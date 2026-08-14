// lib/smsHandler.js
// Inbound text -> identify the ESTIMATOR -> resolve their COMPANY -> price with
// the company's shared profile and catalog -> save under the company, stamped
// with which estimator sent it.

const store = require('../db');
const { calculateRoofEstimate, formatRoofingReply, money } = require('./roofingPricing');

// Light per-user context so "make it 35 squares" works without an AI memory layer.
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

  /* ---- quick commands ---- */

  if (/^(help|commands)$/i.test(body)) {
    return "Text me the job and I'll price it with your company's numbers.\nExample: 32 sq, 1 layer tear off, 8/12 pitch, 2 story, 2 chimneys\n\nTry: PRICING for your rates, SHINGLES for your material list.\nSTOP to opt out.";
  }

  if (/^(pricing|my pricing|rates)$/i.test(body)) {
    const p = store.getPricing(companyId);
    return `${user.company_name} pricing:\nLabor ${money(p.labor_per_square)}/sq\nMargin ${Math.round(p.gross_margin * 100)}%\nTear-off ${money(p.tearoff_per_layer)}/sq/layer\nDisposal ${money(p.dumpster_fee)}\nSteep pitch +${Math.round(p.pitch_surcharge * 100)}% at ${p.steep_pitch_threshold}/12\nTwo-story +${Math.round(p.two_story_surcharge * 100)}%${user.role === 'owner' ? `\n\nChange it at ${site}/pricing-profile` : '\n\nYour owner can change these.'}`;
  }

  if (/^(shingles|materials|material list|products)$/i.test(body)) {
    const rows = store.listShingles(companyId);
    const list = rows.map(r => `${r.is_default ? '• ' : '  '}${r.name} — ${money(r.cost_per_square)}/sq${r.is_default ? ' (default)' : ''}`).join('\n');
    return `${user.company_name} materials:\n${list}${user.role === 'owner' ? `\n\nEdit at ${site}/pricing-profile` : ''}`;
  }

  /* ---- parse, merging over this estimator's previous job ---- */

  const prev = lastJob.get(user.id) || {};
  const parsed = parseRoofingJob(body);

  const matched = store.matchShingle(companyId, body);
  if (matched) parsed.shingle_id = matched.id;

  const isFollowUp = parsed.squares == null && prev.squares != null;
  const job = isFollowUp ? { ...prev, ...stripNulls(parsed) } : stripNulls(parsed);

  if (!job.squares) {
    return "I need squares to price it. Send something like: 32 sq, 1 layer tear off, 8/12, 2 story.";
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
    source: 'sms',
  });

  const reply = formatRoofingReply(estimate);
  if (isFollowUp && matched) return `Switched to ${matched.name}.\n\n${reply}`;
  if (isFollowUp)            return `Updated.\n\n${reply}`;
  return reply;
}

/**
 * Deterministic parser — no AI call for the common case, which keeps cost near
 * zero. Returns nulls for anything not mentioned so follow-ups can patch a job.
 */
function parseRoofingJob(t) {
  const s = ' ' + String(t).toLowerCase() + ' ';
  const grab = (re, i = 1) => { const m = s.match(re); return m ? Number(m[i]) : null; };

  // Square footage first, so "1850 sq ft" never reads as 1850 squares.
  const sqft = grab(/(\d{3,6})\s*(?:sq\s*\.?\s*(?:ft|feet)|sqft|square\s*(?:ft|feet))\b/);
  const squares = sqft
    ? Math.round(sqft / 100 * 10) / 10
    : grab(/(\d+(?:\.\d+)?)\s*(?:sq|squares?|sqs)\b(?!\s*\.?\s*(?:ft|feet))/);

  const pitchM = s.match(/\b(\d{1,2})\s*[\/:]\s*12\b/);
  const pitch = pitchM ? Number(pitchM[1]) : (/steep/.test(s) ? 9 : null);

  let stories = grab(/\b(\d)\s*[-\s]?stor(?:y|ies)\b/);
  if (stories == null && /(two|2)\s*story/.test(s)) stories = 2;
  if (stories == null && /(single|one|1)\s*story|ranch/.test(s)) stories = 1;

  let layers = grab(/\b(\d)\s*layers?\b/);
  if (layers == null && /tear\s*-?\s*off|tearoff|remove/.test(s)) layers = 1;
  if (/no tear\s*-?\s*off|layover|overlay|go over/.test(s)) layers = 0;

  return {
    squares, pitch, stories, layers,
    ridge_lf: grab(/(\d+)\s*(?:lf|linear feet|ft)?\s*(?:of\s*)?ridge/) ?? grab(/ridge\s*(?:of\s*)?(\d+)/),
    eave_lf: grab(/(\d+)\s*(?:lf|linear feet|ft)?\s*(?:of\s*)?(?:eave|drip)/) ?? grab(/(?:eave|drip)\s*(?:edge\s*)?(\d+)/),
    penetrations: grab(/(\d+)\s*(?:pipe|penetration|boot|vent)/),
    chimneys: grab(/(\d+)\s*chimney/) ?? (/chimney/.test(s) ? 1 : null),
    customer_name: (t.match(/(?:for|customer)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/) || [])[1] || null,
    address: (t.match(/\d{2,6}\s+[A-Za-z][A-Za-z\s]{2,30}(?:rd|road|st|street|ave|avenue|dr|drive|ln|lane|way|ct|court|cove|cv)\b/i) || [])[0] || null,
  };
}

const stripNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const firstName  = (n) => String(n || '').split(' ')[0] || 'there';

module.exports = { handleInboundSms, parseRoofingJob };
