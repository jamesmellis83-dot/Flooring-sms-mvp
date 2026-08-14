// lib/smsHandler.js
// The whole point of the MVP: an inbound text is now tied to a contractor account,
// priced with THAT contractor's profile, and saved to their history.
//
// Flow: identify contractor -> parse job -> load pricing -> calculate -> save -> reply

const store = require('../db');
const { calculateRoofEstimate, formatRoofingReply } = require('./roofingPricing');

// Keeps light context so "make it 35 squares" works without a full AI memory layer.
const lastJob = new Map(); // contractorId -> parsed job

async function handleInboundSms({ from, text }) {
  const contractor = store.getContractorByPhone(from);

  if (!contractor) {
    return `This number isn't linked to a BidBuddy account yet. Set up your pricing at ${process.env.SITE_URL || 'https://bidbuddyusa.com'}/signup and add this phone number — takes about two minutes.`;
  }
  if (!contractor.onboarded) {
    return `Almost there, ${firstName(contractor.owner_name)}. Finish your pricing setup at ${process.env.SITE_URL || 'https://bidbuddyusa.com'}/onboarding and I'll price jobs with your numbers instead of defaults.`;
  }

  const body = String(text || '').trim();

  // Quick commands
  if (/^(help|commands)$/i.test(body)) {
    return "Text me the job and I'll price it with your numbers.\nExample: 32 sq, 1 layer tear off, 8/12 pitch, 2 story, 2 chimneys\nSay STOP to opt out.";
  }
  if (/^(pricing|my pricing|rates)$/i.test(body)) {
    const p = store.getPricing(contractor.id);
    return `Your current profile:\nLabor $${p.labor_per_square}/sq\nMaterial $${p.material_per_square}/sq\nMargin ${Math.round(p.gross_margin*100)}%\nTear-off $${p.tearoff_per_layer}/sq/layer\nDisposal $${p.dumpster_fee}\nChange it at ${process.env.SITE_URL || 'https://bidbuddyusa.com'}/pricing-profile`;
  }

  // Parse this text, merged over the previous job so follow-ups work
  const prev = lastJob.get(contractor.id) || {};
  const parsed = parseRoofingJob(body);
  const isFollowUp = parsed.squares == null && prev.squares != null;
  const job = isFollowUp ? { ...prev, ...stripNulls(parsed) } : stripNulls(parsed);

  if (!job.squares) {
    return "I need squares to price it. Send something like: 32 sq, 1 layer tear off, 8/12, 2 story.";
  }

  const pricing = store.getPricing(contractor.id);
  const estimate = calculateRoofEstimate(job, pricing);

  lastJob.set(contractor.id, job);

  store.saveEstimate({
    contractor_id: contractor.id,
    customer_name: job.customer_name,
    job_address: job.address,
    squares: job.squares,
    estimate_amount: estimate.price,
    estimate_json: { ...estimate, parsed_job: job, raw_text: body },
    source: 'sms',
  });

  const reply = formatRoofingReply(estimate, contractor);
  return isFollowUp ? 'Updated.\n\n' + reply : reply;
}

/**
 * Deterministic parser — no AI call needed for the common case, which keeps
 * cost near zero. Returns nulls for anything not mentioned so follow-up
 * texts can patch a previous job.
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
    squares,
    pitch,
    stories,
    layers,
    ridge_lf: grab(/(\d+)\s*(?:lf|linear feet|ft)?\s*(?:of\s*)?ridge/) ?? grab(/ridge\s*(?:of\s*)?(\d+)/),
    eave_lf: grab(/(\d+)\s*(?:lf|linear feet|ft)?\s*(?:of\s*)?(?:eave|drip)/) ?? grab(/(?:eave|drip)\s*(?:edge\s*)?(\d+)/),
    penetrations: grab(/(\d+)\s*(?:pipe|penetration|boot|vent)/),
    chimneys: grab(/(\d+)\s*chimney/) ?? (/chimney/.test(s) ? 1 : null),
    shingle: matchShingle(s),
    customer_name: (t.match(/(?:for|customer)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/) || [])[1] || null,
    address: (t.match(/\d{2,6}\s+[A-Za-z][A-Za-z\s]{2,30}(?:rd|road|st|street|ave|avenue|dr|drive|ln|lane|way|ct|court|cove|cv)\b/i) || [])[0] || null,
  };
}

function matchShingle(s) {
  if (/duration|owens/.test(s)) return 'Owens Corning Duration';
  if (/hdz|timberline|gaf/.test(s)) return 'GAF Timberline HDZ';
  if (/landmark|certainteed/.test(s)) return 'CertainTeed Landmark';
  return null;
}

const stripNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const firstName = (n) => String(n || '').split(' ')[0] || 'there';

module.exports = { handleInboundSms, parseRoofingJob };
