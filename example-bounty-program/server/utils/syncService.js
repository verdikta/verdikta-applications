/**
 * Blockchain Sync Service
 * Periodically syncs local storage with smart contract state
 * Ensures consistency and catches jobs created by other frontends
 */

const logger = require('./logger');
const jobStorage = require('./jobStorage');
const { getContractService } = require('./contractService');

class SyncService {
  constructor(intervalMinutes = 2) {
    this.intervalMs = intervalMinutes * 60 * 1000;
    this.syncTimer = null;
    this.isSyncing = false;
    this.lastSyncTime = null;
    this.syncErrors = 0;
    this.lastBlockNumber = 0; // Track last synced block for efficiency
  }

  /**
   * Start the sync service
   */
  start() {
    if (this.syncTimer) {
      logger.warn('Sync service already running');
      return;
    }

    logger.info('🔄 Starting blockchain sync service', {
      interval: `${this.intervalMs / 60000} minutes`
    });

    // Run initial sync immediately
    this.syncNow();

    // Then run periodically
    this.syncTimer = setInterval(() => {
      this.syncNow();
    }, this.intervalMs);
  }

  /**
   * Stop the sync service
   */
  stop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      logger.info('⏸️  Blockchain sync service stopped');
    }
  }

  /**
   * Trigger immediate sync
   */
  async syncNow() {
    if (this.isSyncing) {
      logger.debug('Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;
    const startTime = Date.now();

    try {
      logger.info('🔄 Starting blockchain sync...');

      const contractService = getContractService();
      const storage = await jobStorage.readStorage();

      // Get all jobs from blockchain
      const onChainBounties = await contractService.listBounties();

      // Track changes
      let added = 0;
      let updated = 0;
      let unchanged = 0;

      for (const bounty of onChainBounties) {
        const existingJob = storage.jobs.find(j =>
          j.onChainId === bounty.jobId
        );

        if (!existingJob) {
          // New job from blockchain - add it
          await this.addJobFromBlockchain(bounty, storage);
          added++;
        } else {
          // Job exists - check if we need to update it
          const needsUpdate = this.needsUpdate(existingJob, bounty);
          if (needsUpdate) {
            await this.updateJobFromBlockchain(existingJob, bounty, storage);
            updated++;
          } else {
            unchanged++;
          }
        }
      }

      // Persist changes if any
      if (added > 0 || updated > 0) {
        await jobStorage.writeStorage(storage);
      }

      this.lastSyncTime = new Date();
      this.syncErrors = 0;

      const duration = Date.now() - startTime;
      logger.info('✅ Blockchain sync completed', {
        duration: `${duration}ms`,
        added,
        updated,
        unchanged,
        total: onChainBounties.length
      });

    } catch (error) {
      this.syncErrors++;
      logger.error('❌ Blockchain sync failed', {
        error: error.message,
        consecutiveErrors: this.syncErrors
      });

      // If too many consecutive errors, stop the service
      if (this.syncErrors >= 5) {
        logger.error('⚠️  Too many sync errors, stopping sync service');
        this.stop();
      }
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync submissions for a bounty from blockchain
   * Merges on-chain status with existing backend data
   */
  async syncSubmissions(bountyId, submissionCount, existingSubmissions = []) {
    const contractService = getContractService();
    const submissions = [];

    try {
      // Fetch all submissions from blockchain
      const onChainSubmissions = await contractService.getSubmissions(bountyId);
      
      for (const sub of onChainSubmissions) {
        // Find existing submission data (has hunterCid, files, etc)
        const existing = existingSubmissions.find(s => s.submissionId === sub.submissionId);
        
        // Map contract status to backend status
        let backendStatus;
        switch (sub.status) {
          case 'Prepared':
            backendStatus = 'PREPARED';
            break;
          case 'PendingVerdikta':
            backendStatus = 'PENDING_EVALUATION';
            break;
          case 'Failed':
            backendStatus = 'REJECTED';
            break;
          case 'PassedPaid':
            backendStatus = 'APPROVED';
            break;
          case 'PassedUnpaid':
            backendStatus = 'APPROVED_UNPAID';
            break;
          default:
            backendStatus = 'UNKNOWN';
        }

        // Merge: Keep backend fields, update status from blockchain
        submissions.push({
          ...(existing || {}), // Preserve hunterCid, files, updatedPrimaryCid, etc
          submissionId: sub.submissionId,
          hunter: sub.hunter,
          deliverableCid: sub.deliverableCid,
          evalWallet: sub.evalWallet,
          verdiktaAggId: sub.verdiktaAggId,
          status: backendStatus, // UPDATE the main status field
          onChainStatus: sub.status, // Keep for reference
          acceptance: sub.acceptance,
          rejection: sub.rejection,
          justificationCids: sub.justificationCids,
          submittedAt: sub.submittedAt,
          finalizedAt: sub.finalizedAt,
          score: sub.acceptance > 0 ? sub.acceptance : null
        });
      }

      logger.info('✅ Synced submission statuses', { 
        bountyId, 
        count: submissions.length,
        statuses: submissions.map(s => `#${s.submissionId}:${s.status}`)
      });
      return submissions;

    } catch (error) {
      logger.error('Error syncing submissions', {
        bountyId,
        error: error.message
      });
      return existingSubmissions; // Return existing on error
    }
  }

  /**
   * Add a new job from blockchain to local storage
   */
  async addJobFromBlockchain(bounty, storage) {
    logger.info('📥 Adding job from blockchain', { jobId: bounty.jobId });

    // Sync submissions if any exist
    const submissions = bounty.submissionCount > 0
      ? await this.syncSubmissions(bounty.jobId, bounty.submissionCount, [])
      : [];

    const job = {
      jobId: storage.nextId,
      onChainId: bounty.jobId, // Track the on-chain ID
      title: bounty.title || `On-Chain Bounty #${bounty.jobId}`,
      description: bounty.description || 'Created via smart contract',
      workProductType: bounty.workProductType || 'On-Chain Work',
      creator: bounty.creator,
      bountyAmount: parseFloat(bounty.bountyAmount),
      bountyAmountUSD: 0, // Would need price oracle
      threshold: bounty.threshold,
      rubricCid: bounty.rubricCid,
      primaryCid: bounty.rubricCid, // May need to fetch/generate
      classId: bounty.classId,
      juryNodes: [], // Not stored on-chain
      submissionOpenTime: bounty.createdAt,
      submissionCloseTime: bounty.submissionCloseTime,
      status: bounty.status, // Use effective status: OPEN, EXPIRED, AWARDED, or CLOSED
      createdAt: bounty.createdAt,
      submissionCount: bounty.submissionCount,
      submissions: submissions, // Now properly synced from blockchain
      winner: bounty.winner,
      syncedFromBlockchain: true,
      lastSyncedAt: Math.floor(Date.now() / 1000)
    };

    storage.jobs.push(job);
    storage.nextId += 1;
  }

  /**
   * Update existing job with blockchain data
   * CRITICAL: Always use blockchain as source of truth for status
   */
  async updateJobFromBlockchain(existingJob, bounty, storage) {
    logger.info('🔄 Updating job from blockchain', {
      jobId: existingJob.jobId,
      onChainId: bounty.jobId,
      oldStatus: existingJob.status,
      newStatus: bounty.status,
      oldSubmissionCount: existingJob.submissionCount,
      newSubmissionCount: bounty.submissionCount
    });

    // CRITICAL: Update ALL mutable fields from blockchain
    // The contract's getEffectiveBountyStatus() returns: OPEN, EXPIRED, AWARDED, or CLOSED
    existingJob.status = bounty.status;
    existingJob.submissionCount = bounty.submissionCount;
    existingJob.winner = bounty.winner;
    existingJob.lastSyncedAt = Math.floor(Date.now() / 1000);

    // CRITICAL: Sync submission statuses from blockchain
    if (bounty.submissionCount > 0) {
      const onChainSubmissions = await this.syncSubmissions(
        bounty.jobId, 
        bounty.submissionCount,
        existingJob.submissions || [] // Pass existing submissions to merge
      );
      
      // Merge with existing submissions, preferring blockchain data
      existingJob.submissions = onChainSubmissions;
      
      logger.info('📝 Updated submission statuses', {
        jobId: existingJob.jobId,
        submissionCount: onChainSubmissions.length
      });
    }

    // Also update deadline-related fields that might have been missing
    if (bounty.submissionCloseTime) {
      existingJob.submissionCloseTime = bounty.submissionCloseTime;
    }
  }

needsUpdate(localJob, chainJob) {
  // Always update if status changed
  if (localJob.status !== chainJob.status) {
    logger.info('Status changed', {
      jobId: localJob.jobId,
      old: localJob.status,
      new: chainJob.status
    });
    return true;
  }

  // Update if submission count changed
  if (localJob.submissionCount !== chainJob.submissionCount) {
    logger.info('Submission count changed', {
      jobId: localJob.jobId,
      old: localJob.submissionCount,
      new: chainJob.submissionCount
    });
    return true;
  }

  // Update if winner changed
  if (localJob.winner !== chainJob.winner) {
    logger.info('Winner changed', { jobId: localJob.jobId });
    return true;
  }

  // CRITICAL: Always sync EXPIRED bounties with submissions
  // Submissions may have timed out or been finalized
  if (chainJob.status === 'EXPIRED' && chainJob.submissionCount > 0) {
    logger.info('✅ Force syncing EXPIRED bounty with submissions', { 
      jobId: localJob.jobId 
    });
    return true;
  }

  return false;
}

  /**
   * Get sync status
   */
  getStatus() {
    return {
      isRunning: this.syncTimer !== null,
      isSyncing: this.isSyncing,
      lastSyncTime: this.lastSyncTime,
      intervalMinutes: this.intervalMs / 60000,
      consecutiveErrors: this.syncErrors
    };
  }
}

// Export singleton instance
let syncService = null;

function initializeSyncService(intervalMinutes = 5) {
  if (syncService) {
    logger.warn('Sync service already initialized');
    return syncService;
  }

  syncService = new SyncService(intervalMinutes);
  return syncService;
}

function getSyncService() {
  if (!syncService) {
    throw new Error('Sync service not initialized');
  }
  return syncService;
}

module.exports = {
  initializeSyncService,
  getSyncService,
  SyncService
};

