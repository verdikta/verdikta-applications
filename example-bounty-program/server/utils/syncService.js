/**
 * Blockchain Sync Service
 * Periodically syncs local storage with smart contract state
 * Ensures consistency and catches jobs created by other frontends
 */

const logger = require('./logger');
const jobStorage = require('./jobStorage');
const { getContractService } = require('./contractService');
const AdmZip = require('adm-zip');

// IPFS gateway for fetching evaluation packages
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.io';
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud';

/**
 * Fetch and parse metadata from an evaluation CID (ZIP archive)
 * Extracts title and description from manifest.json and primary_query.json
 */
async function fetchEvaluationMetadata(evaluationCid) {
  if (!evaluationCid || evaluationCid.startsWith('dev-')) {
    return null; // Skip dev/fake CIDs
  }

  const gateways = [PINATA_GATEWAY, IPFS_GATEWAY];

  for (const gateway of gateways) {
    try {
      const url = `${gateway}/ipfs/${evaluationCid}`;
      const response = await fetch(url, {
        timeout: 15000,
        headers: { 'Accept': 'application/octet-stream, application/zip, */*' }
      });

      if (!response.ok) continue;

      const buffer = await response.arrayBuffer();
      const zip = new AdmZip(Buffer.from(buffer));

      let title = null;
      let description = null;
      let workProductType = null;

      // Parse manifest.json for title
      const manifestEntry = zip.getEntry('manifest.json');
      if (manifestEntry) {
        try {
          const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
          // Title is in format: "Job Title - Evaluation for Payment Release"
          if (manifest.name) {
            title = manifest.name.replace(/ - Evaluation for Payment Release$/, '');
          }
        } catch (e) {
          logger.debug('Failed to parse manifest.json', { cid: evaluationCid, error: e.message });
        }
      }

      // Parse primary_query.json for description
      const queryEntry = zip.getEntry('primary_query.json');
      if (queryEntry) {
        try {
          const query = JSON.parse(queryEntry.getData().toString('utf8'));
          if (query.query) {
            // Extract description from query text
            const descMatch = query.query.match(/Task Description:\s*(.+?)(?:\n\n|===|$)/s);
            if (descMatch) {
              description = descMatch[1].trim();
            }
            // Extract work product type
            const typeMatch = query.query.match(/Work Product Type:\s*(.+?)(?:\n|$)/);
            if (typeMatch) {
              workProductType = typeMatch[1].trim();
            }
            // Extract title if not found in manifest
            if (!title) {
              const titleMatch = query.query.match(/Task Title:\s*(.+?)(?:\n|$)/);
              if (titleMatch) {
                title = titleMatch[1].trim();
              }
            }
          }
        } catch (e) {
          logger.debug('Failed to parse primary_query.json', { cid: evaluationCid, error: e.message });
        }
      }

      if (title || description) {
        logger.debug('Fetched evaluation metadata', { cid: evaluationCid, title, hasDescription: !!description });
        return { title, description, workProductType };
      }

    } catch (error) {
      logger.debug('Failed to fetch from gateway', { gateway, cid: evaluationCid, error: error.message });
      continue;
    }
  }

  return null; // Could not fetch metadata
}

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
      const currentContract = jobStorage.getCurrentContractAddress();

      // Get all jobs from blockchain
      const onChainBounties = await contractService.listBounties();

      // Build a set of on-chain IDs for orphan detection
      const onChainIds = new Set(onChainBounties.map(b => b.jobId));

      // Track changes
      let added = 0;
      let updated = 0;
      let unchanged = 0;
      let orphaned = 0;
      let linked = 0;

      // First pass: Update/add jobs from blockchain
      for (const bounty of onChainBounties) {
        // Find existing job by onChainId (primary) or legacy bountyId field
        // IMPORTANT: Also verify contractAddress matches to avoid cross-contract collisions
        const existingJob = storage.jobs.find(j => {
          const matchesId = j.onChainId === bounty.jobId ||
                           j.bountyId === bounty.jobId ||  // Legacy fallback
                           j.onChainBountyId === bounty.jobId;  // Another legacy name
          if (!matchesId) return false;

          // Verify this job belongs to the current contract (or has no contract set)
          const jobContract = (j.contractAddress || '').toLowerCase();
          return !jobContract || jobContract === currentContract;
        });

        if (!existingJob) {
          // Check for recently created jobs without onChainId that might be waiting to be linked
          // This handles the race condition between frontend create and sync
          const pendingJob = storage.jobs.find(j => 
            j.onChainId == null && 
            j.bountyId == null &&
            j.creator?.toLowerCase() === bounty.creator?.toLowerCase() &&
            // Match by submission deadline (within 60 seconds tolerance)
            Math.abs((j.submissionCloseTime || 0) - bounty.submissionCloseTime) < 60
          );
          
          if (pendingJob) {
            // Link existing job instead of creating duplicate
            logger.info('🔗 Linking pending job to on-chain bounty', {
              jobId: pendingJob.jobId,
              onChainId: bounty.jobId,
              title: pendingJob.title
            });
            await this.updateJobFromBlockchain(pendingJob, bounty, storage, currentContract);
            linked++;
          } else {
            // Truly new job from blockchain (created by another frontend or directly) - add it
            await this.addJobFromBlockchain(bounty, storage, currentContract);
            added++;
          }
        } else {
          // Job exists - check if we need to update it
          const needsUpdate = this.needsUpdate(existingJob, bounty);
          if (needsUpdate) {
            await this.updateJobFromBlockchain(existingJob, bounty, storage, currentContract);
            updated++;
          } else {
            unchanged++;
          }
        }
      }

      // Second pass: Check for orphaned jobs (exist locally but not on-chain)
      for (const job of storage.jobs) {
        // Skip jobs that are already marked as orphaned or closed
        if (job.status === 'ORPHANED' || job.status === 'CLOSED') continue;

        // Skip jobs without an onChainId (never went on-chain)
        const chainId = job.onChainId ?? job.bountyId ?? job.onChainBountyId;
        if (chainId == null) continue;

        // Skip jobs from different contracts
        const jobContract = (job.contractAddress || '').toLowerCase();
        if (jobContract && jobContract !== currentContract) {
          // Already known to be from different contract
          if (job.status !== 'ORPHANED') {
            job.status = 'ORPHANED';
            job.orphanedAt = Math.floor(Date.now() / 1000);
            job.orphanReason = 'different_contract';
            orphaned++;
            logger.info('Marked job as orphaned (different contract)', {
              jobId: job.jobId,
              onChainId: chainId
            });
          }
          continue;
        }

        // Check if this job's on-chain ID exists on current contract
        if (!onChainIds.has(chainId)) {
          // Job references an on-chain ID that doesn't exist!
          job.status = 'ORPHANED';
          job.orphanedAt = Math.floor(Date.now() / 1000);
          job.orphanReason = 'not_found_on_chain';
          orphaned++;
          logger.warn('Marked job as orphaned (not found on chain)', {
            jobId: job.jobId,
            onChainId: chainId,
            contractAddress: currentContract
          });
        }
      }

      // Persist changes if any
      if (added > 0 || updated > 0 || orphaned > 0 || linked > 0) {
        await jobStorage.writeStorage(storage);
      }

      this.lastSyncTime = new Date();
      this.syncErrors = 0;

      const duration = Date.now() - startTime;
      logger.info('✅ Blockchain sync completed', {
        duration: `${duration}ms`,
        added,
        linked,
        updated,
        unchanged,
        orphaned,
        total: onChainBounties.length
      });

      // Trigger archival processing after sync completes
      try {
        const { getArchivalService } = require('./archivalService');
        const archivalService = getArchivalService();
        
        // Run archival asynchronously - don't block sync completion
        archivalService.processSubmissions().catch(archivalError => {
          logger.warn('[sync] Archival processing error', { error: archivalError.message });
        });
        
        logger.debug('[sync] Archival processing triggered');
      } catch (archivalError) {
        // Archival service might not be initialized yet
        logger.debug('[sync] Archival service not available', { error: archivalError.message });
      }

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
        // Contract enum: 0=Prepared, 1=PendingVerdikta, 2=Failed, 3=PassedPaid, 4=PassedUnpaid
        // sub.status from contract can be either string name or numeric index
        let backendStatus;
        const statusNum = typeof sub.status === 'number' ? sub.status :
                         sub.status === 'Prepared' ? 0 :
                         sub.status === 'PendingVerdikta' ? 1 :
                         sub.status === 'Failed' ? 2 :
                         sub.status === 'PassedPaid' ? 3 :
                         sub.status === 'PassedUnpaid' ? 4 : -1;

        switch (statusNum) {
          case 0: // Prepared
            backendStatus = 'PREPARED';
            break;
          case 1: // PendingVerdikta
            backendStatus = 'PENDING_EVALUATION';
            break;
          case 2: // Failed
            backendStatus = 'REJECTED';
            break;
          case 3: // PassedPaid
            backendStatus = 'APPROVED';
            break;
          case 4: // PassedUnpaid
            backendStatus = 'APPROVED';  // Also APPROVED, just didn't get paid
            break;
          default:
            backendStatus = 'UNKNOWN';
        }

        // Merge: Keep backend fields (files, archive status, etc), update status and CIDs from blockchain
        submissions.push({
          ...(existing || {}), // Preserve files and archive metadata from backend storage
          submissionId: sub.submissionId,
          hunter: sub.hunter,
          evaluationCid: sub.evaluationCid, // Now stored in Submission struct
          hunterCid: sub.hunterCid,         // Now stored in Submission struct
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
   * Only called for jobs that were truly created outside our frontend (e.g., directly via contract)
   */
  async addJobFromBlockchain(bounty, storage, currentContract) {
    logger.info('📥 Adding job from blockchain', { jobId: bounty.jobId, evaluationCid: bounty.evaluationCid });

    // Sync submissions if any exist
    const submissions = bounty.submissionCount > 0
      ? await this.syncSubmissions(bounty.jobId, bounty.submissionCount, [])
      : [];

    // Try to fetch real title/description from the evaluation package on IPFS
    let title = bounty.title || `Bounty #${bounty.jobId}`;
    let description = bounty.description || 'Fetched from blockchain';
    let workProductType = bounty.workProductType || 'Work Product';

    try {
      const metadata = await fetchEvaluationMetadata(bounty.evaluationCid);
      if (metadata) {
        if (metadata.title) title = metadata.title;
        if (metadata.description) description = metadata.description;
        if (metadata.workProductType) workProductType = metadata.workProductType;
        logger.info('📋 Fetched bounty metadata from IPFS', {
          jobId: bounty.jobId,
          title,
          hasDescription: !!metadata.description
        });
      }
    } catch (error) {
      logger.warn('Failed to fetch evaluation metadata, using defaults', {
        jobId: bounty.jobId,
        error: error.message
      });
    }

    // Note: evaluationCid in contract is the full evaluation package (was rubricCid)
    const job = {
      jobId: storage.nextId,
      onChainId: bounty.jobId, // Track the on-chain ID
      title,
      description,
      workProductType,
      creator: bounty.creator,
      bountyAmount: parseFloat(bounty.bountyAmount),
      bountyAmountUSD: 0, // Would need price oracle
      threshold: bounty.threshold,
      evaluationCid: bounty.evaluationCid, // The full evaluation package CID
      primaryCid: bounty.evaluationCid, // Same as evaluationCid for compatibility
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
      lastSyncedAt: Math.floor(Date.now() / 1000),
      // Track which contract this job belongs to
      contractAddress: currentContract
    };

    storage.jobs.push(job);
    storage.nextId += 1;
  }

  /**
   * Update existing job with blockchain data
   * CRITICAL: Always use blockchain as source of truth for status
   */
  async updateJobFromBlockchain(existingJob, bounty, storage, currentContract) {
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

    // Ensure onChainId is set (handles legacy jobs and newly linked jobs)
    if (existingJob.onChainId == null) {
      existingJob.onChainId = bounty.jobId;
    }

    // Set contract address if not already set (migration for legacy jobs)
    if (!existingJob.contractAddress && currentContract) {
      existingJob.contractAddress = currentContract;
      logger.info('Migrated legacy job to current contract', {
        jobId: existingJob.jobId,
        contractAddress: currentContract
      });
    }

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

    // Update if job is missing contractAddress (needs migration)
    if (!localJob.contractAddress) {
      logger.info('Job needs contract address migration', { jobId: localJob.jobId });
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

