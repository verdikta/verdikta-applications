/**
 * Poster Routes
 * API endpoints for bounty creators to access and download archived submissions
 * 
 * All submissions are archived and made available to bounty posters through these endpoints.
 * Archives expire 30 days after bounty close, or 7 days after poster retrieves.
 */

const express = require('express');
const AdmZip = require('adm-zip');
const path = require('path');
const router = express.Router();
const logger = require('../utils/logger');
const jobStorage = require('../utils/jobStorage');

// Max bytes we'll send back as inline preview content
const PREVIEW_MAX_BYTES = 500 * 1024;
// Max ZIP size we're willing to fetch server-side for preview
const PREVIEW_ZIP_MAX_BYTES = 20 * 1024 * 1024;
// Max uncompressed size of any single entry we'll decompress (zip-bomb guard).
// Must be checked BEFORE calling entry.getData(), which decompresses fully
// into memory regardless of our downstream slicing.
const PREVIEW_ENTRY_MAX_BYTES = 5 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;

// DEFLATE's theoretical max expansion ratio is ~1032x. Adding headroom for
// other rarer compression methods, we use 1100. If an entry's compressedSize
// times this ratio exceeds our limit, refuse — the declared `size` field is
// attacker-controlled and cannot be trusted, but `compressedSize` is the
// actual bytes on disk and is bounded by the zip we already fetched.
const MAX_COMPRESSION_RATIO = 1100;
function entryBombs(entry, uncompressedLimit) {
  const declared = entry?.header?.size ?? 0;
  const compressed = entry?.header?.compressedSize ?? 0;
  if (declared > uncompressedLimit) return true;
  if (compressed * MAX_COMPRESSION_RATIO > uncompressedLimit) return true;
  return false;
}

const PREVIEWABLE_EXTS = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.json': 'json',
  '.csv': 'csv',
};

// Lazy-load archival service to avoid circular dependency issues
function getArchivalService() {
  try {
    const { getArchivalService: getService } = require('../utils/archivalService');
    return getService();
  } catch (e) {
    logger.warn('[posterRoutes] Archival service not available', { error: e.message });
    return null;
  }
}

// IPFS gateway URLs
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.io';
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud';

/**
 * GET /api/poster/:address/bounties
 * List all bounties created by this address with submission summaries
 */
router.get('/:address/bounties', async (req, res) => {
  try {
    const { address } = req.params;
    const { includeExpired } = req.query;

    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/i.test(address)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid address format',
        details: 'Address must be a valid Ethereum address (0x followed by 40 hex characters)'
      });
    }

    const normalizedAddress = address.toLowerCase();
    const jobs = await jobStorage.listJobs({ creator: normalizedAddress });

    const now = Math.floor(Date.now() / 1000);

    const summaries = jobs.map(job => {
      const submissions = (job.submissions || []).map(s => {
        const isExpired = s.archiveExpiresAt ? now > s.archiveExpiresAt : false;
        const daysUntilExpiry = s.archiveExpiresAt
          ? Math.max(0, Math.ceil((s.archiveExpiresAt - now) / (24 * 60 * 60)))
          : null;

        return {
          submissionId: s.submissionId,
          hunter: s.hunter,
          status: s.status,
          score: s.score ?? s.acceptance ?? null,
          submittedAt: s.submittedAt,
          hunterCid: s.hunterCid,
          files: s.files || [],
          // Archive info
          archiveStatus: s.archiveStatus || 'pending',
          archiveExpiresAt: s.archiveExpiresAt,
          daysUntilExpiry,
          isExpired,
          retrievedByPoster: s.retrievedByPoster || false,
          retrievedAt: s.retrievedAt
        };
      });

      // Filter out expired submissions unless explicitly requested
      const filteredSubmissions = includeExpired === 'true'
        ? submissions
        : submissions.filter(s => !s.isExpired);

      return {
        jobId: job.jobId,
        title: job.title,
        description: job.description,
        status: job.status,
        bountyAmount: job.bountyAmount,
        bountyAmountUSD: job.bountyAmountUSD,
        threshold: job.threshold,
        submissionCloseTime: job.submissionCloseTime,
        createdAt: job.createdAt,
        winner: job.winner,
        submissionCount: job.submissionCount,
        archivedSubmissionCount: filteredSubmissions.length,
        submissions: filteredSubmissions
      };
    });

    // Sort by creation date (newest first)
    summaries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return res.json({
      success: true,
      address: normalizedAddress,
      bountyCount: summaries.length,
      totalSubmissions: summaries.reduce((sum, b) => sum + b.archivedSubmissionCount, 0),
      bounties: summaries
    });

  } catch (error) {
    logger.error('[poster/bounties] error', { address: req.params.address, error: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to list bounties',
      details: error.message
    });
  }
});

