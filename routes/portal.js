// routes/portal.js — signup, login, invites, onboarding, dashboard, pricing, team, estimates
//
// TENANCY: every handler scopes to req.company.id, which comes from the session.
// No route ever accepts a company id from the URL or form body.

const express = require('express');
const store = require('../db');
const auth = require('../lib/auth');
const { layout, esc } = require('../lib/layout');
const { money } = require('../lib/roofingPricing');

const router = express.Router();
const siteUrl = () => process.env.SITE_URL || 'https://bidbuddyusa.com';

/* ================= SIGN UP (creates a company + owner) ================= */

router.get('/signup', (req, res) => {
  res.send(layout({ title: 'Start your trial — BidBuddy', body: `
    <div class="auth">
      <h1>Start your 30-day trial</h1>
      <p class="sub">One account for your whole crew. No card required.</p>
      ${req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : ''}
      <form method="post" action="/signup" class="card">
        <label>Company name</label><input name="company_name" required placeholder="Summit Roofing">
        <label>Your name</label><input name="owner_name" required>
        <div class="row">
          <div><label>Email</label><input type="email" name="email" required></div>
          <div><label>Password</label><input type="password" name="password" required minlength="8"></div>
        </div>
        <label>Your mobile number</label><input name="phone" required placeholder="901-555-0142">
        <div class="hint">The number you'll text estimates from. You can add your other estimators after setup.</div>
        <button class="primary">Create account</button>
      </form>
      <p class="sub" style="text-align:center">Already set up? <a class="b" href="/login">Sign in</a></p>
    </div>`}));
});

router.post('/signup', (req, res) => {
  const { company_name, owner_name, email, password, phone } = req.body;
  if (!email || !password || password.length < 8) return res.redirect('/signup?err=' + encodeURIComponent('Password must be at least 8 characters.'));
  if (store.getUserByEmail(email)) return res.redirect('/signup?err=' + encodeURIComponent('That email already has an account.'));
  try {
    const owner = store.createCompanyWithOwner({
      company_name, owner_name, email,
      password_hash: auth.hash(password),
      phone: normalizePhone(phone),
    });
    auth.login(res, owner.id);
    res.redirect('/onboarding');
  } catch (e) {
    res.redirect('/signup?err=' + encodeURIComponent('Could not create account. That phone number may already be in use.'));
  }
});

/* ================= LOGIN ================= */

router.get('/login', (req, res) => {
  res.send(layout({ title: 'Sign in — BidBuddy', body: `
    <div class="auth">
      <h1>Sign in</h1>
      ${req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : ''}
      ${req.query.ok ? `<div class="ok">${esc(req.query.ok)}</div>` : ''}
      <form method="post" action="/login" class="card">
        <label>Email</label><input type="email" name="email" required>
        <label>Password</label><input type="password" name="password" required>
        <button class="primary">Sign in</button>
      </form>
      <p class="sub" style="text-align:center">New here? <a class="b" href="/signup">Start a trial</a></p>
    </div>`}));
});

router.post('/login', (req, res) => {
  const u = store.getUserByEmail(req.body.email || '');
  if (!u || u.status !== 'active' || !auth.verify(req.body.password || '', u.password_hash)) {
    return res.redirect('/login?err=' + encodeURIComponent('Email or password is incorrect.'));
  }
  auth.login(res, u.id);
  const co = store.getCompany(u.company_id);
  res.redirect(co.onboarded || u.role !== 'owner' ? '/dashboard' : '/onboarding');
});

router.post('/logout', (req, res) => { auth.logout(req, res); res.redirect('/'); });

/* ================= INVITE ACTIVATION ================= */

