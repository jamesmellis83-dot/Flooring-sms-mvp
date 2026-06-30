const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    phone TEXT PRIMARY KEY,
    state TEXT,
    context TEXT,
    onboarded INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT, direction TEXT, body TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT, customer_name TEXT,
    sqft INTEGER, type TEXT, job TEXT,
    location TEXT, notes TEXT,
    estimate_low INTEGER, estimate_high INTEGER,
    breakdown TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: add onboarded column if upgrading from older schema
try { db.exec(`ALTER TABLE conversations ADD COLUMN onboarded INTEGER DEFAULT 0`); } catch {}

function getConvo(phone) {
  const row = db.prepare('SELECT * FROM conversations WHERE phone = ?').get(phone);
  if (!row) return { phone, state: 'NEW', context: {}, onboarded: 0 };
  return { ...row, context: JSON.parse(row.context || '{}') };
}
function saveConvo(phone, state, context, onboarded) {
  const existing = db.prepare('SELECT onboarded FROM conversations WHERE phone = ?').get(phone);
  const onb = onboarded !== undefined ? (onboarded ? 1 : 0) : (existing?.onboarded ?? 0);
  db.prepare(`
    INSERT INTO conversations (phone, state, context, onboarded, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      state = excluded.state,
      context = excluded.context,
      onboarded = excluded.onboarded,
      updated_at = CURRENT_TIMESTAMP
  `).run(phone, state, JSON.stringify(context || {}), onb);
}
function resetConvo(phone) {
  // keep onboarded flag so they don't get the welcome packet again
  db.prepare('UPDATE conversations SET state = ?, context = ? WHERE phone = ?').run('NEW', '{}', phone);
}

function logMessage(phone, direction, body) {
  db.prepare('INSERT INTO messages (phone, direction, body) VALUES (?, ?, ?)').run(phone, direction, body);
}
function getMessages(phone, limit = 200) {
  return db.prepare('SELECT * FROM messages WHERE phone = ? ORDER BY id DESC LIMIT ?').all(phone, limit).reverse();
}
function getAllConvos() {
  return db.prepare(`
    SELECT c.phone, c.state, c.updated_at, c.onboarded,
           (SELECT body FROM messages m WHERE m.phone = c.phone ORDER BY id DESC LIMIT 1) AS last_message
    FROM conversations c
    ORDER BY c.updated_at DESC
  `).all();
}

function saveLead(lead) {
  db.prepare(`
    INSERT INTO leads (phone, customer_name, sqft, type, job, location, notes, estimate_low, estimate_high, breakdown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    lead.phone, lead.customer_name || null,
    lead.sqft, lead.type, lead.job,
    lead.location || null, lead.notes || null,
    lead.estimate_low, lead.estimate_high,
    JSON.stringify(lead.breakdown || {})
  );
}
function getStats() {
  const today = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(estimate_high), 0) AS pipeline
    FROM leads WHERE DATE(created_at) = DATE('now')
  `).get();
  const total = db.prepare('SELECT COUNT(*) AS count FROM leads').get();
  return { leadsToday: today.count, pipelineToday: today.pipeline, totalLeads: total.count };
}
function getAllLeads() {
  return db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 100').all();
}

module.exports = {
  getConvo, saveConvo, resetConvo,
  logMessage, getMessages, getAllConvos,
  saveLead, getStats, getAllLeads,
};
