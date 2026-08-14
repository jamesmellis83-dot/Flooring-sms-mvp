// lib/auth.js — minimal session auth. No extra deps beyond bcryptjs.
// npm i bcryptjs cookie-parser
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const store = require('../db');

const hash    = (pw) => bcrypt.hashSync(pw, 10);
const verify  = (pw, h) => bcrypt.compareSync(pw, h);
const newToken = () => crypto.randomBytes(24).toString('hex');

function login(res, contractorId) {
  const token = newToken();
  store.createSession(token, contractorId);
  res.cookie('bb_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 864e5,
  });
}

function logout(req, res) {
  const t = req.cookies?.bb_session;
  if (t) store.deleteSession(t);
  res.clearCookie('bb_session');
}

// Attaches req.contractor if logged in
function loadUser(req, _res, next) {
  const t = req.cookies?.bb_session;
  if (t) {
    const s = store.getSession(t);
    if (s) req.contractor = store.getContractorById(s.contractor_id);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.contractor) return res.redirect('/login');
  next();
}

module.exports = { hash, verify, login, logout, loadUser, requireAuth };