router.get('/join/:token', (req, res) => {
  const u = store.getUserByInvite(req.params.token);
  if (!u) return res.send(layout({ title: 'Invite', body: `
    <div class="auth"><h1>Invite not found</h1>
    <p class="sub">This link may have already been used. Ask your owner to resend it.</p></div>`}));

  const co = store.getCompany(u.company_id);
  res.send(layout({ title: 'Join ' + co.company_name, body: `
    <div class="auth">
      <h1>Join ${esc(co.company_name)}</h1>
      <p class="sub">Set your password and confirm the number you'll text estimates from.</p>
      ${req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : ''}
      <form method="post" action="/join/${esc(req.params.token)}" class="card">
        <label>Your name</label><input name="full_name" value="${esc(u.full_name||'')}" required>
        <label>Email</label><input value="${esc(u.email)}" disabled>
        <label>Your mobile number</label><input name="phone" value="${esc(u.phone||'')}" required placeholder="901-555-0142">
        <label>Create a password</label><input type="password" name="password" required minlength="8">
        <button class="primary">Join</button>
      </form>
    </div>`}));
});

router.post('/join/:token', (req, res) => {
  const { password, full_name, phone } = req.body;
  if (!password || password.length < 8) return res.redirect(`/join/${req.params.token}?err=` + encodeURIComponent('Password must be at least 8 characters.'));
  try {
    const u = store.activateInvite(req.params.token, {
      password_hash: auth.hash(password), full_name, phone: normalizePhone(phone),
    });
    if (!u) return res.redirect('/login?err=' + encodeURIComponent('That invite is no longer valid.'));
    auth.login(res, u.id);
    res.redirect('/dashboard?ok=' + encodeURIComponent("You're in. Text a job to your BidBuddy number to try it."));
  } catch (e) {
    res.redirect(`/join/${req.params.token}?err=` + encodeURIComponent('That phone number is already registered.'));
  }
});

/* ================= ONBOARDING (owner only) ================= */

router.get('/onboarding', auth.requireOwner, (req, res) => {
  const p = store.getPricing(req.company.id);
  const shingles = store.listShingles(req.company.id);
  res.send(layout({ title: 'Set up your pricing', user: req.user, company: req.company, body: `
    <h1>Set up ${esc(req.company.company_name)}</h1>
    <p class="sub">These numbers are shared by every estimator on your account. Change them any time.</p>
    <form method="post" action="/onboarding">
      <div class="card">
        <h2 style="margin-top:0">Your business</h2>
        <label>Service area</label><input name="service_area" placeholder="Memphis metro, Bartlett, Cordova, Collierville" value="${esc(req.company.service_area||'')}">
        <div class="row">
          <div><label>Primary supplier</label>${select('supplier', ['ABC Supply','SRS','Beacon','Other'], req.company.supplier)}</div>
          <div><label>Branch (optional)</label><input name="supplier_branch" value="${esc(req.company.supplier_branch||'')}"></div>
        </div>
      </div>
      <div class="card">
        <h2 style="margin-top:0">Your shingle costs</h2>
        <p class="hint" style="margin:0 0 6px">What you pay per square, delivered. Pick the one you install most as your default.</p>
        <table style="margin-top:14px">
          <tr><th>Shingle</th><th style="width:150px">Cost per square</th><th style="width:80px">Default</th></tr>
          ${shingles.map(s => `<tr>
            <td><input name="sh_name_${s.id}" value="${esc(s.name)}"></td>
            <td><input name="sh_cost_${s.id}" type="number" step="0.01" value="${s.cost_per_square}"></td>
            <td style="text-align:center"><input type="radio" name="default_shingle_id" value="${s.id}"${s.is_default ? ' checked' : ''} style="width:auto"></td>
          </tr>`).join('')}
        </table>
      </div>
      ${pricingFields(p)}
      <button class="primary">Save and start estimating</button>
    </form>`}));
});

router.post('/onboarding', auth.requireOwner, (req, res) => {
  store.updateCompany(req.company.id, {
    service_area: req.body.service_area,
    supplier: req.body.supplier,
    supplier_branch: req.body.supplier_branch,
    onboarded: 1,
  });
  store.updatePricing(req.company.id, normalizePricing(req.body));
  applyShingleEdits(req.company.id, req.body);
  res.redirect('/team?ok=' + encodeURIComponent('Pricing saved. Now add the rest of your estimators — they all quote off these numbers.'));
});

