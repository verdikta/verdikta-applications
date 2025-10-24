/**
 * Job Routes
 * Handles job/bounty creation, listing, and submission workflow
 * This is temporary storage until smart contracts are deployed
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const jobStorage = require('../utils/jobStorage');
const archiveGenerator = require('../utils/archiveGenerator');
const { validateRubric, isValidFileType, isValidFileSize, MAX_FILE_SIZE } = require('../utils/validation');

/**
 * POST /api/jobs/create
 * Create a new job with rubric and generate Primary CID archive
 *
 * Request body:
 * {
 *   title: string,
 *   description: string,
 *   workProductType: string,
 *   creator: string (wallet address),
 *   bountyAmount: number (ETH),
 *   bountyAmountUSD: number,
 *   threshold: number (0-100),
 *   rubricJson: object,
 *   classId: number,
 *   juryNodes: array,
 *   iterations: number,
 *   submissionWindowHours: number (default 24)
 * }
 */
router.post('/create', async (req, res) => {
  try {
    const {
      title,
      description,
      workProductType = 'Work Product',
      creator,
      bountyAmount,
      bountyAmountUSD,
      threshold,
      rubricJson,
      classId = 128,
      juryNodes = [],
      iterations = 1,
      submissionWindowHours = 24
    } = req.body;

    // Validate required fields
    if (!title || !description || !creator || !bountyAmount || threshold === undefined || !rubricJson) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'Required: title, description, creator, bountyAmount, threshold, rubricJson'
      });
    }

    // Validate wallet address
    if (!/^0x[a-fA-F0-9]{40}$/.test(creator)) {
      return res.status(400).json({
        error: 'Invalid creator address',
        details: 'Creator must be a valid Ethereum address'
      });
    }

    // Validate threshold
    if (threshold < 0 || threshold > 100) {
      return res.status(400).json({
        error: 'Invalid threshold',
        details: 'Threshold must be between 0 and 100'
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

    // Validate jury nodes
    if (!Array.isArray(juryNodes) || juryNodes.length === 0) {
      return res.status(400).json({
        error: 'Invalid jury configuration',
        details: 'At least one jury node is required'
      });
    }

    logger.info('Creating new job', { title, creator, bountyAmount, threshold });

    // Step 1: Upload rubric to IPFS
    const rubricWithMeta = {
      ...rubricJson,
      version: rubricJson.version || '1.0',
      createdAt: new Date().toISOString(),
      classId
    };

    const rubricBuffer = Buffer.from(JSON.stringify(rubricWithMeta, null, 2), 'utf-8');
    const tmpDir = path.join(__dirname, '../tmp');
    const tmpRubricPath = path.join(tmpDir, `rubric-${Date.now()}.json`);

    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(tmpRubricPath, rubricBuffer);

    let rubricCid;
    try {
      const ipfsClient = req.app.locals.ipfsClient;
      rubricCid = await ipfsClient.uploadToIPFS(tmpRubricPath);
      logger.info('Rubric uploaded to IPFS', { rubricCid });
    } finally {
      await fs.unlink(tmpRubricPath).catch(err =>
        logger.warn('Failed to clean up temp rubric file:', err)
      );
    }

    // Step 2: Create Primary CID archive
    const primaryArchive = await archiveGenerator.createPrimaryCIDArchive({
      rubricCid,
      jobTitle: title,
      jobDescription: description,
      workProductType,
      classId,
      juryNodes,
      iterations
    });

    // Step 3: Upload Primary CID archive to IPFS
    let primaryCid;
    try {
      const ipfsClient = req.app.locals.ipfsClient;
      primaryCid = await ipfsClient.uploadToIPFS(primaryArchive.archivePath);
      logger.info('Primary archive uploaded to IPFS', { primaryCid });
    } finally {
      await fs.unlink(primaryArchive.archivePath).catch(err =>
        logger.warn('Failed to clean up primary archive:', err)
      );
    }

    // Step 4: Calculate submission window
    const now = Math.floor(Date.now() / 1000);
    const submissionOpenTime = now;
    const submissionCloseTime = now + (submissionWindowHours * 3600);

    // Step 5: Store job in local storage
    const job = await jobStorage.createJob({
      title,
      description,
      workProductType,
      creator,
      bountyAmount,
      bountyAmountUSD,
      threshold,
      rubricCid,
      primaryCid,
      classId,
      juryNodes,
      iterations,
      submissionOpenTime,
      submissionCloseTime
    });

    logger.info('Job created successfully', { jobId: job.jobId });

    res.json({
      success: true,
      job: {
        jobId: job.jobId,
        title: job.title,
        description: job.description,
        bountyAmount: job.bountyAmount,
        bountyAmountUSD: job.bountyAmountUSD,
        threshold: job.threshold,
        rubricCid: job.rubricCid,
        primaryCid: job.primaryCid,
        status: job.status,
        submissionOpenTime: job.submissionOpenTime,
        submissionCloseTime: job.submissionCloseTime,
        createdAt: job.createdAt
      },
      message: 'Job created successfully! Hunters can now submit work.'
    });

  } catch (error) {
    logger.error('Error creating job:', error);
    res.status(500).json({
      error: 'Failed to create job',
      details: error.message
    });
  }
});

