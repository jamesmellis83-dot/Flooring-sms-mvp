"use strict";

/**
 * lib/promptBuilder.js
 * Builds the system prompt (persona + hard business rules) and the
 * per-turn grounding data block for BidBuddy's AI-generated SMS replies.
 *
 * CRITICAL DESIGN PRINCIPLE:
 * The AI never invents, calculates, or guesses dollar figures. Every price
 * shown to the AI is computed deterministically by lib/roofingPricing.js
 * (or the fallback estimator) BEFORE this prompt is built. The AI's only
 * job is to hold a natural conversation using those exact numbers as facts
 * it is not allowed to deviate from. This keeps the estimate accurate while
 * making the conversation itself flexible instead of template-driven.
 *
 * *** ADDED IN THIS REVISION ***
 * Rule 10 below has the AI briefly confirm the customer/job identity every
 * time it states a price. This is a cheap, always-on safety net against the
 * cross-job customer/address mixing bug fixed in lib/smsHandler.js: even if
 * something upstream ever mis-attaches a name to the wrong thread again,
 * the estimator will see it immediately in the reply text instead of only
 * discovering it later on the dashboard.
 */

function dollars(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

function jobBullets(job) {
  if (!job) return [];
  const lines = [];
  if (job.squares) lines.push(`${job.squares} squares`);
  if (job.pitch) lines.push(`${job.pitch} pitch`);
  if (job.stories) lines.push(`${job.stories}-story access`);
  if (job.tearOffLayers !== null && job.tearOffLayers !== undefined) {
    lines.push(`${job.tearOffLayers} tear-off layer${job.tearOffLayers === 1 ? "" : "s"}`);
  }
  if (job.material) lines.push(job.material);
  if (job.ridgeLf) lines.push(`${job.ridgeLf} LF ridge (priced)`);
  if (job.eaveRakeLf) lines.push(`${job.eaveRakeLf} LF eave/rake (priced)`);
  if (job.valleyLf) lines.push(`${job.valleyLf} LF valley (priced)`);
  if (job.chimneys !== null && job.chimneys !== undefined) lines.push(`${job.chimneys} chimney${job.chimneys === 1 ? "" : "s"} (priced)`);
  if (job.skylights !== null && job.skylights !== undefined) lines.push(`${job.skylights} skylight${job.skylights === 1 ? "" : "s"} (priced)`);
  if (job.pipeBoots !== null && job.pipeBoots !== undefined) {
    lines.push(`${job.pipeBoots} pipe boot/penetration${job.pipeBoots === 1 ? "" : "s"} (priced)`);
  }
  if (job.deckingSheets) lines.push(`${job.deckingSheets} decking sheet${job.deckingSheets === 1 ? "" : "s"} (priced as a separate adder)`);
  if (job.deckingCondition) lines.push(`decking condition: ${job.deckingCondition} (not priced until sheet count is given)`);
  // Dumpster/disposal is INCLUDED BY DEFAULT in every estimate (see COST
  // BREAKDOWN below for the real dollar amount folded into the base price).
  // Only worth a bullet here when it has been explicitly EXCLUDED.
  if (job.dumpsterRequested === false) {
    lines.push("no dumpster needed - customer/estimator supplying their own (disposal fee removed from base price)");
  }
  // Items below are captured from the estimator's text but are NOT
  // automatically priced anywhere in the system. Labeled explicitly as
  // "not priced" so the AI states that honestly instead of implying they
  // were factored into the number, or refusing to acknowledge them at all.
  if (job.complexity) lines.push(`${job.complexity} roof complexity noted (NOT priced - no complexity surcharge is configured for this company)`);
  if (job.access) lines.push(`access noted as ${job.access} (NOT priced - informational only)`);
  if (job.permitRequired === true) {
    lines.push("permit noted as required (NOT priced - permit fees vary by municipality; call it out to the customer as a separate cost)");
  }
  if (job.ventilation) lines.push(`ventilation note: ${job.ventilation} (NOT priced - flag for manual review/quote)`);
  if (job.flashingScope) {
    lines.push(`flashing note: ${job.flashingScope} (NOT priced beyond chimney flashing already counted above - flag for manual review if this is additional scope)`);
  }
  return lines;
}

const REQUIRED_FIELD_LABELS = {
  squares: "squares",
  pitch: "pitch",
  stories: "one-story or two-story access",
  tearOffLayers: "tear-off layer count",
  material: "shingle or material choice"
};

function missingFieldLabels(missingFields) {
  return (missingFields || []).map((f) => REQUIRED_FIELD_LABELS[f] || f);
}

/**
 * The persona + hard rules. This is sent as the system message on every
 * single AI call. Keep it strict and explicit — this is what prevents the
 * model from inventing prices, going off-topic, or acting like a generic
 * chatbot instead of a roofing estimating specialist.
 */
function buildSystemPrompt() {
  return [
    "You are BidBuddy, a texting assistant built for professional roofing contractors and estimators. You are texting directly with an experienced roofer or estimator in the field - NOT a homeowner, and not a general audience.",
    "",
    "Voice and tone: talk like a sharp, experienced roofing estimator colleague texting back. Direct, practical, no corporate fluff, no filler, no false enthusiasm. Do not repeat the same sentence structure or phrasing you have already used earlier in this conversation - vary how you say things, and directly answer whatever the estimator is actually asking right now instead of restating the whole job summary every time.",
    "",
    "Formatting rules (this is a real SMS, not chat/email):",
    "- Plain text only. No markdown (no asterisks, no pound-sign headers, no bullet character '\u2022').",
    "- If you list multiple items, use a plain hyphen '-' at the start of each line.",
    "- Use straight quotes (\") not curly quotes, and a plain hyphen '-' not an em dash.",
    "- No emoji.",
    "- Keep replies as short as the question allows. Do not pad with unnecessary restatement of the whole job every single message.",
    "",
    "Hard rules you must never break:",
    "1. NEVER invent, estimate, guess, round, or recalculate a dollar figure yourself. The ONLY dollar amounts you may state are the ones given to you verbatim in the DATA block below, under CURRENT ESTIMATE or PREVIOUS ESTIMATE. Copy those numbers exactly as written. If the estimator asks for a price and no estimate is available yet in the DATA block, say so plainly and state exactly which required fields are still missing (see MISSING REQUIRED FIELDS) - do not make one up to be helpful.",
    "2. If required fields are missing, proactively ask for exactly those missing items in your own words - do not guess measurements, pitch, layer count, or material.",
    "3. Decking/deck replacement is NEVER part of the base roof price. It is always a separate per-sheet adder, and only appears if a sheet count has been given. If asked about decking with no sheet count given, ask for the sheet count or square footage instead of estimating it.",
    "3b. Dumpster/disposal is INCLUDED BY DEFAULT in every base estimate (see the 'Dumpster/disposal' line under CURRENT ESTIMATE and the COST BREAKDOWN section) - it is not a separate optional adder like decking. If asked about dumpster/disposal cost, state the real dollar figure from COST BREAKDOWN or the COMPANY PRICE BOOK confidently. Never say a dumpster price is 'not on file' - it is always either included in the price you were given, or explicitly excluded because the customer is supplying their own; the DATA block always tells you which.",
    "3c. You have access to this company's FULL price book (labor rate, tear-off rate, ridge/eave/valley rates, penetration fee, chimney flash fee, skylight flash fee, dumpster fee, waste factor, minimum job price, target margin) under COMPANY PRICE BOOK, and the itemized cost breakdown for the current job under COST BREAKDOWN FOR THIS JOB. Use these freely to answer ANY question about what is driving the price, or to quote any individual rate - you are not limited to only the specific fields previous messages happened to mention.",
    "3d. GENERAL RULE for 'is X included/priced' questions (this covers dumpster, valley, skylights, chimneys, penetrations, ridge, eave, decking, and ANY other item, not just the ones spelled out above): check KNOWN JOB DETAILS below. Every item there is labeled either '(priced)' - meaning its exact dollar contribution is real, configured company pricing already reflected in the estimate and/or COST BREAKDOWN - or '(NOT priced - ...)' with the specific reason (no company rate exists for it, or it varies too much to safely auto-price, e.g. permits, general ventilation/flashing scope, roof complexity). Always answer using that label: if it says priced, state the number confidently from the breakdown; if it says NOT priced, say plainly that this company has no configured rate for it and offer to note it for the estimator to price manually - never guess a number, and never claim ignorance about something that actually IS priced.",
    "3e. If the estimator asks about a cost item that does not appear ANYWHERE in KNOWN JOB DETAILS, COMPANY PRICE BOOK, or COST BREAKDOWN (something this company has not configured or mentioned at all, e.g. gutters, satellite dish removal), say so plainly and offer to note it as a manual line item - do not invent a number for something that truly is not configured.",
    "4. When you state a price, always present it as a range (low to high), never a single flat number, and make clear it is a rough field estimate that can move after tear-off reveals hidden conditions (bad decking, structural issues, etc).",
    "5. This tool is estimator-facing only. Do not offer to text, call, or otherwise contact a homeowner directly. You may help the estimator draft wording THEY can say to a homeowner, but you are not a homeowner-communication channel yourself.",
    "6. Stay focused on this roofing estimate. If asked something unrelated to roofing/estimating (politics, other trades, personal topics, etc), briefly decline and steer back to the job.",
    "7. Never mention STOP, HELP, START, or opt-out/opt-in keyword handling - that is handled separately, outside of you, before you ever see the message.",
    "8. If the estimator points out something seems off, wrong, or contradicts a rule above, take it seriously and correct course in your reply rather than repeating the same statement.",
    "9. Once CURRENT ESTIMATE is available (all required fields collected) and CUSTOMER NAME below still says not provided yet, work a brief, natural ask for the customer's name (and property address if that is also missing) into your reply, so the job can be saved under the right account instead of showing as an untitled job. Only do this if CUSTOMER INFO ALREADY REQUESTED says no - if it says yes, do not ask again even if it is still missing; assume the estimator either doesn't have it yet or already saw the request. Never let this ask block or delay giving the actual price.",
    "10. Whenever you state or restate a dollar range (CURRENT ESTIMATE), and CUSTOMER NAME above is known, briefly say who and/or where it's for as part of that reply (e.g., \"For the Smith job at 123 Oak St, that's...\"). This is a safety check for the estimator - texting multiple jobs back to back is common, and naming the job every time a price is given lets them catch it immediately if the wrong customer ever got attached to the wrong job. Keep it short - a few words is enough, do not turn it into a separate sentence every time."
  ].join("\n");
}

// Human-readable labels + formatting for every column in pricing_profiles
// (see db/schema.sql). Listing every field here - not just the ones some
// adder function happens to use - is what lets the AI act like it has the
// company's actual price sheet memorized, instead of only knowing about
// whatever line items a developer previously wired into a bespoke adder.
const PRICE_BOOK_FIELDS = [
  ["labor_per_square", "Labor", (v) => `${dollars(v)} per square`],
  ["material_per_square", "Fallback material rate", (v) => `${dollars(v)} per square (only used if no shingle product is matched - shingle catalog rate normally drives material cost instead)`],
  ["tearoff_per_layer", "Tear-off", (v) => `${dollars(v)} per square, per layer removed`],
  ["pitch_surcharge", "Steep pitch surcharge", (v) => `${Math.round(v * 100)}% added to base cost when pitch is steep`],
  ["steep_pitch_threshold", "Steep pitch threshold", (v) => `${v}/12 or steeper counts as steep`],
  ["two_story_surcharge", "Two-story surcharge", (v) => `${Math.round(v * 100)}% added to base cost for 2+ story access`],
  ["dumpster_fee", "Dumpster/disposal", (v) => `${dollars(v)} flat fee, included on every job by default unless the customer is supplying their own`],
  ["penetration_fee", "Pipe boot/penetration", (v) => `${dollars(v)} each`],
  ["chimney_flash_fee", "Chimney flashing", (v) => `${dollars(v)} each`],
  ["ridge_per_lf", "Ridge cap", (v) => `${dollars(v)} per linear foot`],
  ["eave_per_lf", "Eave/drip edge", (v) => `${dollars(v)} per linear foot`],
  ["valley_per_lf", "Valley", (v) => `${dollars(v)} per linear foot`],
  ["skylight_flash_fee", "Skylight flashing", (v) => `${dollars(v)} each`],
  ["waste_factor", "Waste factor", (v) => `${Math.round(v * 100)}% added to material quantity`],
  ["default_shingle", "Default shingle", (v) => `${v}`],
  ["min_job_price", "Minimum job price", (v) => `${dollars(v)} floor - the price is never quoted below this regardless of size`],
  ["gross_margin", "Target gross margin", (v) => `${Math.round(v * 100)}%`]
];

function buildPriceBookLines(pricingProfile) {
  if (!pricingProfile) {
    return ["PRICE BOOK: none - this is an unregistered/demo number, so generic default rates are being used instead of a specific company's configured pricing."];
  }
  const lines = ["COMPANY PRICE BOOK (this company's actual configured rates - you may confidently cite ANY of these if the estimator asks about a fee, even if it has not yet been itemized into today's job below):"];
  for (const [key, label, fmt] of PRICE_BOOK_FIELDS) {
    const value = pricingProfile[key];
    if (value === null || value === undefined || value === "") continue;
    try {
      lines.push(`- ${label}: ${fmt(value)}`);
    } catch (_) {
      // skip a field that fails to format rather than crash the whole block
    }
  }
  return lines;
}

// Human-readable labels for the itemized cost breakdown returned by
// lib/roofingPricing.js (company-profile path) or the equivalent object
// built by lib/smsHandler.js's fallbackEstimate() (demo/unregistered path).
const BREAKDOWN_FIELDS = [
  ["materials", "Materials"],
  ["materials_and_labor", "Materials + labor"],
  ["labor", "Labor"],
  ["tearoff", "Tear-off/removal"],
  ["ridge", "Ridge cap"],
  ["eave", "Eave/drip edge"],
  ["valley", "Valley"],
  ["accessories", "Chimney/skylight/penetration accessories"],
  ["dumpster", "Dumpster/disposal"],
  ["second_story", "Two-story adjustment"],
  ["pitch_surcharge", "Steep pitch surcharge"],
  ["two_story_surcharge", "Two-story surcharge"]
];

function buildBreakdownLines(estimate) {
  if (!estimate || !estimate.breakdown) return [];
  const lines = ["COST BREAKDOWN FOR THIS JOB (exact line items behind the price above - cite these by name if the estimator asks what is driving the number or why it changed):"];
  let any = false;
  for (const [key, label] of BREAKDOWN_FIELDS) {
    const value = estimate.breakdown[key];
    if (value === null || value === undefined || value === 0) continue;
    any = true;
    lines.push(`- ${label}: ${dollars(value)}`);
  }
  if (estimate.pricePerSquare) {
    lines.push(`- Price per square (all-in, after margin): ${dollars(estimate.pricePerSquare)}`);
    any = true;
  }
  if (estimate.grossMargin != null) {
    lines.push(`- Gross margin applied: ${Math.round(estimate.grossMargin * 100)}%`);
    any = true;
  }
  if (estimate.priceFlags && estimate.priceFlags.below_minimum) {
    lines.push("- Minimum job price floor was applied on this job.");
    any = true;
  }
  return any ? lines : [];
}

/**
 * Builds the per-turn DATA block: the deterministic, code-computed facts
 * the AI must ground its reply in. This is regenerated fresh on every
 * inbound message so the AI always sees the current state of the job.
 */
function buildDataBlock({ companyName, job, missingFields, currentEstimate, previousEstimate, askedForCustomerInfo, pricingProfile }) {
  const lines = [];

  lines.push(`COMPANY: ${companyName ? companyName : "unregistered/demo number - using generic default pricing, not a specific contractor's rates"}`);
  lines.push(`CUSTOMER NAME: ${job && job.customerName ? job.customerName : "not provided yet"}`);
  lines.push(`CUSTOMER ADDRESS: ${job && job.customerAddress ? job.customerAddress : "not provided yet"}`);
  lines.push(`CUSTOMER INFO ALREADY REQUESTED: ${askedForCustomerInfo ? "yes" : "no"}`);
  lines.push("");
  lines.push(...buildPriceBookLines(pricingProfile));

  const known = jobBullets(job);
  lines.push("");
  lines.push("KNOWN JOB DETAILS:");
  if (known.length) {
    known.forEach((b) => lines.push(`- ${b}`));
  } else {
    lines.push("- none yet");
  }

  const missingLabels = missingFieldLabels(missingFields);
  lines.push(`MISSING REQUIRED FIELDS: ${missingLabels.length ? missingLabels.join(", ") : "none - all required fields collected"}`);

  if (currentEstimate && currentEstimate.totalLow != null && currentEstimate.totalHigh != null) {
    const hasDecking = currentEstimate.deckingLow || currentEstimate.deckingHigh;
    lines.push("");
    lines.push("CURRENT ESTIMATE (the only dollar RANGE you may state as the price):");
    lines.push(`- Base roof range: ${dollars(currentEstimate.low)} to ${dollars(currentEstimate.high)}`);
    if (hasDecking) {
      lines.push(`- Decking adder (separate, only if sheet count given): ${dollars(currentEstimate.deckingLow)} to ${dollars(currentEstimate.deckingHigh)}`);
      lines.push(`- Total (base + decking adder): ${dollars(currentEstimate.totalLow)} to ${dollars(currentEstimate.totalHigh)}`);
    }
    lines.push(`- Dumpster/disposal: ${currentEstimate.dumpsterIncluded ? `INCLUDED in the base range above (${dollars(currentEstimate.dumpsterFeeApplied)} before margin)` : "NOT included - customer/estimator is supplying their own"}`);
    lines.push(`- Pricing source: ${currentEstimate.source === "company-pricing-profile" ? `company pricing profile${currentEstimate.shingleUsed ? " (" + currentEstimate.shingleUsed + ")" : ""}` : "generic default pricing (no company profile matched this number)"}`);
    lines.push(...buildBreakdownLines(currentEstimate));
  } else {
    lines.push("");
    lines.push("CURRENT ESTIMATE: not computable yet - required fields are still missing, see above.");
  }

  lines.push("");
  if (previousEstimate && previousEstimate.totalLow != null && previousEstimate.totalHigh != null) {
    lines.push(`PREVIOUS ESTIMATE (for comparison if asked what changed): ${dollars(previousEstimate.totalLow)} to ${dollars(previousEstimate.totalHigh)}`);
  } else {
    lines.push("PREVIOUS ESTIMATE: none given yet in this conversation.");
  }

  return lines.join("\n");
}

/**
 * Assembles the full OpenAI chat "messages" array: system prompt + data
 * block, recent conversation history (as alternating user/assistant turns),
 * then the new inbound message.
 */
function buildMessages({ companyName, job, missingFields, currentEstimate, previousEstimate, askedForCustomerInfo, pricingProfile, history, userText }) {
  const systemContent =
    buildSystemPrompt() +
    "\n\n---\nCURRENT JOB DATA (regenerated fresh every message)\n---\n" +
    buildDataBlock({ companyName, job, missingFields, currentEstimate, previousEstimate, askedForCustomerInfo, pricingProfile });

  const messages = [{ role: "system", content: systemContent }];

  for (const turn of history || []) {
    if (turn.inbound) messages.push({ role: "user", content: turn.inbound });
    if (turn.reply) messages.push({ role: "assistant", content: turn.reply });
  }

  messages.push({ role: "user", content: userText });
  return messages;
}

module.exports = {
  buildSystemPrompt,
  buildDataBlock,
  buildMessages,
  jobBullets,
  missingFieldLabels
};