/**
 * GET /api/poster/:address/submissions
 * List all submissions across all bounties for this poster (flat list)
 */
router.get('/:address/submissions', async (req, res) => {
  try {
    const { address } = req.params;
    const { status, archiveStatus, includeExpired, limit, offset } = req.query;

    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/i.test(address)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid address format'
      });
    }

    const normalizedAddress = address.toLowerCase();
    const jobs = await jobStorage.listJobs({ creator: normalizedAddress });

    const now = Math.floor(Date.now() / 1000);
    let allSubmissions = [];

    for (const job of jobs) {
      for (const sub of job.submissions || []) {
        const isExpired = sub.archiveExpiresAt ? now > sub.archiveExpiresAt : false;
        const daysUntilExpiry = sub.archiveExpiresAt
          ? Math.max(0, Math.ceil((sub.archiveExpiresAt - now) / (24 * 60 * 60)))
          : null;

        allSubmissions.push({
          // Job context
          jobId: job.jobId,
          jobTitle: job.title,
          bountyAmount: job.bountyAmount,
          jobStatus: job.status,
          // Submission details
          submissionId: sub.submissionId,
          hunter: sub.hunter,
          hunterCid: sub.hunterCid,
          status: sub.status,
          score: sub.score ?? sub.acceptance ?? null,
          submittedAt: sub.submittedAt,
          finalizedAt: sub.finalizedAt,
          files: sub.files || [],
          // Archive info
          archiveStatus: sub.archiveStatus || 'pending',
          archivedAt: sub.archivedAt,
          archiveVerifiedAt: sub.archiveVerifiedAt,
          archiveExpiresAt: sub.archiveExpiresAt,
          daysUntilExpiry,
          isExpired,
          retrievedByPoster: sub.retrievedByPoster || false,
          retrievedAt: sub.retrievedAt
        });
      }
    }

    // Apply filters
    if (status) {
      const statusUpper = status.toUpperCase();
      allSubmissions = allSubmissions.filter(s => s.status === statusUpper);
    }

    if (archiveStatus) {
      allSubmissions = allSubmissions.filter(s => s.archiveStatus === archiveStatus);
    }

    if (includeExpired !== 'true') {
      allSubmissions = allSubmissions.filter(s => !s.isExpired);
    }

    // Sort by submission time (newest first)
    allSubmissions.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

    // Apply pagination
    const total = allSubmissions.length;
    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
    const offsetNum = parseInt(offset, 10) || 0;
    const paginatedSubmissions = allSubmissions.slice(offsetNum, offsetNum + limitNum);

    return res.json({
      success: true,
      address: normalizedAddress,
      total,
      limit: limitNum,
      offset: offsetNum,
      count: paginatedSubmissions.length,
      submissions: paginatedSubmissions
    });

  } catch (error) {
    logger.error('[poster/submissions] error', { address: req.params.address, error: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to list submissions',
      details: error.message
    });
  }
});

/**
 * GET /api/poster/jobs/:jobId/submissions
 * List all submissions for a specific bounty (for poster)
 */
