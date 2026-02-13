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
          // Older packages may use just "- Evaluation" suffix
          if (manifest.name) {
            title = manifest.name.replace(/ - Evaluation(?: for Payment Release)?$/, '');
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

          // New format: direct fields in primary_query.json
          if (query.description && !description) {
            description = query.description;
          }
          if (query.title && !title) {
            title = query.title;
          }
          if (query.workProductType && !workProductType) {
            workProductType = query.workProductType;
          }

          // Legacy format: embedded in query.query text field
          if (query.query) {
            // Extract description from query text
            if (!description) {
              const descMatch = query.query.match(/Task Description:\s*(.+?)(?:\n\n|===|$)/s);
              if (descMatch) {
                description = descMatch[1].trim();
              }
            }
            // Extract work product type
            if (!workProductType) {
              const typeMatch = query.query.match(/Work Product Type:\s*(.+?)(?:\n|$)/);
              if (typeMatch) {
                workProductType = typeMatch[1].trim();
              }
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
        // Find existing job by jobId (aligned with on-chain ID)
        // IMPORTANT: Require contractAddress to match exactly to avoid cross-contract collisions
        const existingJob = storage.jobs.find(j => {
          if (j.jobId !== bounty.jobId) return false;

          // Require explicit contract address match (jobs without contractAddress are legacy/orphaned)
          const jobContract = (j.contractAddress || '').toLowerCase();
          return jobContract === currentContract;
        });

        if (!existingJob) {
          // Check for recently created jobs that might be waiting to be linked
          // This handles the race condition between frontend create and sync
          //
          // MATCHING STRATEGIES (in order of reliability):
          // 1. evaluationCid match - most reliable, unique per job
          // 2. creator + deadline match - fallback for older jobs
          const pendingJob = storage.jobs.find(j => {
            // Skip jobs that are already synced (have syncedFromBlockchain flag)
            if (j.syncedFromBlockchain) return false;

            // Strategy 1: Match by evaluationCid (most reliable - unique per job)
            if (bounty.evaluationCid && j.evaluationCid === bounty.evaluationCid) {
              return true;
            }
            
            // Strategy 2: Match by creator + deadline (fallback)
            if (j.creator?.toLowerCase() === bounty.creator?.toLowerCase() &&
                Math.abs((j.submissionCloseTime || 0) - bounty.submissionCloseTime) < 60) {
              return true;
            }
            
            return false;
          });
          
          if (pendingJob) {
            // Link existing job instead of creating duplicate
            logger.info('🔗 Linking pending job to on-chain bounty', {
              jobId: pendingJob.jobId,
              onChainBountyId: bounty.jobId,
              title: pendingJob.title,
              matchedBy: pendingJob.evaluationCid === bounty.evaluationCid ? 'evaluationCid' : 'creator+deadline'
            });
            await this.updateJobFromBlockchain(pendingJob, bounty, storage, currentContract);
            linked++;
          } else {
            // Check if a job with same evaluationCid already exists (even if it was already linked)
            // This catches the race condition where PATCH linked the job AFTER we read storage
            const existingByCid = storage.jobs.find(j =>
              bounty.evaluationCid && j.evaluationCid === bounty.evaluationCid
            );
            
            if (existingByCid) {
              // Job already exists, just update it (handles PATCH race condition)
              logger.info('🔗 Found existing job by CID match (race condition recovery)', {
                jobId: existingByCid.jobId,
                onChainBountyId: bounty.jobId
              });
              await this.updateJobFromBlockchain(existingByCid, bounty, storage, currentContract);
              linked++;
            } else {
              // Truly new job from blockchain (created by another frontend or directly) - add it
              await this.addJobFromBlockchain(bounty, storage, currentContract);
              added++;
            }
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

      // Second pass: Remove duplicates and check for orphaned jobs
      // First, deduplicate: if multiple entries share the same jobId, keep the synced one
      const seen = new Map();
      const toRemove = [];
      for (let i = 0; i < storage.jobs.length; i++) {
        const job = storage.jobs[i];
        const key = `${job.jobId}:${(job.contractAddress || '').toLowerCase()}`;
        if (seen.has(key)) {
          const prev = seen.get(key);
          // Keep the one that's synced from blockchain; remove the other
          if (job.syncedFromBlockchain && !prev.job.syncedFromBlockchain) {
            toRemove.push(prev.idx);
            seen.set(key, { idx: i, job });
          } else {
            toRemove.push(i);
          }
          logger.warn('Removing duplicate job entry', {
            jobId: job.jobId,
            removedIdx: toRemove[toRemove.length - 1],
            reason: 'duplicate_jobId'
          });
          orphaned++;
        } else {
          seen.set(key, { idx: i, job });
        }
      }
      // Remove in reverse order to preserve indices
      for (const idx of toRemove.sort((a, b) => b - a)) {
        storage.jobs.splice(idx, 1);
      }

      for (const job of storage.jobs) {
        // Skip jobs that are already marked as orphaned or closed
        if (job.status === 'ORPHANED' || job.status === 'CLOSED') continue;

        // Skip jobs without a jobId (shouldn't happen, but be safe)
        const chainId = job.jobId;
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
              jobId: job.jobId
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
            contractAddress: currentContract
          });
        }
      }

      // Third pass: Check for jobs that never went on-chain and have expired deadlines
      const now = Math.floor(Date.now() / 1000);
      for (const job of storage.jobs) {
        // Skip jobs that are already terminal states
        if (job.status === 'ORPHANED' || job.status === 'CLOSED' ||
            job.status === 'AWARDED' || job.status === 'EXPIRED') continue;

        // Only check jobs that never went on-chain
        if (job.onChain !== false) continue;

        // Check if deadline has passed
        if (job.submissionCloseTime && now > job.submissionCloseTime) {
          job.status = 'ORPHANED';
          job.orphanedAt = now;
          job.orphanReason = 'never_deployed';
          orphaned++;
          logger.warn('Marked job as orphaned (never deployed on-chain, deadline passed)', {
            jobId: job.jobId,
            title: job.title,
            deadline: new Date(job.submissionCloseTime * 1000).toISOString()
          });
        }
      }

      // Persist changes if any
      // IMPORTANT: Re-read storage and merge to avoid overwriting changes made during sync
      // This handles the race condition where PATCH endpoints update jobs while sync is running
      if (added > 0 || updated > 0 || orphaned > 0 || linked > 0) {
        const freshStorage = await jobStorage.readStorage();
        
        // Merge strategy: For each job in our modified storage, update the fresh storage
        // Preserve any fields set by PATCH (like txHash) that we didn't modify
        for (const modifiedJob of storage.jobs) {
          const freshJob = freshStorage.jobs.find(j => j.jobId === modifiedJob.jobId);

          if (freshJob) {
            // Fields that PATCH endpoints might set during sync - preserve if freshJob has them
            const patchPreserveFields = ['txHash', 'blockNumber', 'onChain', 'contractAddress'];
            
            // Save fresh values for PATCH fields
            const preservedValues = {};
            for (const field of patchPreserveFields) {
              if (freshJob[field] != null) {
                preservedValues[field] = freshJob[field];
              }
            }
            
            // Copy sync updates (status, submissions, winner, etc.)
            Object.assign(freshJob, modifiedJob);

            // Remove stale fields that were deleted during sync
            for (const staleField of ['onChainId', 'legacyJobId']) {
              if (!(staleField in modifiedJob) && staleField in freshJob) {
                delete freshJob[staleField];
              }
            }

            // Restore PATCH fields if they were set in fresh storage
            // (PATCH updates take precedence for these fields)
            for (const [field, value] of Object.entries(preservedValues)) {
              if (freshJob[field] == null || freshJob[field] !== value) {
                logger.debug('[sync] Preserving PATCH field', { 
                  jobId: freshJob.jobId, 
                  field, 
                  patchValue: value,
                  syncValue: modifiedJob[field]
                });
                freshJob[field] = value;
              }
            }
          } else {
            // New job added by sync - add to fresh storage
            freshStorage.jobs.push(modifiedJob);
          }
        }
        
        // Remove entries from freshStorage that were removed during sync (dedup/collision)
        // Use the authoritative job count per ID from storage.jobs
        const targetCounts = {};
        storage.jobs.forEach(j => { targetCounts[j.jobId] = (targetCounts[j.jobId] || 0) + 1; });
        const seenCounts = {};
        for (let i = 0; i < freshStorage.jobs.length; i++) {
          const id = freshStorage.jobs[i].jobId;
          seenCounts[id] = (seenCounts[id] || 0) + 1;
          // Remove non-synced duplicates that exceed the target count
          if (seenCounts[id] > (targetCounts[id] || 0) && !freshStorage.jobs[i].syncedFromBlockchain) {
            logger.info('[sync] Removing duplicate entry from storage', { jobId: id, idx: i });
            freshStorage.jobs.splice(i, 1);
            i--; // adjust index after splice
            seenCounts[id]--;
          }
        }

        // Update nextId if we added jobs
        freshStorage.nextId = Math.max(freshStorage.nextId, storage.nextId);
        
        await jobStorage.writeStorage(freshStorage);
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
  async syncSubmissions(bountyId, submissionCount, existingSubmissions = [], threshold = 50) {
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
          case 0: // Prepared - on-chain but evaluation not yet started
            // Keep the submission - it exists on-chain and may have local data
            // Use existing status if available, otherwise mark as pending
            backendStatus = existing?.status || 'PENDING_EVALUATION';
            break;
          case 1: { // PendingVerdikta — check if oracle evaluation is already complete
            const zeroHash = '0x' + '0'.repeat(64);
            if (sub.verdiktaAggId && sub.verdiktaAggId !== zeroHash) {
              try {
                const evalResult = await contractService.checkEvaluationReady(bountyId, sub.submissionId);
                if (evalResult.ready) {
                  backendStatus = evalResult.scores.acceptance >= threshold
                    ? 'ACCEPTED_PENDING_CLAIM'
                    : 'REJECTED_PENDING_FINALIZATION';
                  // Store aggregator scores so API can serve them
                  sub.acceptance = evalResult.scores.acceptance;
                  sub.rejection = evalResult.scores.rejection;
                  sub.justificationCids = evalResult.justificationCids;
                  logger.info('Oracle evaluation complete, pending finalization', {
                    bountyId, submissionId: sub.submissionId, backendStatus,
                    acceptance: evalResult.scores.acceptance
                  });
                } else {
                  backendStatus = 'PENDING_EVALUATION';
                }
              } catch (error) {
                logger.debug('Error checking evaluation ready', { bountyId, error: error.message });
                backendStatus = 'PENDING_EVALUATION';
              }
            } else {
              backendStatus = 'PENDING_EVALUATION';
            }
            break;
          }
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
      jobId: bounty.jobId, // Aligned with on-chain ID (both 0-based)
      title,
      description,
      workProductType,
      creator: bounty.creator,
      bountyAmount: parseFloat(bounty.bountyAmount),
      bountyAmountUSD: 0, // Would need price oracle
      threshold: bounty.threshold,
      evaluationCid: bounty.evaluationCid,
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
    storage.nextId = Math.max(storage.nextId, bounty.jobId + 1);
  }

  /**
   * Update existing job with blockchain data
   * CRITICAL: Always use blockchain as source of truth for status
   */
  async updateJobFromBlockchain(existingJob, bounty, storage, currentContract) {
    logger.info('🔄 Updating job from blockchain', {
      jobId: existingJob.jobId,
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

    // Reconcile jobId with on-chain ID (aligned ID system)
    if (existingJob.jobId !== bounty.jobId) {
      logger.info('Reconciling jobId to match on-chain ID', {
        oldJobId: existingJob.jobId,
        newJobId: bounty.jobId
      });

      // Remove any existing entry that already has the target jobId to avoid duplicates
      const collisionIdx = storage.jobs.findIndex(j =>
        j !== existingJob &&
        j.jobId === bounty.jobId &&
        (j.contractAddress || '').toLowerCase() === currentContract
      );
      if (collisionIdx !== -1) {
        logger.warn('Removing duplicate job during reconciliation', {
          removedJobId: storage.jobs[collisionIdx].jobId,
          removedLegacyId: storage.jobs[collisionIdx].legacyJobId,
          keptJobId: existingJob.jobId,
          newJobId: bounty.jobId
        });
        storage.jobs.splice(collisionIdx, 1);
      }

      existingJob.jobId = bounty.jobId;
    }

    // Remove stale fields — jobId IS the on-chain index, no aliases needed
    if (existingJob.onChainId != null) {
      delete existingJob.onChainId;
    }
    if (existingJob.legacyJobId != null) {
      delete existingJob.legacyJobId;
    }

    // Sync evaluationCid from on-chain (authoritative source)
    if (bounty.evaluationCid && existingJob.evaluationCid !== bounty.evaluationCid) {
      logger.info('Syncing evaluationCid from blockchain', {
        jobId: existingJob.jobId,
        old: existingJob.evaluationCid,
        new: bounty.evaluationCid
      });
      existingJob.evaluationCid = bounty.evaluationCid;
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
    if (bounty.submissionCount > 0 || (existingJob.submissions && existingJob.submissions.length > 0)) {
      const onChainSubmissions = await this.syncSubmissions(
        bounty.jobId,
        bounty.submissionCount,
        existingJob.submissions || [], // Pass existing submissions to merge
        existingJob.threshold || bounty.threshold || 50
      );

      // Preserve local "Prepared" submissions that aren't on-chain yet
      const localPreparedSubmissions = (existingJob.submissions || []).filter(
        s => s.status === 'Prepared' && !onChainSubmissions.some(ocs => ocs.submissionId === s.submissionId)
      );

      // Merge: on-chain submissions + local Prepared submissions
      existingJob.submissions = [...onChainSubmissions, ...localPreparedSubmissions];

      logger.info('📝 Updated submission statuses', {
        jobId: existingJob.jobId,
        onChainCount: onChainSubmissions.length,
        localPreparedCount: localPreparedSubmissions.length
      });
    }

    // Also update deadline-related fields that might have been missing
    if (bounty.submissionCloseTime) {
      existingJob.submissionCloseTime = bounty.submissionCloseTime;
    }

    // Re-fetch metadata if description is still the placeholder
    if (existingJob.description === 'Fetched from blockchain' && existingJob.evaluationCid) {
      try {
        const metadata = await fetchEvaluationMetadata(existingJob.evaluationCid);
        if (metadata) {
          if (metadata.title && existingJob.title.startsWith('Bounty #')) {
            existingJob.title = metadata.title;
          }
          if (metadata.description) {
            existingJob.description = metadata.description;
          }
          if (metadata.workProductType) {
            existingJob.workProductType = metadata.workProductType;
          }
          logger.info('📋 Re-fetched bounty metadata from IPFS', {
            jobId: existingJob.jobId,
            title: existingJob.title,
            hasDescription: !!metadata.description
          });
        }
      } catch (error) {
        logger.debug('Failed to re-fetch metadata', { jobId: existingJob.jobId, error: error.message });
      }
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

    // Update if description is still the placeholder (needs re-fetch from IPFS)
    if (localJob.description === 'Fetched from blockchain') {
      logger.info('Description needs re-fetch', { jobId: localJob.jobId });
      return true;
    }

    // Update if local submissions array is missing data (recovery from previous sync bug)
    const localSubmissionsLength = (localJob.submissions || []).length;
    if (chainJob.submissionCount > 0 && localSubmissionsLength < chainJob.submissionCount) {
      logger.info('Submissions array incomplete - forcing sync', {
        jobId: localJob.jobId,
        localSubmissions: localSubmissionsLength,
        chainSubmissionCount: chainJob.submissionCount
      });
      return true;
    }

    // Update if winner changed
    if (localJob.winner !== chainJob.winner) {
      logger.info('Winner changed', { jobId: localJob.jobId });
      return true;
    }

    // CRITICAL: Always sync bounties that have pending submissions
    // Submission status can change (e.g., oracle completes evaluation) without
    // changing bounty-level fields like status, submissionCount, or winner
    const hasPendingSubmissions = (localJob.submissions || []).some(
      s => s.status === 'PENDING_EVALUATION' ||
           s.status === 'ACCEPTED_PENDING_CLAIM' ||
           s.status === 'REJECTED_PENDING_FINALIZATION' ||
           s.onChainStatus === 'PendingVerdikta'
    );
    if (hasPendingSubmissions) {
      logger.info('🔄 Syncing bounty with pending submissions', {
        jobId: localJob.jobId,
        pendingCount: (localJob.submissions || []).filter(
          s => s.status === 'PENDING_EVALUATION' ||
               s.status === 'ACCEPTED_PENDING_CLAIM' ||
               s.status === 'REJECTED_PENDING_FINALIZATION' ||
               s.onChainStatus === 'PendingVerdikta'
        ).length
      });
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

    // Cleanup: remove stale legacy fields (jobId IS the on-chain index)
    if (localJob.onChainId != null || localJob.legacyJobId != null) {
      return true;
    }

    // Cleanup: sync evaluationCid if it doesn't match on-chain
    if (chainJob.evaluationCid && localJob.evaluationCid !== chainJob.evaluationCid) {
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

