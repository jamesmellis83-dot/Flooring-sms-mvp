"use strict";

/**
 * lib/aiReply.js
 *
 * Calls OpenAI to generate the conversational reply text, using the
 * grounding data assembled by lib/promptBuilder.js.
 *
 * This module owns:
 *  - the actual HTTP call (raw fetch, no new npm dependency, matching the
 *    existing style already used for Telnyx in lib/smsHandler.js)
 *  - a hard timeout so a slow/hung OpenAI call never stalls the webhook
 *  - GSM-7 sanitization of whatever text comes back, since the SMS
 *    character-limit bug earlier proved a single curly quote/bullet/em
 *    dash silently balloons a reply into 3x as many billed segments and
 *    can get hard-rejected by Telnyx above 10 segments
 *
 * Returns null (never throws) on ANY failure - missing API key, network
 * error, timeout, malformed response, empty content - so the caller
 * (lib/smsHandler.js) can always fall back to the deterministic template
 * replies and the SMS flow never goes silent.
 *
 * NOTE ON gpt-5-mini PARAMETERS:
 *  - This model only supports the DEFAULT temperature (1) and rejects
 *    `max_tokens` in favor of `max_completion_tokens`. Sending either
 *    `temperature: <anything but 1>` or `max_tokens` causes a 400
 *    invalid_request_error.
 *  - This model is a reasoning model - part of max_completion_tokens is
 *    spent on invisible internal "reasoning tokens" BEFORE it writes the
 *    visible reply. Left at its default (medium) reasoning effort, it can
 *    (a) burn the entire token budget thinking and return EMPTY content,
 *    and/or (b) take longer than a short timeout allows, causing this
 *    module to abort the request before any reply comes back.
 *  - reasoning_effort: "minimal" tells the model to skip most of that
 *    internal deliberation, which is appropriate for a short SMS reply.
 *    DEFAULT_TIMEOUT_MS and MAX_REPLY_TOKENS are both raised to give the
 *    call room to finish even if reasoning takes a bit longer than
 *    expected.
 *
 * IMPORTANT: the try block below MUST parse and return the response.
 * A previous revision of this file called fetch() but never read
 * response.json() or returned the reply text - that silently made every
 * single AI call a no-op (implicit `return undefined`), which the caller
 * always treated as a failure and fell back to the static template, even
 * though no error was ever thrown or logged.
 */

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const DEFAULT_TIMEOUT_MS = Number(process.env.AI_REPLY_TIMEOUT_MS || 15000);
const MAX_REPLY_TOKENS = Number(process.env.AI_REPLY_MAX_TOKENS || 800);
const REASONING_EFFORT = process.env.AI_REPLY_REASONING_EFFORT || "minimal";

// Replaces characters outside the GSM-7 SMS alphabet with plain-ASCII
// equivalents. A single non-GSM-7 character (curly quote, em dash, bullet,
// emoji) forces the ENTIRE outbound message into UCS-2 encoding, cutting
// capacity from 160 to 70 characters per segment (153 to 67 per segment
// when split into multiple parts) - this is exactly what caused the
// "message too large" / 13-segment rejection seen earlier.
function sanitizeForSms(text) {
  if (!text) return "";

  let out = String(text);

  const replacements = [
    [/[\u2018\u2019\u201A\u2032]/g, "'"],   // curly single quotes, prime
    [/[\u201C\u201D\u201E\u2033]/g, '"'],   // curly double quotes, double prime
    [/[\u2013\u2014]/g, "-"],               // en dash, em dash
    [/[\u2022\u2023\u25E6\u2043]/g, "-"],   // various bullet characters
    [/\u2026/g, "..."],                     // ellipsis character
    [/\*\*/g, ""],                          // markdown bold markers
    [/(^|\n)\s*[_#]\s*/g, "$1- "]            // markdown bullets/headers -> hyphen
  ];

  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }

  // Strip any remaining characters outside a safe GSM-7-compatible ASCII
  // range (this intentionally also removes emoji, which have no sensible
  // GSM-7 equivalent and are safer dropped than risking segment overflow
  // or an outright send rejection).
  out = out.replace(
    /[^\x00-\x7F\u00A3\u00A5\u00E8\u00E9\u00F9\u00EC\u00F2\u00C7\u00D8\u00F8\u00C5\u00E5\u0394\u03A6\u0393\u039B\u03A9\u03A0\u03A8\u03A3\u0398\u039E\u00C6\u00E6\u00DF\u00C9\u00A4\u00A1\u00C4\u00D6\u00D1\u00DC\u00A7\u00BF\u00E4\u00F6\u00F1\u00FC\u00E0]/g,
    ""
  );

  return out.replace(/[ \t]+\n/g, "\n").trim();
}

async function generateAiReply({
  companyName,
  job,
  missingFields,
  currentEstimate,
  previousEstimate,
  askedForCustomerInfo,
  history,
  userText
}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.log("[BidBuddy AI] Skipped - OPENAI_API_KEY not set. Using template fallback.");
    return null;
  }

  let promptBuilder;
  try {
    promptBuilder = require("./promptBuilder");
  } catch (_) {
    console.error("[BidBuddy AI] promptBuilder module not found. Using template fallback.");
    return null;
  }

  const messages = promptBuilder.buildMessages({
    companyName,
    job,
    missingFields,
    currentEstimate,
    previousEstimate,
    askedForCustomerInfo,
    history,
    userText
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        max_completion_tokens: MAX_REPLY_TOKENS,
        reasoning_effort: REASONING_EFFORT
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[BidBuddy AI] OpenAI returned an error status.", response.status, errorText);
      return null;
    }

    const data = await response.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || "").trim()
      : "";

    if (!reply) {
      const finishReason = data && data.choices && data.choices[0] ? data.choices[0].finish_reason : "unknown";
      const usage = data ? data.usage : undefined;
      console.error(
        "[BidBuddy AI] OpenAI response contained no content. Using template fallback.",
        "finish_reason:", finishReason,
        "usage:", JSON.stringify(usage)
      );
      return null;
    }

    return sanitizeForSms(reply);
  } catch (error) {
    clearTimeout(timeout);
    if (error && error.name === "AbortError") {
      console.error(`[BidBuddy AI] OpenAI call timed out after ${DEFAULT_TIMEOUT_MS}ms. Using template fallback.`);
    } else {
      console.error("[BidBuddy AI] OpenAI call threw an error.", error);
    }
    return null;
  }
}

module.exports = { generateAiReply, sanitizeForSms };