/* ================= DASHBOARD ================= */

router.get('/dashboard', auth.requireAuth, (req, res) => {
  const co = req.company;
  const s = store.estimateStats(co.id);
  const mine = req.query.mine === '1';
  const recent = store.listEstimates(co.id, { limit: 10, userId: mine ? req.user.id : null });
  const byUser = req.user.role === 'owner' ? store.statsByUser(co.id) : [];

  res.send(layout({ title: 'Dashboard — BidBuddy', user: req.user, company: co, active: 'dashboard', body: `
    ${req.query.ok  ? `<div class="ok">${esc(req.query.ok)}</div>` : ''}
    ${req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : ''}
    <h1>${esc(co.company_name)}</h1>
    <p class="sub">${esc(co.subscription_status === 'trial' ? 'Trial — ends ' + fmtDate(co.trial_ends_at) : 'Active subscription')} · ${store.seatCount(co.id)} estimator${store.seatCount(co.id) === 1 ? '' : 's'}</p>
    <div class="grid">
      ${stat(s.this_month, 'Estimates this month')}
      ${stat(s.total, 'Total estimates')}
      ${stat(money(s.value), 'Estimated value')}
      ${stat(money(s.avg), 'Average estimate')}
    </div>

    ${byUser.length > 1 ? `<h2>By estimator</h2><div class="card"><table>
      <tr><th>Estimator</th><th>Estimates</th><th>Value</th></tr>
      ${byUser.map(u => `<tr><td>${esc(u.full_name || '—')}${u.role === 'owner' ? ' <span class="hint">owner</span>' : ''}</td><td>${u.total}</td><td>${money(u.value)}</td></tr>`).join('')}
    </table></div>` : ''}

    <h2>Recent estimates ${mine ? '<a class="b" style="font-size:14px;font-weight:400" href="/dashboard">Show everyone</a>' : '<a class="b" style="font-size:14px;font-weight:400" href="/dashboard?mine=1">Just mine</a>'}</h2>
    <div class="card">
      ${recent.length ? `<table>
        <tr><th>Job</th><th>Estimator</th><th>Squares</th><th>Price</th><th>Date</th></tr>
        ${recent.map(e => `<tr>
          <td>${esc(e.customer_name || e.job_address || 'Untitled job')}</td>
          <td>${esc(e.estimator || '—')}</td>
          <td>${e.squares ?? '—'}</td>
          <td>${money(e.estimate_amount)}</td>
          <td>${fmtDate(e.created_at)}</td>
        </tr>`).join('')}
      </table>` : `<p class="sub" style="margin:0">No estimates yet. Text a job to your BidBuddy number — something like <span class="mono">32 sq, 1 layer tear off, 8/12 pitch, 2 story</span>.</p>`}
    </div>`}));
});

/* ================= ESTIMATES ================= */

router.get('/estimates', auth.requireAuth, (req, res) => {
  const mine = req.query.mine === '1';
  const rows = store.listEstimates(req.company.id, { limit: 200, userId: mine ? req.user.id : null });
  res.send(layout({ title: 'Estimates — BidBuddy', user: req.user, company: req.company, active: 'estimates', body: `
    <h1>Estimates</h1>
    <p class="sub">Every job your company has priced. ${mine ? '<a class="b" href="/estimates">Show everyone</a>' : '<a class="b" href="/estimates?mine=1">Just mine</a>'}</p>
    <div class="card">
      ${rows.length ? `<table>
        <tr><th>Job</th><th>Estimator</th><th>Squares</th><th>Shingle</th><th>Cost</th><th>Price</th><th>Date</th></tr>
        ${rows.map(e => { const j = safeJson(e.estimate_json); return `<tr>
          <td>${esc(e.customer_name || e.job_address || 'Untitled job')}</td>
          <td>${esc(e.estimator || '—')}</td>
          <td>${e.squares ?? '—'}</td>
          <td>${esc(j.shingle || '—')}</td>
          <td>${j.total_cost != null ? money(j.total_cost) : '—'}</td>
          <td>${money(e.estimate_amount)}</td>
          <td>${fmtDate(e.created_at)}</td>
        </tr>`; }).join('')}
      </table>` : '<p class="sub" style="margin:0">Nothing here yet.</p>'}
    </div>`}));
});

