// lib/smsHandler.js
// Inbound text -> identify the ESTIMATOR -> resolve their COMPANY -> price with
// the company's shared profile and catalog -> save under the company, stamped
// with which estimator sent it.
//
// Response system upgrade:
// - asks for missing estimate details instead of guessing immediately
// - keeps lightweight per-estimator memory for follow-up texts
// - handles explanation questions like "why so much?"
// - handles basic roofing advisor questions without creating an estimate

const store = require('../db');
const { calculateRoofEstimate, formatRoofingReply, money } = require('./roofingPricing');

// Light per-user context so follow-up texts can patch the previous job.
const lastJob = new Map(); // userId -> parsed job

async function handleInboundSms({ from, text }) {
  const user = store.getUserByPhone(from);
  const site = process.env.SITE_URL || 'https://bidbuddyusa.com';

  if (!user) {
    return `This number isn't set up with BidBuddy yet. If your company already has an account, ask your owner to add you as an estimator. Otherwise start at ${site}/signup.`;
  }

  if (!user.company_onboarded) {
    return user.role === 'owner'
      ? `Almost there, ${firstName(user.full_name)}. Finish your pricing setup at ${site}/onboarding and I'll price jobs with your numbers instead of defaults.`
      : `${user.company_name} hasn't finished pricing setup yet. Ask your owner to complete it at ${site}/onboarding and I'll start quoting.`;
  }

  const companyId = user.company_id;
  const body = String(text || '').trim();

  if (!body) {
    return "Send me the roof details and I'll help price it. Example: 32 sq, 8/12 pitch, 2 story, 1 layer tear off.";
  }

  /* ---- quick commands ---- */

  if (/^(help|commands)$/i.test(body)) {
    return "Text me the job and I'll price it with your company's numbers.\n\nExample:\n32 sq, 8/12 pitch, 2 story, 1 layer tear off, 2 chimneys\n\nYou can also reply with changes like:\n- make it 35 squares\n- change to 6/12 pitch\n- add 1 chimney\n\nTry: PRICING for your rates, SHINGLES for your material list.\nSTOP to opt out.";
  }

  if (/^(reset|start over|new estimate|clear)$/i.test(body)) {
    lastJob.delete(user.id);
    return "Got it. Starting fresh. Send the roof squares, pitch, story count, tear-off layers, and shingle type if you know it.";
  }

  if (/^(pricing|my pricing|rates)$/i.test(body)) {
    const p = store.getPricing(companyId);
    return `${user.company_name} pricing:\nLabor ${money(p.labor_per_square)}/sq\nMargin ${Math.round(p.gross_margin * 100)}%\nTear-off ${money(p.tearoff_per_layer)}/sq/layer\nDisposal ${money(p.dumpster_fee)}\nSteep pitch +${Math.round(p.pitch_surcharge * 100)}% at ${p.steep_pitch_threshold}/12\nTwo-story +${Math.round(p.two_story_surcharge * 100)}%${user.role === 'owner' ? `\n\nChange it at ${site}/pricing-profile` : '\n\nYour owner can change these.'}`;
  }

  if (/^(shingles|materials|material list|products)$/i.test(body)) {
    const rows = store.listShingles(companyId);
    const list = rows.map(r => `${r.is_default ? '- ' : '  '}${r.name} - ${money(r.cost_per_square)}/sq${r.is_default ? ' (default)' : ''}`).join('\n');
    return `${user.company_name} materials:\n${list}${user.role === 'owner' ? `\n\nEdit at ${site}/pricing-profile` : ''}`;
  }

  const prev = lastJob.get(user.id) || {};

  if (wantsExplanation(body)) {
    if (!prev.squares) {
      return "I can explain the price once we have an estimate built. Send the roof squares, pitch, stories, and tear-off layers and I will walk through the cost drivers.";
    }

    const pricing = store.getPricing(companyId);
    const shingle = prev.shingle_id
      ? store.listShingles(companyId).find(s => s.id === prev.shingle_id)
      : store.getDefaultShingle(companyId);

    const estimate = calculateRoofEstimate(prev, pricing, shingle);
    return formatEstimateExplanation(estimate);
  }

  if (isAdvisorQuestion(body)) {
    return roofingAdvisorReply(body);
  }

  /* ---- parse, merging over this estimator's previous job when appropriate ---- */

  const parsed = parseRoofingJob(body);
  const matched = store.matchShingle(companyId, body);
  if (matched) parsed.shingle_id = matched.id;

  const hasPrev = prev && prev.squares != null;
  const followUp = hasPrev && shouldMergeWithPrevious(body, parsed);
  const job = followUp ? { ...prev, ...stripNulls(parsed) } : stripNulls(parsed);

  if (Object.keys(job).length > 0) {
    lastJob.set(user.id, job);
  }

  const missing = missingEstimateFields(job);

  if (missing.length) {
    return formatMissingInfoReply(job, missing);
  }

  const pricing = store.getPricing(companyId);
  const shingle = job.shingle_id
    ? store.listShingles(companyId).find(s => s.id === job.shingle_id)
    : store.getDefaultShingle(companyId);

  const estimate = calculateRoofEstimate(job, pricing, shingle);
  lastJob.set(user.id, job);

  store.saveEstimate({
    company_id: companyId,
    created_by_user_id: user.id,
    customer_name: job.customer_name,
    job_address: job.address,
    squares: job.squares,
    estimate_amount: estimate.price,
    estimate_json: { ...estimate, parsed_job: job, raw_text: body },
    source: 'sms'
  });

  const reply = formatRoofingReply(estimate);

  if (followUp && matched) return `Switched to ${matched.name}.\n\n${reply}`;
  if (followUp) return `Updated the estimate with that change.\n\n${reply}`;

  return reply;
}

