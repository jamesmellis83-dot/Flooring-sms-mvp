/**
 * SQLite database layer.
 * Tables:
 *   contractors      - the business owners (the customer paying us)
 *   homeowners       - leads / customers of the contractor
 *   conversations    - SMS thread state per (contractor, homeowner)
 *   messages         - every inbound/outbound SMS for audit + AI context
 *   quotes           - generated quotes awaiting approval / sent
 *   followups        - scheduled nudges
 */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS contractors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  owner_name TEXT,
  trade TEXT NOT NULL CHECK(trade IN ('roofing','flooring')),
  contractor_phone TEXT NOT NULL UNIQUE,   -- the OWNER's cell (we text approvals here)
  business_phone TEXT NOT NULL UNIQUE,     -- the Twilio # homeowners text
  pricing_rules_json TEXT NOT NULL DEFAULT '{}',
  calendar_link TEXT,
  payment_link_template TEXT,              -- e.g. https://buy.stripe.com/xxx?amount={{amount}}
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS homeowners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  name TEXT,
  address TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(phone)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL,
  homeowner_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'greeting',
  -- greeting -> qualifying -> awaiting_contractor_approval -> quote_sent -> scheduling -> booked -> closed
  collected_json TEXT NOT NULL DEFAULT '{}',   -- structured data the AI has gathered
  last_activity_at TEXT DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contractor_id) REFERENCES contractors(id),
  FOREIGN KEY (homeowner_id) REFERENCES homeowners(id),
  UNIQUE(contractor_id, homeowner_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  line_items_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  -- pending_approval -> approved -> sent -> accepted -> declined
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  sent_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  send_at TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'nudge_24h' | 'nudge_3d' | 'nudge_7d'
  sent INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
`);

// ---------- Helpers ----------
const upsertHomeowner = db.prepare(`
  INSERT INTO homeowners (phone) VALUES (?)
  ON CONFLICT(phone) DO UPDATE SET phone=excluded.phone
  RETURNING *;
`);

const getContractorByBusinessPhone = db.prepare(
  `SELECT * FROM contractors WHERE business_phone = ?`
);
const getContractorByOwnerPhone = db.prepare(
  `SELECT * FROM contractors WHERE contractor_phone = ?`
);
const getContractorById = db.prepare(`SELECT * FROM contractors WHERE id = ?`);

const getOrCreateConversation = db.transaction((contractorId, homeownerId) => {
  let row = db
    .prepare(
      `SELECT * FROM conversations WHERE contractor_id = ? AND homeowner_id = ?`
    )
    .get(contractorId, homeownerId);
  if (!row) {
    const info = db
      .prepare(
        `INSERT INTO conversations (contractor_id, homeowner_id) VALUES (?, ?)`
      )
      .run(contractorId, homeownerId);
    row = db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(info.lastInsertRowid);
  }
  return row;
});

const updateConversation = db.prepare(`
  UPDATE conversations
  SET state = ?, collected_json = ?, last_activity_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (conversation_id, direction, from_phone, to_phone, body)
  VALUES (?, ?, ?, ?, ?)
`);

const recentMessages = db.prepare(`
  SELECT direction, body, created_at FROM messages
  WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
`);

const insertQuote = db.prepare(`
  INSERT INTO quotes (conversation_id, amount_cents, line_items_json)
  VALUES (?, ?, ?)
`);

const getPendingQuoteForConversation = db.prepare(`
  SELECT * FROM quotes
  WHERE conversation_id = ? AND status = 'pending_approval'
  ORDER BY id DESC LIMIT 1
`);

const approveQuote = db.prepare(`
  UPDATE quotes SET status='approved', approved_at=CURRENT_TIMESTAMP WHERE id = ?
`);
const markQuoteSent = db.prepare(`
  UPDATE quotes SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id = ?
`);

const scheduleFollowup = db.prepare(`
  INSERT INTO followups (conversation_id, send_at, kind) VALUES (?, ?, ?)
`);
const dueFollowups = db.prepare(`
  SELECT f.*, c.contractor_id, c.homeowner_id
  FROM followups f
  JOIN conversations c ON c.id = f.conversation_id
  WHERE f.sent = 0 AND f.send_at <= CURRENT_TIMESTAMP
`);
const markFollowupSent = db.prepare(`UPDATE followups SET sent = 1 WHERE id = ?`);

const getHomeownerById = db.prepare(`SELECT * FROM homeowners WHERE id = ?`);

module.exports = {
  db,
  upsertHomeowner,
  getContractorByBusinessPhone,
  getContractorByOwnerPhone,
  getContractorById,
  getOrCreateConversation,
  updateConversation,
  insertMessage,
  recentMessages,
  insertQuote,
  getPendingQuoteForConversation,
  approveQuote,
  markQuoteSent,
  scheduleFollowup,
  dueFollowups,
  markFollowupSent,
  getHomeownerById,
};

// If run directly: seed a demo contractor so you can simulate immediately.
if (require.main === module) {
  const seed = db.prepare(`
    INSERT OR IGNORE INTO contractors
    (business_name, owner_name, trade, contractor_phone, business_phone, pricing_rules_json, calendar_link, payment_link_template)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  seed.run(
    'Ellis Roofing Co.',
    'James',
    'roofing',
    '+19015550101',                 // owner's cell
    '+19015550102',                 // Twilio business number homeowners text
    JSON.stringify({
      base_per_sqft: 4.5,           // $/sqft installed
      tear_off_per_sqft: 1.25,
      materials: {
        '3-tab asphalt': 0,         // multiplier added to base
        'architectural asphalt': 1.5,
        'metal': 4.0,
        'tile': 6.0,
      },
      min_job: 2500,
      labor_markup_pct: 20,
    }),
    'https://cal.com/ellis-roofing/site-visit',
    'https://buy.stripe.com/demo?amount={{amount}}'
  );

  seed.run(
    'Memphis Floors LLC',
    'James',
    'flooring',
    '+19015550201',
    '+19015550202',
    JSON.stringify({
      base_per_sqft: 3.25,
      removal_per_sqft: 1.0,
      materials: {
        'LVP (luxury vinyl plank)': 2.5,
        'engineered hardwood': 5.0,
        'tile': 4.0,
        'carpet': 1.5,
      },
      min_job: 1500,
      labor_markup_pct: 18,
    }),
    'https://cal.com/memphis-floors/site-visit',
    'https://buy.stripe.com/demo?amount={{amount}}'
  );

  console.log('✅ DB initialized and demo contractors seeded.');
  console.log('   Roofing business #: +19015550102 (owner: +19015550101)');
  console.log('   Flooring business #: +19015550202 (owner: +19015550201)');
}
