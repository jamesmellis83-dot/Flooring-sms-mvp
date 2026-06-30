// SMS state machine — ProStall Flooring
// Returns either a string OR an array of strings (multi-message reply for onboarding)

const cfg = require('./configStore');
const db = require('./db');
const { parseJob } = require('./parser');
const { estimate } = require('./estimator');

const fill = (tpl, vals = {}) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => vals[k] !== undefined && vals[k] !== null ? vals[k] : '');

const jobLabel = j => ({ install: 'install', demo: 'demo', demoAndInstall: 'demo + install' }[j] || j);

async function handleIncoming(phone, body) {
  const text = (body || '').trim();
  const lower = text.toLowerCase();
  const convo = db.getConvo(phone);
  const prompts = cfg.prompts();
  const pricing = cfg.pricing();
  const ctx = { contractorName: pricing.contractorName };

  // ===== FIRST-TIME ONBOARDING =====
  // If this phone has never been onboarded, send the welcome packet THEN process their actual message.
  if (!convo.onboarded) {
    db.saveConvo(phone, convo.state || 'NEW', convo.context || {}, true);

    const onboardingMsg = fill(prompts.firstTimeOnboarding, ctx);

    // If they sent something substantive, process it AFTER onboarding (return array)
    if (text.length >= 8) {
      const followUp = await processMessage(phone, text, prompts, pricing, ctx);
      return [onboardingMsg, followUp].flat();
    }
    return onboardingMsg;
  }

  return processMessage(phone, text, prompts, pricing, ctx);
}

async function processMessage(phone, text, prompts, pricing, ctx) {
  const lower = text.toLowerCase();
  const convo = db.getConvo(phone);

  // Global commands
  if (lower === 'menu' || lower === 'help') return fill(prompts.menu, ctx);
  if (lower === 'reset' || lower === 'start over') {
    db.resetConvo(phone);
    return prompts.resetConfirm;
  }
  if (lower === 'stats') return fill(prompts.statsReply, { ...ctx, ...db.getStats() });

  switch (convo.state) {
    case 'NEW': {
      const parsed = await parseJob(text);
      if (!parsed) {
        if (text.length < 10) return fill(prompts.welcome, ctx);
        return prompts.parseFailed;
      }
      const est = estimate(parsed);
      db.saveConvo(phone, 'AWAITING_ACTION', { parsed, est });
      return fill(prompts.parsedConfirmation, { ...parsed, ...ctx, typeLabel: est.typeLabel, job: jobLabel(parsed.job) });
    }
    case 'AWAITING_ACTION': {
      const { parsed, est } = convo.context;
      if (text === '1') {
        db.saveConvo(phone, 'AFTER_ESTIMATE', { parsed, est });
        return fill(prompts.quickEstimate, { ...parsed, ...est, ...ctx, job: jobLabel(parsed.job) });
      }
      if (text === '2') {
        db.saveConvo(phone, 'AFTER_ESTIMATE', { parsed, est });
        return fill(prompts.fullBreakdown, { ...parsed, ...est, ...ctx, job: jobLabel(parsed.job) });
      }
      if (text === '3') {
        db.saveConvo(phone, 'NEW', {});
        return 'Ok, text me the corrected job details.';
      }
      const reparsed = await parseJob(text);
      if (reparsed) {
        const newEst = estimate(reparsed);
        db.saveConvo(phone, 'AWAITING_ACTION', { parsed: reparsed, est: newEst });
        return fill(prompts.parsedConfirmation, { ...reparsed, ...ctx, typeLabel: newEst.typeLabel, job: jobLabel(reparsed.job) });
      }
      return prompts.unknownInput;
    }
    case 'AFTER_ESTIMATE': {
      const { parsed, est } = convo.context;
      if (text === '1') {
        return fill(prompts.customerMessage, {
          ...parsed, ...est, ...ctx,
          customerName: parsed.customerName || 'there',
        });
      }
      if (text === '2') {
        db.saveLead({
          phone,
          customer_name: parsed.customerName,
          sqft: parsed.sqft, type: parsed.type, job: parsed.job,
          location: parsed.location, notes: parsed.notes,
          estimate_low: est.low, estimate_high: est.high,
          breakdown: est,
        });
        db.saveConvo(phone, 'NEW', {});
        return fill(prompts.savedJob, { ...ctx, ...db.getStats() });
      }
      if (text === '3') {
        db.saveConvo(phone, 'NEW', {});
        return 'Started over. Text me the next job.';
      }
      const reparsed = await parseJob(text);
      if (reparsed) {
        const newEst = estimate(reparsed);
        db.saveConvo(phone, 'AWAITING_ACTION', { parsed: reparsed, est: newEst });
        return fill(prompts.parsedConfirmation, { ...reparsed, ...ctx, typeLabel: newEst.typeLabel, job: jobLabel(reparsed.job) });
      }
      return prompts.unknownInput;
    }
    default:
      db.saveConvo(phone, 'NEW', {});
      return fill(prompts.welcome, ctx);
  }
}

module.exports = { handleIncoming };
