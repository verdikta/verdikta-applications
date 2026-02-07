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
const AdmZip = require('adm-zip');
const logger = require('../utils/logger');
const jobStorage = require('../utils/jobStorage');
const { config } = require('../config');
const archiveGenerator = require('../utils/archiveGenerator');
const { validateRubric, validateJuryNodes, isValidFileType, MAX_FILE_SIZE } = require('../utils/validation');
const { getVerdiktaService, isVerdiktaServiceAvailable } = require('../utils/verdiktaService');
const { validateBounty, IssueSeverity, IssueType } = require('../utils/bountyValidator');
const { getContractService } = require('../utils/contractService');

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

/**
 * GET /api/jobs/admin/stuck
 * Find all stuck submissions and diagnose them.
 * A submission is considered "stuck" if it's been pending for more than 10 minutes.
 */
router.get('/admin/stuck', async (req, res) => {
  const RPC_URL = config.rpcUrl;
  const ESCROW_ADDR = config.bountyEscrowAddress;
  const TIMEOUT_SECONDS = 10 * 60;

  try {
    const jobs = await jobStorage.listJobs({ includeOrphans: false });
    const jobList = jobs.jobs || jobs;
    const nowSeconds = Math.floor(Date.now() / 1000);

    const stuckSubmissions = [];
    const summary = {
      totalJobs: jobList.length,
      totalSubmissions: 0,
      stuckCount: 0,
      byStatus: {},
      byJob: {}
    };

    // Set up provider for on-chain checks
    let provider = null;
    let contract = null;
    if (RPC_URL && ESCROW_ADDR) {
      try {
        provider = new ethers.JsonRpcProvider(RPC_URL);
        contract = new ethers.Contract(ESCROW_ADDR, [
          'function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))'
        ], provider);
      } catch (e) {
        logger.warn('[admin/stuck] Could not initialize provider', { msg: e.message });
      }
    }

    for (const job of jobList) {
      if (!job.submissions || job.submissions.length === 0) continue;

      const onChainBountyId = job.jobId;

      for (const sub of job.submissions) {
        summary.totalSubmissions++;
        const status = (sub.status || '').toLowerCase();
        summary.byStatus[status] = (summary.byStatus[status] || 0) + 1;

        // Check if stuck (pending + timeout elapsed)
        const isPending = status === 'pending' || status === 'pendingverdikta' || status === 'pending_evaluation';
        const submittedAt = sub.submittedAt || 0;
        const elapsedSeconds = nowSeconds - submittedAt;
        const isStuck = isPending && elapsedSeconds >= TIMEOUT_SECONDS;

        if (isStuck) {
          summary.stuckCount++;
          summary.byJob[job.jobId] = (summary.byJob[job.jobId] || 0) + 1;

          const stuckInfo = {
            jobId: job.jobId,
            jobTitle: job.title,
            submissionId: sub.submissionId,
            hunter: sub.hunter,
            localStatus: sub.status,
            submittedAt,
            elapsedMinutes: Math.floor(elapsedSeconds / 60),
            hunterCid: sub.hunterCid,
            onChainBountyId,
            onChainStatus: null,
            canTimeout: false,
            issue: null
          };

          // Check on-chain status if possible
          if (contract && onChainBountyId != null) {
            try {
              const chainSub = await contract.getSubmission(onChainBountyId, sub.submissionId);
              const statusNames = ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid'];
              stuckInfo.onChainStatus = statusNames[Number(chainSub.status)] || `Unknown(${chainSub.status})`;
              stuckInfo.verdiktaAggId = chainSub.verdiktaAggId;

              if (stuckInfo.onChainStatus === 'Prepared') {
                stuckInfo.issue = 'Never started - startPreparedSubmission not called';
                stuckInfo.canTimeout = false;
              } else if (stuckInfo.onChainStatus === 'PendingVerdikta') {
                stuckInfo.canTimeout = true;
                stuckInfo.issue = 'Stuck in evaluation - eligible for timeout';
              } else {
                stuckInfo.issue = `Already finalized on-chain as ${stuckInfo.onChainStatus}`;
                stuckInfo.canTimeout = false;
              }
            } catch (chainErr) {
              stuckInfo.onChainStatus = 'error';
              stuckInfo.issue = `Chain read failed: ${chainErr.message}`;
            }
          } else {
            stuckInfo.issue = 'Cannot verify on-chain - missing bountyId or RPC';
          }

          stuckSubmissions.push(stuckInfo);
        }
      }
    }

    // Group recommendations
    const recommendations = [];
    const canTimeoutCount = stuckSubmissions.filter(s => s.canTimeout).length;
    const neverStartedCount = stuckSubmissions.filter(s => s.onChainStatus === 'Prepared').length;
    const alreadyFinalizedCount = stuckSubmissions.filter(s =>
      ['Failed', 'PassedPaid', 'PassedUnpaid'].includes(s.onChainStatus)
    ).length;

    if (canTimeoutCount > 0) {
      recommendations.push(`${canTimeoutCount} submission(s) can be timed out via failTimedOutSubmission`);
    }
    if (neverStartedCount > 0) {
      recommendations.push(`${neverStartedCount} submission(s) were never started - check LINK funding and startPreparedSubmission`);
    }
    if (alreadyFinalizedCount > 0) {
      recommendations.push(`${alreadyFinalizedCount} submission(s) are finalized on-chain but local status is stale - run sync`);
    }

    return res.json({
      success: true,
      summary,
      recommendations,
      stuckSubmissions
    });

  } catch (error) {
    logger.error('[admin/stuck] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to find stuck submissions', details: error.message });
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

/**
 * GET /api/jobs/admin/expired
 * List all expired bounties and their close eligibility.
 * An expired bounty can be closed if:
 * 1. On-chain status is Open
 * 2. Deadline has passed
 * 3. No submissions are in PendingVerdikta status
 */
router.get('/admin/expired', async (req, res) => {
  const RPC_URL = config.rpcUrl;
  const ESCROW_ADDR = config.bountyEscrowAddress;

  try {
    const jobs = await jobStorage.listJobs({ includeOrphans: false });
    const jobList = jobs.jobs || jobs;
    const nowSeconds = Math.floor(Date.now() / 1000);

    const expiredBounties = [];
    const summary = {
      totalExpired: 0,
      canCloseNow: 0,
      blockedByPendingEval: 0,
      alreadyClosed: 0,
      notOnChain: 0
    };

    // Set up provider for on-chain checks
    let provider = null;
    let contract = null;
    if (RPC_URL && ESCROW_ADDR) {
      try {
        provider = new ethers.JsonRpcProvider(RPC_URL);
        contract = new ethers.Contract(ESCROW_ADDR, [
          'function getBounty(uint256 bountyId) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions))',
          'function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))',
          'function submissionCount(uint256 bountyId) view returns (uint256)'
        ], provider);
      } catch (e) {
        logger.warn('[admin/expired] Could not initialize provider', { msg: e.message });
      }
    }

    for (const job of jobList) {
      // Check if deadline has passed
      const deadline = job.submissionCloseTime || 0;
      if (deadline === 0 || nowSeconds < deadline) continue;

      summary.totalExpired++;
      const onChainBountyId = job.jobId;

      const bountyInfo = {
        jobId: job.jobId,
        title: job.title,
        creator: job.creator,
        bountyAmount: job.bountyAmount,
        deadline,
        expiredMinutesAgo: Math.floor((nowSeconds - deadline) / 60),
        localStatus: job.status,
        onChainStatus: null,
        canClose: false,
        blockedBy: null,
        pendingSubmissions: []
      };

      if (onChainBountyId == null) {
        bountyInfo.blockedBy = 'Not linked to on-chain bounty';
        summary.notOnChain++;
        expiredBounties.push(bountyInfo);
        continue;
      }

      // Check on-chain status
      if (contract) {
        try {
          const chainBounty = await contract.getBounty(onChainBountyId);
          const statusNames = ['Open', 'Awarded', 'Closed'];
          bountyInfo.onChainStatus = statusNames[Number(chainBounty.status)] || `Unknown(${chainBounty.status})`;
          bountyInfo.payoutWei = chainBounty.payoutWei.toString();

          if (bountyInfo.onChainStatus === 'Closed') {
            bountyInfo.blockedBy = 'Already closed';
            summary.alreadyClosed++;
          } else if (bountyInfo.onChainStatus === 'Awarded') {
            bountyInfo.blockedBy = 'Already awarded to winner';
            summary.alreadyClosed++;
          } else if (bountyInfo.onChainStatus === 'Open') {
            // Check for pending submissions
            const subCount = Number(await contract.submissionCount(onChainBountyId));
            let hasPending = false;

            for (let i = 0; i < subCount; i++) {
              try {
                const chainSub = await contract.getSubmission(onChainBountyId, i);
                if (Number(chainSub.status) === 1) { // PendingVerdikta
                  hasPending = true;
                  bountyInfo.pendingSubmissions.push({
                    submissionId: i,
                    hunter: chainSub.hunter,
                    submittedAt: Number(chainSub.submittedAt)
                  });
                }
              } catch (subErr) {
                // Ignore individual submission errors
              }
            }

            if (hasPending) {
              bountyInfo.blockedBy = `${bountyInfo.pendingSubmissions.length} submission(s) still pending evaluation`;
              bountyInfo.canClose = false;
              summary.blockedByPendingEval++;
            } else {
              bountyInfo.canClose = true;
              summary.canCloseNow++;
            }
          }
        } catch (chainErr) {
          bountyInfo.onChainStatus = 'error';
          bountyInfo.blockedBy = `Chain read failed: ${chainErr.message}`;
        }
      }

      expiredBounties.push(bountyInfo);
    }

    return res.json({
      success: true,
      summary,
      expiredBounties
    });

  } catch (error) {
    logger.error('[admin/expired] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to list expired bounties', details: error.message });
  }
});

/**
 * POST /api/jobs/:jobId/close
 * Prepare transaction to close an expired bounty.
 * Returns encoded calldata for client to execute.
 *
 * On-chain requirements (from BountyEscrow.closeExpiredBounty):
 * - Bounty status must be Open
 * - Deadline must have passed
 * - No submissions in PendingVerdikta status
 * - Anyone can call (returns ETH to creator)
 */
router.post('/:jobId/close', async (req, res) => {
  const { jobId } = req.params;
  const RPC_URL = config.rpcUrl;
  const ESCROW_ADDR = config.bountyEscrowAddress;

  try {
    logger.info('[close] check', { jobId });

    const job = await jobStorage.getJob(jobId);
    const onChainBountyId = job.jobId;

    if (onChainBountyId == null) {
      return res.status(400).json({
        success: false,
        canClose: false,
        error: 'Job not on-chain',
        details: 'This job has not been registered on the blockchain yet'
      });
    }

    // Check deadline
    const nowSeconds = Math.floor(Date.now() / 1000);
    const deadline = job.submissionCloseTime || 0;

    if (nowSeconds < deadline) {
      return res.status(400).json({
        success: false,
        canClose: false,
        error: 'Deadline not passed',
        details: `Bounty expires in ${Math.ceil((deadline - nowSeconds) / 60)} minutes`,
        deadline
      });
    }

    // Check on-chain status and pending submissions
    if (!RPC_URL || !ESCROW_ADDR) {
      return res.status(500).json({
        success: false,
        canClose: false,
        error: 'Blockchain not configured'
      });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(ESCROW_ADDR, [
      'function getBounty(uint256 bountyId) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions))',
      'function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))',
      'function submissionCount(uint256 bountyId) view returns (uint256)'
    ], provider);

    const chainBounty = await contract.getBounty(onChainBountyId);
    const statusNames = ['Open', 'Awarded', 'Closed'];
    const onChainStatus = statusNames[Number(chainBounty.status)] || `Unknown(${chainBounty.status})`;

    if (onChainStatus === 'Closed') {
      return res.status(400).json({
        success: false,
        canClose: false,
        error: 'Already closed',
        details: 'This bounty has already been closed'
      });
    }

    if (onChainStatus === 'Awarded') {
      return res.status(400).json({
        success: false,
        canClose: false,
        error: 'Already awarded',
        details: 'This bounty was awarded to a winner'
      });
    }

    // Check for pending submissions
    const subCount = Number(await contract.submissionCount(onChainBountyId));
    const pendingSubmissions = [];

    for (let i = 0; i < subCount; i++) {
      try {
        const chainSub = await contract.getSubmission(onChainBountyId, i);
        if (Number(chainSub.status) === 1) { // PendingVerdikta
          pendingSubmissions.push({
            submissionId: i,
            hunter: chainSub.hunter
          });
        }
      } catch (subErr) {
        // Ignore individual submission errors
      }
    }

    if (pendingSubmissions.length > 0) {
      return res.status(400).json({
        success: false,
        canClose: false,
        error: 'Pending evaluations',
        details: `${pendingSubmissions.length} submission(s) still pending - timeout them first`,
        pendingSubmissions,
        hint: 'Call POST /api/jobs/:jobId/submissions/:subId/timeout for each pending submission'
      });
    }

    // All conditions met - return transaction data
    const iface = new ethers.Interface([
      'function closeExpiredBounty(uint256 bountyId)'
    ]);
    const calldata = iface.encodeFunctionData('closeExpiredBounty', [onChainBountyId]);

    logger.info('[close] conditions met', { jobId, onChainBountyId });

    return res.json({
      success: true,
      canClose: true,
      message: 'Bounty can be closed. Execute the transaction to return funds to creator.',
      transaction: {
        to: ESCROW_ADDR,
        data: calldata,
        value: '0',
        chainId: config.chainId
      },
      contractCall: {
        method: 'closeExpiredBounty',
        args: [onChainBountyId],
        abi: 'function closeExpiredBounty(uint256 bountyId)'
      },
      bounty: {
        jobId: job.jobId,
        title: job.title,
        creator: job.creator,
        payoutWei: chainBounty.payoutWei.toString(),
        expiredMinutesAgo: Math.floor((nowSeconds - deadline) / 60)
      }
    });

  } catch (error) {
    logger.error('[close] error', { jobId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, canClose: false, error: 'Job not found' });
    }
    return res.status(500).json({
      success: false,
      canClose: false,
      error: 'Failed to check close conditions',
      details: error.message
    });
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
   VALIDATE BOUNTY
   ============== */

/**
 * POST /api/jobs/validate
 * Validate an evaluation package CID before creating a bounty.
 * Use this to check format before committing ETH to a bounty.
 *
 * Body: { evaluationCid: "Qm...", classId?: number }
 * Response: { valid: boolean, errors: string[], warnings: string[] }
 */
router.post('/validate', async (req, res) => {
  const { evaluationCid, classId } = req.body;

  if (!evaluationCid) {
    return res.status(400).json({
      valid: false,
      errors: ['evaluationCid is required']
    });
  }

  try {
    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({
        valid: false,
        errors: ['IPFS client not available']
      });
    }

    let classMap;
    try {
      const common = require('@verdikta/common');
      classMap = common.classMap;
    } catch (e) {
      logger.warn('Could not load classMap for validation:', e.message);
    }

    const result = await validateBounty({
      evaluationCid,
      classId: classId || 128, // Default to class 128 if not specified
      ipfsClient,
      classMap
    });

    // Format response as simple errors/warnings arrays
    const errors = result.issues
      .filter(i => i.severity === 'error')
      .map(i => i.message);
    const warnings = result.issues
      .filter(i => i.severity === 'warning')
      .map(i => i.message);

    return res.json({
      valid: result.valid,
      errors,
      warnings,
      evaluationCid,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    logger.error('[validate-cid] error', { evaluationCid, msg: error.message });
    return res.status(500).json({
      valid: false,
      errors: [`Validation failed: ${error.message}`]
    });
  }
});

/**
 * GET /api/jobs/admin/validate-all
 * Batch validate all open bounties for format issues.
 * Stores validation results in job storage.
 */
router.get('/admin/validate-all', async (req, res) => {
  try {
    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({ error: 'IPFS client not available' });
    }

    let classMap;
    try {
      const common = require('@verdikta/common');
      classMap = common.classMap;
    } catch (e) {
      logger.warn('Could not load classMap for validation:', e.message);
    }

    const jobs = await jobStorage.listJobs({ includeOrphans: false });
    const jobList = jobs.jobs || jobs;

    // Only validate OPEN and EXPIRED bounties (ones people might submit to)
    const toValidate = jobList.filter(j =>
      j.status === 'OPEN' || j.status === 'EXPIRED'
    );

    const results = [];
    let validCount = 0;
    let invalidCount = 0;

    for (const job of toValidate) {
      try {
        // Use primaryCid - this is the evaluation package CID (ZIP with rubric)
        const evaluationCid = job.primaryCid || job.evaluationCid;

        const result = await validateBounty({
          evaluationCid,
          classId: job.classId,
          ipfsClient,
          classMap
        });

        // Store validation result in job
        await jobStorage.updateJob(job.jobId, {
          validationStatus: {
            valid: result.valid,
            issues: result.issues,
            checkedAt: new Date().toISOString()
          }
        });

        if (result.valid) {
          validCount++;
        } else {
          invalidCount++;
        }

        results.push({
          jobId: job.jobId,
          title: job.title,
          valid: result.valid,
          errorCount: result.issues.filter(i => i.severity === 'error').length,
          warningCount: result.issues.filter(i => i.severity === 'warning').length
        });

      } catch (e) {
        results.push({
          jobId: job.jobId,
          title: job.title,
          valid: false,
          error: e.message
        });
        invalidCount++;
      }
    }

    return res.json({
      success: true,
      summary: {
        total: toValidate.length,
        valid: validCount,
        invalid: invalidCount
      },
      results
    });

  } catch (error) {
    logger.error('[admin/validate-all] error', { msg: error.message });
    return res.status(500).json({ error: 'Batch validation failed', details: error.message });
  }
});

/**
 * GET /api/jobs/:jobId/validate
 * Validate a bounty's evaluation package format.
 * Checks if the package is a properly formatted ZIP with valid rubric.
 *
 * Returns:
 * - valid: boolean - Whether the bounty is properly formatted
 * - issues: Array<{type, severity, message}> - List of issues found
 * - format: object - Format detection info
 */
router.get('/:jobId/validate', async (req, res) => {
  const { jobId } = req.params;

  try {
    const job = await jobStorage.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({ error: 'IPFS client not available' });
    }

    // Try to get classMap for model validation
    let classMap;
    try {
      const common = require('@verdikta/common');
      classMap = common.classMap;
    } catch (e) {
      logger.warn('Could not load classMap for validation:', e.message);
    }

    // Use primaryCid - this is the evaluation package CID (ZIP with rubric)
    const evaluationCid = job.primaryCid || job.evaluationCid;

    const result = await validateBounty({
      evaluationCid,
      classId: job.classId,
      ipfsClient,
      classMap
    });

    return res.json({
      success: true,
      jobId: job.jobId,
      evaluationCid,
      valid: result.valid,
      issues: result.issues,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    logger.error('[validate] error', { jobId, msg: error.message });
    return res.status(500).json({
      error: 'Validation failed',
      details: error.message
    });
  }
});

/* ==============
   LIST JOBS
   ============== */

router.get('/', async (req, res) => {
  try {
    const {
      status, creator, minPayout, search,
      hideEnded, excludeStatuses, includeOrphans, limit = 50, offset = 0,
      // New filters for agents
      workProductType,    // Filter by type: "code", "writing", "research", etc. (comma-separated)
      minHoursLeft,       // Minimum hours until deadline (e.g., "2" = at least 2 hours left)
      maxHoursLeft,       // Maximum hours until deadline (e.g., "24" = deadline within 24 hours)
      excludeSubmittedBy, // Exclude jobs this address has already submitted to
      minBountyUSD,       // Minimum bounty in USD
      maxBountyUSD,       // Maximum bounty in USD
      classId,            // Filter by Verdikta class ID
      hasWinner,          // "true" = only jobs with winner, "false" = only jobs without winner
    } = req.query;
    logger.info('[jobs/list] filters', {
      status, creator, search, hideEnded, excludeStatuses, includeOrphans,
      workProductType, minHoursLeft, maxHoursLeft, excludeSubmittedBy, minBountyUSD, maxBountyUSD, classId, hasWinner
    });

    const filters = {
      // By default, don't show orphaned jobs
      includeOrphans: String(includeOrphans).toLowerCase() === 'true'
    };
    if (status) filters.status = String(status).toUpperCase();
    if (creator) filters.creator = creator;
    if (minPayout) filters.minPayout = minPayout;
    if (search) filters.search = search;

    let allJobs = await jobStorage.listJobs(filters);

    // Filter by work product type (comma-separated list, case-insensitive)
    if (workProductType) {
      const types = workProductType.split(',').map(t => t.trim().toLowerCase());
      allJobs = allJobs.filter(j => {
        const jobType = (j.workProductType || '').toLowerCase();
        return types.some(t => jobType.includes(t));
      });
    }

    // Filter by time remaining until deadline
    const nowSec = Math.floor(Date.now() / 1000);
    if (minHoursLeft) {
      const minSeconds = parseFloat(minHoursLeft) * 3600;
      allJobs = allJobs.filter(j => {
        const remaining = (j.submissionCloseTime || 0) - nowSec;
        return remaining >= minSeconds;
      });
    }
    if (maxHoursLeft) {
      const maxSeconds = parseFloat(maxHoursLeft) * 3600;
      allJobs = allJobs.filter(j => {
        const remaining = (j.submissionCloseTime || 0) - nowSec;
        return remaining <= maxSeconds && remaining > 0;
      });
    }

    // Exclude jobs that a specific address has already submitted to
    if (excludeSubmittedBy) {
      const excludeAddr = excludeSubmittedBy.toLowerCase();
      allJobs = allJobs.filter(j => {
        if (!j.submissions || j.submissions.length === 0) return true;
        return !j.submissions.some(s => (s.hunter || '').toLowerCase() === excludeAddr);
      });
    }

    // Filter by bounty amount in USD
    if (minBountyUSD) {
      const minUSD = parseFloat(minBountyUSD);
      allJobs = allJobs.filter(j => (j.bountyAmountUSD || 0) >= minUSD);
    }
    if (maxBountyUSD) {
      const maxUSD = parseFloat(maxBountyUSD);
      allJobs = allJobs.filter(j => (j.bountyAmountUSD || 0) <= maxUSD);
    }

    // Filter by Verdikta class ID
    if (classId) {
      const cid = parseInt(classId, 10);
      allJobs = allJobs.filter(j => j.classId === cid);
    }

    // Filter by whether job has a winner
    if (hasWinner === 'true') {
      allJobs = allJobs.filter(j => j.winner != null);
    } else if (hasWinner === 'false') {
      allJobs = allJobs.filter(j => j.winner == null);
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

    const jobSummaries = paginatedJobs.map(job => {
      // Compute time remaining for agent convenience
      const remainingSeconds = (job.submissionCloseTime || 0) - nowSec;
      const hoursLeft = remainingSeconds > 0 ? Math.round(remainingSeconds / 360) / 10 : 0; // 1 decimal place

      // Include validation status if available
      const validationInfo = job.validationStatus ? {
        hasIssues: !job.validationStatus.valid,
        issueCount: job.validationStatus.issues?.length || 0,
        errorCount: job.validationStatus.issues?.filter(i => i.severity === 'error').length || 0
      } : null;

      return {
        jobId: job.jobId,
        title: job.title,
        description: job.description,
        workProductType: job.workProductType,
        bountyAmount: job.bountyAmount,
        bountyAmountUSD: job.bountyAmountUSD,
        threshold: job.threshold,
        classId: job.classId,
        status: job.status,
        submissionCount: job.submissionCount,
        submissionOpenTime: job.submissionOpenTime,
        submissionCloseTime: job.submissionCloseTime,
        hoursLeft, // Computed field for agent convenience
        createdAt: job.createdAt,
        creator: job.creator, // Bounty creator address
        winner: job.winner,
        syncedFromBlockchain: job.syncedFromBlockchain || false,
        contractAddress: job.contractAddress, // Include for debugging
        validationStatus: validationInfo, // Include validation info if available
        submissions: job.submissions // Include for pending evaluation check
      };
    });

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
   LIST SUBMISSIONS FOR A JOB
   ================= */

/**
 * GET /api/jobs/:jobId/submissions
 * List all submissions for a bounty with simplified status.
 * Public endpoint - no authentication required.
 *
 * Statuses:
 * - PENDING_EVALUATION: Submitted, awaiting AI evaluation
 * - EVALUATED_PASSED: Evaluation complete, passed threshold (but didn't win)
 * - EVALUATED_FAILED: Evaluation complete, failed threshold
 * - WINNER: Passed threshold and received payout
 * - TIMED_OUT: Oracle timeout, no evaluation result
 *
 * Note: PREPARED submissions (not yet started on-chain) are excluded.
 */
router.get('/:jobId/submissions', async (req, res) => {
  try {
    const { jobId } = req.params;
    logger.info('[jobs/submissions] list', { jobId });

    const job = await jobStorage.getJob(jobId);
    const threshold = job.threshold || 0;

    // Map internal status to simplified public status
    function mapStatus(sub) {
      const status = (sub.status || '').toLowerCase();
      const score = sub.acceptance ?? sub.score ?? null;
      const hasScore = score !== null && score !== undefined && score > 0;

      // Check for winner (PassedPaid)
      if (status === 'passedpaid' || status === 'winner') {
        return 'WINNER';
      }

      // Check for timeout (Failed with zero scores and no justification)
      if (status === 'failed' || status === 'rejected') {
        const hasZeroScores = (sub.acceptance === 0 || sub.acceptance == null) &&
                             (sub.rejection === 0 || sub.rejection == null);
        const hasNoJustification = !sub.justificationCids || sub.justificationCids === '';
        if (hasZeroScores && hasNoJustification) {
          return 'TIMED_OUT';
        }
        return 'EVALUATED_FAILED';
      }

      // Check for passed but not winner (PassedUnpaid, Approved)
      if (status === 'passedunpaid' || status === 'passed' || status === 'approved' || status === 'accepted') {
        return 'EVALUATED_PASSED';
      }

      // Oracle evaluated but not yet finalized on BountyEscrow
      if (status === 'accepted_pending_claim') {
        return 'EVALUATED_PASSED';
      }
      if (status === 'rejected_pending_finalization') {
        return 'EVALUATED_FAILED';
      }

      // Check pending states
      if (status === 'pending' || status === 'pendingverdikta' || status === 'pending_evaluation') {
        // If has score, evaluation completed but status wasn't updated
        if (hasScore) {
          return score >= threshold ? 'EVALUATED_PASSED' : 'EVALUATED_FAILED';
        }
        return 'PENDING_EVALUATION';
      }

      // Prepared submissions are filtered out below, but handle edge case
      if (status === 'prepared') {
        return null; // Will be filtered
      }

      // Unknown status - treat as pending if no score, otherwise evaluate
      if (hasScore) {
        return score >= threshold ? 'EVALUATED_PASSED' : 'EVALUATED_FAILED';
      }
      return 'PENDING_EVALUATION';
    }

    // Filter out PREPARED submissions and map to response format
    const submissions = (job.submissions || [])
      .map(sub => {
        const mappedStatus = mapStatus(sub);
        if (!mappedStatus) return null; // Filter out PREPARED

        // Don't report score for pending/timed-out submissions — acceptance defaults
        // to 0 on-chain, which is misleading (looks like 0% instead of "not yet scored")
        const rawScore = sub.acceptance ?? sub.score ?? null;
        const suppressScore = mappedStatus === 'PENDING_EVALUATION' || mappedStatus === 'TIMED_OUT';
        const score = suppressScore ? null : rawScore;

        return {
          id: sub.submissionId,
          hunter: sub.hunter,
          hunterCid: sub.hunterCid || null,
          status: mappedStatus,
          score,
          submittedAt: sub.submittedAt || null,
          evaluatedAt: sub.finalizedAt || null
        };
      })
      .filter(Boolean); // Remove nulls (PREPARED submissions)

    return res.json({
      success: true,
      jobId: job.jobId,
      threshold,
      submissions
    });

  } catch (error) {
    logger.error('[jobs/submissions] error', { msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: 'Job not found', details: error.message });
    }
    return res.status(500).json({ error: 'Failed to list submissions', details: error.message });
  }
});

/* =================
   GET JOB DETAILS
   ================= */

router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    logger.info('[jobs/details] get', { jobId });

    let job;
    try {
      job = await jobStorage.getJob(jobId);
    } catch (e) {
      // Fallback: try jobId - 1 for legacy URLs (old 1-based IDs)
      const numId = parseInt(jobId);
      if (numId > 0) {
        try { job = await jobStorage.getJob(numId - 1); } catch {}
      }
      if (!job) throw e;
    }

    let rubricContent = null;
    let extractedJuryNodes = job.juryNodes || [];

    if (req.query.includeRubric === 'true') {
      const ipfsClient = req.app.locals.ipfsClient;

      // Try fetching from rubricCid first (legacy format)
      if (job.rubricCid) {
        try {
          const rawRubric = await ipfsClient.fetchFromIPFS(job.rubricCid);
          rubricContent = JSON.parse(rawRubric);
        } catch (err) {
          logger.warn('[jobs/details] failed to fetch rubric from rubricCid', { msg: err.message });
        }
      }

      // If no rubricCid or fetch failed, try extracting from primaryCid (ZIP archive)
      if (!rubricContent && job.primaryCid) {
        try {
          const archiveBuffer = await ipfsClient.fetchFromIPFS(job.primaryCid);
          const AdmZip = require('adm-zip');
          const zip = new AdmZip(archiveBuffer);
          const entries = zip.getEntries();

          // Look for manifest.json first (new Verdikta format)
          const manifestEntry = entries.find(e =>
            e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json')
          );

          if (manifestEntry) {
            const manifestText = zip.readAsText(manifestEntry);
            const manifest = JSON.parse(manifestText);

            // Extract jury nodes from manifest.juryParameters.AI_NODES
            if (manifest.juryParameters?.AI_NODES && extractedJuryNodes.length === 0) {
              extractedJuryNodes = manifest.juryParameters.AI_NODES.map(node => ({
                provider: node.AI_PROVIDER,
                model: node.AI_MODEL,
                runs: node.NO_COUNTS || 1,
                weight: node.WEIGHT || 1
              }));
            }

            // Look for grading rubric reference in manifest.additional
            const gradingRubricRef = manifest.additional?.find(a => a.name === 'gradingRubric');
            if (gradingRubricRef?.hash) {
              try {
                const rubricBuffer = await ipfsClient.fetchFromIPFS(gradingRubricRef.hash);
                const rubricText = rubricBuffer.toString('utf8');
                rubricContent = JSON.parse(rubricText);
              } catch (err) {
                logger.warn('[jobs/details] failed to fetch grading rubric from IPFS', {
                  hash: gradingRubricRef.hash,
                  msg: err.message
                });
              }
            }
          }

          // Fallback: look for rubric.json directly in ZIP (older format)
          if (!rubricContent) {
            const rubricEntry = entries.find(e =>
              e.entryName === 'rubric.json' || e.entryName.endsWith('/rubric.json')
            );
            if (rubricEntry) {
              const rubricText = zip.readAsText(rubricEntry);
              rubricContent = JSON.parse(rubricText);

              // Extract jury from rubric if present
              if (rubricContent.jury && Array.isArray(rubricContent.jury) && extractedJuryNodes.length === 0) {
                extractedJuryNodes = rubricContent.jury;
              }
            }
          }
        } catch (err) {
          logger.warn('[jobs/details] failed to extract from primaryCid', { msg: err.message });
        }
      }
    }

    return res.json({
      success: true,
      job: {
        ...job,
        syncedFromBlockchain: job.syncedFromBlockchain || false,
        rubricContent: rubricContent || null,
        juryNodes: extractedJuryNodes.length > 0 ? extractedJuryNodes : (job.juryNodes || [])
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

/* =================
   GET JOB RUBRIC (Agent-friendly endpoint)
   ================= */

/**
 * GET /api/jobs/:jobId/rubric
 * Returns the rubric content directly (not wrapped in job object).
 * Designed for AI agents that need to understand evaluation criteria.
 *
 * Response includes:
 * - rubric: The full rubric JSON with criteria, weights, etc.
 * - meta: Job context (title, threshold, classId) for reference
 */
router.get('/:jobId/rubric', async (req, res) => {
  try {
    const { jobId } = req.params;
    logger.info('[jobs/rubric] get', { jobId });

    const job = await jobStorage.getJob(jobId);

    if (!job.rubricCid) {
      return res.status(404).json({
        success: false,
        error: 'No rubric available',
        details: 'This job does not have a rubric CID'
      });
    }

    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({
        success: false,
        error: 'IPFS client not available',
        details: 'Server IPFS client is not initialized'
      });
    }

    let rubricContent;
    try {
      const rawContent = await withTimeout(
        ipfsClient.fetchFromIPFS(job.rubricCid),
        PIN_TIMEOUT_MS,
        'IPFS rubric fetch'
      );
      rubricContent = JSON.parse(rawContent);
    } catch (ipfsErr) {
      logger.error('[jobs/rubric] IPFS fetch failed', { jobId, cid: job.rubricCid, msg: ipfsErr.message });
      return res.status(502).json({
        success: false,
        error: 'Failed to fetch rubric from IPFS',
        details: ipfsErr.message,
        rubricCid: job.rubricCid,
        hint: 'You can try fetching directly from IPFS gateway'
      });
    }

    // Return rubric with useful job context
    return res.json({
      success: true,
      rubric: rubricContent,
      meta: {
        jobId: job.jobId,
        title: job.title,
        description: job.description,
        workProductType: job.workProductType,
        threshold: job.threshold,
        classId: job.classId,
        rubricCid: job.rubricCid,
        submissionCloseTime: job.submissionCloseTime,
        status: job.status
      }
    });

  } catch (error) {
    logger.error('[jobs/rubric] error', { msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Job not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to get rubric', details: error.message });
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
    : cb(new Error(`Invalid file type: ${file.mimetype} for file ${file.originalname}. Allowed: code files (.py, .sol, .cpp, .js, etc.), documents (.txt, .md, .pdf, .docx), images (.jpg, .png), and data files (.json, .xml, .yaml, .csv)`)),
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

    // NOTE: We do NOT create the submission record here anymore.
    // The submission record is created by POST /api/jobs/:jobId/submissions/confirm
    // AFTER the on-chain prepareSubmission transaction succeeds.
    // This prevents orphaned "Prepared" submissions when on-chain tx fails.

    return res.json({
      success: true,
      message: 'Files uploaded to IPFS successfully! Call /submissions/confirm after on-chain prepareSubmission succeeds.',
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

/* ==========================================
   CONFIRM SUBMISSION (after on-chain success)
   ========================================== */

/**
 * Create the backend submission record AFTER on-chain prepareSubmission succeeds.
 * This prevents orphaned "Prepared" submissions when on-chain tx fails.
 */
router.post('/:jobId/submissions/confirm', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { submissionId, hunter, hunterCid, evalWallet, fileCount, files } = req.body;

    if (submissionId === undefined || submissionId === null) {
      return res.status(400).json({ error: 'Missing submissionId', details: 'submissionId from on-chain event is required' });
    }
    if (!hunter || !/^0x[a-fA-F0-9]{40}$/.test(hunter)) {
      return res.status(400).json({ error: 'Invalid hunter address' });
    }
    if (!hunterCid) {
      return res.status(400).json({ error: 'Missing hunterCid' });
    }

    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if submission with this ID already exists
    const existingSubmission = job.submissions.find(s => s.submissionId === Number(submissionId));
    if (existingSubmission) {
      // Already confirmed - return success (idempotent)
      logger.info('[submissions/confirm] Submission already exists', { jobId, submissionId });
      return res.json({ success: true, submission: existingSubmission, alreadyExists: true });
    }

    // Create the submission record with the on-chain submissionId
    const submission = {
      submissionId: Number(submissionId),
      hunter,
      hunterCid,
      evalWallet: evalWallet || null,
      fileCount: fileCount || 0,
      files: files || [],
      submittedAt: Math.floor(Date.now() / 1000),
      status: 'Prepared',  // Will be updated to PendingVerdikta after startPreparedSubmission
      // Track which client type submitted this work
      clientType: req.clientType || 'unknown',
      clientId: req.clientId || null,
    };

    job.submissions.push(submission);
    job.submissionCount = job.submissions.length;

    await jobStorage.writeStorage(storage);

    logger.info('[submissions/confirm] Submission confirmed', { jobId, submissionId, hunter });
    return res.json({ success: true, submission });

  } catch (error) {
    logger.error('[submissions/confirm] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to confirm submission', details: error.message });
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

    job.txHash      = txHash;
    job.blockNumber = blockNumber;
    job.onChain     = true;

    // Reconcile jobId to match on-chain ID (aligned ID system)
    if (job.jobId !== Number(bountyId)) {
      logger.info('[jobs/bountyId] reconciling jobId to match on-chain ID', {
        oldJobId: job.jobId, newJobId: Number(bountyId)
      });
      job.legacyJobId = job.legacyJobId || job.jobId;
      job.jobId = Number(bountyId);
    }
    
    // Track which contract this job was created on
    const currentContract = jobStorage.getCurrentContractAddress();
    if (currentContract && !job.contractAddress) {
      job.contractAddress = currentContract;
    }

    await jobStorage.writeStorage(storage);

    logger.info('[jobs/bountyId] updated', { jobId, bountyId, contractAddress: job.contractAddress });
    return res.json({ success: true, job });
  } catch (error) {
    logger.error('[jobs/bountyId] error', { msg: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});


// Resolve endpoint (unchanged logic from your working version)
const RESOLVE_ABI = [
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256) view returns (address,string,uint64,uint8,uint256,uint256,uint64,uint8,address,uint256)"
];
function ro() { return new ethers.JsonRpcProvider(config.rpcUrl); }
function escrowRO() { return new ethers.Contract(config.bountyEscrowAddress, RESOLVE_ABI, ro()); }


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
              job.jobId = bountyId;
              job.onChain = true;
              job.txHash = job.txHash ?? txHash;
              // Track contract address
              const currentContract = jobStorage.getCurrentContractAddress();
              if (currentContract) job.contractAddress = currentContract;
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
        job.jobId = best;
        job.onChain = true;
        // Track contract address
        const currentContract = jobStorage.getCurrentContractAddress();
        if (currentContract) job.contractAddress = currentContract;
        await jobStorage.writeStorage(storage);
        logger.info('[resolve] via state', { jobId: jobIdParam, resolvedId: best, delta: bestDelta });
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
  const RPC_URL = config.rpcUrl;
  const ESCROW_ADDR = config.bountyEscrowAddress;

  logger.info('[refresh] Request received', { jobId, submissionId, RPC_URL: RPC_URL ? 'set' : 'NOT SET', ESCROW_ADDR });

  if (!RPC_URL || !ESCROW_ADDR) {
    return res.status(500).json({
      error: 'Blockchain not configured',
      details: 'RPC URL and BountyEscrow address must be configured'
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
      title: job.title,
      submissionsCount: job.submissions?.length || 0
    });

    const onChainId = job.jobId;

    if (onChainId == null) {
      logger.error('[refresh] No on-chain ID found', { jobId });
      return res.status(400).json({
        error: 'No on-chain bounty ID',
        details: 'This job has not been registered on-chain yet. Please check that the bounty was created on-chain.'
      });
    }

    logger.info('[refresh] Using on-chain bounty ID', { jobId, onChainId });

    const subId = parseInt(submissionId, 10);

    // Check if this submission was ever started on-chain
    const localSubmission = job.submissions?.find(s => s.submissionId === subId);
    if (localSubmission) {
      const isPreparedOnly = (localSubmission.status === 'Prepared' || localSubmission.status === 'PREPARED')
                             && !localSubmission.evalWallet
                             && !localSubmission.verdiktaAggId;
      if (isPreparedOnly) {
        logger.info('[refresh] Submission never started on-chain', { jobId, submissionId: subId });
        return res.status(400).json({
          error: 'Submission not on-chain',
          details: 'This submission was prepared but never started on-chain. It may be orphaned from a failed transaction.',
          submission: localSubmission
        });
      }
    }

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
    let chainStatus = statusMap[statusIndex] || 'UNKNOWN';

    // Receipt eligibility helpers
    const paidWinner = statusIndex === 3;      // PassedPaid
    const passedUnpaid = statusIndex === 4;    // PassedUnpaid

    // Scores are ALREADY normalized by the contract (divided by 10000)
    // The contract stores acceptance/rejection as 0-100, NOT 0-1000000
    let acceptScore = Number(sub.acceptance);
    let rejectScore = Number(sub.rejection);

    // For PendingVerdikta, check if oracle evaluation is already complete on VerdiktaAggregator
    if (statusIndex === 1) {
      const zeroHash = '0x' + '0'.repeat(64);
      const aggId = sub.verdiktaAggId;
      if (aggId && aggId !== zeroHash) {
        try {
          const cs = getContractService();
          const evalResult = await cs.checkEvaluationReady(onChainId, subId);
          if (evalResult.ready) {
            const threshold = job.threshold || 50;
            chainStatus = evalResult.scores.acceptance >= threshold
              ? 'ACCEPTED_PENDING_CLAIM'
              : 'REJECTED_PENDING_FINALIZATION';
            acceptScore = evalResult.scores.acceptance;
            rejectScore = evalResult.scores.rejection;
            logger.info('[refresh] Oracle evaluation complete, pending finalization', {
              jobId, submissionId: subId, chainStatus,
              acceptance: acceptScore, rejection: rejectScore
            });
          }
        } catch (err) {
          logger.debug('[refresh] Error checking aggregator', { error: err.message });
        }
      }
    }

    logger.info('[refresh] Status mapping', {
      rawStatus: sub.status?.toString?.() ?? sub.status,
      statusIndex,
      chainStatus
    });

    // Detect timeout vs actual evaluation failure
    // Timeout signature: REJECTED status with zero scores and empty justificationCids
    // This happens when Verdikta oracles don't respond (insufficient commits)
    let failureReason = null;
    if (statusIndex === 2) { // Failed/REJECTED
      const hasZeroScores = acceptScore === 0 && rejectScore === 0;
      const hasNoJustification = !sub.justificationCids || sub.justificationCids === '';
      if (hasZeroScores && hasNoJustification) {
        failureReason = 'ORACLE_TIMEOUT';
      } else {
        failureReason = 'EVALUATION_FAILED';
      }
    }

    logger.info('[refresh] Parsed submission from chain', {
      jobId,
      onChainId,
      submissionId: subId,
      statusIndex,
      chainStatus,
      acceptScore,
      rejectScore,
      failureReason
    });
    
    // Update local storage (reuse localSubmission from earlier check)
    if (localSubmission) {
      localSubmission.status = chainStatus;
      localSubmission.score = acceptScore;
      localSubmission.acceptance = acceptScore;
      localSubmission.rejection = rejectScore;
      localSubmission.evaluationCid = sub.evaluationCid;
      localSubmission.hunterCid = sub.hunterCid;
      localSubmission.justificationCids = sub.justificationCids;
      localSubmission.finalizedAt = Number(sub.finalizedAt);
      localSubmission.verdiktaAggId = sub.verdiktaAggId;
      localSubmission.failureReason = failureReason;
      localSubmission.paidWinner = paidWinner;
      localSubmission.passedUnpaid = passedUnpaid;

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
        hunter: sub.hunter,
        verdiktaAggId: sub.verdiktaAggId,
        failureReason,  // null, 'ORACLE_TIMEOUT', or 'EVALUATION_FAILED'
        paidWinner,
        passedUnpaid
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


/* =======================
   TIMEOUT STUCK SUBMISSION
   ======================= */

/**
 * POST /api/jobs/:jobId/submissions/:submissionId/timeout
 * Validate and prepare a timeout call for a stuck submission.
 *
 * On-chain requirements (from BountyEscrow.failTimedOutSubmission):
 * - Status must be PendingVerdikta (PENDING_EVALUATION)
 * - 10 minutes must have elapsed since submittedAt
 * - Anyone can call (no access restriction)
 *
 * Returns contract call data for client to execute the transaction.
 */
router.post('/:jobId/submissions/:submissionId/timeout', async (req, res) => {
  const { jobId, submissionId } = req.params;
  const TIMEOUT_SECONDS = 10 * 60; // 10 minutes per contract

  try {
    logger.info('[timeout] check', { jobId, submissionId });

    const job = await jobStorage.getJob(jobId);
    const subId = parseInt(submissionId, 10);
    const submission = job.submissions?.find(s => s.submissionId === subId);

    if (!submission) {
      return res.status(404).json({
        success: false,
        canTimeout: false,
        error: 'Submission not found',
        details: `No submission with ID ${submissionId} found for job ${jobId}`
      });
    }

    // Get on-chain IDs
    const onChainBountyId = job.jobId;
    const onChainSubmissionId = submission.onChainSubmissionId ?? submission.submissionId;

    if (onChainBountyId == null) {
      return res.status(400).json({
        success: false,
        canTimeout: false,
        error: 'Job not on-chain',
        details: 'This job has not been registered on the blockchain yet'
      });
    }

    // Check status - must be pending evaluation
    const status = (submission.status || '').toLowerCase();
    const isPending = status === 'pending' ||
                      status === 'pendingverdikta' ||
                      status === 'pending_evaluation';

    if (!isPending) {
      return res.status(400).json({
        success: false,
        canTimeout: false,
        error: 'Submission not pending',
        details: `Submission status is "${submission.status}". Only submissions with PENDING_EVALUATION status can be timed out.`,
        currentStatus: submission.status
      });
    }

    // Check time elapsed
    const submittedAt = submission.submittedAt || 0;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const elapsedSeconds = nowSeconds - submittedAt;
    const remainingSeconds = TIMEOUT_SECONDS - elapsedSeconds;

    if (remainingSeconds > 0) {
      const remainingMinutes = Math.ceil(remainingSeconds / 60);
      return res.status(400).json({
        success: false,
        canTimeout: false,
        error: 'Timeout not reached',
        details: `${remainingMinutes} minute(s) remaining until timeout is allowed`,
        submittedAt,
        timeoutAt: submittedAt + TIMEOUT_SECONDS,
        remainingSeconds
      });
    }

    // All conditions met - return contract call data
    const contractAddress = config.bountyEscrowAddress;

    if (!contractAddress) {
      return res.status(500).json({
        success: false,
        canTimeout: false,
        error: 'Contract not configured',
        details: 'BOUNTY_ESCROW_ADDRESS not set on server'
      });
    }

    // Encode the function call data
    const iface = new ethers.Interface([
      'function failTimedOutSubmission(uint256 bountyId, uint256 submissionId)'
    ]);
    const calldata = iface.encodeFunctionData('failTimedOutSubmission', [
      onChainBountyId,
      onChainSubmissionId
    ]);

    logger.info('[timeout] conditions met', {
      jobId,
      submissionId,
      onChainBountyId,
      onChainSubmissionId,
      elapsedSeconds
    });

    return res.json({
      success: true,
      canTimeout: true,
      message: 'Submission can be timed out. Execute the transaction to trigger refund.',
      // Ready-to-sign transaction object for bots
      transaction: {
        to: contractAddress,
        data: calldata,
        value: '0',
        chainId: config.chainId
      },
      // Human-readable contract call info
      contractCall: {
        method: 'failTimedOutSubmission',
        args: [onChainBountyId, onChainSubmissionId],
        abi: 'function failTimedOutSubmission(uint256 bountyId, uint256 submissionId)'
      },
      submission: {
        id: subId,
        hunter: submission.hunter,
        status: submission.status,
        submittedAt,
        elapsedMinutes: Math.floor(elapsedSeconds / 60)
      }
    });

  } catch (error) {
    logger.error('[timeout] error', { jobId, submissionId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        canTimeout: false,
        error: 'Not found',
        details: error.message
      });
    }
    return res.status(500).json({
      success: false,
      canTimeout: false,
      error: 'Failed to check timeout conditions',
      details: error.message
    });
  }
});


/* =======================
   DIAGNOSE STUCK SUBMISSION
   ======================= */

/**
 * GET /api/jobs/:jobId/submissions/:submissionId/diagnose
 * Deep diagnostic for stuck submissions - checks on-chain state, CID accessibility, and Verdikta status.
 * Helps identify why a submission is stuck or why timeout is reverting.
 */
router.get('/:jobId/submissions/:submissionId/diagnose', async (req, res) => {
  const { jobId, submissionId } = req.params;
  const RPC_URL = config.rpcUrl;
  const ESCROW_ADDR = config.bountyEscrowAddress;

  const diagnosis = {
    jobId: parseInt(jobId),
    submissionId: parseInt(submissionId),
    checks: {},
    issues: [],
    recommendations: []
  };

  try {
    logger.info('[diagnose] start', { jobId, submissionId });

    // 1. Check local storage state
    const job = await jobStorage.getJob(jobId);
    const subId = parseInt(submissionId, 10);
    const localSub = job.submissions?.find(s => s.submissionId === subId);

    diagnosis.checks.localStorage = {
      found: !!localSub,
      status: localSub?.status || null,
      submittedAt: localSub?.submittedAt || null,
      hunterCid: localSub?.hunterCid || null,
      evalWallet: localSub?.evalWallet || null,
      verdiktaAggId: localSub?.verdiktaAggId || null
    };

    if (!localSub) {
      diagnosis.issues.push('Submission not found in local storage');
    }

    // 2. Check on-chain state
    const onChainBountyId = job.jobId;
    diagnosis.checks.onChainIds = {
      bountyId: onChainBountyId,
      submissionId: subId
    };

    if (onChainBountyId == null) {
      diagnosis.issues.push('Job not linked to on-chain bounty');
      diagnosis.recommendations.push('Link job to on-chain bounty ID');
    } else if (RPC_URL && ESCROW_ADDR) {
      try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const contract = new ethers.Contract(ESCROW_ADDR, [
          'function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))'
        ], provider);

        const chainSub = await contract.getSubmission(onChainBountyId, subId);

        // Map status enum: 0=Prepared, 1=PendingVerdikta, 2=Failed, 3=PassedPaid, 4=PassedUnpaid
        const statusNames = ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid'];
        const chainStatus = statusNames[Number(chainSub.status)] || `Unknown(${chainSub.status})`;

        const submittedAtChain = Number(chainSub.submittedAt);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const elapsedSeconds = nowSeconds - submittedAtChain;
        const timeoutEligible = elapsedSeconds >= 600; // 10 minutes

        diagnosis.checks.onChain = {
          found: true,
          hunter: chainSub.hunter,
          status: chainStatus,
          statusCode: Number(chainSub.status),
          evaluationCid: chainSub.evaluationCid,
          hunterCid: chainSub.hunterCid,
          evalWallet: chainSub.evalWallet,
          verdiktaAggId: chainSub.verdiktaAggId,
          submittedAt: submittedAtChain,
          finalizedAt: Number(chainSub.finalizedAt),
          acceptance: Number(chainSub.acceptance),
          rejection: Number(chainSub.rejection),
          elapsedMinutes: Math.floor(elapsedSeconds / 60),
          timeoutEligible
        };

        // Analyze on-chain state
        if (chainStatus === 'Prepared') {
          diagnosis.issues.push('Submission is still in Prepared state - startPreparedSubmission was never called');
          diagnosis.recommendations.push('Call startPreparedSubmission to begin evaluation, or check if LINK was transferred to evalWallet');
        } else if (chainStatus === 'PendingVerdikta') {
          if (!chainSub.verdiktaAggId || chainSub.verdiktaAggId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
            diagnosis.issues.push('PendingVerdikta but no verdiktaAggId - evaluation may not have started properly');
          } else {
            diagnosis.checks.verdiktaAggId = chainSub.verdiktaAggId;

            // Check if oracle evaluation is already complete on VerdiktaAggregator
            try {
              const cs = getContractService();
              const evalResult = await cs.checkEvaluationReady(onChainBountyId, subId);
              if (evalResult.ready) {
                const threshold = job.threshold || 50;
                const passed = evalResult.scores.acceptance >= threshold;
                diagnosis.checks.oracleResult = {
                  complete: true,
                  acceptance: evalResult.scores.acceptance,
                  rejection: evalResult.scores.rejection,
                  threshold,
                  passed
                };
                diagnosis.recommendations.push(
                  passed
                    ? 'Oracle evaluation PASSED — call finalizeSubmission to claim bounty'
                    : 'Oracle evaluation did not meet threshold — call finalizeSubmission to finalize'
                );
              } else {
                diagnosis.checks.oracleResult = { complete: false };
                if (timeoutEligible) {
                  diagnosis.recommendations.push('Oracle not yet complete and submission is eligible for timeout - call failTimedOutSubmission');
                } else {
                  diagnosis.recommendations.push(`Oracle not yet complete. Wait ${Math.ceil((600 - elapsedSeconds) / 60)} more minute(s) for timeout eligibility`);
                }
              }
            } catch (aggErr) {
              diagnosis.checks.oracleResult = { complete: false, error: aggErr.message };
              if (timeoutEligible) {
                diagnosis.recommendations.push('Could not check oracle — submission is eligible for timeout');
              } else {
                diagnosis.recommendations.push(`Wait ${Math.ceil((600 - elapsedSeconds) / 60)} more minute(s) for timeout eligibility`);
              }
            }
          }
        } else if (chainStatus === 'Failed' || chainStatus === 'PassedPaid' || chainStatus === 'PassedUnpaid') {
          diagnosis.issues.push(`Submission already finalized with status: ${chainStatus}`);
          diagnosis.recommendations.push('No action needed - submission is complete');
        }

      } catch (chainErr) {
        diagnosis.checks.onChain = { found: false, error: chainErr.message };
        diagnosis.issues.push(`Failed to read on-chain state: ${chainErr.message}`);
      }
    }

    // 3. Check CID accessibility
    const ipfsClient = req.app.locals.ipfsClient;
    if (ipfsClient && localSub?.hunterCid) {
      try {
        // Just do a HEAD check or quick fetch
        const gatewayUrl = `${config.pinataGateway}/ipfs/${localSub.hunterCid}`;
        const cidCheck = await fetch(gatewayUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        diagnosis.checks.hunterCidAccessible = cidCheck.ok;
        if (!cidCheck.ok) {
          diagnosis.issues.push(`Hunter CID not accessible: ${cidCheck.status}`);
          diagnosis.recommendations.push('Verify hunterCid is pinned and accessible');
        }
      } catch (cidErr) {
        diagnosis.checks.hunterCidAccessible = false;
        diagnosis.issues.push(`Hunter CID check failed: ${cidErr.message}`);
      }
    }

    // 4. Check evaluation CID
    if (job.primaryCid) {
      try {
        const gatewayUrl = `${config.pinataGateway}/ipfs/${job.primaryCid}`;
        const cidCheck = await fetch(gatewayUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        diagnosis.checks.evaluationCidAccessible = cidCheck.ok;
        if (!cidCheck.ok) {
          diagnosis.issues.push(`Evaluation package CID not accessible: ${cidCheck.status}`);
          diagnosis.recommendations.push('Verify primaryCid (evaluation package) is pinned');
        }
      } catch (cidErr) {
        diagnosis.checks.evaluationCidAccessible = false;
        diagnosis.issues.push(`Evaluation CID check failed: ${cidErr.message}`);
      }
    }

    // 5. Summary
    diagnosis.summary = {
      issueCount: diagnosis.issues.length,
      status: diagnosis.issues.length === 0 ? 'healthy' : 'issues_found',
      canTimeout: diagnosis.checks.onChain?.status === 'PendingVerdikta' &&
                  diagnosis.checks.onChain?.timeoutEligible === true
    };

    return res.json({ success: true, diagnosis });

  } catch (error) {
    logger.error('[diagnose] error', { jobId, submissionId, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Diagnosis failed',
      details: error.message,
      partialDiagnosis: diagnosis
    });
  }
});


/* =======================
   GET EVALUATION REPORT (Agent-friendly endpoint)
   ======================= */

/**
 * GET /api/jobs/:jobId/submissions/:submissionId/evaluation
 * Returns the AI evaluation report for a submission.
 * Fetches justification content from IPFS so agents don't need direct IPFS access.
 *
 * Response includes:
 * - scores: acceptance/rejection scores and pass/fail status
 * - evaluation: The parsed AI evaluation report (criteria scores, feedback, etc.)
 * - meta: Submission and job context
 */
router.get('/:jobId/submissions/:submissionId/evaluation', async (req, res) => {
  const { jobId, submissionId } = req.params;

  try {
    logger.info('[evaluation] get', { jobId, submissionId });

    const job = await jobStorage.getJob(jobId);
    const subId = parseInt(submissionId, 10);
    const submission = job.submissions?.find(s => s.submissionId === subId);

    if (!submission) {
      return res.status(404).json({
        success: false,
        error: 'Submission not found',
        details: `No submission with ID ${submissionId} found for job ${jobId}`
      });
    }

    // Check if evaluation is complete (includes oracle-complete-but-not-finalized statuses)
    const hasEvaluation = submission.status === 'APPROVED' ||
                          submission.status === 'REJECTED' ||
                          submission.status === 'PassedPaid' ||
                          submission.status === 'PassedUnpaid' ||
                          submission.status === 'Failed' ||
                          submission.status === 'ACCEPTED_PENDING_CLAIM' ||
                          submission.status === 'REJECTED_PENDING_FINALIZATION';

    if (!hasEvaluation) {
      return res.status(400).json({
        success: false,
        error: 'Evaluation not complete',
        details: `Submission status is "${submission.status}". Evaluation results are only available after evaluation completes.`,
        status: submission.status,
        hint: 'Use POST /api/jobs/:jobId/submissions/:submissionId/refresh to check for updates'
      });
    }

    // Build scores response
    const scores = {
      acceptance: submission.acceptance ?? submission.score ?? null,
      rejection: submission.rejection ?? null,
      threshold: job.threshold,
      passed: (submission.acceptance ?? submission.score ?? 0) >= job.threshold,
      status: submission.status,
      failureReason: submission.failureReason || null
    };

    // Check if we have justification CIDs to fetch
    const justificationCids = submission.justificationCids;
    const evaluationCid = submission.evaluationCid;

    if (!justificationCids && !evaluationCid) {
      // No detailed evaluation available (e.g., oracle timeout)
      return res.json({
        success: true,
        scores,
        evaluation: null,
        evaluationAvailable: false,
        message: scores.failureReason === 'ORACLE_TIMEOUT'
          ? 'No evaluation report available - oracle timeout occurred'
          : 'No detailed evaluation report available',
        meta: {
          jobId: job.jobId,
          submissionId: subId,
          hunter: submission.hunter,
          submittedAt: submission.submittedAt,
          finalizedAt: submission.finalizedAt
        }
      });
    }

    // Fetch evaluation content from IPFS
    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({
        success: false,
        error: 'IPFS client not available',
        scores, // Still return scores even if IPFS fails
        justificationCids,
        evaluationCid,
        hint: 'Scores are available but detailed report requires IPFS'
      });
    }

    let evaluationContent = null;
    let fetchedFrom = null;

    // Try justificationCids first (contains the detailed AI feedback)
    if (justificationCids) {
      // justificationCids might be a single CID or comma-separated list
      const cids = justificationCids.split(',').map(c => c.trim()).filter(Boolean);

      for (const cid of cids) {
        try {
          const rawContent = await withTimeout(
            ipfsClient.fetchFromIPFS(cid),
            PIN_TIMEOUT_MS,
            'IPFS evaluation fetch'
          );

          // Try to parse as JSON
          try {
            const parsed = JSON.parse(rawContent);
            if (!evaluationContent) {
              evaluationContent = parsed;
              fetchedFrom = cid;
            } else if (Array.isArray(evaluationContent)) {
              evaluationContent.push(parsed);
            } else {
              evaluationContent = [evaluationContent, parsed];
            }
          } catch {
            // Not JSON, store as raw text
            if (!evaluationContent) {
              evaluationContent = { raw: rawContent, cid };
              fetchedFrom = cid;
            }
          }
        } catch (ipfsErr) {
          logger.warn('[evaluation] Failed to fetch justification CID', { cid, msg: ipfsErr.message });
        }
      }
    }

    // Fallback to evaluationCid if no justification content
    if (!evaluationContent && evaluationCid) {
      try {
        const rawContent = await withTimeout(
          ipfsClient.fetchFromIPFS(evaluationCid),
          PIN_TIMEOUT_MS,
          'IPFS evaluation fetch'
        );
        try {
          evaluationContent = JSON.parse(rawContent);
          fetchedFrom = evaluationCid;
        } catch {
          evaluationContent = { raw: rawContent, cid: evaluationCid };
          fetchedFrom = evaluationCid;
        }
      } catch (ipfsErr) {
        logger.warn('[evaluation] Failed to fetch evaluation CID', { cid: evaluationCid, msg: ipfsErr.message });
      }
    }

    if (!evaluationContent) {
      return res.status(502).json({
        success: false,
        error: 'Failed to fetch evaluation from IPFS',
        scores, // Still return scores
        justificationCids,
        evaluationCid,
        hint: 'You can try fetching directly from IPFS gateway using the CIDs above'
      });
    }

    return res.json({
      success: true,
      scores,
      evaluation: evaluationContent,
      evaluationAvailable: true,
      fetchedFrom,
      meta: {
        jobId: job.jobId,
        jobTitle: job.title,
        submissionId: subId,
        hunter: submission.hunter,
        hunterCid: submission.hunterCid,
        submittedAt: submission.submittedAt,
        finalizedAt: submission.finalizedAt,
        justificationCids,
        evaluationCid
      }
    });

  } catch (error) {
    logger.error('[evaluation] error', { jobId, submissionId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to get evaluation', details: error.message });
  }
});


/* =======================
   GET SUBMISSION CONTENT (Agent-friendly endpoint)
   ======================= */

/**
 * GET /api/jobs/:jobId/submissions/:submissionId/content
 * Returns the submission content (manifest, narrative, file list).
 * Fetches the hunter submission archive from IPFS and extracts metadata.
 *
 * Query params:
 * - includeFileContent=true: Include base64-encoded file content (for small text files only)
 * - file=<filename>: Return only a specific file's content
 *
 * Response includes:
 * - manifest: The submission manifest with file metadata
 * - narrative: The submission narrative (from primary_query.json)
 * - files: List of files with names, sizes, types
 * - meta: Submission and job context
 */
router.get('/:jobId/submissions/:submissionId/content', async (req, res) => {
  const { jobId, submissionId } = req.params;
  const { includeFileContent, file: requestedFile } = req.query;

  try {
    logger.info('[content] get', { jobId, submissionId, includeFileContent, requestedFile });

    const job = await jobStorage.getJob(jobId);
    const subId = parseInt(submissionId, 10);
    const submission = job.submissions?.find(s => s.submissionId === subId);

    if (!submission) {
      return res.status(404).json({
        success: false,
        error: 'Submission not found',
        details: `No submission with ID ${submissionId} found for job ${jobId}`
      });
    }

    const hunterCid = submission.hunterCid;
    if (!hunterCid) {
      return res.status(404).json({
        success: false,
        error: 'No submission content available',
        details: 'This submission does not have a hunterCid (no uploaded content)'
      });
    }

    // Fetch the submission archive from IPFS
    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({
        success: false,
        error: 'IPFS client not available',
        hunterCid,
        hint: 'You can fetch directly from IPFS gateway'
      });
    }

    let archiveBuffer;
    try {
      // fetchFromIPFS returns string, but we need buffer for ZIP
      // Try to get raw buffer if available, otherwise use gateway URL
      const gatewayUrl = `${process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud'}/ipfs/${hunterCid}`;
      const response = await withTimeout(
        fetch(gatewayUrl),
        PIN_TIMEOUT_MS * 2, // Give more time for archive download
        'IPFS archive fetch'
      );

      if (!response.ok) {
        throw new Error(`Gateway returned ${response.status}`);
      }

      archiveBuffer = Buffer.from(await response.arrayBuffer());
      logger.info('[content] Archive fetched', { jobId, submissionId, size: archiveBuffer.length });
    } catch (ipfsErr) {
      logger.error('[content] Failed to fetch archive', { hunterCid, msg: ipfsErr.message });
      return res.status(502).json({
        success: false,
        error: 'Failed to fetch submission archive from IPFS',
        details: ipfsErr.message,
        hunterCid,
        hint: 'You can try fetching directly from IPFS gateway'
      });
    }

    // Extract archive contents
    let zip;
    try {
      zip = new AdmZip(archiveBuffer);
    } catch (zipErr) {
      logger.error('[content] Failed to parse archive', { hunterCid, msg: zipErr.message });
      return res.status(500).json({
        success: false,
        error: 'Failed to parse submission archive',
        details: 'The archive may be corrupted or not a valid ZIP file',
        hunterCid
      });
    }

    const zipEntries = zip.getEntries();

    // Parse manifest.json
    let manifest = null;
    const manifestEntry = zipEntries.find(e => e.entryName === 'manifest.json');
    if (manifestEntry) {
      try {
        manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
      } catch (e) {
        logger.warn('[content] Failed to parse manifest.json', { msg: e.message });
      }
    }

    // Parse primary_query.json (contains narrative)
    let narrative = null;
    const queryEntry = zipEntries.find(e => e.entryName === 'primary_query.json');
    if (queryEntry) {
      try {
        const queryData = JSON.parse(queryEntry.getData().toString('utf8'));
        narrative = queryData.query || null;
      } catch (e) {
        logger.warn('[content] Failed to parse primary_query.json', { msg: e.message });
      }
    }

    // List submission files
    const submissionFiles = zipEntries
      .filter(e => e.entryName.startsWith('submission/') && !e.isDirectory)
      .map(e => {
        const filename = e.entryName.replace('submission/', '');
        const fileInfo = manifest?.additional?.find(a => a.filename === e.entryName || a.filename === `submission/${filename}`);

        return {
          filename,
          path: e.entryName,
          size: e.header.size,
          compressedSize: e.header.compressedSize,
          type: fileInfo?.type || 'application/octet-stream',
          description: fileInfo?.description || null
        };
      });

    // If a specific file was requested, return just that file
    if (requestedFile) {
      const fileEntry = zipEntries.find(e =>
        e.entryName === `submission/${requestedFile}` ||
        e.entryName === requestedFile
      );

      if (!fileEntry) {
        return res.status(404).json({
          success: false,
          error: 'File not found in submission',
          details: `No file named "${requestedFile}" found in the submission archive`,
          availableFiles: submissionFiles.map(f => f.filename)
        });
      }

      const fileData = fileEntry.getData();
      const fileInfo = submissionFiles.find(f => f.filename === requestedFile || f.path === fileEntry.entryName);

      // For text files, return as string; for binary, return base64
      const isTextFile = /\.(txt|md|json|js|ts|py|sol|html|css|xml|yaml|yml|csv|log)$/i.test(requestedFile);

      return res.json({
        success: true,
        file: {
          ...fileInfo,
          content: isTextFile ? fileData.toString('utf8') : fileData.toString('base64'),
          encoding: isTextFile ? 'utf8' : 'base64'
        },
        meta: {
          jobId: job.jobId,
          submissionId: subId,
          hunterCid
        }
      });
    }

    // Build response with optional file content
    const filesWithContent = includeFileContent === 'true'
      ? submissionFiles.map(f => {
          const entry = zipEntries.find(e => e.entryName === f.path);
          if (!entry) return f;

          // Only include content for small text files (< 100KB)
          const isSmallTextFile = f.size < 100000 &&
            /\.(txt|md|json|js|ts|py|sol|html|css|xml|yaml|yml|csv)$/i.test(f.filename);

          if (isSmallTextFile) {
            return {
              ...f,
              content: entry.getData().toString('utf8'),
              encoding: 'utf8'
            };
          }

          return {
            ...f,
            content: null,
            contentNote: f.size >= 100000 ? 'File too large' : 'Binary file - use ?file=<filename> to fetch'
          };
        })
      : submissionFiles;

    return res.json({
      success: true,
      manifest,
      narrative,
      files: filesWithContent,
      fileCount: submissionFiles.length,
      totalSize: submissionFiles.reduce((sum, f) => sum + f.size, 0),
      meta: {
        jobId: job.jobId,
        jobTitle: job.title,
        submissionId: subId,
        hunter: submission.hunter,
        hunterCid,
        submittedAt: submission.submittedAt,
        status: submission.status
      }
    });

  } catch (error) {
    logger.error('[content] error', { jobId, submissionId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to get submission content', details: error.message });
  }
});


/* =======================
   ESTIMATE SUBMISSION FEE (Agent-friendly endpoint)
   ======================= */

/**
 * GET /api/jobs/:jobId/estimate-fee
 * POST /api/jobs/estimate-fee (with custom jury config)
 *
 * Estimates the LINK token cost for submitting to a bounty.
 * This helps agents budget before committing to a submission.
 *
 * The fee depends on:
 * - Number of AI models in the jury
 * - Number of runs per model
 * - Number of iterations
 * - Current max oracle fee from Verdikta aggregator
 *
 * Response includes:
 * - estimatedLinkCost: Estimated LINK tokens needed
 * - breakdown: How the estimate was calculated
 * - parameters: Fee parameters to use in prepareSubmission
 */
router.get('/:jobId/estimate-fee', async (req, res) => {
  const { jobId } = req.params;

  try {
    logger.info('[estimate-fee] get', { jobId });

    const job = await jobStorage.getJob(jobId);

    // Get jury configuration from the job
    const juryNodes = job.juryNodes || [];
    const iterations = job.iterations || 1;

    // Calculate the fee estimate
    const estimate = await calculateFeeEstimate(juryNodes, iterations);

    return res.json({
      success: true,
      ...estimate,
      meta: {
        jobId: job.jobId,
        title: job.title,
        classId: job.classId,
        juryNodes: juryNodes.length,
        iterations
      }
    });

  } catch (error) {
    logger.error('[estimate-fee] error', { jobId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Job not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to estimate fee', details: error.message });
  }
});

/**
 * POST /api/jobs/estimate-fee
 * Estimate fee with custom jury configuration (without needing a job)
 *
 * Body:
 * - juryNodes: Array of {provider, model, runs, weight}
 * - iterations: Number of evaluation iterations (default: 1)
 */
router.post('/estimate-fee', async (req, res) => {
  try {
    const { juryNodes = [], iterations = 1 } = req.body;

    logger.info('[estimate-fee] post', { juryNodesCount: juryNodes.length, iterations });

    if (!Array.isArray(juryNodes) || juryNodes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid jury configuration',
        details: 'juryNodes must be a non-empty array'
      });
    }

    const estimate = await calculateFeeEstimate(juryNodes, iterations);

    return res.json({
      success: true,
      ...estimate,
      meta: {
        juryNodes: juryNodes.length,
        iterations
      }
    });

  } catch (error) {
    logger.error('[estimate-fee] error', { msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to estimate fee', details: error.message });
  }
});

/**
 * Calculate fee estimate based on jury configuration
 */
async function calculateFeeEstimate(juryNodes, iterations) {
  // Default fee parameters (fallback values)
  // These are conservative estimates based on typical Verdikta pricing
  let maxOracleFeeWei = BigInt('3000000000000000'); // 0.003 LINK per oracle call
  let aggregatorConfigAvailable = false;

  // Try to get actual maxOracleFee from Verdikta aggregator
  if (isVerdiktaServiceAvailable()) {
    try {
      const verdiktaService = getVerdiktaService();
      const aggConfig = await verdiktaService.getAggregatorConfig();
      if (aggConfig.maxOracleFee) {
        // Convert from LINK string to wei
        const parsed = parseFloat(aggConfig.maxOracleFee);
        if (parsed > 0) {
          maxOracleFeeWei = BigInt(Math.floor(parsed * 1e18));
          aggregatorConfigAvailable = true;
        }
      }
    } catch (err) {
      logger.warn('[estimate-fee] Could not get aggregator config', { msg: err.message });
    }
  }

  // Calculate total oracle calls
  // Each jury node makes (runs) calls, repeated for each iteration
  let totalCalls = 0;
  for (const node of juryNodes) {
    const runs = node.runs || 1;
    totalCalls += runs;
  }
  totalCalls *= iterations;

  // Base cost estimate (fixed overhead per evaluation)
  const baseCostWei = BigInt('1000000000000000'); // 0.001 LINK

  // Calculate raw cost: baseCost + (totalCalls × maxOracleFee)
  const oracleCostWei = BigInt(totalCalls) * maxOracleFeeWei;
  const rawCostWei = baseCostWei + oracleCostWei;

  // Add safety margin (20% buffer for gas price fluctuations, etc.)
  const safetyMargin = BigInt(120); // 120%
  const estimatedCostWei = (rawCostWei * safetyMargin) / BigInt(100);

  // Convert to LINK (human-readable)
  const estimatedLinkCost = Number(estimatedCostWei) / 1e18;
  const rawLinkCost = Number(rawCostWei) / 1e18;
  const maxOracleFeeLINK = Number(maxOracleFeeWei) / 1e18;

  // Recommended prepareSubmission parameters
  // These are the values agents should use when calling prepareSubmission
  const recommendedParams = {
    alpha: '500',                                    // Reputation weight (0-1000), 500 = balanced
    maxOracleFee: maxOracleFeeWei.toString(),       // Per-oracle fee cap
    estimatedBaseCost: baseCostWei.toString(),     // Base cost
    maxFeeBasedScaling: '1200000000000000000'      // 1.2x scaling factor (18 decimals)
  };

  return {
    estimatedLinkCost: Math.round(estimatedLinkCost * 10000) / 10000, // 4 decimal places
    estimatedLinkCostWei: estimatedCostWei.toString(),
    breakdown: {
      baseCost: Number(baseCostWei) / 1e18,
      oracleCalls: totalCalls,
      maxOracleFeePerCall: maxOracleFeeLINK,
      oracleCostTotal: Number(oracleCostWei) / 1e18,
      rawCost: rawLinkCost,
      safetyMarginPercent: 20,
      finalEstimate: estimatedLinkCost
    },
    recommendedParams,
    aggregatorConfigAvailable,
    note: aggregatorConfigAvailable
      ? 'Fee based on current Verdikta aggregator configuration'
      : 'Fee based on default estimates (Verdikta aggregator not available)',
    warning: 'This is an estimate. Actual cost may vary based on network conditions and oracle availability.'
  };
}

module.exports = router;

