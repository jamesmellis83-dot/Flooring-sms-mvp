// lib/roofingPricing.js
// Company-profile-driven roofing estimate engine.
// Improved contractor-facing response formatting.

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

  const matRate = shingle
    ? num(shingle.cost_per_square, 0)
    : num(p.material_per_square, 0);

  const shingleName = shingle
    ? shingle.name
    : (p.default_shingle || 'Not set');

  const materials = round2(billableSq * matRate);
  const labor = round2(sq * num(p.labor_per_square, 0));
  const tearoff = round2(sq * layers * num(p.tearoff_per_layer, 0));
  const ridge = round2(ridgeLf * num(p.ridge_per_lf, 0));
  const eave = round2(eaveLf * num(p.eave_per_lf, 0));

  const accessories = round2(
    pens * num(p.penetration_fee, 0) +
    chimneys * num(p.chimney_flash_fee, 0)
  );

  const dumpster = round2(num(p.dumpster_fee, 0));

  const baseCost = round2(
    materials +
    labor +
    tearoff +
    ridge +
    eave +
    accessories +
    dumpster
  );

  const steep = pitch >= num(p.steep_pitch_threshold, 7);

  const pitchAdj = steep
    ? round2(baseCost * num(p.pitch_surcharge, 0))
    : 0;

  const storyAdj = stories >= 2
    ? round2(baseCost * num(p.two_story_surcharge, 0))
    : 0;

  const totalCost = round2(baseCost + pitchAdj + storyAdj);
  const margin = clamp(num(p.gross_margin, 0.35), 0, 0.9);

  let price = round2(totalCost / (1 - margin));

  const minJob = num(p.min_job_price, 0);
  const belowMin = price < minJob;

  if (belowMin) {
    price = minJob;
  }

  return {
    squares: sq,
    billable_squares: billableSq,
    shingle: shingleName,
    material_rate: matRate,

    breakdown: {
      materials,
      labor,
      tearoff,
      ridge,
      eave,
      accessories,
      dumpster,
      pitch_surcharge: pitchAdj,
      two_story_surcharge: storyAdj
    },

    total_cost: totalCost,
    gross_margin: margin,
    gross_profit: round2(price - totalCost),
    price_per_square: round2(price / sq),
    price,

    flags: {
      steep,
      two_story: stories >= 2,
      below_minimum: belowMin
    },

    inputs: {
      layers,
      pitch,
      stories,
      ridge_lf: ridgeLf,
      eave_lf: eaveLf,
      penetrations: pens,
      chimneys
    }
  };
}

const num = (v, d) =>
  (v === null || v === undefined || v === '' || isNaN(Number(v)))
    ? d
    : Number(v);

const round2 = (n) =>
  Math.round(n * 100) / 100;

const clamp = (n, lo, hi) =>
  Math.min(hi, Math.max(lo, n));

const money = (n) =>
  '$' + Number(n).toLocaleString(
    'en-US',
    {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }
  );

function estimateConfidence(est) {
  let score = 0;

  if (est.inputs.pitch) score++;
  if (est.inputs.stories) score++;
  if (est.inputs.layers !== undefined) score++;
  if (est.inputs.ridge_lf) score++;
  if (est.inputs.eave_lf) score++;
  if (est.inputs.chimneys) score++;
  if (est.inputs.penetrations) score++;

  if (score >= 6) return 'High';
  if (score >= 3) return 'Medium';

  return 'Low';
}

function estimateRange(price, confidence) {
  let variance = 0.15;

  if (confidence === 'High') variance = 0.05;
  if (confidence === 'Medium') variance = 0.10;

  return {
    low: Math.round(price * (1 - variance)),
    high: Math.round(price * (1 + variance))
  };
}

function formatRoofingReply(est) {
  if (est.error === 'NO_SQUARES') {
    return 'I need the roof size before I can build an estimate. Send something like: 32 sq, 8/12 pitch, 2 story, 1 layer tear off.';
  }

  const confidence = estimateConfidence(est);
  const range = estimateRange(est.price, confidence);
  const lines = [];

  lines.push(
    `Based on ${est.squares} squares, I would expect this roof to land somewhere around ${money(range.low)} - ${money(range.high)}.`
  );

  lines.push('');
  lines.push(`Confidence: ${confidence}`);
  lines.push('');
  lines.push('Assumptions:');
  lines.push(`- ${est.inputs.layers || 1} tear-off layer${(est.inputs.layers || 1) === 1 ? '' : 's'}`);
  lines.push(`- ${est.inputs.stories || 1} story structure${(est.inputs.stories || 1) === 1 ? '' : ''}`);
  lines.push(`- ${est.inputs.pitch || 5}/12 pitch`);
  lines.push(`- ${est.shingle}`);

  lines.push('');
  lines.push('Major Cost Drivers:');
  lines.push('- Roofing materials');
  lines.push('- Labor');
  lines.push('- Tear-off and disposal');

  if (est.flags.steep) {
    lines.push('- Steep pitch labor');
  }

  if (est.flags.two_story) {
    lines.push('- Two-story access');
  }

  if (est.inputs.chimneys) {
    lines.push('- Chimney flashing');
  }

  if (est.inputs.penetrations) {
    lines.push('- Roof penetrations');
  }

  lines.push('');
  lines.push(`Estimated Sale Price: ${money(est.price)}`);
  lines.push(`Estimated Cost Basis: ${money(est.total_cost)}`);
  lines.push(`Price Per Square: ${money(est.price_per_square)}/sq`);

  lines.push('');
  lines.push('Not Included:');
  lines.push('- Deck replacement');
  lines.push('- Structural repairs');
  lines.push('- Gutters');
  lines.push('- Insurance supplements');

  if (est.flags.below_minimum) {
    lines.push('');
    lines.push('Minimum job pricing was applied.');
  }

  lines.push('');
  lines.push('This is a preliminary estimating range, not a final bid. Reply with changes like "2 story", "8/12 pitch", "2 chimneys", or a different shingle and I will recalculate it.');

  return lines.join('\n');
}

module.exports = {
  calculateRoofEstimate,
  formatRoofingReply,
  money
};
