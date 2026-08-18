// server.js — BidBuddy USA
// Replace your existing root server.js with this, or merge the marked sections.

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const authLib = require('./lib/auth');
const portal = require('./routes/portal');
const { handleInboundSms } = require('./lib/smsHandler');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(authLib.loadUser);            // puts req.contractor on every request

// ---- Marketing site ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- Contractor portal ----
app.use('/', portal);

// ---- SMS webhook (Telnyx) ----
app.post('/sms', async (req, res) => {
  try {
    console.log('FULL SMS PAYLOAD:', JSON.stringify(req.body, null, 2));

    const p = req.body?.data?.payload || req.body || {};
    const from = p.from?.phone_number || p.from || req.body.From;
    const text = p.text || req.body.Body || '';

    console.log('FROM:', from);
    console.log('TEXT:', text);

    res.sendStatus(200);

    if (!from || !text) return;

    const reply = await handleInboundSms({ from, text });

    console.log('REPLY:', reply);

    await sendSms({
      to: from,
      text: reply
    });

  } catch (err) {
    console.error('SMS handler error:', err);
  }
});
``

async function sendSms({ to, text }) {
  const r = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
    },
    body: JSON.stringify({ from: process.env.TELNYX_PHONE_NUMBER, to, text }),
  });
  if (!r.ok) console.error('Telnyx send failed:', r.status, await r.text());
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BidBuddy running on ${PORT}`));