router.get('/jobs/:jobId/submissions', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { posterAddress, includeExpired } = req.query;

    const job = await jobStorage.getJob(jobId);

    // Optional: verify caller is the bounty creator
    if (posterAddress && job.creator.toLowerCase() !== posterAddress.toLowerCase()) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
        details: 'Only the bounty creator can view submission details'
      });
    }

    const now = Math.floor(Date.now() / 1000);

    let submissions = (job.submissions || []).map(sub => {
      const isExpired = sub.archiveExpiresAt ? now > sub.archiveExpiresAt : false;
      const daysUntilExpiry = sub.archiveExpiresAt
        ? Math.max(0, Math.ceil((sub.archiveExpiresAt - now) / (24 * 60 * 60)))
        : null;

      return {
        submissionId: sub.submissionId,
        hunter: sub.hunter,
        hunterCid: sub.hunterCid,
        evaluationCid: sub.evaluationCid,
        status: sub.status,
        score: sub.score || sub.acceptance,
        rejection: sub.rejection,
        submittedAt: sub.submittedAt,
        finalizedAt: sub.finalizedAt,
        files: sub.files || [],
        fileCount: sub.fileCount || (sub.files || []).length,
        // Archive info
        archiveStatus: sub.archiveStatus || 'pending',
        archivedAt: sub.archivedAt,
        archiveVerifiedAt: sub.archiveVerifiedAt,
        archiveExpiresAt: sub.archiveExpiresAt,
        daysUntilExpiry,
        isExpired,
        retrievedByPoster: sub.retrievedByPoster || false,
        retrievedAt: sub.retrievedAt,
        // Download URLs (only if not expired and has CID)
        downloadUrls: (!isExpired && sub.hunterCid) ? {
          pinata: `${PINATA_GATEWAY}/ipfs/${sub.hunterCid}`,
          ipfsIo: `${IPFS_GATEWAY}/ipfs/${sub.hunterCid}`,
          ipfsProtocol: `ipfs://${sub.hunterCid}`
        } : null
      };
    });

    // Filter expired unless requested
    if (includeExpired !== 'true') {
      submissions = submissions.filter(s => !s.isExpired);
    }

    return res.json({
      success: true,
      job: {
        jobId: job.jobId,
        title: job.title,
        status: job.status,
        bountyAmount: job.bountyAmount,
        threshold: job.threshold,
        submissionCloseTime: job.submissionCloseTime,
        creator: job.creator
      },
      submissionCount: submissions.length,
      submissions
    });

  } catch (error) {
    logger.error('[poster/job-submissions] error', { jobId: req.params.jobId, error: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to list submissions',
      details: error.message
    });
  }
});

/**
 * GET /api/poster/jobs/:jobId/submissions/:submissionId/download
 * Get download information for a specific submission
 * Marks the submission as retrieved, starting the 7-day countdown
 */
