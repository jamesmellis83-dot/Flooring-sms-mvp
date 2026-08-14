-- BidBuddy USA — MVP schema
-- SQLite. Safe to run repeatedly (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS contractors (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name        TEXT NOT NULL,
  owner_name          TEXT,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  phone               TEXT UNIQUE,              -- E.164, the number they text FROM
  service_area        TEXT,
  trade               TEXT DEFAULT 'roofing',
  supplier            TEXT,                     -- ABC | SRS | Beacon | Other
  supplier_branch     TEXT,
  subscription_status TEXT DEFAULT 'trial',     -- trial | active | past_due | canceled
  trial_ends_at       TEXT,
  onboarded           INTEGER DEFAULT 0,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pricing_profiles (
  contractor_id        INTEGER PRIMARY KEY REFERENCES contractors(id) ON DELETE CASCADE,
  labor_per_square     REAL DEFAULT 175,
  material_per_square  REAL DEFAULT 165,
  gross_margin         REAL DEFAULT 0.35,   -- decimal, not markup
  tearoff_per_layer    REAL DEFAULT 55,     -- per square, per layer
  pitch_surcharge      REAL DEFAULT 0.15,   -- % uplift applied at/above steep_pitch_threshold
  steep_pitch_threshold INTEGER DEFAULT 7,  -- x/12
  two_story_surcharge  REAL DEFAULT 0.10,   -- % uplift
  dumpster_fee         REAL DEFAULT 450,
  penetration_fee      REAL DEFAULT 65,     -- each
  chimney_flash_fee    REAL DEFAULT 350,    -- each
  ridge_per_lf         REAL DEFAULT 9,
  eave_per_lf          REAL DEFAULT 4,
  waste_factor         REAL DEFAULT 0.10,
  default_shingle      TEXT DEFAULT 'GAF Timberline HDZ',
  min_job_price        REAL DEFAULT 1500,
  updated_at           TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS estimates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id   INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  customer_name   TEXT,
  job_address     TEXT,
  squares         REAL,
  estimate_amount REAL,
  estimate_json   TEXT,          -- full breakdown + parsed job
  source          TEXT DEFAULT 'sms',
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_est_contractor ON estimates(contractor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contractor_phone ON contractors(phone);
