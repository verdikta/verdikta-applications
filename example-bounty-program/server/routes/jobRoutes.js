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
const { validateRubric, isValidFileType, isValidFileSize, MAX_FILE_SIZE } = require('../utils/validation');

// ---------- helpers / config ----------

function readBool(v) { return /^(1|true|yes|on)$/i.test(String(v || '').trim()); }
const DEV_ENV_FAKE = readBool(process.env.DEV_FAKE_RUBRIC_CID);

// Very permissive IPFS CID check (supports Qm..., bafy..., z..., etc.)
const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58}|B[A-Z2-7]{58}|z[1-9A-HJ-NP-Za-km-z]{48}|F[0-9A-F]{50}|bafy[0-9A-Za-z]{50,})$/i;

// Unified temp base OUTSIDE project tree
const TMP_BASE = process.env.VERDIKTA_TMP_DIR || path.join(os.tmpdir(), 'verdikta');

async function ensureTmpBase() {
  await fs.mkdir(TMP_BASE, { recursive: true });
}

function stringifyErr(e) {
  if (!e) return 'Unknown error';
  if (e.response?.data) { try { return JSON.stringify(e.response.data); } catch {} return String(e.response.data); }
  if (e.data)           { try { return JSON.stringify(e.data); } catch {} return String(e.data); }
  return e.message || String(e);
}

// ---------- CREATE JOB ----------

