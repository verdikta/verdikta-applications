/**
 * Validation utilities for bounty program
 */

const CID_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58}|B[A-Z2-7]{58}|z[1-9A-HJ-NP-Za-km-z]{48}|F[0-9A-F]{50}$/i;

const ALLOWED_FILE_TYPES = [
  'text/plain',
  'text/markdown',
  'image/jpeg',
  'image/png',
  'image/bmp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  // Code/text file MIME types
  'text/x-python',
  'text/javascript',
  'application/javascript',
  'application/json',
  'text/html',
  'text/css',
  'application/xml',
  'text/xml',
  'application/x-sh',
  'application/sql',
  'text/x-c',
  'text/x-c++',
  'text/x-java',
  'text/x-go',
  'text/x-rust',
  'text/x-ruby',
  'text/x-php',
  'text/csv',
  'application/octet-stream' // Many code files use this generic type
];

const ALLOWED_EXTENSIONS = [
  // Documents
  '.txt', '.md', '.pdf', '.docx',
  // Images
  '.jpg', '.jpeg', '.png', '.bmp',
  // Programming languages
  '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.go', '.rs', '.php', '.swift', '.kt', '.sol', '.r', '.m',
  // Web
  '.html', '.css', '.scss', '.sass',
  // Data/Config
  '.json', '.xml', '.yaml', '.yml', '.toml', '.csv',
  // Shell
  '.sh', '.bat', '.ps1',
  // Other
  '.sql'
];

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
 * Note: Threshold is NOT validated here as it's stored separately
 * for smart contract use, not sent to AI nodes
 * @param {object} rubric - Rubric object to validate
 * @returns {{ valid: boolean, errors: string[] }} - Validation result
 */
