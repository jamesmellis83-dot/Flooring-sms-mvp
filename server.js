require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const basicAuth = require('basic-auth');
const twilio = require('twilio');
const path = require('path');
const https = require('https');
const http = require('http');

const db = require('./lib/db');
const cfg = require('./lib/configStore');
const { handleIncoming } = require('./lib/flow');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// ---------- Twilio SMS Webhook ----------
app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  console.log(`📥 ${from}: ${body}`);
  db.logMessage(from, 'in', body);

  let reply;
  try { reply = await handleIncoming(from, body); }
  catch (err) {
    console.error('Flow error:', err);
    reply = 'Sorry, something went sideways on my end. Try again.';
  }

  const replies = Array.isArray(reply) ? reply : [reply];

  // First reply goes via TwiML (instant response)
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(replies[0]);
  db.logMessage(from, 'out', replies[0]);
  console.log(`📤 ${from}: ${replies[0]}`);
  res.type('text/xml').send(twiml.toString());

  // Additional replies (onboarding + first job) sent via REST API after a short delay
  if (replies.length > 1 && twilioClient && process.env.TWILIO_PHONE_NUMBER) {
    for (let i = 1; i < replies.length; i++) {
      setTimeout(() => {
        twilioClient.messages.create({
          from: process.env.TWILIO_PHONE_NUMBER,
          to: from,
          body: replies[i],
        }).then(() => {
          db.logMessage(from, 'out', replies[i]);
          console.log(`📤 ${from}: ${replies[i]}`);
        }).catch(err => console.error('Follow-up SMS failed:', err.message));
      }, i * 1500);
    }
  }
});

// ---------- Health check / keep-alive ----------
app.get('/', (_req, res) => res.send('✅ ProStall Flooring SMS estimator running. Admin: /admin'));
app.get('/healthz', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- KEEP-ALIVE PING ----------
// Render free tier sleeps after 15 min idle. Self-ping every 10 min to stay warm.
if (process.env.APP_URL) {
  setInterval(() => {
    const url = process.env.APP_URL.replace(/\/$/, '') + '/healthz';
    const client = url.startsWith('https') ? https : http;
    client.get(url, r => {
      console.log(`💓 Keep-alive ping → ${r.statusCode}`);
    }).on('error', err => console.error('Keep-alive failed:', err.message));
  }, 10 * 60 * 1000);
  console.log(`💓 Keep-alive enabled — pinging ${process.env.APP_URL}/healthz every 10 min`);
}

// ---------- Public cheat-sheet (no auth — share this with contractor) ----------
app.get('/cheatsheet', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cheatsheet.html'));
});
app.use('/public', express.static(path.join(__dirname, 'public')));

// ---------- Admin auth ----------
function requireAuth(req, res, next) {
  const u = basicAuth(req);
  if (!u || u.name !== process.env.ADMIN_USER || u.pass !== process.env.ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Authentication required.');
  }
  next();
}
app.use('/admin', requireAuth);
app.use('/admin', express.static(path.join(__dirname, 'views')));

app.get('/admin/api/convos', (_req, res) => res.json(db.getAllConvos()));
app.get('/admin/api/messages/:phone', (req, res) => res.json(db.getMessages(req.params.phone, 200)));
app.get('/admin/api/leads', (_req, res) => res.json(db.getAllLeads()));
app.get('/admin/api/stats', (_req, res) => res.json(db.getStats()));
app.get('/admin/api/prompts', (_req, res) => res.json(cfg.prompts()));
app.get('/admin/api/pricing', (_req, res) => res.json(cfg.pricing()));
app.post('/admin/api/prompts', (req, res) => {
  try { cfg.save('prompts', req.body); res.json({ ok: true, savedAt: new Date().toISOString() }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/admin/api/pricing', (req, res) => {
  try { cfg.save('pricing', req.body); res.json({ ok: true, savedAt: new Date().toISOString() }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/admin/api/test-sms', async (req, res) => {
  const { phone = '+1SANDBOX', body } = req.body;
  db.logMessage(phone, 'in', body);
  const reply = await handleIncoming(phone, body);
  const replies = Array.isArray(reply) ? reply : [reply];
  replies.forEach(r => db.logMessage(phone, 'out', r));
  res.json({ reply: replies.join('\n\n---\n\n') });
});

app.listen(PORT, () => {
  console.log(`🚀 Server on :${PORT}`);
  console.log(`   Admin:      http://localhost:${PORT}/admin`);
  console.log(`   Webhook:    http://localhost:${PORT}/sms`);
  console.log(`   Cheatsheet: http://localhost:${PORT}/cheatsheet`);
});