/* ================= TEAM (owner only) ================= */

router.get('/team', auth.requireOwner, (req, res) => {
  const users = store.listUsers(req.company.id);
  const seats = store.seatCount(req.company.id);
  res.send(layout({ title: 'Team — BidBuddy', user: req.user, company: req.company, active: 'team', body: `
    ${req.query.ok  ? `<div class="ok">${esc(req.query.ok)}</div>` : ''}
    ${req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : ''}
    ${req.query.invite ? `<div class="ok">Invite link — send this to them:<br><span class="mono">${esc(siteUrl())}/join/${esc(req.query.invite)}</span></div>` : ''}
    <h1>Your team</h1>
    <p class="sub">${seats} of ${req.company.seat_limit} seats used. Everyone quotes off the same pricing, and every estimate lands in one dashboard.</p>

    <div class="card">
      <table>
        <tr><th>Name</th><th>Email</th><th>Texts from</th><th>Role</th><th>Status</th><th></th></tr>
        ${users.map(u => `<tr>
          <td>${esc(u.full_name || '—')}</td>
          <td>${esc(u.email)}</td>
          <td class="mono">${esc(u.phone || '—')}</td>
          <td>${esc(u.role)}</td>
          <td>${u.status === 'invited' ? '<span style="color:var(--brand)">invited</span>' : esc(u.status)}</td>
          <td>${u.id === req.user.id ? '<span class="hint">you</span>' :
            `<form method="post" action="/team/${u.id}/remove" style="display:inline"><button class="link" style="margin:0;font-size:13px;color:#b91c1c">Remove</button></form>`}</td>
        </tr>`).join('')}
      </table>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Add an estimator</h2>
      <p class="hint" style="margin:0 0 10px">They get a link to set a password and register the phone they text from.</p>
      <form method="post" action="/team">
        <div class="row">
          <div><label>Name</label><input name="full_name" placeholder="Dale Whitaker"></div>
          <div><label>Email</label><input type="email" name="email" required></div>
        </div>
        <label>Mobile number they'll text from (optional)</label><input name="phone" placeholder="901-555-0177">
        <button class="primary">Create invite</button>
      </form>
    </div>`}));
});

router.post('/team', auth.requireOwner, (req, res) => {
  const r = store.inviteUser(req.company.id, {
    full_name: req.body.full_name, email: req.body.email, phone: normalizePhone(req.body.phone),
  });
  if (r.error) return res.redirect('/team?err=' + encodeURIComponent(r.error));
  res.redirect('/team?invite=' + encodeURIComponent(r.token));
});

router.post('/team/:id/remove', auth.requireOwner, (req, res) => {
  const r = store.removeUser(req.company.id, req.params.id);
  res.redirect('/team?' + (r.error ? 'err=' + encodeURIComponent(r.error) : 'ok=' + encodeURIComponent('Removed.')));
});

/* ================= PRICING (owner only) ================= */