/**
 * Deterministic parser - no AI call for the common case, which keeps cost near zero.
 * Returns nulls for anything not mentioned so follow-ups can patch a job.
 */
function parseRoofingJob(t) {
  const original = String(t || '');
  const s = ' ' + original.toLowerCase() + ' ';
  const grab = (re, i = 1) => {
    const m = s.match(re);
    return m ? Number(m[i]) : null;
  };

  // Square footage first, so "1850 sq ft" never reads as 1850 squares.
  const sqft = grab(/(\d{3,6})\s*(?:sq\s*\.?\s*(?:ft|feet)|sqft|square\s*(?:ft|feet))\b/);
  const squares = sqft
    ? Math.round(sqft / 100 * 10) / 10
    : grab(/(\d+(?:\.\d+)?)\s*(?:sq|squares?|sqs)\b(?!\s*\.?\s*(?:ft|feet))/);

  const pitchM = s.match(/\b(\d{1,2})\s*[\/:]\s*12\b/);
  const pitch = pitchM ? Number(pitchM[1]) : (/steep/.test(s) ? 9 : null);

  let stories = grab(/\b(\d)\s*[-\s]?stor(?:y|ies)\b/);
  if (stories == null && /\b(two|2)\s*story\b/.test(s)) stories = 2;
  if (stories == null && /\b(single|one|1)\s*story\b|\branch\b/.test(s)) stories = 1;

  let layers = grab(/\b(\d)\s*layers?\b/);
  if (layers == null && /tear\s*-?\s*off|tearoff|remove/.test(s)) layers = 1;
  if (/no tear\s*-?\s*off|layover|overlay|go over/.test(s)) layers = 0;

  return {
    squares,
    pitch,
    stories,
    layers,
    ridge_lf: grab(/(\d+)\s*(?:lf|linear feet|ft)?\s*(?:of\s*)?ridge/) ?? grab(/ridge\s*(?:of\s*)?(\d+)/),
    eave_lf: grab(/(\d+)\s*(?:lf|linear feet|ft)?\s*(?:of\s*)?(?:eave|drip)/) ?? grab(/(?:eave|drip)\s*(?:edge\s*)?(\d+)/),
    penetrations: grab(/(\d+)\s*(?:pipe|pipes|penetration|penetrations|boot|boots|vent|vents)/),
    chimneys: grab(/(\d+)\s*chimneys?/) ?? (/chimney/.test(s) ? 1 : null),
    customer_name: (original.match(/(?:for|customer)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/) || [])[1] || null,
    address: (original.match(/\d{2,6}\s+[A-Za-z][A-Za-z\s]{2,30}(?:rd|road|st|street|ave|avenue|dr|drive|ln|lane|way|ct|court|cove|cv)\b/i) || [])[0] || null
  };
}

function shouldMergeWithPrevious(body, parsed) {
  const s = String(body || '').toLowerCase().trim();

  if (/^(make|change|update|switch|set|add|also|actually|no|use)\b/.test(s)) return true;
  if (parsed.squares == null) return true;

  return false;
}

function missingEstimateFields(job) {
  const missing = [];

  if (!job.squares) missing.push('roof squares');
  if (!job.pitch) missing.push('pitch');
  if (!job.stories) missing.push('story count');
  if (job.layers === null || job.layers === undefined) missing.push('tear-off layers');

  return missing;
}

