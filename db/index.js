// db/index.js — SQLite connection + helpers
// npm i better-sqlite3
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// On Render, set DB_PATH to a path on a mounted Persistent Disk (e.g. /data/bidbuddy.db)
// or the file resets on every deploy.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'bidbuddy.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema on boot
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/* ---------- contractors ---------- */

function createContractor({ company_name, owner_name, email, password_hash, phone, service_area, supplier, supplier_branch }) {
  const trialEnds = new Date(Date.now() + 30 * 864e5).toISOString();
  const info = db.prepare(`
    INSERT INTO contractors
      (company_name, owner_name, email, password_hash, phone, service_area, supplier, supplier_branch, trial_ends_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(company_name, owner_name, email.toLowerCase().trim(), password_hash, phone || null, service_area, supplier, supplier_branch, trialEnds);

  // every contractor gets a default pricing profile immediately
  db.prepare(`INSERT INTO pricing_profiles (contractor_id) VALUES (?)`).run(info.lastInsertRowid);
  return getContractorById(info.lastInsertRowid);
}

const getContractorById    = (id)    => db.prepare(`SELECT * FROM contractors WHERE id = ?`).get(id);
const getContractorByEmail = (email) => db.prepare(`SELECT * FROM contractors WHERE email = ?`).get(String(email).toLowerCase().trim());

// Used by the SMS webhook to map an inbound number to an account.
function getContractorByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!digits) return null;
  return db.prepare(`
    SELECT * FROM contractors
    WHERE replace(replace(replace(replace(phone,'+',''),'-',''),' ',''),'()','') LIKE ?
  `).get('%' + digits) || db.prepare(`SELECT * FROM contractors WHERE phone LIKE ?`).get('%' + digits);
}

function updateContractor(id, fields) {
  const allowed = ['company_name','owner_name','phone','service_area','supplier','supplier_branch','subscription_status','onboarded'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return getContractorById(id);
  db.prepare(`UPDATE contractors SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => fields[k]), id);
  return getContractorById(id);
}

/* ---------- pricing ---------- */

const getPricing = (contractorId) =>
  db.prepare(`SELECT * FROM pricing_profiles WHERE contractor_id = ?`).get(contractorId);

function updatePricing(contractorId, fields) {
  const allowed = ['labor_per_square','material_per_square','gross_margin','tearoff_per_layer','pitch_surcharge',
    'steep_pitch_threshold','two_story_surcharge','dumpster_fee','penetration_fee','chimney_flash_fee',
    'ridge_per_lf','eave_per_lf','waste_factor','default_shingle','min_job_price'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== '' && fields[k] != null);
  if (!keys.length) return getPricing(contractorId);
  db.prepare(`UPDATE pricing_profiles SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE contractor_id = ?`)
    .run(...keys.map(k => fields[k]), contractorId);
  return getPricing(contractorId);
}

/* ---------- estimates ---------- */

function saveEstimate({ contractor_id, customer_name, job_address, squares, estimate_amount, estimate_json, source }) {
  const info = db.prepare(`
    INSERT INTO estimates (contractor_id, customer_name, job_address, squares, estimate_amount, estimate_json, source)
    VALUES (?,?,?,?,?,?,?)
  `).run(contractor_id, customer_name || null, job_address || null, squares || null,
         estimate_amount, JSON.stringify(estimate_json || {}), source || 'sms');
  return info.lastInsertRowid;
}

const listEstimates = (contractorId, limit = 50) =>
  db.prepare(`SELECT * FROM estimates WHERE contractor_id = ? ORDER BY created_at DESC LIMIT ?`).all(contractorId, limit);

const lastEstimate = (contractorId) =>
  db.prepare(`SELECT * FROM estimates WHERE contractor_id = ? ORDER BY id DESC LIMIT 1`).get(contractorId);

function estimateStats(contractorId) {
  return db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(estimate_amount),0) AS value,
           COALESCE(AVG(estimate_amount),0) AS avg,
           COALESCE(SUM(CASE WHEN created_at >= date('now','start of month') THEN 1 ELSE 0 END),0) AS this_month
    FROM estimates WHERE contractor_id = ?
  `).get(contractorId);
}

/* ---------- sessions ---------- */

const createSession = (token, contractorId) =>
  db.prepare(`INSERT INTO sessions (token, contractor_id) VALUES (?,?)`).run(token, contractorId);
const getSession  = (token) => db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
const deleteSession = (token) => db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);

module.exports = {
  db,
  createContractor, getContractorById, getContractorByEmail, getContractorByPhone, updateContractor,
  getPricing, updatePricing,
  saveEstimate, listEstimates, lastEstimate, estimateStats,
  createSession, getSession, deleteSession,
};
