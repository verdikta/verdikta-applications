/**
 * Job Routes
 * Handles job/bounty creation, listing, and submission workflow
 */

const { ethers } = require('ethers');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const jobStorage = require('../utils/jobStorage');
const archiveGenerator = require('../utils/archiveGenerator');
const { validateRubric, validateJuryNodes, isValidFileType, MAX_FILE_SIZE } = require('../utils/validation');

/* ======================
   Helpers / configuration
   ====================== */

function readBool(v) { return /^(1|true|yes|on)$/i.test(String(v || '').trim()); }
const DEV_ENV_FAKE = readBool(process.env.DEV_FAKE_RUBRIC_CID);

// Loose IPFS CID check; we still try a HEAD fetch later when possible.
const CID_REGEX =
  /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[0-9A-Za-z]{50,}|z[1-9A-HJ-NP-Za-km-z]{46,}|ba[ef]y[0-9A-Za-z]{50,}|b[A-Za-z2-7]{58,}|B[A-Z2-7]{58,}|F[0-9A-F]{50,})$/i;

// One temp base OUTSIDE the project tree
const TMP_BASE = process.env.VERDIKTA_TMP_DIR || path.join(os.tmpdir(), 'verdikta');
async function ensureTmpBase() {
  await fs.mkdir(TMP_BASE, { recursive: true });
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}
function stringifyErr(e) {
  if (!e) return 'Unknown error';
  if (e.response?.data) {
    try { return JSON.stringify(e.response.data); } catch {}
    return String(e.response.data);
  }
  if (e.data) {
    try { return JSON.stringify(e.data); } catch {}
    return String(e.data);
  }
  return e.message || String(e);
}

// Direct, minimal JSON‑pin helper (Pinata). Expects RAW JWT in env; we add "Bearer ".
const PIN_TIMEOUT_MS = Number(process.env.PIN_TIMEOUT_MS || 20000);
function withTimeout(p, ms, label='operation') {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}
async function pinJsonToPinata(contentObj, name = 'verdikta-json') {
  const PINATA_BASE = (process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud').replace(/\/+$/,'');
  const jwt = process.env.IPFS_PINNING_KEY || '';
  if (!jwt) throw new Error('IPFS_PINNING_KEY not set');
  const authHeader = jwt.toLowerCase().startsWith('bearer ') ? jwt : `Bearer ${jwt}`;

  const url = `${PINATA_BASE}/pinning/pinJSONToIPFS`;
  const res = await withTimeout(fetch(url, {
    method: 'POST',
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinataContent: contentObj, pinataMetadata: { name } })
  }), PIN_TIMEOUT_MS, 'Pinata pinJSONToIPFS');

  const text = await res.text();
  if (!res.ok) {
    let data; try { data = JSON.parse(text); } catch { data = text; }
    const err = new Error(`Pinata returned ${res.status}`);
    err.status = res.status;
    err.response = { status: res.status, data };
    throw err;
  }
  const parsed = JSON.parse(text);
  if (!parsed?.IpfsHash) throw new Error('Pinata response missing IpfsHash');
  return parsed.IpfsHash;
}

/* ==============
   CREATE A JOB
   ============== */

/**
 * POST /api/jobs/create
 * Accepts EITHER:
 *  - rubricJson: object (server pins & returns real rubricCid), OR
 *  - rubricCid:  string (already pinned)
 * Uses ipfsClient.uploadToIPFS for the Primary archive.
 */
