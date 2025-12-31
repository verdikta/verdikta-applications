/**
 * Job Storage Utility
 * Local storage for jobs/bounties synced from blockchain
 * Blockchain is the source of truth for all status changes
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

const STORAGE_FILE = path.join(__dirname, '../data/jobs.json');

// Get current contract address from environment
function getCurrentContractAddress() {
  return (process.env.BOUNTY_ESCROW_ADDRESS || '').toLowerCase();
}

/**
 * Initialize storage file if it doesn't exist
 */
async function initStorage() {
  try {
    const dataDir = path.dirname(STORAGE_FILE);
    await fs.mkdir(dataDir, { recursive: true });

    try {
      await fs.access(STORAGE_FILE);
    } catch {
      // File doesn't exist, create it
      await fs.writeFile(STORAGE_FILE, JSON.stringify({ jobs: [], nextId: 1 }, null, 2));
      logger.info('Initialized job storage file');
    }
  } catch (error) {
    logger.error('Error initializing storage:', error);
    throw error;
  }
}

/**
 * Read all jobs from storage
 */
async function readStorage() {
  try {
    await initStorage();
    const content = await fs.readFile(STORAGE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    logger.error('Error reading storage:', error);
    return { jobs: [], nextId: 1 };
  }
}

/**
 * Write jobs to storage
 */
async function writeStorage(data) {
  try {
    await fs.writeFile(STORAGE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    logger.error('Error writing storage:', error);
    throw error;
  }
}

/**
 * Create a new job
 */
async function createJob(jobData) {
  try {
    const storage = await readStorage();
    const contractAddress = getCurrentContractAddress();

    const job = {
      jobId: storage.nextId,
      ...jobData,
      status: 'OPEN',
      createdAt: Math.floor(Date.now() / 1000),
      submissionCount: 0,
      submissions: [],
      winner: null,
      // Track which contract this job belongs to
      contractAddress: contractAddress || null
    };

    storage.jobs.push(job);
    storage.nextId += 1;

    await writeStorage(storage);

    logger.info('Job created', { jobId: job.jobId, title: job.title, contractAddress });

    return job;
  } catch (error) {
    logger.error('Error creating job:', error);
    throw error;
  }
}

/**
 * Get a job by ID
 * NOTE: Status is synced from blockchain - no auto-updates here
 */
async function getJob(jobId) {
  try {
    const storage = await readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    return job;
  } catch (error) {
    logger.error('Error getting job:', error);
    throw error;
  }
}

/**
 * Update a job by ID
 */
async function updateJob(jobId, updates) {
  try {
    const storage = await readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    Object.assign(job, updates);
    await writeStorage(storage);

    logger.info('Job updated', { jobId, updates: Object.keys(updates) });
    return job;
  } catch (error) {
    logger.error('Error updating job:', error);
    throw error;
  }
}

/**
 * List all jobs with optional filters
 * NOTE: Status is synced from blockchain - no auto-updates here
 * 
 * @param {Object} filters - Filter options
 * @param {string} filters.status - Filter by status
 * @param {string} filters.creator - Filter by creator address
 * @param {number} filters.minPayout - Filter by minimum payout
 * @param {string} filters.search - Search in title/description
 * @param {boolean} filters.currentContractOnly - Only show jobs from current contract (default: true)
 * @param {boolean} filters.includeOrphans - Include orphaned jobs (default: false)
 */
async function listJobs(filters = {}) {
  try {
    const storage = await readStorage();
    let jobs = storage.jobs;
    const currentContract = getCurrentContractAddress();

    // One-time normalization: ensure all job.status values are UPPERCASE
    let normalized = false;
    for (const j of jobs) {
      const uc = String(j.status).toUpperCase();
      if (j.status !== uc) {
        j.status = uc;
        normalized = true;
      }
    }
    if (normalized) {
      await writeStorage(storage);
      logger.info('Normalized job statuses to UPPERCASE');
    }

    // By default, only show jobs from current contract (unless explicitly disabled)
    // This filters out orphaned jobs from old contracts
    const currentContractOnly = filters.currentContractOnly !== false;
    const includeOrphans = filters.includeOrphans === true;
    
    if (currentContractOnly && currentContract && !includeOrphans) {
      jobs = jobs.filter(j => {
        // Include jobs that:
        // 1. Match current contract address
        // 2. Have no contract address set (legacy jobs - need migration)
        // 3. Are not marked as orphaned
        const jobContract = (j.contractAddress || '').toLowerCase();
        const matchesContract = !jobContract || jobContract === currentContract;
        const notOrphaned = j.status !== 'ORPHANED';
        return matchesContract && notOrphaned;
      });
    }

    // Apply filters
    if (filters.status) {
      const want = String(filters.status).toUpperCase();
      jobs = jobs.filter(j => String(j.status).toUpperCase() === want);
    }

    if (filters.creator) {
      jobs = jobs.filter(j =>
        j.creator.toLowerCase() === filters.creator.toLowerCase()
      );
    }

    if (filters.minPayout) {
      jobs = jobs.filter(j => j.bountyAmount >= parseFloat(filters.minPayout));
    }

    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      jobs = jobs.filter(j =>
        j.title.toLowerCase().includes(searchLower) ||
        j.description.toLowerCase().includes(searchLower)
      );
    }

    // Sort by creation date (newest first)
    jobs.sort((a, b) => b.createdAt - a.createdAt);

    return jobs;
  } catch (error) {
    logger.error('Error listing jobs:', error);
    throw error;
  }
}

/**
 * Update job status
 */
async function updateJobStatus(jobId, status) {
  try {
    const storage = await readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    job.status = String(status).toUpperCase();
    await writeStorage(storage);

    logger.info('Job status updated', { jobId, status });

    return job;
  } catch (error) {
    logger.error('Error updating job status:', error);
    throw error;
  }
}

/**
 * Add a submission to a job
 */
async function addSubmission(jobId, submissionData) {
  try {
    const storage = await readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    // Check if job is still open
    // NOTE: We check cached status, but frontend also verifies on-chain before submitting
    if (job.status !== 'OPEN') {
      throw new Error(`Job ${jobId} is not accepting submissions (status: ${job.status})`);
    }

    // Use 0-based indexing to match on-chain submission IDs
    // The contract uses 0-based array indices for submissions
    const submission = {
      submissionId: job.submissions.length,  // 0-based to match contract
      ...submissionData,
      submittedAt: Math.floor(Date.now() / 1000),
      // Start as "Prepared" - not on-chain yet. Status changes to "PendingVerdikta"
      // when startPreparedSubmission() is called on-chain
      status: 'Prepared'
    };

    job.submissions.push(submission);
    job.submissionCount += 1;

    await writeStorage(storage);

    logger.info('Submission added to job', {
      jobId,
      submissionId: submission.submissionId,
      hunter: submissionData.hunter
    });

    return job;
  } catch (error) {
    logger.error('Error adding submission:', error);
    throw error;
  }
}

/**
 * Cancel/remove a submission (only for Prepared status)
 */
async function cancelSubmission(jobId, submissionId) {
  try {
    const storage = await readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const subIndex = job.submissions.findIndex(s => s.submissionId === parseInt(submissionId));
    if (subIndex === -1) {
      throw new Error(`Submission ${submissionId} not found`);
    }

    const submission = job.submissions[subIndex];

    // Only allow canceling Prepared submissions (not on-chain yet)
    if (submission.status !== 'Prepared' && submission.status !== 'PREPARED') {
      throw new Error(`Cannot cancel submission with status ${submission.status}. Only Prepared submissions can be cancelled.`);
    }

    // Remove the submission
    job.submissions.splice(subIndex, 1);
    job.submissionCount = Math.max(0, (job.submissionCount || 1) - 1);

    await writeStorage(storage);

    logger.info('Submission cancelled', { jobId, submissionId });

    return job;
  } catch (error) {
    logger.error('Error cancelling submission:', error);
    throw error;
  }
}

/**
 * Update submission with evaluation result
 */
async function updateSubmissionResult(jobId, submissionId, result) {
  try {
    const storage = await readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const submission = job.submissions.find(s => s.submissionId === submissionId);

    if (!submission) {
      throw new Error(`Submission ${submissionId} not found`);
    }

    submission.result = result;
    submission.status = result.outcome === 'FUND' ? 'PASSED' : 'FAILED';
    submission.evaluatedAt = Math.floor(Date.now() / 1000);

    // If this submission passed and no winner yet, mark as winner
    if (result.outcome === 'FUND' && !job.winner) {
      job.winner = submission.hunter;
      job.status = 'AWARDED'; // Use AWARDED not COMPLETED
    }

    await writeStorage(storage);

    logger.info('Submission result updated', {
      jobId,
      submissionId,
      outcome: result.outcome
    });

    return job;
  } catch (error) {
    logger.error('Error updating submission result:', error);
    throw error;
  }
}

/**
 * Find orphaned jobs (jobs that reference a different contract)
 * Returns jobs that exist in storage but don't belong to current contract
 */
async function findOrphanedJobs() {
  try {
    const storage = await readStorage();
    const currentContract = getCurrentContractAddress();
    
    if (!currentContract) {
      logger.warn('No current contract address set, cannot find orphans');
      return [];
    }

    const orphans = storage.jobs.filter(j => {
      const jobContract = (j.contractAddress || '').toLowerCase();
      // Orphaned if: has a contract address AND it doesn't match current
      // Jobs with no contract address are legacy and need migration, not orphaning
      return jobContract && jobContract !== currentContract;
    });

    return orphans;
  } catch (error) {
    logger.error('Error finding orphaned jobs:', error);
    throw error;
  }
}

/**
 * Mark orphaned jobs as ORPHANED status
 * This prevents them from showing in listings but preserves the data
 */
async function markOrphanedJobs() {
  try {
    const storage = await readStorage();
    const currentContract = getCurrentContractAddress();
    
    if (!currentContract) {
      logger.warn('No current contract address set');
      return { marked: 0 };
    }

    let marked = 0;
    for (const job of storage.jobs) {
      const jobContract = (job.contractAddress || '').toLowerCase();
      if (jobContract && jobContract !== currentContract && job.status !== 'ORPHANED') {
        logger.info('Marking job as orphaned', { 
          jobId: job.jobId, 
          jobContract,
          currentContract 
        });
        job.status = 'ORPHANED';
        job.orphanedAt = Math.floor(Date.now() / 1000);
        job.previousStatus = job.status;
        marked++;
      }
    }

    if (marked > 0) {
      await writeStorage(storage);
      logger.info(`Marked ${marked} orphaned jobs`);
    }

    return { marked };
  } catch (error) {
    logger.error('Error marking orphaned jobs:', error);
    throw error;
  }
}

/**
 * Delete orphaned jobs permanently
 * USE WITH CAUTION - this deletes data
 */
async function deleteOrphanedJobs() {
  try {
    const storage = await readStorage();
    const currentContract = getCurrentContractAddress();
    
    if (!currentContract) {
      throw new Error('No current contract address set');
    }

    const before = storage.jobs.length;
    storage.jobs = storage.jobs.filter(j => {
      const jobContract = (j.contractAddress || '').toLowerCase();
      // Keep if: no contract set (legacy) OR matches current contract
      return !jobContract || jobContract === currentContract;
    });
    const deleted = before - storage.jobs.length;

    if (deleted > 0) {
      await writeStorage(storage);
      logger.info(`Deleted ${deleted} orphaned jobs`);
    }

    return { deleted, remaining: storage.jobs.length };
  } catch (error) {
    logger.error('Error deleting orphaned jobs:', error);
    throw error;
  }
}

/**
 * Migrate legacy jobs (add contract address to jobs that don't have one)
 * Only migrates jobs that have an onChainId and can be verified on current contract
 */
async function migrateLegacyJobs(verifyOnChain = null) {
  try {
    const storage = await readStorage();
    const currentContract = getCurrentContractAddress();
    
    if (!currentContract) {
      throw new Error('No current contract address set');
    }

    let migrated = 0;
    let orphaned = 0;

    for (const job of storage.jobs) {
      // Skip jobs that already have a contract address
      if (job.contractAddress) continue;
      
      // If job has onChainId, try to verify it exists on current contract
      if (job.onChainId != null && verifyOnChain) {
        try {
          const exists = await verifyOnChain(job.onChainId);
          if (exists) {
            job.contractAddress = currentContract;
            migrated++;
          } else {
            // Mark as orphan - doesn't exist on current contract
            job.status = 'ORPHANED';
            job.orphanedAt = Math.floor(Date.now() / 1000);
            orphaned++;
          }
        } catch (e) {
          logger.warn('Failed to verify job on-chain', { jobId: job.jobId, error: e.message });
        }
      } else if (!job.onChainId) {
        // Job was never put on-chain, assume it's for current contract
        job.contractAddress = currentContract;
        migrated++;
      }
    }

    if (migrated > 0 || orphaned > 0) {
      await writeStorage(storage);
      logger.info('Legacy job migration complete', { migrated, orphaned });
    }

    return { migrated, orphaned };
  } catch (error) {
    logger.error('Error migrating legacy jobs:', error);
    throw error;
  }
}

/**
 * Get diagnostic info about job storage
 */
async function getDiagnostics() {
  try {
    const storage = await readStorage();
    const currentContract = getCurrentContractAddress();
    
    const stats = {
      totalJobs: storage.jobs.length,
      nextId: storage.nextId,
      currentContract,
      byStatus: {},
      byContract: {},
      orphanedCount: 0,
      legacyCount: 0, // Jobs without contractAddress
      currentContractCount: 0
    };

    for (const job of storage.jobs) {
      // Count by status
      const status = job.status || 'UNKNOWN';
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

      // Count by contract
      const contract = job.contractAddress || 'LEGACY (no address)';
      stats.byContract[contract] = (stats.byContract[contract] || 0) + 1;

      // Categorize
      if (!job.contractAddress) {
        stats.legacyCount++;
      } else if (job.contractAddress.toLowerCase() === currentContract) {
        stats.currentContractCount++;
      } else {
        stats.orphanedCount++;
      }
    }

    return stats;
  } catch (error) {
    logger.error('Error getting diagnostics:', error);
    throw error;
  }
}

module.exports = {
  initStorage,
  readStorage,
  writeStorage,
  createJob,
  getJob,
  updateJob,
  listJobs,
  updateJobStatus,
  addSubmission,
  cancelSubmission,
  updateSubmissionResult,
  // New orphan management functions
  findOrphanedJobs,
  markOrphanedJobs,
  deleteOrphanedJobs,
  migrateLegacyJobs,
  getDiagnostics,
  getCurrentContractAddress
};

