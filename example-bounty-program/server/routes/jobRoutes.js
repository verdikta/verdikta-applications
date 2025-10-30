/**
 * Job Routes
 * Handles job/bounty creation, listing, and submission workflow
 * This is temporary storage until smart contracts are deployed
 */

const { ethers } = require('ethers');
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
 * Supports:
 *   - status=OPEN|CLOSED|COMPLETED|CANCELLED
 *   - creator=0x...
 *   - minPayout=number
 *   - search=free text
 *   - onChainId=number
 *   - hideEnded=true      // ← NEW: hides CANCELLED and COMPLETED
 *   - excludeStatuses=A,B // ← NEW: e.g. excludeStatuses=CANCELLED,COMPLETED
 *   - limit, offset
 */
router.get('/', async (req, res) => {
  try {
    const {
      status,
      creator,
      minPayout,
      search,
      onChainId,
      hideEnded,
      excludeStatuses,
      limit = 50,
      offset = 0
    } = req.query;

    logger.info('Listing jobs', { status, creator, search, onChainId, hideEnded, excludeStatuses });

    // Build base filters supported by jobStorage.listJobs
    const filters = {};
    if (status) filters.status = status;
    if (creator) filters.creator = creator;
    if (minPayout) filters.minPayout = minPayout;
    if (search) filters.search = search;

    // Pull jobs from storage with base filters applied
    let allJobs = await jobStorage.listJobs(filters);

    // Filter by onChainId if provided
    if (onChainId) {
      allJobs = allJobs.filter(j => Number(j.onChainId) === Number(onChainId));
    }

    // NEW: build an exclusion set
    const excludeSet = new Set();

    // hideEnded=true → exclude CANCELLED & COMPLETED
    if (String(hideEnded).toLowerCase() === 'true') {
      excludeSet.add('CANCELLED');
      excludeSet.add('COMPLETED');
    }

    // excludeStatuses=A,B → exclude those explicit statuses too
    if (excludeStatuses) {
      for (const s of String(excludeStatuses).split(',')) {
        const v = s.trim().toUpperCase();
        if (v) excludeSet.add(v);
      }
    }

    // Apply exclusion if requested
    if (excludeSet.size > 0) {
      allJobs = allJobs.filter(j => !excludeSet.has(String(j.status).toUpperCase()));
    }

    // Pagination
    const limitNum = parseInt(limit, 10);
    const offsetNum = parseInt(offset, 10);
    const paginatedJobs = allJobs.slice(offsetNum, offsetNum + limitNum);

    // Summaries
    const jobSummaries = paginatedJobs.map(job => ({
      jobId: job.jobId,
      onChainId: job.onChainId,
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
      syncedFromBlockchain: job.syncedFromBlockchain || false
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
 * Submit work for a job (supports multiple files)
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../tmp')),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}-${file.originalname}`)
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => isValidFileType(file.mimetype, file.originalname) ? cb(null, true)
    : cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: txt, md, jpg, png, pdf, docx`)),
  limits: { fileSize: MAX_FILE_SIZE, files: 10 }
}).array('files', 10);

router.post('/:jobId/submit', async (req, res) => {
  let uploadedFiles = [];
  try {
    await new Promise((resolve, reject) => upload(req, res, (err) => err ? reject(err) : resolve()));

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded', details: 'Provide at least one file' });
    }
    uploadedFiles = req.files;

    const { jobId } = req.params;
    const { hunter, submissionNarrative } = req.body;

    // Validate hunter address
    if (!hunter || !/^0x[a-fA-F0-9]{40}$/.test(hunter)) {
      return res.status(400).json({ error: 'Invalid hunter address', details: 'Must be a valid Ethereum address' });
    }

    // Validate narrative length
    if (submissionNarrative) {
      const wordCount = submissionNarrative.trim().split(/\s+/).length;
      if (wordCount > 200) {
        return res.status(400).json({ error: 'Submission narrative too long', details: `<= 200 words` });
      }
    }

    const job = await jobStorage.getJob(jobId);

    // Check status and window
    if (job.status !== 'OPEN') {
      return res.status(400).json({ error: 'Job is not open', details: `Status is ${job.status}` });
    }
    const now = Math.floor(Date.now()/1000);
    if (now < job.submissionOpenTime || now > job.submissionCloseTime) {
      return res.status(400).json({ error: 'Submission window closed' });
    }

    // Prepare work products
    const fileDescriptions = (() => {
      try { return req.body.fileDescriptions ? JSON.parse(req.body.fileDescriptions) : {}; }
      catch { return {}; }
    })();

    const workProducts = uploadedFiles.map(f => ({
      path: f.path,
      name: f.originalname,
      type: f.mimetype,
      description: fileDescriptions[f.originalname] || `Work product file: ${f.originalname}`
    }));

    // Create Hunter Submission CID archive
    const hunterArchive = await archiveGenerator.createHunterSubmissionCIDArchive({
      workProducts,
      submissionNarrative: submissionNarrative || undefined
    });

    // Upload hunter archive to IPFS
    const ipfsClient = req.app.locals.ipfsClient;
    let hunterCid;
    try {
      hunterCid = await ipfsClient.uploadToIPFS(hunterArchive.archivePath);
      logger.info('Hunter submission uploaded to IPFS', { hunterCid, fileCount: uploadedFiles.length });
    } finally {
      await fs.unlink(hunterArchive.archivePath).catch(err => logger.warn('Failed to clean up hunter archive:', err));
    }

    // Create updated Primary archive
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

    // Upload updated Primary archive
    let updatedPrimaryCid;
    try {
      updatedPrimaryCid = await ipfsClient.uploadToIPFS(updatedPrimaryArchive.archivePath);
      logger.info('Updated Primary archive uploaded to IPFS', { updatedPrimaryCid });
    } finally {
      await fs.unlink(updatedPrimaryArchive.archivePath).catch(err => logger.warn('Failed to clean up updated primary archive:', err));
    }

    // Persist submission
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

    res.json({
      success: true,
      message: 'Submission recorded successfully!',
      submission: {
        hunter,
        hunterCid,
        updatedPrimaryCid,
        fileCount: uploadedFiles.length,
        files: uploadedFiles.map(f => ({
          filename: f.originalname, size: f.size, description: fileDescriptions[f.originalname]
        })),
        totalSize: uploadedFiles.reduce((s, f) => s + f.size, 0)
      }
    });

  } catch (error) {
    logger.error('Error submitting work:', error);
    if (error.message.includes('not found')) {
      res.status(404).json({ error: 'Job not found', details: error.message });
    } else {
      res.status(500).json({ error: 'Failed to submit work', details: error.message });
    }
  } finally {
    // Clean up temp files
    for (const f of uploadedFiles) {
      if (f?.path) await fs.unlink(f.path).catch(err => logger.warn('Failed to clean up temp file:', err));
    }
  }
});

/**
 * PATCH /api/jobs/:jobId/bountyId
 * Manually attach the on-chain bountyId (used by the client after tx confirmation)
 */
router.patch('/:jobId/bountyId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { bountyId, txHash, blockNumber } = req.body;

    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    job.bountyId   = bountyId;
    job.txHash     = txHash;
    job.blockNumber = blockNumber;
    job.onChain    = true;

    await jobStorage.writeStorage(storage);

    logger.info('Job updated with bountyId', { jobId, bountyId });
    res.json({ success: true, job });
  } catch (error) {
    logger.error('Error updating job bountyId:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/jobs/:id/bountyId/resolve
 * Resolve on-chain bountyId via server-side RPC and persist it
 */
const RPC = process.env.RPC_PROVIDER_URL;
const ESCROW = process.env.BOUNTY_ESCROW_ADDRESS;
const ABI = [
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256) view returns (address,string,uint64,uint8,uint256,uint256,uint64,uint8,address,uint256)"
];
function ro() { return new ethers.JsonRpcProvider(RPC); }
function escrowRO() { return new ethers.Contract(ESCROW, ABI, ro()); }

// keep these helpers at top of file 
router.patch('/:id/bountyId/resolve', async (req, res) => {
  const jobIdParam = req.params.id;
  try {
    logger.info('[resolve] hit', { id: jobIdParam, body: req.body });

    const { creator, rubricCid, submissionCloseTime, txHash } = req.body || {};
    if (!creator || !submissionCloseTime) {
      return res.status(400).json({ success: false, error: 'creator and submissionCloseTime are required' });
    }

    // load job from storage
    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobIdParam));
    if (!job) {
      return res.status(404).json({ success: false, error: `Job ${jobIdParam} not found` });
    }

    // normalize deadline to seconds
    const deadlineSec = Number(submissionCloseTime) > 1e12
      ? Math.floor(Number(submissionCloseTime) / 1000)
      : Number(submissionCloseTime);

    // ---- 1) tx-hash fast path (guarded) ----
    if (txHash) {
      try {
        const receipt = await ro().getTransactionReceipt(txHash);
        if (receipt && Array.isArray(receipt.logs)) {
          const iface = new ethers.Interface([
            "event BountyCreated(uint256 indexed bountyId, address indexed creator, string rubricCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)"
          ]);
          for (const log of receipt.logs) {
            if ((log.address || '').toLowerCase() !== (ESCROW || '').toLowerCase()) continue;
            try {
              const ev = iface.parseLog(log);
              const bountyId = Number(ev.args.bountyId);
              job.bountyId = bountyId;
              job.onChain = true;
              job.txHash = job.txHash ?? txHash;
              await jobStorage.writeStorage(storage);
              logger.info('[resolve] resolved via tx', { jobId: jobIdParam, bountyId });
              return res.json({ success: true, method: 'tx', bountyId, job });
            } catch (parseErr) {
              // not our event; keep scanning
            }
          }
        }
      } catch (txErr) {
        logger.warn('[resolve] txHash path failed', { msg: txErr?.message });
        // fall through to state scan
      }
    }

    // ---- 2) state scan (bounded & tolerant) ----
    try {
      const c = escrowRO();
      const total = Number(await c.bountyCount());
      if (!(total > 0)) {
        return res.status(404).json({ success: false, error: 'No bounties on chain yet' });
      }

      const start = Math.max(0, total - 1);
      const stop  = Math.max(0, total - 1 - 300); // lookback 300
      const wantCreator  = String(creator).toLowerCase();
      const wantCid      = rubricCid ? String(rubricCid) : '';
      const wantDeadline = deadlineSec;

      let best = null, bestDelta = Number.POSITIVE_INFINITY;
      for (let i = start; i >= stop; i--) {
        let b;
        try { b = await c.getBounty(i); } catch (e) { continue; }
        const bCreator  = (b[0] || '').toLowerCase();
        if (bCreator !== wantCreator) continue;
        const bCid      = b[1] || '';
        const bDeadline = Number(b[6] || 0);
        const delta     = Math.abs(bDeadline - wantDeadline);
        const cidOk      = !wantCid || wantCid === bCid;
        const deadlineOk = delta <= 300; // ±5 minutes
        if ((cidOk && deadlineOk) || (cidOk && delta < bestDelta)) {
          best = i; bestDelta = delta;
          if (delta === 0) break;
        }
      }

      if (best != null) {
        job.bountyId = best;
        job.onChain  = true;
        await jobStorage.writeStorage(storage);
        logger.info('[resolve] resolved via state', { jobId: jobIdParam, bountyId: best, delta: bestDelta });
        return res.json({ success: true, method: 'state', bountyId: best, delta: bestDelta, job });
      }

      job.onChain = false;
      await jobStorage.writeStorage(storage);
      return res.status(404).json({ success: false, error: 'No matching on-chain bounty', onChain: false });
    } catch (scanErr) {
      logger.error('[resolve] state scan error', { msg: scanErr?.message });
      return res.status(500).json({ success: false, error: `State scan failed: ${scanErr?.message}` });
    }
  } catch (e) {
    logger.error('[resolve] fatal', { msg: e?.message, stack: e?.stack });
    return res.status(500).json({ success: false, error: e?.message || 'Internal error' });
  }
});





// ============================================================
//          BLOCKCHAIN SYNC MONITORING ENDPOINTS
// ============================================================

/**
 * GET /api/jobs/sync/status
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

