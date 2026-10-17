// Generated from server/utils/validation.js by sync_contract_assets.js; do not edit.
function validateRubric(rubric) {
  const errors = [];
  if (!rubric || typeof rubric !== "object") return { valid: false, errors: ["Rubric must be an object"] };

  // Note: Threshold is no longer part of the rubric sent to AI nodes
  // It's stored separately and used by the smart contract for pass/fail decisions

  if (!rubric.criteria || !Array.isArray(rubric.criteria)) {
    errors.push('Missing or invalid criteria array');
  } else {
    if (rubric.criteria.length === 0) {
      errors.push('Criteria array must have at least one criterion');
    }
    if (rubric.criteria.length > 10) {
      errors.push('Criteria array can have at most 10 criteria');
    }

    // Validate each criterion
    let totalWeight = 0;
    const ids = new Set();
    const hasScored = rubric.criteria.some(c => c && typeof c === 'object' && !c.must);
    rubric.criteria.forEach((criterion, index) => {
      if (!criterion || typeof criterion !== "object") { errors.push(`Criterion ${index}: invalid object`); return; }
      const cLabel = criterion.label || criterion.id || 'unknown';
      const cPrefix = `Criterion ${index} ("${cLabel}")`;

      if (!criterion.id || typeof criterion.id !== 'string') {
        errors.push(`${cPrefix}: Missing or invalid id`);
      } else {
        if (ids.has(criterion.id)) {
          errors.push(`${cPrefix}: Duplicate id '${criterion.id}'`);
        }
        ids.add(criterion.id);
      }

      if (typeof criterion.must !== 'boolean') {
        errors.push(`${cPrefix}: Missing or invalid 'must' field (must be boolean)`);
      }

      if (typeof criterion.weight !== 'number' || !Number.isFinite(criterion.weight)) {
        errors.push(`${cPrefix}: Missing or invalid weight (must be number)`);
      } else if (criterion.weight < 0 || criterion.weight > 1) {
        errors.push(`${cPrefix}: Weight must be between 0 and 1`);
      } else {
        if (criterion.must === true && criterion.weight !== 0) {
          errors.push(`${cPrefix}: Must-pass criteria must have weight 0 (got ${criterion.weight})`);
        }
        if (!criterion.must) {
          totalWeight += criterion.weight;
        }
      }

      if (!criterion.description || typeof criterion.description !== 'string') {
        errors.push(`${cPrefix}: Missing or invalid description`);
      }
    });

    // Scored criteria weights must sum to approximately 1.0 (allow small floating
    // point errors). A rubric of only must-pass criteria has nothing to sum.
    // Same rule as bountyValidator, so a bounty accepted here is not gated later.
    if (hasScored && Math.abs(totalWeight - 1.0) > 0.001) {
      errors.push(`Rubric: Scored criteria weights must sum to 1.0 (got ${totalWeight.toFixed(3)})`);
    }
  }

  // Optional fields validation
  if (rubric.forbidden_content && !Array.isArray(rubric.forbidden_content)) {
    errors.push('forbidden_content must be an array');
  }

  if (rubric.license_template && typeof rubric.license_template !== 'string') {
    errors.push('license_template must be a string');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
module.exports = { validateRubric };