router.get('/jobs/:jobId/submissions/:submissionId/download', async (req, res) => {
  try {
    const { jobId, submissionId } = req.params;
    const { posterAddress } = req.query;

    const job = await jobStorage.getJob(jobId);

    // Verify caller is the bounty creator (required for download)
    if (!posterAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing posterAddress',
        details: 'posterAddress query parameter is required to verify ownership'
      });
    }

    if (job.creator.toLowerCase() !== posterAddress.toLowerCase()) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
        details: 'Only the bounty creator can download submissions'
      });
    }

    const submission = job.submissions?.find(s => s.submissionId === parseInt(submissionId));
    if (!submission) {
      return res.status(404).json({
        success: false,
        error: 'Submission not found'
      });
    }

    if (!submission.hunterCid) {
      return res.status(404).json({
        success: false,
        error: 'Submission has no archived content',
        details: 'The hunterCid is missing for this submission'
      });
    }

    // Check if archive has expired
    const now = Math.floor(Date.now() / 1000);
    if (submission.archiveExpiresAt && now > submission.archiveExpiresAt) {
      return res.status(410).json({
        success: false,
        error: 'Archive expired',
        details: 'This submission archive has expired and may no longer be available',
        expiredAt: new Date(submission.archiveExpiresAt * 1000).toISOString()
      });
    }

    // Mark as retrieved (starts 7-day countdown)
    const archivalService = getArchivalService();
    if (archivalService) {
      try {
        await archivalService.markAsRetrieved(jobId, submissionId, posterAddress);
      } catch (e) {
        logger.warn('[poster/download] Could not mark as retrieved', { error: e.message });
        // Continue anyway - don't block download
      }
    }

    // Calculate new expiry for response
    const newExpiresAt = now + (7 * 24 * 60 * 60);

    return res.json({
      success: true,
      message: 'Archive will expire 7 days from now. Please download and save locally.',
      submission: {
        submissionId: submission.submissionId,
        hunter: submission.hunter,
        hunterCid: submission.hunterCid,
        status: submission.status,
        score: submission.score ?? submission.acceptance ?? null,
        submittedAt: submission.submittedAt,
        files: submission.files || [],
        archiveStatus: submission.archiveStatus,
        archiveExpiresAt: newExpiresAt,
        daysUntilExpiry: 7,
        retrievedByPoster: true,
        retrievedAt: now
      },
      downloadUrls: {
        // Primary: Pinata gateway (faster, more reliable)
        primary: `${PINATA_GATEWAY}/ipfs/${submission.hunterCid}`,
        // Fallback: Public IPFS gateway
        fallback: `${IPFS_GATEWAY}/ipfs/${submission.hunterCid}`,
        // For IPFS-native apps
        ipfsProtocol: `ipfs://${submission.hunterCid}`
      },
      instructions: [
        'Click the primary download URL to download the submission archive',
        'The archive is a ZIP file containing the submitted work and manifest',
        'Save the file locally - the archive will expire in 7 days',
        'If primary fails, try the fallback URL'
      ]
    });

  } catch (error) {
    logger.error('[poster/download] error', {
      jobId: req.params.jobId,
      submissionId: req.params.submissionId,
      error: error.message
    });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Not found', details: error.message });
    }
    return res.status(500).json({
      success: false,
      error: 'Download failed',
      details: error.message
    });
  }
});

/**
 * GET /api/poster/jobs/:jobId/submissions/:submissionId/preview
 * Fetch the submission ZIP server-side, identify a text-like work product
 * (.md/.txt/.json/.csv) and return its contents inline for in-browser review.
 * Like /download, this marks the archive as retrieved (starts 7-day countdown).
 */
