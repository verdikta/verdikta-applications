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
const { bountyAmountFields } = require('./bountyAmounts');
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

// Max Phase D.8 chain reads per sync cycle (see that block for why it is capped)
const PAID_HEAL_MAX_PER_CYCLE = 25;

// Phase D.6b metadata heal (see needsMetadataHeal): IPFS fetches per cycle, the
// retry budget per job, and the backoff between attempts (doubling, capped).
const METADATA_HEAL_MAX_PER_CYCLE = 5;
const METADATA_HEAL_MAX_ATTEMPTS = 8;
const METADATA_HEAL_BASE_DELAY_SEC = 5 * 60;
const METADATA_HEAL_MAX_DELAY_SEC = 6 * 60 * 60;

// Per-request timeout for evaluation package / rubric fetches. Node's built-in
// fetch ignores a `timeout` option, so this goes through AbortSignal.timeout.
const IPFS_FETCH_TIMEOUT_MS = 15000;

// Defaults addJobFromBlockchain writes when the evaluation package can't be read.
const DEFAULT_SYNCED_DESCRIPTION = 'Fetched from blockchain';
const DEFAULT_WORK_PRODUCT_TYPE = 'Work Product';

// Contract SubmissionStatus enum → local fields, indexed by the raw uint8.
// ON_CHAIN_STATUS keeps the low-level enum name (analytics needs PassedPaid vs
// PassedUnpaid); LOCAL_STATUS is the collapsed form the API/UI render. Note that
// LOCAL_STATUS deliberately maps BOTH 3 and 4 to 'APPROVED' — so never use it to
// decide whether a record needs correcting, or PassedPaid/PassedUnpaid drift
// compares equal and is silently kept.
const ON_CHAIN_STATUS_BY_INDEX = [
  'Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid', 'PendingCreatorApproval'
];
const LOCAL_STATUS_BY_INDEX = [
  'Prepared', 'PENDING_EVALUATION', 'REJECTED', 'APPROVED', 'APPROVED', 'PendingCreatorApproval'
];

