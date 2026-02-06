/**
 * Bounty Validation Utilities
 *
 * Validates that bounty evaluation packages are properly formatted
 * for the Verdikta oracle network to process.
 */

const logger = require('./logger');

// ZIP file magic bytes: PK\x03\x04
const ZIP_MAGIC = Buffer.from([0x50, 0x4B, 0x03, 0x04]);

/**
 * Issue severity levels
 */
const IssueSeverity = {
  ERROR: 'error',     // Bounty will not work - oracles cannot process
  WARNING: 'warning', // May cause problems
  INFO: 'info'        // Informational only
};

/**
 * Known issue types
 */
const IssueType = {
  INVALID_FORMAT: 'INVALID_FORMAT',           // Not a ZIP file
  CID_INACCESSIBLE: 'CID_INACCESSIBLE',       // Cannot fetch from IPFS
  MISSING_RUBRIC: 'MISSING_RUBRIC',           // No rubric.json in ZIP
  INVALID_RUBRIC: 'INVALID_RUBRIC',           // Rubric JSON is malformed
  MISSING_JURY: 'MISSING_JURY',               // No jury configuration
  INVALID_CLASS: 'INVALID_CLASS',             // Class ID not found/inactive
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE'      // Jury model not in class
};

/**
 * Check if content is a ZIP file by examining magic bytes
 * @param {Buffer} content - Content to check
 * @returns {boolean}
 */
function isZipFile(content) {
  if (!content || content.length < 4) return false;
  return content.slice(0, 4).equals(ZIP_MAGIC);
}

/**
 * Validate a bounty's evaluation package
 * @param {object} options
 * @param {string} options.evaluationCid - IPFS CID of evaluation package
 * @param {number} options.classId - Verdikta class ID
 * @param {object} options.ipfsClient - IPFS client instance
 * @param {object} [options.classMap] - Optional class map for model validation
 * @returns {Promise<{valid: boolean, issues: Array<{type: string, severity: string, message: string}>}>}
 */
