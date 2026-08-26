-- BidBuddy USA — multi-tenant schema
-- SQLite. Safe to run repeatedly (CREATE TABLE IF NOT EXISTS).
--
-- TENANCY MODEL
--   companies  = the paying tenant. Owns pricing, materials, estimates, customers.
--   users      = estimators inside a company. Each has their own login and phone.
--   Everything business-related hangs off company_id, never user_id.
--   One $299/mo subscription per company, unlimited estimators.
CREATE TABLE IF NOT EXISTS companies (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name        TEXT NOT NULL,
  service_area        TEXT,
  trade               TEXT DEFAULT 'roofing',
  supplier            TEXT,                     -- ABC | SRS | Beacon | Other
  supplier_branch     TEXT,
  subscription_status TEXT DEFAULT 'trial',     -- trial | active | past_due | canceled
  trial_ends_at       TEXT,
  seat_limit          INTEGER DEFAULT 10,
  onboarded           INTEGER DEFAULT 0,
  created_at          TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name      TEXT,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT,                          -- null until an invited user activates
  phone          TEXT UNIQUE,                   -- E.164, the number they text FROM
  role           TEXT DEFAULT 'estimator',      -- owner | estimator
  status         TEXT DEFAULT 'active',         -- active | invited | disabled
  invite_token   TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);
-- Pricing belongs to the COMPANY. All estimators quote off the same numbers.
CREATE TABLE IF NOT EXISTS pricing_profiles (
  company_id           INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  labor_per_square     REAL DEFAULT 175,
  material_per_square  REAL DEFAULT 165,   -- fallback only, when no shingle is matched
  gross_margin         REAL DEFAULT 0.35,  -- decimal, not markup
  tearoff_per_layer    REAL DEFAULT 55,    -- per square, per layer
  pitch_surcharge      REAL DEFAULT 0.15,
  steep_pitch_threshold INTEGER DEFAULT 7,
  two_story_surcharge  REAL DEFAULT 0.10,
  dumpster_fee         REAL DEFAULT 450,
  penetration_fee      REAL DEFAULT 65,
  chimney_flash_fee    REAL DEFAULT 350,
  ridge_per_lf         REAL DEFAULT 9,
  eave_per_lf          REAL DEFAULT 4,
  valley_per_lf        REAL DEFAULT 12,
  skylight_flash_fee   REAL DEFAULT 275,
  waste_factor         REAL DEFAULT 0.10,
  default_shingle      TEXT DEFAULT 'GAF Timberline HDZ',
  min_job_price        REAL DEFAULT 1500,
  updated_at           TEXT DEFAULT (datetime('now'))
);
-- Material catalog, per company.
CREATE TABLE IF NOT EXISTS shingle_options (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  cost_per_square REAL NOT NULL,
  is_default      INTEGER DEFAULT 0,
  sort_order      INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);
-- Estimates belong to the company; we track which estimator produced them.
CREATE TABLE IF NOT EXISTS estimates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name   TEXT,
  job_address     TEXT,
  squares         REAL,
  estimate_amount REAL,
  estimate_json   TEXT,
  source          TEXT DEFAULT 'sms',
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
);
-- SMS compliance: tracks STOP/UNSUBSCRIBE/CANCEL and START/YES status per
-- phone number, independent of whether that phone is (yet) tied to a
-- registered estimator/company. Keyed on the same last-10-digit normalized
-- phone format already used by getUserByPhone(), so lookups stay consistent
-- across the codebase regardless of how the number was originally formatted
-- (+1 vs no country code, dashes, parentheses, etc.).
CREATE TABLE IF NOT EXISTS sms_opt_outs (
  phone         TEXT PRIMARY KEY,   -- last 10 digits, no formatting
  company_id    INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  opted_out     INTEGER NOT NULL DEFAULT 0,
  opted_out_at  TEXT,
  opted_in_at   TEXT,
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_est_company    ON estimates(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_company  ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_phone    ON users(phone);
CREATE INDEX IF NOT EXISTS idx_shingle_company ON shingle_options(company_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_optout_company ON sms_opt_outs(company_id);