/**
 * GET /api/jobs
 * List all jobs with optional filters
 */
router.get('/', async (req, res) => {
  try {
    // ============ ADD onChainId PARAMETER ============
    const { status, creator, minPayout, search, onChainId, limit = 50, offset = 0 } = req.query;

    logger.info('Listing jobs', { status, creator, search, onChainId });

    const filters = {};
    if (status) filters.status = status;
    if (creator) filters.creator = creator;
    if (minPayout) filters.minPayout = minPayout;
    if (search) filters.search = search;

    let allJobs = await jobStorage.listJobs(filters);

    // ============ ADD onChainId FILTERING ============
    // Filter by onChainId if provided (for finding newly created blockchain jobs)
    if (onChainId) {
      allJobs = allJobs.filter(j => j.onChainId === parseInt(onChainId));
    }
    // ================================================

    // Apply pagination
    const limitNum = parseInt(limit, 10);
    const offsetNum = parseInt(offset, 10);
    const paginatedJobs = allJobs.slice(offsetNum, offsetNum + limitNum);

    // Return job summaries (not full details)
    const jobSummaries = paginatedJobs.map(job => ({
      jobId: job.jobId,
      onChainId: job.onChainId, // ============ ADD THIS ============
      title: job.title,
      description: job.description,
      workProductType: job.workProductType,
      bountyAmount: job.bountyAmount,
      bountyAmountUSD: job.bountyAmountUSD,
      threshold: job.threshold,
      status: job.status,
      submissionCount: job.submissionCount,
      submissionOpenTime: job.submissionOpenTime,
      submissionCloseTime: job.submissionCloseTime,
      createdAt: job.createdAt,
      winner: job.winner,
      syncedFromBlockchain: job.syncedFromBlockchain || false // ============ ADD THIS ============
    }));

    res.json({
      success: true,
      jobs: jobSummaries,
      total: allJobs.length,
      limit: limitNum,
      offset: offsetNum
    });

  } catch (error) {
    logger.error('Error listing jobs:', error);
    res.status(500).json({
      error: 'Failed to list jobs',
      details: error.message
    });
  }
});

/**
 * GET /api/jobs/:jobId
 * Get detailed job information
 */
router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    logger.info(`Getting job details for ${jobId}`);

    const job = await jobStorage.getJob(jobId);

    // Optionally fetch rubric content
    let rubricContent = null;
    if (req.query.includeRubric === 'true' && job.rubricCid) {
      try {
        const ipfsClient = req.app.locals.ipfsClient;
        rubricContent = await ipfsClient.fetchFromIPFS(job.rubricCid);
      } catch (err) {
        logger.warn('Failed to fetch rubric from IPFS:', err);
      }
    }

    res.json({
      success: true,
      job: {
        ...job,
        rubricContent: rubricContent ? JSON.parse(rubricContent) : null
      }
    });

  } catch (error) {
    logger.error('Error getting job:', error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        error: 'Job not found',
        details: error.message
      });
    } else {
      res.status(500).json({
        error: 'Failed to get job',
        details: error.message
      });
    }
  }
});

/**
 * POST /api/jobs/:jobId/submit
 * Submit work for a job
 * Generates Hunter CID archive and updates Primary CID
 */
// Configure multer for file uploads (supports multiple files)
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
    files: 10 // Allow up to 10 files
  }
}).array('files', 10); // Changed from .single('file') to .array('files', 10)

