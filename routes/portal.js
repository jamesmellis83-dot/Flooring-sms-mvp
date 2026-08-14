// routes/portal.js — signup, login, onboarding, dashboard, pricing, estimates, account
const express = require('express');
const store = require('../db');
const auth = require('../lib/auth');
const { layout, esc } = require('../lib/layout');
const { money } = require('../lib/roofingPricing');

const router = express.Router();

/* ========== SIGN UP ========== */

router.get('/signup', (req, res) => {
  res.send(layout({ title: 'Start your trial — BidBuddy', body: `
    <div class="auth">
      <h1>Start your 30-day trial</h1>
      <p class="sub">No card required. Takes about two minutes.</p>
      ${req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : ''}
      <form method="post" action="/signup" class="card">
        <label>Company name</label><input name="company_name" required placeholder="Summit Roofing">
        <label>Your name</label><input name="owner_name" required>
        <div class="row">
          <div><label>Email</label><input type="email" name="email" required></div>
          <div><label>Password</label><input type="password" name="password" required minlength="8"></div>
        </div>
        <label>Mobile number you'll text estimates from</label>
        <input name="phone" required placeholder="901-555-0142">
        <div class="hint">This is how we know the estimate is yours and which pricing to use.</div>
        <button class="primary">Create account</button>
      </form>
      <p class="sub" style="text-align:center">Already set up? <a class="b" href="/login">Sign in</a></p>
    </div>`}));
});

router.post('/signup', (req, res) => {
  const { company_name, owner_name, email, password, phone } = req.body;
  if (!email || !password || password.length < 8) return res.redirect('/signup?err=' + encodeURIComponent('Password must be at least 8 characters.'));
  if (store.getContractorByEmail(email)) return res.redirect('/signup?err=' + encodeURIComponent('That email already has an account.'));
  try {
    const c = store.createContractor({
      company_name, owner_name, email,
      password_hash: auth.hash(password),
      phone: normalizePhone(phone),
    });
    auth.login(res, c.id);
    res.redirect('/onboarding');
  } catch (e) {
    res.redirect('/signup?err=' + encodeURIComponent('Could not create account. That phone number may already be in use.'));
  }
});

/* ========== LOGIN ========== */

router.get('/login', (req, res) => {
  res.send(layout({ title: 'Sign in — BidBuddy', body: `
    <div class="auth">
      <h1>Sign in</h1>
      <p class="sub">Your estimates and pricing are waiting.</p>
      ${req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : ''}
      <form method="post" action="/login" class="card">
        <label>Email</label><input type="email" name="email" required>
        <label>Password</label><input type="password" name="password" required>
        <button class="primary">Sign in</button>
      </form>
      <p class="sub" style="text-align:center">New here? <a class="b" href="/signup">Start a trial</a></p>
    </div>`}));
});

router.post('/login', (req, res) => {
  const c = store.getContractorByEmail(req.body.email || '');
  if (!c || !auth.verify(req.body.password || '', c.password_hash)) {
    return res.redirect('/login?err=' + encodeURIComponent('Email or password is incorrect.'));
  }
  auth.login(res, c.id);
  res.redirect(c.onboarded ? '/dashboard' : '/onboarding');
});

router.post('/logout', (req, res) => { auth.logout(req, res); res.redirect('/'); });

/* ========== ONBOARDING ========== */

router.get('/onboarding', auth.requireAuth, (req, res) => {
  const p = store.getPricing(req.contractor.id);
  res.send(layout({ title: 'Set up your pricing', contractor: req.contractor, body: `
    <h1>Set up your pricing</h1>
    <p class="sub">These are your numbers. Every estimate we text back uses them, and you can change any of it later.</p>
    <form method="post" action="/onboarding">
      <div class="card">
        <h2 style="margin-top:0">Your business</h2>
        <label>Service area</label><input name="service_area" placeholder="Memphis metro, Bartlett, Cordova, Collierville" value="${esc(req.contractor.service_area||'')}">
        <div class="row">
          <div><label>Primary supplier</label>${select('supplier', ['ABC Supply','SRS','Beacon','Other'], req.contractor.supplier)}</div>
          <div><label>Branch (optional)</label><input name="supplier_branch" value="${esc(req.contractor.supplier_branch||'')}"></div>
        </div>
        <label>Default shingle</label>${select('default_shingle', ['GAF Timberline HDZ','Owens Corning Duration','CertainTeed Landmark','Other'], p.default_shingle)}
      </div>
      ${pricingFields(p)}
      <button class="primary">Save and start estimating</button>
    </form>`}));
});

