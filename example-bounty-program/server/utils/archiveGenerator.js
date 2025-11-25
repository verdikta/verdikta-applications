/**
 * Archive Generator Utility
 * Creates Verdikta-compatible archive structures for Primary CID and Hunter Submission CID
 */

const fs = require('fs').promises;
const path = require('path');
const AdmZip = require('adm-zip');
const logger = require('./logger');

/**
 * Create Evaluation CID archive structure (also known as "Primary CID")
 * This archive contains: manifest.json + primary_query.json
 * 
 * The manifest references:
 * - The rubric CID (via `additional` array with type: "ipfs/cid")
 * - A description of the expected bCID (hunter's work) via `bCIDs` field
 * 
 * IMPORTANT: The `bCIDs` field contains DESCRIPTIONS of expected bCIDs, not the CIDs themselves.
 * The actual hunter CID is passed separately to the Verdikta contract as a second parameter.
 * 
 * @param {Object} options
 * @param {string} options.rubricCid - IPFS CID of the rubric
 * @param {string} options.jobTitle - Title of the job/bounty
 * @param {string} options.jobDescription - Description of the work required
 * @param {string} options.workProductType - Type of work (e.g., "Blog Post", "Code", "Design")
 * @param {number} options.classId - Verdikta class ID (default: 128)
 * @param {Array} options.juryNodes - AI jury configuration
 * @param {number} options.iterations - Number of iterations (default: 1)
 * @returns {Promise<{archivePath: string, manifest: Object, primaryQuery: Object}>}
 */
