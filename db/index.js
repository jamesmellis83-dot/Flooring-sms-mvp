// db/index.js — SQLite connection + helpers (multi-tenant)
//
// TENANCY RULE: every query that touches business data takes a companyId and
// filters on it. There is no helper that reads estimates, pricing, or materials
// without a company scope.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'bidbuddy.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
const DEFAULT_SHINGLES = [
  { name: 'GAF Timberline HDZ',     cost_per_square: 165, is_default: 1 },
  { name: 'Owens Corning Duration', cost_per_square: 180, is_default: 0 },
  { name: 'CertainTeed Landmark',   cost_per_square: 172, is_default: 0 },
  { name: '3-Tab (economy)',        cost_per_square: 125, is_default: 0 },
];
/* ================= companies + users ================= */
function createCompanyWithOwner({ company_name, owner_name, email, password_hash, phone }) {
  const trialEnds = new Date(Date.now() + 30 * 864e5).toISOString();
  const tx = db.transaction(() => {
    const co = db.prepare(`INSERT INTO companies (company_name, trial_ends_at) VALUES (?,?)`)
      .run(company_name, trialEnds);
    const companyId = co.lastInsertRowid;
    db.prepare(`INSERT INTO pricing_profiles (company_id) VALUES (?)`).run(companyId);
    seedShingles(companyId);
    const u = db.prepare(`
      INSERT INTO users (company_id, full_name, email, password_hash, phone, role, status)
      VALUES (?,?,?,?,?,'owner','active')
    `).run(companyId, owner_name, String(email).toLowerCase().trim(), password_hash, phone || null);
    return u.lastInsertRowid;
  });
  return getUserById(tx());
}
const getUserById    = (id)    => db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
const getUserByEmail = (email) => db.prepare(`SELECT * FROM users WHERE email = ?`).get(String(email).toLowerCase().trim());
const getCompany     = (id)    => db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id);
function getUserByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!digits) return null;
  return db.prepare(`
    SELECT u.*, c.company_name, c.onboarded AS company_onboarded, c.subscription_status
    FROM users u JOIN companies c ON c.id = u.company_id
    WHERE u.phone LIKE ? AND u.status = 'active'
  `).get('%' + digits) || null;
}
const listUsers = (companyId) =>
  db.prepare(`SELECT * FROM users WHERE company_id = ? ORDER BY (role='owner') DESC, full_name, id`).all(companyId);