router.post('/onboarding', auth.requireAuth, (req, res) => {
  store.updateContractor(req.contractor.id, {
    service_area: req.body.service_area,
    supplier: req.body.supplier,
    supplier_branch: req.body.supplier_branch,
    onboarded: 1,
  });
  store.updatePricing(req.contractor.id, normalizePricing(req.body));
  res.redirect('/dashboard?ok=' + encodeURIComponent('Pricing saved. Text your job details to your BidBuddy number and it will use these numbers.'));
});

/* ========== DASHBOARD ========== */

router.get('/dashboard', auth.requireAuth, (req, res) => {
  const c = req.contractor;
  const s = store.estimateStats(c.id);
  const recent = store.listEstimates(c.id, 10);

  res.send(layout({ title: 'Dashboard — BidBuddy', contractor: c, active: 'dashboard', body: `
    ${req.query.ok ? `<div class="ok">${esc(req.query.ok)}</div>` : ''}
    <h1>${esc(c.company_name)}</h1>
    <p class="sub">${esc(c.subscription_status === 'trial' ? 'Trial — ends ' + fmtDate(c.trial_ends_at) : 'Active subscription')}</p>
    <div class="grid">
      ${stat(s.this_month, 'Estimates this month')}
      ${stat(s.total, 'Total estimates')}
      ${stat(money(s.value), 'Estimated value')}
      ${stat(money(s.avg), 'Average estimate')}
    </div>
    <h2>Recent estimates</h2>
    <div class="card">
      ${recent.length ? `<table>
        <tr><th>Job</th><th>Squares</th><th>Price</th><th>Date</th></tr>
        ${recent.map(e => `<tr>
          <td>${esc(e.customer_name || e.job_address || 'Untitled job')}</td>
          <td>${e.squares ?? '—'}</td>
          <td>${money(e.estimate_amount)}</td>
          <td>${fmtDate(e.created_at)}</td>
        </tr>`).join('')}
      </table>` : `<p class="sub" style="margin:0">No estimates yet. Text your job details to your BidBuddy number — something like <span class="mono">32 sq, 1 layer tear off, 8/12 pitch, 2 story</span>.</p>`}
    </div>`}));
});

/* ========== ESTIMATES ========== */

router.get('/estimates', auth.requireAuth, (req, res) => {
  const rows = store.listEstimates(req.contractor.id, 200);
  res.send(layout({ title: 'Estimates — BidBuddy', contractor: req.contractor, active: 'estimates', body: `
    <h1>Estimates</h1>
    <p class="sub">Every job you've priced, saved automatically.</p>
    <div class="card">
      ${rows.length ? `<table>
        <tr><th>Job</th><th>Squares</th><th>Cost</th><th>Price</th><th>Date</th></tr>
        ${rows.map(e => { const j = safeJson(e.estimate_json); return `<tr>
          <td>${esc(e.customer_name || e.job_address || 'Untitled job')}</td>
          <td>${e.squares ?? '—'}</td>
          <td>${j.total_cost != null ? money(j.total_cost) : '—'}</td>
          <td>${money(e.estimate_amount)}</td>
          <td>${fmtDate(e.created_at)}</td>
        </tr>`; }).join('')}
      </table>` : '<p class="sub" style="margin:0">Nothing here yet.</p>'}
    </div>`}));
});

/* ========== PRICING PROFILE (editable anytime) ========== */

router.get('/pricing-profile', auth.requireAuth, (req, res) => {
  const p = store.getPricing(req.contractor.id);
  res.send(layout({ title: 'Pricing — BidBuddy', contractor: req.contractor, active: 'pricing', body: `
    ${req.query.ok ? `<div class="ok">${esc(req.query.ok)}</div>` : ''}
    <h1>Your pricing</h1>
    <p class="sub">Change these any time — material costs move, so should your estimates. New numbers apply to the next estimate you text in.</p>
    <form method="post" action="/pricing-profile">
      <div class="card">
        <label>Default shingle</label>${select('default_shingle', ['GAF Timberline HDZ','Owens Corning Duration','CertainTeed Landmark','Other'], p.default_shingle)}
        <div class="row">
          <div><label>Primary supplier</label>${select('supplier', ['ABC Supply','SRS','Beacon','Other'], req.contractor.supplier)}</div>
          <div><label>Branch</label><input name="supplier_branch" value="${esc(req.contractor.supplier_branch||'')}"></div>
        </div>
      </div>
      ${pricingFields(p)}
      <button class="primary">Save pricing</button>
    </form>`}));
});

router.post('/pricing-profile', auth.requireAuth, (req, res) => {
  store.updateContractor(req.contractor.id, { supplier: req.body.supplier, supplier_branch: req.body.supplier_branch });
  store.updatePricing(req.contractor.id, normalizePricing(req.body));
  res.redirect('/pricing-profile?ok=' + encodeURIComponent('Saved. Your next estimate uses these numbers.'));
});

