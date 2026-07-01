/**
 * The brain. Two entry points:
 *   handleHomeownerInbound  - SMS arrived at a contractor's business number
 *   handleContractorInbound - SMS arrived from a contractor (approval/override)
 *
 * Both return nothing (side-effect: sends SMS via sms.js).
 */
const db = require('./db');
const { sendSMS } = require('./sms');
const { runHomeownerTurn, formatQuoteSMS, formatContractorApprovalSMS } = require('./ai');
const { generateQuote, hasMinimumData } = require('./pricing');

const HISTORY_LIMIT = 20;

async function handleHomeownerInbound({ fromPhone, toPhone, body }) {
  const contractor = db.getContractorByBusinessPhone.get(toPhone);
  if (!contractor) {
    console.warn(`No contractor mapped to business phone ${toPhone}`);
    return;
  }

  const homeowner = db.upsertHomeowner.get(fromPhone);
  const convo = db.getOrCreateConversation(contractor.id, homeowner.id);

  // Log inbound
  db.insertMessage.run(convo.id, 'inbound', fromPhone, toPhone, body);

  // If we are awaiting contractor approval, hold the homeowner gently
  if (convo.state === 'awaiting_contractor_approval') {
    await sendSMS({
      from: toPhone,
      to: fromPhone,
      body: `Thanks! ${contractor.owner_name || 'The owner'} is reviewing your estimate now and will confirm shortly.`,
    });
    db.insertMessage.run(convo.id, 'outbound', toPhone, fromPhone,
      `Thanks! ${contractor.owner_name || 'The owner'} is reviewing your estimate now and will confirm shortly.`);
    return;
  }

  // Handle scheduling state — if homeowner replies YES after quote sent
  if (convo.state === 'quote_sent' && /\b(yes|yep|yeah|sure|ok|okay|sounds good|let's do it|book it)\b/i.test(body)) {
    const reply = `Awesome! Pick a time that works for you: ${contractor.calendar_link}`;
    await sendSMS({ from: toPhone, to: fromPhone, body: reply });
    db.insertMessage.run(convo.id, 'outbound', toPhone, fromPhone, reply);
    db.updateConversation.run('scheduling', convo.collected_json, convo.id);
    return;
  }

  // Otherwise: run AI turn
  const history = db.recentMessages.all(convo.id, HISTORY_LIMIT).reverse();
  const collected = JSON.parse(convo.collected_json || '{}');
  const aiResult = await runHomeownerTurn(
    contractor,
    { state: convo.state, collected },
    history.slice(0, -1), // exclude the inbound we just inserted
    body
  );

  // Save & send AI reply
  await sendSMS({ from: toPhone, to: fromPhone, body: aiResult.reply });
  db.insertMessage.run(convo.id, 'outbound', toPhone, fromPhone, aiResult.reply);

  // If escalate -> notify contractor
  if (aiResult.escalate) {
    await sendSMS({
      from: contractor.business_phone,
      to: contractor.contractor_phone,
      body: `⚠️ Heads up: ${fromPhone} may need a personal call. Last msg: "${body}"`,
    });
  }

  // Decide if we are ready to draft a quote
  let nextState = convo.state === 'greeting' ? 'qualifying' : convo.state;
  if (
    aiResult.ready_for_quote &&
    hasMinimumData(contractor.trade, aiResult.collected)
  ) {
    const quoteObj = generateQuote(contractor, aiResult.collected);
    if (quoteObj) {
      const quoteRow = db.insertQuote.run(
        convo.id,
        quoteObj.amount_cents,
        JSON.stringify(quoteObj.line_items)
      );
      // Stash summary in line_items for later retrieval
      const enriched = { ...quoteObj, id: quoteRow.lastInsertRowid };
      // Send to contractor for approval
      const approvalSMS = formatContractorApprovalSMS(
        contractor,
        aiResult.collected.name,
        aiResult.collected,
        enriched
      );
      await sendSMS({
        from: contractor.business_phone,
        to: contractor.contractor_phone,
        body: approvalSMS,
      });
      nextState = 'awaiting_contractor_approval';
    }
  }

  db.updateConversation.run(nextState, JSON.stringify(aiResult.collected), convo.id);
}

async function handleContractorInbound({ fromPhone, toPhone, body }) {
  const contractor = db.getContractorByOwnerPhone.get(fromPhone);
  if (!contractor) {
    console.warn(`No contractor matched owner phone ${fromPhone}`);
    return;
  }

  // Find the most recent conversation awaiting approval
  const pendingConvo = db.db
    .prepare(
      `SELECT * FROM conversations
       WHERE contractor_id = ? AND state = 'awaiting_contractor_approval'
       ORDER BY last_activity_at DESC LIMIT 1`
    )
    .get(contractor.id);

  if (!pendingConvo) {
    await sendSMS({
      from: contractor.business_phone,
      to: fromPhone,
      body: `Got it — no quotes awaiting approval right now.`,
    });
    return;
  }

  const quote = db.getPendingQuoteForConversation.get(pendingConvo.id);
  const homeowner = db.getHomeownerById.get(pendingConvo.homeowner_id);

  const trimmed = body.trim();
  const yes = /^(y|yes|yep|send|ok|okay|go)\b/i.test(trimmed);
  const no = /^(n|no|skip|hold)\b/i.test(trimmed);
  const overrideMatch = trimmed.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);

  if (no) {
    await sendSMS({
      from: contractor.business_phone,
      to: fromPhone,
      body: `Skipped. I'll keep the convo open and ping you if they ask again.`,
    });
    db.updateConversation.run('qualifying', pendingConvo.collected_json, pendingConvo.id);
    return;
  }

  let finalAmountCents = quote.amount_cents;
  if (!yes && overrideMatch) {
    finalAmountCents = Math.round(parseFloat(overrideMatch[1].replace(/,/g, '')) * 100);
  } else if (!yes && !overrideMatch) {
    await sendSMS({
      from: contractor.business_phone,
      to: fromPhone,
      body: `Didn't catch that — reply YES to send, NO to skip, or "$<amount>" to override.`,
    });
    return;
  }

  // Build line items for the actual amount (rebuild from collected if override)
  const lineItems = JSON.parse(quote.line_items_json);
  const collected = JSON.parse(pendingConvo.collected_json || '{}');
  const summary = (() => {
    if (contractor.trade === 'roofing') {
      return `${collected.material || 'asphalt'} roof, ${collected.sqft || '?'} sqft${collected.tear_off ? ', with tear-off' : ''}`;
    }
    return `${collected.material || 'flooring'}, ${collected.sqft || '?'} sqft${collected.removal ? ', with old flooring removal' : ''}`;
  })();

  db.approveQuote.run(quote.id);

  // Send quote to homeowner
  const paymentLink = contractor.payment_link_template
    ? contractor.payment_link_template.replace('{{amount}}', Math.round(finalAmountCents / 100 * 0.1)) // 10% deposit
    : null;
  const homeownerSMS = formatQuoteSMS(
    contractor,
    { amount_cents: finalAmountCents, summary, line_items: lineItems },
    paymentLink
  );
  await sendSMS({
    from: contractor.business_phone,
    to: homeowner.phone,
    body: homeownerSMS,
  });
  db.insertMessage.run(pendingConvo.id, 'outbound', contractor.business_phone, homeowner.phone, homeownerSMS);
  db.markQuoteSent.run(quote.id);
  db.updateConversation.run('quote_sent', pendingConvo.collected_json, pendingConvo.id);

  // Confirm to contractor
  await sendSMS({
    from: contractor.business_phone,
    to: fromPhone,
    body: `✅ Sent. I'll follow up automatically at 24h, 3d, and 7d if they go quiet.`,
  });

  // Schedule follow-ups
  const now = Date.now();
  db.scheduleFollowup.run(pendingConvo.id, new Date(now + 24 * 60 * 60 * 1000).toISOString(), 'nudge_24h');
  db.scheduleFollowup.run(pendingConvo.id, new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(), 'nudge_3d');
  db.scheduleFollowup.run(pendingConvo.id, new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(), 'nudge_7d');
}

module.exports = { handleHomeownerInbound, handleContractorInbound };