router.get('/jobs/:jobId/submissions/:submissionId/preview', async (req, res) => {
  try {
    const { jobId, submissionId } = req.params;
    const { posterAddress } = req.query;

    if (!posterAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing posterAddress',
        details: 'posterAddress query parameter is required to verify ownership'
      });
    }

    const job = await jobStorage.getJob(jobId);
    if (job.creator.toLowerCase() !== posterAddress.toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const submission = job.submissions?.find(s => s.submissionId === parseInt(submissionId));
    if (!submission) {
      return res.status(404).json({ success: false, error: 'Submission not found' });
    }
    if (!submission.hunterCid) {
      return res.status(404).json({ success: false, error: 'Submission has no archived content' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (submission.archiveExpiresAt && now > submission.archiveExpiresAt) {
      return res.status(410).json({ success: false, error: 'Archive expired' });
    }

    // Fetch ZIP from IPFS (Pinata primary, ipfs.io fallback)
    const gatewayUrls = [
      `${PINATA_GATEWAY}/ipfs/${submission.hunterCid}`,
      `${IPFS_GATEWAY}/ipfs/${submission.hunterCid}`,
    ];

    let zipBuffer = null;
    let fetchError = null;
    for (const url of gatewayUrls) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!resp.ok) {
          fetchError = `gateway ${url} returned ${resp.status}`;
          continue;
        }
        const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
        if (contentLength && contentLength > PREVIEW_ZIP_MAX_BYTES) {
          return res.status(413).json({
            success: false,
            error: 'Archive too large to preview',
            details: `ZIP is ${contentLength} bytes; max ${PREVIEW_ZIP_MAX_BYTES}. Use download instead.`,
          });
        }
        const arrayBuffer = await resp.arrayBuffer();
        if (arrayBuffer.byteLength > PREVIEW_ZIP_MAX_BYTES) {
          return res.status(413).json({
            success: false,
            error: 'Archive too large to preview',
            details: 'Use download instead.',
          });
        }
        zipBuffer = Buffer.from(arrayBuffer);
        break;
      } catch (e) {
        fetchError = e.message;
      }
    }

    if (!zipBuffer) {
      return res.status(502).json({
        success: false,
        error: 'Failed to fetch archive from IPFS',
        details: fetchError || 'unknown error',
      });
    }

    // Unzip and inspect manifest
    let zip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (e) {
      return res.status(422).json({
        success: false,
        error: 'Archive is not a valid ZIP',
        details: e.message,
      });
    }

    const manifestEntry = zip.getEntry('manifest.json');
    let previewFilename = null;
    let previewFormat = null;
    let mimeType = null;

    if (manifestEntry) {
      try {
        if (entryBombs(manifestEntry, MANIFEST_MAX_BYTES)) {
          logger.warn('[poster/preview] manifest too large, skipping', {
            declared: manifestEntry.header?.size,
            compressed: manifestEntry.header?.compressedSize,
            limit: MANIFEST_MAX_BYTES,
          });
          throw new Error('manifest exceeds size limit');
        }
        const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
        const additional = Array.isArray(manifest.additional) ? manifest.additional : [];
        // Pick first text-like entry from manifest
        for (const entry of additional) {
          const ext = path.extname(entry.filename || '').toLowerCase();
          if (PREVIEWABLE_EXTS[ext]) {
            previewFilename = entry.filename;
            previewFormat = PREVIEWABLE_EXTS[ext];
            mimeType = entry.type || null;
            break;
          }
        }
      } catch (e) {
        logger.warn('[poster/preview] manifest parse failed', { error: e.message });
      }
    }

    // Fallback: scan zip for any previewable file under submission/
    if (!previewFilename) {
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const ext = path.extname(entry.entryName).toLowerCase();
        if (PREVIEWABLE_EXTS[ext] && entry.entryName.startsWith('submission/')) {
          previewFilename = entry.entryName;
          previewFormat = PREVIEWABLE_EXTS[ext];
          break;
        }
      }
    }

    // Preview does NOT mark the archive as retrieved — IPFS content is public,
    // so a GET here doesn't prove the creator has a local copy. Only /download
    // starts the 7-day countdown.
    const commonResponse = {
      success: true,
      submission: {
        submissionId: submission.submissionId,
        hunter: submission.hunter,
        hunterCid: submission.hunterCid,
      },
    };

    if (!previewFilename) {
      return res.json({
        ...commonResponse,
        previewable: false,
        reason: 'no-text-file',
        details: 'No .md/.txt/.json/.csv work product found in this submission.',
      });
    }

    const fileEntry = zip.getEntry(previewFilename);
    if (!fileEntry) {
      return res.json({
        ...commonResponse,
        previewable: false,
        reason: 'not-found',
        filename: previewFilename,
      });
    }

    // Zip-bomb guard: refuse to decompress anything that could exceed our
    // per-entry limit, based on both declared and compressed size (see
    // entryBombs for rationale).
    if (entryBombs(fileEntry, PREVIEW_ENTRY_MAX_BYTES)) {
      return res.json({
        ...commonResponse,
        previewable: false,
        reason: 'too-large',
        filename: previewFilename,
        byteLength: fileEntry.header?.size ?? null,
        compressedBytes: fileEntry.header?.compressedSize ?? null,
        details: `File exceeds ${PREVIEW_ENTRY_MAX_BYTES} byte preview limit. Use download instead.`,
      });
    }

    const raw = fileEntry.getData();
    const truncated = raw.length > PREVIEW_MAX_BYTES;
    const content = (truncated ? raw.slice(0, PREVIEW_MAX_BYTES) : raw).toString('utf8');

    return res.json({
      ...commonResponse,
      previewable: true,
      filename: previewFilename,
      format: previewFormat,
      mimeType,
      byteLength: raw.length,
      truncated,
      content,
    });

  } catch (error) {
    logger.error('[poster/preview] error', {
      jobId: req.params.jobId,
      submissionId: req.params.submissionId,
      error: error.message,
    });
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Not found', details: error.message });
    }
    return res.status(500).json({
      success: false,
      error: 'Preview failed',
      details: error.message,
    });
  }
});