router.get('/pricing-profile', auth.requireOwner, (req, res) => {
  const p = store.getPricing(req.company.id);
  const shingles = store.listShingles(req.company.id);

  res.send(layout({ title: 'Pricing — BidBuddy', user: req.user, company: req.company, active: 'pricing', body: `
    ${req.query.ok  ? `<div class="ok">${esc(req.query.ok)}</div>` : ''}
    ${req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : ''}
    <h1>Your pricing</h1>
    <p class="sub">Shared by every estimator on the account. Change it here and the next text-in estimate uses the new numbers.</p>

    <div class="card">
      <h2 style="margin-top:0">Shingles &amp; material costs</h2>
      <p class="hint" style="margin:0 0 14px">Your delivered cost per square. Texting "switch it to Duration" reprices using that line.</p>
      <table>
        <tr><th>Shingle</th><th style="width:150px">Cost / square</th><th style="width:80px">Default</th><th style="width:70px"></th></tr>
        ${shingles.map(s => `<tr>
          <td><form method="post" action="/shingles/${s.id}" id="f${s.id}"><input name="name" value="${esc(s.name)}"></td>
          <td><input name="cost_per_square" type="number" step="0.01" value="${s.cost_per_square}"></td>
          <td style="text-align:center">${s.is_default
              ? '<span title="Default" style="color:var(--brand);font-weight:700">●</span>'
              : `<button formaction="/shingles/${s.id}/default" class="link" style="margin:0;font-size:13px">Set</button>`}</td>
          <td><button class="link" style="margin:0;font-size:13px">Save</button>${shingles.length > 1
              ? `<button formaction="/shingles/${s.id}/delete" class="link" style="margin:0 0 0 8px;font-size:13px;color:#b91c1c">Delete</button>` : ''}</form></td>
        </tr>`).join('')}
      </table>
      <form method="post" action="/shingles" style="margin-top:18px;display:grid;grid-template-columns:1fr 150px auto;gap:10px;align-items:end">
        <div><label style="margin-top:0">Add a product</label><input name="name" placeholder="Malarkey Legacy" required></div>
        <div><label style="margin-top:0">Cost / square</label><input name="cost_per_square" type="number" step="0.01" placeholder="185" required></div>
        <button class="primary" style="margin:0">Add</button>
      </form>
    </div>

    <form method="post" action="/pricing-profile">
      <div class="card">
        <h2 style="margin-top:0">Supplier</h2>
        <div class="row">
          <div><label>Primary supplier</label>${select('supplier', ['ABC Supply','SRS','Beacon','Other'], req.company.supplier)}</div>
          <div><label>Branch</label><input name="supplier_branch" value="${esc(req.company.supplier_branch||'')}"></div>
        </div>
      </div>
      ${pricingFields(p)}
      <button class="primary">Save pricing</button>
    </form>`}));
});

router.post('/pricing-profile', auth.requireOwner, (req, res) => {
  store.updateCompany(req.company.id, { supplier: req.body.supplier, supplier_branch: req.body.supplier_branch });
  store.updatePricing(req.company.id, normalizePricing(req.body));
  res.redirect('/pricing-profile?ok=' + encodeURIComponent('Saved. Your next estimate uses these numbers.'));
});

/* ================= SHINGLE ACTIONS (owner only) ================= */

router.post('/shingles', auth.requireOwner, (req, res) => {
  const ok = store.addShingle(req.company.id, req.body);
  res.redirect('/pricing-profile?' + (ok ? 'ok=' + encodeURIComponent('Product added.') : 'err=' + encodeURIComponent('Need a name and a cost per square.')));
});

router.post('/shingles/:id', auth.requireOwner, (req, res) => {
  store.updateShingle(req.company.id, req.params.id, req.body);
  res.redirect('/pricing-profile?ok=' + encodeURIComponent('Updated.'));
});

router.post('/shingles/:id/default', auth.requireOwner, (req, res) => {
  store.setDefaultShingle(req.company.id, req.params.id);
  res.redirect('/pricing-profile?ok=' + encodeURIComponent('Default shingle changed.'));
});

router.post('/shingles/:id/delete', auth.requireOwner, (req, res) => {
  const ok = store.deleteShingle(req.company.id, req.params.id);
  res.redirect('/pricing-profile?' + (ok ? 'ok=' + encodeURIComponent('Removed.') : 'err=' + encodeURIComponent('You need at least one product on the list.')));
});

/* ================= ACCOUNT ================= */

