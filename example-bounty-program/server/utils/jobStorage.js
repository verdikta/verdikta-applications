/**
 * Job Storage Utility
 * Local storage for jobs/bounties synced from blockchain
 * Blockchain is the source of truth for all status changes
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

const STORAGE_FILE = path.join(__dirname, '../data/jobs.json');

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

    const job = {
      jobId: storage.nextId,
      ...jobData,
      status: 'OPEN',
      createdAt: Math.floor(Date.now() / 1000),
      submissionCount: 0,
      submissions: [],
      winner: null
    };

    storage.jobs.push(job);
    storage.nextId += 1;

    await writeStorage(storage);

    logger.info('Job created', { jobId: job.jobId, title: job.title });

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
 * List all jobs with optional filters
 * NOTE: Status is synced from blockchain - no auto-updates here
 */
async function listJobs(filters = {}) {
  try {
    const storage = await readStorage();
    let jobs = storage.jobs;

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
      status: 'PENDING_EVALUATION'
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

module.exports = {
  initStorage,
  readStorage,
  writeStorage,
  createJob,
  getJob,
  listJobs,
  updateJobStatus,
  addSubmission,
  updateSubmissionResult
};

