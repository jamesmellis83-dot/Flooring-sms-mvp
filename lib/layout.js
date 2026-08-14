// lib/layout.js — server-rendered HTML shell for the portal.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function layout({ title = 'BidBuddy', user = null, company = null, active = '', body = '' }) {
  const isOwner = user && user.role === 'owner';
  const nav = user ? `
    <nav class="nav">
      <a href="/dashboard" class="${active==='dashboard'?'on':''}">Dashboard</a>
      <a href="/estimates" class="${active==='estimates'?'on':''}">Estimates</a>
      ${isOwner ? `<a href="/team" class="${active==='team'?'on':''}">Team</a>` : ''}
      ${isOwner ? `<a href="/pricing-profile" class="${active==='pricing'?'on':''}">Pricing</a>` : ''}
      <a href="/account" class="${active==='account'?'on':''}">Account</a>
      <form method="post" action="/logout" style="display:inline"><button class="link">Sign out</button></form>
    </nav>` : '';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--ink:#12161c;--mut:#5c6672;--line:#e3e7ec;--brand:#c2410c;--bg:#f7f8fa}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:#fff;border-bottom:1px solid var(--line)}
.wrap{max-width:1000px;margin:0 auto;padding:0 20px}
.bar{display:flex;align-items:center;justify-content:space-between;height:62px}
.logo{font-weight:800;letter-spacing:-.02em;font-size:20px;color:var(--ink);text-decoration:none}
.logo span{color:var(--brand)}
.nav a{margin-left:18px;color:var(--mut);text-decoration:none;font-size:15px;font-weight:500}
.nav a.on,.nav a:hover{color:var(--ink)}
.link{background:none;border:0;color:var(--mut);font:inherit;font-size:15px;margin-left:18px;cursor:pointer;padding:0}
main{padding:32px 0 64px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
h2{font-size:17px;margin:28px 0 12px}
.sub{color:var(--mut);margin:0 0 24px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
.stat .n{font-size:28px;font-weight:700;letter-spacing:-.02em}
.stat .l{color:var(--mut);font-size:13px;text-transform:uppercase;letter-spacing:.04em}
label{display:block;font-size:13px;font-weight:600;color:var(--mut);margin:14px 0 5px}
input,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:7px;font:inherit;background:#fff}
input:disabled{background:var(--bg);color:var(--mut)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
button.primary{background:var(--brand);color:#fff;border:0;border-radius:7px;padding:12px 20px;font:inherit;font-weight:600;cursor:pointer;margin-top:20px}
button.primary:hover{opacity:.92}
table{width:100%;border-collapse:collapse;font-size:15px}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);padding:8px 0;border-bottom:1px solid var(--line)}
td{padding:11px 8px 11px 0;border-bottom:1px solid var(--line);vertical-align:middle}
td input{padding:7px 9px}
.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:11px 14px;border-radius:7px;margin-bottom:16px;font-size:14px}
.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;padding:11px 14px;border-radius:7px;margin-bottom:16px;font-size:14px;word-break:break-all}
.hint{color:var(--mut);font-size:13px;margin-top:5px}
.auth{max-width:420px;margin:56px auto}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:14px}
a.b{color:var(--brand)}
@media(max-width:620px){.row{grid-template-columns:1fr}.nav a{margin-left:12px;font-size:14px}}
</style></head><body>
<header><div class="wrap bar">
  <a class="logo" href="${user ? '/dashboard' : '/'}">Bid<span>Buddy</span></a>
  ${nav}
</div></header>
<main><div class="wrap">${body}</div></main>
</body></html>`;
}

module.exports = { layout, esc };
