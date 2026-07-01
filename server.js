// === Telnyx SMS Backend for ProStall Flooring ===
// No SQLite version - uses a simple JSON file for logging

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_PHONE_NUMBER = process.env.TELNYX_PHONE_NUMBER;

const LOG_FILE = path.join(__dirname, "messages.json");

app.use(express.json());

function loadMessages() {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, JSON.stringify([], null, 2));
    }

    const raw = fs.readFileSync(LOG_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error loading messages:", err);
    return [];
  }
}

function saveMessage(message) {
  try {
    const messages = loadMessages();

    messages.push({
      id: Date.now(),
      created_at: new Date().toISOString(),
      ...message
    });

    fs.writeFileSync(LOG_FILE, JSON.stringify(messages.slice(-200), null, 2));
  } catch (err) {
    console.error("Error saving message:", err);
  }
}

async function sendSMS(to, text) {
  if (!TELNYX_API_KEY) {
    throw new Error("Missing TELNYX_API_KEY environment variable");
  }

  if (!TELNYX_PHONE_NUMBER) {
    throw new Error("Missing TELNYX_PHONE_NUMBER environment variable");
  }

  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: TELNYX_PHONE_NUMBER,
      to,
      text
    })
  });

  const data = await res.text();

  if (!res.ok) {
    console.error("Telnyx Error Response:", data);
    throw new Error("Telnyx Error: " + data);
  }

  console.log("SMS Sent:", data);
}

function estimateReply(message) {
  const text = message.toLowerCase();

  let price = null;
  let flooringType = null;

  if (text.includes("lvp") || text.includes("vinyl")) {
    price = 2.5;
    flooringType = "LVP";
  }

  if (text.includes("tile")) {
    price = 4.8;
    flooringType = "tile";
  }

  if (text.includes("hardwood") || text.includes("wood")) {
    price = 3.0;
    flooringType = "hardwood";
  }

  const match = text.match(/(\d+)/);
  const sqft = match ? Number(match[1]) : null;

  if (price && sqft) {
    const total = sqft * price;

    return `Thanks for reaching out to ProStall Flooring. Estimated labor for ${sqft} sq ft of ${flooringType} is $${total.toFixed(0)}. Final pricing may vary based on demo, prep, stairs, transitions, materials, and job conditions.`;
  }

  return "Thanks for reaching out to ProStall Flooring. Please send the flooring type (tile, LVP, or hardwood), approximate square footage, whether demo is needed, and the job location.";
}

// Primary Telnyx webhook
app.post("/sms", async (req, res) => {
  console.log("Webhook received:", JSON.stringify(req.body, null, 2));

  const event = req.body?.data;

  if (!event || event.event_type !== "message.received") {
    return res.sendStatus(200);
  }

  const payload = event.payload;

  const from = payload.from?.phone_number;
  const text = payload.text;

  console.log("Incoming:", from, text);

  // Respond immediately so Telnyx does not retry
  res.sendStatus(200);

  try {
    saveMessage({
      direction: "in",
      from_number: from,
      to_number: TELNYX_PHONE_NUMBER,
      body: text,
      status: "received"
    });

    const reply = estimateReply(text);

    await sendSMS(from, reply);

    saveMessage({
      direction: "out",
      from_number: TELNYX_PHONE_NUMBER,
      to_number: from,
      body: reply,
      status: "sent"
    });

  } catch (err) {
    console.error("ERROR processing SMS:", err);

    saveMessage({
      direction: "error",
      from_number: from,
      to_number: TELNYX_PHONE_NUMBER,
      body: text,
      status: "error",
      error: err.message
    });
  }
});

// Failover webhook
app.post("/sms-failover", (req, res) => {
  console.warn("FAILOVER TRIGGERED");
  console.warn("Failover payload:", JSON.stringify(req.body, null, 2));

  saveMessage({
    direction: "failover",
    body: JSON.stringify(req.body),
    status: "failover"
  });

  res.sendStatus(200);
});

// Admin dashboard
app.get("/admin", (req, res) => {
  const messages = loadMessages().reverse();

  const rows = messages.map(m => `
    <tr>
      <td>${m.created_at || ""}</td>
      <td>${m.direction || ""}</td>
      <td>${m.from_number || ""}</td>
      <td>${m.to_number || ""}</td>
      <td>${m.body || ""}</td>
      <td>${m.status || ""}</td>
      <td>${m.error || ""}</td>
    </tr>
  `).join("");

  res.send(`
    <html>
      <head>
        <title>ProStall Flooring SMS Logs</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 24px;
            background: #f5f5f5;
          }
          table {
            border-collapse: collapse;
            width: 100%;
            background: white;
          }
          th, td {
            border: 1px solid #ccc;
            padding: 8px;
            text-align: left;
            vertical-align: top;
          }
          th {
            background: #222;
            color: white;
          }
        </style>
      </head>
      <body>
        <h1>ProStall Flooring SMS Logs</h1>
        <p>Provider: Telnyx</p>
        <p>Primary webhook: /sms</p>
        <p>Failover webhook: /sms-failover</p>

        <table>
          <thead>
            <tr>
              <th>Created</th>
              <th>Direction</th>
              <th>From</th>
              <th>To</th>
              <th>Body</th>
              <th>Status</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="7">No messages yet.</td></tr>`}
          </tbody>
        </table>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    provider: "telnyx",
    hasTelnyxKey: Boolean(TELNYX_API_KEY),
    hasTelnyxNumber: Boolean(TELNYX_PHONE_NUMBER),
    timestamp: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.send(`
    <h1>ProStall Flooring SMS Estimator</h1>
    <p>Status: running</p>
    <p>Provider: Telnyx</p>
    <p>/adminAdmin Dashboard</a></p>
    <p>/healthHealth Check</a></p>
  `);
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});