router.post('/:jobId/submit', async (req, res) => {
  let uploadedFiles = [];

  try {
    // Handle file uploads
    await new Promise((resolve, reject) => {
      upload(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'No files uploaded',
        details: 'Request must include at least one file in multipart/form-data format'
      });
    }

    uploadedFiles = req.files;
    const { jobId } = req.params;
    const { hunter, submissionNarrative } = req.body;

    // Parse file descriptions (sent as JSON string)
    let fileDescriptions = {};
    try {
      if (req.body.fileDescriptions) {
        fileDescriptions = JSON.parse(req.body.fileDescriptions);
      }
    } catch (e) {
      logger.warn('Failed to parse file descriptions:', e);
    }

    // Validate hunter address
    if (!hunter || !/^0x[a-fA-F0-9]{40}$/.test(hunter)) {
      return res.status(400).json({
        error: 'Invalid hunter address',
        details: 'Hunter must be a valid Ethereum address'
      });
    }

    // Validate submission narrative length (200 words max)
    if (submissionNarrative) {
      const wordCount = submissionNarrative.trim().split(/\s+/).length;
      if (wordCount > 200) {
        return res.status(400).json({
          error: 'Submission narrative too long',
          details: `Narrative must be 200 words or less (current: ${wordCount} words)`
        });
      }
    }

    // Validate all file sizes
    for (const file of uploadedFiles) {
      if (!isValidFileSize(file.size)) {
        return res.status(400).json({
          error: 'File too large',
          details: `File "${file.originalname}" exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024} MB`
        });
      }
    }

    logger.info(`Submission for job ${jobId}`, {
      hunter,
      fileCount: uploadedFiles.length,
      files: uploadedFiles.map(f => f.originalname),
      narrativeLength: submissionNarrative?.length || 0
    });

    // Get job details
    const job = await jobStorage.getJob(jobId);

    // Check if job is open
    if (job.status !== 'OPEN') {
      return res.status(400).json({
        error: 'Job is not open',
        details: `Job status is ${job.status}. Only OPEN jobs accept submissions.`
      });
    }

    // Check if submission window is still open
    const now = Math.floor(Date.now() / 1000);
    if (now < job.submissionOpenTime || now > job.submissionCloseTime) {
      return res.status(400).json({
        error: 'Submission window closed',
        details: 'This job is no longer accepting submissions.'
      });
    }

    // Prepare work products array with descriptions
    const workProducts = uploadedFiles.map(file => ({
      path: file.path,
      name: file.originalname,
      type: file.mimetype,
      description: fileDescriptions[file.originalname] || `Work product file: ${file.originalname}`
    }));

    // Step 1: Create Hunter Submission CID archive with multiple files
    const hunterArchive = await archiveGenerator.createHunterSubmissionCIDArchive({
      workProducts,
      submissionNarrative: submissionNarrative || undefined // Use default if not provided
    });

    // Step 2: Upload Hunter archive to IPFS
    const ipfsClient = req.app.locals.ipfsClient;
    let hunterCid;
    try {
      hunterCid = await ipfsClient.uploadToIPFS(hunterArchive.archivePath);
      logger.info('Hunter submission uploaded to IPFS', {
        hunterCid,
        fileCount: uploadedFiles.length
      });
    } finally {
      await fs.unlink(hunterArchive.archivePath).catch(err =>
        logger.warn('Failed to clean up hunter archive:', err)
      );
    }

    // Step 3: Create updated Primary CID archive with hunter submission CID
    const updatedPrimaryArchive = await archiveGenerator.createPrimaryCIDArchive({
      rubricCid: job.rubricCid,
      jobTitle: job.title,
      jobDescription: job.description,
      workProductType: job.workProductType,
      classId: job.classId,
      juryNodes: job.juryNodes,
      iterations: job.iterations,
      hunterSubmissionCid: hunterCid
    });

    // Step 4: Upload updated Primary archive to IPFS
    let updatedPrimaryCid;
    try {
      updatedPrimaryCid = await ipfsClient.uploadToIPFS(updatedPrimaryArchive.archivePath);
      logger.info('Updated Primary archive uploaded to IPFS', { updatedPrimaryCid });
    } finally {
      await fs.unlink(updatedPrimaryArchive.archivePath).catch(err =>
        logger.warn('Failed to clean up updated primary archive:', err)
      );
    }

    // Step 5: Add submission to job storage
    await jobStorage.addSubmission(jobId, {
      hunter,
      hunterCid,
      updatedPrimaryCid,
      fileCount: uploadedFiles.length,
      files: uploadedFiles.map(f => ({
        name: f.originalname,
        size: f.size,
        description: fileDescriptions[f.originalname]
      }))
    });

    logger.info('Submission recorded successfully', {
      jobId,
      hunter,
      fileCount: uploadedFiles.length
    });

    // Return CIDs for testing with example-frontend
    res.json({
      success: true,
      message: 'Submission recorded successfully!',
      submission: {
        hunter,
        hunterCid,
        updatedPrimaryCid,
        fileCount: uploadedFiles.length,
        files: uploadedFiles.map(f => ({
          filename: f.originalname,
          size: f.size,
          description: fileDescriptions[f.originalname]
        })),
        totalSize: uploadedFiles.reduce((sum, f) => sum + f.size, 0)
      },
      testingInfo: {
        message: 'For testing with example-frontend, use these CIDs:',
        primaryCid: updatedPrimaryCid,
        hunterCid: hunterCid,
        evaluationFormat: `${updatedPrimaryCid},${hunterCid}`,
        threshold: job.threshold,
        bountyAmount: job.bountyAmount
      }
    });

  } catch (error) {
    logger.error('Error submitting work:', error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        error: 'Job not found',
        details: error.message
      });
    } else {
      res.status(500).json({
        error: 'Failed to submit work',
        details: error.message
      });
    }
  } finally {
    // Clean up all uploaded files
    for (const file of uploadedFiles) {
      if (file?.path) {
        await fs.unlink(file.path).catch(err =>
          logger.warn('Failed to clean up temp file:', err)
        );
      }
    }
  }
});

