const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const { validateRubric, isValidFileType, isValidFileSize, MAX_FILE_SIZE } = require('../utils/validation');

/**
 * POST /api/bounties
 * Upload rubric to IPFS and return CID for bounty creation
 */
router.post('/', async (req, res) => {
  try {
    const { rubricJson, classId } = req.body;

    // Validate request body
    if (!rubricJson) {
      return res.status(400).json({
        error: 'Missing rubric',
        details: 'Request body must include rubricJson object'
      });
    }

    // Validate rubric structure
    const validation = validateRubric(rubricJson);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid rubric',
        details: 'Rubric validation failed',
        errors: validation.errors
      });
    }

    logger.info('POST /api/bounties called', { 
      criteriaCount: rubricJson.criteria?.length,
      threshold: rubricJson.threshold,
      classId 
    });

    // Add metadata to rubric
    const rubricWithMeta = {
      ...rubricJson,
      version: rubricJson.version || '1.0',
      createdAt: new Date().toISOString(),
      classId: classId || 128
    };

    // Convert rubric to JSON buffer
    const rubricBuffer = Buffer.from(JSON.stringify(rubricWithMeta, null, 2), 'utf-8');
    
    // Create temporary file for IPFS upload
    const path = require('path');
    const fs = require('fs').promises;
    const tmpDir = path.join(__dirname, '../tmp');
    const tmpFilePath = path.join(tmpDir, `rubric-${Date.now()}.json`);
    
    await fs.writeFile(tmpFilePath, rubricBuffer);

    try {
      // Upload to IPFS
      const ipfsClient = req.app.locals.ipfsClient;
      const rubricCid = await ipfsClient.uploadToIPFS(tmpFilePath);
      
      logger.info('Rubric uploaded to IPFS successfully', { 
        cid: rubricCid,
        size: rubricBuffer.length 
      });

      res.json({
        success: true,
        rubricCid,
        size: rubricBuffer.length,
        criteriaCount: rubricJson.criteria?.length,
        message: 'Rubric uploaded to IPFS. Use this CID when calling createBounty().'
      });

    } finally {
      // Clean up temp file
      await fs.unlink(tmpFilePath).catch(err => 
        logger.warn('Failed to clean up temp rubric file:', err)
      );
    }

  } catch (error) {
    logger.error('Error creating bounty metadata:', error);
    res.status(500).json({
      error: 'Failed to create bounty metadata',
      details: error.message
    });
  }
});

/**
 * GET /api/bounties
 * List all bounties (with optional filters)
 */
router.get('/', async (req, res) => {
  try {
    const { status, creator, minPayout, limit = 20, offset = 0 } = req.query;

    // TODO: Implement bounty listing
    // 1. Query blockchain for all bounties (via ethers.js)
    // 2. Apply filters (status, creator, minPayout)
    // 3. Fetch rubric CIDs from IPFS for titles
    // 4. Apply pagination
    // 5. Return formatted list

    logger.info('GET /api/bounties called', { status, creator, minPayout, limit, offset });
    logger.warn('TODO: Implement bounty listing from blockchain');

    res.status(501).json({
      error: 'Not implemented',
      message: 'TODO: Implement bounty listing functionality',
      steps: [
        '1. Connect to BountyEscrow contract using ethers.js',
        '2. Query all bounties (may need event filtering or indexing)',
        '3. Filter by status, creator, minPayout',
        '4. For each bounty, fetch rubric from IPFS to get title',
        '5. Apply pagination (limit, offset)',
        '6. Return formatted results'
      ]
    });

  } catch (error) {
    logger.error('Error listing bounties:', error);
    res.status(500).json({
      error: 'Failed to list bounties',
      details: error.message
    });
  }
});

/**
 * GET /api/bounties/:bountyId
 * Get detailed bounty information including rubric content
 */
