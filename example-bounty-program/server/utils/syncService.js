/**
 * Blockchain Sync Service — Event-Based
 *
 * Replaces the old full-scan approach with event-driven sync:
 *   Phase A — getBlockNumber() + getEventsSince() (2 RPC calls)
 *   Phase B — Process events locally (0 RPC for most events)
 *   Phase C — Hot polling: check oracle results for pending submissions (P calls)
 *   Phase D — Belt-and-suspenders bountyCount() check (1 call)
 *   Phase E — Persist syncState
 *
 * Steady-state RPC budget: 3 + P calls per cycle (~8 at P=5).
 *
 * Bootstrap: On first run (no syncState), replays events from the deployment
 * block in 10K-block chunks, then reconciles with existing jobs.
 */

const logger = require('./logger');
const jobStorage = require('./jobStorage');
const { getContractService } = require('./contractService');
const { config } = require('../config');
const { ethers } = require('ethers');
const AdmZip = require('adm-zip');

// IPFS gateway for fetching evaluation packages
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.io';
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud';

// Bootstrap chunk size (Infura limit is typically 10K blocks per getLogs call)
const BOOTSTRAP_CHUNK_SIZE = 10_000;

// Sync state schema version — bump when the shape changes
const SYNC_STATE_VERSION = 2;

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

          if (query.description && !description) {
            description = query.description;
          }
          if (query.title && !title) {
            title = query.title;
          }
          if (query.workProductType && !workProductType) {
            workProductType = query.workProductType;
          }

          if (query.query) {
            if (!description) {
              const descMatch = query.query.match(/Task Description:\s*(.+?)(?:\n\n|===|$)/s);
              if (descMatch) {
                description = descMatch[1].trim();
              }
            }
            if (!workProductType) {
              const typeMatch = query.query.match(/Work Product Type:\s*(.+?)(?:\n|$)/);
              if (typeMatch) {
                workProductType = typeMatch[1].trim();
              }
            }
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

  return null;
}

/**
 * Copy chain-authoritative bounty fields from a `getBounty()` result onto an
 * existing local job record. Used by:
 *   - Phase D.5 stale-check: when verifying a pending job against the chain.
 *   - Heal sweep: when retroactively backfilling already-synced records that
 *     are missing windowed/target fields.
 *   - PATCH /:id/bountyId in routes: when the frontend tells us a pending job
 *     is now on-chain at a known id.
 *
 * Fields copied are the ones the chain owns and the local cache shouldn't
 * second-guess: identity (creator, contract address indirectly), economic
 * params (payouts, deadline), threshold/class, and the targeting + creator-
 * approval-window fields that are the source of the windowed-bounty bug.
 *
 * Returns true if any field was changed.
 */
function applyChainBountyFields(localJob, chainBounty) {
  if (!localJob || !chainBounty) return false;
  let changed = false;
  const set = (key, value) => {
    if (localJob[key] !== value) {
      localJob[key] = value;
      changed = true;
    }
  };

  // Targeting + creator approval window — the fields that bug #45 lost.
  // contractService.getBounty() already converts ZeroAddress → null and
  // formats payment fields as ETH strings.
  set('targetHunter', chainBounty.targetHunter || null);
  set('creatorDeterminationPayment', chainBounty.creatorDeterminationPayment || '0.0');
  set('arbiterDeterminationPayment', chainBounty.arbiterDeterminationPayment || '0.0');
  set('creatorAssessmentWindowSize', Number(chainBounty.creatorAssessmentWindowSize || 0));

  // Other authoritative chain fields — only overwrite if the chain has them.
  // We don't want to wipe local-only metadata like title/description/juryNodes.
  if (chainBounty.creator) set('creator', chainBounty.creator);
  if (chainBounty.evaluationCid) set('evaluationCid', chainBounty.evaluationCid);
  if (chainBounty.classId != null) set('classId', Number(chainBounty.classId));
  if (chainBounty.threshold != null) set('threshold', Number(chainBounty.threshold));
  if (chainBounty.bountyAmount != null) set('bountyAmount', parseFloat(chainBounty.bountyAmount));
  if (chainBounty.submissionCloseTime != null) set('submissionCloseTime', Number(chainBounty.submissionCloseTime));
  if (chainBounty.createdAt != null) {
    // Don't clobber the local createdAt if it already exists; chain createdAt
    // is the block timestamp which can differ slightly from when the local
    // pending job was first created.
    if (localJob.createdAt == null) set('createdAt', Number(chainBounty.createdAt));
    if (localJob.submissionOpenTime == null) set('submissionOpenTime', Number(chainBounty.createdAt));
  }
  if (chainBounty.winner !== undefined) {
    set('winner', chainBounty.winner || null);
  }

  return changed;
}

