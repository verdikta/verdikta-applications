// Weight-only UI feedback; full rubric validation remains server-authoritative.
// Same rule as the server: scored (non-must) weights sum to 1; a rubric of only
// must-pass criteria has nothing to sum.
export function rubricWeights(criteria = []) {
  const scored = criteria.filter(c => !c.must);
  const totalWeight = scored.reduce((sum, c) => sum + c.weight, 0);
  const valid = criteria.every(c => typeof c.weight === 'number' && Number.isFinite(c.weight) &&
    c.weight >= 0 && c.weight <= 1 && (!c.must || c.weight === 0)) &&
    (scored.length === 0 || Math.abs(totalWeight - 1) <= 0.001);
  return { valid, totalWeight, message: valid ? 'Valid' : 'Must-pass weights must be 0; scored weights must sum to 1 (tolerance 0.001).' };
}