/** GET a CID from one gateway; returns a Buffer, or null on any HTTP/network failure. */
async function fetchFromGateway(gateway, cid) {
  try {
    const response = await fetch(`${gateway}/ipfs/${cid}`, {
      signal: AbortSignal.timeout(IPFS_FETCH_TIMEOUT_MS),
      headers: { 'Accept': 'application/octet-stream, application/zip, */*' }
    });
    if (!response.ok) {
      logger.debug('IPFS gateway returned an error', { gateway, cid, status: response.status });
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    logger.debug('IPFS gateway request failed', { gateway, cid, error: error.message });
    return null;
  }
}

/**
 * Fetch and parse metadata from an evaluation CID (ZIP archive).
 * Title comes from manifest.json `name`, then primary_query.json, then the
 * linked grading rubric's `title`. Jury models come from the manifest.
 *
 * Returns null when no gateway delivered a readable package ("try again
 * later"). Once the package is read, it always returns an object, with null
 * fields for anything the package doesn't carry. `incomplete: true` means the
 * title could only have come from a rubric that failed to fetch, so a retry
 * may still find it.
 */
async function fetchEvaluationMetadata(evaluationCid) {
  if (!evaluationCid || evaluationCid.startsWith('dev-')) {
    return null; // Skip dev/fake CIDs
  }

  const gateways = [PINATA_GATEWAY, IPFS_GATEWAY];

  for (const gateway of gateways) {
    try {
      const buffer = await fetchFromGateway(gateway, evaluationCid);
      if (!buffer) continue;
      // A gateway error page is not a ZIP: AdmZip throws and we try the next gateway.
      const zip = new AdmZip(buffer);
      zip.getEntries();

      let title = null;
      let description = null;
      let workProductType = null;
      let juryNodes = [];
      let rubricHash = null;
      let incomplete = false;

      // Parse manifest.json for title + jury models
      const manifestEntry = zip.getEntry('manifest.json');
      if (manifestEntry) {
        try {
          const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
          if (manifest.name) {
            title = manifest.name.replace(/ - Evaluation(?: for Payment Release)?$/, '');
          }
          const rubricRef = Array.isArray(manifest.additional)
            ? manifest.additional.find(a => a && a.name === 'gradingRubric')
            : null;
          if (rubricRef && typeof rubricRef.hash === 'string') rubricHash = rubricRef.hash;
          // Capture the AI jury models so they can be persisted onto the job
          // record (immutable per evaluationCid — content-addressed). Shape
          // matches API-created juryNodes: { provider, model, runs, weight }.
          const aiNodes = manifest?.juryParameters?.AI_NODES;
          if (Array.isArray(aiNodes)) {
            juryNodes = aiNodes
              .filter(n => n && n.AI_MODEL)
              .map(n => ({
                provider: n.AI_PROVIDER,
                model: n.AI_MODEL,
                runs: n.NO_COUNTS || 1,
                weight: typeof n.WEIGHT === 'number' ? n.WEIGHT : 1,
              }));
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

      // Packages built outside the API often carry neither a manifest name nor a
      // "Task Description:" line; the linked grading rubric has both. A failed
      // rubric fetch only matters for a retry when it was the title source.
      if ((!title || !description) && rubricHash) {
        let rubricBuffer = null;
        for (const g of gateways) {
          rubricBuffer = await fetchFromGateway(g, rubricHash);
          if (rubricBuffer) break;
        }
        if (!rubricBuffer) {
          if (!title) incomplete = true;
        } else {
          try {
            const rubric = JSON.parse(rubricBuffer.toString('utf8'));
            if (!title && typeof rubric.title === 'string' && rubric.title.trim()) title = rubric.title.trim();
            if (!description && typeof rubric.description === 'string' && rubric.description.trim()) {
              description = rubric.description.trim();
            }
          } catch (e) {
            logger.debug('Grading rubric is not JSON', { cid: rubricHash, error: e.message });
          }
        }
      }

      logger.debug('Fetched evaluation metadata', { cid: evaluationCid, title, hasDescription: !!description, juryNodeCount: juryNodes.length, incomplete });
      return { title, description, workProductType, juryNodes, ...(incomplete ? { incomplete: true } : {}) };

    } catch (error) {
      logger.debug('Evaluation package from gateway is unreadable', { gateway, cid: evaluationCid, error: error.message });
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
/**
 * Pick the API-created (not yet synced) job that a BountyCreated event belongs to.
 * evaluationCid is authoritative and is checked FIRST across all candidates; the
 * creator+deadline heuristic is only a fallback when no CID matches (older clients that
 * never stored the CID). A single mixed pass used to let a creator+deadline match on an
 * EARLIER job win over the exact-CID match further down the array — with several bounties
 * created in parallel by one creator with near-identical deadlines that paired them wrong.
 */
function findPendingJobForBountyCreated(jobs, { evaluationCid, creator, deadline }) {
  const candidates = (jobs || []).filter((j) => !j.syncedFromBlockchain && j.status !== 'ORPHANED');
  if (evaluationCid) {
    const byCid = candidates.find((j) => j.evaluationCid === evaluationCid);
    if (byCid) return byCid;
  }
  return candidates.find((j) =>
    j.creator?.toLowerCase() === creator?.toLowerCase() &&
    Math.abs((j.submissionCloseTime || 0) - deadline) < 60
  ) || null;
}

/**
 * Phase D.6 candidate rule: does this synced job need a getBounty() re-read to
 * backfill chain-authoritative fields? Pure, so it is unit-testable.
 *
 *  - Windowed/target/oracle fields missing and never healed (original rule).
 *  - bountyAmountWei missing (legacy float-only record), even if the record was
 *    healed before that field existed; `_weiBackfillAttempted` stops a record
 *    from being retried every cycle if a successful read still yields no wei.
 */
function needsChainFieldHeal(job, currentContract, bountyCount) {
  if (!job) return false;
  if ((job.contractAddress || '').toLowerCase() !== currentContract) return false;
  if (job.syncedFromBlockchain !== true) return false;
  if (job.status === 'ORPHANED') return false;
  if (typeof job.jobId !== 'number' || !(job.jobId < bountyCount)) return false;

  const missingChainFields = job.creatorDeterminationPayment == null ||
    job.targetHunter === null || job.oracleSettings == null;
  if (!job._chainFieldsHealed && missingChainFields) return true;

  // '0' is never a legitimate amount (createBounty requires value > 0); it is
  // the signature of a record written from a drained payoutWei — re-read it.
  const weiMissing = job.bountyAmountWei == null || job.bountyAmountWei === '0';
  return weiMissing && !job._weiBackfillAttempted;
}

/** True while a synced job still carries the placeholder title addJobFromBlockchain writes. */
function hasPlaceholderTitle(job) {
  return !job.title || job.title === `Bounty #${job.jobId}`;
}

/** True while a synced job still carries the placeholder description. */
function hasPlaceholderDescription(job) {
  return !job.description || job.description === DEFAULT_SYNCED_DESCRIPTION;
}

/**
 * Should Phase D.6b retry reading this job's title/description from its
 * evaluation package? addJobFromBlockchain fetches the package once, when the
 * bounty is discovered; if the gateways fail at that moment (they rate-limit
 * this host) the job keeps "Bounty #N" forever. Packages built outside the API
 * may also have put the description only in the grading rubric, which older
 * code never read. This picks those jobs up again, with a per-job retry budget
 * and backoff so a CID that never resolves can't cost a fetch every cycle.
 */
function needsMetadataHeal(job, currentContract, nowSec = Math.floor(Date.now() / 1000)) {
  if (!job) return false;
  if ((job.contractAddress || '').toLowerCase() !== currentContract) return false;
  if (job.syncedFromBlockchain !== true) return false;
  if (job.status === 'ORPHANED') return false;
  if (!job.evaluationCid || job._metadataHealDone) return false;
  if (!hasPlaceholderTitle(job) && !hasPlaceholderDescription(job)) return false;
  if ((job._metadataHealAttempts || 0) >= METADATA_HEAL_MAX_ATTEMPTS) return false;
  return !(job._metadataHealNextAt > nowSec);
}

/**
 * Copy evaluation-package metadata onto a job whose title, description, work
 * product type or jury are still the sync defaults. Never overwrites a value
 * that came from somewhere else. Returns true if anything changed.
 */
function applyEvaluationMetadata(job, metadata) {
  let changed = false;
  const set = (field, value) => { if (job[field] !== value) { job[field] = value; changed = true; } };
  if (metadata.title && hasPlaceholderTitle(job)) set('title', metadata.title);
  if (metadata.description && hasPlaceholderDescription(job)) {
    set('description', metadata.description);
  }
  if (metadata.workProductType && (!job.workProductType || job.workProductType === DEFAULT_WORK_PRODUCT_TYPE)) {
    set('workProductType', metadata.workProductType);
  }
  if (Array.isArray(metadata.juryNodes) && metadata.juryNodes.length > 0 &&
      (!Array.isArray(job.juryNodes) || job.juryNodes.length === 0)) {
    job.juryNodes = metadata.juryNodes;
    changed = true;
  }
  return changed;
}

/**
 * One Phase D.6b attempt for a job. Uses a rubric the API already stored on the
 * job (GET /:jobId lazy-persists rubricContent) before spending an IPFS fetch.
 * Returns 'healed' | 'no-title' | 'retry'.
 */
async function healJobMetadata(job, nowSec = Math.floor(Date.now() / 1000), fetchMetadata = fetchEvaluationMetadata) {
  const stored = job.rubricContent;
  if (stored && typeof stored.title === 'string' && stored.title.trim()) {
    applyEvaluationMetadata(job, {
      title: stored.title.trim(),
      description: typeof stored.description === 'string' && stored.description.trim() ? stored.description.trim() : null,
    });
    if (!hasPlaceholderTitle(job) && !hasPlaceholderDescription(job)) {
      job._metadataHealDone = true;
      return 'healed';
    }
  }

  const metadata = await fetchMetadata(job.evaluationCid);
  if (!metadata || (metadata.incomplete && !metadata.title)) {
    const attempts = (job._metadataHealAttempts || 0) + 1;
    job._metadataHealAttempts = attempts;
    job._metadataHealNextAt = nowSec + Math.min(
      METADATA_HEAL_BASE_DELAY_SEC * 2 ** (attempts - 1), METADATA_HEAL_MAX_DELAY_SEC
    );
    return 'retry';
  }

  const changed = applyEvaluationMetadata(job, metadata);
  // The package was read; whatever it lacks, refetching won't add.
  job._metadataHealDone = true;
  return changed ? 'healed' : 'no-title';
}

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

  // Creator-chosen oracle request settings (September 2026 revision: bounty.oracle).
  // Compared field-wise so an identical struct doesn't count as a change.
  if (chainBounty.oracleSettings) {
    const o = chainBounty.oracleSettings;
    const cur = localJob.oracleSettings || {};
    if (String(cur.maxOracleFee) !== String(o.maxOracleFee) ||
        Number(cur.alpha) !== Number(o.alpha) ||
        String(cur.estimatedBaseCost) !== String(o.estimatedBaseCost) ||
        Number(cur.maxFeeBasedScaling) !== Number(o.maxFeeBasedScaling)) {
      localJob.oracleSettings = {
        maxOracleFee: String(o.maxOracleFee),
        alpha: Number(o.alpha),
        estimatedBaseCost: String(o.estimatedBaseCost),
        maxFeeBasedScaling: Number(o.maxFeeBasedScaling)
      };
      changed = true;
    }
  }

  // Other authoritative chain fields — only overwrite if the chain has them.
  // We don't want to wipe local-only metadata like title/description/juryNodes.
  if (chainBounty.creator) set('creator', chainBounty.creator);
  if (chainBounty.evaluationCid) set('evaluationCid', chainBounty.evaluationCid);
  if (chainBounty.classId != null) set('classId', Number(chainBounty.classId));
  if (chainBounty.threshold != null) set('threshold', Number(chainBounty.threshold));
  if (chainBounty.bountyAmountWei != null || chainBounty.bountyAmount != null) {
    const amounts = bountyAmountFields(chainBounty);
    // Defensive: never replace a known nonzero amount with zero. A zero here
    // means the reader handed us a drained escrow balance, not the bounty amount.
    const localNonzero = Number(localJob.bountyAmount) > 0 ||
      (localJob.bountyAmountWei != null && localJob.bountyAmountWei !== '0');
    if (amounts.bountyAmountWei !== '0' || !localNonzero) {
      set('bountyAmount', amounts.bountyAmount);
      set('bountyAmountWei', amounts.bountyAmountWei);
    }
  }
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

  // Reconcile a TERMINAL on-chain status. The award/close event handlers
  // normally drive job.status, but if those events were missed locally (e.g. a
  // creator-approved bounty whose CreatorApproved/PayoutSent were never applied)
  // this heal would otherwise backfill `winner` while leaving `status: OPEN` —
  // the contradiction that kept already-awarded bounty 91 in the open listing.
  // Chain AWARDED/CLOSED is authoritative and terminal, so sync it. We
  // deliberately do NOT sync the non-terminal OPEN/EXPIRED here: those are
  // deadline-derived and we don't want a routine heal to clobber local
  // lifecycle state.
  if (chainBounty.status === 'AWARDED' || chainBounty.status === 'CLOSED') {
    set('status', chainBounty.status);
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
    this._stopped = false;
    // Maximum delay between retries during an outage. Sync auto-recovers from
    // transient RPC failures by exponential backoff up to this cap.
    this.maxBackoffMs = 10 * 60 * 1000;

    // Set of bountyIds with PendingVerdikta submissions — polled each cycle
    this.hotBountyIds = new Set();
    this._staleCheckDone = false;
    // Note: chain-fields heal (Phase D.6) and submission-level heal (D.7) both
    // run every sync cycle and gate on per-record sentinels rather than a
    // one-shot process flag — see the heal blocks in _eventSync.
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  start() {
    if (this.syncTimer) {
      logger.warn('Sync service already running');
      return;
    }
    this._stopped = false;

    logger.info('Starting blockchain sync service (event-based)', {
      interval: `${this.intervalMs / 1000} seconds`,
      maxBackoffSeconds: this.maxBackoffMs / 1000
    });

    // Chained setTimeout so each cycle can choose its own delay (exponential
    // backoff after errors, normal interval after success). This replaces the
    // previous setInterval + permanent-stop watchdog.
    const tick = async () => {
      if (this._stopped) return;
      try { await this.syncNow(); } catch { /* syncNow handles its own errors */ }
      if (this._stopped) return;
      const delay = this._computeNextDelay();
      this.syncTimer = setTimeout(tick, delay);
    };
    // First run fires immediately; subsequent runs are scheduled by tick().
    this.syncTimer = setTimeout(tick, 0);
  }

  stop() {
    this._stopped = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
      logger.info('Blockchain sync service stopped');
    }
  }

  getStatus() {
    return {
      isRunning: this.syncTimer !== null && !this._stopped,
      isSyncing: this.isSyncing,
      lastSyncTime: this.lastSyncTime,
      intervalMinutes: this.intervalMs / 60000,
      consecutiveErrors: this.syncErrors,
      nextDelayMs: this._computeNextDelay(),
      hotBountyCount: this.hotBountyIds.size
    };
  }

  /**
   * Compute the delay for the next sync attempt.
   * Normal cadence after a successful run; exponential backoff after errors,
   * doubling each cycle (cap at maxBackoffMs). Auto-recovers when RPC returns
   * and the next sync succeeds — syncErrors resets to 0 in syncNow().
   */
  _computeNextDelay() {
    if (this.syncErrors === 0) return this.intervalMs;
    const exp = Math.min(this.syncErrors - 1, 6); // cap exponent so we hit maxBackoff predictably
    return Math.min(this.intervalMs * (2 ** exp), this.maxBackoffMs);
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
      const nextDelayMs = this._computeNextDelay();
      logger.error('Blockchain sync failed — will retry with backoff', {
        error: error.message,
        consecutiveErrors: this.syncErrors,
        nextRetryInSeconds: Math.round(nextDelayMs / 1000)
      });
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

    // Persist via the serialized lock so an API write that landed during the
    // (long) bootstrap chain replay isn't lost. Merge the bootstrap-built state
    // onto a fresh read inside the lock — same Phase-E pattern as _eventSync.
    let mergedJobCount = 0;
    await jobStorage.withStorage((fresh) => {
      this._mergeStorageChanges(storage, fresh, currentContract);

      // Build hot set from the merged result
      this._rebuildHotSet(fresh, currentContract);

      fresh.syncState = {
        lastSyncedBlock: currentBlock,
        lastKnownBountyCount: bountyCount,
        version: SYNC_STATE_VERSION
      };
      mergedJobCount = fresh.jobs.length;
    });

    logger.info('[bootstrap] Complete', {
      lastSyncedBlock: currentBlock,
      bountyCount,
      hotBounties: this.hotBountyIds.size,
      totalJobs: mergedJobCount
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
      // Any job (synced or not) with jobId >= bountyCount cannot exist on-chain.
      // Previously this only caught unsynced jobs, but a phantom can acquire
      // syncedFromBlockchain=true via the PATCH /bountyId endpoint's chain
      // backfill or a coincidental ID collision in the BountyCreated handler.
      const suspects = storage.jobs.filter(j =>
        (j.contractAddress || '').toLowerCase() === currentContract &&
        j.onChain === true &&
        j.status !== 'ORPHANED' &&
        typeof j.jobId === 'number' &&
        j.jobId >= bountyCount // Can't exist if jobId >= bountyCount
      );

      let staleCount = 0;
      for (const job of suspects) {
        logger.info('[sync/stale-check] job has jobId >= bountyCount, marking orphaned', {
          jobId: job.jobId, bountyCount, syncedFromBlockchain: job.syncedFromBlockchain,
          contractAddress: job.contractAddress
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

      // Cross-check: find synced jobs that share an evaluationCid with another
      // job on the same contract. This is the hallmark of a phantom entry created
      // by a coincidental ID collision during duplicate creation attempts. For
      // each duplicate pair, verify which one matches chain truth and orphan the
      // other. Only checks duplicates to avoid excessive RPC calls.
      const cidCount = new Map();
      for (const j of storage.jobs) {
        if ((j.contractAddress || '').toLowerCase() !== currentContract) continue;
        if (j.status === 'ORPHANED' || !j.evaluationCid) continue;
        const key = j.evaluationCid;
        if (!cidCount.has(key)) cidCount.set(key, []);
        cidCount.get(key).push(j);
      }
      for (const [cid, jobs] of cidCount) {
        if (jobs.length < 2) continue;
        // Multiple local jobs share this evaluationCid — verify each against chain
        for (const job of jobs) {
          if (!job.syncedFromBlockchain || typeof job.jobId !== 'number') continue;
          if (job.jobId >= bountyCount) continue;
          try {
            const chainBounty = await contractService.getBounty(job.jobId);
            if (chainBounty.evaluationCid && job.evaluationCid !== chainBounty.evaluationCid) {
              logger.warn('[sync/stale-check] evaluationCid mismatch in duplicate set — orphaning phantom', {
                jobId: job.jobId,
                localCid: job.evaluationCid,
                chainCid: chainBounty.evaluationCid,
                localTitle: job.title
              });
              job.status = 'ORPHANED';
              job.orphanReason = 'evaluationCid_mismatch';
              staleCount++;
            }
          } catch (err) {
            logger.warn('[sync/stale-check] CID cross-check failed for job', {
              jobId: job.jobId, error: err.message
            });
          }
        }
      }

      if (staleCount > 0) {
        logger.info('[sync/stale-check] orphaned stale entries', { count: staleCount });
      }
      this._staleCheckDone = true;
    }

    // Phase D.6: Reactive heal sweep — backfill chain-authoritative fields for
    // jobs that were marked syncedFromBlockchain but are missing the
    // windowed/target fields. Originally one-shot at startup, but jobs can
    // drift into this state mid-process (e.g. BountyCreated event handler's
    // "existing" branch before the targetHunter backfill landed; bounties
    // #151-153 on Base). Runs every cycle when candidates exist.
    //
    // Detection heuristic: a synced job missing creatorDeterminationPayment OR
    // targetHunter (with no prior healed marker) is a clear indicator the
    // chain-fields backfill never ran. applyChainBountyFields always sets
    // creatorDeterminationPayment to a string ("0.0" for un-windowed), so a
    // missing/null value is unambiguous. We can't use null targetHunter as the
    // sole signal because untargeted bounties legitimately have it null —
    // pairing it with a sentinel (`_chainFieldsHealed`) lets us re-heal only
    // jobs that have never been backfilled.
    //
    // Steady-state cost: zero RPC calls (filter pass is in-memory; once a job
    // has been healed, _chainFieldsHealed=true keeps it out of the candidate
    // set forever). Per-cycle cap of 50 keeps a large backlog from blocking
    // the sync loop.
    //
    // Exact-amount backfill (2026-09-30): records written before bountyAmountWei
    // existed carry only the float display amount. Those are picked up here too,
    // regardless of the healed marker, so receipts/calldata stop re-deriving wei
    // from a rounded number. See needsChainFieldHeal().
    const healCandidates = storage.jobs.filter(j =>
      needsChainFieldHeal(j, currentContract, bountyCount)
    ).slice(0, 50);

    if (healCandidates.length > 0) {
      let healed = 0;
      for (const job of healCandidates) {
        try {
          const chainBounty = await contractService.getBounty(job.jobId);
          const changed = applyChainBountyFields(job, chainBounty);
          job.lastSyncedAt = Math.floor(Date.now() / 1000);
          job._chainFieldsHealed = true;
          // The chain read succeeded but produced no exact amount (should not
          // happen — getBounty always maps payoutWei). Mark it so this record
          // does not cost one RPC call every cycle forever.
          if (job.bountyAmountWei == null || job.bountyAmountWei === '0') job._weiBackfillAttempted = true;
          if (changed) {
            healed++;
            logger.info('[sync/heal] backfilled chain fields for previously-synced job', {
              jobId: job.jobId,
              targetHunter: job.targetHunter,
              creatorAssessmentWindowSize: job.creatorAssessmentWindowSize,
              creatorDeterminationPayment: job.creatorDeterminationPayment,
              bountyAmountWei: job.bountyAmountWei
            });
          }
        } catch (err) {
          logger.warn('[sync/heal] failed to backfill', {
            jobId: job.jobId, error: err.message
          });
        }
      }

      logger.info('[sync/heal] heal sweep complete', {
        candidates: healCandidates.length,
        healed
      });
    }

    // Phase D.6b: Metadata heal — retry the evaluation-package read for synced
    // jobs still titled "Bounty #N" (the gateways failed when the bounty was
    // discovered; mainnet 137/138) or still described "Fetched from blockchain"
    // (description only in the rubric; mainnet 117-136). See needsMetadataHeal()
    // for the retry budget. Steady-state cost: zero (in-memory filter, empty candidate set).
    {
      const nowSec = Math.floor(Date.now() / 1000);
      const metaCandidates = storage.jobs
        .filter(j => needsMetadataHeal(j, currentContract, nowSec))
        .slice(0, METADATA_HEAL_MAX_PER_CYCLE);
      for (const job of metaCandidates) {
        try {
          const outcome = await healJobMetadata(job, nowSec);
          if (outcome === 'retry') {
            logger.warn('[sync/metadata-heal] evaluation package unavailable; will retry', {
              jobId: job.jobId, attempts: job._metadataHealAttempts, nextAt: job._metadataHealNextAt
            });
          } else {
            logger.info('[sync/metadata-heal] metadata applied', { jobId: job.jobId, outcome, title: job.title });
          }
        } catch (err) {
          logger.warn('[sync/metadata-heal] failed', { jobId: job.jobId, error: err.message });
        }
      }
    }

    // Phase D.7: Submission-level continuous heal — find submissions on
    // windowed bounties whose local status is still 'Prepared', and
    // re-read chain state for them. A windowed bounty's submission can
    // never legitimately be in state 'Prepared' on chain — the contract
    // transitions it directly to PendingCreatorApproval. So if we see
    // local='Prepared' on a windowed bounty, the local record is stale
    // (the POST /submissions/confirm write landed before chain truth was
    // read, or the chain-read fallback in the event handler fired).
    // See bounty 46 / bounty 52 incidents.
    //
    // Runs every sync cycle, NOT just at startup. The candidate-detection
    // pass is an in-memory filter — zero RPC cost when nothing is stuck,
    // which is the steady state. Only when we find a stuck record do we
    // make any chain calls (one getSubmission per stuck record).
    //
    // This is the "recovery" backstop for the prevention fixes in
    // POST /submissions/confirm and the SubmissionPrepared event handler.
    // If either of those falls back to 'Prepared' due to a transient RPC
    // failure, the next sync cycle (~20 sec by default) will heal it.
    {
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

      // Steady state: zero candidates → skip the loop entirely (no RPC).
      if (subHealCandidates.length > 0) {
        let subHealed = 0;
        for (const { job, sub } of subHealCandidates) {
          try {
            const contract = contractService.contract;
            const chainSub = await contract.getSubmission(job.jobId, sub.submissionId);
            const statusIndex = Number(chainSub.status);
            const chainStatus = LOCAL_STATUS_BY_INDEX[statusIndex] || 'UNKNOWN';
            const chainOnChainStatus = ON_CHAIN_STATUS_BY_INDEX[statusIndex] || null;

            if (chainStatus !== sub.status) {
              sub.status = chainStatus;
              // Store the low-level chain enum name, not the collapsed
              // high-level form — analytics needs PassedPaid vs PassedUnpaid.
              if (chainOnChainStatus) {
                sub.onChainStatus = chainOnChainStatus;
              }
              sub.creatorWindowEnd = Number(chainSub.creatorWindowEnd) || null;
              if (chainSub.hunterCid && !sub.hunterCid) {
                sub.hunterCid = chainSub.hunterCid;
              }
              if (chainSub.ethMaxBudget != null) {
                sub.ethMaxBudget = chainSub.ethMaxBudget.toString();
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
                hunterCid: sub.hunterCid,
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

        logger.info('[sync/sub-heal] submission heal sweep complete', {
          candidates: subHealCandidates.length,
          healed: subHealed,
        });
      }
    }

    // Phase D.8: Reconcile finalized submissions that claim to have been PAID but
    // were never observed receiving a payout.
    //
    // Recovery backstop for the long-standing optimistic write in the
    // SubmissionFinalized handler, which labelled every passing submission
    // 'PassedPaid' without asking the chain. Losers in a two-passing race were
    // therefore shown to their hunters as paid winners. The handler now reads chain
    // truth, but records written before that fix — and any record whose chain read
    // failed — still need correcting, and no other pass can do it (D.7 above is
    // windowed-only and compares collapsed statuses).
    //
    // Candidate detection is a pure in-memory filter, so this costs zero RPC in the
    // steady state. Each corrected record either gains paidWinner or drops to
    // PassedUnpaid, so it leaves the candidate set permanently — the set drains and
    // stays drained rather than re-reading the same submissions every cycle.
    {
      const paidHealCandidates = [];
      for (const job of storage.jobs) {
        if ((job.contractAddress || '').toLowerCase() !== currentContract) continue;
        if (!job.syncedFromBlockchain) continue;
        if (job.status === 'ORPHANED') continue;
        for (const sub of job.submissions || []) {
          const claimsPaidUnwitnessed = sub.onChainStatus === 'PassedPaid' && !sub.paidWinner;
          const readFailedEarlier = !sub.onChainStatus && sub.status === 'APPROVED';
          if (claimsPaidUnwitnessed || readFailedEarlier) {
            paidHealCandidates.push({ job, sub });
          }
        }
      }

      if (paidHealCandidates.length > 0) {
        let paidHealed = 0;
        // Cap the reads per cycle so a large first-run backlog can't hammer the RPC
        // (Base's public endpoint throttles hard). Corrected records leave the
        // candidate set, so a backlog drains over consecutive cycles either way.
        const batch = paidHealCandidates.slice(0, PAID_HEAL_MAX_PER_CYCLE);
        for (const { job, sub } of batch) {
          try {
            const chainSub = await contractService.contract.getSubmission(job.jobId, sub.submissionId);
            const statusIndex = Number(chainSub.status);
            const chainOnChainStatus = ON_CHAIN_STATUS_BY_INDEX[statusIndex];
            if (!chainOnChainStatus) continue;

            const before = sub.onChainStatus;
            sub.onChainStatus = chainOnChainStatus;
            sub.status = LOCAL_STATUS_BY_INDEX[statusIndex];
            // Status 3 IS the payment record — trust it over the PayoutSent handler's
            // hunter-address match, which mis-attributes when one hunter has several
            // submissions on the same bounty.
            sub.paidWinner = statusIndex === 3;
            if (chainSub.acceptance != null) sub.acceptance = Number(chainSub.acceptance);
            if (chainSub.rejection != null) sub.rejection = Number(chainSub.rejection);
            if (chainSub.funder && !/^0x0{40}$/i.test(chainSub.funder)) sub.funder = chainSub.funder;

            if (before !== chainOnChainStatus) {
              paidHealed++;
              logger.info('[sync/paid-heal] corrected finalized status from chain', {
                bountyId: job.jobId,
                submissionId: sub.submissionId,
                was: before,
                now: chainOnChainStatus,
              });
            }
          } catch (err) {
            logger.warn('[sync/paid-heal] failed to read submission from chain', {
              bountyId: job.jobId,
              submissionId: sub.submissionId,
              error: err.message
            });
          }
        }

        logger.info('[sync/paid-heal] payout status sweep complete', {
          candidates: paidHealCandidates.length,
          examined: batch.length,
          healed: paidHealed,
          deferred: paidHealCandidates.length - batch.length,
        });
      }
    }

    // Phase E: Persist
    // Run the fresh-read → merge → orphan-handling → write as ONE serialized
    // critical section via withStorage(). withStorage re-reads fresh inside the
    // lock (merging any concurrent PATCH/createJob that landed during the heavy
    // phases above) and holds the lock through the write, so an API write can no
    // longer be lost between our read and our write — this is the orphan-race
    // fix on the sync side. The lock is held across _handleOrphanedJobs, whose
    // chain calls touch only the few expiring on-chain bounties per cycle, so
    // the hold is short.
    await jobStorage.withStorage(async (freshStorage) => {
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
    });
  }

  // ==========================================================================
  // One-time backfill: populate txHash + awardTxHash for synced jobs
  // ==========================================================================

  async _backfillAwardTxHashes(contractService) {
    try {
      const storage = await jobStorage.readStorage();
      const currentContract = jobStorage.getCurrentContractAddress();

      const needsBackfill = storage.jobs.filter(j =>
        (j.contractAddress || '').toLowerCase() === currentContract &&
        j.syncedFromBlockchain &&
        (!j.txHash || (j.status === 'AWARDED' && !j.awardTxHash))
      );

      if (needsBackfill.length === 0) return;

      logger.info('[backfill] Backfilling creation/award tx hashes', { count: needsBackfill.length });

      // Fetch all events from deployment block to find PayoutSent + BountyCreated
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

      // Build lookups: bountyId -> PayoutSent / BountyCreated
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

      // Apply the computed tx maps under the serialized lock on a fresh copy.
      // The event fetch above happened outside the lock; only this fast,
      // synchronous apply + write is serialized, so a concurrent API write
      // during the (long) event scan can't be lost.
      await jobStorage.withStorage((fresh, ctx) => {
        let patched = 0;
        for (const job of fresh.jobs) {
          if ((job.contractAddress || '').toLowerCase() !== currentContract) continue;

          if (!job.awardTxHash && payoutTxMap.has(job.jobId)) {
            job.awardTxHash = payoutTxMap.get(job.jobId);
            patched++;
          }
          if (!job.txHash && creationTxMap.has(job.jobId)) {
            const info = creationTxMap.get(job.jobId);
            job.txHash = info.txHash;
            if (!job.blockNumber) job.blockNumber = info.blockNumber;
            patched++;
          }
        }

        if (patched > 0) {
          logger.info('[backfill] creation/award tx backfill complete', { patched });
        } else {
          ctx.skipWrite = true;
        }
      });
    } catch (error) {
      logger.warn('[backfill] creation/award tx backfill failed', { error: error.message });
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
        const evaluationCid = args.evaluationCid;
        const creator = args.creator;
        const deadline = Number(args.submissionDeadline);

        const existing = storage.jobs.find(j =>
          j.jobId === bountyId &&
          (j.contractAddress || '').toLowerCase() === currentContract
        );

        if (existing) {
          // Guard against coincidental ID collisions: if the local job hasn't
          // been synced yet and its evaluationCid differs from the on-chain
          // event, this is a different bounty that just happens to share the
          // same local ID (nextId vs on-chain bountyId). Don't link — fall
          // through to the pending-job search or create a new entry.
          if (!existing.syncedFromBlockchain &&
              evaluationCid && existing.evaluationCid &&
              existing.evaluationCid !== evaluationCid) {
            logger.warn('[event] BountyCreated: jobId collision with unsynced job (evaluationCid mismatch)', {
              bountyId,
              localCid: existing.evaluationCid,
              chainCid: evaluationCid,
              localTitle: existing.title
            });
            // Fall through — do NOT break; let the pending-job search handle it
          } else {
            // Already tracked — make sure it's synced
            if (!existing.syncedFromBlockchain) {
              existing.syncedFromBlockchain = true;
              existing.contractAddress = currentContract;
              existing.lastSyncedAt = Math.floor(Date.now() / 1000);
            }
            // Backfill creation tx info if missing (covers sync-discovered bounties)
            if (!existing.txHash && transactionHash) existing.txHash = transactionHash;
            if (!existing.blockNumber && blockNumber) existing.blockNumber = blockNumber;

            // Pull chain-only fields (targetHunter + creator approval window).
            // Why: if the local job pre-existed (e.g. created via /jobs/create
            // without targetHunter in the body, then on-chain createBounty was
            // called directly), this branch is the only place the event handler
            // touches it — and without copying chain truth, targetHunter stays
            // null locally even though the contract has it set. Bug seen on
            // bounties #151-153 (Base) where /onchain-status returned the
            // target but /jobs/:id and the UI showed them as untargeted.
            if (existing.targetHunter == null || existing.creatorDeterminationPayment == null) {
              try {
                const bounty = await contractService.getBounty(bountyId);
                applyChainBountyFields(existing, bounty);
              } catch (err) {
                logger.warn('[event] BountyCreated: failed to backfill chain fields on existing job', {
                  bountyId, error: err.message
                });
              }
            }
            break;
          }
        }

        const pendingJob = findPendingJobForBountyCreated(storage.jobs, { evaluationCid, creator, deadline });

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
          if (!pendingJob.txHash && transactionHash) pendingJob.txHash = transactionHash;
          if (!pendingJob.blockNumber && blockNumber) pendingJob.blockNumber = blockNumber;
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
            await this.addJobFromBlockchain(bounty, storage, currentContract, { txHash: transactionHash, blockNumber });
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
            ethMaxBudget: args.ethMaxBudget?.toString(),
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

        // Record who attached the prepay (Submission.funder — the refund recipient; not in
        // the event, so one chain read). Non-fatal: the paid-heal pass fills it in later too.
        try {
          const chainSub = await contractService.contract.getSubmission(bountyId, submissionId);
          const target = sub || job.submissions[job.submissions.length - 1];
          if (chainSub.funder && !/^0x0{40}$/i.test(chainSub.funder)) target.funder = chainSub.funder;
        } catch (e) {
          logger.debug('[event] WorkSubmitted: funder read failed (will heal)', { bountyId, submissionId, msg: e.message });
        }

        // Mark bounty as HOT for oracle polling
        this.hotBountyIds.add(bountyId);
        logger.info('[event] WorkSubmitted — bounty marked HOT', { bountyId, submissionId });
        break;
      }

      case 'SubmissionFinalized': {
        const bountyId = Number(args.bountyId);
        const submissionId = Number(args.submissionId);
        // Contract event signature (September 2026 revision):
        //   (bountyId, submissionId, bool passed, bool paid, uint256 acceptance, uint256 rejection, string justificationCids)
        // `paid` is true only for the winner in that tx (PassedPaid); false for
        // Failed, PassedUnpaid and TIMED_OUT. It replaces the extra getSubmission()
        // read the old handler needed to tell PassedPaid from PassedUnpaid.
        const passed = Boolean(args.passed);
        const paid = Boolean(args.paid);
        const acceptance = Number(args.acceptance);
        const rejection = Number(args.rejection);
        const justificationCids = args.justificationCids || '';
        const job = this._findJob(storage, bountyId, currentContract);
        if (!job) break;

        const sub = (job.submissions || []).find(s => s.submissionId === submissionId);
        if (sub) {
          // Status index straight from the event: 2 Failed, 3 PassedPaid, 4 PassedUnpaid.
          const statusIndex = !passed ? 2 : (paid ? 3 : 4);

          if (!passed) {
            sub.status = 'REJECTED';
            sub.onChainStatus = 'Failed';
          } else {
            sub.status = LOCAL_STATUS_BY_INDEX[statusIndex];
            sub.onChainStatus = ON_CHAIN_STATUS_BY_INDEX[statusIndex];
            // `paid` is the authoritative record of payment (more reliable than the
            // PayoutSent handler's hunter-address match).
            sub.paidWinner = paid;
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

        logger.info('[event] SubmissionFinalized', { bountyId, submissionId, passed, paid, status: sub?.status });
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
          // Record that this passed via creator approval (not an oracle
          // evaluation) so the UI can say "accepted by the bounty creator"
          // rather than "passed the evaluation threshold". A creator-approved
          // submission never ran the oracle, so it has no verdiktaAggId.
          sub.creatorApproved = true;
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

      case 'EthRefunded': {
        const bountyId = Number(args.bountyId);
        const submissionId = Number(args.submissionId);
        const amount = args.amount?.toString();
        // A successful (inline or retried) prepay recovery clears any deferred flag.
        const job = this._findJob(storage, bountyId, currentContract);
        const sub = job && (job.submissions || []).find(s => s.submissionId === submissionId);
        if (sub && sub.refundDeferred) sub.refundDeferred = false;
        logger.info('[event] EthRefunded', { bountyId, submissionId, amount });
        break;
      }

      case 'RefundDeferred': {
        // The resolving tx (finalize / force-fail) could not recover the unspent oracle
        // prepay (wallet -> aggregator withdrawEth chain failed). The resolution itself
        // succeeded. Anyone can retry via recoverLeftoverEth(bountyId, submissionId);
        // the UI offers a "Recover oracle prepay" action while this flag is set.
        const bountyId = Number(args.bountyId);
        const submissionId = Number(args.submissionId);
        const job = this._findJob(storage, bountyId, currentContract);
        const sub = job && (job.submissions || []).find(s => s.submissionId === submissionId);
        if (sub) sub.refundDeferred = true;
        logger.warn('[event] RefundDeferred — prepay recovery failed in the resolving tx; retry with recoverLeftoverEth', { bountyId, submissionId });
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
   *
   * @param {object} eventMeta - Optional `{txHash, blockNumber}` from the
   *   BountyCreated event. When present, stored on the job so the Analytics
   *   "Creation Tx" column has a value. Gap-fill callers don't have this,
   *   and the one-shot _backfillAwardTxHashes heals those rows later.
   */
  async addJobFromBlockchain(bounty, storage, currentContract, eventMeta = null) {
    logger.info('Adding job from blockchain', { jobId: bounty.jobId, evaluationCid: bounty.evaluationCid });

    // ---- Duplicate prevention: check for existing job with same evaluationCid ----
    // This catches API-created jobs whose IDs were never aligned with on-chain IDs
    // (e.g. the PATCH /api/jobs/:id/bountyId step was skipped).
    if (bounty.evaluationCid) {
      // First try: unsynced pending job (same logic as _processEvent BountyCreated)
      // Exclude ORPHANED tombstones: a never-deployed/old-contract record that
      // happens to share an evaluationCid must not be revived and renumbered onto
      // this on-chain id (that resurrection is how two records collide on jobId).
      // Mirrors the route dedup guard in jobRoutes.js POST /jobs/create.
      const pendingJob = storage.jobs.find(j =>
        !j.syncedFromBlockchain &&
        j.status !== 'ORPHANED' &&
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
        if (!pendingJob.txHash && eventMeta?.txHash) pendingJob.txHash = eventMeta.txHash;
        if (!pendingJob.blockNumber && eventMeta?.blockNumber) pendingJob.blockNumber = eventMeta.blockNumber;
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
    let description = bounty.description || DEFAULT_SYNCED_DESCRIPTION;
    let workProductType = bounty.workProductType || DEFAULT_WORK_PRODUCT_TYPE;
    let juryNodes = [];

    try {
      const metadata = await fetchEvaluationMetadata(bounty.evaluationCid);
      if (metadata) {
        if (metadata.title) title = metadata.title;
        if (metadata.description) description = metadata.description;
        if (metadata.workProductType) workProductType = metadata.workProductType;
        if (Array.isArray(metadata.juryNodes)) juryNodes = metadata.juryNodes;
      } else if (bounty.evaluationCid && !bounty.evaluationCid.startsWith('dev-')) {
        logger.warn('Evaluation package unavailable; using default title until the metadata heal succeeds', {
          jobId: bounty.jobId, evaluationCid: bounty.evaluationCid
        });
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
      ...bountyAmountFields(bounty),
      bountyAmountUSD: 0,
      threshold: bounty.threshold,
      evaluationCid: bounty.evaluationCid,
      classId: bounty.classId,
      juryNodes,
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
      // Creator-chosen oracle request settings from getBounty().oracle
      oracleSettings: bounty.oracleSettings || null,
      onChain: true,
      syncedFromBlockchain: true,
      lastSyncedAt: Math.floor(Date.now() / 1000),
      contractAddress: currentContract,
      txHash: eventMeta?.txHash || null,
      blockNumber: eventMeta?.blockNumber || null
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
          // The Submission struct no longer carries evaluationCid (it is the bounty's);
          // keep whatever the local record already had.
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
          funder: sub.funder || null,
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
    // Fields that PATCH endpoints might set during sync — preserve fresh values.
    // Sync's Object.assign(freshJob, modifiedJob) below would otherwise
    // overwrite a concurrent PATCH that landed between our initial readStorage
    // and this merge. Add any new creator-controlled or off-chain-only fields
    // here when adding new PATCH endpoints.
    const patchPreserveFields = [
      'txHash', 'blockNumber', 'onChain', 'contractAddress',
      'publicSubmissions', 'publicSubmissionsUpdatedAt'
    ];

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

      // Orphan off-chain jobs that were never confirmed on-chain. A job is
      // considered on-chain if onChain===true OR syncedFromBlockchain===true.
      // Two triggers:
      //   1. Age > 1h (matches the ghost-hiding threshold in jobStorage.listJobs).
      //      After 1h an unsynced job is already hidden from list endpoints; we
      //      mark it ORPHANED in storage too so direct GET /api/jobs/:id lookups
      //      and analytics counters agree with list output.
      //   2. Past submissionCloseTime (belt-and-suspenders for short windows).
      // Recovery: if the on-chain tx eventually lands, the BountyCreated event
      // handler re-links the pending job (sets status=OPEN, syncedFromBlockchain=true),
      // so early orphaning is reversible.
      const GHOST_GRACE_SECS = 3600;
      const isOffChain = !job.onChain && !job.syncedFromBlockchain;
      const pastGhostGrace = (now - (job.createdAt || 0)) > GHOST_GRACE_SECS;
      const pastSubmissionDeadline = job.submissionCloseTime && now > job.submissionCloseTime;
      if (isOffChain && (pastGhostGrace || pastSubmissionDeadline)) {
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
  applyChainBountyFields, findPendingJobForBountyCreated, needsChainFieldHeal,
  needsMetadataHeal, applyEvaluationMetadata, healJobMetadata, fetchEvaluationMetadata };