function formatMissingInfoReply(job, missing) {
  const have = [];

  if (job.squares) have.push(`${job.squares} squares`);
  if (job.pitch) have.push(`${job.pitch}/12 pitch`);
  if (job.stories) have.push(`${job.stories} story${job.stories === 1 ? '' : 's'}`);
  if (job.layers !== null && job.layers !== undefined) have.push(`${job.layers} tear-off layer${job.layers === 1 ? '' : 's'}`);

  const lines = [];

  if (have.length) {
    lines.push(`I have ${humanJoin(have)}.`);
  } else {
    lines.push('I can help with that estimate, but I need a few roof details first.');
  }

  lines.push('');
  lines.push('Before I price it, send me:');
  missing.forEach(item => lines.push(`- ${item}`));
  lines.push('');
  lines.push('Example: 32 sq, 8/12 pitch, 2 story, 1 layer tear off');

  return lines.join('\n');
}

function wantsExplanation(body) {
  const s = String(body || '').toLowerCase();
  return /why|explain|expensive|breakdown|cost driver|cost drivers|what makes|how did|where does/.test(s);
}

function formatEstimateExplanation(est) {
  if (est.error) {
    return 'I need a completed estimate before I can explain the cost drivers.';
  }

  const lines = [];
  const b = est.breakdown;

  lines.push('The estimate is mainly being driven by materials, labor, tear-off, and disposal.');
  lines.push('');
  lines.push(`For this one, the current sale price is ${money(est.price)}.`);
  lines.push('');
  lines.push('Biggest items I see:');
  lines.push(`- Materials: ${money(b.materials)}`);
  lines.push(`- Labor: ${money(b.labor)}`);

  if (b.tearoff) lines.push(`- Tear-off: ${money(b.tearoff)}`);
  if (b.dumpster) lines.push(`- Disposal: ${money(b.dumpster)}`);
  if (b.pitch_surcharge) lines.push(`- Steep pitch: ${money(b.pitch_surcharge)}`);
  if (b.two_story_surcharge) lines.push(`- Two-story access: ${money(b.two_story_surcharge)}`);
  if (b.accessories) lines.push(`- Flashing/penetrations: ${money(b.accessories)}`);

  lines.push('');
  lines.push('Deck replacement is not included in this number. If decking is bad, quote that separately as a per-sheet adder.');

  return lines.join('\n');
}

function isAdvisorQuestion(body) {
  const s = String(body || '').toLowerCase();

  if (/(what|when|is|are|should|difference|explain|how)\b/.test(s) === false) return false;

  return /architectural|3 tab|three tab|pitch|steep|decking|deck replacement|underlayment|ice and water|valley|ridge|starter|drip edge|shingle|waste/.test(s);
}

function roofingAdvisorReply(body) {
  const s = String(body || '').toLowerCase();

  if (/architectural|3 tab|three tab/.test(s)) {
    return 'Architectural shingles are thicker and more dimensional than 3-tab shingles. They usually cost more, but they are more common on reroofs because they look better and typically carry better wind ratings. For most residential reroofs, architectural shingles are the safer default unless the customer specifically wants a lower-cost option.';
  }

  if (/steep|pitch/.test(s)) {
    return 'Pitch matters because it changes labor time, safety setup, and production speed. A 4/12 or 6/12 roof is usually straightforward. Once you get around 8/12 and above, I would treat it as a steeper roof and expect labor to climb.';
  }

  if (/decking|deck replacement/.test(s)) {
    return 'Deck replacement should not be baked into the base roof estimate. Treat it as a separate per-sheet adder. That keeps the estimate cleaner and avoids underpricing jobs where bad decking is discovered after tear-off.';
  }

  if (/ice and water|underlayment|starter|drip edge/.test(s)) {
    return 'Those items are usually part of the roofing system, but the amount depends on roof layout, code requirements, valleys, eaves, and contractor standards. For a rough estimate, they can be defaulted, but the final quote should call out what is included.';
  }

  if (/waste/.test(s)) {
    return 'Waste factor covers cuts, starter, ridge, valleys, and layout complexity. A simple roof may be close to 10 percent waste. More cut-up roofs, valleys, dormers, or steep sections may need more.';
  }

  return 'I can help with that roofing question. For estimating, the big items I care about are squares, pitch, stories, tear-off layers, shingle type, penetrations, chimneys, and any decking concerns.';
}

const stripNulls = (o) =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined)
  );

const firstName = (n) =>
  String(n || '').split(' ')[0] || 'there';

function humanJoin(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

module.exports = { handleInboundSms, parseRoofingJob };