router.post('/create', async (req, res) => {
  const keys = Object.keys(req.body || {});
  logger.info('[jobs/create] incoming keys', { keys });

  try {
    await ensureTmpBase();

    const {
      title,
      description,
      workProductType = 'Work Product',
      creator,
      bountyAmount,
      bountyAmountUSD,
      threshold,
      rubricJson,              // optional (server pins json)
      rubricCid: rubricCidIn,  // optional (already pinned)
      classId = 128,
      juryNodes = [],
      iterations = 1,
      submissionWindowHours = 24
    } = req.body || {};

    // ---- Validate commons ----
    if (!title || !description || !creator) {
      return res.status(400).json({ error: 'Missing required fields', details: 'title, description, creator required' });
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(creator)) {
      return res.status(400).json({ error: 'Invalid creator address', details: 'Must be a valid Ethereum address' });
    }
    if (!Number.isFinite(Number(bountyAmount)) || Number(bountyAmount) <= 0) {
      return res.status(400).json({ error: 'Invalid bountyAmount', details: 'Must be a positive number' });
    }
    if (!Number.isFinite(Number(threshold)) || Number(threshold) < 0 || Number(threshold) > 100) {
      return res.status(400).json({ error: 'Invalid threshold', details: 'Threshold must be between 0 and 100' });
    }
    // Validate jury configuration
    const juryValidation = validateJuryNodes(juryNodes);
    if (!juryValidation.valid) {
      return res.status(400).json({ 
        error: 'Invalid jury configuration', 
        details: 'Jury validation failed', 
        errors: juryValidation.errors 
      });
    }
    if (!rubricJson && !rubricCidIn) {
      return res.status(400).json({ error: 'Missing rubric', details: 'Provide rubricJson or rubricCid' });
    }

    // ---- Resolve rubricCid ----
    let rubricCid;

    if (rubricJson) {
      // Validate rubric JSON
      const validation = validateRubric(rubricJson);
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid rubric', details: 'Rubric validation failed', errors: validation.errors });
      }

      // Enrich and pin as JSON (no temp file needed)
      const rubricWithMeta = {
        ...rubricJson,
        version: rubricJson.version || '1.0',
        createdAt: new Date().toISOString(),
        classId
      };

      try {
        const devQuery = readBool(req.query?.dev);
        const devBypass = devQuery || DEV_ENV_FAKE;
        if (devBypass) {
          rubricCid = `dev-rubric-${Date.now()}.json`;
          logger.warn('[jobs/create] DEV bypass — fake rubricCid', { rubricCid });
        } else {
          rubricCid = await pinJsonToPinata(rubricWithMeta, `rubric-${rubricWithMeta.title || 'untitled'}`);
          logger.info('[jobs/create] rubric pinned (JSON)', { rubricCid });
        }
      } catch (err) {
        const msg = stringifyErr(err);
        logger.error('[jobs/create] rubric JSON pin failed', { msg });
        return res.status(500).json({ success: false, error: `Rubric upload failed: ${msg}` });
      }

    } else {
      // rubricCid provided
      if (typeof rubricCidIn !== 'string' || !CID_REGEX.test(rubricCidIn)) {
        return res.status(400).json({ error: 'Invalid rubricCid', details: 'Provide a valid IPFS CID' });
      }
      rubricCid = rubricCidIn;

      // Optional: non-fatal HEAD check if your IPFS client supports it
      try {
        const ipfsClient = req.app.locals.ipfsClient;
        if (ipfsClient?.headFromIPFS && typeof ipfsClient.headFromIPFS === 'function') {
          await ipfsClient.headFromIPFS(rubricCid);
        }
      } catch (e) {
        logger.warn('[jobs/create] rubricCid HEAD check failed (continuing)', { cid: rubricCid, msg: e.message });
      }
    }

    // ---- Create Primary archive ----
    let primaryArchive;
    try {
      primaryArchive = await archiveGenerator.createPrimaryCIDArchive({
        rubricCid,
        jobTitle: title,
        jobDescription: description,
        workProductType,
        classId,
        juryNodes,
        iterations
        // you can also pass tmpDir: TMP_BASE if your helper supports it
      });
    } catch (e) {
      logger.error('[jobs/create] primary archive creation failed', { msg: e.message });
      return res.status(500).json({ success: false, error: `Primary archive build failed: ${e.message}` });
    }

    // ---- Pin Primary archive (file) ----
    let primaryCid;
    try {
      const devQuery = readBool(req.query?.dev);
      const devBypass = devQuery || DEV_ENV_FAKE;

      if (devBypass) {
        primaryCid = `dev-${path.basename(primaryArchive.archivePath)}`;
        logger.warn('[jobs/create] DEV bypass — fake primaryCid', { primaryCid });
      } else {
        const ipfsClient = req.app.locals.ipfsClient;
        if (!ipfsClient || typeof ipfsClient.uploadToIPFS !== 'function') {
          throw new Error('IPFS client not initialized on server');
        }
        primaryCid = await ipfsClient.uploadToIPFS(primaryArchive.archivePath);
        logger.info('[jobs/create] primary archive pinned', { primaryCid });
      }
    } catch (err) {
      const msg = stringifyErr(err);
      logger.error('[jobs/create] primary archive upload failed', { msg });
      return res.status(500).json({ success: false, error: `Primary archive upload failed: ${msg}` });
    } finally {
      if (primaryArchive?.archivePath) {
        await fs.unlink(primaryArchive.archivePath).catch(e =>
          logger.warn('[jobs/create] failed to clean primary archive', { msg: e.message })
        );
      }
    }

    // ---- Times ----
    const now = Math.floor(Date.now() / 1000);
    const submissionOpenTime = now;
    const submissionCloseTime = now + (Number(submissionWindowHours) * 3600);

    // ---- Persist job ----
    const job = await jobStorage.createJob({
      title,
      description,
      workProductType,
      creator,
      bountyAmount: Number(bountyAmount),
      bountyAmountUSD: Number(bountyAmountUSD || 0),
      threshold: Number(threshold),
      rubricCid,
      primaryCid,
      classId: Number(classId),
      juryNodes,
      iterations: Number(iterations),
      submissionOpenTime,
      submissionCloseTime
    });

    logger.info('[jobs/create] job created', { jobId: job.jobId });

    return res.json({
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
    logger.error('[jobs/create] fatal', { msg: error.message, stack: error.stack?.split('\n')[0] });
    return res.status(500).json({ error: 'Failed to create job', details: error.message });
  }
});

/* =======================
   SYNC STATUS - MUST BE BEFORE /:jobId routes!
   ======================= */

router.get('/sync/status', (req, res) => {
  if (process.env.USE_BLOCKCHAIN_SYNC !== 'true') {
    return res.json({ enabled: false, message: 'Blockchain sync is disabled. Set USE_BLOCKCHAIN_SYNC=true in .env to enable.' });
  }
  try {
    const { getSyncService } = require('../utils/syncService');
    const syncService = getSyncService();
    return res.json({ enabled: true, status: syncService.getStatus() });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get sync status', details: error.message });
  }
});

router.post('/sync/now', async (req, res) => {
  if (process.env.USE_BLOCKCHAIN_SYNC !== 'true') {
    return res.status(400).json({ error: 'Blockchain sync not enabled', message: 'Set USE_BLOCKCHAIN_SYNC=true in .env to enable sync functionality.' });
  }
  try {
    const { getSyncService } = require('../utils/syncService');
    const syncService = getSyncService();
    syncService.syncNow();
    return res.json({ success: true, message: 'Blockchain sync triggered', status: syncService.getStatus() });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to trigger sync', details: error.message });
  }
});

/* =======================
   ADMIN ROUTES - MUST BE BEFORE /:jobId routes!
   ======================= */

router.get('/admin/diagnostics', async (req, res) => {
  try {
    const diagnostics = await jobStorage.getDiagnostics();
    return res.json({ success: true, diagnostics });
  } catch (error) {
    logger.error('[admin/diagnostics] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to get diagnostics', details: error.message });
  }
});

