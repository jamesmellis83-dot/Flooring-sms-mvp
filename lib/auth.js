// lib/auth.js — session auth + tenancy guards
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const store = require('../db');

const hash     = (pw) => bcrypt.hashSync(pw, 10);
const verify   = (pw, h) => (h ? bcrypt.compareSync(pw, h) : false);
const newToken = () => crypto.randomBytes(24).toString('hex');

function login(res, userId) {
  const token = newToken();
  store.createSession(token, userId);
  res.cookie('bb_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 864e5,
  });
}

function logout(req, res) {
  const t = req.cookies && req.cookies.bb_session;
  if (t) store.deleteSession(t);
  res.clearCookie('bb_session');
}

// Attaches req.user and req.company on every request.
// req.company is the tenant scope — routes must use req.company.id.
function loadUser(req, _res, next) {
  const t = req.cookies && req.cookies.bb_session;
  if (t) {
    const s = store.getSession(t);
    if (s) {
      const u = store.getUserById(s.user_id);
      if (u && u.status === 'active') {
        req.user = u;
        req.company = store.getCompany(u.company_id);
      }
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

// Pricing, materials, and the team roster are owner-only.
function requireOwner(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'owner') {
    return res.redirect('/dashboard?err=' + encodeURIComponent('Only an account owner can change that.'));
  }
  next();
}

module.exports = { hash, verify, login, logout, loadUser, requireAuth, requireOwner };
