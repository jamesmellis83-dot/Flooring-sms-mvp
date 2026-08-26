// lib/roofingPricing.js
// Company-profile-driven roofing estimate engine.
// Human-friendly SMS response formatting for roofing estimators.

function calculateRoofEstimate(job, p, shingle = null) {
  const sq = num(job.squares, 0);
  const layers = num(job.layers, 1);
  const pitch = num(job.pitch, 5);
  const stories = num(job.stories, 1);
  const ridgeLf = num(job.ridge_lf, 0);
  const eaveLf = num(job.eave_lf, 0);
  const valleyLf = num(job.valley_lf, 0);
  const pens = num(job.penetrations, 0);
  const chimneys = num(job.chimneys, 0);
  const skylights = num(job.skylights, 0);

  if (!sq) return { error: 'NO_SQUARES' };

  const billableSq = round2(sq * (1 + num(p.waste_factor, 0.10)));
  const matRate = shingle ? num(shingle.cost_per_square, 0) : num(p.material_per_square, 0);
  const shingleName = shingle ? shingle.name : (p.default_shingle || 'Not set');

  const materials = round2(billableSq * matRate);
  const labor = round2(sq * num(p.labor_per_square, 0));
  const tearoff = round2(sq * layers * num(p.tearoff_per_layer, 0));
  const ridge = round2(ridgeLf * num(p.ridge_per_lf, 0));
  const eave = round2(eaveLf * num(p.eave_per_lf, 0));
  const valley = round2(valleyLf * num(p.valley_per_lf, 0));
  const accessories = round2(
    pens * num(p.penetration_fee, 0) +
    chimneys * num(p.chimney_flash_fee, 0) +
    skylights * num(p.skylight_flash_fee, 0)
  );
  // Disposal/dumpster is included by DEFAULT on every job (tear-off almost
  // always requires disposal) unless the estimator explicitly says the
  // customer is supplying their own dumpster / no disposal fee is needed
  // (job.dumpster_excluded === true). This must be stated in the AI's reply
  // either way - never silently included without being mentioned, and never
  // silently dropped without being mentioned either.
  const dumpster = job.dumpster_excluded ? 0 : round2(num(p.dumpster_fee, 0));

  const baseCost = round2(
    materials +
    labor +
    tearoff +
    ridge +
    eave +
    valley +
    accessories +
    dumpster
  );

  const steep = pitch >= num(p.steep_pitch_threshold, 7);
  const pitchAdj = steep ? round2(baseCost * num(p.pitch_surcharge, 0)) : 0;
  const storyAdj = stories >= 2 ? round2(baseCost * num(p.two_story_surcharge, 0)) : 0;
  const totalCost = round2(baseCost + pitchAdj + storyAdj);

  const margin = clamp(num(p.gross_margin, 0.35), 0, 0.9);
  let price = round2(totalCost / (1 - margin));

  const minJob = num(p.min_job_price, 0);
  const belowMin = price < minJob;
  if (belowMin) price = minJob;

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
      valley,
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
      below_minimum: belowMin,
      dumpster_included: !job.dumpster_excluded
    },
    inputs: {
      layers,
      pitch,
      stories,
      ridge_lf: ridgeLf,
      eave_lf: eaveLf,
      valley_lf: valleyLf,
      penetrations: pens,
      chimneys,
      skylights
    }
  };
}

const num = (v, d) =>
  (v === null || v === undefined || v === '' || isNaN(Number(v))) ? d : Number(v);

const round2 = (n) => Math.round(n * 100) / 100;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const money = (n) =>
  '$' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });

function estimateConfidence(est) {
  let score = 0;

  if (est.squares) score++;
  if (est.inputs.pitch) score++;
  if (est.inputs.stories) score++;
  if (est.inputs.layers !== undefined) score++;
  if (est.inputs.chimneys) score++;
  if (est.inputs.penetrations) score++;
  if (est.inputs.ridge_lf) score++;
  if (est.inputs.eave_lf) score++;

  if (score >= 4) return 'High';
  if (score >= 3) return 'Medium';
  return 'Low';
}

function estimateRange(price, confidence) {
  let variance = 0.15;
  if (confidence === 'High') variance = 0.06;
  if (confidence === 'Medium') variance = 0.10;

  return {
    low: roundToNearestHundred(price * (1 - variance)),
    high: roundToNearestHundred(price * (1 + variance))
  };
}

