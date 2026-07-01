/**
 * Interactive SMS simulator.
 * Talks to the running backend via POST /simulate so you can demo the whole
 * flow end-to-end from your terminal without Twilio.
 *
 * Usage:
 *   1. Start server in one terminal:  npm start
 *   2. Run this in another:           npm run simulate
 */
const readline = require('readline');

const SERVER = process.env.SERVER_URL || 'http://localhost:3000';

// Demo numbers from db.js seed
const HOMEOWNER = '+19015559999';
const ROOFING_BUSINESS = '+19015550102';
const ROOFING_OWNER = '+19015550101';
const FLOORING_BUSINESS = '+19015550202';
const FLOORING_OWNER = '+19015550201';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function send(from, to, body) {
  const r = await fetch(`${SERVER}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, body }),
  });
  if (!r.ok) {
    console.error('Error:', await r.text());
  }
}

async function main() {
  console.log('\n🎬 Contractor SMS Simulator');
  console.log('---------------------------');
  const trade = (await ask('Trade? (r)oofing / (f)looring [r]: ')).toLowerCase();
  const isRoofing = !trade || trade.startsWith('r');
  const businessPhone = isRoofing ? ROOFING_BUSINESS : FLOORING_BUSINESS;
  const ownerPhone = isRoofing ? ROOFING_OWNER : FLOORING_OWNER;
  console.log(`\nYou are texting as homeowner ${HOMEOWNER} -> ${isRoofing ? 'Ellis Roofing' : 'Memphis Floors'} (${businessPhone}).`);
  console.log(`Type "/owner <msg>" to send as the contractor (${ownerPhone}). Type "/quit" to exit.\n`);

  while (true) {
    const line = await ask('> ');
    if (!line) continue;
    if (line === '/quit') break;
    if (line.startsWith('/owner ')) {
      await send(ownerPhone, businessPhone, line.slice(7));
    } else {
      await send(HOMEOWNER, businessPhone, line);
    }
  }
  rl.close();
}

main().catch(console.error);
