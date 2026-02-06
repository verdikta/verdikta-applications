/**
 * Archival Service
 * Ensures submission CIDs remain pinned and accessible to bounty posters
 * 
 * TTL Policy:
 * - Submissions archived for 30 days after bounty's submissionCloseTime
 * - If poster retrieves, expiry changes to 7 days from retrieval
 * - Poster should plan on personal archival upon retrieval
 */

const logger = require('./logger');
const jobStorage = require('./jobStorage');

// Pinata API configuration
const PINATA_BASE = (process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud').replace(/\/+$/, '');
const PINATA_JWT = process.env.IPFS_PINNING_KEY || '';

// Archive settings (configurable via environment)
const ARCHIVE_TTL_DAYS = parseInt(process.env.ARCHIVE_TTL_DAYS || '30', 10);
const ARCHIVE_AFTER_RETRIEVAL_DAYS = parseInt(process.env.ARCHIVE_AFTER_RETRIEVAL_DAYS || '7', 10);
const PIN_VERIFY_INTERVAL_HOURS = parseInt(process.env.PIN_VERIFY_INTERVAL_HOURS || '1', 10);
const VERIFICATION_RATE_LIMIT_MS = parseInt(process.env.VERIFICATION_RATE_LIMIT_MS || '250', 10);

/**
 * Get properly formatted Pinata auth header
 */
function getPinataAuthHeader() {
  if (!PINATA_JWT) return null;
  return PINATA_JWT.toLowerCase().startsWith('bearer ')
    ? PINATA_JWT
    : `Bearer ${PINATA_JWT}`;
}

/**
 * Utility function to add delay between API calls (rate limiting)
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class ArchivalService {
  constructor(ipfsClient) {
    this.ipfsClient = ipfsClient;
    this.isProcessing = false;
    this.lastRunTime = null;
    this.stats = { verified: 0, repinned: 0, failed: 0, skipped: 0, expired: 0 };
  }

  /**
   * Process all submissions that need archival attention
   * Called by syncService after each sync cycle
   */
  async processSubmissions() {
    if (this.isProcessing) {
      logger.debug('[archival] Already processing, skipping');
      return this.stats;
    }

    this.isProcessing = true;
    const startTime = Date.now();
    this.stats = { verified: 0, repinned: 0, failed: 0, skipped: 0, expired: 0 };

    try {
      const storage = await jobStorage.readStorage();
      const now = Math.floor(Date.now() / 1000);
      let storageModified = false;

      for (const job of storage.jobs) {
        // Skip jobs that shouldn't be processed
        if (this.shouldSkipJob(job)) {
          continue;
        }

        for (const submission of job.submissions || []) {
          // Skip submissions without content
          if (!submission.hunterCid) {
            continue;
          }

          // Check if submission archive has expired
          if (this.isExpired(submission, job, now)) {
            // Mark as expired but don't unpin (Pinata handles cleanup via their own policies)
            if (submission.archiveStatus !== 'expired') {
              submission.archiveStatus = 'expired';
              storageModified = true;
              this.stats.expired++;
              logger.info('[archival] Submission archive expired', {
                jobId: job.jobId,
                submissionId: submission.submissionId,
                hunterCid: submission.hunterCid
              });
            }
            continue;
          }

          try {
            const wasModified = await this.processSubmission(job, submission, now);
            if (wasModified) {
              storageModified = true;
            }
            
            // Rate limiting: Add delay between submissions to avoid saturating Pinata API
            // This prevents HTTP 429 (Too Many Requests) errors when verifying many CIDs
            if (VERIFICATION_RATE_LIMIT_MS > 0) {
              await delay(VERIFICATION_RATE_LIMIT_MS);
            }
          } catch (err) {
            logger.error('[archival] Failed to process submission', {
              jobId: job.jobId,
              submissionId: submission.submissionId,
              error: err.message
            });
            this.stats.failed++;
          }
        }
      }

      // Persist any updates
      if (storageModified) {
        await jobStorage.writeStorage(storage);
      }

      this.lastRunTime = new Date();
      const duration = Date.now() - startTime;

      logger.info('[archival] Cycle complete', {
        duration: `${duration}ms`,
        ...this.stats
      });

      return this.stats;

    } catch (error) {
      logger.error('[archival] Processing failed', { error: error.message });
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single submission - verify pin exists, repin if needed
   * @returns {boolean} Whether the submission was modified
   */
  async processSubmission(job, submission, now) {
    const { hunterCid } = submission;
    let modified = false;

    // Check if we recently verified this pin
    const lastVerified = submission.archiveVerifiedAt || 0;
    const verifyIntervalSec = PIN_VERIFY_INTERVAL_HOURS * 60 * 60;
    
    if (now - lastVerified < verifyIntervalSec) {
      this.stats.skipped++;
      return false; // Skip, recently verified
    }

    // Set initial expiry if not already set
    if (!submission.archiveExpiresAt) {
      const bountyCloseTime = job.submissionCloseTime || job.createdAt || now;
      submission.archiveExpiresAt = bountyCloseTime + (ARCHIVE_TTL_DAYS * 24 * 60 * 60);
      modified = true;
    }

    // Set archivedAt if not already set
    if (!submission.archivedAt) {
      submission.archivedAt = now;
      modified = true;
    }

    // Verify the pin still exists on Pinata
    const isPinned = await this.verifyPin(hunterCid);

    if (isPinned) {
      submission.archiveVerifiedAt = now;
      submission.archiveStatus = 'verified';
      this.stats.verified++;
      modified = true;
    } else {
      // Pin is missing - attempt to re-pin
      logger.warn('[archival] Pin missing, attempting recovery', {
        jobId: job.jobId,
        submissionId: submission.submissionId,
        hunterCid
      });

      const repinned = await this.pinByHash(hunterCid, {
        name: `submission-${job.jobId}-${submission.submissionId}`,
        jobId: job.jobId,
        submissionId: submission.submissionId,
        hunter: submission.hunter
      });

      if (repinned) {
        submission.archiveVerifiedAt = now;
        submission.archiveStatus = 'repinned';
        submission.lastRepinnedAt = now;
        this.stats.repinned++;
        logger.info('[archival] Successfully re-pinned', { hunterCid });
      } else {
        submission.archiveStatus = 'failed';
        submission.lastFailedAt = now;
        this.stats.failed++;
        logger.error('[archival] Re-pin failed - content may be lost', {
          jobId: job.jobId,
          submissionId: submission.submissionId,
          hunterCid
        });
      }
      modified = true;
    }

    return modified;
  }

  /**
   * Check if a CID is pinned on Pinata
   * @param {string} cid - The IPFS CID to check
   * @returns {Promise<boolean>} Whether the CID is currently pinned
   */
  async verifyPin(cid) {
    const authHeader = getPinataAuthHeader();
    if (!authHeader) {
      logger.warn('[archival] No Pinata JWT configured, assuming pinned');
      return true;
    }

    try {
      const url = `${PINATA_BASE}/data/pinList?hashContains=${cid}&status=pinned`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authHeader }
      });

      if (!response.ok) {
        logger.warn('[archival] Pinata pinList API error', {
          status: response.status,
          cid
        });
        // On API error, assume pinned to avoid false alarms
        return true;
      }

      const data = await response.json();
      return data.count > 0;

    } catch (error) {
      logger.error('[archival] Pin verification network error', {
        cid,
        error: error.message
      });
      // On network error, assume pinned
      return true;
    }
  }

  /**
   * Pin existing IPFS content by hash using Pinata's pinByHash endpoint
   * This finds the content on the IPFS network and pins it to Pinata
   * @param {string} cid - The IPFS CID to pin
   * @param {object} metadata - Optional metadata for the pin
   * @returns {Promise<boolean>} Whether the pin was successful
   */
  async pinByHash(cid, metadata = {}) {
    const authHeader = getPinataAuthHeader();
    if (!authHeader) {
      logger.warn('[archival] No Pinata JWT configured, cannot re-pin');
      return false;
    }

    try {
      const url = `${PINATA_BASE}/pinning/pinByHash`;
      const body = {
        hashToPin: cid,
        pinataMetadata: {
          name: metadata.name || `archived-${cid.slice(-12)}`,
          keyvalues: {
            archivedAt: new Date().toISOString(),
            jobId: String(metadata.jobId || ''),
            submissionId: String(metadata.submissionId || ''),
            hunter: metadata.hunter || '',
            source: 'verdikta-archival'
          }
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn('[archival] pinByHash API error', {
          cid,
          status: response.status,
          body: text.slice(0, 200)
        });
        return false;
      }

      const result = await response.json();
      logger.debug('[archival] pinByHash success', { cid, result });
      return true;

    } catch (error) {
      logger.error('[archival] pinByHash network error', {
        cid,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Check if a submission's archive has expired
   */
  isExpired(submission, job, now) {
    // If explicitly marked with expiry time, use that
    if (submission.archiveExpiresAt) {
      return now > submission.archiveExpiresAt;
    }

    // Otherwise calculate based on bounty close time
    const bountyCloseTime = job.submissionCloseTime || job.createdAt || 0;
    const defaultExpiry = bountyCloseTime + (ARCHIVE_TTL_DAYS * 24 * 60 * 60);
    return now > defaultExpiry;
  }

  /**
   * Determine if a job should be skipped for archival processing
   */
  shouldSkipJob(job) {
    // Skip orphaned jobs
    if (job.status === 'ORPHANED') return true;

    // Skip jobs with no submissions
    if (!job.submissions || job.submissions.length === 0) return true;

    return false;
  }

  /**
   * Mark a submission as retrieved by poster
   * Changes expiry to 7 days from now
   * @param {number|string} jobId - The job ID
   * @param {number|string} submissionId - The submission ID
   * @param {string} posterAddress - The address that retrieved it
   * @returns {Promise<object>} The updated submission
   */
  async markAsRetrieved(jobId, submissionId, posterAddress) {
    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const submission = job.submissions?.find(s => s.submissionId === parseInt(submissionId));
    if (!submission) {
      throw new Error(`Submission ${submissionId} not found in job ${jobId}`);
    }

    const now = Math.floor(Date.now() / 1000);

    // Update retrieval metadata
    submission.retrievedByPoster = true;
    submission.retrievedAt = now;
    submission.retrieverAddress = posterAddress;

    // Set new expiry: 7 days from retrieval
    submission.archiveExpiresAt = now + (ARCHIVE_AFTER_RETRIEVAL_DAYS * 24 * 60 * 60);

    await jobStorage.writeStorage(storage);

    logger.info('[archival] Submission marked as retrieved', {
      jobId,
      submissionId,
      posterAddress,
      newExpiry: new Date(submission.archiveExpiresAt * 1000).toISOString()
    });

    return submission;
  }

  /**
   * Get archival status for a specific submission
   */
  async getSubmissionArchiveStatus(jobId, submissionId) {
    const job = await jobStorage.getJob(jobId);
    const submission = job.submissions?.find(s => s.submissionId === parseInt(submissionId));

    if (!submission) {
      throw new Error(`Submission ${submissionId} not found`);
    }

    const now = Math.floor(Date.now() / 1000);

    return {
      hunterCid: submission.hunterCid,
      archiveStatus: submission.archiveStatus || 'unknown',
      archivedAt: submission.archivedAt,
      archiveVerifiedAt: submission.archiveVerifiedAt,
      archiveExpiresAt: submission.archiveExpiresAt,
      isExpired: submission.archiveExpiresAt ? now > submission.archiveExpiresAt : false,
      retrievedByPoster: submission.retrievedByPoster || false,
      retrievedAt: submission.retrievedAt,
      daysUntilExpiry: submission.archiveExpiresAt
        ? Math.max(0, Math.ceil((submission.archiveExpiresAt - now) / (24 * 60 * 60)))
        : null
    };
  }

  /**
   * Force re-verification of a specific submission's pin
   */
  async forceVerify(jobId, submissionId) {
    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const submission = job.submissions?.find(s => s.submissionId === parseInt(submissionId));
    if (!submission || !submission.hunterCid) {
      throw new Error(`Submission ${submissionId} not found or has no CID`);
    }

    // Clear last verified time to force re-check
    submission.archiveVerifiedAt = 0;

    const now = Math.floor(Date.now() / 1000);
    await this.processSubmission(job, submission, now);
    await jobStorage.writeStorage(storage);

    return {
      hunterCid: submission.hunterCid,
      archiveStatus: submission.archiveStatus,
      archiveVerifiedAt: submission.archiveVerifiedAt
    };
  }

  /**
   * Get service status and statistics
   */
  getStatus() {
    return {
      lastRunTime: this.lastRunTime,
      isProcessing: this.isProcessing,
      lastStats: this.stats,
      config: {
        archiveTtlDays: ARCHIVE_TTL_DAYS,
        archiveAfterRetrievalDays: ARCHIVE_AFTER_RETRIEVAL_DAYS,
        pinVerifyIntervalHours: PIN_VERIFY_INTERVAL_HOURS,
        verificationRateLimitMs: VERIFICATION_RATE_LIMIT_MS,
        pinataConfigured: !!PINATA_JWT
      }
    };
  }
}

// Singleton instance
let archivalService = null;

/**
 * Initialize the archival service
 * @param {object} ipfsClient - The IPFS client instance
 * @returns {ArchivalService} The initialized service
 */
function initializeArchivalService(ipfsClient) {
  if (archivalService) {
    logger.warn('[archival] Service already initialized, returning existing instance');
    return archivalService;
  }

  archivalService = new ArchivalService(ipfsClient);
  logger.info('[archival] Service initialized', {
    archiveTtlDays: ARCHIVE_TTL_DAYS,
    archiveAfterRetrievalDays: ARCHIVE_AFTER_RETRIEVAL_DAYS
  });

  return archivalService;
}

/**
 * Get the archival service instance
 * @returns {ArchivalService} The service instance
 * @throws {Error} If service not initialized
 */
function getArchivalService() {
  if (!archivalService) {
    throw new Error('Archival service not initialized. Call initializeArchivalService first.');
  }
  return archivalService;
}

module.exports = {
  initializeArchivalService,
  getArchivalService,
  ArchivalService
};