const seatCount = (companyId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND status != 'disabled'`).get(companyId).n;
function inviteUser(companyId, { full_name, email, phone }) {
  if (!email) return { error: 'Email is required.' };
  if (getUserByEmail(email)) return { error: 'That email is already in use.' };
  const co = getCompany(companyId);
  if (seatCount(companyId) >= (co.seat_limit || 10)) return { error: 'Seat limit reached for this plan.' };
  const token = crypto.randomBytes(20).toString('hex');
  try {
    const info = db.prepare(`
      INSERT INTO users (company_id, full_name, email, phone, role, status, invite_token)
      VALUES (?,?,?,?,'estimator','invited',?)
    `).run(companyId, full_name || null, String(email).toLowerCase().trim(), phone || null, token);
    return { id: info.lastInsertRowid, token };
  } catch (e) {
    return { error: 'That phone number is already registered to another user.' };
  }
}
const getUserByInvite = (token) =>
  db.prepare(`SELECT * FROM users WHERE invite_token = ? AND status = 'invited'`).get(token);
function activateInvite(token, { password_hash, full_name, phone }) {
  const u = getUserByInvite(token);
  if (!u) return null;
  db.prepare(`
    UPDATE users SET password_hash = ?, full_name = COALESCE(?, full_name),
           phone = COALESCE(?, phone), status = 'active', invite_token = NULL
    WHERE id = ?
  `).run(password_hash, full_name || null, phone || null, u.id);
  return getUserById(u.id);
}
function updateUser(companyId, userId, fields) {
  const allowed = ['full_name', 'phone', 'role', 'status'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] != null && fields[k] !== '');
  if (!keys.length) return null;
  db.prepare(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND company_id = ?`)
    .run(...keys.map(k => fields[k]), userId, companyId);
  return getUserById(userId);
}
function removeUser(companyId, userId) {
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND company_id = ?`).get(userId, companyId);
  if (!u) return { error: 'User not found.' };
  if (u.role === 'owner') {
    const owners = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role='owner' AND status='active'`).get(companyId).n;
    if (owners <= 1) return { error: 'You need at least one owner on the account.' };
  }
  db.prepare(`DELETE FROM users WHERE id = ? AND company_id = ?`).run(userId, companyId);
  return { ok: true };
}
function updateCompany(id, fields) {
  const allowed = ['company_name','service_area','supplier','supplier_branch','subscription_status','onboarded','seat_limit'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return getCompany(id);
  db.prepare(`UPDATE companies SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => fields[k]), id);
  return getCompany(id);
}
/* ================= pricing (company-scoped) ================= */
const getPricing = (companyId) =>
  db.prepare(`SELECT * FROM pricing_profiles WHERE company_id = ?`).get(companyId);
function updatePricing(companyId, fields) {
  const allowed = ['labor_per_square','material_per_square','gross_margin','tearoff_per_layer','pitch_surcharge',
    'steep_pitch_threshold','two_story_surcharge','dumpster_fee','penetration_fee','chimney_flash_fee',
    'ridge_per_lf','eave_per_lf','waste_factor','default_shingle','min_job_price'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== '' && fields[k] != null);
  if (!keys.length) return getPricing(companyId);
  db.prepare(`UPDATE pricing_profiles SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE company_id = ?`)
    .run(...keys.map(k => fields[k]), companyId);
  return getPricing(companyId);
}
/* ================= shingle catalog (company-scoped) ================= */
function seedShingles(companyId) {
  const ins = db.prepare(`INSERT INTO shingle_options (company_id, name, cost_per_square, is_default, sort_order) VALUES (?,?,?,?,?)`);
  DEFAULT_SHINGLES.forEach((s, i) => ins.run(companyId, s.name, s.cost_per_square, s.is_default, i));
}
function listShingles(companyId) {
  let rows = db.prepare(`SELECT * FROM shingle_options WHERE company_id = ? ORDER BY sort_order, id`).all(companyId);
  if (!rows.length) {
    seedShingles(companyId);
    rows = db.prepare(`SELECT * FROM shingle_options WHERE company_id = ? ORDER BY sort_order, id`).all(companyId);
  }
  return rows;
}
function getDefaultShingle(companyId) {
  const rows = listShingles(companyId);
  return rows.find(r => r.is_default) || rows[0] || null;
}
function addShingle(companyId, { name, cost_per_square }) {
  if (!name || !String(name).trim() || !Number(cost_per_square)) return null;
  const max = db.prepare(`SELECT COALESCE(MAX(sort_order),0) AS m FROM shingle_options WHERE company_id = ?`).get(companyId).m;
  return db.prepare(`INSERT INTO shingle_options (company_id, name, cost_per_square, is_default, sort_order) VALUES (?,?,?,0,?)`)
    .run(companyId, String(name).trim(), Number(cost_per_square), max + 1).lastInsertRowid;
}
function updateShingle(companyId, id, { name, cost_per_square }) {
  db.prepare(`UPDATE shingle_options SET name = COALESCE(?, name), cost_per_square = COALESCE(?, cost_per_square)
              WHERE id = ? AND company_id = ?`)
    .run(name ? String(name).trim() : null, cost_per_square ? Number(cost_per_square) : null, id, companyId);
}
function deleteShingle(companyId, id) {
  const rows = listShingles(companyId);
  if (rows.length <= 1) return false;
  const target = rows.find(r => String(r.id) === String(id));
  db.prepare(`DELETE FROM shingle_options WHERE id = ? AND company_id = ?`).run(id, companyId);
  if (target && target.is_default) {
    const next = listShingles(companyId)[0];
    if (next) setDefaultShingle(companyId, next.id);
  }
  return true;
}
function setDefaultShingle(companyId, id) {
  db.prepare(`UPDATE shingle_options SET is_default = 0 WHERE company_id = ?`).run(companyId);
  db.prepare(`UPDATE shingle_options SET is_default = 1 WHERE id = ? AND company_id = ?`).run(id, companyId);
  const row = db.prepare(`SELECT name FROM shingle_options WHERE id = ? AND company_id = ?`).get(id, companyId);
  if (row) db.prepare(`UPDATE pricing_profiles SET default_shingle = ? WHERE company_id = ?`).run(row.name, companyId);
}
function matchShingle(companyId, text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const rows = listShingles(companyId);
  for (const r of rows) if (t.includes(r.name.toLowerCase())) return r;
  const skip = new Set(['shingle','shingles','the','and','economy','tab','3-tab']);
  for (const r of rows) {
    const words = r.name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !skip.has(w));
    if (words.some(w => t.includes(w))) return r;
  }
  const alias = [
    [/\bhdz\b|timberline|\bgaf\b/,       'timberline'],
    [/duration|owens|\boc\b/,            'duration'],
    [/landmark|certainteed|\bct\b/,      'landmark'],
    [/3\s*-?\s*tab|three\s*tab|economy/, '3-tab'],
  ];
  for (const [re, key] of alias) {
    if (re.test(t)) {
      const hit = rows.find(r => r.name.toLowerCase().includes(key));
      if (hit) return hit;
    }
  }
  return null;
}
/* ================= estimates (company-scoped) ================= */
function saveEstimate({ company_id, created_by_user_id, customer_name, job_address, squares, estimate_amount, estimate_json, source }) {
  return db.prepare(`
    INSERT INTO estimates (company_id, created_by_user_id, customer_name, job_address, squares, estimate_amount, estimate_json, source)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(company_id, created_by_user_id || null, customer_name || null, job_address || null,
         squares || null, estimate_amount, JSON.stringify(estimate_json || {}), source || 'sms').lastInsertRowid;
}
function listEstimates(companyId, { limit = 50, userId = null } = {}) {
  const base = `
    SELECT e.*, u.full_name AS estimator
    FROM estimates e LEFT JOIN users u ON u.id = e.created_by_user_id
    WHERE e.company_id = ?`;
  return userId
    ? db.prepare(base + ` AND e.created_by_user_id = ? ORDER BY e.created_at DESC LIMIT ?`).all(companyId, userId, limit)
    : db.prepare(base + ` ORDER BY e.created_at DESC LIMIT ?`).all(companyId, limit);
}
function estimateStats(companyId) {
  return db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(estimate_amount),0) AS value,
           COALESCE(AVG(estimate_amount),0) AS avg,
           COALESCE(SUM(CASE WHEN created_at >= date('now','start of month') THEN 1 ELSE 0 END),0) AS this_month
    FROM estimates WHERE company_id = ?
  `).get(companyId);
}
const statsByUser = (companyId) => db.prepare(`
  SELECT u.id, u.full_name, u.role,
         COUNT(e.id) AS total,
         COALESCE(SUM(e.estimate_amount),0) AS value
  FROM users u LEFT JOIN estimates e ON e.created_by_user_id = u.id AND e.company_id = ?
  WHERE u.company_id = ? AND u.status != 'disabled'
  GROUP BY u.id ORDER BY value DESC
`).all(companyId, companyId);
/* ================= sessions ================= */
const createSession = (token, userId) => db.prepare(`INSERT INTO sessions (token, user_id) VALUES (?,?)`).run(token, userId);
const getSession    = (token) => db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
const deleteSession = (token) => db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
/* ================= sms compliance (opt-out / opt-in) ================= */
// Keyed on the same last-10-digit normalized phone format used by
// getUserByPhone(), so an estimator's opt-out status is found consistently
// no matter how the inbound "from" number is formatted by the carrier.
function normalizePhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}
function isPhoneOptedOut(phone) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return false;
  const row = db.prepare(`SELECT opted_out FROM sms_opt_outs WHERE phone = ?`).get(digits);
  return Boolean(row && row.opted_out);
}
function recordOptOut(phone, companyId = null) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return false;
  db.prepare(`
    INSERT INTO sms_opt_outs (phone, company_id, opted_out, opted_out_at, updated_at)
    VALUES (?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      opted_out = 1,
      opted_out_at = datetime('now'),
      updated_at = datetime('now'),
      company_id = COALESCE(sms_opt_outs.company_id, excluded.company_id)
  `).run(digits, companyId);
  return true;
}
function recordOptIn(phone, companyId = null) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return false;
  db.prepare(`
    INSERT INTO sms_opt_outs (phone, company_id, opted_out, opted_in_at, updated_at)
    VALUES (?, ?, 0, datetime('now'), datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      opted_out = 0,
      opted_in_at = datetime('now'),
      updated_at = datetime('now'),
      company_id = COALESCE(sms_opt_outs.company_id, excluded.company_id)
  `).run(digits, companyId);
  return true;
}
function getOptOutRecord(phone) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return null;
  return db.prepare(`SELECT * FROM sms_opt_outs WHERE phone = ?`).get(digits) || null;
}
function listOptOuts(companyId = null) {
  return companyId
    ? db.prepare(`SELECT * FROM sms_opt_outs WHERE company_id = ? ORDER BY updated_at DESC`).all(companyId)
    : db.prepare(`SELECT * FROM sms_opt_outs ORDER BY updated_at DESC`).all();
}
module.exports = {
  db,
  createCompanyWithOwner, getUserById, getUserByEmail, getUserByPhone, getCompany, updateCompany,
  listUsers, seatCount, inviteUser, getUserByInvite, activateInvite, updateUser, removeUser,
  getPricing, updatePricing,
  listShingles, getDefaultShingle, addShingle, updateShingle, deleteShingle, setDefaultShingle, matchShingle,
  saveEstimate, listEstimates, estimateStats, statsByUser,
  createSession, getSession, deleteSession,
  isPhoneOptedOut, recordOptOut, recordOptIn, getOptOutRecord, listOptOuts,
};
