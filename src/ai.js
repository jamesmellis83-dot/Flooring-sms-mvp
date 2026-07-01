/**
 * AI conversation engine.
 *
 * Two distinct prompts:
 *   1. Homeowner-facing: friendly, professional, gathers info, never quotes a price
 *      until the contractor approves.
 *   2. Quote-summary writer: takes a structured quote and writes the SMS the
 *      homeowner will receive.
 *
 * We use function calling to extract structured data and decide state transitions.
 */
require('dotenv').config();
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const HOMEOWNER_SYSTEM_PROMPT = (contractor) => `
You are a friendly, professional virtual assistant texting on behalf of ${contractor.business_name}, a ${contractor.trade} contractor. The owner is ${contractor.owner_name || 'the owner'}.

YOUR JOB:
- Greet the homeowner warmly.
- Gather the info needed to quote a ${contractor.trade} job.
- Confirm details back to them.
- NEVER quote a price yourself. NEVER promise a specific dollar amount. The owner reviews & approves every quote.
- Keep replies SHORT and friendly — this is SMS. Max 1-3 sentences per message. No emoji spam (1 at most, sparingly).
- Don't ask more than 1-2 questions per message.
- If they send a photo (you'll see "[image attached]"), acknowledge it but still ask for the data you need.

INFO TO COLLECT for ${contractor.trade}:
${contractor.trade === 'roofing' ? `
- Homeowner name
- Property address
- Approximate roof square footage (or "I don't know" — that's fine)
- Material preference (3-tab asphalt, architectural asphalt, metal, tile) — or "not sure"
- Is this a tear-off (removing old roof) or new construction?
- How many stories?
- Any leaks / urgency?
` : `
- Homeowner name
- Property address
- Approximate square footage of the area
- Material preference (LVP, engineered hardwood, tile, carpet) — or "not sure"
- Do they need the old flooring removed?
- Which rooms / type of space?
- Timeline / urgency?
`}

When you have enough info to draft a quote, set ready_for_quote=true in the structured output.
If the homeowner asks something off-topic, politely steer back. If they want to talk to a human, set escalate=true.
`.trim();

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'update_conversation',
      description: 'Update the structured data we have collected from the homeowner and decide next state.',
      parameters: {
        type: 'object',
        properties: {
          reply: {
            type: 'string',
            description: 'The SMS message to send to the homeowner. Short, friendly, 1-3 sentences.',
          },
          collected: {
            type: 'object',
            description: 'All structured data collected so far. Merge with prior data.',
            properties: {
              name: { type: 'string' },
              address: { type: 'string' },
              sqft: { type: 'number' },
              material: { type: 'string' },
              tear_off: { type: 'boolean', description: 'Roofing only' },
              removal: { type: 'boolean', description: 'Flooring only' },
              stories: { type: 'number', description: 'Roofing only' },
              rooms: { type: 'string', description: 'Flooring only' },
              urgency: { type: 'string' },
              notes: { type: 'string' },
            },
            additionalProperties: true,
          },
          ready_for_quote: {
            type: 'boolean',
            description: 'True when we have enough info to draft a quote for contractor approval.',
          },
          escalate: {
            type: 'boolean',
            description: 'True if the homeowner needs a human (complaint, complex situation, etc.).',
          },
        },
        required: ['reply', 'collected', 'ready_for_quote', 'escalate'],
      },
    },
  },
];

async function runHomeownerTurn(contractor, conversationState, history, incomingMessage) {
  const messages = [
    { role: 'system', content: HOMEOWNER_SYSTEM_PROMPT(contractor) },
    {
      role: 'system',
      content: `Current collected data: ${JSON.stringify(conversationState.collected)}\nCurrent state: ${conversationState.state}`,
    },
    ...history.map((m) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body,
    })),
    { role: 'user', content: incomingMessage },
  ];

  const resp = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools: TOOLS,
    tool_choice: { type: 'function', function: { name: 'update_conversation' } },
    temperature: 0.5,
  });

  const call = resp.choices[0].message.tool_calls?.[0];
  if (!call) {
    return {
      reply: "Sorry, I didn't catch that — could you say it again?",
      collected: conversationState.collected,
      ready_for_quote: false,
      escalate: false,
    };
  }

  const args = JSON.parse(call.function.arguments);
  // Merge collected (new wins on overlap, but don't wipe with undefined)
  const mergedCollected = { ...conversationState.collected };
  for (const [k, v] of Object.entries(args.collected || {})) {
    if (v !== undefined && v !== null && v !== '') mergedCollected[k] = v;
  }

  return {
    reply: args.reply,
    collected: mergedCollected,
    ready_for_quote: !!args.ready_for_quote,
    escalate: !!args.escalate,
  };
}

/**
 * Format a quote as a homeowner-facing SMS (called after contractor approves).
 */
function formatQuoteSMS(contractor, quoteObj, paymentLink) {
  const dollars = (quoteObj.amount_cents / 100).toFixed(2);
  return `Here's your estimate from ${contractor.business_name} for ${quoteObj.summary}:\n\n💵 Total: $${dollars}\n\nThis is an estimate based on the info you shared — final price confirmed after a quick site visit.\n\nReady to move forward? Reply YES to schedule, or any questions just text back!${paymentLink ? `\n\nDeposit (optional): ${paymentLink}` : ''}`;
}

/**
 * Format a quote summary for the contractor to approve.
 */
function formatContractorApprovalSMS(contractor, homeownerName, collected, quoteObj) {
  const dollars = (quoteObj.amount_cents / 100).toFixed(2);
  const lines = quoteObj.line_items
    .map((li) => `  • ${li.label}: $${li.amount.toFixed(2)}`)
    .join('\n');
  return `🆕 New quote ready for your OK:\n\nCustomer: ${homeownerName || 'Unknown'}\nJob: ${quoteObj.summary}\n${lines}\n\n💵 TOTAL: $${dollars}\n\nReply YES to send, NO to skip, or "$<amount>" to override (e.g. $4200).`;
}

module.exports = {
  runHomeownerTurn,
  formatQuoteSMS,
  formatContractorApprovalSMS,
};