router.get('/admin/orphans', async (req, res) => {
  try {
    const orphans = await jobStorage.findOrphanedJobs();
    return res.json({ 
      success: true, 
      count: orphans.length,
      orphans: orphans.map(j => ({
        jobId: j.jobId,
        onChainId: j.onChainId,
        title: j.title,
        status: j.status,
        contractAddress: j.contractAddress,
        creator: j.creator,
        createdAt: j.createdAt
      }))
    });
  } catch (error) {
    logger.error('[admin/orphans] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to find orphaned jobs', details: error.message });
  }
});

router.post('/admin/orphans/mark', async (req, res) => {
  try {
    const result = await jobStorage.markOrphanedJobs();
    return res.json({ 
      success: true, 
      message: `Marked ${result.marked} jobs as orphaned`,
      ...result
    });
  } catch (error) {
    logger.error('[admin/orphans/mark] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to mark orphaned jobs', details: error.message });
  }
});

router.delete('/admin/orphans', async (req, res) => {
  try {
    // Require confirmation query param to prevent accidental deletion
    if (req.query.confirm !== 'yes') {
      return res.status(400).json({ 
        error: 'Confirmation required', 
        details: 'Add ?confirm=yes to confirm deletion of orphaned jobs'
      });
    }
    
    const result = await jobStorage.deleteOrphanedJobs();
    return res.json({ 
      success: true, 
      message: `Deleted ${result.deleted} orphaned jobs`,
      ...result
    });
  } catch (error) {
    logger.error('[admin/orphans] delete error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to delete orphaned jobs', details: error.message });
  }
});

