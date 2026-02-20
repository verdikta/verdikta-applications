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
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',     // Jury model not in class
  INVALID_PRIMARY_QUERY: 'INVALID_PRIMARY_QUERY', // primary_query.json has wrong format
  MISSING_BCIDS: 'MISSING_BCIDS',             // manifest.json missing bCIDs
  NOT_ON_CHAIN: 'NOT_ON_CHAIN',               // Bounty does not exist on-chain
  CHAIN_STATUS: 'CHAIN_STATUS'                // On-chain status issue (not open, expired, etc.)
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

  // Step 3: Extract and validate content from ZIP
  let rubric = null;
  let juryNodes = [];
  let manifest = null;

  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(contentBuffer);
    const entries = zip.getEntries();

    // Look for manifest.json first (new Verdikta format)
    const manifestEntry = entries.find(e =>
      e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json')
    );

    if (manifestEntry) {
      try {
        const manifestText = zip.readAsText(manifestEntry);
        manifest = JSON.parse(manifestText);

        // Extract jury configuration from manifest.juryParameters.AI_NODES
        if (manifest.juryParameters?.AI_NODES && Array.isArray(manifest.juryParameters.AI_NODES)) {
          juryNodes = manifest.juryParameters.AI_NODES.map(node => ({
            provider: node.AI_PROVIDER,
            model: node.AI_MODEL,
            runs: node.NO_COUNTS || 1,
            weight: node.WEIGHT || 1
          }));
        }

        // Look for grading rubric reference in manifest.additional
        const gradingRubricRef = manifest.additional?.find(a => a.name === 'gradingRubric');
        if (gradingRubricRef?.hash) {
          // Fetch the grading rubric from IPFS
          try {
            const rubricBuffer = await ipfsClient.fetchFromIPFS(gradingRubricRef.hash);
            const rubricText = rubricBuffer.toString('utf8');
            rubric = JSON.parse(rubricText);
          } catch (err) {
            issues.push({
              type: IssueType.MISSING_RUBRIC,
              severity: IssueSeverity.ERROR,
              message: `Cannot fetch grading rubric from IPFS (${gradingRubricRef.hash}): ${err.message}`
            });
          }
        } else {
          // No gradingRubric reference - check if criteria are embedded elsewhere
          issues.push({
            type: IssueType.MISSING_RUBRIC,
            severity: IssueSeverity.WARNING,
            message: 'Manifest does not reference a grading rubric. Evaluation may use default criteria.'
          });
        }

        // Validate primary_query.json format (critical for oracle processing)
        const primaryFilename = manifest.primary?.filename || 'primary_query.json';
        const primaryEntry = entries.find(e =>
          e.entryName === primaryFilename || e.entryName.endsWith('/' + primaryFilename)
        );

        if (primaryEntry) {
          try {
            const primaryQuery = JSON.parse(zip.readAsText(primaryEntry));

            // Check for WRONG format: {title, description, outcomes}
            // Oracles require: {query, references, outcomes}
            if (primaryQuery.title !== undefined || primaryQuery.description !== undefined) {
              if (!primaryQuery.query) {
                issues.push({
                  type: IssueType.INVALID_PRIMARY_QUERY,
                  severity: IssueSeverity.ERROR,
                  message: 'primary_query.json uses wrong format: found "title"/"description" fields. Oracles require "query", "references", and "outcomes" fields. See Blockchain page for correct format.'
                });
              }
            }

            // Check for required "query" field
            if (!primaryQuery.query || typeof primaryQuery.query !== 'string') {
              if (!issues.some(i => i.type === IssueType.INVALID_PRIMARY_QUERY)) {
                issues.push({
                  type: IssueType.INVALID_PRIMARY_QUERY,
                  severity: IssueSeverity.ERROR,
                  message: 'primary_query.json missing required "query" field (must be a string with evaluation instructions).'
                });
              }
            }

            // Check for required "outcomes" field
            if (!primaryQuery.outcomes || !Array.isArray(primaryQuery.outcomes) || primaryQuery.outcomes.length < 2) {
              issues.push({
                type: IssueType.INVALID_PRIMARY_QUERY,
                severity: IssueSeverity.ERROR,
                message: 'primary_query.json missing or invalid "outcomes" field (must be an array, e.g. ["DONT_FUND", "FUND"]).'
              });
            }

            // Check for "references" field
            if (!primaryQuery.references || !Array.isArray(primaryQuery.references)) {
              issues.push({
                type: IssueType.INVALID_PRIMARY_QUERY,
                severity: IssueSeverity.WARNING,
                message: 'primary_query.json missing "references" field. Oracles may not be able to access the grading rubric.'
              });
            }
          } catch (err) {
            issues.push({
              type: IssueType.INVALID_PRIMARY_QUERY,
              severity: IssueSeverity.ERROR,
              message: `Failed to parse ${primaryFilename}: ${err.message}`
            });
          }
        } else {
          issues.push({
            type: IssueType.INVALID_PRIMARY_QUERY,
            severity: IssueSeverity.ERROR,
            message: `ZIP archive does not contain ${primaryFilename} (referenced in manifest.primary.filename).`
          });
        }

        // Check for bCIDs in manifest
        if (!manifest.bCIDs || typeof manifest.bCIDs !== 'object' || Object.keys(manifest.bCIDs).length === 0) {
          issues.push({
            type: IssueType.MISSING_BCIDS,
            severity: IssueSeverity.WARNING,
            message: 'manifest.json missing "bCIDs" object. Oracles may not be able to access submitted work products.'
          });
        }
      } catch (err) {
        issues.push({
          type: IssueType.INVALID_RUBRIC,
          severity: IssueSeverity.ERROR,
          message: `Failed to parse manifest.json: ${err.message}`
        });
      }
    } else {
      // Fallback: Look for rubric.json directly in ZIP (legacy format)
      const rubricEntry = entries.find(e =>
        e.entryName === 'rubric.json' ||
        e.entryName.endsWith('/rubric.json')
      );

      if (rubricEntry) {
        try {
          const rubricContent = zip.readAsText(rubricEntry);
          rubric = JSON.parse(rubricContent);

          // Legacy format may have jury in rubric
          if (rubric.jury && Array.isArray(rubric.jury)) {
            juryNodes = rubric.jury;
          }
        } catch (err) {
          issues.push({
            type: IssueType.INVALID_RUBRIC,
            severity: IssueSeverity.ERROR,
            message: `Failed to parse rubric.json: ${err.message}`
          });
        }
      } else {
        // No manifest.json and no rubric.json
        issues.push({
          type: IssueType.MISSING_RUBRIC,
          severity: IssueSeverity.ERROR,
          message: 'ZIP archive does not contain manifest.json or rubric.json'
        });
        return { valid: false, issues };
      }
    }
  } catch (err) {
    issues.push({
      type: IssueType.INVALID_RUBRIC,
      severity: IssueSeverity.ERROR,
      message: `Failed to process ZIP archive: ${err.message}`
    });
    return { valid: false, issues };
  }

  // Step 4: Validate jury configuration
  if (juryNodes.length === 0) {
    issues.push({
      type: IssueType.MISSING_JURY,
      severity: IssueSeverity.WARNING,
      message: 'No jury configuration found. Default jury will be used.'
    });
  } else {
    // Validate jury models against class (if classMap provided)
    if (classMap) {
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
          const availableModels = classInfo.models.map(m => `${m.provider}/${m.model}`);
          for (const node of juryNodes) {
            const modelKey = `${node.provider}/${node.model}`;
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
        logger.warn('Could not validate class:', err.message);
      }
    }
  }

  // Step 5: Validate rubric structure
  if (rubric) {
    // Check for criteria
    if (!rubric.criteria || !Array.isArray(rubric.criteria) || rubric.criteria.length === 0) {
      issues.push({
        type: IssueType.INVALID_RUBRIC,
        severity: IssueSeverity.WARNING,
        message: 'Grading rubric does not contain evaluation criteria'
      });
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