/**
 * GET /api/jobs/:jobId/submissions
 * Get all submissions for a job
 */
router.get('/:jobId/submissions', async (req, res) => {
  try {
    const { jobId } = req.params;

    logger.info(`Getting submissions for job ${jobId}`);

    const job = await jobStorage.getJob(jobId);

    res.json({
      success: true,
      jobId: parseInt(jobId),
      submissions: job.submissions || []
    });

  } catch (error) {
    logger.error('Error getting submissions:', error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        error: 'Job not found',
        details: error.message
      });
    } else {
      res.status(500).json({
        error: 'Failed to get submissions',
        details: error.message
      });
    }
  }
});

// ============================================================
//          BLOCKCHAIN SYNC MONITORING ENDPOINTS
// ============================================================

/**
 * GET /api/jobs/sync/status
 * Get blockchain sync service status
 * Returns info about sync state, last sync time, and configuration
 */
router.get('/sync/status', (req, res) => {
  if (process.env.USE_BLOCKCHAIN_SYNC !== 'true') {
    return res.json({ 
      enabled: false,
      message: 'Blockchain sync is disabled. Set USE_BLOCKCHAIN_SYNC=true in .env to enable.'
    });
  }
  
  try {
    const { getSyncService } = require('../utils/syncService');
    const syncService = getSyncService();
    
    res.json({
      enabled: true,
      status: syncService.getStatus()
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get sync status',
      details: error.message 
    });
  }
});

/**
 * POST /api/jobs/sync/now
 * Trigger immediate blockchain sync
 * Useful for testing or forcing a sync without waiting for the interval
 * 
 * Note: In production, add authentication to this endpoint!
 */
router.post('/sync/now', async (req, res) => {
  if (process.env.USE_BLOCKCHAIN_SYNC !== 'true') {
    return res.status(400).json({ 
      error: 'Blockchain sync not enabled',
      message: 'Set USE_BLOCKCHAIN_SYNC=true in .env to enable sync functionality.'
    });
  }
  
  try {
    const { getSyncService } = require('../utils/syncService');
    const syncService = getSyncService();
    
    // Trigger sync (runs asynchronously)
    syncService.syncNow();
    
    res.json({
      success: true,
      message: 'Blockchain sync triggered',
      status: syncService.getStatus()
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to trigger sync',
      details: error.message 
    });
  }
});

module.exports = router;