router.get('/account', auth.requireAuth, (req, res) => {
  const u = req.user, co = req.company;
  res.send(layout({ title: 'Account — BidBuddy', user: u, company: co, active: 'account', body: `
    ${req.query.ok ? `<div class="ok">${esc(req.query.ok)}</div>` : ''}
    <h1>Account</h1>
    <p class="sub">${esc(co.company_name)} · ${esc(u.role)} · ${esc(co.subscription_status)}${co.trial_ends_at ? ', trial ends ' + fmtDate(co.trial_ends_at) : ''}</p>

    <form method="post" action="/account" class="card">
      <h2 style="margin-top:0">You</h2>
      <label>Your name</label><input name="full_name" value="${esc(u.full_name||'')}">
      <label>Mobile number you text from</label><input name="phone" value="${esc(u.phone||'')}">
      <div class="hint">Estimates only work from this number.</div>
      <button class="primary">Save</button>
    </form>

    ${u.role === 'owner' ? `<form method="post" action="/account/company" class="card">
      <h2 style="margin-top:0">Company</h2>
      <label>Company name</label><input name="company_name" value="${esc(co.company_name)}">
      <label>Service area</label><input name="service_area" value="${esc(co.service_area||'')}">
      <button class="primary">Save</button>
    </form>` : ''}`}));
});

router.post('/account', auth.requireAuth, (req, res) => {
  store.updateUser(req.company.id, req.user.id, {
    full_name: req.body.full_name, phone: normalizePhone(req.body.phone),
  });
  res.redirect('/account?ok=' + encodeURIComponent('Saved.'));
});

router.post('/account/company', auth.requireOwner, (req, res) => {
  store.updateCompany(req.company.id, {
    company_name: req.body.company_name, service_area: req.body.service_area,
  });
  res.redirect('/account?ok=' + encodeURIComponent('Company updated.'));
});

/* ================= helpers ================= */

function pricingFields(p) {
  return `
  <div class="card">
    <h2 style="margin-top:0">Labor &amp; job costs</h2>
    <div class="row">
      <div><label>Labor per square</label><input name="labor_per_square" type="number" step="0.01" value="${p.labor_per_square}"></div>
      <div><label>Tear-off per square, per layer</label><input name="tearoff_per_layer" type="number" step="0.01" value="${p.tearoff_per_layer}"></div>
    </div>
    <div class="row">
      <div><label>Disposal / dumpster</label><input name="dumpster_fee" type="number" step="0.01" value="${p.dumpster_fee}"></div>
      <div><label>Waste factor (%)</label><input name="waste_factor" type="number" step="1" value="${Math.round(p.waste_factor*100)}"></div>
    </div>
    <div class="row">
      <div><label>Ridge per linear foot</label><input name="ridge_per_lf" type="number" step="0.01" value="${p.ridge_per_lf}"></div>
      <div><label>Eave / drip per linear foot</label><input name="eave_per_lf" type="number" step="0.01" value="${p.eave_per_lf}"></div>
    </div>
    <div class="row">
      <div><label>Per penetration</label><input name="penetration_fee" type="number" step="0.01" value="${p.penetration_fee}"></div>
      <div><label>Per chimney flash</label><input name="chimney_flash_fee" type="number" step="0.01" value="${p.chimney_flash_fee}"></div>
    </div>
    <label>Fallback material rate per square</label><input name="material_per_square" type="number" step="0.01" value="${p.material_per_square}">
    <div class="hint">Only used if no shingle is matched. Your shingle list normally drives material cost.</div>
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

function applyShingleEdits(companyId, body) {
  Object.keys(body).forEach(k => {
    const m = k.match(/^sh_name_(\d+)$/);
    if (!m) return;
    store.updateShingle(companyId, m[1], { name: body[k], cost_per_square: body['sh_cost_' + m[1]] });
  });
  if (body.default_shingle_id) store.setDefaultShingle(companyId, body.default_shingle_id);
}

function normalizePricing(b) {
  const out = { ...b };
  ['gross_margin','pitch_surcharge','two_story_surcharge','waste_factor'].forEach(k => {
    if (b[k] !== undefined && b[k] !== '') out[k] = Number(b[k]) / 100;
  });
  delete out.default_shingle;
  return out;
}

const normalizePhone = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  return d.length === 10 ? '+1' + d : '+' + d;
};

const select = (name, opts, val) =>
  `<select name="${name}">${opts.map(o => `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;

const stat = (n, l) => `<div class="card stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return d; } };
const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

module.exports = router;