router.patch('/admin/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { status } = req.body;
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    
    const validStatuses = ['OPEN', 'EXPIRED', 'AWARDED', 'CLOSED', 'ORPHANED', 'CANCELLED'];
    if (!validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({ 
        error: 'Invalid status', 
        details: `Valid statuses: ${validStatuses.join(', ')}`
      });
    }
    
    const job = await jobStorage.updateJobStatus(jobId, status);
    return res.json({ success: true, job });
  } catch (error) {
    logger.error('[admin/status] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to update job status', details: error.message });
  }
});

/* ==============
   LIST JOBS
   ============== */

router.get('/', async (req, res) => {
  try {
    const {
      status, creator, minPayout, search, onChainId,
      hideEnded, excludeStatuses, includeOrphans, limit = 50, offset = 0
    } = req.query;
    logger.info('[jobs/list] filters', { status, creator, search, onChainId, hideEnded, excludeStatuses, includeOrphans });

    const filters = {
      // By default, don't show orphaned jobs
      includeOrphans: String(includeOrphans).toLowerCase() === 'true'
    };
    if (status) filters.status = String(status).toUpperCase();
    if (creator) filters.creator = creator;
    if (minPayout) filters.minPayout = minPayout;
    if (search) filters.search = search;

    let allJobs = await jobStorage.listJobs(filters);

    if (onChainId) {
      allJobs = allJobs.filter(j => Number(j.onChainId) === Number(onChainId));
    }

    const excludeSet = new Set();
    if (String(hideEnded).toLowerCase() === 'true') {
      excludeSet.add('CANCELLED');
      excludeSet.add('COMPLETED');
    }
    // Always exclude ORPHANED unless explicitly requested
    if (!filters.includeOrphans) {
      excludeSet.add('ORPHANED');
    }
    if (excludeStatuses) {
      for (const s of String(excludeStatuses).split(',')) {
        const v = s.trim().toUpperCase();
        if (v) excludeSet.add(v);
      }
    }
    if (excludeSet.size > 0) {
      allJobs = allJobs.filter(j => !excludeSet.has(String(j.status).toUpperCase()));
    }

    const limitNum = parseInt(limit, 10);
    const offsetNum = parseInt(offset, 10);
    const paginatedJobs = allJobs.slice(offsetNum, offsetNum + limitNum);

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
      syncedFromBlockchain: job.syncedFromBlockchain || false,
      contractAddress: job.contractAddress // Include for debugging
    }));

    return res.json({
      success: true,
      jobs: jobSummaries,
      total: allJobs.length,
      limit: limitNum,
      offset: offsetNum
    });

  } catch (error) {
    logger.error('[jobs/list] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to list jobs', details: error.message });
  }
});

/* =================
   GET JOB DETAILS
   ================= */

