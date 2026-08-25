"use strict";

/**
 * BidBuddy Roofing SMS Handler
 * Complete replacement file for lib/smsHandler.js
 *
 * Goal:
 * - Sound like an experienced human roofing estimator, not a generic bot.
 * - Maintain conversation context by phone/company when possible.
 * - Gather required roofing inputs before producing a defendable rough range.
 * - Answer natural estimator follow-up questions after a quote.
 * - Keep decking separate from the base roof estimate unless confirmed.
 * - Use the estimator's OWN company pricing profile (labor rate, margin,
 *   waste factor, shingle costs) whenever the texting number is recognized,
 *   falling back to generic placeholder pricing only when it is not.
 * - Honor STOP / HELP / START compliance keywords BEFORE any other
 *   processing, exactly matching the keyword sets and confirmation
 *   messages registered on the BidBuddy USA LLC 10DLC campaign
 *   (Campaign ID 4b30019f-ed47-92e2-52b9-2e63d0671a29 / TCR CW91TMM).
 *
 * Expected usage from an Express route:
 *   const { handleSms } = require("./lib/smsHandler");
 *   app.post("/sms", handleSms);
 *
 * This file is intentionally dependency-light. It will use:
 * - Existing pricing modules if available (lib/roofingPricing.js).
 * - The multi-tenant DB (db/index.js) if available, to resolve which
 *   company/estimator sent the text and load their real pricing profile,
 *   and to persist SMS opt-out/opt-in status so it survives redeploys.
 * - Telnyx API if TELNYX_API_KEY and TELNYX_PHONE_NUMBER are set.
 * - Optional JSON persistence so SMS context survives normal request flow,
 *   and as an automatic fallback for opt-out status if the DB call throws.
 */

const fs = require("fs");
const path = require("path");

// -----------------------------------------------------------------------------
// Optional pricing module loading (lib/roofingPricing.js — the real engine)
// -----------------------------------------------------------------------------

let pricingModule = null;
const pricingModuleCandidates = [
  "./roofingpricing",
  "./roofingPricing",
  "./pricing",
  "../lib/roofingpricing",
  "../lib/roofingPricing",
  "../lib/pricing"
];

for (const candidate of pricingModuleCandidates) {
  try {
    pricingModule = require(candidate);
    break;
  } catch (_) {
    // Keep trying. This file can still produce useful conversations without it.
  }
}

// -----------------------------------------------------------------------------
// Optional multi-tenant DB loading (companies, users, pricing_profiles, shingles)
// -----------------------------------------------------------------------------

let dbModule = null;
try {
  dbModule = require("../db");
} catch (_) {
  // No DB available (e.g. running standalone/tests). Fallback pricing still works.
  dbModule = null;
}

// Resolves which company/estimator sent this text, and loads that company's
// real pricing profile, so estimates use the contractor's own rates instead
// of the generic fallback numbers. Looks up by the estimator's own phone
// (the number they text FROM), matching the multi-tenant user model where
// each estimator's personal cell is registered to exactly one company.
function resolveEstimatorContext(fromPhone) {
  if (!dbModule || typeof dbModule.getUserByPhone !== "function") return null;
  try {
    const user = dbModule.getUserByPhone(fromPhone);
    if (!user) return null;
    const pricing = typeof dbModule.getPricing === "function" ? dbModule.getPricing(user.company_id) : null;
    if (!pricing) return null;
    return { user, companyId: user.company_id, companyName: user.company_name, pricing };
  } catch (_) {
    return null;
  }
}

// Looks up (or falls back to the default) shingle for this company, matching
// on whatever material text the estimator has sent so far.
function resolveShingle(estimatorContext, materialText) {
  if (!estimatorContext || !dbModule) return null;
  try {
    if (materialText && typeof dbModule.matchShingle === "function") {
      const matched = dbModule.matchShingle(estimatorContext.companyId, materialText);
      if (matched) return matched;
    }
    if (typeof dbModule.getDefaultShingle === "function") {
      return dbModule.getDefaultShingle(estimatorContext.companyId);
    }
  } catch (_) {
    // fall through
  }
  return null;
}

// Maps this file's job shape (tearOffLayers, pitch as "8/12", ridgeLf, pipeBoots)
// into the shape lib/roofingPricing.js's calculateRoofEstimate expects
// (layers, numeric pitch, ridge_lf, eave_lf, penetrations).
function mapJobForPricingEngine(job) {
  return {
    squares: job.squares,
    layers: job.tearOffLayers,
    pitch: parsePitchNumber(job.pitch),
    stories: job.stories,
    ridge_lf: job.ridgeLf,
    eave_lf: job.eaveRakeLf,
    penetrations: job.pipeBoots || job.penetrations,
    chimneys: job.chimneys
  };
}

// -----------------------------------------------------------------------------
// Compliance: STOP / HELP / START keyword handling
// -----------------------------------------------------------------------------
// These keyword lists and confirmation messages are kept in exact sync with
// what is registered on the BidBuddy USA LLC 10DLC campaign in the Telnyx
// Mission Control Portal (Messaging > 10DLC > Campaigns). If those campaign
// settings are ever changed, update the constants below to match.

const OPT_OUT_KEYWORDS = ["STOP", "UNSUBSCRIBE", "CANCEL"];
const OPT_IN_KEYWORDS = ["START", "YES"];
const HELP_KEYWORDS = ["HELP"];

const OPT_IN_MESSAGE =
  "You have agreed to receive SMS updates from BidBuddy USA LLC. Msg freq may vary. Std msg & data rates apply. Reply STOP to opt out, HELP for help.";
const OPT_OUT_MESSAGE =
  "BidBuddy USA LLC: You have been unsubscribed and will no longer receive messages from us. Reply HELP for assistance.";
const HELP_MESSAGE =
  "BidBuddy USA LLC: For help, reply HELP or contact us at +19012889044. Msg frequency varies. Msg&data rates may apply. Reply STOP to opt out.";

// Carriers/CTIA expect these keywords to be matched as the ENTIRE message
// body (case-insensitive, ignoring surrounding whitespace/punctuation), not
// as a substring buried in a longer sentence. This avoids false positives
// like an estimator texting "the pitch stops at the ridge line".
function matchesKeyword(cleanedText, keywordList) {
  const normalized = String(cleanedText || "")
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .toUpperCase();
  return keywordList.includes(normalized);
}

