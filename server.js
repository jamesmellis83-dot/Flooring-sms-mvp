"use strict";

/**
 * BidBuddy USA — main server entry point
 *
 * Wires together:
 *   - db/index.js            multi-tenant SQLite store (companies, users, pricing, estimates)
 *   - lib/auth.js             session cookies + req.user / req.company + owner guards
 *   - routes/portal.js        signup, login, invites, dashboard, team, pricing-profile, account
 *   - lib/smsHandler.js       inbound SMS webhook (Telnyx) -> roofing estimate replies
 *   - public/                 marketing site, legal pages, pricing configurator demo
 */

const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");

const auth = require("./lib/auth");
const portalRoutes = require("./routes/portal");
const { handleSms } = require("./lib/smsHandler");

const app = express();

// Parse form posts (portal.js reads req.body.email, req.body.password, etc.)
app.use(express.urlencoded({ extended: true }));
// Parse JSON bodies (Telnyx webhook posts JSON)
app.use(express.json());

app.use(cookieParser());

// Attaches req.user and req.company from the session cookie on every request.
app.use(auth.loadUser);

// --- Authenticated portal -----------------------------------------------
// Mounted BEFORE the static file server on purpose: routes/portal.js owns
// /onboarding as the owner-only pricing setup wizard, which is also the
// redirect target immediately after signup. If the static file server were
// mounted first, public/onboarding.html would shadow that route and break
// the post-signup flow. NOTE: this means public/onboarding.html (the
// marketing "request setup" form) is currently unreachable at /onboarding.
// Recommend renaming its route (e.g. /request-setup) and updating the two
// links in public/index.html that point to /onboarding.
app.use("/", portalRoutes);

// --- Marketing site, legal pages, pricing configurator demo -------------
app.use(express.static(path.join(__dirname, "public")));

// Explicit fallback in case static resolution ever needs a nudge
// (kept per README-UPLOAD.txt instructions from the original site build).
app.get("/pricing-configurator", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pricing-configurator.html"));
});

// --- SMS webhook (Telnyx) ------------------------------------------------
// NOTE: lib/smsHandler.js currently keeps its own lightweight JSON-file
// conversation store and does not look up req.company from the database.
// Inbound Telnyx webhooks have no session cookie, so req.company is not
// set here. This means SMS conversations are not yet tied to a specific
// company record in db/index.js. That deeper SMS <-> multi-tenant-DB
// integration is a known follow-up item, not something this file solves.
app.post("/sms", (req, res) => {
  handleSms(req, res);
});

// Simple health check for Render / uptime monitoring
app.get("/healthz", (req, res) => res.status(200).send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BidBuddy server listening on port ${PORT}`);
});

module.exports = app;