function validateRubric(rubric) {
  const errors = [];

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
    rubric.criteria.forEach((criterion, index) => {
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

      if (typeof criterion.weight !== 'number') {
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

    // Check that scored criteria weights sum to approximately 1.0 (allow small floating point errors)
    if (Math.abs(totalWeight - 1.0) > 0.001 && totalWeight !== 0) {
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

/**
 * Validate Ethereum address format
 * @param {string} address - Address to validate
 * @returns {boolean} - Whether address is valid
 */
function isValidAddress(address) {
  if (!address || typeof address !== 'string') return false;
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate jury configuration
 * @param {Array} juryNodes - Array of jury node configurations
 * @returns {{ valid: boolean, errors: string[] }} - Validation result
 */
function validateJuryNodes(juryNodes) {
  const errors = [];

  if (!Array.isArray(juryNodes)) {
    errors.push('Jury nodes must be an array');
    return { valid: false, errors };
  }

  if (juryNodes.length === 0) {
    errors.push('At least one jury node is required');
    return { valid: false, errors };
  }

  // Validate each jury node
  let totalWeight = 0;

  juryNodes.forEach((node, index) => {
    if (!node.provider || typeof node.provider !== 'string') {
      errors.push(`Jury node ${index}: Missing or invalid provider`);
    }

    if (!node.model || typeof node.model !== 'string') {
      errors.push(`Jury node ${index}: Missing or invalid model`);
    }

    if (typeof node.runs !== 'number' || node.runs < 1) {
      errors.push(`Jury node ${index}: Runs must be a number >= 1`);
    }

    if (typeof node.weight !== 'number') {
      errors.push(`Jury node ${index}: Missing or invalid weight (must be number)`);
    } else if (node.weight < 0 || node.weight > 1) {
      errors.push(`Jury node ${index}: Weight must be between 0 and 1`);
    } else {
      totalWeight += node.weight;
    }
  });

  // Check that weights sum to approximately 1.0 (allow small floating point errors)
  if (Math.abs(totalWeight - 1.0) > 0.01) {
    errors.push(`Total weight of jury nodes must sum to 1.0 (current: ${totalWeight.toFixed(2)})`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// --- Oracle-readability guards ---------------------------------------------
// The Verdikta oracle pipeline silently SKIPS archive/binary attachments it can't
// read: the models see no content, a must-pass-override kicks in, and the score is
// 0 — with NO error at upload time. Detect these up front so a hunter never burns
// the ETH prepay on a submission that can't actually be evaluated.
//
// Note: application/octet-stream is an allowed mimetype (many code files arrive
// with it), which is exactly why a .zip can slip past isValidFileType — these
// checks are extension/mimetype/magic-byte based and do not rely on octet-stream.
const ORACLE_UNREADABLE_EXTENSIONS = [
  '.zip', '.tar', '.gz', '.tgz', '.tbz2', '.bz2', '.7z', '.rar', '.xz', '.zst', '.lz', '.lzma',
  '.jar', '.war', '.apk', '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.iso', '.dmg', '.class', '.wasm', '.pyc'
];
const ORACLE_UNREADABLE_MIMETYPES = [
  'application/zip', 'application/x-zip-compressed', 'application/x-tar',
  'application/gzip', 'application/x-gzip', 'application/x-7z-compressed',
  'application/x-rar-compressed', 'application/vnd.rar', 'application/x-bzip2',
  'application/x-xz', 'application/java-archive', 'application/x-msdownload',
  'application/wasm', 'application/x-iso9660-image'
];
// OOXML documents (.docx) are ZIP-based but ARE oracle-readable, so they must be
// exempt from magic-byte ZIP detection.
const ALLOWED_ZIP_BASED_EXTENSIONS = ['.docx'];

/**
 * Detect an archive/binary container from its leading bytes. Catches files whose
 * extension or mimetype was renamed/generic (e.g. a .zip sent as octet-stream, or
 * renamed to .txt). Callers must exempt ALLOWED_ZIP_BASED_EXTENSIONS for ZIP hits.
 * @param {Buffer} buffer - the first bytes of the file (>= 8 recommended)
 * @returns {string|null} - human label of the detected container, or null
 */
function detectBinaryContainer(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const b = buffer;
  if (b[0] === 0x50 && b[1] === 0x4B && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'ZIP archive'; // PK..
  if (b[0] === 0x1F && b[1] === 0x8B) return 'gzip archive';
  if (b[0] === 0x37 && b[1] === 0x7A && b[2] === 0xBC && b[3] === 0xAF) return '7z archive';
  if (b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21) return 'RAR archive';
  if (b[0] === 0x42 && b[1] === 0x5A && b[2] === 0x68) return 'bzip2 archive';
  if (b.length >= 6 && b[0] === 0xFD && b[1] === 0x37 && b[2] === 0x7A && b[3] === 0x58 && b[4] === 0x5A && b[5] === 0x00) return 'xz archive';
  if (b[0] === 0x7F && b[1] === 0x45 && b[2] === 0x4C && b[3] === 0x46) return 'ELF binary';
  if (b[0] === 0x4D && b[1] === 0x5A) return 'Windows executable'; // MZ
  return null;
}

/**
 * Reason string if this attachment would be skipped by the oracle (archive/binary),
 * based on extension + mimetype. Returns null if it looks evaluable.
 * @param {string} mimeType
 * @param {string} filename
 * @returns {string|null}
 */
function oracleUnreadableReason(mimeType, filename) {
  const ext = '.' + (filename || '').toLowerCase().split('.').pop();
  if (ORACLE_UNREADABLE_EXTENSIONS.includes(ext)) {
    return `${filename} is a ${ext.slice(1).toUpperCase()} archive/binary — the oracle skips it and evaluates no content (score 0)`;
  }
  if (ORACLE_UNREADABLE_MIMETYPES.includes((mimeType || '').toLowerCase())) {
    return `${filename} has archive/binary type "${mimeType}" — the oracle skips it and evaluates no content (score 0)`;
  }
  return null;
}

module.exports = {
  isValidCid,
  isValidFileType,
  isValidFileSize,
  validateRubric,
  validateJuryNodes,
  isValidAddress,
  MAX_FILE_SIZE,
  ALLOWED_FILE_TYPES,
  ALLOWED_EXTENSIONS,
  ORACLE_UNREADABLE_EXTENSIONS,
  ALLOWED_ZIP_BASED_EXTENSIONS,
  detectBinaryContainer,
  oracleUnreadableReason
};