router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    logger.info('[jobs/details] get', { jobId });

    const job = await jobStorage.getJob(jobId);

    let rubricContent = null;
    if (req.query.includeRubric === 'true' && job.rubricCid) {
      try {
        const ipfsClient = req.app.locals.ipfsClient;
        rubricContent = await ipfsClient.fetchFromIPFS(job.rubricCid);
      } catch (err) {
        logger.warn('[jobs/details] failed to fetch rubric', { msg: err.message });
      }
    }

    return res.json({
      success: true,
      job: {
        ...job,
        syncedFromBlockchain: job.syncedFromBlockchain || false,
        rubricContent: rubricContent ? JSON.parse(rubricContent) : null
      }
    });

  } catch (error) {
    logger.error('[jobs/details] error', { msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: 'Job not found', details: error.message });
    }
    return res.status(500).json({ error: 'Failed to get job', details: error.message });
  }
});

/* ==============
   SUBMIT WORK
   ============== */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_BASE),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}-${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => isValidFileType(file.mimetype, file.originalname)
    ? cb(null, true)
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

    if (!hunter || !/^0x[a-fA-F0-9]{40}$/.test(hunter)) {
      return res.status(400).json({ error: 'Invalid hunter address', details: 'Must be a valid Ethereum address' });
    }

    if (submissionNarrative) {
      const wordCount = submissionNarrative.trim().split(/\s+/).length;
      if (wordCount > 200) {
        return res.status(400).json({ error: 'Submission narrative too long', details: `<= 200 words` });
      }
    }

    const job = await jobStorage.getJob(jobId);
    if (job.status !== 'OPEN') {
      return res.status(400).json({ error: 'Job is not open', details: `Status is ${job.status}` });
    }
    const now = Math.floor(Date.now()/1000);
    if (now < job.submissionOpenTime || now > job.submissionCloseTime) {
      return res.status(400).json({ error: 'Submission window closed' });
    }

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

    const hunterArchive = await archiveGenerator.createHunterSubmissionCIDArchive({
      workProducts,
      submissionNarrative: submissionNarrative || undefined
    });

    const ipfsClient = req.app.locals.ipfsClient;
    let hunterCid;
    try {
      hunterCid = await ipfsClient.uploadToIPFS(hunterArchive.archivePath);
      logger.info('[jobs/submit] hunter submission pinned', { hunterCid, fileCount: uploadedFiles.length });
    } finally {
      await fs.unlink(hunterArchive.archivePath).catch(err =>
        logger.warn('[jobs/submit] failed to clean hunter archive', { msg: err.message })
      );
    }

    // Note: We no longer create an "updated primary" archive at submission time.
    // The evaluation package (primaryCid) was created at bounty creation and is stored in the contract.
    // The hunterCid is passed to startPreparedSubmission() and sent to Verdikta along with
    // the bounty's evaluationCid (which the contract retrieves from storage).

    await jobStorage.addSubmission(jobId, {
      hunter,
      hunterCid,
      fileCount: uploadedFiles.length,
      files: uploadedFiles.map(f => ({ name: f.originalname, size: f.size, description: fileDescriptions[f.originalname] }))
    });

    return res.json({
      success: true,
      message: 'Submission recorded successfully!',
      submission: {
        hunter,
        hunterCid,
        // Note: evaluationCid is stored in the bounty on-chain (job.primaryCid)
        fileCount: uploadedFiles.length,
        files: uploadedFiles.map(f => ({ filename: f.originalname, size: f.size, description: fileDescriptions[f.originalname] })),
        totalSize: uploadedFiles.reduce((s, f) => s + f.size, 0)
      }
    });

  } catch (error) {
    logger.error('[jobs/submit] error', { msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: 'Job not found', details: error.message });
    }
    return res.status(500).json({ error: 'Failed to submit work', details: error.message });
  } finally {
    for (const f of uploadedFiles) {
      if (f?.path) await fs.unlink(f.path).catch(err =>
        logger.warn('[jobs/submit] failed to clean tmp file', { msg: err.message })
      );
    }
  }
});

/* ===============================
   PATCH bountyId + resolve helper
   =============================== */

