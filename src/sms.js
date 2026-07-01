/**
 * Thin SMS sender abstraction.
 * If DRY_RUN=true, logs to console (great for local dev / demos).
 * Otherwise hits Twilio.
 */
require('dotenv').config();

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

let twilioClient = null;
if (!DRY_RUN) {
  const twilio = require('twilio');
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

async function sendSMS({ from, to, body }) {
  if (DRY_RUN) {
    console.log('\n────── 📤 SMS (DRY_RUN) ──────');
    console.log(`FROM: ${from}`);
    console.log(`TO:   ${to}`);
    console.log(`BODY: ${body}`);
    console.log('──────────────────────────────\n');
    return { sid: 'DRYRUN-' + Date.now() };
  }
  return twilioClient.messages.create({ from, to, body });
}

module.exports = { sendSMS, DRY_RUN };
