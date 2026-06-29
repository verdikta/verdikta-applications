/**
 * Verdikta Service
 * Read-only access to the ReputationAggregator and ReputationKeeper contracts
 * for arbiter/oracle analytics. One instance is cached per network so the UI
 * can toggle between Base Sepolia and Base mainnet.
 *
 * Ported (trimmed) from example-bounty-program. Only the analytics surface is
 * kept — the aggregation-history queries and their event ABIs are omitted.
 */

const { ethers } = require('ethers');
const logger = require('./logger');
const { networks, normalizeNetwork, getRpcUrl, getArchiveRpcUrl, getReceiptRpcUrl, funding } = require('../config');
const GasReceiptStore = require('./gasReceiptStore');

/**
 * Public RPC endpoints (sepolia.base.org / mainnet.base.org) rate-limit bursts
 * of parallel eth_calls and respond with an empty result. In ethers v6 that
 * surfaces as a CALL_EXCEPTION with `data == null` ("missing revert data") —
 * distinct from a real contract revert, which carries `data`. We retry those
 * transient drops; a genuine revert (with data) is not retried.
 */
function isTransientRpcError(err) {
  if (!err) return false;
  if (err.code === 'CALL_EXCEPTION' && (err.data == null)) return true;
  if (['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'BAD_DATA'].includes(err.code)) return true;
  const msg = String(err.message || '');
  return /missing revert data|rate|429|could not coalesce|timeout/i.test(msg);
}

async function withRetry(fn, { retries = 4, delayMs = 250 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransientRpcError(err)) throw err;
      // Exponential-ish backoff to let the public RPC recover.
      await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Used to throttle
 * the per-tx receipt fetches behind gas tracking so the backfill doesn't burst
 * the RPC. Results are returned in input order; a per-item rejection propagates
 * (callers wrap fn to swallow what they want to tolerate).
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Summarize a set of gas-receipt records (all one kind) into the shape the
 * analytics UI renders: min/median/max of gas units (the stable, gas-price-
 * independent measure) plus avg/total ETH cost. Returns null for an empty set.
 *
 * gasUsed fits in a JS Number (< 2^53); wei costs are summed as BigInt to avoid
 * precision loss, then formatted to ETH.
 */
function summarizeGas(records) {
  if (!records || !records.length) return null;
  const gas = records.map((r) => Number(r.gasUsed)).sort((a, b) => a - b);
  const n = gas.length;
  const median = n % 2
    ? gas[(n - 1) / 2]
    : Math.round((gas[n / 2 - 1] + gas[n / 2]) / 2);
  const totalCostWei = records.reduce((s, r) => s + BigInt(r.gasCostWei), 0n);
  const totalCostEth = Number(ethers.formatEther(totalCostWei));
  return {
    count: n,
    gasUsed: { min: gas[0], median, max: gas[n - 1] },
    costEth: { avg: totalCostEth / n, total: totalCostEth },
  };
}

// ReputationAggregator ABI — view functions needed for analytics.
const AGGREGATOR_ABI = [
  "function reputationKeeper() view returns (address)",
  // ETH pull-payment ledger: arbiter owners' earned ETH (base + bonus), claimed via
  // withdrawEth(). Replaces per-operator LINK (operator.withdrawable) as the live
  // "claimable" figure under the ETH-funded aggregator.
  "function ethOwed(address) view returns (uint256)",
  "function commitOraclesToPoll() view returns (uint256)",
  "function oraclesToPoll() view returns (uint256)",
  "function requiredResponses() view returns (uint256)",
  "function clusterSize() view returns (uint256)",
  "function bonusMultiplier() view returns (uint256)",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function maxOracleFee() view returns (uint256)",
  "function getContractConfig() view returns (address oracleAddr, address linkAddr, bytes32 jobId, uint256 fee)",
  // Extended config surfaced on the /contracts page.
  "function maxLikelihoodLength() view returns (uint256)",
  "function lastEntropyBlock() view returns (uint256)",
  "function MAX_CID_COUNT() view returns (uint256)",
  "function MAX_CID_LENGTH() view returns (uint256)",
  "function MAX_ADDENDUM_LENGTH() view returns (uint256)",
  // Reputation score deltas (per response outcome).
  "function clusteredTimelinessScore() view returns (int8)",
  "function clusteredQualityScore() view returns (int8)",
  "function selectedTimelinessScore() view returns (int8)",
  "function selectedQualityScore() view returns (int8)",
  "function revealedTimelinessScore() view returns (int8)",
  "function revealedQualityScore() view returns (int8)",
  "function committedTimelinessScore() view returns (int8)",
  "function committedQualityScore() view returns (int8)"
];

// ReputationKeeper ABI — oracle data.
// Note: registeredOracles auto-getter doesn't return classes array - must use getOracleClasses separately
const KEEPER_ABI = [
  "function getRegisteredOraclesCount() view returns (uint256)",
  "function registeredOracles(uint256 index) view returns (address oracle, bytes32 jobId)",
  "function getOracleInfo(address _oracle, bytes32 _jobId) view returns (bool isActive, int256 qualityScore, int256 timelinessScore, uint256 callCount, bytes32 jobId, uint256 fee, uint256 stakeAmount, uint256 lockedUntil, bool blocked)",
  "function getOracleClasses(uint256 index) view returns (uint64[])",
  "function getRecentScores(address _oracle, bytes32 _jobId) view returns (tuple(int256 qualityScore, int256 timelinessScore)[])",
  "function mildThreshold() view returns (int256)",
  "function severeThreshold() view returns (int256)",
  "function verdiktaToken() view returns (address)",
  // Extended config + live counters surfaced on the /contracts page.
  "function selectionCounter() view returns (uint256)",
  "function STAKE_REQUIREMENT() view returns (uint256)",
  "function lockDurationConfig() view returns (uint256)",
  "function slashAmountConfig() view returns (uint256)",
  "function shortlistSize() view returns (uint256)",
  "function minScoreForSelection() view returns (uint256)",
  "function maxScoreForSelection() view returns (uint256)",
  "function maxScoreHistory() view returns (uint256)",
  "function entropyBlock() view returns (uint256)"
];

// Minimal ERC-20 ABI for token metadata (wVDKA, LINK). Each getter is read
// individually and tolerated as missing — not every token implements name().
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)"
];

// ArbiterOperator (Chainlink Operator) ABI — owner + legacy LINK balance.
// An operator serves one owner and may back several jobIds. Under the ETH aggregator
// (0-juel dispatch) operators accrue NO new LINK — earnings go to ethOwed on the
// aggregator — so withdrawable() reflects only leftover LINK from the old aggregator.
const OPERATOR_ABI = [
  "function owner() view returns (address)",
  "function withdrawable() view returns (uint256)",
  // Node EOAs that submit commit/reveal txs and pay gas — the ETH-funded keys.
  "function getAuthorizedSenders() view returns (address[])"
];

// Chainlink Operator request/response events. Used to derive the per-jobId
// sending key from on-chain fulfillment history (the assignment lives off-chain
// in the node's job spec; on-chain we read it from the fulfillment tx's sender).
const ORACLE_EVENTS_ABI = [
  "event OracleRequest(bytes32 indexed specId, address requester, bytes32 requestId, uint256 payment, address callbackAddr, bytes4 callbackFunctionId, uint256 cancelExpiration, uint256 dataVersion, bytes data)",
  "event OracleResponse(bytes32 indexed requestId)"
];

// ReputationAggregator lifecycle events — used by the oracle-health panel to
// derive per-operator commit/reveal reliability and the network eval success
// rate from log history (no view function exposes these aggregate stats).
const AGG_EVENT_ABI = [
  "event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)",
  "event OracleSelected(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address oracle, bytes32 jobId)",
  "event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash)",
  "event RevealRequestDispatched(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash)",
  "event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, bytes32 indexed aggRequestId, address operator)",
  "event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] likelihoods, string justificationCID)"
];

// Full per-aggregation lifecycle surface, for the agg-history drill-down (the
// blow-by-blow of one evaluation: requirements, per-slot commit/reveal outcome,
// failure reasons, and final fulfillment). Mirrors example-bounty-program's
// agg-history so the same picture renders here. The getAggregationStatus view is
// the ETH aggregator's named status getter (the legacy auto-getter is gone).
const AGG_HISTORY_ABI = [
  "function commitOraclesToPoll() view returns (uint256)",
  "function oraclesToPoll() view returns (uint256)",
  "function requiredResponses() view returns (uint256)",
  "function maxLikelihoodLength() view returns (uint256)",
  "function getAggregationStatus(bytes32 aggId) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)",
  "event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)",
  "event OracleSelected(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address oracle, bytes32 jobId)",
  "event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash)",
  "event RevealRequestDispatched(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash)",
  "event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, bytes32 indexed aggRequestId, address operator)",
  "event RevealHashMismatch(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address operator, bytes16 expectedHash, bytes16 gotHash)",
  "event InvalidRevealFormat(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address operator, string badCid)",
  "event RevealTooManyScores(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address operator, uint256 responseLength, uint256 maxAllowed)",
  "event RevealWrongScoreCount(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address operator, uint256 responseLength, uint256 expectedLength)",
  "event RevealTooFewScores(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address operator, uint256 responseLength)",
  "event EvaluationFailed(bytes32 indexed aggRequestId, string phase)",
  "event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] likelihoods, string justificationCID)"
];
// Agg-history scan tuning (blocks). Windows are bounded so a drill-down never
// runs an unbounded full-history scan.
const AGGH_REQ_SEARCH_MARGIN = 7500;     // ± window around the estimated request block
const AGGH_EVENT_WINDOW = 8000;          // blocks after the request to collect lifecycle events
const AGGH_RECENT_FALLBACK_BLOCKS = 250000; // bounded look-back when the timestamp anchor is unavailable

class VerdiktaService {
  constructor(providerUrl, aggregatorAddress, options = {}) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.aggregatorAddress = aggregatorAddress;
    this.aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, this.provider);
    this.reputationKeeper = null;
    this.keeperAddress = null;

    // Network identity (used in logging / data paths).
    this.networkKey = options.networkKey || 'base-sepolia';

    // Aggregator deployment block — lower bound for event scans.
    this.aggregatorFromBlock = options.aggregatorFromBlock || 0;

    // Archive RPC for historical eth_getLogs (per-jobId sender derivation).
    // Lazy-init: only opened when an archive scan is requested.
    this.archiveRpcUrl = options.archiveRpcUrl || null;
    this._archiveProvider = null;

    // RPC for per-tx receipt fetches (gas tracking). Defaults to the read RPC
    // (Infura), overridable via RECEIPT_RPC_URL. Receipts are point lookups, so
    // this need not be the archive endpoint. Lazy-init.
    this.receiptRpcUrl = options.receiptRpcUrl || null;
    this._receiptProvider = null;

    // In-memory caches that let the by-class, by-owner and My Arbiters paths
    // share work. getAllOracles is the heavy enumeration; owner() is static.
    this._oraclesCache = null;          // { data, ts }
    this._ownerMap = {};                // { operatorLower: { owner, ts } }
    this._senderMap = {};               // { operatorLower: { senders: [addr], ts } }
    this._gasPrice = null;              // { value: bigint, ts }
    this._jobSenderCache = {};          // { operatorLower: { map, ts } }
  }

  /** Archive provider for log scans (Tenderly). Falls back to the read RPC. */
  _getArchiveProvider() {
    if (!this._archiveProvider) {
      const url = this.archiveRpcUrl;
      this._archiveProvider = url ? new ethers.JsonRpcProvider(url) : this.provider;
    }
    return this._archiveProvider;
  }

  /** Provider for receipt fetches (gas tracking). Falls back to the read RPC. */
  _getReceiptProvider() {
    if (!this._receiptProvider) {
      const url = this.receiptRpcUrl;
      this._receiptProvider = url ? new ethers.JsonRpcProvider(url) : this.provider;
    }
    return this._receiptProvider;
  }

  /**
   * Get ReputationKeeper contract instance (lazy-loaded)
   */
  async getReputationKeeper() {
    if (!this.reputationKeeper) {
      try {
        this.keeperAddress = await withRetry(() => this.aggregator.reputationKeeper());
        this.reputationKeeper = new ethers.Contract(this.keeperAddress, KEEPER_ABI, this.provider);
        logger.info('ReputationKeeper loaded', { address: this.keeperAddress });
      } catch (error) {
        logger.error('Failed to get ReputationKeeper address', { msg: error.message });
        throw error;
      }
    }
    return this.reputationKeeper;
  }

  /**
   * Get aggregator configuration
   */
  async getAggregatorConfig() {
    try {
      const [
        commitOraclesToPoll,
        oraclesToPoll,
        requiredResponses,
        clusterSize,
        bonusMultiplier,
        responseTimeoutSeconds,
        maxOracleFee
      ] = await Promise.all([
        withRetry(() => this.aggregator.commitOraclesToPoll()),
        withRetry(() => this.aggregator.oraclesToPoll()),
        withRetry(() => this.aggregator.requiredResponses()),
        withRetry(() => this.aggregator.clusterSize()),
        withRetry(() => this.aggregator.bonusMultiplier()),
        withRetry(() => this.aggregator.responseTimeoutSeconds()),
        withRetry(() => this.aggregator.maxOracleFee())
      ]);

      // Extended config (newer getters). Fetched tolerantly — a deployment
      // missing any one yields null for that field rather than failing the page.
      const num = (fn) => withRetry(fn).then((v) => Number(v)).catch(() => null);
      const [
        maxLikelihoodLength, lastEntropyBlock,
        maxCidCount, maxCidLength, maxAddendumLength,
        cT, cQ, sT, sQ, rT, rQ, mT, mQ
      ] = await Promise.all([
        num(() => this.aggregator.maxLikelihoodLength()),
        num(() => this.aggregator.lastEntropyBlock()),
        num(() => this.aggregator.MAX_CID_COUNT()),
        num(() => this.aggregator.MAX_CID_LENGTH()),
        num(() => this.aggregator.MAX_ADDENDUM_LENGTH()),
        num(() => this.aggregator.clusteredTimelinessScore()),
        num(() => this.aggregator.clusteredQualityScore()),
        num(() => this.aggregator.selectedTimelinessScore()),
        num(() => this.aggregator.selectedQualityScore()),
        num(() => this.aggregator.revealedTimelinessScore()),
        num(() => this.aggregator.revealedQualityScore()),
        num(() => this.aggregator.committedTimelinessScore()),
        num(() => this.aggregator.committedQualityScore())
      ]);

      return {
        commitOraclesToPoll: Number(commitOraclesToPoll),
        oraclesToPoll: Number(oraclesToPoll),
        requiredResponses: Number(requiredResponses),
        clusterSize: Number(clusterSize),
        bonusMultiplier: Number(bonusMultiplier),
        responseTimeoutSeconds: Number(responseTimeoutSeconds),
        maxOracleFee: ethers.formatEther(maxOracleFee),
        maxLikelihoodLength,
        lastEntropyBlock,
        inputLimits: { maxCidCount, maxCidLength, maxAddendumLength },
        // Per-outcome reputation score changes (timeliness/quality).
        scoreDeltas: {
          clustered: { timeliness: cT, quality: cQ },
          selected: { timeliness: sT, quality: sQ },
          revealed: { timeliness: rT, quality: rQ },
          committed: { timeliness: mT, quality: mQ }
        }
      };
    } catch (error) {
      logger.error('Failed to get aggregator config', { msg: error.message });
      throw error;
    }
  }

  /**
   * Extended ReputationKeeper config + live counters for the /contracts page:
   * stake requirement, penalty (lock/slash) config, selection-algorithm tuning,
   * and the live selection-round counter. Each field is read tolerantly.
   */
  async getKeeperConfig() {
    const keeper = await this.getReputationKeeper();
    const num = (fn) => withRetry(fn).then((v) => Number(v)).catch(() => null);
    const ether = (fn) => withRetry(fn).then((v) => ethers.formatEther(v)).catch(() => null);
    const [
      selectionCounter, stakeRequirement, lockDurationSeconds, slashAmount,
      shortlistSize, minScoreForSelection, maxScoreForSelection, maxScoreHistory, entropyBlock
    ] = await Promise.all([
      num(() => keeper.selectionCounter()),
      ether(() => keeper.STAKE_REQUIREMENT()),
      num(() => keeper.lockDurationConfig()),
      ether(() => keeper.slashAmountConfig()),
      num(() => keeper.shortlistSize()),
      num(() => keeper.minScoreForSelection()),
      num(() => keeper.maxScoreForSelection()),
      num(() => keeper.maxScoreHistory()),
      num(() => keeper.entropyBlock())
    ]);
    return {
      selectionCounter, stakeRequirement, lockDurationSeconds, slashAmount,
      shortlistSize, minScoreForSelection, maxScoreForSelection, maxScoreHistory, entropyBlock
    };
  }

  /**
   * Get total registered oracle count
   */
  async getOracleCount() {
    try {
      const keeper = await this.getReputationKeeper();
      const count = await withRetry(() => keeper.getRegisteredOraclesCount());
      return Number(count);
    } catch (error) {
      logger.error('Failed to get oracle count', { msg: error.message });
      throw error;
    }
  }

  /**
   * Get oracle identity at index
   */
  async getOracleAtIndex(index) {
    const keeper = await this.getReputationKeeper();
    // Get oracle address and jobId (auto-getter doesn't return classes array)
    const [oracle, jobId] = await withRetry(() => keeper.registeredOracles(index));
    // Get classes separately
    const classes = await withRetry(() => keeper.getOracleClasses(index));
    return {
      oracle,
      jobId,
      classes: classes.map(c => Number(c))
    };
  }

  /**
   * Get detailed oracle info
   */
  async getOracleInfo(oracleAddress, jobId) {
    try {
      const keeper = await this.getReputationKeeper();
      const info = await withRetry(() => keeper.getOracleInfo(oracleAddress, jobId));

      return {
        isActive: info.isActive,
        qualityScore: Number(info.qualityScore),
        timelinessScore: Number(info.timelinessScore),
        callCount: Number(info.callCount),
        jobId: info.jobId,
        fee: ethers.formatEther(info.fee),
        stakeAmount: ethers.formatEther(info.stakeAmount),
        lockedUntil: Number(info.lockedUntil),
        blocked: info.blocked
      };
    } catch (error) {
      logger.error('Failed to get oracle info', { oracle: oracleAddress, msg: error.message });
      throw error;
    }
  }

  /**
   * Get recent score history for an oracle
   */
  async getRecentScores(oracleAddress, jobId) {
    try {
      const keeper = await this.getReputationKeeper();
      const scores = await withRetry(() => keeper.getRecentScores(oracleAddress, jobId));
      return scores.map(s => ({
        qualityScore: Number(s.qualityScore),
        timelinessScore: Number(s.timelinessScore)
      }));
    } catch (error) {
      logger.warn('Failed to get recent scores', { oracle: oracleAddress, msg: error.message });
      return [];
    }
  }

  /**
   * Get reputation thresholds from the keeper contract
   */
  async getThresholds() {
    try {
      const keeper = await this.getReputationKeeper();
      const [mildThreshold, severeThreshold] = await Promise.all([
        withRetry(() => keeper.mildThreshold()),
        withRetry(() => keeper.severeThreshold())
      ]);
      return {
        mildThreshold: Number(mildThreshold),
        severeThreshold: Number(severeThreshold)
      };
    } catch (error) {
      logger.warn('Failed to get thresholds, using defaults', { msg: error.message });
      return { mildThreshold: -300, severeThreshold: -900 };
    }
  }

  /**
   * Analyze recent scores to determine if an oracle is unresponsive
   * An oracle is considered unresponsive if:
   * 1. Current timeliness score is significantly negative
   * 2. Recent timeliness scores show declining trend
   * 3. Most recent scores show rapid decline (missing responses)
   */
  analyzeResponsiveness(recentScores, currentTimelinessScore, thresholds) {
    // Check 1: Current timeliness is significantly negative (below -60, i.e. 3+ missed responses)
    // Each missed response gives -20, so -60 means at least 3 failures
    if (currentTimelinessScore <= -60) {
      return {
        isUnresponsive: true,
        reason: 'low_timeliness'
      };
    }

    // If we have recent scores, analyze the trend
    if (recentScores && recentScores.length >= 2) {
      // Check 2: Count total declines in recent history (not just consecutive)
      let declineCount = 0;
      for (let i = 1; i < recentScores.length; i++) {
        if (recentScores[i].timelinessScore < recentScores[i - 1].timelinessScore) {
          declineCount++;
        }
      }

      // If more than half of recent changes are declines, likely unresponsive
      const declineRatio = declineCount / (recentScores.length - 1);
      if (declineRatio >= 0.6 && currentTimelinessScore < 0) {
        return {
          isUnresponsive: true,
          reason: 'declining_timeliness'
        };
      }

      // Check 3: Sustained recent decline - look at last 8 scores.
      // Max single-step drop is 20, so a 140-point net drop over 7 increments
      // is equivalent to 7 consecutive declines (no zigzag possible).
      if (recentScores.length >= 8) {
        const last8 = recentScores.slice(-8);
        const recentDrop = last8[0].timelinessScore - last8[last8.length - 1].timelinessScore;
        if (recentDrop >= 140) {
          return {
            isUnresponsive: true,
            reason: 'rapid_decline'
          };
        }
      }
    }

    return { isUnresponsive: false, reason: null };
  }

  /**
   * Get all oracles with their info (batched for efficiency).
   *
   * Memoized per service instance so the by-class, by-owner and My Arbiters
   * paths can share one registry walk. Pass { maxAgeMs: 0 } to force a fresh
   * read (e.g. right after a deregister tx).
   */
  async getAllOracles({ maxAgeMs = 60000 } = {}) {
    if (this._oraclesCache && Date.now() - this._oraclesCache.ts < maxAgeMs) {
      return this._oraclesCache.data;
    }
    try {
      const count = await this.getOracleCount();
      logger.info('Fetching all oracles', { count });

      const oracles = [];

      // Small batches keep us under the public RPC's burst limits. A single
      // index that can't be read (after retries) yields an error sentinel
      // rather than failing the whole dataset, so partial data still renders.
      const batchSize = 4;
      for (let i = 0; i < count; i += batchSize) {
        const batchEnd = Math.min(i + batchSize, count);
        const batchPromises = [];

        for (let j = i; j < batchEnd; j++) {
          const index = j;
          batchPromises.push(
            this.getOracleAtIndex(index)
              .then(o =>
                Promise.all([
                  this.getOracleInfo(o.oracle, o.jobId),
                  this.getRecentScores(o.oracle, o.jobId)
                ]).then(([info, recentScores]) => ({ ...o, ...info, recentScores }))
              )
              .catch(err => {
                logger.warn('Failed to read oracle, skipping', { index, msg: err.message });
                return { index, error: err.message };
              })
          );
        }

        const oraclesWithInfo = await Promise.all(batchPromises);
        oracles.push(...oraclesWithInfo);
      }

      this._oraclesCache = { data: oracles, ts: Date.now() };
      return oracles;
    } catch (error) {
      logger.error('Failed to get all oracles', { msg: error.message });
      throw error;
    }
  }

  /**
   * Get arbiter availability statistics per class
   */
  async getArbiterAvailabilityByClass() {
    try {
      const [oracles, thresholds] = await Promise.all([
        this.getAllOracles(),
        this.getThresholds()
      ]);
      const byClass = {};
      const now = Math.floor(Date.now() / 1000);

      for (const oracle of oracles) {
        if (oracle.error) continue;

        // Determine if oracle is currently blocked
        const isBlocked = oracle.blocked && oracle.lockedUntil > now;

        // Analyze responsiveness based on recent scores
        const responsiveness = this.analyzeResponsiveness(
          oracle.recentScores,
          oracle.timelinessScore,
          thresholds
        );

        // Determine arbiter status - "new" if called fewer than 3 times
        const isNew = oracle.callCount < 3;
        let status;
        if (!oracle.isActive) status = 'inactive';
        else if (isBlocked) status = 'blocked';
        else if (responsiveness.isUnresponsive) status = 'unresponsive';
        else if (isNew) status = 'new';
        else status = 'active';

        for (const classId of oracle.classes) {
          if (!byClass[classId]) {
            byClass[classId] = {
              classId,
              active: 0,
              new: 0,
              blocked: 0,
              inactive: 0,
              unresponsive: 0,
              total: 0,
              avgQualityScore: 0,
              avgTimelinessScore: 0,
              totalCallCount: 0,
              qualityScores: [],
              timelinessScores: [],
              operatorAddresses: new Set(),
              arbiterList: []
            };
          }

          byClass[classId].total++;
          // Track unique operator contract addresses
          if (oracle.oracle) {
            byClass[classId].operatorAddresses.add(oracle.oracle.toLowerCase());
            byClass[classId].arbiterList.push({
              address: oracle.oracle,
              jobId: oracle.jobId,
              classes: oracle.classes || [classId],
              callCount: oracle.callCount,
              qualityScore: oracle.qualityScore,
              timelinessScore: oracle.timelinessScore,
              fee: oracle.fee,
              status
            });
          }

          byClass[classId][status]++;

          byClass[classId].totalCallCount += oracle.callCount;
          byClass[classId].qualityScores.push(oracle.qualityScore);
          byClass[classId].timelinessScores.push(oracle.timelinessScore);
        }
      }

      // Calculate averages and finalize data
      for (const classId of Object.keys(byClass)) {
        const cls = byClass[classId];
        if (cls.qualityScores.length > 0) {
          cls.avgQualityScore = Math.round(
            cls.qualityScores.reduce((a, b) => a + b, 0) / cls.qualityScores.length
          );
          cls.avgTimelinessScore = Math.round(
            cls.timelinessScores.reduce((a, b) => a + b, 0) / cls.timelinessScores.length
          );
        }
        // Convert operator Set to count and list
        cls.operators = cls.operatorAddresses.size;
        cls.operatorList = Array.from(cls.operatorAddresses);
        // Remove raw data from output
        delete cls.qualityScores;
        delete cls.timelinessScores;
        delete cls.operatorAddresses;
      }

      return {
        byClass,
        totalOracles: oracles.filter(o => !o.error).length,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error('Failed to get arbiter availability', { msg: error.message });
      throw error;
    }
  }

  /**
   * Derive a display status for an arbiter from its on-chain info, matching the
   * logic used by the availability table.
   */
  _statusFor(oracle, thresholds, now) {
    const isBlocked = oracle.blocked && oracle.lockedUntil > now;
    const responsiveness = this.analyzeResponsiveness(
      oracle.recentScores,
      oracle.timelinessScore,
      thresholds
    );
    if (!oracle.isActive) return 'inactive';
    if (isBlocked) return 'blocked';
    if (responsiveness.isUnresponsive) return 'unresponsive';
    if (oracle.callCount < 3) return 'new';
    return 'active';
  }

  /**
   * Arbiters owned by a given wallet, grouped by operator contract.
   *
   * Ownership is the operator contract's own `owner()` (Chainlink ConfirmedOwner)
   * — the address that earns ETH (ethOwed on the aggregator) and may deregister.
   * Claimable ETH is per-owner (returned once at the top level as claimableEth); the
   * per-operator withdrawableLink is LEGACY (leftover old-aggregator LINK). Stake/lock
   * state is reported per (oracle, jobId).
   *
   * The keeper + aggregator addresses are returned so the client can build the
   * deregister and withdrawEth txs.
   */
  async getOwnedArbiters(ownerAddress) {
    const target = String(ownerAddress).toLowerCase();
    // Ensure keeperAddress is resolved for the client write path.
    await this.getReputationKeeper();

    const [oracles, thresholds] = await Promise.all([
      // Force-fresh so the page reflects state right after a claim/deregister tx.
      this.getAllOracles({ maxAgeMs: 0 }),
      this.getThresholds()
    ]);

    // Distinct operator contracts (skip indexes that failed to read).
    const operatorAddrs = [...new Set(
      oracles.filter(o => !o.error && o.oracle).map(o => o.oracle)
    )];

    // Read owner() + withdrawable() per operator, tolerating failures so one
    // bad operator doesn't sink the whole list.
    const ownerInfo = {};
    await Promise.all(operatorAddrs.map(async (addr) => {
      const op = new ethers.Contract(addr, OPERATOR_ABI, this.provider);
      const [owner, withdrawable] = await Promise.all([
        withRetry(() => op.owner()).catch(() => null),
        withRetry(() => op.withdrawable()).catch(() => null)
      ]);
      ownerInfo[addr.toLowerCase()] = {
        owner: owner ? String(owner) : null,
        withdrawable
      };
    }));

    const now = Math.floor(Date.now() / 1000);
    const byOperator = {};

    for (const oracle of oracles) {
      if (oracle.error || !oracle.oracle) continue;
      const info = ownerInfo[oracle.oracle.toLowerCase()];
      if (!info || !info.owner || info.owner.toLowerCase() !== target) continue;

      if (!byOperator[oracle.oracle]) {
        byOperator[oracle.oracle] = {
          operator: oracle.oracle,
          owner: info.owner,
          withdrawableLink: info.withdrawable != null
            ? ethers.formatEther(info.withdrawable)
            : null,
          jobs: []
        };
      }

      byOperator[oracle.oracle].jobs.push({
        jobId: oracle.jobId,
        classes: oracle.classes,
        status: this._statusFor(oracle, thresholds, now),
        isActive: oracle.isActive,
        blocked: oracle.blocked,
        lockedUntil: oracle.lockedUntil,
        locked: oracle.lockedUntil > now,
        stakeAmount: oracle.stakeAmount, // formatted ether string ("100.0")
        fee: oracle.fee,
        callCount: oracle.callCount,
        qualityScore: oracle.qualityScore,
        timelinessScore: oracle.timelinessScore
      });
    }

    // Attach per-operator ETH funding (node sending-key balances + estimate).
    const ownedOps = Object.keys(byOperator);
    if (ownedOps.length) {
      const { perOp, gasPrice } = await this._computeFunding(ownedOps);
      for (const opAddr of ownedOps) {
        byOperator[opAddr].funding = this._fundingForClient(
          perOp[opAddr.toLowerCase()] || { senders: [], totalWei: 0n },
          gasPrice
        );
      }
    }

    // Attach per-jobId sender (derived from fulfillment-history log scan via
    // the archive RPC; null for never-used arbiters). Operators are scanned in
    // parallel; failures are logged and leave job.sender = null without
    // breaking the listing.
    if (ownedOps.length) {
      await Promise.all(ownedOps.map(async (opAddr) => {
        const opData = byOperator[opAddr];
        try {
          const senderMap = await this.getJobSenderMap(opAddr, opData.jobs.map((j) => j.jobId));
          for (const job of opData.jobs) {
            job.sender = senderMap[String(job.jobId).toLowerCase()] || null;
          }
        } catch (err) {
          logger.warn('per-jobId sender scan failed', { operator: opAddr, msg: err.message });
          for (const job of opData.jobs) job.sender = null;
        }
      }));
    }

    // Live claimable ETH is per-OWNER (ethOwed on the aggregator), aggregated across all
    // the owner's operators — unlike the legacy per-operator LINK (withdrawableLink),
    // which is retained on each operator card only for draining old-aggregator LINK.
    const ethOwedWei = await this.getEthOwed(ownerAddress);

    return {
      owner: ownerAddress,
      keeperAddress: this.keeperAddress,
      aggregatorAddress: this.aggregatorAddress,
      claimableEth: ethOwedWei != null ? ethers.formatEther(ethOwedWei) : null,
      operators: Object.values(byOperator),
      timestamp: Date.now()
    };
  }

  /**
   * Read a contract method for many operator addresses in small batches, with
   * retry, tolerating per-operator failures (returns null for those).
   */
  async _batchOperatorRead(operatorAddrs, method) {
    const out = {};
    const batchSize = 6;
    for (let i = 0; i < operatorAddrs.length; i += batchSize) {
      const slice = operatorAddrs.slice(i, i + batchSize);
      await Promise.all(slice.map(async (addr) => {
        const op = new ethers.Contract(addr, OPERATOR_ABI, this.provider);
        out[addr.toLowerCase()] = await withRetry(() => op[method]()).catch(() => null);
      }));
    }
    return out;
  }

  /**
   * operator (lowercased) -> owner address. owner() is effectively static, so
   * results are cached per instance and only re-read when missing or stale.
   */
  async getOwnerMap(operatorAddrs, { maxAgeMs = 600000 } = {}) {
    const now = Date.now();
    const stale = operatorAddrs.filter((a) => {
      const e = this._ownerMap[a.toLowerCase()];
      return !e || now - e.ts >= maxAgeMs;
    });
    if (stale.length) {
      const fresh = await this._batchOperatorRead(stale, 'owner');
      for (const [addr, owner] of Object.entries(fresh)) {
        this._ownerMap[addr] = { owner: owner ? String(owner) : null, ts: now };
      }
    }
    const map = {};
    for (const a of operatorAddrs) map[a.toLowerCase()] = this._ownerMap[a.toLowerCase()]?.owner ?? null;
    return map;
  }

  /**
   * operator (lowercased) -> legacy withdrawable LINK (bigint) or null. Read fresh.
   * Under the ETH aggregator operators no longer accrue LINK (0-juel dispatch), so this
   * is normally 0; it survives only to let owners drain LINK left over from the old
   * aggregator (the secondary "legacy LINK" claim path in My Arbiters).
   */
  async getWithdrawableMap(operatorAddrs) {
    return this._batchOperatorRead(operatorAddrs, 'withdrawable');
  }

  /**
   * ETH (wei) owed to `owner` on the aggregator's pull-payment ledger, or null on read
   * error. This is the live "claimable" figure under the ETH aggregator — earnings are
   * credited per OWNER (aggregated across all their operators), not per operator.
   */
  async getEthOwed(ownerAddress) {
    if (!ownerAddress) return null;
    return withRetry(() => this.aggregator.ethOwed(ownerAddress)).catch(() => null);
  }

  /** owner (lowercased) -> ethOwed (bigint) or null. Batched with bounded concurrency. */
  async getEthOwedMap(ownerAddrs) {
    const out = {};
    await mapWithConcurrency(ownerAddrs, 6, async (addr) => {
      out[addr.toLowerCase()] = await this.getEthOwed(addr);
    });
    return out;
  }

  // --- ETH funding of arbiter nodes ---------------------------------------
  //
  // Each operator's authorized senders are the node EOAs that submit
  // commit/reveal txs and pay gas. Funding = the ETH balance of those keys.
  // Senders are static-ish (cached); balances + gas price are read fresh.

  /** operator (lowercased) -> [sender addresses]. Cached (senders rarely change). */
  async getSenderMap(operatorAddrs, { maxAgeMs = 600000 } = {}) {
    const now = Date.now();
    const stale = operatorAddrs.filter((a) => {
      const e = this._senderMap[a.toLowerCase()];
      return !e || now - e.ts >= maxAgeMs;
    });
    const batchSize = 6;
    for (let i = 0; i < stale.length; i += batchSize) {
      const slice = stale.slice(i, i + batchSize);
      await Promise.all(slice.map(async (addr) => {
        const op = new ethers.Contract(addr, OPERATOR_ABI, this.provider);
        const senders = await withRetry(() => op.getAuthorizedSenders()).catch(() => []);
        this._senderMap[addr.toLowerCase()] = { senders: senders.map(String), ts: now };
      }));
    }
    const map = {};
    for (const a of operatorAddrs) map[a.toLowerCase()] = this._senderMap[a.toLowerCase()]?.senders || [];
    return map;
  }

  /** address (lowercased) -> ETH balance (bigint) or null. Read fresh, batched. */
  async getBalances(addrs) {
    const out = {};
    const batchSize = 8;
    for (let i = 0; i < addrs.length; i += batchSize) {
      const slice = addrs.slice(i, i + batchSize);
      await Promise.all(slice.map(async (a) => {
        out[a.toLowerCase()] = await withRetry(() => this.provider.getBalance(a)).catch(() => null);
      }));
    }
    return out;
  }

  /** Current gas price in wei (bigint), short-cached. */
  async getGasPrice() {
    const now = Date.now();
    if (this._gasPrice && now - this._gasPrice.ts < 30000) return this._gasPrice.value;
    const fee = await withRetry(() => this.provider.getFeeData());
    const value = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
    this._gasPrice = { value, ts: now };
    return value;
  }

  /**
   * Internal: per-operator funding in wei + the live gas price.
   * Returns { perOp: { opLower: { senders:[{address, balanceWei}], totalWei } }, gasPrice }.
   */
  async _computeFunding(operatorAddrs) {
    const senderMap = await this.getSenderMap(operatorAddrs);
    const allSenders = [...new Set(Object.values(senderMap).flat().map((a) => a.toLowerCase()))];
    const [balances, gasPrice] = await Promise.all([
      this.getBalances(allSenders),
      this.getGasPrice()
    ]);
    const perOp = {};
    for (const op of operatorAddrs) {
      const lower = op.toLowerCase();
      const senders = (senderMap[lower] || []).map((a) => ({
        address: a,
        balanceWei: balances[a.toLowerCase()] ?? 0n
      }));
      const totalWei = senders.reduce((acc, s) => acc + (s.balanceWei ?? 0n), 0n);
      perOp[lower] = { senders, totalWei };
    }
    return { perOp, gasPrice };
  }

  /** Estimated remaining queries for a wei balance at the given gas price. */
  _estQueries(totalWei, gasPrice) {
    const costPerQuery = BigInt(funding.gasPerQuery) * (gasPrice ?? 0n);
    return costPerQuery > 0n ? Number(totalWei / costPerQuery) : null;
  }

  /** Is a wei balance "low" (below the query OR the absolute-ETH threshold)? */
  _fundingLow(totalWei, estQueries) {
    const lowEthWei = ethers.parseEther(String(funding.lowEthThreshold));
    return (estQueries != null && estQueries < funding.lowQueriesThreshold) || totalWei < lowEthWei;
  }

  /** Client-safe funding object for one operator (no bigints). */
  _fundingForClient({ senders, totalWei }, gasPrice) {
    const estQueries = this._estQueries(totalWei, gasPrice);
    return {
      totalEth: ethers.formatEther(totalWei),
      estQueries,
      low: this._fundingLow(totalWei, estQueries),
      senders: senders.map((s) => ({ address: s.address, balanceEth: ethers.formatEther(s.balanceWei ?? 0n) })),
      gasPriceGwei: gasPrice != null ? ethers.formatUnits(gasPrice, 'gwei') : null,
      gasPerQuery: funding.gasPerQuery,
      lowQueriesThreshold: funding.lowQueriesThreshold,
      lowEthThreshold: funding.lowEthThreshold
    };
  }

  // --- Per-jobId sender derivation -----------------------------------------
  //
  // On-chain there's no `(jobId → sending key)` mapping — the operator
  // contract just has one global `authorizedSenders` list. The 1:1 a node
  // operator configures (job spec `fromAddress`) is off-chain. We recover it
  // by scanning fulfillment history: each `OracleResponse(requestId)` event's
  // transaction was sent by the key that fulfilled it; the matching
  // `OracleRequest(specId, ..., requestId, ...)` ties that requestId to a
  // jobId. We walk back chunked through the archive RPC with an early-exit
  // when all requested jobIds have a hit. Unused arbiters → null (no history).

  /**
   * Operator (lowercased) → { jobIdLower: senderAddress }. Cached per operator
   * (30 min). On any failure returns the best-effort partial map; never throws.
   */
  async getJobSenderMap(operatorAddress, jobIds) {
    const opLower = operatorAddress.toLowerCase();
    const wantLower = (jobIds || []).map((j) => String(j).toLowerCase());
    const cached = this._jobSenderCache[opLower];
    // Cache hit only if it's fresh AND has already attempted every requested
    // jobId (otherwise a newly-registered arbiter would stay "—" until TTL).
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000 &&
        wantLower.every((j) => cached.attempted.has(j))) {
      return cached.map;
    }

    const provider = this._getArchiveProvider();
    const iface = new ethers.Interface(ORACLE_EVENTS_ABI);
    const reqTopic = iface.getEvent('OracleRequest').topicHash;
    const respTopic = iface.getEvent('OracleResponse').topicHash;

    const needed = new Set((jobIds || []).map((j) => String(j).toLowerCase()));
    const reqIdToSpec = {};        // requestId(lower) → specId(lower), accumulated
    let pendingResp = [];          // responses whose matching request isn't seen yet
    const senderByJob = {};

    let latest;
    try {
      latest = await withRetry(() => provider.getBlockNumber());
    } catch (err) {
      logger.warn('archive getBlockNumber failed', { operator: operatorAddress, msg: err.message });
      // Don't poison the cache with a failure — let the next request retry.
      return senderByJob;
    }

    // Chunk size sits just under Tenderly's 100k-block per-query cap. The
    // total look-back covers infrequent arbiters (testnet activity can lag by
    // weeks); cached for 30 min after, so this is paid at most rarely.
    const CHUNK = 90_000;     // ≤ 100k per-query (Tenderly free-tier cap)
    const MAX_CHUNKS = 25;    // ≈ 2.25M blocks (~52 days on Base) of look-back

    let toBlock = latest;
    for (let i = 0; i < MAX_CHUNKS && needed.size > 0; i++) {
      const fromBlock = Math.max(0, toBlock - CHUNK + 1);
      let reqLogs = [];
      let respLogs = [];
      try {
        [reqLogs, respLogs] = await Promise.all([
          withRetry(() => provider.getLogs({ address: operatorAddress, topics: [reqTopic], fromBlock, toBlock })),
          withRetry(() => provider.getLogs({ address: operatorAddress, topics: [respTopic], fromBlock, toBlock })),
        ]);
      } catch (err) {
        logger.warn('archive getLogs failed', { operator: operatorAddress, fromBlock, toBlock, msg: err.message });
        break;
      }

      for (const log of reqLogs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          reqIdToSpec[String(parsed.args.requestId).toLowerCase()] = String(parsed.args.specId).toLowerCase();
        } catch { /* skip malformed */ }
      }

      // Add new responses to the pending pool (newer first).
      for (const log of respLogs) {
        pendingResp.push({
          requestId: log.topics[1].toLowerCase(),
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.index,
        });
      }
      pendingResp.sort((a, b) => (b.blockNumber - a.blockNumber) || (b.logIndex - a.logIndex));

      // Try to resolve any pending response whose request we now know about,
      // for jobs we care about that aren't yet resolved. Keep the rest pending.
      const stillPending = [];
      for (const r of pendingResp) {
        if (needed.size === 0) break;
        const specId = reqIdToSpec[r.requestId];
        if (!specId) { stillPending.push(r); continue; }
        if (!needed.has(specId)) continue; // request we don't care about — drop
        if (senderByJob[specId]) continue; // already have it
        try {
          const tx = await withRetry(() => provider.getTransaction(r.txHash));
          if (tx?.from) {
            senderByJob[specId] = ethers.getAddress(tx.from);
            needed.delete(specId);
          }
        } catch (err) {
          // transient; keep it pending so we can retry next chunk
          stillPending.push(r);
        }
      }
      pendingResp = stillPending;

      if (fromBlock === 0) break;
      toBlock = fromBlock - 1;
    }

    this._jobSenderCache[opLower] = {
      map: senderByJob,
      attempted: new Set(wantLower),
      ts: Date.now(),
    };
    return senderByJob;
  }

  // --- Oracle health (commit/reveal reliability + eval success rate) -------
  //
  // No view function exposes aggregate commit/reveal stats, so we derive them
  // from the aggregator's lifecycle events over a recent block window via the
  // archive RPC. Per request the protocol polls K oracles (OracleSelected),
  // waits for M commits (CommitReceived) to enter the reveal phase, then needs
  // N reveals (NewOracleResponseRecorded) to fulfill (FulfillAIEvaluation).
  // Tallying selected→committed→revealed per operator surfaces nodes that
  // commit but never reveal — the failure mode that silently sinks evaluations.

  /**
   * @param {{ days?: number }} [opts] look-back window in days (default 14).
   * @returns {Promise<object>} success-rate + per-operator reliability, plus a
   *   `partial` flag if a chunk error cut the scan short.
   */
  async getOracleHealth({ days = 14 } = {}) {
    const provider = this._getArchiveProvider();
    const iface = new ethers.Interface(AGG_EVENT_ABI);
    const topic = (name) => iface.getEvent(name).topicHash;
    const T = {
      request: topic('RequestAIEvaluation'),
      selected: topic('OracleSelected'),
      commit: topic('CommitReceived'),
      revealReq: topic('RevealRequestDispatched'),
      reveal: topic('NewOracleResponseRecorded'),
      fulfill: topic('FulfillAIEvaluation'),
    };

    const latest = await withRetry(() => provider.getBlockNumber());
    const windowBlocks = Math.max(1, Math.round(days * 43200)); // ~2s/block on Base
    const floor = Math.max(this.aggregatorFromBlock || 0, latest - windowBlocks);

    const CHUNK = 90_000; // ≤ Tenderly's 100k per-query cap
    const parse = (log) => iface.parseLog({ topics: log.topics, data: log.data });
    const ops = {}; // operatorLower → { operator, selected, commits, reveals }
    const bump = (addr, field) => {
      if (!addr) return;
      const lower = addr.toLowerCase();
      if (!ops[lower]) ops[lower] = { operator: ethers.getAddress(addr), selected: 0, commits: 0, reveals: 0 };
      ops[lower][field]++;
    };

    // Per-evaluation, per-slot map for blame attribution. Each (aggRequestId,
    // pollIndex) is one arbiter slot = an (operator, jobId) pairing. Commit and
    // reveal events carry the same pollIndex, so they link back to the slot.
    // When an evaluation never reaches FulfillAIEvaluation it failed/timed out,
    // and we blame the arbiters that didn't do their part (see blame pass below).
    const evals = {}; // aggIdLower → { fulfilled, slots: { pollIndexStr → { operator, committed, revealRequested, revealed } } }
    const evalFor = (aggId) => {
      const k = (aggId || '').toLowerCase();
      if (!evals[k]) evals[k] = { fulfilled: false, slots: {} };
      return evals[k];
    };
    const slotFor = (aggId, pollIndex, operator) => {
      const ev = evalFor(aggId);
      const pk = pollIndex == null ? '?' : pollIndex.toString();
      if (!ev.slots[pk]) ev.slots[pk] = { operator: operator || null, committed: false, revealRequested: false, revealed: false };
      else if (operator && !ev.slots[pk].operator) ev.slots[pk].operator = operator;
      return ev.slots[pk];
    };

    // Fetch all five event types in ONE getLogs per chunk via an OR'd topic0
    // filter (the free archive gateway is slow/rate-limited, so 1 call/chunk
    // beats 5), then dispatch each log by its decoded event name.
    const topic0Or = [Object.values(T)];
    let requests = 0, fulfilled = 0, scannedChunks = 0, partial = false;
    // Gas tracking: collect the commit/reveal tx references seen during the scan
    // so we can fetch their receipts afterward (gasUsed lives on the receipt, not
    // the log). `fulfillTxHashes` flags reveal txs that also completed the round
    // (emitted FulfillAIEvaluation) — their gas is inflated by aggregation work.
    const commitRevealLogs = []; // { kind, txHash, operator, blockNumber }
    const fulfillTxHashes = new Set();
    // Daily buckets for the trend sparkline — one per day of the scan window.
    // Index = days ago (0 = most recent ~24h). Bucketed by block offset
    // (~43200 blocks/day on Base) so no per-event timestamp lookups are needed.
    const BLOCKS_PER_DAY = 43200;
    const daily = Array.from({ length: days }, () => ({ requests: 0, fulfilled: 0 }));
    const dayOff = (blk) => Math.floor((latest - blk) / BLOCKS_PER_DAY);
    let toBlock = latest;
    while (toBlock >= floor) {
      const fromBlock = Math.max(floor, toBlock - CHUNK + 1);
      let logs;
      try {
        logs = await withRetry(() => provider.getLogs({
          address: this.aggregatorAddress, topics: topic0Or, fromBlock, toBlock
        }));
      } catch (err) {
        logger.warn('oracle-health getLogs failed', { network: this.networkKey, fromBlock, toBlock, msg: err.message });
        partial = true;
        break;
      }
      for (const log of logs) {
        let p;
        try { p = parse(log); } catch { continue; }
        switch (p.name) {
          case 'RequestAIEvaluation': { requests++; const o = dayOff(log.blockNumber); if (o >= 0 && o < days) daily[o].requests++; evalFor(p.args.aggRequestId); break; }
          case 'FulfillAIEvaluation': { fulfilled++; const o = dayOff(log.blockNumber); if (o >= 0 && o < days) daily[o].fulfilled++; fulfillTxHashes.add(log.transactionHash.toLowerCase()); evalFor(p.args.aggRequestId).fulfilled = true; break; }
          case 'OracleSelected': bump(p.args.oracle, 'selected'); slotFor(p.args.aggRequestId, p.args.pollIndex, p.args.oracle); break;
          case 'CommitReceived': bump(p.args.operator, 'commits'); slotFor(p.args.aggRequestId, p.args.pollIndex, p.args.operator).committed = true; commitRevealLogs.push({ kind: 'commit', txHash: log.transactionHash, operator: p.args.operator, blockNumber: log.blockNumber }); break;
          case 'RevealRequestDispatched': slotFor(p.args.aggRequestId, p.args.pollIndex, null).revealRequested = true; break;
          case 'NewOracleResponseRecorded': bump(p.args.operator, 'reveals'); slotFor(p.args.aggRequestId, p.args.pollIndex, p.args.operator).revealed = true; commitRevealLogs.push({ kind: 'reveal', txHash: log.transactionHash, operator: p.args.operator, blockNumber: log.blockNumber }); break;
        }
      }
      scannedChunks++;
      if (fromBlock === floor) break;
      toBlock = fromBlock - 1;
    }

    // ---- Blame attribution. An evaluation needs 4 commits then 3 reveals to be
    // fulfilled; one that never fulfilled (failed/timed out) is charged to the
    // arbiter slots that fell short. The two stages are mutually exclusive: if
    // the commit threshold wasn't met the round never reached the reveal stage,
    // so only non-committers are blamed; otherwise the committers that failed to
    // reveal are blamed. A slot is an (operator, jobId) arbiter, so an operator
    // backing several slots in one round is docked once per blameworthy slot.
    const COMMITS_REQUIRED = 4;
    const REVEALS_REQUIRED = 3;
    // operatorLower → { count, evals: { aggId → { stage, slots } } }. `count` is
    // the total blameworthy slot instances (the Blameworthy column); `evals` lists
    // the distinct failed aggIds this operator is responsible for (for the drill-down).
    const blameByOp = {};
    const dockBlame = (operator, aggId, stage) => {
      if (!operator) return;
      const k = operator.toLowerCase();
      if (!blameByOp[k]) blameByOp[k] = { count: 0, evals: {} };
      blameByOp[k].count++;
      const e = blameByOp[k].evals[aggId] || (blameByOp[k].evals[aggId] = { stage, slots: 0 });
      e.slots++;
    };
    for (const [aggId, ev] of Object.entries(evals)) {
      if (ev.fulfilled) continue; // succeeded — no blame
      const slots = Object.values(ev.slots);
      const commitCount = slots.filter((s) => s.committed).length;
      if (commitCount < COMMITS_REQUIRED) {
        // Failed at the commit stage: blame every selected slot that didn't commit.
        for (const s of slots) if (!s.committed) dockBlame(s.operator, aggId, 'commit');
      } else {
        const revealCount = slots.filter((s) => s.revealed).length;
        if (revealCount < REVEALS_REQUIRED) {
          // Reached the reveal stage but fell short: blame only arbiters that were
          // ASKED to reveal (RevealRequestDispatched) and didn't. A committer that
          // was never sent a reveal request did its job — not blameworthy. (Only a
          // subset of committers are dispatched reveal requests.)
          for (const s of slots) if (s.revealRequested && !s.revealed) dockBlame(s.operator, aggId, 'reveal');
        }
      }
    }

    // Count currently-registered arbiters (jobId registrations) per operator
    // contract, for context next to the reliability numbers. Independent of the
    // event scan — if the enumeration fails, counts are simply omitted (null).
    let arbiterCountByOp = {};
    try {
      const oracles = await this.getAllOracles();
      for (const o of oracles) {
        if (o.error || !o.oracle) continue;
        const k = o.oracle.toLowerCase();
        arbiterCountByOp[k] = (arbiterCountByOp[k] || 0) + 1;
      }
    } catch (err) {
      logger.warn('oracle-health: getAllOracles failed (arbiter counts omitted)', { network: this.networkKey, msg: err.message });
      arbiterCountByOp = null;
    }

    // ---- Gas tracking (step 2): fetch & persist receipts for new commit/reveal
    // txs. Receipts are immutable, so we only fetch tx hashes not already cached
    // (write-once store) — the first run backfills, later runs touch only new
    // txs. Throttled and capped so the backfill can't hang the request. Best
    // effort: any failure here leaves the success/reliability stats intact.
    const RECEIPT_CONCURRENCY = 5;  // simultaneous getTransactionReceipt calls
    const MAX_NEW_PER_SCAN = 750;   // bound the per-request backfill; rest spill to next scan
    let gasSummary = null;          // scan/backfill meta
    let gasByOp = {};               // operatorLower → { commit, reveal } stat summaries
    let gasDaily = [];              // network daily avg gas series (for the trend chart)
    let gasFinalization = null;     // round-completing reveal cost (the aggregation outlier)
    try {
      const store = GasReceiptStore.forNetwork(this.networkKey).load();
      const receiptProvider = this._getReceiptProvider();
      // Anchor block timestamp once; approximate per-tx timestamps from block
      // offset (~2s/block on Base) so we store an absolute time without a
      // getBlock per receipt. Good enough for daily bucketing in step 3.
      const head = await withRetry(() => provider.getBlock(latest));
      const anchorTs = head ? Number(head.timestamp) : Math.floor(Date.now() / 1000);

      // Unique, not-yet-cached tx hashes (a tx carries one commit OR one reveal).
      const seen = new Set();
      const toFetch = [];
      for (const e of commitRevealLogs) {
        const h = e.txHash.toLowerCase();
        if (seen.has(h)) continue;
        seen.add(h);
        if (store.has(h)) {
          // Already cached — but the round-completing flag may only be knowable
          // now (the fulfill log might land in a later-scanned chunk).
          if (e.kind === 'reveal' && fulfillTxHashes.has(h)) store.markCompletedRound(h);
          continue;
        }
        toFetch.push(e);
      }

      const batch = toFetch.slice(0, MAX_NEW_PER_SCAN);
      let gasFetched = 0, gasFailed = 0;
      await mapWithConcurrency(batch, RECEIPT_CONCURRENCY, async (e) => {
        try {
          const rcpt = await withRetry(() => receiptProvider.getTransactionReceipt(e.txHash));
          if (!rcpt || rcpt.gasUsed == null) { gasFailed++; return; }
          // ethers v6: the effective gas price paid is exposed as receipt.gasPrice.
          const effectiveGasPrice = rcpt.gasPrice ?? rcpt.effectiveGasPrice ?? 0n;
          const ts = anchorTs - (latest - e.blockNumber) * 2;
          store.set(e.txHash, {
            kind: e.kind,
            operator: e.operator,
            gasUsed: rcpt.gasUsed,
            effectiveGasPrice,
            blockNumber: e.blockNumber,
            timestamp: ts,
            completedRound: e.kind === 'reveal' && fulfillTxHashes.has(e.txHash.toLowerCase()),
          });
          gasFetched++;
        } catch (err) {
          gasFailed++;
        }
      });
      store.flush();

      const gasCapped = toFetch.length > batch.length;
      gasSummary = {
        storeSize: store.size,        // total receipts cached for this network
        candidates: toFetch.length,   // new (uncached) txs found this scan
        fetched: gasFetched,
        failed: gasFailed,
        capped: gasCapped,            // true if backfill spilled to a later scan
        partial: gasCapped || gasFailed > 0,
      };
      if (gasCapped || gasFailed > 0) {
        logger.info('oracle-health: gas backfill incomplete this scan', {
          network: this.networkKey, ...gasSummary,
        });
      }

      // ---- Aggregate the cached receipts within the display window. The store
      // accumulates across scans, so filter to the current window by timestamp.
      // The Reveal min/median/max EXCLUDES round-completing txs (their gas is
      // inflated by aggregation and would skew the distribution); finalizing
      // reveals get their own summary. AVERAGES (`revealAll` + the daily chart)
      // BLEND both, since finalizing reveals are a real recurring cost (~1/4 of
      // reveals) and the true per-reveal average must include them.
      const windowStartTs = anchorTs - days * 86400;
      const inWindow = store.all().filter((r) => r.timestamp >= windowStartTs);

      const byOp = {};
      for (const r of inWindow) {
        if (!r.operator) continue;
        if (!byOp[r.operator]) byOp[r.operator] = { commit: [], reveal: [], finalizing: [] };
        if (r.kind === 'commit') byOp[r.operator].commit.push(r);
        else if (r.kind === 'reveal' && r.completedRound) byOp[r.operator].finalizing.push(r);
        else if (r.kind === 'reveal') byOp[r.operator].reveal.push(r);
      }
      gasByOp = {};
      for (const [op, g] of Object.entries(byOp)) {
        gasByOp[op] = {
          commit: summarizeGas(g.commit),         // commit txs
          reveal: summarizeGas(g.reveal),         // normal reveals only (for the distribution column)
          finalizing: summarizeGas(g.finalizing), // reveals that also ran aggregation (one per completed round)
          revealAll: summarizeGas([...g.reveal, ...g.finalizing]), // all reveals — blended true per-reveal cost
        };
      }

      gasFinalization = summarizeGas(inWindow.filter((r) => r.kind === 'reveal' && r.completedRound));

      // Network-wide daily average gas. Commit = all commits; reveal = ALL
      // reveals incl. finalizing (true blended avg). Bucketed by day offset from
      // the anchor timestamp, oldest → newest to match `dailyTrend`.
      const buckets = Array.from({ length: days }, () => ({ cSum: 0, cN: 0, rSum: 0, rN: 0 }));
      for (const r of inWindow) {
        const idx = Math.floor((anchorTs - r.timestamp) / 86400);
        if (idx < 0 || idx >= days) continue;
        if (r.kind === 'commit') { buckets[idx].cSum += Number(r.gasUsed); buckets[idx].cN++; }
        else if (r.kind === 'reveal') { buckets[idx].rSum += Number(r.gasUsed); buckets[idx].rN++; }
      }
      gasDaily = buckets
        .map((b, i) => ({
          daysAgo: i,
          avgGasCommit: b.cN ? Math.round(b.cSum / b.cN) : null,
          avgGasReveal: b.rN ? Math.round(b.rSum / b.rN) : null,
          commits: b.cN,
          reveals: b.rN,
        }))
        .reverse();
    } catch (err) {
      logger.warn('oracle-health: gas receipt collection failed', { network: this.networkKey, msg: err.message });
      gasSummary = { error: err.message };
    }

    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
    const operators = Object.values(ops)
      .map((o) => ({
        operator: o.operator,
        arbiters: arbiterCountByOp ? (arbiterCountByOp[o.operator.toLowerCase()] || 0) : null,
        timesSelected: o.selected,
        commits: o.commits,
        commitRatePct: pct(o.commits, o.selected),
        reveals: o.reveals,
        revealRatePct: pct(o.reveals, o.commits), // reveals per commit — exposes commit-but-no-reveal
        blameworthy: (blameByOp[o.operator.toLowerCase()] || {}).count || 0, // failed-eval slots charged to this operator
        // Distinct failed aggIds this operator is responsible for (drill-down list).
        blameAggIds: blameByOp[o.operator.toLowerCase()]
          ? Object.entries(blameByOp[o.operator.toLowerCase()].evals).map(([aggId, d]) => ({ aggId, stage: d.stage, slots: d.slots }))
          : [],
        gas: gasByOp[o.operator.toLowerCase()] || null, // per-op gas stats (null until receipts cached)
      }))
      .sort((a, b) => b.timesSelected - a.timesSelected || b.commits - a.commits);

    // Daily trend, oldest → newest (today last). failed ≈ requests not fulfilled
    // that day (request→fulfill happens within minutes, so same-day).
    const dailyTrend = daily
      .map((d, i) => ({ daysAgo: i, fulfilled: d.fulfilled, failed: Math.max(0, d.requests - d.fulfilled) }))
      .reverse();

    return {
      network: this.networkKey,
      windowDays: days,
      fromBlock: Math.max(floor, 0),
      toBlock: latest,
      scannedChunks,
      partial,
      success: {
        requests,
        fulfilled,
        unfulfilled: Math.max(0, requests - fulfilled),
        successRatePct: pct(fulfilled, requests),
      },
      dailyTrend,
      operators,
      gas: {
        scan: gasSummary,            // receipt-collection/backfill meta
        daily: gasDaily,             // network daily avg gas (commit + reveal) for the trend chart
        finalization: gasFinalization, // round-completing reveal cost (aggregation outlier), network-wide
      },
      generatedAt: Date.now(),
    };
  }

  /**
   * Full blow-by-blow of a single aggregation (aggId), for the agg-history
   * drill-down: contract requirements (K/M/N), the named on-chain status, the
   * request event + CIDs, a per-slot commit/reveal/failure breakdown, the final
   * fulfillment (likelihoods + justification CID), and a derived outcome.
   * Mirrors example-bounty-program's getAggHistory so the same picture renders
   * here. Reads go through the read RPC; log scans use the archive provider and
   * are bounded to a window around the request (never a full-history scan).
   */
  async getAggHistory(aggId) {
    const provider = this.provider;
    const logProvider = this._getArchiveProvider();
    const aggr = new ethers.Contract(this.aggregatorAddress, AGG_HISTORY_ABI, provider);
    const iface = aggr.interface;
    const deployBlock = this.aggregatorFromBlock || 0;

    // Chunked log scan over the archive provider (bounded ranges → single chunk).
    const CHUNK = 90_000;
    const getLogsChunked = async (topics, fromBlock, toBlock) => {
      const out = [];
      if (toBlock < fromBlock) return out;
      for (let start = fromBlock; start <= toBlock; start += CHUNK) {
        const end = Math.min(start + CHUNK - 1, toBlock);
        const chunk = await withRetry(() => logProvider.getLogs({
          address: this.aggregatorAddress, topics, fromBlock: start, toBlock: end,
        }));
        out.push(...chunk);
      }
      return out;
    };

    const currentBlock = await withRetry(() => logProvider.getBlockNumber());

    // 1. Contract params: K = oracles polled, M = commits required, N = reveals required.
    const [K, M, N, maxLikLen] = await withRetry(() => Promise.all([
      aggr.commitOraclesToPoll(),
      aggr.oraclesToPoll(),
      aggr.requiredResponses(),
      aggr.maxLikelihoodLength(),
    ]));
    const contractParams = { K: Number(K), M: Number(M), N: Number(N), maxLikelihoodLength: Number(maxLikLen) };

    // 2. Named on-chain aggregation status.
    let aggStatus;
    try {
      const raw = await withRetry(() => aggr.getAggregationStatus(aggId));
      aggStatus = {
        commitPhaseComplete: raw.commitPhaseComplete,
        commitExpected: Number(raw.commitExpected),   // K
        commitCount: Number(raw.commitReceived),      // commits received
        responseCount: Number(raw.responseCount),     // reveals recorded
        requiredResponses: Number(raw.requiredN),     // N
        clusterSize: Number(raw.clusterP),            // P
        requester: raw.requester,
        startTimestamp: Number(raw.startTimestamp),   // unix secs
        isComplete: raw.isComplete,
        failed: raw.failed,
      };
    } catch (err) {
      logger.warn('agg-history: getAggregationStatus failed', { network: this.networkKey, aggId, msg: err.message });
      aggStatus = null;
    }

    // A clean read with startTimestamp 0 means the aggregator has no record of
    // this aggId — definitively not found; skip the (costly) log scan.
    if (aggStatus && !(aggStatus.startTimestamp > 0)) {
      return { found: false, aggId, network: this.networkKey, message: 'No aggregation found on-chain for this ID' };
    }

    // 3. Find the RequestAIEvaluation event, narrowing via startTimestamp when set.
    const aggIdTopic = aggId;
    const reqTopics = [iface.getEvent('RequestAIEvaluation').topicHash, aggIdTopic];
    let requestEvent = null;
    let searchFrom = deployBlock;
    let logs = [];
    if (aggStatus?.startTimestamp > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      const ageBlocks = Math.floor((nowSec - aggStatus.startTimestamp) / 2); // ~2s/block on Base
      const estReqBlock = Math.max(deployBlock, currentBlock - ageBlocks);
      searchFrom = Math.max(deployBlock, estReqBlock - AGGH_REQ_SEARCH_MARGIN);
      const searchTo = Math.min(currentBlock, estReqBlock + AGGH_REQ_SEARCH_MARGIN);
      logs = await getLogsChunked(reqTopics, searchFrom, searchTo);
    }
    if (logs.length === 0) {
      // Fallback: bounded recent look-back (never unbounded full history).
      searchFrom = Math.max(deployBlock, currentBlock - AGGH_RECENT_FALLBACK_BLOCKS);
      logs = await getLogsChunked(reqTopics, searchFrom, currentBlock);
    }
    if (logs.length > 0) {
      const parsed = iface.parseLog(logs[0]);
      requestEvent = { block: logs[0].blockNumber, txHash: logs[0].transactionHash, cids: parsed.args.cids };
    }
    if (!requestEvent && !aggStatus) {
      return { found: false, aggId, network: this.networkKey, message: 'No matching aggregation found on-chain' };
    }

    const eventFromBlock = requestEvent ? requestEvent.block : searchFrom;
    const eventToBlock = Math.min(currentBlock, eventFromBlock + AGGH_EVENT_WINDOW);

    // 4. OracleSelected → the per-slot roster.
    const oracleLogs = await getLogsChunked([iface.getEvent('OracleSelected').topicHash, aggIdTopic], eventFromBlock, eventToBlock);
    const slotMap = {};
    for (const log of oracleLogs) {
      const parsed = iface.parseLog(log);
      const slot = Number(parsed.args.pollIndex);
      slotMap[slot] = {
        slot, oracle: parsed.args.oracle, jobId: parsed.args.jobId,
        committed: false, revealRequested: false, revealOK: false,
        hashMismatch: false, invalidFormat: false, tooManyScores: false,
        wrongScoreCount: false, tooFewScores: false, scores: null,
      };
    }

    // 5. Commit / reveal-request / failure events (indexed by aggRequestId).
    const eventNames = [
      'CommitReceived', 'RevealRequestDispatched',
      'RevealHashMismatch', 'InvalidRevealFormat',
      'RevealTooManyScores', 'RevealWrongScoreCount', 'RevealTooFewScores',
    ];
    // Sequential, NOT Promise.all: concurrent getLogs get batched into one
    // JSON-RPC call by ethers, and the Tenderly archive gateway hangs on batched
    // eth_getLogs. Each scan is a sub-second single-chunk query, so serial is fine.
    const lifecycleLogs = [];
    for (const name of eventNames) {
      lifecycleLogs.push(await getLogsChunked([iface.getEvent(name).topicHash, aggIdTopic], eventFromBlock, eventToBlock));
    }
    for (let i = 0; i < eventNames.length; i++) {
      for (const log of lifecycleLogs[i]) {
        const parsed = iface.parseLog(log);
        const slot = Number(parsed.args.pollIndex);
        if (!slotMap[slot]) continue;
        switch (eventNames[i]) {
          case 'CommitReceived': slotMap[slot].committed = true; break;
          case 'RevealRequestDispatched': slotMap[slot].revealRequested = true; break;
          case 'RevealHashMismatch': slotMap[slot].hashMismatch = true; break;
          case 'InvalidRevealFormat': slotMap[slot].invalidFormat = true; break;
          case 'RevealTooManyScores': slotMap[slot].tooManyScores = true; break;
          case 'RevealWrongScoreCount': slotMap[slot].wrongScoreCount = true; break;
          case 'RevealTooFewScores': slotMap[slot].tooFewScores = true; break;
        }
      }
    }

    // 6. Successful reveals.
    const responseLogs = await getLogsChunked([iface.getEvent('NewOracleResponseRecorded').topicHash, aggIdTopic], eventFromBlock, eventToBlock);
    for (const log of responseLogs) {
      const parsed = iface.parseLog(log);
      const slot = Number(parsed.args.pollIndex);
      if (slotMap[slot]) slotMap[slot].revealOK = true;
    }

    // 7. Fulfillment (final scores + justification CID).
    const fulfillLogs = await getLogsChunked([iface.getEvent('FulfillAIEvaluation').topicHash, aggIdTopic], eventFromBlock, eventToBlock);
    let fulfillment = null;
    if (fulfillLogs.length > 0) {
      const parsed = iface.parseLog(fulfillLogs[0]);
      fulfillment = {
        likelihoods: parsed.args.likelihoods.map((s) => Number(s)),
        justificationCID: parsed.args.justificationCID,
        block: fulfillLogs[0].blockNumber,
        txHash: fulfillLogs[0].transactionHash,
      };
    }

    // 8. Build slots + analysis + derived outcome.
    const slots = Object.values(slotMap).sort((a, b) => a.slot - b.slot);
    const committedSlots = slots.filter((s) => s.committed);
    const revealedSlots = slots.filter((s) => s.revealOK);
    const nonRespondingSlots = slots.filter((s) => !s.committed);
    const uniqueOracles = new Set(slots.map((s) => s.oracle)).size;

    const requestBlock = requestEvent?.block || null;
    let elapsedMinutes = null;
    if (requestBlock) elapsedMinutes = Math.round((currentBlock - requestBlock) * 2 / 60);
    else if (aggStatus?.startTimestamp > 0) elapsedMinutes = Math.round((Math.floor(Date.now() / 1000) - aggStatus.startTimestamp) / 60);
    const IN_PROCESS_WINDOW_MINUTES = 10;
    const isEarly = elapsedMinutes !== null && elapsedMinutes < IN_PROCESS_WINDOW_MINUTES;

    // Outcome from events + elapsed time (the aggregator leaves `failed` unset on
    // timeouts). Phase of death: commit (< M commits) or reveal (< N reveals).
    const failPhase = committedSlots.length < contractParams.M ? 'commit'
      : (revealedSlots.length < contractParams.N ? 'reveal' : 'aggregation');
    let outcome;
    if (fulfillment) outcome = 'COMPLETED';
    else if (isEarly) outcome = `IN PROCESS (${failPhase} phase, ${elapsedMinutes}m elapsed)`;
    else if (elapsedMinutes === null) outcome = 'RUNNING';
    else outcome = `FAILED (${failPhase} phase)`;

    const analysis = {
      totalSlots: slots.length,
      committed: committedSlots.length,
      revealed: revealedSlots.length,
      nonResponding: nonRespondingSlots.length,
      nonRespondingSlotIds: nonRespondingSlots.map((s) => s.slot),
      uniqueOracles,
      failures: {
        hashMismatch: slots.filter((s) => s.hashMismatch).length,
        invalidFormat: slots.filter((s) => s.invalidFormat).length,
        tooManyScores: slots.filter((s) => s.tooManyScores).length,
        wrongScoreCount: slots.filter((s) => s.wrongScoreCount).length,
        tooFewScores: slots.filter((s) => s.tooFewScores).length,
      },
    };

    return {
      found: true,
      aggId,
      network: this.networkKey,
      contractParams,
      aggregationStatus: aggStatus,
      requestEvent,
      slots,
      fulfillment,
      outcome,
      analysis,
    };
  }

  /**
   * Arbiters grouped by owner address (the ArbiterOperator owner), with totals
   * for the analytics "Arbiters by Owner" table: arbiter/operator counts,
   * average reputation, claimable ETH (ethOwed on the aggregator, per owner) and
   * node funding.
   * Sorted by owner address, numerically ascending.
   */
  async getOwnersAnalytics() {
    const [oracles, thresholds] = await Promise.all([
      this.getAllOracles(),
      this.getThresholds()
    ]);
    const valid = oracles.filter((o) => !o.error && o.oracle);
    const operatorAddrs = [...new Set(valid.map((o) => o.oracle))];

    const [ownerMap, fundingData] = await Promise.all([
      this.getOwnerMap(operatorAddrs),
      this._computeFunding(operatorAddrs)
    ]);
    const { perOp: fundingPerOp, gasPrice } = fundingData;
    const now = Math.floor(Date.now() / 1000);

    // Roll arbiters up by owner, tallying status the same way the availability
    // table does so the by-owner table can show Active/New/Unresponsive/Blocked.
    const byOwner = {};
    for (const o of valid) {
      const opLower = o.oracle.toLowerCase();
      const owner = ownerMap[opLower] || null;
      const key = owner ? owner.toLowerCase() : 'unknown';
      if (!byOwner[key]) {
        byOwner[key] = {
          owner, operators: new Set(), arbiters: 0, qSum: 0, tSum: 0,
          active: 0, new: 0, unresponsive: 0, blocked: 0, inactive: 0
        };
      }
      const b = byOwner[key];
      b.operators.add(opLower);
      b.arbiters += 1;
      b.qSum += o.qualityScore;
      b.tSum += o.timelinessScore;
      b[this._statusFor(o, thresholds, now)] += 1;
    }

    // Per-owner claimable ETH (ethOwed on the aggregator), read once per distinct owner.
    // The unknown-owner bucket has no address and gets null.
    const ownerAddrs = Object.values(byOwner).map((b) => b.owner).filter(Boolean);
    const ethOwedMap = await this.getEthOwedMap(ownerAddrs);

    const owners = Object.values(byOwner).map((b) => {
      let nodeWei = 0n;
      for (const op of b.operators) {
        nodeWei += fundingPerOp[op]?.totalWei ?? 0n;
      }
      const owedWei = b.owner ? ethOwedMap[b.owner.toLowerCase()] : null;
      const estQueries = this._estQueries(nodeWei, gasPrice);
      return {
        owner: b.owner,
        operators: b.operators.size,
        arbiters: b.arbiters,
        active: b.active,
        new: b.new,
        unresponsive: b.unresponsive,
        blocked: b.blocked,
        inactive: b.inactive,
        avgQualityScore: Math.round(b.qSum / b.arbiters),
        avgTimelinessScore: Math.round(b.tSum / b.arbiters),
        claimableEth: owedWei != null ? ethers.formatEther(owedWei) : null,
        nodeEth: ethers.formatEther(nodeWei),
        estQueries,
        fundingLow: this._fundingLow(nodeWei, estQueries)
      };
    });

    // Numeric ascending by address (lowercase fixed-width hex == numeric order);
    // unknown-owner bucket sorts last.
    owners.sort((a, b) => {
      if (!a.owner) return 1;
      if (!b.owner) return -1;
      const x = a.owner.toLowerCase();
      const y = b.owner.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });

    return {
      owners,
      funding: {
        gasPriceGwei: gasPrice != null ? ethers.formatUnits(gasPrice, 'gwei') : null,
        gasPerQuery: funding.gasPerQuery,
        lowQueriesThreshold: funding.lowQueriesThreshold,
        lowEthThreshold: funding.lowEthThreshold
      },
      timestamp: Date.now()
    };
  }

  /**
   * Check if the service is properly configured
   */
  async healthCheck() {
    try {
      const keeperAddress = await withRetry(() => this.aggregator.reputationKeeper());
      const config = await this.getAggregatorConfig();

      // Chainlink transport-token address from getContractConfig (legacy view). This is
      // the 0-juel request rail's token, NOT a payment token — arbiters are paid in ETH.
      let linkTokenAddress = null;
      try {
        const contractConfig = await withRetry(() => this.aggregator.getContractConfig());
        linkTokenAddress = contractConfig.linkAddr || contractConfig[1];
      } catch (err) {
        // May fail if getContractConfig is removed in future versions
        logger.debug('Could not get transport-token address', { msg: err.message });
      }

      // Get wVDKA token address from ReputationKeeper
      let wvdkaAddress = null;
      try {
        const keeper = await this.getReputationKeeper();
        wvdkaAddress = await withRetry(() => keeper.verdiktaToken());
      } catch (err) {
        logger.debug('Could not get wVDKA token address', { msg: err.message });
      }

      return {
        healthy: true,
        aggregatorAddress: this.aggregatorAddress,
        keeperAddress,
        linkTokenAddress,
        wvdkaAddress,
        config
      };
    } catch (error) {
      return {
        healthy: false,
        aggregatorAddress: this.aggregatorAddress,
        error: error.message
      };
    }
  }

  /**
   * ReputationKeeper scoring thresholds. An oracle's quality/timeliness score
   * dropping below these triggers mild (warning) or severe (block) treatment.
   */
  async getKeeperThresholds() {
    const keeper = await this.getReputationKeeper();
    const [mild, severe] = await Promise.all([
      withRetry(() => keeper.mildThreshold()),
      withRetry(() => keeper.severeThreshold())
    ]);
    return { mildThreshold: Number(mild), severeThreshold: Number(severe) };
  }

  /**
   * Legacy getContractConfig() view. Under the ETH aggregator this returns the Chainlink
   * transport token (0-juel rail) and zero placeholders for jobId/fee — there is no single
   * per-oracle LINK fee anymore (each arbiter's fee lives in the keeper, and maxOracleFee
   * is the ETH ceiling). `fee` is therefore a 0 placeholder; the Contracts page shows the
   * live ETH ceiling from getAggregatorConfig().maxOracleFee instead.
   */
  async getPaymentConfig() {
    const cfg = await withRetry(() => this.aggregator.getContractConfig());
    return {
      transportTokenAddress: cfg.linkAddr || cfg[1],
      jobId: cfg.jobId || cfg[2],
      fee: ethers.formatEther(cfg.fee ?? cfg[3]) // legacy placeholder (0 on ETH contract)
    };
  }

  /**
   * ERC-20 metadata for a token (e.g. wVDKA). Each field is fetched
   * independently so a token missing one optional getter still returns the
   * rest. totalSupply is formatted using the token's own decimals.
   */
  async getTokenInfo(tokenAddress) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      withRetry(() => token.name()).catch(() => null),
      withRetry(() => token.symbol()).catch(() => null),
      withRetry(() => token.decimals()).catch(() => null),
      withRetry(() => token.totalSupply()).catch(() => null)
    ]);
    const dec = decimals != null ? Number(decimals) : 18;
    return {
      address: tokenAddress,
      name,
      symbol,
      decimals: decimals != null ? dec : null,
      totalSupply: totalSupply != null ? ethers.formatUnits(totalSupply, dec) : null
    };
  }
}

// One cached service instance per canonical network key.
const instances = new Map();

/**
 * Get (or lazily create) the VerdiktaService for a network. Accepts any caller
 * form (e.g. 'base_sepolia'); unknown values fall back to the default network.
 * @param {string} [networkKey]
 * @returns {VerdiktaService}
 */
function getVerdiktaService(networkKey) {
  const key = normalizeNetwork(networkKey);
  if (!instances.has(key)) {
    const net = networks[key];
    const service = new VerdiktaService(getRpcUrl(key), net.verdiktaAggregatorAddress, {
      networkKey: key,
      aggregatorFromBlock: net.aggregatorFromBlock || 0,
      archiveRpcUrl: getArchiveRpcUrl(key),
      receiptRpcUrl: getReceiptRpcUrl(key)
    });
    instances.set(key, service);
    logger.info('Verdikta service initialized', { network: key, aggregatorAddress: net.verdiktaAggregatorAddress });
  }
  return instances.get(key);
}

module.exports = {
  getVerdiktaService,
  VerdiktaService
};
