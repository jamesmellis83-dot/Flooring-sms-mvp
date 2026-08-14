// === BidBuddy USA Roofing SMS Backend ===
// Telnyx SMS backend with JSON logging, admin dashboard, and roofing-first estimating.
// ProStall Flooring and flooring-specific estimating logic removed.

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_PHONE_NUMBER = process.env.TELNYX_PHONE_NUMBER || process.env.TELNYX_FROM_NUMBER;
const LOG_FILE = path.join(__dirname, "messages.json");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Static website files (public/) ---
app.use(express.static(path.join(__dirname, "public")));

app.get("/terms", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "terms.html")));

app.get("/privacy", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "privacy.html")));

app.get("/sms-consent", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "sms-consent.html")));

app.get("/onboarding", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "onboarding.html")));

app.get("/pricing-configurator", (req, res) =>
  res.sendFile(
    path.join(__dirname, "public", "pricing-configurator.html")
  ));

app.get("/cheatsheet", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "cheatsheet.html")));

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
    throw new Error("Missing TELNYX_PHONE_NUMBER or TELNYX_FROM_NUMBER environment variable");
  }

  const telnyxResponse = await fetch("https://api.telnyx.com/v2/messages", {
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

  const data = await telnyxResponse.text();

  if (!telnyxResponse.ok) {
    console.error("Telnyx Error Response:", data);
    throw new Error("Telnyx Error: " + data);
  }

  console.log("SMS Sent:", data);
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value || 0);
}

function numberFromMatch(text, regex) {
  const match = text.match(regex);
  return match ? Number(match[1]) : null;
}

function parseRoofingMessage(message) {
  const text = (message || "").toLowerCase();

  const squares = numberFromMatch(text, /(\d+(?:\.\d+)?)\s*(?:squares?|sq\b)/);
  const tearOffLayers = numberFromMatch(text, /(\d+)\s*(?:layers?|layer)/);
  const ridgeFeet = numberFromMatch(text, /(\d+(?:\.\d+)?)\s*(?:ft|feet|foot)?\s*ridge/);
  const valleyFeet = numberFromMatch(text, /(\d+(?:\.\d+)?)\s*(?:ft|feet|foot)?\s*valley/);
  const pipeBootCount = numberFromMatch(text, /(\d+)\s*(?:pipe boots?|boots?)/);
  const chimneyCount = numberFromMatch(text, /(\d+)\s*(?:chimneys?|chimney)/);
  const skylightCount = numberFromMatch(text, /(\d+)\s*(?:skylights?|skylight)/);
  const deckingSheets = numberFromMatch(text, /(\d+)\s*(?:sheets?|sheet)\s*(?:decking|osb|plywood)?/);

  const pitchMatch = text.match(/\b(\d+\s*\/\s*12)\b/);
  const pitch = pitchMatch ? pitchMatch[1].replace(/\s/g, "") : null;

  let materialType = null;
  if (text.includes("architectural")) materialType = "architectural shingles";
  else if (text.includes("3-tab") || text.includes("three tab")) materialType = "3-tab shingles";
  else if (text.includes("metal")) materialType = "metal roofing";
  else if (text.includes("shingle")) materialType = "shingles";

  let storyCount = null;
  if (text.includes("two story") || text.includes("two-story") || text.includes("2 story") || text.includes("2-story")) {
    storyCount = "two-story";
  } else if (text.includes("one story") || text.includes("one-story") || text.includes("1 story") || text.includes("1-story")) {
    storyCount = "one-story";
  }

  const dumpsterRequired = text.includes("dumpster") || text.includes("haul off") || text.includes("haul-off");
  const steepPitch = pitch ? Number(pitch.split("/")[0]) >= 7 : text.includes("steep");
  const twoStory = storyCount === "two-story";

  return {
    squares,
    materialType,
    tearOffLayers,
    pitch,
    storyCount,
    ridgeFeet,
    valleyFeet,
    pipeBootCount,
    chimneyCount,
    skylightCount,
    deckingSheets,
    dumpsterRequired,
    steepPitch,
    twoStory,
    originalMessage: message
  };
}

function missingRoofingInfo(job) {
  const missing = [];
  if (!job.squares) missing.push("roof squares");
  if (!job.materialType) missing.push("material type");
  if (job.tearOffLayers === null || job.tearOffLayers === undefined) missing.push("tear-off layers");
  if (!job.pitch) missing.push("roof pitch");
  if (!job.storyCount) missing.push("one-story or two-story");
  return missing;
}

