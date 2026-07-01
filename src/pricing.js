/**
 * Pricing engine.
 * Given a contractor's rules + the data the AI gathered, produce a quote.
 *
 * Inputs (collected by AI):
 *   sqft               (number)            REQUIRED
 *   material           (string, optional)  matches a key in rules.materials
 *   tear_off           (bool, roofing)
 *   removal            (bool, flooring)
 *   stories            (number, roofing)
 *   notes              (string)
 */

function priceRoofing(rules, data) {
  const sqft = Number(data.sqft) || 0;
  if (!sqft) return null;

  const materialKey = (data.material || '3-tab asphalt').toLowerCase();
  const matchedMaterialKey =
    Object.keys(rules.materials || {}).find(
      (k) => k.toLowerCase() === materialKey
    ) || '3-tab asphalt';
  const materialUpcharge = (rules.materials || {})[matchedMaterialKey] || 0;

  const base = rules.base_per_sqft * sqft;
  const materials = materialUpcharge * sqft;
  const tearOff = data.tear_off ? rules.tear_off_per_sqft * sqft : 0;
  const storiesMultiplier = data.stories && Number(data.stories) >= 2 ? 1.1 : 1.0;

  const subtotal = (base + materials + tearOff) * storiesMultiplier;
  const labor = subtotal * (rules.labor_markup_pct / 100);
  let total = subtotal + labor;

  if (total < rules.min_job) total = rules.min_job;

  const cents = Math.round(total * 100);

  return {
    amount_cents: cents,
    line_items: [
      { label: `Base install (${sqft} sqft @ $${rules.base_per_sqft}/sqft)`, amount: +(base).toFixed(2) },
      { label: `Material upcharge: ${matchedMaterialKey}`, amount: +(materials).toFixed(2) },
      ...(data.tear_off ? [{ label: `Tear-off (${sqft} sqft @ $${rules.tear_off_per_sqft}/sqft)`, amount: +(tearOff).toFixed(2) }] : []),
      ...(storiesMultiplier > 1 ? [{ label: '2+ story multiplier (10%)', amount: +(subtotal - (base + materials + tearOff)).toFixed(2) }] : []),
      { label: `Labor markup ${rules.labor_markup_pct}%`, amount: +(labor).toFixed(2) },
    ],
    summary: `${matchedMaterialKey} roof, ${sqft} sqft${data.tear_off ? ', with tear-off' : ''}${data.stories ? `, ${data.stories} stor${data.stories > 1 ? 'ies' : 'y'}` : ''}`,
  };
}

function priceFlooring(rules, data) {
  const sqft = Number(data.sqft) || 0;
  if (!sqft) return null;

  const materialKey = (data.material || 'LVP (luxury vinyl plank)').toLowerCase();
  const matchedMaterialKey =
    Object.keys(rules.materials || {}).find(
      (k) => k.toLowerCase() === materialKey
    ) || 'LVP (luxury vinyl plank)';
  const materialUpcharge = (rules.materials || {})[matchedMaterialKey] || 0;

  const base = rules.base_per_sqft * sqft;
  const materials = materialUpcharge * sqft;
  const removal = data.removal ? rules.removal_per_sqft * sqft : 0;

  const subtotal = base + materials + removal;
  const labor = subtotal * (rules.labor_markup_pct / 100);
  let total = subtotal + labor;
  if (total < rules.min_job) total = rules.min_job;

  return {
    amount_cents: Math.round(total * 100),
    line_items: [
      { label: `Base install (${sqft} sqft @ $${rules.base_per_sqft}/sqft)`, amount: +(base).toFixed(2) },
      { label: `Material upcharge: ${matchedMaterialKey}`, amount: +(materials).toFixed(2) },
      ...(data.removal ? [{ label: `Old flooring removal (${sqft} sqft @ $${rules.removal_per_sqft}/sqft)`, amount: +(removal).toFixed(2) }] : []),
      { label: `Labor markup ${rules.labor_markup_pct}%`, amount: +(labor).toFixed(2) },
    ],
    summary: `${matchedMaterialKey}, ${sqft} sqft${data.removal ? ', with old flooring removal' : ''}`,
  };
}

function generateQuote(contractor, collected) {
  const rules = JSON.parse(contractor.pricing_rules_json || '{}');
  if (contractor.trade === 'roofing') return priceRoofing(rules, collected);
  if (contractor.trade === 'flooring') return priceFlooring(rules, collected);
  return null;
}

function hasMinimumData(trade, collected) {
  if (!collected.sqft) return false;
  if (trade === 'roofing') return !!collected.material;
  if (trade === 'flooring') return !!collected.material;
  return false;
}

module.exports = { generateQuote, hasMinimumData };