/* ========== ACCOUNT ========== */

router.get('/account', auth.requireAuth, (req, res) => {
  const c = req.contractor;
  res.send(layout({ title: 'Account — BidBuddy', contractor: c, active: 'account', body: `
    ${req.query.ok ? `<div class="ok">${esc(req.query.ok)}</div>` : ''}
    <h1>Account</h1>
    <p class="sub">Status: ${esc(c.subscription_status)}${c.trial_ends_at ? ' · trial ends ' + fmtDate(c.trial_ends_at) : ''}</p>
    <form method="post" action="/account" class="card">
      <label>Company name</label><input name="company_name" value="${esc(c.company_name)}">
      <label>Your name</label><input name="owner_name" value="${esc(c.owner_name||'')}">
      <label>Mobile number you text from</label><input name="phone" value="${esc(c.phone||'')}">
      <div class="hint">Estimates only work from this number. Update it if you change phones.</div>
      <label>Service area</label><input name="service_area" value="${esc(c.service_area||'')}">
      <button class="primary">Save</button>
    </form>`}));
});

router.post('/account', auth.requireAuth, (req, res) => {
  store.updateContractor(req.contractor.id, {
    company_name: req.body.company_name,
    owner_name: req.body.owner_name,
    phone: normalizePhone(req.body.phone),
    service_area: req.body.service_area,
  });
  res.redirect('/account?ok=' + encodeURIComponent('Account updated.'));
});

/* ========== helpers ========== */

function pricingFields(p) {
  return `
  <div class="card">
    <h2 style="margin-top:0">Costs</h2>
    <div class="row">
      <div><label>Labor per square</label><input name="labor_per_square" type="number" step="0.01" value="${p.labor_per_square}"></div>
      <div><label>Material per square</label><input name="material_per_square" type="number" step="0.01" value="${p.material_per_square}"></div>
    </div>
    <div class="row">
      <div><label>Tear-off per square, per layer</label><input name="tearoff_per_layer" type="number" step="0.01" value="${p.tearoff_per_layer}"></div>
      <div><label>Disposal / dumpster</label><input name="dumpster_fee" type="number" step="0.01" value="${p.dumpster_fee}"></div>
    </div>
    <div class="row">
      <div><label>Ridge per linear foot</label><input name="ridge_per_lf" type="number" step="0.01" value="${p.ridge_per_lf}"></div>
      <div><label>Eave / drip per linear foot</label><input name="eave_per_lf" type="number" step="0.01" value="${p.eave_per_lf}"></div>
    </div>
    <div class="row">
      <div><label>Per penetration</label><input name="penetration_fee" type="number" step="0.01" value="${p.penetration_fee}"></div>
      <div><label>Per chimney flash</label><input name="chimney_flash_fee" type="number" step="0.01" value="${p.chimney_flash_fee}"></div>
    </div>
    <label>Waste factor (%)</label><input name="waste_factor" type="number" step="1" value="${Math.round(p.waste_factor*100)}">
  </div>
  <div class="card">
    <h2 style="margin-top:0">Margin and surcharges</h2>
    <label>Target gross margin (%)</label><input name="gross_margin" type="number" step="1" value="${Math.round(p.gross_margin*100)}">
    <div class="hint">Margin, not markup. Price = cost ÷ (1 − margin).</div>
    <div class="row">
      <div><label>Steep pitch surcharge (%)</label><input name="pitch_surcharge" type="number" step="1" value="${Math.round(p.pitch_surcharge*100)}"></div>
      <div><label>Applies at pitch (x/12)</label><input name="steep_pitch_threshold" type="number" step="1" value="${p.steep_pitch_threshold}"></div>
    </div>
    <div class="row">
      <div><label>Two-story surcharge (%)</label><input name="two_story_surcharge" type="number" step="1" value="${Math.round(p.two_story_surcharge*100)}"></div>
      <div><label>Job minimum</label><input name="min_job_price" type="number" step="1" value="${p.min_job_price}"></div>
    </div>
  </div>`;
}

// Percent fields come in as whole numbers; store as decimals.
function normalizePricing(b) {
  const out = { ...b };
  ['gross_margin','pitch_surcharge','two_story_surcharge','waste_factor'].forEach(k => {
    if (b[k] !== undefined && b[k] !== '') out[k] = Number(b[k]) / 100;
  });
  return out;
}

const normalizePhone = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  return d.length === 10 ? '+1' + d : (d.length === 11 ? '+' + d : '+' + d);
};

const select = (name, opts, val) =>
  `<select name="${name}">${opts.map(o => `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;

const stat = (n, l) => `<div class="card stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return d; } };
const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

module.exports = router;