/**
 * GET /api/poster/jobs/:jobId/submissions/:submissionId/status
 * Get archive status for a specific submission (without triggering retrieval)
 */
router.get('/jobs/:jobId/submissions/:submissionId/status', async (req, res) => {
  try {
    const { jobId, submissionId } = req.params;

    const archivalService = getArchivalService();
    if (!archivalService) {
      return res.status(503).json({
        success: false,
        error: 'Archival service not available'
      });
    }

    const status = await archivalService.getSubmissionArchiveStatus(jobId, submissionId);

    return res.json({
      success: true,
      jobId: parseInt(jobId),
      submissionId: parseInt(submissionId),
      archive: status
    });

  } catch (error) {
    logger.error('[poster/status] error', { error: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to get archive status',
      details: error.message
    });
  }
});

/**
 * POST /api/poster/jobs/:jobId/submissions/:submissionId/verify
 * Force re-verification of a submission's pin (admin/debug endpoint)
 */
router.post('/jobs/:jobId/submissions/:submissionId/verify', async (req, res) => {
  try {
    const { jobId, submissionId } = req.params;
    const { posterAddress } = req.body;

    // Verify ownership
    const job = await jobStorage.getJob(jobId);
    if (posterAddress && job.creator.toLowerCase() !== posterAddress.toLowerCase()) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }

    const archivalService = getArchivalService();
    if (!archivalService) {
      return res.status(503).json({
        success: false,
        error: 'Archival service not available'
      });
    }

    const result = await archivalService.forceVerify(jobId, submissionId);

    return res.json({
      success: true,
      message: 'Pin verification completed',
      result
    });

  } catch (error) {
    logger.error('[poster/verify] error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: 'Verification failed',
      details: error.message
    });
  }
});

/**
 * GET /api/archival/status
 * Get archival service status (diagnostic endpoint)
 */
router.get('/archival/status', (req, res) => {
  try {
    const archivalService = getArchivalService();
    if (!archivalService) {
      return res.status(503).json({
        success: false,
        error: 'Archival service not initialized'
      });
    }

    return res.json({
      success: true,
      status: archivalService.getStatus()
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Failed to get archival status',
      details: error.message
    });
  }
});

/**
 * POST /api/archival/run
 * Manually trigger archival processing (admin endpoint)
 */
router.post('/archival/run', async (req, res) => {
  try {
    const archivalService = getArchivalService();
    if (!archivalService) {
      return res.status(503).json({
        success: false,
        error: 'Archival service not initialized'
      });
    }

    // Run asynchronously, don't wait
    archivalService.processSubmissions().catch(err => {
      logger.error('[archival/run] Manual run failed', { error: err.message });
    });

    return res.json({
      success: true,
      message: 'Archival processing triggered',
      status: archivalService.getStatus()
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Failed to trigger archival',
      details: error.message
    });
  }
});

module.exports = router;