// -----------------------------------------------------------------------------
// Opt-out persistence: database-backed (survives redeploys/restarts), with a
// local JSON file used ONLY as an automatic fallback if the database call
// throws (e.g. running standalone/tests without db/index.js wired up, or an
// unexpected DB error). This is a compliance-critical status, so it must
// never silently disappear on a redeploy.
// -----------------------------------------------------------------------------

const OPT_OUT_STATE_FILE =
  process.env.BIDBUDDY_OPTOUT_STATE_FILE ||
  path.join(process.env.BIDBUDDY_DATA_DIR || path.join(process.cwd(), "data"), "sms-optouts.json");

function ensureDataDirFor(filePath) {
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // Read-only filesystem fallback: in-memory only for this process lifetime.
  }
}

function loadOptOutState() {
  try {
    ensureDataDirFor(OPT_OUT_STATE_FILE);
    if (!fs.existsSync(OPT_OUT_STATE_FILE)) return {};
    const raw = fs.readFileSync(OPT_OUT_STATE_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (_) {
    return {};
  }
}

function saveOptOutState(state) {
  try {
    ensureDataDirFor(OPT_OUT_STATE_FILE);
    fs.writeFileSync(OPT_OUT_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {
    // Do not fail SMS response if state save fails.
  }
}

let optOutState = loadOptOutState();

function hasDbOptOutSupport() {
  return Boolean(
    dbModule &&
      typeof dbModule.isPhoneOptedOut === "function" &&
      typeof dbModule.recordOptOut === "function" &&
      typeof dbModule.recordOptIn === "function"
  );
}

function isOptedOut(phone) {
  if (hasDbOptOutSupport()) {
    try {
      return dbModule.isPhoneOptedOut(phone);
    } catch (_) {
      // fall through to JSON fallback below
    }
  }
  const key = normalizePhone(phone);
  return Boolean(optOutState[key] && optOutState[key].optedOut);
}

function recordOptOut(phone, companyId) {
  if (hasDbOptOutSupport()) {
    try {
      dbModule.recordOptOut(phone, companyId || null);
      return;
    } catch (_) {
      // fall through to JSON fallback below
    }
  }
  const key = normalizePhone(phone);
  optOutState[key] = optOutState[key] || {};
  optOutState[key].optedOut = true;
  optOutState[key].optedOutAt = new Date().toISOString();
  saveOptOutState(optOutState);
}

function recordOptIn(phone, companyId) {
  if (hasDbOptOutSupport()) {
    try {
      dbModule.recordOptIn(phone, companyId || null);
      return;
    } catch (_) {
      // fall through to JSON fallback below
    }
  }
  const key = normalizePhone(phone);
  optOutState[key] = optOutState[key] || {};
  optOutState[key].optedOut = false;
  optOutState[key].optedInAt = new Date().toISOString();
  saveOptOutState(optOutState);
}

// -----------------------------------------------------------------------------
// Lightweight context store
// -----------------------------------------------------------------------------

const DATA_DIR = process.env.BIDBUDDY_DATA_DIR || path.join(process.cwd(), "data");
const STATE_FILE = process.env.BIDBUDDY_SMS_STATE_FILE || path.join(DATA_DIR, "sms-conversations.json");
const MAX_STORED_MESSAGES = 20;

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {
    // If Render filesystem is read-only for some reason, in-memory fallback still works.
  }
}

function loadState() {
  try {
    ensureDataDir();
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (_) {
    return {};
  }
}

function saveState(state) {
  try {
    ensureDataDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {
    // Do not fail SMS response if state save fails.
  }
}

let conversationState = loadState();

function normalizePhone(phone) {
  return String(phone || "unknown")
    .trim()
    .replace(/[^+0-9]/g, "");
}

function getConversationKey({ from, companyId }) {
  const normalized = normalizePhone(from);
  return `${companyId || "default"}:${normalized}`;
}

function getOrCreateConversation(key) {
  if (!conversationState[key]) {
    conversationState[key] = {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      job: emptyRoofJob(),
      messages: [],
      lastEstimate: null,
      estimatorContext: null
    };
  }
  return conversationState[key];
}

function emptyRoofJob() {
  return {
    trade: "roofing",
    squares: null,
    roofAreaSqFt: null,
    pitch: null,
    stories: null,
    access: null,
    tearOffLayers: null,
    material: null,
    complexity: null,
    ridgeLf: null,
    eaveRakeLf: null,
    valleyLf: null,
    chimneys: null,
    skylights: null,
    pipeBoots: null,
    penetrations: null,
    deckingSheets: null,
    deckingSqFt: null,
    deckingCondition: null,
    dumpAccess: null,
    permitRequired: null,
    ventilation: null,
    flashingScope: null,
    notes: []
  };
}

// -----------------------------------------------------------------------------
// Incoming SMS parsing helpers
// -----------------------------------------------------------------------------

// Telnyx sends webhooks for THREE distinct event types to the same
// configured webhook URL: message.received (a real inbound SMS from a
// customer/estimator), message.sent (confirmation that YOUR OWN outbound
// reply was accepted), and message.finalized (your own outbound reply's
// terminal delivery status). Only message.received represents an actual
// inbound text that should be processed. If message.sent/message.finalized
// events are not filtered out, the app ends up treating its own outbound
// replies as brand-new inbound messages, re-processing them and attempting
// to "reply" again with mismatched from/to numbers, which Telnyx rejects
// with error 10004 "Invalid source number". This is what caused the
// observed invalid-source-number loop.
function getTelnyxEventType(body) {
  return body && body.data && body.data.event_type ? body.data.event_type : null;
}

function isProcessableInboundEvent(body) {
  const eventType = getTelnyxEventType(body);
  // No event_type at all means this is likely a non-Telnyx / test payload
  // (e.g. a form post or another provider) — allow it through so local
  // testing and other providers keep working. If event_type IS present, it
  // must be message.received to be processed.
  if (eventType === null) return true;
  return eventType === "message.received";
}

function extractSmsPayload(req) {
  const body = req && req.body ? req.body : {};

  // Telnyx webhook shape
  const telnyxPayload = body.data && body.data.payload ? body.data.payload : null;
  if (telnyxPayload) {
    return {
      from: telnyxPayload.from && telnyxPayload.from.phone_number,
      to: telnyxPayload.to && telnyxPayload.to.length ? telnyxPayload.to[0].phone_number : undefined,
      text: telnyxPayload.text || telnyxPayload.body || "",
      provider: "telnyx",
      eventType: getTelnyxEventType(body),
      raw: body
    };
  }

  // Twilio-like or simple form shape
  return {
    from: body.From || body.from || body.sender || body.phone || body.msisdn,
    to: body.To || body.to || body.recipient,
    text: body.Body || body.body || body.text || body.message || "",
    provider: body.provider || "unknown",
    eventType: null,
    raw: body
  };
}

function cleanText(text) {
  return String(text || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function lower(text) {
  return cleanText(text).toLowerCase();
}

function numberFromMatch(match) {
  if (!match || !match[1]) return null;
  const n = Number(String(match[1]).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseRoofDetails(text) {
  const msg = lower(text);
  const details = {};
  const notes = [];

  // Squares: "30 squares", "30 sq", "30 sqs", "30 square roof"
  let m = msg.match(/(?:^|\b)(\d+(?:\.\d+)?)\s*(?:squares|square|sqrs|sqs|sq)\b/);
  if (m) details.squares = numberFromMatch(m);

  // Roof area: "3000 sf", "3000 sqft", "3000 square feet"
  m = msg.match(/(?:^|\b)(\d{3,6}(?:\.\d+)?)\s*(?:sf|sqft|sq ft|square feet)\b/);
  if (m) {
    details.roofAreaSqFt = numberFromMatch(m);
    if (!details.squares) details.squares = Math.round((details.roofAreaSqFt / 100) * 10) / 10;
  }

  // Pitch: "8/12", "8 pitch", "8 12 pitch"
  m = msg.match(/\b(\d{1,2})\s*\/\s*12\b/);
  if (m) details.pitch = `${m[1]}/12`;
  if (!details.pitch) {
    m = msg.match(/\b(\d{1,2})\s*(?:pitch|slope)\b/);
    if (m) details.pitch = `${m[1]}/12`;
  }

  // Stories/access
  if (/\b(one|1)[ -]?(story|storey)\b/.test(msg) || /\bsingle story\b/.test(msg)) details.stories = 1;
  if (/\b(two|2)[ -]?(story|storey)\b/.test(msg)) details.stories = 2;
  if (/\b(three|3)[ -]?(story|storey)\b/.test(msg)) details.stories = 3;
  if (/\bsteep\b/.test(msg)) details.access = "steep";
  if (/\bwalkable\b/.test(msg)) details.access = "walkable";
  if (/\bhard access|tight access|bad access|limited access\b/.test(msg)) details.access = "limited";

  // Tear-off layers
  m = msg.match(/\b(\d+)\s*(?:layer|layers)\b/);
  if (m && /tear|off|remove|existing|old roof|shingle/.test(msg)) details.tearOffLayers = numberFromMatch(m);
  if (/\bone layer\b/.test(msg) && /tear|off|remove|existing|old roof|shingle/.test(msg)) details.tearOffLayers = 1;
  if (/\btwo layers\b/.test(msg) && /tear|off|remove|existing|old roof|shingle/.test(msg)) details.tearOffLayers = 2;
  if (/\bno tear|overlay|layover|recover\b/.test(msg)) details.tearOffLayers = 0;

  // Material
  if (/\barchitectural|dimensional|30 year|laminate\b/.test(msg)) details.material = "architectural shingles";
  if (/\b3 tab|three tab|3-tab\b/.test(msg)) details.material = "3-tab shingles";
  if (/\bdesigner|premium|presidential|grand manor|carriage\b/.test(msg)) details.material = "designer shingles";
  if (/\bmetal|standing seam|r panel|corrugated\b/.test(msg)) details.material = "metal roofing";
  if (/\btile roof|clay tile|concrete tile\b/.test(msg)) details.material = "tile roofing";
  if (/\bslate\b/.test(msg)) details.material = "slate roofing";

  // Complexity
  if (/\bsimple gable|straight gable|easy gable\b/.test(msg)) details.complexity = "simple";
  if (/\bhip roof\b/.test(msg)) details.complexity = "moderate";
  if (/\bcut up|cut-up|complex|lots of valleys|many valleys|dormers\b/.test(msg)) details.complexity = "complex";

  // Linear feet
  m = msg.match(/\b(\d+(?:\.\d+)?)\s*(?:lf|linear feet|feet|ft)\s*(?:of\s*)?(?:ridge|ridge cap)\b/);
  if (m) details.ridgeLf = numberFromMatch(m);
  m = msg.match(/\b(\d+(?:\.\d+)?)\s*(?:lf|linear feet|feet|ft)\s*(?:of\s*)?(?:eave|eaves|rake|rakes|eave rake|eave\/rake)\b/);
  if (m) details.eaveRakeLf = numberFromMatch(m);
  m = msg.match(/\b(\d+(?:\.\d+)?)\s*(?:lf|linear feet|feet|ft)\s*(?:of\s*)?(?:valley|valleys)\b/);
  if (m) details.valleyLf = numberFromMatch(m);

  // Counts
  m = msg.match(/\b(\d+)\s*(?:chimney|chimneys)\b/);
  if (m) details.chimneys = numberFromMatch(m);
  m = msg.match(/\b(\d+)\s*(?:skylight|skylights)\b/);
  if (m) details.skylights = numberFromMatch(m);
  m = msg.match(/\b(\d+)\s*(?:pipe boot|pipe boots|boots|pipes|penetrations|vents)\b/);
  if (m) {
    details.pipeBoots = numberFromMatch(m);
    details.penetrations = details.pipeBoots;
  }

  // Decking
  m = msg.match(/\b(\d+)\s*(?:sheet|sheets)\b/);
  if (m && /deck|decking|plywood|osb|sheathing/.test(msg)) details.deckingSheets = numberFromMatch(m);
  m = msg.match(/\b(\d{2,5})\s*(?:sf|sqft|sq ft|square feet)\s*(?:decking|deck|sheathing)\b/);
  if (m) details.deckingSqFt = numberFromMatch(m);
  if (/\bbad decking|soft decking|rotten decking|decking is bad|bad deck|soft spots|delaminated\b/.test(msg)) {
    details.deckingCondition = "suspect or damaged";
  }

  // Misc scope
  if (/\bdumpster|dump access|driveway access|haul off|disposal\b/.test(msg)) notes.push(text);
  if (/\bpermit|permits\b/.test(msg)) details.permitRequired = !/no permit|not required/.test(msg);
  if (/\bridge vent|box vents|ventilation|intake|exhaust\b/.test(msg)) details.ventilation = text;
  if (/\bflashing|step flashing|counter flashing|apron flashing|wall flashing\b/.test(msg)) details.flashingScope = text;

  if (notes.length) details.notes = notes;
  return details;
}

function mergeJobDetails(job, details) {
  const updatedFields = [];
  for (const [key, value] of Object.entries(details || {})) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "notes") {
      job.notes = Array.isArray(job.notes) ? job.notes : [];
      for (const note of value) job.notes.push(note);
      updatedFields.push("notes");
      continue;
    }
    job[key] = value;
    updatedFields.push(key);
  }
  return updatedFields;
}

// -----------------------------------------------------------------------------
// Intent classification
// -----------------------------------------------------------------------------

// Core required-field keys. If a message updates ANY of these, it is treated
// as a measurement update FIRST, even if the same text also happens to
// mention chimneys, valleys, pipe boots, decking, etc. This matters because
// real estimators dump the whole field scope in one text (e.g. "28 squares,
// architectural shingles, 1 layer tear-off, 6/12 pitch, two-story, 58 ft
// ridge, 42 ft valley, 2 pipe boots, 1 chimney, dumpster needed") — that
// message must be recognized as providing the core basics, not diverted into
// a narrower "tell me more about the chimney" reply just because it also
// contains scope-detail words.
const CORE_MEASUREMENT_FIELDS = ["squares", "pitch", "stories", "tearOffLayers", "material"];

function hasCoreMeasurementUpdate(details) {
  if (!details) return false;
  return CORE_MEASUREMENT_FIELDS.some(
    (field) => details[field] !== undefined && details[field] !== null && details[field] !== ""
  );
}

function classifyIntent(text, details) {
  const msg = lower(text);

  if (/\b(reset|start over|new roof|new estimate|clear this)\b/.test(msg)) return "reset_estimate";
  if (/\b(help|what can you do)\b/.test(msg)) return "help";
  if (/\b(homeowner|customer|explain to|tell them|say to them)\b/.test(msg)) return "homeowner_response_help";
  if (/\b(quote|estimate|price|range|rough number|how much|total|cost)\b/.test(msg)) return "request_estimate";
  if (/\b(why|expensive|so high|high|too much|cost driver|breakdown|explain)\b/.test(msg)) return "explain_price";
  if (/\b(cheaper|lower|save money|value engineer|reduce)\b/.test(msg)) return "lower_price";
  if (/\b(competitor|another roofer|other bid|cheaper bid|match)\b/.test(msg)) return "competitor_comparison";
  if (/\b(missing|need from me|what else|what do you need)\b/.test(msg)) return "missing_info";
  if (/\b(check before i leave|field checklist|look for|inspect|before leaving|driveway)\b/.test(msg)) return "field_checklist";
  if (/\b(insurance|supplement|claim|adjuster|storm|hail|wind)\b/.test(msg)) return "insurance_or_supplement";

  // Core measurement data takes priority over decking/scope-detail keyword
  // matches, so a full field dump is never misread as a narrow follow-up
  // question just because it also mentions a chimney, valley, or pipe boot.
  if (hasCoreMeasurementUpdate(details)) return "provide_measurement";

  if (/\b(decking|deck|sheathing|plywood|osb|sheets)\b/.test(msg)) return "decking";
  if (/\b(chimney|flashing|skylight|pipe boot|penetration|valley|ventilation|ridge vent)\b/.test(msg)) return "scope_detail";
  if (details && Object.keys(details).length > 0) return "provide_measurement";
  if (msg.length < 8) return "unclear";

  return "general_roofing_question";
}

// -----------------------------------------------------------------------------
// Roofing estimate logic
// -----------------------------------------------------------------------------

const REQUIRED_FIELDS = ["squares", "pitch", "stories", "tearOffLayers", "material"];

function missingRequiredFields(job) {
  return REQUIRED_FIELDS.filter((field) => job[field] === null || job[field] === undefined || job[field] === "");
}

function formatFieldName(field) {
  const names = {
    squares: "squares",
    pitch: "pitch",
    stories: "one-story or two-story access",
    tearOffLayers: "tear-off layer count",
    material: "shingle or material choice"
  };
  return names[field] || field;
}

function knownJobBullets(job) {
  const bullets = [];
  if (job.squares) bullets.push(`${job.squares} squares`);
  if (job.pitch) bullets.push(`${job.pitch} pitch`);
  if (job.stories) bullets.push(`${job.stories}-story access`);
  if (job.tearOffLayers !== null && job.tearOffLayers !== undefined) bullets.push(`${job.tearOffLayers} tear-off layer${job.tearOffLayers === 1 ? "" : "s"}`);
  if (job.material) bullets.push(job.material);
  if (job.complexity) bullets.push(`${job.complexity} roof complexity`);
  if (job.chimneys !== null && job.chimneys !== undefined) bullets.push(`${job.chimneys} chimney${job.chimneys === 1 ? "" : "s"}`);
  if (job.skylights !== null && job.skylights !== undefined) bullets.push(`${job.skylights} skylight${job.skylights === 1 ? "" : "s"}`);
  if (job.pipeBoots !== null && job.pipeBoots !== undefined) bullets.push(`${job.pipeBoots} pipe boot/penetration${job.pipeBoots === 1 ? "" : "s"}`);
  if (job.deckingSheets) bullets.push(`${job.deckingSheets} decking sheet${job.deckingSheets === 1 ? "" : "s"} as an adder`);
  if (job.deckingCondition) bullets.push(`decking condition: ${job.deckingCondition}`);
  return bullets;
}

function parsePitchNumber(pitch) {
  const m = String(pitch || "").match(/(\d{1,2})/);
  return m ? Number(m[1]) : null;
}

// Applies the per-sheet decking adder. Kept separate from the base estimate
// regardless of pricing source, per BidBuddy's rule: never bake deck
// replacement into the base number; quote it as a per-sheet adder.
function calculateDeckingAdder(job) {
  const deckSheetAdder = Number(process.env.ROOFING_DECK_SHEET_ADDER || 95);
  let deckingLow = 0;
  let deckingHigh = 0;
  if (job.deckingSheets) {
    deckingLow = Number(job.deckingSheets) * deckSheetAdder;
    deckingHigh = Number(job.deckingSheets) * Math.round(deckSheetAdder * 1.25);
  }
  return { deckingLow, deckingHigh };
}

// Calls the real company pricing engine (lib/roofingPricing.js) using the
// estimator's own pricing profile and matched shingle from the database.
function calculateFromCompanyPricing(job, estimatorContext) {
  if (!estimatorContext || !estimatorContext.pricing) return null;
  if (!pricingModule || typeof pricingModule.calculateRoofEstimate !== "function") return null;

  try {
    const mappedJob = mapJobForPricingEngine(job);
    const shingle = resolveShingle(estimatorContext, job.material);
    const result = pricingModule.calculateRoofEstimate(mappedJob, estimatorContext.pricing, shingle);
    if (!result || result.error) return null;

    const price = Number(result.price || 0);
    if (!price) return null;

    // Same +/-8% presentation band used by the fallback engine, so the
    // estimator sees a consistent range shape regardless of pricing source.
    const low = Math.round((price * 0.94) / 100) * 100;
    const high = Math.round((price * 1.08) / 100) * 100;
    const { deckingLow, deckingHigh } = calculateDeckingAdder(job);

    return {
      low,
      high,
      deckingLow,
      deckingHigh,
      totalLow: low + deckingLow,
      totalHigh: high + deckingHigh,
      detailAdders: [],
      source: "company-pricing-profile",
      companyName: estimatorContext.companyName,
      shingleUsed: result.shingle,
      raw: result
    };
  } catch (_) {
    return null;
  }
}

function fallbackEstimate(job) {
  // These environment defaults are intentionally configurable. They are only a fallback
  // if your project pricing engine is not available, or no company match was found
  // for the texting phone number.
  const basePerSquare = Number(process.env.ROOFING_BASE_PER_SQUARE || 475);
  const designerPerSquare = Number(process.env.ROOFING_DESIGNER_PER_SQUARE || 725);
  const metalPerSquare = Number(process.env.ROOFING_METAL_PER_SQUARE || 950);
  const tilePerSquare = Number(process.env.ROOFING_TILE_PER_SQUARE || 1100);
  const slatePerSquare = Number(process.env.ROOFING_SLATE_PER_SQUARE || 1400);
  const tearOffPerSquare = Number(process.env.ROOFING_TEAROFF_PER_SQUARE || 75);
  const secondStoryPerSquare = Number(process.env.ROOFING_SECOND_STORY_PER_SQUARE || 45);

  const squares = Number(job.squares || 0);
  let perSquare = basePerSquare;

  if (/3-tab/.test(job.material || "")) perSquare = Math.max(basePerSquare - 40, 350);
  if (/designer/.test(job.material || "")) perSquare = designerPerSquare;
  if (/metal/.test(job.material || "")) perSquare = metalPerSquare;
  if (/tile/.test(job.material || "")) perSquare = tilePerSquare;
  if (/slate/.test(job.material || "")) perSquare = slatePerSquare;

  const pitchNum = parsePitchNumber(job.pitch);
  let pitchMultiplier = 1;
  if (pitchNum >= 7 && pitchNum <= 9) pitchMultiplier = 1.08;
  if (pitchNum >= 10 && pitchNum <= 12) pitchMultiplier = 1.18;
  if (pitchNum > 12) pitchMultiplier = 1.3;

  let complexityMultiplier = 1;
  if (job.complexity === "moderate") complexityMultiplier = 1.05;
  if (job.complexity === "complex") complexityMultiplier = 1.12;

  let subtotal = squares * perSquare;
  subtotal += squares * tearOffPerSquare * Number(job.tearOffLayers || 0);
  if (Number(job.stories || 1) >= 2) subtotal += squares * secondStoryPerSquare;
  subtotal *= pitchMultiplier;
  subtotal *= complexityMultiplier;

  const detailAdders = [];
  if (job.chimneys) detailAdders.push({ name: "chimney flashing allowance", amount: Number(job.chimneys) * 250 });
  if (job.skylights) detailAdders.push({ name: "skylight flashing allowance", amount: Number(job.skylights) * 275 });
  if (job.pipeBoots) detailAdders.push({ name: "pipe boot allowance", amount: Number(job.pipeBoots) * 65 });

  for (const adder of detailAdders) subtotal += adder.amount;

  const baseLow = Math.round((subtotal * 0.94) / 100) * 100;
  const baseHigh = Math.round((subtotal * 1.08) / 100) * 100;

  const { deckingLow, deckingHigh } = calculateDeckingAdder(job);

  return {
    low: baseLow,
    high: baseHigh,
    deckingLow,
    deckingHigh,
    totalLow: baseLow + deckingLow,
    totalHigh: baseHigh + deckingHigh,
    detailAdders,
    source: "fallback"
  };
}

function calculateEstimate(job, estimatorContext) {
  const fromCompany = calculateFromCompanyPricing(job, estimatorContext);
  if (fromCompany) return fromCompany;
  return fallbackEstimate(job);
}

function dollars(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "$0";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

// -----------------------------------------------------------------------------
// Human estimator response builders
// -----------------------------------------------------------------------------

function smsJoin(lines) {
  return lines
    .filter((line) => line !== null && line !== undefined && String(line).trim() !== "")
    .join("\n");
}

// Uses a plain hyphen, not a Unicode bullet (•). A bullet character is
// outside the GSM-7 SMS alphabet, which silently forces the ENTIRE outbound
// message into UCS-2 encoding (70 chars/segment instead of 160, 67/segment
// instead of 153 when split into multiple parts). Since bulletList() is used
// in nearly every reply, a single "•" here was responsible for estimate
// replies ballooning past Telnyx's 10-segment cap and being hard-rejected
// with error 40302 "message too large".
function bulletList(items) {
  return items.filter(Boolean).map((item) => `- ${item}`).join("\n");
}

function pricingSourceNote(estimate) {
  if (!estimate) return "";
  if (estimate.source === "company-pricing-profile") {
    return `(using ${estimate.companyName || "your"} company pricing${estimate.shingleUsed ? ", " + estimate.shingleUsed : ""})`;
  }
  return "(using generic default pricing - no company profile matched this number)";
}

function missingInfoReply(job) {
  const known = knownJobBullets(job);
  const missing = missingRequiredFields(job).map(formatFieldName);

  if (!missing.length) {
    return smsJoin([
      "I have the required items for a rough roof number.",
      "",
      "Current basis:",
      bulletList(known),
      "",
      "Helpful extras if you have them: valleys, chimneys, skylights, pipe boots, decking condition, dump access, and any flashing or ventilation changes."
    ]);
  }

  return smsJoin([
    known.length ? "Here's what I have so far:" : "I can build the roof estimate, but I need the basics first.",
    known.length ? bulletList(known) : "",
    "",
    "Still need:",
    bulletList(missing),
    "",
    "Send what you know next and I'll keep building it."
  ]);
}

function measurementReply(job, updatedFields) {
  const missing = missingRequiredFields(job).map(formatFieldName);
  const known = knownJobBullets(job);

  if (!updatedFields.length) {
    return "I'm not totally sure what to do with that yet. Send it like: 30 squares, 8/12 pitch, two story, one layer tear-off, architectural shingles.";
  }

  if (missing.length) {
    return smsJoin([
      "Got it. I updated the roof details.",
      "",
      "Current basis:",
      bulletList(known),
      "",
      "Still need to tighten the number:",
      bulletList(missing)
    ]);
  }

  return smsJoin([
    "Got it. I have enough to rough this in now.",
    "",
    "Current basis:",
    bulletList(known),
    "",
    "Send 'estimate' and I'll give you the range with assumptions and adders."
  ]);
}

function estimateReply(job, conversation) {
  const missing = missingRequiredFields(job).map(formatFieldName);
  const known = knownJobBullets(job);

  if (missing.length) {
    return smsJoin([
      "I can rough it in, but I don't want to fake a number with key items missing.",
      "",
      known.length ? "What I have:" : "",
      known.length ? bulletList(known) : "",
      "",
      "Still need:",
      bulletList(missing),
      "",
      "Send those and I'll give you a tighter range."
    ]);
  }

  const estimate = calculateEstimate(job, conversation.estimatorContext);
  conversation.lastEstimate = {
    ...estimate,
    createdAt: new Date().toISOString(),
    basis: { ...job }
  };

  const hasDeckingAdder = estimate.deckingLow || estimate.deckingHigh;
  const totalLine = hasDeckingAdder
    ? `Updated rough total with decking adder: ${dollars(estimate.totalLow)} to ${dollars(estimate.totalHigh)}`
    : "";

  return smsJoin([
    "Here's the rough roof replacement range based on the field info:",
    "",
    "Estimate basis:",
    bulletList(known),
    "",
    `Base roof range: ${dollars(estimate.low)} to ${dollars(estimate.high)}`,
    hasDeckingAdder ? `Decking adder: ${dollars(estimate.deckingLow)} to ${dollars(estimate.deckingHigh)}` : "",
    totalLine,
    "",
    "Included assumptions:",
    bulletList([
      "normal tear-off/disposal for the layers provided",
      "standard underlayment, starter, drip edge, and ridge cap",
      "standard labor adjustment for pitch and access",
      "normal pipe boot/flashing allowance unless noted otherwise"
    ]),
    "",
    "Not included unless confirmed:",
    bulletList([
      "deck replacement beyond listed sheets",
      "structural repairs",
      "chimney flashing rebuilds",
      "skylight replacement",
      "permit or code-driven changes"
    ]),
    "",
    "If you see valleys, chimneys, skylights, or bad decking, send those next and I'll adjust it.",
    "",
    pricingSourceNote(estimate)
  ]);
}

function explainPriceReply(job, conversation) {
  const known = knownJobBullets(job);
  const drivers = [];

  if (job.squares) drivers.push(`${job.squares} squares drives the material, labor, and disposal volume.`);
  if (job.pitch) drivers.push(`${job.pitch} pitch affects labor speed, setup, and safety.`);
  if (Number(job.stories || 1) >= 2) drivers.push("Two-story access usually adds labor and setup time.");
  if (Number(job.tearOffLayers || 0) > 0) drivers.push(`${job.tearOffLayers} tear-off layer${job.tearOffLayers === 1 ? "" : "s"} adds removal and disposal.`);
  if (job.material) drivers.push(`${job.material} controls a big part of the material cost.`);
  if (job.complexity === "complex") drivers.push("The roof is marked complex, so waste and labor risk are higher.");
  if (job.deckingSheets || job.deckingCondition) drivers.push("Decking should stay separate because final sheet count can change after tear-off.");

  if (!drivers.length) {
    drivers.push("The biggest roof price drivers are squares, pitch, stories/access, tear-off layers, material choice, disposal, flashing details, and decking condition.");
  }

  return smsJoin([
    "The number is mainly being driven by scope, labor, and risk, not just shingles.",
    "",
    known.length ? "On this roof:" : "Typical drivers:",
    bulletList(drivers),
    "",
    "I'd present it as a rough replacement range until decking, flashing, and hidden conditions are confirmed."
  ]);
}

function lowerPriceReply() {
  return smsJoin([
    "Maybe, but I wouldn't cut waterproofing items just to make the number look better.",
    "",
    "Safer places to review:",
    bulletList([
      "shingle product level",
      "whether ventilation changes are included",
      "dump/disposal assumptions",
      "whether decking is separate instead of buried in the base",
      "scope differences versus another bid"
    ]),
    "",
    "I would not remove drip edge, starter, underlayment, flashing, or required ice/water protection just to lower the price."
  ]);
}

function deckingReply(job, conversation) {
  const lines = [
    "I'd keep decking separate from the base roof number unless the sheet count is already confirmed.",
    "",
    "Best structure:",
    bulletList([
      "base roof replacement covers normal tear-off and install",
      "decking is listed as a per-sheet or allowance adder",
      "final decking quantity is confirmed after tear-off"
    ])
  ];

  if (job.deckingSheets) {
    const estimate = calculateEstimate(job, conversation.estimatorContext);
    lines.push("", `I have ${job.deckingSheets} decking sheet${job.deckingSheets === 1 ? "" : "s"} noted as an adder.`);
    lines.push(`Current decking adder: ${dollars(estimate.deckingLow)} to ${dollars(estimate.deckingHigh)}`);
  } else if (job.deckingCondition) {
    lines.push("", "You mentioned suspect decking. Send the number of sheets if you have it. If not, I'd call it out as a per-sheet adder after tear-off.");
  } else {
    lines.push("", "Send the number of sheets, square footage, or a note like 'soft decking around eaves' and I'll treat it as a separate adder.");
  }

  return smsJoin(lines);
}

function scopeDetailReply(job) {
  return smsJoin([
    "Good callout. Details like chimneys, skylights, pipe boots, valleys, ventilation, and flashing can move the number.",
    "",
    "What I have noted:",
    bulletList(knownJobBullets(job).length ? knownJobBullets(job) : ["no detailed roof accessories captured yet"]),
    "",
    "If you can, send counts like: 2 chimneys, 1 skylight, 6 pipe boots, 40 LF valley. I'll adjust the estimate around those details."
  ]);
}

function homeownerHelpReply(job, conversation) {
  const hasFullEstimate = !missingRequiredFields(job).length;

  if (!hasFullEstimate) {
    return smsJoin([
      "Here's a safe way to say it before the number is fully tightened:",
      "",
      "'I'm still confirming a few roof details, but the final price will depend on the roof size, pitch, tear-off, access, material choice, and any hidden decking or flashing issues we find.'",
      "",
      "Once you send the missing basics, I'll help you word the actual range."
    ]);
  }

  const range = calculateEstimate(job, conversation.estimatorContext);

  return smsJoin([
    "Here's how I'd explain it to the homeowner:",
    "",
    `"Based on what we can see today, this roof is likely in the ${dollars(range.totalLow)} to ${dollars(range.totalHigh)} range. That includes the roof replacement, tear-off, disposal, standard accessories, and labor for the pitch and access. The final number can change if we uncover bad decking, hidden damage, or flashing issues after tear-off."`,
    "",
    "That gives them a real number without locking you into hidden conditions."
  ]);
}

function competitorReply() {
  return smsJoin([
    "I'd compare scope, not just the total price.",
    "",
    "Ask if the cheaper bid includes:",
    bulletList([
      "tear-off and disposal",
      "drip edge, starter, underlayment, and ridge cap",
      "ice/water where required",
      "flashing details",
      "decking adders",
      "permit assumptions",
      "ventilation changes",
      "warranty terms"
    ]),
    "",
    "A cheaper bid may be fine, but only if the scope is actually the same."
  ]);
}

function fieldChecklistReply() {
  return smsJoin([
    "Before you leave, I'd check these items:",
    "",
    bulletList([
      "confirm squares or roof measurement",
      "confirm pitch",
      "confirm one-story or two-story access",
      "confirm tear-off layers",
      "note shingle/material choice",
      "count chimneys, skylights, pipe boots, and valleys",
      "look for soft decking, waves, or leak areas",
      "confirm dump access and driveway limitations",
      "note flashing and ventilation concerns"
    ]),
    "",
    "Those are the items most likely to change the rough number after you leave the property."
  ]);
}

function insuranceReply() {
  return smsJoin([
    "For insurance or supplement work, I'd keep the wording scope-based and factual.",
    "",
    "Use language like:",
    "'Estimate includes roof replacement scope observed in the field. Final scope may change based on tear-off findings, decking condition, flashing requirements, and code or permit requirements.'",
    "",
    "I wouldn't promise coverage or approval. Keep it to observed damage, measured scope, and clearly listed assumptions."
  ]);
}

function helpReply() {
  return smsJoin([
    "I can help you build and explain a rough roof estimate from the field.",
    "",
    "Send details like:",
    bulletList([
      "30 squares",
      "8/12 pitch",
      "two story",
      "one layer tear-off",
      "architectural shingles",
      "2 chimneys, 1 skylight, 6 pipe boots",
      "add 10 sheets decking"
    ]),
    "",
    "You can also ask: estimate, what am I missing, why so high, explain to homeowner, competitor is cheaper, or field checklist."
  ]);
}

function generalRoofingReply(job) {
  return smsJoin([
    "I can help with that from an estimating angle.",
    "",
    "For this roof, I'm focused on the details that affect price: squares, pitch, access, tear-off, material, decking, flashing, ventilation, and roof complexity.",
    "",
    missingRequiredFields(job).length ? "If you want a number, send the missing basics and I'll tighten the range." : "If you want, send 'estimate' and I'll price the current scope."
  ]);
}

function unclearReply(job) {
  return smsJoin([
    "I may need that one a little clearer.",
    "",
    "You can send it like:",
    "30 squares, 8/12 pitch, two story, one layer tear-off, architectural shingles",
    "",
    missingRequiredFields(job).length ? "Or ask 'what am I missing' and I'll list the next items I need." : "Or send 'estimate' and I'll price what we have."
  ]);
}

function buildReply(intent, job, conversation, updatedFields) {
  switch (intent) {
    case "reset_estimate":
      conversation.job = emptyRoofJob();
      conversation.lastEstimate = null;
      return "Got it. I cleared this roof and started fresh. Send the squares, pitch, stories, tear-off layers, and shingle choice when you're ready.";
    case "help":
      return helpReply();
    case "provide_measurement":
      return measurementReply(job, updatedFields || []);
    case "request_estimate":
      return estimateReply(job, conversation);
    case "explain_price":
      return explainPriceReply(job, conversation);
    case "lower_price":
      return lowerPriceReply();
    case "decking":
      return deckingReply(job, conversation);
    case "scope_detail":
      return scopeDetailReply(job);
    case "missing_info":
      return missingInfoReply(job);
    case "homeowner_response_help":
      return homeownerHelpReply(job, conversation);
    case "competitor_comparison":
      return competitorReply();
    case "field_checklist":
      return fieldChecklistReply();
    case "insurance_or_supplement":
      return insuranceReply();
    case "general_roofing_question":
      return generalRoofingReply(job);
    case "unclear":
    default:
      return unclearReply(job);
  }
}

// -----------------------------------------------------------------------------
// Telnyx outbound send
// -----------------------------------------------------------------------------

async function sendSms({ to, from, text }) {
  const apiKey = process.env.TELNYX_API_KEY;
  const telnyxFrom = from || process.env.TELNYX_PHONE_NUMBER || process.env.SMS_FROM_NUMBER;

  if (!apiKey || !telnyxFrom || !to) {
    console.log("[BidBuddy SMS] Outbound skipped. Missing TELNYX_API_KEY, from number, or recipient.");
    console.log("[BidBuddy SMS] Reply would have been:", text);
    return { skipped: true, reason: "missing_telnyx_config" };
  }

  const response = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: telnyxFrom,
      to,
      text
    })
  });

  const responseBody = await response.text();
  if (!response.ok) {
    console.error("[BidBuddy SMS] Telnyx send failed", response.status, responseBody);
    return { ok: false, status: response.status, body: responseBody };
  }

  return { ok: true, status: response.status, body: responseBody };
}

// -----------------------------------------------------------------------------
// Public processing function
// -----------------------------------------------------------------------------

async function processIncomingSms({ from, to, text, companyId }) {
  const cleaned = cleanText(text);

  // ---------------------------------------------------------------------
  // Compliance gate: STOP / HELP / START take priority over everything
  // else, exactly matching the BidBuddy USA LLC 10DLC campaign keywords.
  // ---------------------------------------------------------------------
  if (matchesKeyword(cleaned, OPT_OUT_KEYWORDS)) {
    const knownCompany = resolveEstimatorContext(from);
    recordOptOut(from, knownCompany ? knownCompany.companyId : null);
    return {
      reply: OPT_OUT_MESSAGE,
      intent: "opt_out",
      job: null,
      conversationKey: getConversationKey({ from, companyId }),
      estimatorContext: null,
      suppressed: false
    };
  }

  if (matchesKeyword(cleaned, HELP_KEYWORDS)) {
    // HELP is always answered, even if the number is currently opted out.
    return {
      reply: HELP_MESSAGE,
      intent: "help_keyword",
      job: null,
      conversationKey: getConversationKey({ from, companyId }),
      estimatorContext: null,
      suppressed: false
    };
  }

  if (matchesKeyword(cleaned, OPT_IN_KEYWORDS)) {
    const knownCompany = resolveEstimatorContext(from);
    recordOptIn(from, knownCompany ? knownCompany.companyId : null);
    return {
      reply: OPT_IN_MESSAGE,
      intent: "opt_in",
      job: null,
      conversationKey: getConversationKey({ from, companyId }),
      estimatorContext: null,
      suppressed: false
    };
  }

  if (isOptedOut(from)) {
    // Per CTIA guidance, do not send any further messages to an opted-out
    // number other than replies to HELP or START/YES, both handled above.
    return {
      reply: null,
      intent: "suppressed_opted_out",
      job: null,
      conversationKey: getConversationKey({ from, companyId }),
      estimatorContext: null,
      suppressed: true
    };
  }

  // ---------------------------------------------------------------------
  // Normal roofing-estimate conversation flow
  // ---------------------------------------------------------------------
  const key = getConversationKey({ from, companyId });
  const conversation = getOrCreateConversation(key);

  // Resolve the estimator/company once per conversation and cache it, so we
  // do not hit the database on every single message in the thread.
  if (conversation.estimatorContext === null) {
    conversation.estimatorContext = resolveEstimatorContext(from) || false;
  }
  const estimatorContext = conversation.estimatorContext || null;

  const details = parseRoofDetails(cleaned);
  const intent = classifyIntent(cleaned, details);

  let updatedFields = [];
  if (intent !== "reset_estimate") {
    updatedFields = mergeJobDetails(conversation.job, details);
  }

  const reply = buildReply(intent, conversation.job, conversation, updatedFields);

  conversation.updatedAt = new Date().toISOString();
  conversation.messages.push({
    at: new Date().toISOString(),
    from,
    to,
    inbound: cleaned,
    intent,
    updatedFields,
    reply
  });
  if (conversation.messages.length > MAX_STORED_MESSAGES) {
    conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES);
  }

  conversationState[key] = conversation;
  saveState(conversationState);

  return {
    reply,
    intent,
    job: conversation.job,
    conversationKey: key,
    estimatorContext: estimatorContext ? { companyId: estimatorContext.companyId, companyName: estimatorContext.companyName } : null,
    suppressed: false
  };
}

// -----------------------------------------------------------------------------
// Express route handler
// -----------------------------------------------------------------------------

async function handleSms(req, res) {
  try {
    const body = req && req.body ? req.body : {};

    // Guard against processing our own outbound message.sent / message.finalized
    // webhook callbacks as if they were new inbound texts. Telnyx delivers ALL
    // event types to the same webhook URL, so this check is required to avoid
    // a self-triggering reply loop and "Invalid source number" send failures.
    if (!isProcessableInboundEvent(body)) {
      const eventType = getTelnyxEventType(body);
      console.log(`[BidBuddy SMS] Ignoring non-inbound webhook event: ${eventType}`);
      if (res) return res.status(200).json({ ok: true, ignored: true, reason: "non_inbound_event", eventType });
      return { ok: true, ignored: true, eventType };
    }

    const payload = extractSmsPayload(req);
    const from = normalizePhone(payload.from);
    const to = normalizePhone(payload.to);
    const text = cleanText(payload.text);

    if (!from || !text) {
      if (res) return res.status(200).json({ ok: true, ignored: true, reason: "missing_from_or_text" });
      return { ok: true, ignored: true };
    }

    console.log(`[BidBuddy SMS] inbound from ${from}: ${text}`);

    const result = await processIncomingSms({
      from,
      to,
      text,
      companyId: req && req.company ? req.company.id : undefined
    });

    // If the conversation was suppressed (opted-out number, non-HELP/START
    // message), do not send anything back at all.
    if (!result.suppressed && result.reply) {
      await sendSms({
        to: from,
        from: to || process.env.TELNYX_PHONE_NUMBER || process.env.SMS_FROM_NUMBER,
        text: result.reply
      });
    } else if (result.suppressed) {
      console.log(`[BidBuddy SMS] Suppressed outbound to opted-out number ${from}`);
    }

    if (res) return res.status(200).json({ ok: true, reply: result.reply, intent: result.intent, suppressed: result.suppressed });
    return { ok: true, ...result };
  } catch (error) {
    console.error("[BidBuddy SMS] handler error", error);
    if (res) return res.status(200).json({ ok: false, error: "sms_handler_error" });
    return { ok: false, error };
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  handleSms,
  processIncomingSms,
  parseRoofDetails,
  classifyIntent,
  calculateEstimate,
  emptyRoofJob,
  missingRequiredFields,
  normalizePhone,
  isOptedOut,
  recordOptOut,
  recordOptIn
};
