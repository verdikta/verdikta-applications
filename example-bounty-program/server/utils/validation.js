/**
 * Validation utilities for bounty program
 */

const CID_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58}|B[A-Z2-7]{58}|z[1-9A-HJ-NP-Za-km-z]{48}|F[0-9A-F]{50}$/i;

const ALLOWED_FILE_TYPES = [
  'text/plain',
  'text/markdown',
  'image/jpeg',
  'image/png',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' // .docx
];

const ALLOWED_EXTENSIONS = ['.txt', '.md', '.jpg', '.jpeg', '.png', '.pdf', '.docx'];

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

/**
 * Validate IPFS CID format
 * @param {string} cid - CID to validate
 * @returns {boolean} - Whether CID is valid
 */
function isValidCid(cid) {
  if (!cid || typeof cid !== 'string') return false;
  return CID_REGEX.test(cid.trim());
}

/**
 * Validate file type
 * @param {string} mimeType - File MIME type
 * @param {string} filename - File name
 * @returns {boolean} - Whether file type is allowed
 */
function isValidFileType(mimeType, filename) {
  const extension = filename.toLowerCase().split('.').pop();
  return ALLOWED_FILE_TYPES.includes(mimeType) || 
         ALLOWED_EXTENSIONS.includes(`.${extension}`);
}

/**
 * Validate file size
 * @param {number} size - File size in bytes
 * @returns {boolean} - Whether file size is within limit
 */
function isValidFileSize(size) {
  return size > 0 && size <= MAX_FILE_SIZE;
}

/**
 * Validate rubric JSON structure
 * @param {object} rubric - Rubric object to validate
 * @returns {{ valid: boolean, errors: string[] }} - Validation result
 */
function validateRubric(rubric) {
  const errors = [];

  // Check required fields
  if (!rubric.threshold || typeof rubric.threshold !== 'number') {
    errors.push('Missing or invalid threshold (must be number 0-100)');
  } else if (rubric.threshold < 0 || rubric.threshold > 100) {
    errors.push('Threshold must be between 0 and 100');
  }

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

    rubric.criteria.forEach((criterion, index) => {
      if (!criterion.id || typeof criterion.id !== 'string') {
        errors.push(`Criterion ${index}: Missing or invalid id`);
      } else {
        if (ids.has(criterion.id)) {
          errors.push(`Criterion ${index}: Duplicate id '${criterion.id}'`);
        }
        ids.add(criterion.id);
      }

      if (typeof criterion.must !== 'boolean') {
        errors.push(`Criterion ${index}: Missing or invalid 'must' field (must be boolean)`);
      }

      if (typeof criterion.weight !== 'number') {
        errors.push(`Criterion ${index}: Missing or invalid weight (must be number)`);
      } else if (criterion.weight < 0 || criterion.weight > 1) {
        errors.push(`Criterion ${index}: Weight must be between 0 and 1`);
      } else {
        totalWeight += criterion.weight;
      }

      if (!criterion.description || typeof criterion.description !== 'string') {
        errors.push(`Criterion ${index}: Missing or invalid description`);
      }
    });

    // Check that weights sum to approximately 1.0 (allow small floating point errors)
    if (Math.abs(totalWeight - 1.0) > 0.01 && totalWeight !== 0) {
      errors.push(`Total weight of criteria must sum to 1.0 (current: ${totalWeight.toFixed(2)})`);
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

/**
 * Validate Ethereum address format
 * @param {string} address - Address to validate
 * @returns {boolean} - Whether address is valid
 */
function isValidAddress(address) {
  if (!address || typeof address !== 'string') return false;
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

module.exports = {
  isValidCid,
  isValidFileType,
  isValidFileSize,
  validateRubric,
  isValidAddress,
  MAX_FILE_SIZE,
  ALLOWED_FILE_TYPES,
  ALLOWED_EXTENSIONS
};

