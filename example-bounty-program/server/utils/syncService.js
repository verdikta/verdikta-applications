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
          j.onChainId === bounty.jobId ||
          j.jobId === bounty.jobId
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
   * Add a new job from blockchain to local storage
   */
  async addJobFromBlockchain(bounty, storage) {
    logger.info('📥 Adding job from blockchain', { jobId: bounty.jobId });

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
      submissions: [], // Will be synced separately if needed
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
      newStatus: bounty.status
    });

    // CRITICAL: Update ALL mutable fields from blockchain
    // The contract's getEffectiveBountyStatus() returns: OPEN, EXPIRED, AWARDED, or CLOSED
    existingJob.status = bounty.status;
    existingJob.submissionCount = bounty.submissionCount;
    existingJob.winner = bounty.winner;
    existingJob.lastSyncedAt = Math.floor(Date.now() / 1000);

    // Also update deadline-related fields that might have been missing
    if (bounty.submissionCloseTime) {
      existingJob.submissionCloseTime = bounty.submissionCloseTime;
    }
  }

  /**
   * Check if a job needs updating from blockchain
   */
  needsUpdate(localJob, chainJob) {
    // Always update if status changed (this catches OPEN → EXPIRED → CLOSED transitions)
    if (localJob.status !== chainJob.status) {
      return true;
    }
    
    // Update if submission count changed
    if (localJob.submissionCount !== chainJob.submissionCount) {
      return true;
    }
    
    // Update if winner changed
    if (localJob.winner !== chainJob.winner) {
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