router.get('/:bountyId', async (req, res) => {
  try {
    const { bountyId } = req.params;

    // TODO: Implement bounty details fetching
    // 1. Query blockchain for bounty data
    // 2. Fetch and parse rubric from IPFS
    // 3. Get all submissions for this bounty
    // 4. Return detailed bounty object

    logger.info(`GET /api/bounties/${bountyId} called`);
    logger.warn('TODO: Implement bounty details fetching');

    res.status(501).json({
      error: 'Not implemented',
      message: 'TODO: Implement bounty details fetching',
      steps: [
        '1. Connect to BountyEscrow contract',
        '2. Call contract.getBounty(bountyId)',
        '3. Fetch rubric JSON from IPFS using rubricCid',
        '4. Call contract.getBountySubmissions(bountyId)',
        '5. For each submission, get details',
        '6. Return complete bounty object with rubric and submissions'
      ]
    });

  } catch (error) {
    logger.error('Error fetching bounty details:', error);
    res.status(500).json({
      error: 'Failed to fetch bounty details',
      details: error.message
    });
  }
});

/**
 * GET /api/bounties/:bountyId/submissions
 * Get all submissions for a bounty
 */
router.get('/:bountyId/submissions', async (req, res) => {
  try {
    const { bountyId } = req.params;

    // TODO: Implement submission listing for bounty
    // 1. Query blockchain for bounty submissions
    // 2. Return formatted list

    logger.info(`GET /api/bounties/${bountyId}/submissions called`);
    logger.warn('TODO: Implement submission listing');

    res.status(501).json({
      error: 'Not implemented',
      message: 'TODO: Implement submission listing',
      steps: [
        '1. Connect to BountyEscrow contract',
        '2. Call contract.getBountySubmissions(bountyId)',
        '3. For each submissionId, call contract.getSubmission()',
        '4. Return formatted array of submissions'
      ]
    });

  } catch (error) {
    logger.error('Error fetching submissions:', error);
    res.status(500).json({
      error: 'Failed to fetch submissions',
      details: error.message
    });
  }
});

/**
 * POST /api/bounties/:bountyId/submit
 * Upload deliverable to IPFS for submission
 */
// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../tmp'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (isValidFileType(file.mimetype, file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: txt, md, jpg, png, pdf, docx`));
    }
  },
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  }
}).single('file');

router.post('/:bountyId/submit', async (req, res) => {
  let uploadedFile = null;

  try {
    // Handle file upload
    await new Promise((resolve, reject) => {
      upload(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded',
        details: 'Request must include a file in multipart/form-data format'
      });
    }

    uploadedFile = req.file;
    const { bountyId } = req.params;

    // Validate bountyId is a number
    const bountyIdNum = parseInt(bountyId, 10);
    if (isNaN(bountyIdNum)) {
      return res.status(400).json({
        error: 'Invalid bounty ID',
        details: 'Bounty ID must be a number'
      });
    }

    // Validate file size
    if (!isValidFileSize(uploadedFile.size)) {
      return res.status(400).json({
        error: 'File too large',
        details: `Maximum file size is ${MAX_FILE_SIZE / 1024 / 1024} MB`
      });
    }

    logger.info(`POST /api/bounties/${bountyId}/submit called`, {
      filename: uploadedFile.originalname,
      size: uploadedFile.size,
      mimetype: uploadedFile.mimetype
    });

    // Upload to IPFS
    const ipfsClient = req.app.locals.ipfsClient;
    const deliverableCid = await ipfsClient.uploadToIPFS(uploadedFile.path);

    logger.info('Deliverable uploaded to IPFS successfully', {
      cid: deliverableCid,
      size: uploadedFile.size,
      bountyId
    });

    res.json({
      success: true,
      deliverableCid,
      size: uploadedFile.size,
      filename: uploadedFile.originalname,
      mimetype: uploadedFile.mimetype,
      message: 'File uploaded to IPFS. Use this CID when calling submitAndEvaluate().'
    });

  } catch (error) {
    logger.error('Error uploading deliverable:', error);
    res.status(500).json({
      error: 'Failed to upload deliverable',
      details: error.message
    });
  } finally {
    // Clean up uploaded file
    if (uploadedFile?.path) {
      await fs.unlink(uploadedFile.path).catch(err =>
        logger.warn('Failed to clean up temp file:', err)
      );
    }
  }
});

module.exports = router;

