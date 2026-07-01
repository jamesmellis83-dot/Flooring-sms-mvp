// ProStall Flooring estimator
const cfg = require('./configStore');
const round = n => Math.round(n);
const ceil  = n => Math.ceil(n);

function estimate({ sqft, type, job = 'install', addOns = {} }) {
  const pricing = cfg.pricing();
  const key = (type || '').toLowerCase();
  const mat = pricing.materials[key] || pricing.materials[pricing.defaults.fallbackMaterialType];
  const wasteMult = 1 + (pricing.fees.wastePercent / 100);
  const lineItems = [];
  const demoOnly = (job === 'demo');

  // 1. Material (skip if demo-only)
  const materialCost = demoOnly ? 0 : sqft * mat.materialPerSqft * wasteMult;
  if (!demoOnly) {
    lineItems.push({
      label: `${mat.label} material (${sqft} sqft × $${mat.materialPerSqft.toFixed(2)}/sqft + ${pricing.fees.wastePercent}% waste)`,
      amount: round(materialCost),
    });
  }

  // 2. Labor
  let laborCost = 0, laborLabel = '';
  if (job === 'install') {
    laborCost = sqft * mat.laborInstallPerSqft;
    laborLabel = `${mat.label} install labor (${sqft} sqft × $${mat.laborInstallPerSqft.toFixed(2)})`;
  } else if (job === 'demo') {
    if (mat.demoFlatRate > 0) {
      laborCost = mat.demoFlatRate;
      laborLabel = `${mat.label} demo (flat rate)`;
    } else {
      laborCost = sqft * mat.laborDemoPerSqft;
      laborLabel = `${mat.label} demo (${sqft} sqft × $${mat.laborDemoPerSqft.toFixed(2)})`;
    }
  } else if (job === 'demoAndInstall') {
    const installPart = sqft * mat.laborInstallPerSqft;
    let demoPart;
    if (mat.demoFlatRate > 0) {
      demoPart = mat.demoFlatRate;
      laborLabel = `${mat.label} install + flat $${mat.demoFlatRate} demo`;
    } else {
      demoPart = sqft * mat.laborDemoPerSqft;
      laborLabel = `${mat.label} install + demo (${sqft} sqft × $${(mat.laborInstallPerSqft + mat.laborDemoPerSqft).toFixed(2)})`;
    }
    laborCost = installPart + demoPart;
  } else {
    laborCost = sqft * mat.laborInstallPerSqft;
    laborLabel = `${mat.label} labor`;
  }
  lineItems.push({ label: laborLabel, amount: round(laborCost) });

  // 3. Consumables
  let consumablesCost = 0;
  if (!demoOnly) {
    for (const [cKey, c] of Object.entries(pricing.consumables || {})) {
      if (!c.appliesTo?.includes(key)) continue;
      if (cKey === 'thinset' && !mat.requiresThinset) continue;
      if (cKey === 'grout' && !mat.requiresGrout) continue;
      const bags = ceil(sqft / c.sqftPerBag);
      const cost = bags * c.pricePerBag;
      consumablesCost += cost;
      lineItems.push({
        label: `${c.label} (${bags} bag${bags>1?'s':''} × $${c.pricePerBag.toFixed(2)})`,
        amount: round(cost),
      });
    }
  }

  // 4. Add-ons
  let addOnsCost = 0;
  if (addOns.stairs && Number(addOns.stairs) > 0) {
    const v = Number(addOns.stairs) * pricing.addOns.stairsPerStep;
    addOnsCost += v;
    lineItems.push({ label: `Stairs (${addOns.stairs} × $${pricing.addOns.stairsPerStep.toFixed(2)})`, amount: round(v) });
  }
  if (addOns.subfloorPrep) {
    const v = sqft * pricing.addOns.subfloorPrepPerSqft;
    addOnsCost += v;
    lineItems.push({ label: 'Subfloor prep', amount: round(v) });
  }
  if (addOns.pattern) {
    const v = sqft * pricing.addOns.patternUpcharge;
    addOnsCost += v;
    lineItems.push({ label: 'Pattern layout upcharge', amount: round(v) });
  }
  if (addOns.diagonal) {
    const v = sqft * pricing.addOns.diagonalLayoutUpcharge;
    addOnsCost += v;
    lineItems.push({ label: 'Diagonal layout upcharge', amount: round(v) });
  }

  // 5. Trip fee
  const tripFee = pricing.defaults.includeTripFeeAutomatically ? pricing.fees.tripFee : 0;
  if (tripFee > 0) lineItems.push({ label: 'Trip fee', amount: round(tripFee) });

  // 6. Subtotal + tax
  let subtotal = materialCost + laborCost + consumablesCost + addOnsCost + tripFee;
  let tax = 0;
  if (pricing.defaults.includeTaxInEstimate) {
    tax = subtotal * (pricing.fees.salesTaxPercent / 100);
    lineItems.push({ label: `Sales tax (${pricing.fees.salesTaxPercent}%)`, amount: round(tax) });
  }
  let total = subtotal + tax;
  if (total < pricing.fees.minimumJobCharge) total = pricing.fees.minimumJobCharge;

  const rangePct = pricing.fees.estimateRangePercent || 0;
  const low = round(total);
  const high = round(total * (1 + rangePct / 100));

  return {
    low, high,
    materials: round(materialCost),
    labor: round(laborCost),
    consumables: round(consumablesCost),
    addOnsTotal: round(addOnsCost),
    tripFee: round(tripFee),
    subtotal: round(subtotal),
    tax: round(tax),
    typeLabel: mat.label,
    contractorName: pricing.contractorName,
    lineItems,
    breakdownText: lineItems.map(li => `  ${li.label}: $${li.amount.toLocaleString()}`).join('\n'),
  };
}

module.exports = { estimate };