function roundToNearestHundred(n) {
  return Math.round(Number(n) / 100) * 100;
}

function formatRoofingReply(est) {
  if (est.error === 'NO_SQUARES') {
    return 'I need the roof size before I can build an estimate. Send something like: 32 sq, 8/12 pitch, 2 story, 1 layer tear off.';
  }

  const confidence = estimateConfidence(est);
  const range = estimateRange(est.price, confidence);
  const factors = getEstimateFactors(est);
  const notes = getEstimateNotes(est);
  const summary = getJobSummary(est);
  const lines = [];

  lines.push(`Based on ${summary}, I would expect this roof to land around ${money(range.low)} - ${money(range.high)}.`);
  lines.push('');
  lines.push(`Confidence: ${confidence}`);
  lines.push('');
  lines.push('What is affecting this estimate:');
  factors.forEach(factor => lines.push(`- ${factor}`));
  lines.push('');
  lines.push(`Working price: ${money(est.price)}`);
  lines.push('');
  lines.push('Not included: deck replacement, structural repairs, gutters, or insurance supplements.');

  if (notes.length) {
    lines.push('');
    notes.forEach(note => lines.push(note));
  }

  if (est.flags.below_minimum) {
    lines.push('');
    lines.push('Minimum job pricing was applied.');
  }

  lines.push('');
  lines.push('Reply with a change like "make it 35 sq", "6/12 pitch", "2 chimneys", or "2 story" and I will rerun it.');

  return lines.join('\n');
}

function getJobSummary(est) {
  const parts = [];
  parts.push(`${est.squares} squares`);
  parts.push(`${est.inputs.pitch}/12 pitch`);
  parts.push(`${est.inputs.stories} story${est.inputs.stories === 1 ? '' : ' structure'}`);
  parts.push(`${est.inputs.layers} tear-off layer${est.inputs.layers === 1 ? '' : 's'}`);
  parts.push(est.shingle);
  return parts.filter(Boolean).join(', ');
}

function getEstimateFactors(est) {
  const factors = [];

  if (est.flags.steep) {
    factors.push(`${est.inputs.pitch}/12 pitch increases labor and safety requirements`);
  } else {
    factors.push(`${est.inputs.pitch}/12 pitch is treated as standard pitch`);
  }

  if (est.flags.two_story) {
    factors.push('Two-story access adds production time');
  } else {
    factors.push('One-story access assumed');
  }

  if (est.inputs.layers > 0) {
    factors.push(`${est.inputs.layers} tear-off layer${est.inputs.layers === 1 ? '' : 's'} plus disposal`);
  } else {
    factors.push('Overlay/no tear-off selected');
  }

  factors.push(`${est.shingle} material selection`);

  if (est.inputs.chimneys) {
    factors.push(`${est.inputs.chimneys} chimney flashing item${est.inputs.chimneys === 1 ? '' : 's'}`);
  }

  if (est.inputs.penetrations) {
    factors.push(`${est.inputs.penetrations} roof penetration item${est.inputs.penetrations === 1 ? '' : 's'}`);
  }

  if (est.inputs.ridge_lf) {
    factors.push(`${est.inputs.ridge_lf} LF of ridge`);
  }

  if (est.inputs.eave_lf) {
    factors.push(`${est.inputs.eave_lf} LF of eave/drip edge`);
  }

  if (est.inputs.valley_lf) {
    factors.push(`${est.inputs.valley_lf} LF of valley`);
  }

  if (est.inputs.skylights) {
    factors.push(`${est.inputs.skylights} skylight flashing item${est.inputs.skylights === 1 ? '' : 's'}`);
  }

  return factors;
}

function getEstimateNotes(est) {
  const notes = [];

  if (!est.inputs.chimneys && !est.inputs.penetrations && !est.inputs.ridge_lf && !est.inputs.eave_lf && !est.inputs.valley_lf && !est.inputs.skylights) {
    notes.push('If the roof has several penetrations, chimneys, valleys, or unusual flashing, the final number may move.');
  }

  notes.push('Decking should be quoted separately as a per-sheet adder if bad wood is found after tear-off.');

  return notes;
}

module.exports = {
  calculateRoofEstimate,
  formatRoofingReply,
  money
};
