/**
 * Job Storage Utility
 * Temporary local storage for jobs/bounties until smart contracts are deployed
 * This will be replaced by blockchain queries once BountyEscrow is deployed
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
 * 
 * @param {Object} jobData
 * @param {string} jobData.title - Job title
 * @param {string} jobData.description - Job description
 * @param {string} jobData.workProductType - Type of work (e.g., "Blog Post")
 * @param {string} jobData.creator - Wallet address of creator
 * @param {number} jobData.bountyAmount - Bounty amount in ETH
 * @param {number} jobData.bountyAmountUSD - Bounty amount in USD (for display)
 * @param {number} jobData.threshold - Passing threshold (0-100)
 * @param {string} jobData.rubricCid - IPFS CID of the rubric
 * @param {string} jobData.primaryCid - IPFS CID of the primary archive
 * @param {number} jobData.classId - Verdikta class ID
 * @param {Array} jobData.juryNodes - AI jury configuration
 * @param {number} jobData.submissionOpenTime - Unix timestamp when submissions open
 * @param {number} jobData.submissionCloseTime - Unix timestamp when submissions close
 * @returns {Promise<Object>} - Created job object
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
 * 
 * @param {Object} filters
 * @param {string} filters.status - Filter by status (OPEN, CLOSED, COMPLETED)
 * @param {string} filters.creator - Filter by creator address
 * @param {number} filters.minPayout - Minimum payout in ETH
 * @param {string} filters.search - Search in title/description
 * @returns {Promise<Array>} - Array of jobs
 */
async function listJobs(filters = {}) {
  try {
    const storage = await readStorage();
    let jobs = storage.jobs;
    
    // Apply filters
    if (filters.status) {
      jobs = jobs.filter(j => j.status === filters.status);
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
    
    job.status = status;
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
 * 
 * @param {number} jobId
 * @param {Object} submissionData
 * @param {string} submissionData.hunter - Hunter wallet address
 * @param {string} submissionData.hunterCid - IPFS CID of hunter submission
 * @param {string} submissionData.updatedPrimaryCid - Updated primary CID with hunter submission
 * @returns {Promise<Object>} - Updated job
 */
async function addSubmission(jobId, submissionData) {
  try {
    const storage = await readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));
    
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    
    const submission = {
      submissionId: job.submissions.length + 1,
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
      job.status = 'COMPLETED';
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
  createJob,
  getJob,
  listJobs,
  updateJobStatus,
  addSubmission,
  updateSubmissionResult
};