router.patch('/:jobId/bountyId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { bountyId, txHash, blockNumber } = req.body;

    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    job.onChainId   = bountyId;  // ← Changed from job.bountyId
    job.txHash      = txHash;
    job.blockNumber = blockNumber;
    job.onChain     = true;
    
    // Track which contract this job was created on
    const currentContract = jobStorage.getCurrentContractAddress();
    if (currentContract && !job.contractAddress) {
      job.contractAddress = currentContract;
    }

    await jobStorage.writeStorage(storage);

    logger.info('[jobs/bountyId] updated', { jobId, onChainId: bountyId, contractAddress: job.contractAddress });
    return res.json({ success: true, job });
  } catch (error) {
    logger.error('[jobs/bountyId] error', { msg: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});


// Resolve endpoint (unchanged logic from your working version)
const RPC = process.env.RPC_PROVIDER_URL;
const ESCROW = process.env.BOUNTY_ESCROW_ADDRESS;
const ABI = [
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256) view returns (address,string,uint64,uint8,uint256,uint256,uint64,uint8,address,uint256)"
];
function ro() { return new ethers.JsonRpcProvider(RPC); }
function escrowRO() { return new ethers.Contract(ESCROW, ABI, ro()); }


router.patch('/:id/bountyId/resolve', async (req, res) => {
  const jobIdParam = req.params.id;
  try {
    logger.info('[resolve] hit', { id: jobIdParam, body: req.body });

    const { creator, rubricCid, submissionCloseTime, txHash } = req.body || {};
    if (!creator || !submissionCloseTime) {
      return res.status(400).json({ success: false, error: 'creator and submissionCloseTime are required' });
    }

    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobIdParam));
    if (!job) return res.status(404).json({ success: false, error: `Job ${jobIdParam} not found` });

    const deadlineSec = Number(submissionCloseTime) > 1e12
      ? Math.floor(Number(submissionCloseTime) / 1000)
      : Number(submissionCloseTime);

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
              job.onChainId = bountyId;  // ← Changed from job.bountyId
              job.onChain = true;
              job.txHash = job.txHash ?? txHash;
              // Track contract address
              const currentContract = jobStorage.getCurrentContractAddress();
              if (currentContract) job.contractAddress = currentContract;
              await jobStorage.writeStorage(storage);
              logger.info('[resolve] via tx', { jobId: jobIdParam, onChainId: bountyId });
              return res.json({ success: true, method: 'tx', bountyId, job });
            } catch {}
          }
        }
      } catch (txErr) {
        logger.warn('[resolve] txHash path failed', { msg: txErr?.message });
      }
    }

    try {
      const c = escrowRO();
      const total = Number(await c.bountyCount());
      if (!(total > 0)) return res.status(404).json({ success: false, error: 'No bounties on chain yet' });

      const start = Math.max(0, total - 1);
      const stop  = Math.max(0, total - 1 - 300);
      const wantCreator  = String(creator).toLowerCase();
      const wantCid      = rubricCid ? String(rubricCid) : '';
      const wantDeadline = deadlineSec;

      let best = null, bestDelta = Number.POSITIVE_INFINITY;
      for (let i = start; i >= stop; i--) {
        let b; try { b = await c.getBounty(i); } catch { continue; }
        const bCreator  = (b[0] || '').toLowerCase();
        if (bCreator !== wantCreator) continue;
        const bCid      = b[1] || '';
        const bDeadline = Number(b[6] || 0);
        const delta     = Math.abs(bDeadline - wantDeadline);
        const cidOk      = !wantCid || wantCid === bCid;
        const deadlineOk = delta <= 300;
        if ((cidOk && deadlineOk) || (cidOk && delta < bestDelta)) { best = i; bestDelta = delta; if (delta === 0) break; }
      }

      if (best != null) {
        job.onChainId = best;  // ← Changed from job.bountyId
        job.onChain = true;
        // Track contract address
        const currentContract = jobStorage.getCurrentContractAddress();
        if (currentContract) job.contractAddress = currentContract;
        await jobStorage.writeStorage(storage);
        logger.info('[resolve] via state', { jobId: jobIdParam, onChainId: best, delta: bestDelta });
        return res.json({ success: true, method: 'state', bountyId: best, delta: bestDelta, job });
      }

      job.onChain = false; await jobStorage.writeStorage(storage);
      return res.status(404).json({ success: false, error: 'No matching on-chain bounty', onChain: false });
    } catch (scanErr) {
      logger.error('[resolve] state scan error', { msg: scanErr?.message });
      return res.status(500).json({ success: false, error: `State scan failed: ${scanErr?.message}` });
    }
  } catch (e) {
    logger.error('[resolve] fatal', { msg: e?.message });
    return res.status(500).json({ success: false, error: e?.message || 'Internal error' });
  }
});