class SyncService {
  constructor(intervalMinutes = 2) {
    this.intervalMs = intervalMinutes * 60 * 1000;
    this.syncTimer = null;
    this.isSyncing = false;
    this.lastSyncTime = null;
    this.syncErrors = 0;

    // Set of bountyIds with PendingVerdikta submissions — polled each cycle
    this.hotBountyIds = new Set();
    this._staleCheckDone = false;
    this._healCheckDone = false;
    this._subHealCheckDone = false;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  start() {
    if (this.syncTimer) {
      logger.warn('Sync service already running');
      return;
    }

    logger.info('Starting blockchain sync service (event-based)', {
      interval: `${this.intervalMs / 1000} seconds`
    });

    // Run initial sync immediately
    this.syncNow();

    // Then run periodically
    this.syncTimer = setInterval(() => {
      this.syncNow();
    }, this.intervalMs);
  }

  stop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      logger.info('Blockchain sync service stopped');
    }
  }

  getStatus() {
    return {
      isRunning: this.syncTimer !== null,
      isSyncing: this.isSyncing,
      lastSyncTime: this.lastSyncTime,
      intervalMinutes: this.intervalMs / 60000,
      consecutiveErrors: this.syncErrors,
      hotBountyCount: this.hotBountyIds.size
    };
  }

  // ==========================================================================
  // Main sync loop
  // ==========================================================================

  async syncNow() {
    if (this.isSyncing) {
      logger.debug('Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;
    const startTime = Date.now();

    try {
      const contractService = getContractService();
      const syncState = await jobStorage.readSyncState();

      if (!syncState || !syncState.lastSyncedBlock) {
        // Bootstrap: first run or reset
        await this._bootstrap(contractService);
      } else {
        // Normal event-based sync
        await this._eventSync(contractService, syncState);
      }

      this.lastSyncTime = new Date();
      this.syncErrors = 0;

      const duration = Date.now() - startTime;
      logger.info('Blockchain sync completed', {
        duration: `${duration}ms`,
        hotBounties: this.hotBountyIds.size
      });

      // One-time backfill of awardTxHash for existing awarded jobs
      if (!this._awardTxBackfillDone) {
        await this._backfillAwardTxHashes(contractService);
        this._awardTxBackfillDone = true;
      }

      // Trigger archival processing after sync completes
      try {
        const { getArchivalService } = require('./archivalService');
        const archivalService = getArchivalService();
        archivalService.processSubmissions().catch(archivalError => {
          logger.warn('[sync] Archival processing error', { error: archivalError.message });
        });
      } catch (archivalError) {
        logger.debug('[sync] Archival service not available', { error: archivalError.message });
      }

    } catch (error) {
      this.syncErrors++;
      logger.error('Blockchain sync failed', {
        error: error.message,
        consecutiveErrors: this.syncErrors
      });

      if (this.syncErrors >= 5) {
        logger.error('Too many sync errors, stopping sync service');
        this.stop();
      }
    } finally {
      this.isSyncing = false;
    }
  }

  // ==========================================================================
  // Bootstrap (one-time on first run or after reset)
  // ==========================================================================

  async _bootstrap(contractService) {
    logger.info('[bootstrap] Starting event replay from deployment block...');

    const currentBlock = await contractService.getBlockNumber();
    const deploymentBlock = config.deploymentBlock || 0;

    // Replay events in chunks
    let allEvents = [];
    for (let from = deploymentBlock; from <= currentBlock; from += BOOTSTRAP_CHUNK_SIZE) {
      const to = Math.min(from + BOOTSTRAP_CHUNK_SIZE - 1, currentBlock);
      try {
        const chunk = await contractService.getEventsSince(from, to);
        allEvents = allEvents.concat(chunk);
        logger.debug(`[bootstrap] Fetched events for blocks ${from}-${to}`, { count: chunk.length });
      } catch (error) {
        logger.warn(`[bootstrap] Failed chunk ${from}-${to}`, { error: error.message });
      }
    }

    logger.info(`[bootstrap] Replayed ${allEvents.length} events from ${deploymentBlock} to ${currentBlock}`);

    // Process all events to build/update job state
    const storage = await jobStorage.readStorage();
    const currentContract = jobStorage.getCurrentContractAddress();

    for (const event of allEvents) {
      await this._processEvent(event, storage, currentContract, contractService);
    }

    // Belt-and-suspenders: verify bounty count
    const bountyCount = await contractService.getBountyCount();
    const knownBountyIds = new Set();
    for (const job of storage.jobs) {
      const jc = (job.contractAddress || '').toLowerCase();
      if (jc === currentContract && job.syncedFromBlockchain) {
        knownBountyIds.add(job.jobId);
      }
    }

    // Fetch any bounties we missed during event replay
    let gapFilled = 0;
    for (let id = 0; id < bountyCount; id++) {
      if (!knownBountyIds.has(id)) {
        try {
          const bounty = await contractService.getBounty(id);
          await this.addJobFromBlockchain(bounty, storage, currentContract);
          gapFilled++;
          logger.info('[bootstrap] Filled gap for bounty', { id });
        } catch (err) {
          logger.warn('[bootstrap] Failed to fill gap', { id, error: err.message });
        }
      }
    }

    if (gapFilled > 0) {
      logger.info(`[bootstrap] Filled ${gapFilled} gaps from bountyCount check`);
    }

    // Build hot set from existing submissions
    this._rebuildHotSet(storage, currentContract);

    // Save sync state and storage
    storage.syncState = {
      lastSyncedBlock: currentBlock,
      lastKnownBountyCount: bountyCount,
      version: SYNC_STATE_VERSION
    };
    await jobStorage.writeStorage(storage);

    logger.info('[bootstrap] Complete', {
      lastSyncedBlock: currentBlock,
      bountyCount,
      hotBounties: this.hotBountyIds.size,
      totalJobs: storage.jobs.length
    });
  }

  // ==========================================================================
  // Normal event-based sync cycle
  // ==========================================================================

  async _eventSync(contractService, syncState) {
    const storage = await jobStorage.readStorage();
    const currentContract = jobStorage.getCurrentContractAddress();

    // Phase A: Event fetch (2 RPC calls)
    const currentBlock = await contractService.getBlockNumber();
    const fromBlock = syncState.lastSyncedBlock + 1;

    let events = [];
    if (fromBlock <= currentBlock) {
      events = await contractService.getEventsSince(fromBlock, currentBlock);
    }

    // Phase B: Event processing
    let eventsProcessed = 0;
    for (const event of events) {
      await this._processEvent(event, storage, currentContract, contractService);
      eventsProcessed++;
    }

    if (eventsProcessed > 0) {
      logger.info('[sync] Processed events', { count: eventsProcessed, fromBlock, toBlock: currentBlock });
    }

    // Phase C: Hot polling — check oracle results for pending submissions
    await this._pollHotBounties(storage, currentContract, contractService);

    // Phase D: bountyCount check — fill any gaps from 0 to bountyCount
    const bountyCount = await contractService.getBountyCount();
    const knownIds = new Set(
      storage.jobs
        .filter(j => (j.contractAddress || '').toLowerCase() === currentContract && j.syncedFromBlockchain)
        .map(j => j.jobId)
    );
    let gapFilled = 0;
    for (let id = 0; id < bountyCount; id++) {
      if (!knownIds.has(id)) {
        try {
          const bounty = await contractService.getBounty(id);
          await this.addJobFromBlockchain(bounty, storage, currentContract);
          gapFilled++;
        } catch (err) {
          logger.warn('[sync] Failed to fetch bounty gap', { id, error: err.message });
        }
      }
    }
    if (gapFilled > 0) {
      logger.info('[sync] Filled gaps from bountyCount check', { gapFilled, bountyCount });
    }

    // Phase D.5: Stale-detection sweep — verify jobs that claim to be on the current
    // contract but were never confirmed by the sync service. These could be phantom
    // entries from PATCH /bountyId calls that pointed at the wrong contract.
    // Only runs once per startup (first sync cycle) to avoid repeated RPC costs.
    if (!this._staleCheckDone) {
      const suspects = storage.jobs.filter(j =>
        (j.contractAddress || '').toLowerCase() === currentContract &&
        j.onChain === true &&
        !j.syncedFromBlockchain &&
        typeof j.jobId === 'number' &&
        j.jobId >= bountyCount // Can't exist if jobId >= bountyCount
      );

      let staleCount = 0;
      for (const job of suspects) {
        logger.info('[sync/stale-check] job claims onChain but jobId >= bountyCount, marking orphaned', {
          jobId: job.jobId, bountyCount, contractAddress: job.contractAddress
        });
        job.status = 'ORPHANED';
        job.orphanReason = 'jobId_exceeds_bountyCount';
        staleCount++;
      }

      // For suspects below bountyCount, do a quick getBounty check
      const suspectsBelowCount = storage.jobs.filter(j =>
        (j.contractAddress || '').toLowerCase() === currentContract &&
        j.onChain === true &&
        !j.syncedFromBlockchain &&
        typeof j.jobId === 'number' &&
        j.jobId < bountyCount
      );
      for (const job of suspectsBelowCount) {
        try {
          // Pull the chain truth — and ACTUALLY USE IT. Previously this call
          // discarded its result and only flipped syncedFromBlockchain, which
          // was the root cause of bounty #45 being stuck without targetHunter
          // / creatorAssessmentWindowSize / payment fields.
          const chainBounty = await contractService.getBounty(job.jobId);
          const changed = applyChainBountyFields(job, chainBounty);
          job.syncedFromBlockchain = true;
          job.lastSyncedAt = Math.floor(Date.now() / 1000);
          if (changed) {
            logger.info('[sync/stale-check] backfilled chain fields for pending job', {
              jobId: job.jobId,
              targetHunter: job.targetHunter,
              creatorAssessmentWindowSize: job.creatorAssessmentWindowSize
            });
          }
        } catch (err) {
          const msg = (err.message || '').toLowerCase();
          if (msg.includes('bad bountyid') || msg.includes('badbountyid')) {
            logger.info('[sync/stale-check] job does not exist on current contract, marking orphaned', {
              jobId: job.jobId, contractAddress: job.contractAddress
            });
            job.status = 'ORPHANED';
            job.orphanReason = 'not_found_on_current_contract';
            staleCount++;
          }
        }
      }

      if (staleCount > 0) {
        logger.info('[sync/stale-check] orphaned stale entries', { count: staleCount });
      }
      this._staleCheckDone = true;
    }

    // Phase D.6: One-shot heal sweep — backfill chain-authoritative fields for
    // jobs that were marked syncedFromBlockchain in the past but are missing
    // the windowed/target fields (because of an older bug where Phase D.5
    // discarded the getBounty() result instead of copying it). Runs once per
    // server startup, gated by _healCheckDone.
    //
    // Detection heuristic: a synced job missing creatorDeterminationPayment is
    // a clear indicator the chain-fields backfill never ran. (Even non-windowed
    // bounties get a "0.0" string from applyChainBountyFields once it runs, so
    // missing-entirely is unambiguous.)
    if (!this._healCheckDone) {
      const healCandidates = storage.jobs.filter(j =>
        (j.contractAddress || '').toLowerCase() === currentContract &&
        j.syncedFromBlockchain === true &&
        j.status !== 'ORPHANED' &&
        typeof j.jobId === 'number' &&
        j.jobId < bountyCount &&
        j.creatorDeterminationPayment == null
      );

      let healed = 0;
      for (const job of healCandidates) {
        try {
          const chainBounty = await contractService.getBounty(job.jobId);
          const changed = applyChainBountyFields(job, chainBounty);
          job.lastSyncedAt = Math.floor(Date.now() / 1000);
          if (changed) {
            healed++;
            logger.info('[sync/heal] backfilled chain fields for previously-synced job', {
              jobId: job.jobId,
              targetHunter: job.targetHunter,
              creatorAssessmentWindowSize: job.creatorAssessmentWindowSize,
              creatorDeterminationPayment: job.creatorDeterminationPayment
            });
          }
        } catch (err) {
          logger.warn('[sync/heal] failed to backfill', {
            jobId: job.jobId, error: err.message
          });
        }
      }

      if (healCandidates.length > 0) {
        logger.info('[sync/heal] heal sweep complete', {
          candidates: healCandidates.length,
          healed
        });
      }
      this._healCheckDone = true;
    }

    // Phase D.7: Submission-level one-shot heal — find submissions on
    // windowed bounties whose local status is still 'Prepared', and
    // re-read chain state for them. A windowed bounty's submission can
    // never legitimately be in state 'Prepared' on chain — the contract
    // transitions it directly to PendingCreatorApproval. So if we see
    // local='Prepared' on a windowed bounty, the local record is stale
    // (the POST /submissions/confirm write landed before chain truth was
    // read). See bounty 46 sub 0 incident.
    //
    // Runs once per server startup, gated by _subHealCheckDone.
    if (!this._subHealCheckDone) {
      const subHealCandidates = [];
      for (const job of storage.jobs) {
        if ((job.contractAddress || '').toLowerCase() !== currentContract) continue;
        if (!job.syncedFromBlockchain) continue;
        if (job.status === 'ORPHANED') continue;
        if (!job.creatorAssessmentWindowSize || Number(job.creatorAssessmentWindowSize) === 0) continue;
        if (!Array.isArray(job.submissions) || job.submissions.length === 0) continue;
        for (const sub of job.submissions) {
          // Target: locally 'Prepared' but the bounty is windowed. On chain
          // this should be PendingCreatorApproval (or possibly further along
          // if the window already closed and evaluation was started).
          if (sub.status === 'Prepared' || sub.status === 'PREPARED') {
            subHealCandidates.push({ job, sub });
          }
        }
      }

      let subHealed = 0;
      for (const { job, sub } of subHealCandidates) {
        try {
          const contract = contractService.contract;
          const chainSub = await contract.getSubmission(job.jobId, sub.submissionId);
          const statusMap = {
            0: 'Prepared',
            1: 'PENDING_EVALUATION',
            2: 'REJECTED',
            3: 'APPROVED',
            4: 'APPROVED',
            5: 'PendingCreatorApproval',
          };
          const statusIndex = Number(chainSub.status);
          const chainStatus = statusMap[statusIndex] || 'UNKNOWN';

          if (chainStatus !== sub.status) {
            sub.status = chainStatus;
            sub.onChainStatus = chainStatus;
            sub.creatorWindowEnd = Number(chainSub.creatorWindowEnd) || null;
            if (chainSub.linkMaxBudget != null) {
              sub.linkMaxBudget = chainSub.linkMaxBudget.toString();
            }
            if (chainSub.submittedAt != null) {
              sub.submittedAt = Number(chainSub.submittedAt) || sub.submittedAt;
            }
            subHealed++;
            logger.info('[sync/sub-heal] updated submission from chain', {
              bountyId: job.jobId,
              submissionId: sub.submissionId,
              newStatus: chainStatus,
              creatorWindowEnd: sub.creatorWindowEnd,
            });
          }
        } catch (err) {
          logger.warn('[sync/sub-heal] failed to read submission from chain', {
            bountyId: job.jobId,
            submissionId: sub.submissionId,
            error: err.message
          });
        }
      }

      if (subHealCandidates.length > 0) {
        logger.info('[sync/sub-heal] submission heal sweep complete', {
          candidates: subHealCandidates.length,
          healed: subHealed,
        });
      }
      this._subHealCheckDone = true;
    }

    // Phase E: Persist
    // Re-read storage to merge with any concurrent PATCH updates
    const freshStorage = await jobStorage.readStorage();
    this._mergeStorageChanges(storage, freshStorage, currentContract);

    // Handle orphaned/expired off-chain jobs + reconcile on-chain status
    // before writing, so there is a single atomic write per cycle (no
    // intermediate state where the API can serve stale data).
    await this._handleOrphanedJobs(freshStorage, currentContract, contractService);

    freshStorage.syncState = {
      lastSyncedBlock: currentBlock,
      lastKnownBountyCount: bountyCount,
      version: SYNC_STATE_VERSION
    };
    await jobStorage.writeStorage(freshStorage);
  }

  // ==========================================================================
  // One-time backfill: populate awardTxHash for awarded jobs
  // ==========================================================================

  async _backfillAwardTxHashes(contractService) {
    try {
      const storage = await jobStorage.readStorage();
      const currentContract = jobStorage.getCurrentContractAddress();

      const needsBackfill = storage.jobs.filter(j =>
        j.status === 'AWARDED' &&
        !j.awardTxHash &&
        (j.contractAddress || '').toLowerCase() === currentContract
      );

      if (needsBackfill.length === 0) return;

      logger.info('[backfill] Backfilling awardTxHash for awarded jobs', { count: needsBackfill.length });

      // Fetch all events from deployment block to find PayoutSent
      const deploymentBlock = config.deploymentBlock || 0;
      const currentBlock = await contractService.getBlockNumber();

      let allEvents = [];
      for (let from = deploymentBlock; from <= currentBlock; from += BOOTSTRAP_CHUNK_SIZE) {
        const to = Math.min(from + BOOTSTRAP_CHUNK_SIZE - 1, currentBlock);
        try {
          const chunk = await contractService.getEventsSince(from, to);
          allEvents = allEvents.concat(chunk);
        } catch (error) {
          logger.warn('[backfill] Failed to fetch events chunk', { from, to, error: error.message });
        }
      }

      // Build lookup: bountyId -> PayoutSent transactionHash
      const payoutTxMap = new Map();
      const creationTxMap = new Map();
      for (const event of allEvents) {
        if (event.name === 'PayoutSent') {
          payoutTxMap.set(Number(event.args.bountyId), event.transactionHash);
        } else if (event.name === 'BountyCreated') {
          creationTxMap.set(Number(event.args.bountyId), {
            txHash: event.transactionHash,
            blockNumber: event.blockNumber
          });
        }
      }

      let patched = 0;
      for (const job of storage.jobs) {
        if ((job.contractAddress || '').toLowerCase() !== currentContract) continue;

        if (!job.awardTxHash && payoutTxMap.has(job.jobId)) {
          job.awardTxHash = payoutTxMap.get(job.jobId);
          patched++;
        }
        if (!job.txHash && creationTxMap.has(job.jobId)) {
          const info = creationTxMap.get(job.jobId);
          job.txHash = info.txHash;
          if (!job.blockNumber) job.blockNumber = info.blockNumber;
        }
      }

      if (patched > 0) {
        await jobStorage.writeStorage(storage);
        logger.info('[backfill] awardTxHash backfill complete', { patched });
      }
    } catch (error) {
      logger.warn('[backfill] awardTxHash backfill failed', { error: error.message });
    }
  }

  // ==========================================================================
  // Event processing
  // ==========================================================================

  async _processEvent(event, storage, currentContract, contractService) {
    const { name, args, blockNumber, transactionHash } = event;

    switch (name) {
      case 'BountyCreated': {
        const bountyId = Number(args.bountyId);
        const existing = storage.jobs.find(j =>
          j.jobId === bountyId &&
          (j.contractAddress || '').toLowerCase() === currentContract
        );

        if (existing) {
          // Already tracked — make sure it's synced
          if (!existing.syncedFromBlockchain) {
            existing.syncedFromBlockchain = true;
            existing.contractAddress = currentContract;
            existing.lastSyncedAt = Math.floor(Date.now() / 1000);
          }
          // Backfill creation tx info if missing (covers sync-discovered bounties)
          if (!existing.txHash && transactionHash) existing.txHash = transactionHash;
          if (!existing.blockNumber && blockNumber) existing.blockNumber = blockNumber;
          break;
        }

        // Check for pending jobs that match by evaluationCid or creator+deadline
        const evaluationCid = args.evaluationCid;
        const creator = args.creator;
        const deadline = Number(args.submissionDeadline);

        const pendingJob = storage.jobs.find(j => {
          if (j.syncedFromBlockchain) return false;
          if (evaluationCid && j.evaluationCid === evaluationCid) return true;
          if (j.creator?.toLowerCase() === creator?.toLowerCase() &&
              Math.abs((j.submissionCloseTime || 0) - deadline) < 60) return true;
          return false;
        });

        if (pendingJob) {
          // Link pending job (API-created, not yet on-chain)
          logger.info('[event] Linking pending job to BountyCreated', {
            jobId: pendingJob.jobId,
            bountyId,
            matchedBy: pendingJob.evaluationCid === evaluationCid ? 'evaluationCid' : 'creator+deadline'
          });
          pendingJob.jobId = bountyId;
          pendingJob.syncedFromBlockchain = true;
          pendingJob.contractAddress = currentContract;
          pendingJob.status = 'OPEN';
          pendingJob.lastSyncedAt = Math.floor(Date.now() / 1000);
          if (pendingJob.onChainId != null) delete pendingJob.onChainId;
          if (pendingJob.legacyJobId != null) delete pendingJob.legacyJobId;

          // Pull chain-only fields (targetHunter + creator approval window) that
          // the pending job may not have if the API caller didn't pass them.
          // The contract is the source of truth for these.
          try {
            const bounty = await contractService.getBounty(bountyId);
            applyChainBountyFields(pendingJob, bounty);
          } catch (err) {
            logger.warn('[event] Failed to pull chain-only fields for linked pending job', {
              bountyId, error: err.message
            });
          }
        } else {
          // New bounty from chain — fetch full struct and metadata
          try {
            const bounty = await contractService.getBounty(bountyId);
            await this.addJobFromBlockchain(bounty, storage, currentContract);
          } catch (err) {
            logger.warn('[event] Failed to fetch BountyCreated bounty', { bountyId, error: err.message });
          }
        }
        break;
      }

      case 'SubmissionPrepared': {
        const bountyId = Number(args.bountyId);
        const submissionId = Number(args.submissionId);
        const job = this._findJob(storage, bountyId, currentContract);
        if (!job) break;

        // Add submission if not already tracked.
        // Note: hunterCid is NOT in this event — it's stored on-chain via prepareSubmission()
        // and will be picked up by the next getSubmission() call (e.g., in syncSubmissions or refresh).
        const existing = (job.submissions || []).find(s => s.submissionId === submissionId);
        if (!existing) {
          // For windowed bounties, the contract puts the submission straight
          // into PendingCreatorApproval (state 5) with a creatorWindowEnd —
          // not Prepared (state 0). The event doesn't carry those fields, so
          // we pull chain truth with a single getSubmission() call. Non-fatal:
          // if the call fails we fall back to the 'Prepared' default and the
          // submission-level heal sweep (Phase D.7) will fix it later.
          let chainStatusString = 'Prepared';
          let creatorWindowEnd = null;
          let hunterCidFromChain = null;
          try {
            const chainSub = await contractService.contract.getSubmission(bountyId, submissionId);
            const statusMap = {
              0: 'Prepared',
              1: 'PENDING_EVALUATION',
              2: 'REJECTED',
              3: 'APPROVED',
              4: 'APPROVED',
              5: 'PendingCreatorApproval',
            };
            chainStatusString = statusMap[Number(chainSub.status)] || 'Prepared';
            creatorWindowEnd = Number(chainSub.creatorWindowEnd) || null;
            hunterCidFromChain = chainSub.hunterCid || null;
          } catch (err) {
            logger.warn('[event] SubmissionPrepared: chain read failed, falling back to Prepared', {
              bountyId, submissionId, error: err.message
            });
          }

          if (!job.submissions) job.submissions = [];
          job.submissions.push({
            submissionId,
            hunter: args.hunter,
            evalWallet: args.evalWallet,
            evaluationCid: args.evaluationCid,
            hunterCid: hunterCidFromChain,
            linkMaxBudget: args.linkMaxBudget?.toString(),
            status: chainStatusString,
            onChainStatus: chainStatusString,
            creatorWindowEnd,
            submittedAt: Math.floor(Date.now() / 1000)
          });
          job.submissionCount = (job.submissionCount || 0) + 1;
          logger.info('[event] SubmissionPrepared', {
            bountyId, submissionId, evalWallet: args.evalWallet,
            status: chainStatusString, creatorWindowEnd
          });
        }
        break;
      }

      case 'WorkSubmitted': {
        const bountyId = Number(args.bountyId);
        const submissionId = Number(args.submissionId);
        const verdiktaAggId = args.verdiktaAggId;
        const job = this._findJob(storage, bountyId, currentContract);
        if (!job) break;

        const sub = (job.submissions || []).find(s => s.submissionId === submissionId);
        if (sub) {
          sub.status = 'PENDING_EVALUATION';
          sub.onChainStatus = 'PendingVerdikta';
          sub.verdiktaAggId = verdiktaAggId;
        } else {
          // Submission not tracked locally — add it
          if (!job.submissions) job.submissions = [];
          job.submissions.push({
            submissionId,
            verdiktaAggId,
            status: 'PENDING_EVALUATION',
            onChainStatus: 'PendingVerdikta',
            submittedAt: Math.floor(Date.now() / 1000)
          });
        }

        // Mark bounty as HOT for oracle polling
        this.hotBountyIds.add(bountyId);
        logger.info('[event] WorkSubmitted — bounty marked HOT', { bountyId, submissionId });
        break;
      }

      case 'SubmissionFinalized': {
        const bountyId = Number(args.bountyId);
        const submissionId = Number(args.submissionId);
        // Contract event signature: (bountyId, submissionId, bool passed, uint256 acceptance, uint256 rejection, string justificationCids)
        const passed = Boolean(args.passed);
        const acceptance = Number(args.acceptance);
        const rejection = Number(args.rejection);
        const justificationCids = args.justificationCids || '';
        const job = this._findJob(storage, bountyId, currentContract);
        if (!job) break;

        const sub = (job.submissions || []).find(s => s.submissionId === submissionId);
        if (sub) {
          // For passed=true, the contract sets status to PassedPaid (3) if this is the winner,
          // or PassedUnpaid (4) otherwise. The PayoutSent event (handled separately) flags the
          // actual winner via paidWinner. Default to PassedPaid here; PassedUnpaid will be
          // corrected by re-sync if needed.
          if (passed) {
            sub.status = 'APPROVED';
            sub.onChainStatus = 'PassedPaid';
          } else {
            sub.status = 'REJECTED';
            sub.onChainStatus = 'Failed';
          }
          sub.acceptance = acceptance;
          sub.rejection = rejection;
          sub.finalizedAt = Math.floor(Date.now() / 1000);
          sub.score = acceptance > 0 ? acceptance : null;
          if (justificationCids) {
            sub.justificationCids = justificationCids;
          }

          // Detect timeout: failed with zero scores = oracle timed out (failTimedOutSubmission was called)
          if (!passed && acceptance === 0 && rejection === 0) {
            sub.failureReason = 'ORACLE_TIMEOUT';
          }
        }

        // Check if bounty still has pending submissions — if not, remove from hot set
        const stillHot = (job.submissions || []).some(
          s => s.status === 'PENDING_EVALUATION' || s.onChainStatus === 'PendingVerdikta' ||
               s.status === 'PendingCreatorApproval'
        );
        if (!stillHot) {
          this.hotBountyIds.delete(bountyId);
        }

        logger.info('[event] SubmissionFinalized', { bountyId, submissionId, passed, status: sub?.status });
        break;
      }

      case 'CreatorApproved': {
        const bountyId = Number(args.bountyId);
        const submissionId = Number(args.submissionId);
        const hunter = args.hunter;
        const amountPaid = args.amountPaid?.toString();
        const job = this._findJob(storage, bountyId, currentContract);
        if (!job) break;

        const sub = (job.submissions || []).find(s => s.submissionId === submissionId);
        if (sub) {
          sub.status = 'APPROVED';
          sub.onChainStatus = 'PassedPaid';
          sub.paidWinner = true;
          sub.finalizedAt = Math.floor(Date.now() / 1000);
        }

        logger.info('[event] CreatorApproved', { bountyId, submissionId, hunter, amountPaid });
        break;
      }

      case 'CreatorRefunded': {
        const bountyId = Number(args.bountyId);
        const creator = args.creator;
        const amountRefunded = args.amountRefunded?.toString();
        logger.info('[event] CreatorRefunded', { bountyId, creator, amountRefunded });
        break;
      }

      case 'PayoutSent': {
        const bountyId = Number(args.bountyId);
        const winner = args.winner;
        const job = this._findJob(storage, bountyId, currentContract);
        if (!job) break;

        job.status = 'AWARDED';
        job.winner = winner;
        job.settledAt = Math.floor(Date.now() / 1000);
        job.awardTxHash = transactionHash;
        this.hotBountyIds.delete(bountyId);

        // Mark the winning submission
        const winningSub = (job.submissions || []).find(s => s.hunter?.toLowerCase() === winner?.toLowerCase());
        if (winningSub) {
          winningSub.paidWinner = true;
        }

        logger.info('[event] PayoutSent', { bountyId, winner });
        break;
      }

      case 'BountyClosed': {
        const bountyId = Number(args.bountyId);
        const creator = args.creator;
        const amountReturned = args.amountReturned?.toString();
        const job = this._findJob(storage, bountyId, currentContract);
        if (!job) break;

        job.status = 'CLOSED';
        job.settledAt = Math.floor(Date.now() / 1000);
        this.hotBountyIds.delete(bountyId);
        logger.info('[event] BountyClosed', { bountyId, creator, amountReturned });
        break;
      }

      case 'LinkRefunded': {
        const bountyId = Number(args.bountyId);
        const submissionId = Number(args.submissionId);
        const amount = args.amount?.toString();
        logger.info('[event] LinkRefunded', { bountyId, submissionId, amount });
        break;
      }

      default:
        logger.debug('[event] Unknown event', { name });
    }
  }

  // ==========================================================================
  // Hot polling: check oracle results for pending submissions
  // ==========================================================================

  async _pollHotBounties(storage, currentContract, contractService) {
    if (this.hotBountyIds.size === 0) return;

    const zeroHash = ethers.ZeroHash;
    let checksPerformed = 0;

    for (const bountyId of [...this.hotBountyIds]) {
      const job = this._findJob(storage, bountyId, currentContract);
      if (!job) {
        this.hotBountyIds.delete(bountyId);
        continue;
      }

      const pendingSubs = (job.submissions || []).filter(
        s => s.status === 'PENDING_EVALUATION' ||
             s.status === 'ACCEPTED_PENDING_CLAIM' ||
             s.status === 'REJECTED_PENDING_FINALIZATION' ||
             s.onChainStatus === 'PendingVerdikta'
      );

      if (pendingSubs.length === 0) {
        this.hotBountyIds.delete(bountyId);
        continue;
      }

      for (const sub of pendingSubs) {
        // Skip submissions already in a terminal-ish state (waiting for finalize tx)
        if (sub.status === 'ACCEPTED_PENDING_CLAIM' || sub.status === 'REJECTED_PENDING_FINALIZATION') {
          continue;
        }

        const aggId = sub.verdiktaAggId;
        if (!aggId || aggId === zeroHash) continue;

        try {
          const evalResult = await contractService.getEvaluationByAggId(aggId);
          checksPerformed++;

          if (evalResult.ready) {
            const threshold = job.threshold || 50;
            sub.status = evalResult.scores.acceptance >= threshold
              ? 'ACCEPTED_PENDING_CLAIM'
              : 'REJECTED_PENDING_FINALIZATION';
            sub.acceptance = evalResult.scores.acceptance;
            sub.rejection = evalResult.scores.rejection;
            sub.justificationCids = evalResult.justificationCids;
            sub.score = evalResult.scores.acceptance > 0 ? evalResult.scores.acceptance : null;

            logger.info('[hot-poll] Oracle evaluation complete', {
              bountyId,
              submissionId: sub.submissionId,
              status: sub.status,
              acceptance: evalResult.scores.acceptance
            });
          }
        } catch (err) {
          logger.debug('[hot-poll] Error checking evaluation', {
            bountyId,
            submissionId: sub.submissionId,
            error: err.message
          });
        }
      }
    }

    if (checksPerformed > 0) {
      logger.info('[hot-poll] Evaluation checks completed', { checks: checksPerformed });
    }
  }

  // ==========================================================================
  // Job management (reused from old sync — handles matching/merging logic)
  // ==========================================================================

  /**
   * Add a new job from blockchain to local storage
   */
  async addJobFromBlockchain(bounty, storage, currentContract) {
    logger.info('Adding job from blockchain', { jobId: bounty.jobId, evaluationCid: bounty.evaluationCid });

    // ---- Duplicate prevention: check for existing job with same evaluationCid ----
    // This catches API-created jobs whose IDs were never aligned with on-chain IDs
    // (e.g. the PATCH /api/jobs/:id/bountyId step was skipped).
    if (bounty.evaluationCid) {
      // First try: unsynced pending job (same logic as _processEvent BountyCreated)
      const pendingJob = storage.jobs.find(j =>
        !j.syncedFromBlockchain &&
        j.evaluationCid === bounty.evaluationCid
      );

      if (pendingJob) {
        logger.info('[addJobFromBlockchain] Linking pending job by evaluationCid', {
          oldJobId: pendingJob.jobId,
          newBountyId: bounty.jobId,
          evaluationCid: bounty.evaluationCid
        });
        pendingJob.jobId = bounty.jobId;
        pendingJob.onChain = true;
        pendingJob.syncedFromBlockchain = true;
        pendingJob.contractAddress = currentContract;
        pendingJob.status = bounty.status || 'OPEN';
        pendingJob.lastSyncedAt = Math.floor(Date.now() / 1000);
        if (pendingJob.onChainId != null) delete pendingJob.onChainId;
        if (pendingJob.legacyJobId != null) delete pendingJob.legacyJobId;
        storage.nextId = Math.max(storage.nextId, bounty.jobId + 1);
        return;
      }

    }

    // Check if this exact on-chain bountyId is already tracked
    const existingById = storage.jobs.find(j =>
      j.syncedFromBlockchain &&
      j.jobId === bounty.jobId &&
      (j.contractAddress || '').toLowerCase() === currentContract
    );

    if (existingById) {
      logger.info('[addJobFromBlockchain] Already tracked by jobId', {
        jobId: existingById.jobId
      });
      existingById.lastSyncedAt = Math.floor(Date.now() / 1000);
      return;
    }

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
      }
    } catch (error) {
      logger.warn('Failed to fetch evaluation metadata, using defaults', {
        jobId: bounty.jobId,
        error: error.message
      });
    }

    const job = {
      jobId: bounty.jobId,
      title,
      description,
      workProductType,
      creator: bounty.creator,
      bountyAmount: parseFloat(bounty.bountyAmount),
      bountyAmountUSD: 0,
      threshold: bounty.threshold,
      evaluationCid: bounty.evaluationCid,
      classId: bounty.classId,
      juryNodes: [],
      submissionOpenTime: bounty.createdAt,
      submissionCloseTime: bounty.submissionCloseTime,
      status: bounty.status,
      createdAt: bounty.createdAt,
      submissionCount: bounty.submissionCount,
      submissions: [],
      winner: bounty.winner,
      targetHunter: bounty.targetHunter || null,
      creatorDeterminationPayment: bounty.creatorDeterminationPayment || '0.0',
      arbiterDeterminationPayment: bounty.arbiterDeterminationPayment || '0.0',
      creatorAssessmentWindowSize: bounty.creatorAssessmentWindowSize || 0,
      onChain: true,
      syncedFromBlockchain: true,
      lastSyncedAt: Math.floor(Date.now() / 1000),
      contractAddress: currentContract
    };

    // If the bounty already has submissions, sync them from chain
    if (bounty.submissionCount > 0) {
      try {
        job.submissions = await this.syncSubmissions(
          bounty.jobId,
          bounty.submissionCount,
          [],
          bounty.threshold || 50
        );
      } catch (err) {
        logger.warn('Failed to sync submissions during addJob', { jobId: bounty.jobId, error: err.message });
      }
    }

    // Keep submissionCount consistent with the actual submissions array
    job.submissionCount = job.submissions.length;

    storage.jobs.push(job);
    storage.nextId = Math.max(storage.nextId, bounty.jobId + 1);
  }

  /**
   * Sync submissions for a bounty from blockchain
   * Merges on-chain status with existing backend data
   */
  async syncSubmissions(bountyId, submissionCount, existingSubmissions = [], threshold = 50) {
    const contractService = getContractService();
    const submissions = [];

    try {
      const onChainSubmissions = await contractService.getSubmissions(bountyId);

      for (const sub of onChainSubmissions) {
        const existing = existingSubmissions.find(s => s.submissionId === sub.submissionId);

        // Map contract status
        let backendStatus;
        const statusNum = typeof sub.status === 'number' ? sub.status :
                         sub.status === 'Prepared' ? 0 :
                         sub.status === 'PendingVerdikta' ? 1 :
                         sub.status === 'Failed' ? 2 :
                         sub.status === 'PassedPaid' ? 3 :
                         sub.status === 'PassedUnpaid' ? 4 :
                         sub.status === 'PendingCreatorApproval' ? 5 : -1;

        switch (statusNum) {
          case 0:
            backendStatus = existing?.status || 'PENDING_EVALUATION';
            break;
          case 1: {
            const zeroHash = '0x' + '0'.repeat(64);
            if (sub.verdiktaAggId && sub.verdiktaAggId !== zeroHash) {
              try {
                const evalResult = await contractService.getEvaluationByAggId(sub.verdiktaAggId);
                if (evalResult.ready) {
                  backendStatus = evalResult.scores.acceptance >= threshold
                    ? 'ACCEPTED_PENDING_CLAIM'
                    : 'REJECTED_PENDING_FINALIZATION';
                  sub.acceptance = evalResult.scores.acceptance;
                  sub.rejection = evalResult.scores.rejection;
                  sub.justificationCids = evalResult.justificationCids;
                } else {
                  backendStatus = 'PENDING_EVALUATION';
                }
              } catch (error) {
                backendStatus = 'PENDING_EVALUATION';
              }
            } else {
              backendStatus = 'PENDING_EVALUATION';
            }
            break;
          }
          case 2:
            backendStatus = 'REJECTED';
            break;
          case 3:
            backendStatus = 'APPROVED';
            break;
          case 4:
            backendStatus = 'APPROVED';
            break;
          case 5:
            backendStatus = 'PendingCreatorApproval';
            break;
          default:
            backendStatus = 'UNKNOWN';
        }

        submissions.push({
          ...(existing || {}),
          submissionId: sub.submissionId,
          hunter: sub.hunter,
          evaluationCid: sub.evaluationCid,
          hunterCid: sub.hunterCid,
          evalWallet: sub.evalWallet,
          verdiktaAggId: sub.verdiktaAggId,
          status: backendStatus,
          onChainStatus: sub.status,
          acceptance: sub.acceptance,
          rejection: sub.rejection,
          justificationCids: sub.justificationCids,
          submittedAt: sub.submittedAt,
          finalizedAt: sub.finalizedAt,
          score: sub.acceptance > 0 ? sub.acceptance : null,
          creatorWindowEnd: sub.creatorWindowEnd || 0,
        });
      }

      return submissions;

    } catch (error) {
      logger.error('Error syncing submissions', { bountyId, error: error.message });
      return existingSubmissions;
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  _findJob(storage, bountyId, currentContract) {
    return storage.jobs.find(j =>
      j.jobId === bountyId &&
      (j.contractAddress || '').toLowerCase() === currentContract
    );
  }

  /**
   * Rebuild the hot set from storage — used after bootstrap
   */
  _rebuildHotSet(storage, currentContract) {
    this.hotBountyIds.clear();
    for (const job of storage.jobs) {
      if ((job.contractAddress || '').toLowerCase() !== currentContract) continue;
      const hasPending = (job.submissions || []).some(
        s => s.status === 'PENDING_EVALUATION' ||
             s.status === 'ACCEPTED_PENDING_CLAIM' ||
             s.status === 'REJECTED_PENDING_FINALIZATION' ||
             s.onChainStatus === 'PendingVerdikta'
      );
      if (hasPending) {
        this.hotBountyIds.add(job.jobId);
      }
    }
  }

  /**
   * Merge sync changes into fresh storage (handles PATCH race conditions)
   */
  _mergeStorageChanges(modifiedStorage, freshStorage, currentContract) {
    // Fields that PATCH endpoints might set during sync — preserve fresh values
    const patchPreserveFields = ['txHash', 'blockNumber', 'onChain', 'contractAddress'];

    for (const modifiedJob of modifiedStorage.jobs) {
      const modifiedContract = (modifiedJob.contractAddress || '').toLowerCase();
      let freshJob = freshStorage.jobs.find(j =>
        j.jobId === modifiedJob.jobId &&
        (j.contractAddress || '').toLowerCase() === modifiedContract
      );

      // If no match by jobId+contract, try matching by evaluationCid — covers the case where
      // sync linked a pending job (changed its jobId from null to the on-chain ID)
      // but freshStorage still has the old null-id entry.
      // IMPORTANT: only match when at least one side has a null/undefined jobId (i.e. a
      // pending job not yet linked to an on-chain bounty).  Multiple on-chain bounties
      // can legitimately share the same evaluationCid, so matching two synced jobs by CID
      // would cause them to overwrite each other and oscillate every sync cycle.
      if (!freshJob && modifiedJob.evaluationCid) {
        freshJob = freshStorage.jobs.find(j =>
          j.evaluationCid === modifiedJob.evaluationCid &&
          (j.contractAddress || '').toLowerCase() === modifiedContract &&
          (j.jobId == null || modifiedJob.jobId == null)
        );
      }

      if (freshJob) {
        // Save PATCH fields from fresh storage
        const preservedValues = {};
        for (const field of patchPreserveFields) {
          if (freshJob[field] != null) {
            preservedValues[field] = freshJob[field];
          }
        }

        // Merge submissions: keep the longer/richer array.
        // PATCH endpoints add submissions to freshStorage while sync runs,
        // so freshStorage.submissions may have entries that modifiedStorage doesn't.
        const freshSubs = freshJob.submissions || [];
        const modifiedSubs = modifiedJob.submissions || [];
        let mergedSubs;
        if (freshSubs.length > modifiedSubs.length) {
          // Fresh has more — PATCH added submissions during sync. Keep fresh, overlay sync updates.
          mergedSubs = freshSubs.map(fs => {
            const ms = modifiedSubs.find(s => s.submissionId === fs.submissionId);
            return ms ? { ...fs, ...ms } : fs;
          });
          // Also add any sync-only subs not in fresh
          for (const ms of modifiedSubs) {
            if (!mergedSubs.some(s => s.submissionId === ms.submissionId)) {
              mergedSubs.push(ms);
            }
          }
        } else {
          // Modified has equal or more — sync found submissions. Keep modified, overlay PATCH fields.
          mergedSubs = modifiedSubs.map(ms => {
            const fs = freshSubs.find(s => s.submissionId === ms.submissionId);
            // Preserve local-only fields from PATCH (files, archive metadata, etc.)
            return fs ? { ...fs, ...ms } : ms;
          });
          // Also keep any fresh-only subs (locally prepared, not on-chain yet)
          for (const fs of freshSubs) {
            if (!mergedSubs.some(s => s.submissionId === fs.submissionId)) {
              mergedSubs.push(fs);
            }
          }
        }

        // Copy sync updates
        Object.assign(freshJob, modifiedJob);

        // Restore merged submissions
        freshJob.submissions = mergedSubs;
        freshJob.submissionCount = mergedSubs.length;

        // Remove stale fields
        for (const staleField of ['onChainId', 'legacyJobId']) {
          if (!(staleField in modifiedJob) && staleField in freshJob) {
            delete freshJob[staleField];
          }
        }

        // Restore PATCH fields
        for (const [field, value] of Object.entries(preservedValues)) {
          freshJob[field] = value;
        }
      } else {
        // New job added by sync
        freshStorage.jobs.push(modifiedJob);
      }
    }

    // Deduplicate by jobId:contract, and also by evaluationCid:contract
    // (catches null-id pending jobs that duplicate a synced entry)
    const seen = new Map();
    const seenByCid = new Map();
    const toRemove = new Set();
    for (let i = 0; i < freshStorage.jobs.length; i++) {
      const job = freshStorage.jobs[i];
      const contract = (job.contractAddress || '').toLowerCase();

      // Dedup by jobId (skip null jobIds — they can't collide on this key)
      if (job.jobId != null) {
        const key = `${job.jobId}:${contract}`;
        if (seen.has(key)) {
          const prev = seen.get(key);
          if (job.syncedFromBlockchain && !prev.job.syncedFromBlockchain) {
            toRemove.add(prev.idx);
            seen.set(key, { idx: i, job });
          } else {
            toRemove.add(i);
          }
        } else {
          seen.set(key, { idx: i, job });
        }
      }

      // Dedup by evaluationCid — a null-id job with the same CID as a real-id job is a duplicate.
      // Only dedup when at least one side has a null jobId; multiple on-chain bounties
      // can legitimately share the same evaluationCid.
      if (job.evaluationCid) {
        const cidKey = `${job.evaluationCid}:${contract}`;
        if (seenByCid.has(cidKey)) {
          const prev = seenByCid.get(cidKey);
          const bothHaveIds = job.jobId != null && prev.job.jobId != null;
          if (!bothHaveIds) {
            // Keep the one with a real jobId; remove the null-id one
            if (job.jobId != null && prev.job.jobId == null) {
              toRemove.add(prev.idx);
              seenByCid.set(cidKey, { idx: i, job });
            } else if (job.jobId == null && prev.job.jobId != null) {
              toRemove.add(i);
            } else if (job.syncedFromBlockchain && !prev.job.syncedFromBlockchain) {
              toRemove.add(prev.idx);
              seenByCid.set(cidKey, { idx: i, job });
            } else {
              toRemove.add(i);
            }
          }
        } else {
          seenByCid.set(cidKey, { idx: i, job });
        }
      }
    }
    for (const idx of [...toRemove].sort((a, b) => b - a)) {
      freshStorage.jobs.splice(idx, 1);
    }

    freshStorage.nextId = Math.max(freshStorage.nextId, modifiedStorage.nextId);
  }

  /**
   * Handle orphaned/expired off-chain jobs, settled bounties, and
   * reconcile on-chain status for EXPIRED bounties that may have been
   * closed externally (e.g., via script or direct contract call).
   */
  async _handleOrphanedJobs(storage, currentContract, contractService) {
    const now = Math.floor(Date.now() / 1000);
    let changed = false;

    for (const job of storage.jobs) {
      if (job.status === 'ORPHANED' || job.status === 'CLOSED') continue;

      // Check different contract
      const jobContract = (job.contractAddress || '').toLowerCase();
      if (jobContract && jobContract !== currentContract) {
        if (job.status !== 'ORPHANED') {
          job.status = 'ORPHANED';
          job.orphanedAt = now;
          job.orphanReason = 'different_contract';
          changed = true;
        }
        continue;
      }

      // Check off-chain jobs that expired — including ones already marked EXPIRED,
      // since off-chain bounties can't be closed on-chain and should be orphaned.
      // A job is considered on-chain if onChain===true OR syncedFromBlockchain===true
      // (addJobFromBlockchain sets syncedFromBlockchain but not onChain).
      if (!job.onChain && !job.syncedFromBlockchain && job.submissionCloseTime && now > job.submissionCloseTime) {
        if (job.status !== 'ORPHANED' && job.status !== 'AWARDED') {
          job.status = 'ORPHANED';
          job.orphanedAt = now;
          job.orphanReason = 'never_deployed';
          changed = true;
        }
        continue;
      }

      // Reconcile on-chain bounties whose local status may be stale: check
      // if they were closed or awarded externally (not through the website).
      // The event-based sync may have missed the BountyClosed event if it
      // occurred before the sync cursor was established, or via a direct
      // contract call. Covers both EXPIRED and OPEN-past-deadline bounties.
      const pastDeadline = job.submissionCloseTime && now > job.submissionCloseTime;
      if ((job.status === 'EXPIRED' || (job.status === 'OPEN' && pastDeadline)) && (job.onChain || job.syncedFromBlockchain) && contractService) {
        try {
          const onChainStatus = await contractService.getEffectiveStatus(job.jobId);
          const upper = String(onChainStatus).toUpperCase();
          if (upper === 'CLOSED') {
            logger.info('[reconcile] %s bounty is CLOSED on-chain', job.status, { jobId: job.jobId });
            job.status = 'CLOSED';
            job.settledAt = now;
            changed = true;
            continue;
          }
          if (upper === 'AWARDED') {
            logger.info('[reconcile] %s bounty is AWARDED on-chain', job.status, { jobId: job.jobId });
            job.status = 'AWARDED';
            job.settledAt = now;
            changed = true;
            continue;
          }
        } catch (err) {
          // Non-fatal: if the RPC call fails, we'll try again next cycle
          logger.debug('[reconcile] Could not check on-chain status', { jobId: job.jobId, error: err.message });
        }
      }

      // Settle terminal bounties: compute effective status for OPEN bounties
      if (job.status === 'OPEN' && job.submissionCloseTime && now > job.submissionCloseTime) {
        job.status = 'EXPIRED';
        changed = true;
      }
    }

    // Caller (_eventSync) handles the single write after all mutations.
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
  SyncService,
  applyChainBountyFields
};
