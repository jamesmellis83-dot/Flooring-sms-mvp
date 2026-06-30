const OpenAI = require('openai');
const cfg = require('./configStore');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function parseJob(message) {
  try {
    const prompts = cfg.prompts();
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompts.aiParsePrompt },
        { role: 'user', content: message },
      ],
    });
    const json = JSON.parse(res.choices[0].message.content);
    if (!json.sqft || !json.type) return null;
    json.type = String(json.type).toLowerCase();
    json.job = json.job || 'install';
    json.addOns = json.addOns || {};
    return json;
  } catch (err) {
    console.error('parseJob error:', err.message);
    return null;
  }
}
module.exports = { parseJob };
