/**
 * Cron job that sends scheduled follow-up nudges.
 * Runs every minute and dispatches any followups whose send_at has passed.
 */
const cron = require('node-cron');
const db = require('./db');
const { sendSMS } = require('./sms');

const NUDGE_COPY = {
  nudge_24h: (biz) =>
    `Just checking in! Any questions about the estimate from ${biz}? Happy to walk through it 😊`,
  nudge_3d: (biz) =>
    `Hey, ${biz} here — wanted to make sure the estimate I sent worked for you. Want to lock in a time?`,
  nudge_7d: (biz) =>
    `Last quick check-in from ${biz} — if the timing isn't right we can hold the quote for 30 days. Just let us know!`,
};

async function runDueFollowups() {
  const due = db.dueFollowups.all();
  for (const f of due) {
    const contractor = db.getContractorById.get(f.contractor_id);
    const homeowner = db.getHomeownerById.get(f.homeowner_id);
    if (!contractor || !homeowner) {
      db.markFollowupSent.run(f.id);
      continue;
    }
    const body = (NUDGE_COPY[f.kind] || (() => 'Checking in!'))(contractor.business_name);
    await sendSMS({
      from: contractor.business_phone,
      to: homeowner.phone,
      body,
    });
    db.insertMessage.run(
      f.conversation_id,
      'outbound',
      contractor.business_phone,
      homeowner.phone,
      body
    );
    db.markFollowupSent.run(f.id);
  }
}

function start() {
  // every minute
  cron.schedule('* * * * *', () => {
    runDueFollowups().catch((err) =>
      console.error('Followup runner error:', err)
    );
  });
  console.log('⏰ Followup scheduler started (every 1 min).');
}

module.exports = { start, runDueFollowups };