/**
 * POST /api/jobs/create
 * Accepts EITHER:
 *  - rubricJson: object (server pins & returns real rubricCid), OR
 *  - rubricCid:  string (already pinned)
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
      rubricJson,              // optional (server pins)
      rubricCid: rubricCidIn,  // optional (already pinned)
      classId = 128,
      juryNodes = [],
      iterations = 1,
      submissionWindowHours = 24
    } = req.body || {};

    // ---- Required fields (common) ----
    if (!title || !description || !creator || bountyAmount == null || threshold == null) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'Required: title, description, creator, bountyAmount, threshold, and either rubricJson or rubricCid'
      });
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(creator)) {
      return res.status(400).json({ error: 'Invalid creator address', details: 'Creator must be a valid Ethereum address' });
    }

    if (!Array.isArray(juryNodes) || juryNodes.length === 0) {
      return res.status(400).json({ error: 'Invalid jury configuration', details: 'At least one jury node is required' });
    }

    // ---- Rubric source must be provided ----
    if (!rubricJson && !rubricCidIn) {
      return res.status(400).json({ error: 'Missing rubric', details: 'Provide rubricJson or rubricCid' });
    }

    // ---- Resolve rubricCid (pin when JSON provided) ----
    let rubricCid = null;

    if (rubricJson) {
      // Validate rubric JSON structure
      const validation = validateRubric(rubricJson);
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid rubric', details: 'Rubric validation failed', errors: validation.errors });
      }

      // Write to tmp & pin
      const rubricWithMeta = {
        ...rubricJson,
        version: rubricJson.version || '1.0',
        createdAt: new Date().toISOString(),
        classId
      };

      const tmpRubricPath = path.join(
        TMP_BASE,
        `rubric-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
      );
      await fs.writeFile(tmpRubricPath, JSON.stringify(rubricWithMeta, null, 2), 'utf8');

      try {
        const devQuery = readBool(req.query?.dev);
        const devBypass = devQuery || DEV_ENV_FAKE;

        if (devBypass) {
          rubricCid = `dev-${path.basename(tmpRubricPath)}`;
          logger.warn('[jobs/create] DEV bypass active — returning fake rubric CID', { rubricCid });
        } else {
          const ipfsClient = req.app.locals.ipfsClient;
          if (!ipfsClient || typeof ipfsClient.uploadToIPFS !== 'function') {
            throw new Error('IPFS client not initialized on server');
          }
          rubricCid = await ipfsClient.uploadToIPFS(tmpRubricPath);
          logger.info('[jobs/create] rubric pinned to IPFS', { rubricCid });
        }
      } catch (err) {
        const msg = stringifyErr(err);
        logger.error('[jobs/create] rubric upload failed', { msg });
        return res.status(500).json({ success: false, error: `Rubric upload failed: ${msg}` });
      } finally {
        await fs.unlink(tmpRubricPath).catch(e =>
          logger.warn('[jobs/create] failed to clean tmp rubric file', { msg: e.message })
        );
      }
    } else {
      // rubricCid provided directly
      if (typeof rubricCidIn !== 'string' || !CID_REGEX.test(rubricCidIn)) {
        return res.status(400).json({ error: 'Invalid rubricCid', details: 'Provide a valid IPFS CID' });
      }
      rubricCid = rubricCidIn;

      // Optional light HEAD check; non-fatal
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
    const primaryArchive = await archiveGenerator.createPrimaryCIDArchive({
      rubricCid,
      jobTitle: title,
      jobDescription: description,
      workProductType,
      classId,
      juryNodes,
      iterations,
      // If your archiveGenerator supports it, pass tmpDir: TMP_BASE
      // tmpDir: TMP_BASE
    });

    // ---- Pin Primary archive ----
    let primaryCid = null;
    try {
      const devQuery = readBool(req.query?.dev);
      const devBypass = devQuery || DEV_ENV_FAKE;

      if (devBypass) {
        primaryCid = `dev-${path.basename(primaryArchive.archivePath)}`;
        logger.warn('[jobs/create] DEV bypass active — returning fake primary CID', { primaryCid });
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
      await fs.unlink(primaryArchive.archivePath).catch(e =>
        logger.warn('[jobs/create] failed to clean primary archive', { msg: e.message })
      );
    }

    // ---- Time window ----
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
    logger.error('[jobs/create] fatal', { msg: error.message, stack: error.stack });
    return res.status(500).json({ error: 'Failed to create job', details: error.message });
  }
});

// ---------- LIST JOBS (unchanged apart from logs) ----------
router.get('/', async (req, res) => {
  try {
    const {
      status, creator, minPayout, search, onChainId,
      hideEnded, excludeStatuses, limit = 50, offset = 0
    } = req.query;
    logger.info('[jobs/list] filters', { status, creator, search, onChainId, hideEnded, excludeStatuses });

    const filters = {};
    if (status) filters.status = status;
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
      syncedFromBlockchain: job.syncedFromBlockchain || false
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

// ---------- GET JOB DETAILS ----------
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

// ---------- SUBMIT WORK (unchanged) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_BASE),
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
      await fs.unlink(hunterArchive.archivePath).catch(err => logger.warn('[jobs/submit] failed to clean hunter archive', { msg: err.message }));
    }

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

    let updatedPrimaryCid;
    try {
      updatedPrimaryCid = await ipfsClient.uploadToIPFS(updatedPrimaryArchive.archivePath);
      logger.info('[jobs/submit] updated primary pinned', { updatedPrimaryCid });
    } finally {
      await fs.unlink(updatedPrimaryArchive.archivePath).catch(err => logger.warn('[jobs/submit] failed to clean updated primary archive', { msg: err.message }));
    }

    await jobStorage.addSubmission(jobId, {
      hunter,
      hunterCid,
      updatedPrimaryCid,
      fileCount: uploadedFiles.length,
      files: uploadedFiles.map(f => ({ name: f.originalname, size: f.size, description: fileDescriptions[f.originalname] }))
    });

    return res.json({
      success: true,
      message: 'Submission recorded successfully!',
      submission: {
        hunter,
        hunterCid,
        updatedPrimaryCid,
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
      if (f?.path) await fs.unlink(f.path).catch(err => logger.warn('[jobs/submit] failed to clean tmp file', { msg: err.message }));
    }
  }
});

// ---------- BOUNTY ID PATCH & RESOLVE (unchanged) ----------
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

    logger.info('[jobs/bountyId] updated', { jobId, bountyId });
    return res.json({ success: true, job });
  } catch (error) {
    logger.error('[jobs/bountyId] error', { msg: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Resolve endpoint left as in your working version…
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
              job.bountyId = bountyId; job.onChain = true; job.txHash = job.txHash ?? txHash;
              await jobStorage.writeStorage(storage);
              logger.info('[resolve] via tx', { jobId: jobIdParam, bountyId });
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
        job.bountyId = best; job.onChain = true;
        await jobStorage.writeStorage(storage);
        logger.info('[resolve] via state', { jobId: jobIdParam, bountyId: best, delta: bestDelta });
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

// ---------- SYNC STATUS (unchanged) ----------
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

module.exports = router;