function calculateRoofingEstimate(job) {
  // Demo roofing pricing only. Replace these with contractor-specific pricing before production sales use.
  const pricing = {
    baseInstallPerSquare: 425,
    tearOffPerSquarePerLayer: 85,
    steepPitchSurchargePerSquare: 45,
    twoStorySurchargePerSquare: 35,
    ridgeVentPerFoot: 9,
    valleyPerFoot: 14,
    pipeBootEach: 75,
    chimneyFlashingEach: 325,
    skylightFlashingEach: 275,
    deckingPerSheet: 95,
    dumpsterFlat: 450,
    minimumJob: 2500,
    marginPercent: 0.3
  };

  const lineItems = [];

  function addLine(label, quantity, rate, unit) {
    const qty = Number(quantity || 0);
    const amount = qty * rate;
    if (qty > 0 && amount > 0) {
      lineItems.push({ label, quantity: qty, unit, rate, amount });
    }
  }

  addLine("Roof installation", job.squares, pricing.baseInstallPerSquare, "square");
  addLine("Tear-off", job.squares * (job.tearOffLayers || 0), pricing.tearOffPerSquarePerLayer, "square/layer");

  if (job.steepPitch) {
    addLine("Steep pitch surcharge", job.squares, pricing.steepPitchSurchargePerSquare, "square");
  }

  if (job.twoStory) {
    addLine("Two-story surcharge", job.squares, pricing.twoStorySurchargePerSquare, "square");
  }

  addLine("Ridge detail", job.ridgeFeet, pricing.ridgeVentPerFoot, "linear foot");
  addLine("Valley detail", job.valleyFeet, pricing.valleyPerFoot, "linear foot");
  addLine("Pipe boots", job.pipeBootCount, pricing.pipeBootEach, "each");
  addLine("Chimney flashing", job.chimneyCount, pricing.chimneyFlashingEach, "each");
  addLine("Skylight flashing", job.skylightCount, pricing.skylightFlashingEach, "each");
  addLine("Decking replacement", job.deckingSheets, pricing.deckingPerSheet, "sheet");

  if (job.dumpsterRequired) {
    lineItems.push({
      label: "Dumpster / haul-off",
      quantity: 1,
      unit: "flat",
      rate: pricing.dumpsterFlat,
      amount: pricing.dumpsterFlat
    });
  }

  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const marginAmount = subtotal * pricing.marginPercent;
  const totalBeforeMinimum = subtotal + marginAmount;
  const total = Math.max(totalBeforeMinimum, pricing.minimumJob);

  return {
    ...job,
    lineItems,
    subtotal,
    marginAmount,
    total,
    minimumApplied: total > totalBeforeMinimum
  };
}

function formatRoofingReply(estimate) {
  const lines = [];

  lines.push(`Roofing Estimate: ${money(estimate.total)}`);
  lines.push("");

  lines.push(
    `${estimate.squares} squares | ${estimate.materialType} | ${estimate.pitch} pitch | ${estimate.storyCount}`
  );

  lines.push("");

  lines.push("Cost Breakdown:");

  estimate.lineItems.forEach(item => {
    lines.push(`• ${item.label}: ${money(item.amount)}`);
  });

  if (estimate.minimumApplied) {
    lines.push("• Minimum job charge applied");
  }

  lines.push("");

  lines.push("Estimator Notes:");

  if (estimate.twoStory) {
    lines.push("• Two-story access surcharge included.");
  }

  if (estimate.steepPitch) {
    lines.push("• Steep-pitch labor adjustment included.");
  }

  if (estimate.deckingSheets > 0) {
    lines.push(
      `• Includes ${estimate.deckingSheets} sheet(s) of decking replacement.`
    );
  }

  if (estimate.chimneyCount > 0) {
    lines.push(
      `• Includes flashing work for ${estimate.chimneyCount} chimney(s).`
    );
  }

  if (estimate.skylightCount > 0) {
    lines.push(
      `• Includes flashing work for ${estimate.skylightCount} skylight(s).`
    );
  }

  lines.push(
    "• Verify measurements, ventilation requirements, flashing scope, and decking conditions before finalizing pricing."
  );

  return lines.join("\n");
}

function estimateReply(message) {
  const job = parseRoofingMessage(message);
  const missing = missingRoofingInfo(job);

  if (missing.length > 0) {
    return "I can price that roofing job. Please send the roof squares, material type, tear-off layers, pitch, and whether it is one-story or two-story. Example: 28 squares architectural shingles, 1 layer tear-off, 6/12 pitch, two-story, 2 pipe boots.";
  }

  const estimate = calculateRoofingEstimate(job);
  return formatRoofingReply(estimate);
}

// Primary Telnyx webhook
app.post("/sms", async (req, res) => {
  console.log("Webhook received:", JSON.stringify(req.body, null, 2));

  const event = req.body && req.body.data;

  if (!event || event.event_type !== "message.received") {
    return res.sendStatus(200);
  }

  const payload = event.payload;
  const from = payload.from && payload.from.phone_number;
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
        <title>BidBuddy USA SMS Logs</title>
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
            background: #0f172a;
            color: white;
          }
          .badge {
            display: inline-block;
            background: #2563eb;
            color: white;
            padding: 4px 8px;
            border-radius: 999px;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <h1>BidBuddy USA SMS Logs</h1>
        <p><span class="badge">Roofing estimator</span></p>
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
    service: "BidBuddy USA Roofing SMS Estimator",
    provider: "telnyx",
    trade: "roofing",
    hasTelnyxKey: Boolean(TELNYX_API_KEY),
    hasTelnyxNumber: Boolean(TELNYX_PHONE_NUMBER),
    timestamp: new Date().toISOString()
  });
});

// Fallback only - if public/index.html exists, express.static serves it instead
app.get("/", (req, res) => {
  res.send(`
    <h1>BidBuddy USA Roofing SMS Estimator</h1>
    <p>Status: running</p>
    <p>Provider: Telnyx</p>
    <p><a href="/admin">Admin Dashboard</a></p>
    <p><a href="/health">Health Check</a></p>
  `);
});

app.listen(PORT, () => {
  console.log("BidBuddy USA roofing server running on port", PORT);
});