async function validateBounty({ evaluationCid, classId, ipfsClient, classMap }) {
  const issues = [];

  if (!evaluationCid) {
    issues.push({
      type: IssueType.CID_INACCESSIBLE,
      severity: IssueSeverity.ERROR,
      message: 'No evaluation CID provided'
    });
    return { valid: false, issues };
  }

  // Step 1: Try to fetch the evaluation package from IPFS
  let content;
  try {
    // IPFSClient uses fetchFromIPFS method
    content = await ipfsClient.fetchFromIPFS(evaluationCid);
  } catch (err) {
    issues.push({
      type: IssueType.CID_INACCESSIBLE,
      severity: IssueSeverity.ERROR,
      message: `Cannot fetch evaluation package from IPFS: ${err.message}`
    });
    return { valid: false, issues };
  }

  // Step 2: Check if it's a ZIP file
  const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

  if (!isZipFile(contentBuffer)) {
    // Check if it looks like JSON (common mistake)
    const firstChar = String.fromCharCode(contentBuffer[0]);
    if (firstChar === '{' || firstChar === '[') {
      issues.push({
        type: IssueType.INVALID_FORMAT,
        severity: IssueSeverity.ERROR,
        message: 'Evaluation package is plain JSON, not a ZIP archive. Oracles cannot process this format.'
      });
    } else {
      issues.push({
        type: IssueType.INVALID_FORMAT,
        severity: IssueSeverity.ERROR,
        message: 'Evaluation package is not a valid ZIP archive. Expected ZIP file with rubric.json inside.'
      });
    }
    return { valid: false, issues };
  }

  // Step 3: Try to extract and validate rubric from ZIP
  let rubric;
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(contentBuffer);
    const entries = zip.getEntries();

    // Look for rubric.json or primary_query.json
    let rubricEntry = entries.find(e =>
      e.entryName === 'rubric.json' ||
      e.entryName === 'primary_query.json' ||
      e.entryName.endsWith('/rubric.json') ||
      e.entryName.endsWith('/primary_query.json')
    );

    if (!rubricEntry) {
      // Also check manifest.json for rubric location
      const manifestEntry = entries.find(e =>
        e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json')
      );

      if (!manifestEntry) {
        issues.push({
          type: IssueType.MISSING_RUBRIC,
          severity: IssueSeverity.ERROR,
          message: 'ZIP archive does not contain rubric.json, primary_query.json, or manifest.json'
        });
        return { valid: false, issues };
      }
    }

    if (rubricEntry) {
      const rubricContent = zip.readAsText(rubricEntry);
      rubric = JSON.parse(rubricContent);
    }
  } catch (err) {
    issues.push({
      type: IssueType.INVALID_RUBRIC,
      severity: IssueSeverity.ERROR,
      message: `Failed to parse rubric from ZIP: ${err.message}`
    });
    return { valid: false, issues };
  }

  // Step 4: Validate rubric structure
  if (rubric) {
    // Check for jury configuration
    if (!rubric.jury || !Array.isArray(rubric.jury) || rubric.jury.length === 0) {
      issues.push({
        type: IssueType.MISSING_JURY,
        severity: IssueSeverity.WARNING,
        message: 'Rubric does not specify a jury configuration. Default jury will be used.'
      });
    }

    // Check for criteria
    if (!rubric.criteria || !Array.isArray(rubric.criteria) || rubric.criteria.length === 0) {
      issues.push({
        type: IssueType.INVALID_RUBRIC,
        severity: IssueSeverity.ERROR,
        message: 'Rubric does not contain evaluation criteria'
      });
    }

    // Validate jury models against class (if classMap provided)
    if (classMap && rubric.jury && Array.isArray(rubric.jury)) {
      try {
        const classInfo = classMap.getClass(classId);
        if (!classInfo) {
          issues.push({
            type: IssueType.INVALID_CLASS,
            severity: IssueSeverity.WARNING,
            message: `Class ${classId} not found in class map`
          });
        } else if (classInfo.status !== 'ACTIVE') {
          issues.push({
            type: IssueType.INVALID_CLASS,
            severity: IssueSeverity.WARNING,
            message: `Class ${classId} is not active (status: ${classInfo.status})`
          });
        } else if (classInfo.models && Array.isArray(classInfo.models)) {
          // Check each jury model
          const availableModels = classInfo.models.map(m => `${m.provider}/${m.model}`);
          for (const juryNode of rubric.jury) {
            const modelKey = `${juryNode.provider}/${juryNode.model}`;
            if (!availableModels.includes(modelKey)) {
              issues.push({
                type: IssueType.MODEL_UNAVAILABLE,
                severity: IssueSeverity.WARNING,
                message: `Jury model ${modelKey} may not be available in class ${classId}`
              });
            }
          }
        }
      } catch (err) {
        // Class validation is optional, don't fail on error
        logger.warn('Could not validate class:', err.message);
      }
    }
  }

  const hasErrors = issues.some(i => i.severity === IssueSeverity.ERROR);

  return {
    valid: !hasErrors,
    issues
  };
}

/**
 * Quick format check without full IPFS fetch
 * Uses cached content if available
 * @param {Buffer|string} content - Content to check
 * @returns {{isZip: boolean, isJson: boolean, firstBytes: string}}
 */
function quickFormatCheck(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const isZip = isZipFile(buffer);
  const firstChar = buffer.length > 0 ? String.fromCharCode(buffer[0]) : '';
  const isJson = firstChar === '{' || firstChar === '[';

  return {
    isZip,
    isJson,
    firstBytes: buffer.slice(0, 4).toString('hex')
  };
}

module.exports = {
  validateBounty,
  quickFormatCheck,
  isZipFile,
  IssueSeverity,
  IssueType
};