/* =======================
   CANCEL SUBMISSION
   - Only works for Prepared (not on-chain) submissions
   - Removes the submission from local storage
   ======================= */

router.delete('/:jobId/submissions/:submissionId', async (req, res) => {
  const { jobId, submissionId } = req.params;

  logger.info('[cancel] Request received', { jobId, submissionId });

  try {
    const job = await jobStorage.cancelSubmission(jobId, submissionId);

    return res.json({
      success: true,
      message: 'Submission cancelled',
      job
    });
  } catch (error) {
    logger.error('[cancel] Error', { jobId, submissionId, error: error.message });

    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('Cannot cancel')) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to cancel submission', details: error.message });
  }
});


/* =======================
   REFRESH SUBMISSION FROM BLOCKCHAIN
   - Works even without full sync enabled
   - Reads single submission status from chain and updates local storage
   ======================= */

router.post('/:jobId/submissions/:submissionId/refresh', async (req, res) => {
  const { jobId, submissionId } = req.params;
  const RPC_URL = process.env.RPC_PROVIDER_URL;
  const ESCROW_ADDR = process.env.BOUNTY_ESCROW_ADDRESS;
  
  logger.info('[refresh] Request received', { jobId, submissionId, RPC_URL: RPC_URL ? 'set' : 'NOT SET', ESCROW_ADDR });
  
  if (!RPC_URL || !ESCROW_ADDR) {
    return res.status(500).json({ 
      error: 'Blockchain not configured', 
      details: 'RPC_PROVIDER_URL and BOUNTY_ESCROW_ADDRESS must be set in .env' 
    });
  }
  
  try {
    // Get the job to find the on-chain bountyId
    const job = await jobStorage.getJob(jobId);
    if (!job) {
      logger.error('[refresh] Job not found', { jobId });
      return res.status(404).json({ error: 'Job not found', details: `No job with ID ${jobId}` });
    }
    
    logger.info('[refresh] Found job', { 
      jobId, 
      onChainId: job.onChainId,
      title: job.title,
      submissionsCount: job.submissions?.length || 0
    });
    
    // Use onChainId as the standard field name, with fallbacks
    let onChainId = job.onChainId ?? job.onChainBountyId ?? job.bountyId;
    
    // If still not found, try to find from submission data
    if (onChainId == null && job.submissions?.length > 0) {
      // Check if any submission has the bountyId from when it was created
      const firstSub = job.submissions[0];
      if (firstSub.onChainBountyId != null) {
        onChainId = firstSub.onChainBountyId;
        logger.info('[refresh] Found onChainId from submission', { jobId, onChainId });
      }
    }
    
    if (onChainId == null) {
      logger.error('[refresh] No onChainId found', { 
        jobId, 
        hasOnChainId: job.onChainId,
        hasOnChainBountyId: job.onChainBountyId,
        hasBountyId: job.bountyId
      });
      return res.status(400).json({ 
        error: 'No on-chain bounty ID', 
        details: 'This job has not been registered on-chain yet. Please check that the bounty was created on-chain.'
      });
    }
    
    logger.info('[refresh] Using on-chain bounty ID', { jobId, onChainId });
    
    const subId = parseInt(submissionId, 10);
    
    // Read submission from blockchain
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(ESCROW_ADDR, [
      "function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))"
    ], provider);
    
    const sub = await contract.getSubmission(onChainId, subId);
    
    // Debug: log raw struct fields
    logger.info('[refresh] Raw submission data from chain', {
      jobId,
      onChainId,
      submissionId: subId,
      hunter: sub.hunter,
      status: sub.status?.toString?.() ?? sub.status,
      acceptance: sub.acceptance?.toString?.() ?? sub.acceptance,
      rejection: sub.rejection?.toString?.() ?? sub.rejection,
      evaluationCid: sub.evaluationCid,
      hunterCid: sub.hunterCid
    });
    
    // Map status enum to string (ethers v6 returns BigInt for enums)
    // Contract enum: 0=Prepared, 1=PendingVerdikta, 2=Failed, 3=PassedPaid, 4=PassedUnpaid
    // Frontend expects: PENDING_EVALUATION (still pending), APPROVED/REJECTED (final states)
    const statusMap = {
      0: 'Prepared',
      1: 'PENDING_EVALUATION',  // PendingVerdikta
      2: 'REJECTED',            // Failed
      3: 'APPROVED',            // PassedPaid (winner!)
      4: 'APPROVED'             // PassedUnpaid (passed but someone else won)
    };
    const statusIndex = Number(sub.status);
    const chainStatus = statusMap[statusIndex] || 'UNKNOWN';
    
    logger.info('[refresh] Status mapping', {
      rawStatus: sub.status?.toString?.() ?? sub.status,
      statusIndex,
      chainStatus
    });
    
    // Scores are ALREADY normalized by the contract (divided by 10000)
    // The contract stores acceptance/rejection as 0-100, NOT 0-1000000
    const acceptScore = Number(sub.acceptance);
    const rejectScore = Number(sub.rejection);
    
    logger.info('[refresh] Parsed submission from chain', {
      jobId,
      onChainId,
      submissionId: subId,
      statusIndex,
      chainStatus,
      acceptScore,
      rejectScore
    });
    
    // Update local storage
    const localSubmission = job.submissions?.find(s => s.submissionId === subId);
    if (localSubmission) {
      localSubmission.status = chainStatus;
      localSubmission.score = acceptScore;
      localSubmission.acceptance = acceptScore;
      localSubmission.rejection = rejectScore;
      localSubmission.evaluationCid = sub.evaluationCid;
      localSubmission.hunterCid = sub.hunterCid;
      localSubmission.justificationCids = sub.justificationCids;
      localSubmission.finalizedAt = Number(sub.finalizedAt);
      
      jobStorage.updateJob(jobId, { submissions: job.submissions });
      
      logger.info('[refresh] Updated local submission', { 
        jobId, 
        submissionId: subId, 
        newStatus: chainStatus,
        score: acceptScore
      });
    } else {
      logger.warn('[refresh] Submission not found in local storage', {
        jobId,
        submissionId: subId,
        existingSubmissionIds: job.submissions?.map(s => s.submissionId) || []
      });
    }
    
    return res.json({
      success: true,
      submission: {
        submissionId: subId,
        status: chainStatus,
        acceptance: acceptScore,
        rejection: rejectScore,
        evaluationCid: sub.evaluationCid,
        hunterCid: sub.hunterCid,
        justificationCids: sub.justificationCids,
        finalizedAt: Number(sub.finalizedAt),
        hunter: sub.hunter
      }
    });
    
  } catch (error) {
    logger.error('[refresh] Error reading submission from blockchain', { 
      jobId, 
      submissionId, 
      error: error.message,
      stack: error.stack,
      RPC_URL: RPC_URL ? 'set' : 'NOT SET',
      ESCROW_ADDR
    });
    return res.status(500).json({ 
      error: 'Failed to refresh submission', 
      details: error.message,
      hint: error.message.includes('bad bountyId') ? 'Bounty ID may not exist on this contract' :
            error.message.includes('bad submissionId') ? 'Submission ID may not exist for this bounty' :
            'Check server logs for details'
    });
  }
});

module.exports = router;