async function createEvaluationCIDArchive(options) {
  const {
    rubricCid,
    jobTitle,
    jobDescription,
    workProductType = 'Work Product',
    classId = 128,
    juryNodes = [],
    iterations = 1
  } = options;

  try {
    logger.info('Creating Evaluation CID archive', { rubricCid, jobTitle });

    // Create temporary directory for archive files
    const tmpDir = path.join(__dirname, '../tmp');
    const archiveName = `evaluation-${Date.now()}`;
    const archiveDir = path.join(tmpDir, archiveName);
    
    await fs.mkdir(archiveDir, { recursive: true });

    // Create manifest.json
    // NOTE: bCIDs contains DESCRIPTIONS of what each bCID represents.
    // The actual bCID values (e.g., hunter's work archive CID) are passed 
    // separately to the Verdikta contract as additional CIDs in the array.
    const manifest = {
      version: '1.0',
      name: `${jobTitle} - Evaluation for Payment Release`,
      primary: {
        filename: 'primary_query.json'
      },
      juryParameters: {
        NUMBER_OF_OUTCOMES: 2,
        AI_NODES: juryNodes.map(node => ({
          AI_MODEL: node.model,
          AI_PROVIDER: node.provider,
          NO_COUNTS: node.runs,
          WEIGHT: node.weight
        })),
        ITERATIONS: iterations
      },
      additional: [
        {
          name: 'gradingRubric',
          type: 'ipfs/cid',
          hash: rubricCid,
          description: `${workProductType} grading rubric with evaluation criteria`
        }
      ],
      // bCIDs: Descriptions of expected bCID archives that will be passed separately
      // The external adapter uses these descriptions to understand what each bCID contains
      bCIDs: {
        submittedWork: 'The work submitted by a hunter.'
      }
    };

    // Create primary_query.json
    const primaryQuery = {
      query: `WORK PRODUCT EVALUATION REQUEST

You are evaluating a work product submission to determine whether it meets the required quality standards for payment release from escrow.

=== TASK DESCRIPTION ===
Work Product Type: ${workProductType}
Task Title: ${jobTitle}
Task Description: ${jobDescription}

=== EVALUATION INSTRUCTIONS ===
A detailed grading rubric is provided as an attachment (gradingRubric). You must thoroughly evaluate the submitted work product against ALL criteria specified in the rubric.

For each evaluation criterion in the rubric:
1. Assess how well the work product meets the requirement
2. Note specific strengths and weaknesses
3. Consider the overall quality and completeness

=== YOUR TASK ===
Evaluate the quality of the submitted work product and provide scores for two outcomes:
- DONT_FUND: The work product does not meet quality standards
- FUND: The work product meets quality standards

Base your scoring on the overall quality assessment from the rubric criteria. Higher quality work should receive higher FUND scores, while lower quality work should receive higher DONT_FUND scores.

In your justification, explain your evaluation of each rubric criterion and how the work product performs against the stated requirements.

The submitted work product will be provided in the next section.`,
      references: ['gradingRubric'],
      outcomes: ['DONT_FUND', 'FUND']
    };

    // Write files to archive directory
    await fs.writeFile(
      path.join(archiveDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );
    await fs.writeFile(
      path.join(archiveDir, 'primary_query.json'),
      JSON.stringify(primaryQuery, null, 2)
    );

    // Create ZIP archive
    const zip = new AdmZip();
    zip.addLocalFile(path.join(archiveDir, 'manifest.json'));
    zip.addLocalFile(path.join(archiveDir, 'primary_query.json'));
    
    const archivePath = path.join(tmpDir, `${archiveName}.zip`);
    zip.writeZip(archivePath);

    logger.info('Evaluation CID archive created successfully', { archivePath });

    // Clean up temporary directory (but keep the ZIP)
    await fs.rm(archiveDir, { recursive: true, force: true });

    return {
      archivePath,
      manifest,
      primaryQuery
    };

  } catch (error) {
    logger.error('Error creating Evaluation CID archive:', error);
    throw new Error(`Failed to create Evaluation CID archive: ${error.message}`);
  }
}

// Backward compatibility alias
const createPrimaryCIDArchive = createEvaluationCIDArchive;

/**
 * Create Hunter Submission CID archive structure
 * This archive contains: manifest.json + primary_query.json + work product file(s)
 * 
 * @param {Object} options
 * @param {Array} options.workProducts - Array of work product files
 * @param {string} options.workProducts[].path - Path to the file
 * @param {string} options.workProducts[].name - Original filename
 * @param {string} options.workProducts[].type - MIME type
 * @param {string} options.workProducts[].description - File description
 * @param {string} options.submissionNarrative - Custom narrative (optional, defaults to standard message)
 * @returns {Promise<{archivePath: string, manifest: Object, primaryQuery: Object}>}
 */
async function createHunterSubmissionCIDArchive(options) {
  const {
    workProducts = [],
    submissionNarrative = 'Thank you for giving me the opportunity to submit this work. You can find it below in the references section.'
  } = options;

  try {
    logger.info('Creating Hunter Submission CID archive', { 
      fileCount: workProducts.length,
      narrativeLength: submissionNarrative.length 
    });

    // Create temporary directory for archive files
    const tmpDir = path.join(__dirname, '../tmp');
    const archiveName = `hunter-submission-${Date.now()}`;
    const archiveDir = path.join(tmpDir, archiveName);
    const submissionDir = path.join(archiveDir, 'submission');
    
    await fs.mkdir(submissionDir, { recursive: true });

    // Build additional array and references
    const additional = [];
    const references = [];

    for (let i = 0; i < workProducts.length; i++) {
      const product = workProducts[i];
      const referenceName = workProducts.length === 1 
        ? 'submitted-work' 
        : `submitted-work-${i + 1}`;
      const submissionFilePath = `submission/${product.name}`;

      additional.push({
        name: referenceName,
        type: product.type,
        filename: submissionFilePath,
        description: product.description || `Work product file: ${product.name}`
      });

      references.push(referenceName);

      // Copy work product to submission directory
      await fs.copyFile(product.path, path.join(submissionDir, product.name));
    }

    // Create manifest.json with descriptions
    const manifest = {
      version: '1.0',
      name: 'submittedWork',
      primary: {
        filename: 'primary_query.json'
      },
      additional
    };

    // Create primary_query.json with custom narrative
    const primaryQuery = {
      query: submissionNarrative,
      references
    };

    // Write manifest and primary query
    await fs.writeFile(
      path.join(archiveDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );
    await fs.writeFile(
      path.join(archiveDir, 'primary_query.json'),
      JSON.stringify(primaryQuery, null, 2)
    );

    // Create ZIP archive
    const zip = new AdmZip();
    zip.addLocalFile(path.join(archiveDir, 'manifest.json'));
    zip.addLocalFile(path.join(archiveDir, 'primary_query.json'));
    zip.addLocalFolder(submissionDir, 'submission');
    
    const archivePath = path.join(tmpDir, `${archiveName}.zip`);
    zip.writeZip(archivePath);

    logger.info('Hunter Submission CID archive created successfully', { 
      archivePath,
      fileCount: workProducts.length 
    });

    // Clean up temporary directory (but keep the ZIP)
    await fs.rm(archiveDir, { recursive: true, force: true });

    return {
      archivePath,
      manifest,
      primaryQuery
    };

  } catch (error) {
    logger.error('Error creating Hunter Submission CID archive:', error);
    throw new Error(`Failed to create Hunter Submission CID archive: ${error.message}`);
  }
}

/**
 * @deprecated This function is no longer needed.
 * The bCIDs field now contains descriptions, not CID values.
 * The actual hunter CID is passed separately to the Verdikta contract.
 * 
 * This function is kept for backward compatibility but should not be used.
 * 
 * @param {string} primaryArchivePath - Path to the primary archive ZIP
 * @param {string} hunterSubmissionCid - IPFS CID of hunter submission
 * @returns {Promise<string>} - Path to updated archive
 */
async function updatePrimaryArchiveWithHunterCID(primaryArchivePath, hunterSubmissionCid) {
  try {
    logger.info('Updating Primary archive with Hunter CID', { hunterSubmissionCid });

    const tmpDir = path.join(__dirname, '../tmp');
    const updateDir = path.join(tmpDir, `update-${Date.now()}`);
    await fs.mkdir(updateDir, { recursive: true });

    // Extract existing archive
    const zip = new AdmZip(primaryArchivePath);
    zip.extractAllTo(updateDir, true);

    // Read and update manifest
    const manifestPath = path.join(updateDir, 'manifest.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);
    
    manifest.bCIDs.submittedWork = hunterSubmissionCid;
    
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    // Create new ZIP with updated manifest
    const newZip = new AdmZip();
    newZip.addLocalFile(path.join(updateDir, 'manifest.json'));
    newZip.addLocalFile(path.join(updateDir, 'primary_query.json'));
    
    const updatedArchivePath = primaryArchivePath.replace('.zip', '-updated.zip');
    newZip.writeZip(updatedArchivePath);

    logger.info('Primary archive updated successfully', { updatedArchivePath });

    // Clean up
    await fs.rm(updateDir, { recursive: true, force: true });

    return updatedArchivePath;

  } catch (error) {
    logger.error('Error updating Primary archive:', error);
    throw new Error(`Failed to update Primary archive: ${error.message}`);
  }
}

module.exports = {
  createEvaluationCIDArchive,
  createPrimaryCIDArchive,  // Backward compatibility alias
  createHunterSubmissionCIDArchive,
  updatePrimaryArchiveWithHunterCID
};

