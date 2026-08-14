// lib/roofingPricing.js
// Company-profile-driven roofing estimate engine. Every number comes from that
// company's pricing_profiles row and their own shingle catalog.

function calculateRoofEstimate(job, p, shingle = null) {
  const sq = num(job.squares, 0);
  const layers = num(job.layers, 1);
  const pitch = num(job.pitch, 5);
  const stories = num(job.stories, 1);
  const ridgeLf = num(job.ridge_lf, 0);
  const eaveLf = num(job.eave_lf, 0);
  const pens = num(job.penetrations, 0);
  const chimneys = num(job.chimneys, 0);

  if (!sq) return { error: 'NO_SQUARES' };

  const billableSq = round2(sq * (1 + num(p.waste_factor, 0.10)));

  // Shingle cost wins over the blended fallback rate.
  const matRate = shingle ? num(shingle.cost_per_square, 0) : num(p.material_per_square, 0);
  const shingleName = shingle ? shingle.name : (p.default_shingle || 'Not set');

  const materials = round2(billableSq * matRate);
  const labor = round2(sq * num(p.labor_per_square, 0));
  const tearoff = round2(sq * layers * num(p.tearoff_per_layer, 0));
  const ridge = round2(ridgeLf * num(p.ridge_per_lf, 0));
  const eave = round2(eaveLf * num(p.eave_per_lf, 0));
  const accessories = round2(pens * num(p.penetration_fee, 0) + chimneys * num(p.chimney_flash_fee, 0));
  const dumpster = round2(num(p.dumpster_fee, 0));

  const baseCost = round2(materials + labor + tearoff + ridge + eave + accessories + dumpster);

  // Surcharges apply to the cost base, before margin
  const steep = pitch >= num(p.steep_pitch_threshold, 7);
  const pitchAdj = steep ? round2(baseCost * num(p.pitch_surcharge, 0)) : 0;
  const storyAdj = stories >= 2 ? round2(baseCost * num(p.two_story_surcharge, 0)) : 0;

  const totalCost = round2(baseCost + pitchAdj + storyAdj);

  // MARGIN, not markup: price = cost / (1 - margin)
  const margin = clamp(num(p.gross_margin, 0.35), 0, 0.9);
  let price = round2(totalCost / (1 - margin));

  const minJob = num(p.min_job_price, 0);
  const belowMin = price < minJob;
  if (belowMin) price = minJob;

  return {
    squares: sq, billable_squares: billableSq, shingle: shingleName, material_rate: matRate,
    breakdown: { materials, labor, tearoff, ridge, eave, accessories, dumpster,
      pitch_surcharge: pitchAdj, two_story_surcharge: storyAdj },
    total_cost: totalCost, gross_margin: margin, gross_profit: round2(price - totalCost),
    price_per_square: round2(price / sq), price,
    flags: { steep, two_story: stories >= 2, below_minimum: belowMin },
    inputs: { layers, pitch, stories, ridge_lf: ridgeLf, eave_lf: eaveLf, penetrations: pens, chimneys },
  };
}

const num = (v, d) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// Contractor-facing SMS reply.
function formatRoofingReply(est) {
  if (est.error === 'NO_SQUARES') {
    return "I need the squares to price this. Send me something like: 32 sq, 1 layer tear off, 8/12, 2 story.";
  }
  const b = est.breakdown;
  const lines = [];
  lines.push(est.squares + ' sq' + (est.inputs.layers ? ', ' + est.inputs.layers + ' layer tear-off' : '') + ' — ' + money(est.price));
  lines.push('');
  lines.push('Materials (' + est.billable_squares + ' sq w/ waste @ ' + money(est.material_rate) + '/sq): ' + money(b.materials));
  lines.push('Labor: ' + money(b.labor));
  if (b.tearoff) lines.push('Tear-off: ' + money(b.tearoff));
  if (b.ridge) lines.push('Ridge: ' + money(b.ridge));
  if (b.eave) lines.push('Eave/drip: ' + money(b.eave));
  if (b.accessories) lines.push('Flashing/penetrations: ' + money(b.accessories));
  if (b.dumpster) lines.push('Disposal: ' + money(b.dumpster));
  if (b.pitch_surcharge) lines.push('Steep pitch (' + est.inputs.pitch + '/12): +' + money(b.pitch_surcharge));
  if (b.two_story_surcharge) lines.push('Two-story: +' + money(b.two_story_surcharge));
  lines.push('');
  lines.push('Cost ' + money(est.total_cost) + ' | Profit ' + money(est.gross_profit) + ' at ' + Math.round(est.gross_margin * 100) + '%');
  lines.push(money(est.price_per_square) + '/sq on ' + est.shingle);
  if (est.flags.below_minimum) lines.push('Bumped to your ' + money(est.price) + ' job minimum.');
  lines.push('');
  lines.push("Change anything and I'll rerun it.");
  return lines.join('\n');
}

module.exports = { calculateRoofEstimate, formatRoofingReply, money };
