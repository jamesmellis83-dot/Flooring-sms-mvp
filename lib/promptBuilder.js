"use strict";

/**
 * lib/promptBuilder.js
 *
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
  if (job.complexity) lines.push(`${job.complexity} roof complexity`);
  if (job.ridgeLf) lines.push(`${job.ridgeLf} LF ridge`);
  if (job.eaveRakeLf) lines.push(`${job.eaveRakeLf} LF eave/rake`);
  if (job.valleyLf) lines.push(`${job.valleyLf} LF valley`);
  if (job.chimneys !== null && job.chimneys !== undefined) lines.push(`${job.chimneys} chimney${job.chimneys === 1 ? "" : "s"}`);
  if (job.skylights !== null && job.skylights !== undefined) lines.push(`${job.skylights} skylight${job.skylights === 1 ? "" : "s"}`);
  if (job.pipeBoots !== null && job.pipeBoots !== undefined) lines.push(`${job.pipeBoots} pipe boot/penetration${job.pipeBoots === 1 ? "" : "s"}`);
  if (job.deckingSheets) lines.push(`${job.deckingSheets} decking sheet${job.deckingSheets === 1 ? "" : "s"} noted as an adder`);
  if (job.deckingCondition) lines.push(`decking condition: ${job.deckingCondition}`);
  if (job.dumpAccess) lines.push(`dumpster/dump access noted`);
  if (job.ventilation) lines.push(`ventilation note: ${job.ventilation}`);
  if (job.flashingScope) lines.push(`flashing note: ${job.flashingScope}`);
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
    "4. When you state a price, always present it as a range (low to high), never a single flat number, and make clear it is a rough field estimate that can move after tear-off reveals hidden conditions (bad decking, structural issues, etc).",
    "5. This tool is estimator-facing only. Do not offer to text, call, or otherwise contact a homeowner directly. You may help the estimator draft wording THEY can say to a homeowner, but you are not a homeowner-communication channel yourself.",
    "6. Stay focused on this roofing estimate. If asked something unrelated to roofing/estimating (politics, other trades, personal topics, etc), briefly decline and steer back to the job.",
    "7. Never mention STOP, HELP, START, or opt-out/opt-in keyword handling - that is handled separately, outside of you, before you ever see the message.",
    "8. If the estimator points out something seems off, wrong, or contradicts a rule above, take it seriously and correct course in your reply rather than repeating the same statement."
  ].join("\n");
}

/**
 * Builds the per-turn DATA block: the deterministic, code-computed facts
 * the AI must ground its reply in. This is regenerated fresh on every
 * inbound message so the AI always sees the current state of the job.
 */
function buildDataBlock({ companyName, job, missingFields, currentEstimate, previousEstimate }) {
  const lines = [];

  lines.push(`COMPANY: ${companyName ? companyName : "unregistered/demo number - using generic default pricing, not a specific contractor's rates"}`);

  const known = jobBullets(job);
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
    lines.push("CURRENT ESTIMATE (the only dollar figures you may state):");
    lines.push(`- Base roof range: ${dollars(currentEstimate.low)} to ${dollars(currentEstimate.high)}`);
    if (hasDecking) {
      lines.push(`- Decking adder: ${dollars(currentEstimate.deckingLow)} to ${dollars(currentEstimate.deckingHigh)}`);
      lines.push(`- Total (base + decking): ${dollars(currentEstimate.totalLow)} to ${dollars(currentEstimate.totalHigh)}`);
    }
    lines.push(`- Pricing source: ${currentEstimate.source === "company-pricing-profile" ? `${companyName || "this company"}'s own pricing profile${currentEstimate.shingleUsed ? " (" + currentEstimate.shingleUsed + ")" : ""}` : "generic default pricing (no company profile matched this number)"}`);
  } else {
    lines.push("CURRENT ESTIMATE: not computable yet - required fields are still missing, see above.");
  }

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
function buildMessages({ companyName, job, missingFields, currentEstimate, previousEstimate, history, userText }) {
  const systemContent = buildSystemPrompt() + "\n\n---\nCURRENT JOB DATA (regenerated fresh every message)\n---\n" +
    buildDataBlock({ companyName, job, missingFields, currentEstimate, previousEstimate });

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
