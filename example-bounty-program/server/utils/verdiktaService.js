/**
 * Verdikta Service
 * Interacts with ReputationAggregator and ReputationKeeper contracts
 * for analytics data about arbiters/oracles
 */

const { ethers } = require('ethers');
const logger = require('./logger');

// Event-scan tuning. Public RPCs (e.g. mainnet.base.org) reject eth_getLogs over
// a >10,000-block range, so every scan is chunked and bounded to a window around
// the aggregation instead of running to the chain head.
const MAX_LOG_RANGE = 9000;          // < 10k RPC cap, per getLogs chunk
const REQ_SEARCH_MARGIN = 7500;      // ± window (blocks) around the estimated request block
const EVENT_WINDOW = 8000;           // blocks after the request to collect lifecycle events (one getLogs chunk; an agg's full commit→reveal→fulfill/timeout lifecycle is well under this)
const RECENT_FALLBACK_BLOCKS = 250000; // bounded look-back when the timestamp anchor is unavailable

// Outcome label for a settled round with zero commits from any polled slot.
// Mirrors example-arbiters' getAggHistory/getOracleHealth rule (same repo, a
// separate npm package with no shared module to import from): a request that
// no arbiter ever committed to is most likely a malformed evaluation package,
// not a node failure. Exported so callers (e.g. the /diagnose route) can
// detect this outcome without re-deriving or hardcoding the label string.
const LIKELY_MALFORMED_OUTCOME = 'LIKELY MALFORMED EVALUATION PACKAGE (no arbiter committed)';

// ReputationAggregator ABI (functions needed for analytics + agg history)
const AGGREGATOR_ABI = [
  "function reputationKeeper() view returns (address)",
  "function commitOraclesToPoll() view returns (uint256)",
  "function oraclesToPoll() view returns (uint256)",
  "function requiredResponses() view returns (uint256)",
  "function clusterSize() view returns (uint256)",
  "function bonusMultiplier() view returns (uint256)",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function maxOracleFee() view returns (uint256)",
  // Agg history view functions
  "function maxLikelihoodLength() view returns (uint256)",
  // NOTE: Solidity's auto-getter for this struct omits its mappings and dynamic
  // arrays, returning the remaining members (incl. one embedded string) in
  // declaration order. The first six fields below are CONFIRMED by triangulating
  // the raw getter return against on-chain commit/reveal events for known
  // aggregations; the trailing flags (isComplete/failed) are decoded for
  // completeness but are NOT relied upon (the aggregator leaves `failed` unset and
  // times out silently — outcome is derived from events + elapsed time instead).
  // The ETH-funded ReputationAggregator exposes a dedicated, named status view
  // (the old contract's auto-getter `aggregatedEvaluations(bytes32)` does NOT
  // exist on the new contract — calling it reverts with "missing revert data").
  "function getAggregationStatus(bytes32 aggId) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)",
  "function requestIdToAggregatorId(bytes32) view returns (bytes32)",
  // Agg history events — signatures must match the actual contract exactly
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

// ReputationKeeper ABI (functions needed for oracle data)
// Note: registeredOracles auto-getter doesn't return classes array - must use getOracleClasses separately
const KEEPER_ABI = [
  "function getRegisteredOraclesCount() view returns (uint256)",
  "function registeredOracles(uint256 index) view returns (address oracle, bytes32 jobId)",
  "function getOracleInfo(address _oracle, bytes32 _jobId) view returns (bool isActive, int256 qualityScore, int256 timelinessScore, uint256 callCount, bytes32 jobId, uint256 fee, uint256 stakeAmount, uint256 lockedUntil, bool blocked)",
  "function getOracleClasses(uint256 index) view returns (uint64[])",
  "function getRecentScores(address _oracle, bytes32 _jobId) view returns (tuple(int256 qualityScore, int256 timelinessScore)[])",
  "function mildThreshold() view returns (int256)",
  "function severeThreshold() view returns (int256)",
  "function verdiktaToken() view returns (address)"
];

// ArbiterOperator (Chainlink Operator) ABI — one operator contract serves one
// owner and may back several jobIds. Same pattern as the arbiters app: ownership
// is the operator's own `owner()` (ConfirmedOwner).
const OPERATOR_ABI = [
  "function owner() view returns (address)"
];

// Aggregator jury-size protocol params (K oracles polled per round). Used only to
// phrase the "fewer than K eligible arbiters" warning when the on-chain read of
// commitOraclesToPoll fails.
const DEFAULT_ORACLES_TO_POLL = 6;

class VerdiktaService {
  constructor(providerUrl, aggregatorAddress, aggregatorDeployBlock = 0) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.aggregatorAddress = aggregatorAddress;
    // Lower bound for event scans — never scan below the aggregator's deploy block.
    this.aggregatorDeployBlock = Number(aggregatorDeployBlock) || 0;
    this.aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, this.provider);
    this.reputationKeeper = null;
    this.keeperAddress = null;
    // Registry walk (all oracles + info) and operator owner() reads are the
    // expensive part of the oracle-check; memoize them per instance.
    this._oraclesCache = null;          // { data, ts }
    this._ownerMap = {};                // { operatorLower: { owner, ts } }
  }

  // Retry a read against transient RPC errors (the public/load-balanced Base
  // endpoints intermittently return "missing revert data" / "could not coalesce
  // error" on otherwise-valid calls). Short linear backoff; re-throws the last
  // error if all attempts fail.
  async _withRetry(fn, label, tries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        logger.warn('[verdikta] RPC read failed, retrying', {
          label, attempt, tries, msg: (err.shortMessage || err.message || '').slice(0, 80)
        });
        if (attempt < tries) await new Promise(r => setTimeout(r, 300 * attempt));
      }
    }
    throw lastErr;
  }

  // Public RPCs cap eth_getLogs at a 10,000-block range. Split a scan into
  // windows under that cap and concatenate (ascending block order preserved).
  // Each chunk is retried independently so one transient failure doesn't abort
  // the whole scan.
  async _getLogsChunked(topics, fromBlock, toBlock, chunkSize = MAX_LOG_RANGE) {
    const out = [];
    if (toBlock < fromBlock) return out;
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, toBlock);
      const chunk = await this._withRetry(
        () => this.provider.getLogs({
          address: this.aggregatorAddress,
          topics,
          fromBlock: start,
          toBlock: end,
        }),
        `getLogs[${start}-${end}]`
      );
      out.push(...chunk);
    }
    return out;
  }

  // Resolve unix timestamps (seconds) for a set of block numbers. Duplicates and
  // null/undefined entries are ignored; a block whose header can't be fetched is
  // left out of the result (callers treat a missing entry as "unknown").
  async _getBlockTimestamps(blockNumbers) {
    const unique = [...new Set(blockNumbers.filter(b => Number.isInteger(b)))];
    const out = {};
    await Promise.all(unique.map(async (bn) => {
      try {
        const blk = await this._withRetry(() => this.provider.getBlock(bn), `getBlock[${bn}]`);
        if (blk && blk.timestamp != null) out[bn] = Number(blk.timestamp);
      } catch (err) {
        logger.warn('Failed to fetch block timestamp', { block: bn, msg: err.message });
      }
    }));
    return out;
  }

  /**
   * Get ReputationKeeper contract instance (lazy-loaded)
   */
  async getReputationKeeper() {
    if (!this.reputationKeeper) {
      try {
        this.keeperAddress = await this.aggregator.reputationKeeper();
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
        this.aggregator.commitOraclesToPoll(),
        this.aggregator.oraclesToPoll(),
        this.aggregator.requiredResponses(),
        this.aggregator.clusterSize(),
        this.aggregator.bonusMultiplier(),
        this.aggregator.responseTimeoutSeconds(),
        this.aggregator.maxOracleFee()
      ]);

      return {
        commitOraclesToPoll: Number(commitOraclesToPoll),
        oraclesToPoll: Number(oraclesToPoll),
        requiredResponses: Number(requiredResponses),
        clusterSize: Number(clusterSize),
        bonusMultiplier: Number(bonusMultiplier),
        responseTimeoutSeconds: Number(responseTimeoutSeconds),
        maxOracleFee: ethers.formatEther(maxOracleFee)
      };
    } catch (error) {
      logger.error('Failed to get aggregator config', { msg: error.message });
      throw error;
    }
  }

  /**
   * Get total registered oracle count
   */
  async getOracleCount() {
    try {
      const keeper = await this.getReputationKeeper();
      const count = await keeper.getRegisteredOraclesCount();
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
    try {
      const keeper = await this.getReputationKeeper();
      // Get oracle address and jobId (auto-getter doesn't return classes array)
      const [oracle, jobId] = await keeper.registeredOracles(index);
      // Get classes separately
      const classes = await keeper.getOracleClasses(index);
      return {
        oracle,
        jobId,
        classes: classes.map(c => Number(c))
      };
    } catch (error) {
      logger.error('Failed to get oracle at index', { index, msg: error.message });
      throw error;
    }
  }

  /**
   * Get detailed oracle info
   */
  async getOracleInfo(oracleAddress, jobId) {
    try {
      const keeper = await this.getReputationKeeper();
      const info = await keeper.getOracleInfo(oracleAddress, jobId);

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
      const scores = await keeper.getRecentScores(oracleAddress, jobId);
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
        keeper.mildThreshold(),
        keeper.severeThreshold()
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
   * Walk the ReputationKeeper registry once: identity (address, jobId, classes)
   * + getOracleInfo for every index. Memoized for `maxAgeMs` so repeated
   * oracle-checks don't re-walk the registry. A single unreadable index yields
   * an error sentinel rather than failing the whole dataset.
   */
  async getAllOracles({ maxAgeMs = 60000 } = {}) {
    if (this._oraclesCache && Date.now() - this._oraclesCache.ts < maxAgeMs) {
      return this._oraclesCache.data;
    }
    const count = await this.getOracleCount();
    const oracles = [];
    const batchSize = 4;
    for (let i = 0; i < count; i += batchSize) {
      const batchEnd = Math.min(i + batchSize, count);
      const batch = [];
      for (let j = i; j < batchEnd; j++) {
        const index = j;
        batch.push(
          this.getOracleAtIndex(index)
            .then(o => this.getOracleInfo(o.oracle, o.jobId).then(info => ({ index, ...o, ...info })))
            .catch(err => {
              logger.warn('[verdikta] Failed to read oracle, skipping', { index, msg: err.message });
              return { index, error: err.message };
            })
        );
      }
      oracles.push(...(await Promise.all(batch)));
    }
    this._oraclesCache = { data: oracles, ts: Date.now() };
    return oracles;
  }

  /**
   * operator (lowercased) -> owner address (or null if unreadable). owner() is
   * effectively static, so results are cached per instance.
   */
  async getOwnerMap(operatorAddrs, { maxAgeMs = 600000 } = {}) {
    const now = Date.now();
    const unique = [...new Set(operatorAddrs.map(a => String(a).toLowerCase()))];
    const stale = unique.filter(a => {
      const e = this._ownerMap[a];
      return !e || now - e.ts >= maxAgeMs;
    });
    const batchSize = 6;
    for (let i = 0; i < stale.length; i += batchSize) {
      const slice = stale.slice(i, i + batchSize);
      await Promise.all(slice.map(async (addr) => {
        const op = new ethers.Contract(addr, OPERATOR_ABI, this.provider);
        const owner = await this._withRetry(() => op.owner(), `owner(${addr.slice(0, 10)})`).catch(() => null);
        this._ownerMap[addr] = { owner: owner ? String(owner) : null, ts: now };
      }));
    }
    const map = {};
    for (const a of unique) map[a] = this._ownerMap[a]?.owner ?? null;
    return map;
  }

  /**
   * Oracle-check for a bounty: how many registered arbiters in `classId` could
   * actually be selected under the bounty's creator-chosen oracle settings.
   *
   * An arbiter is "eligible" when it is registered for the class, active, not
   * currently blocked, and its per-call fee is <= the bounty's maxOracleFee (the
   * keeper drops arbiters priced above the fee ceiling from selection).
   *
   * @param {number} classId
   * @param {{maxOracleFee:string|bigint, alpha:number, estimatedBaseCost:string|bigint, maxFeeBasedScaling:number}} oracleSettings (wei strings)
   * @returns {Promise<object>} see route GET /api/jobs/:id/oracle-check
   */
  async getClassOracleEligibility(classId, oracleSettings) {
    const cls = Number(classId);
    const maxFeeWei = BigInt(String(oracleSettings?.maxOracleFee ?? '0'));
    const alpha = Number(oracleSettings?.alpha ?? 0);
    const baseCostWei = BigInt(String(oracleSettings?.estimatedBaseCost ?? '0'));
    const scaling = Number(oracleSettings?.maxFeeBasedScaling ?? 1);

    const [oracles, thresholds] = await Promise.all([
      this.getAllOracles(),
      this.getThresholds()
    ]);
    let oraclesToPoll = DEFAULT_ORACLES_TO_POLL;
    try {
      oraclesToPoll = Number(await this._withRetry(() => this.aggregator.commitOraclesToPoll(), 'commitOraclesToPoll')) || DEFAULT_ORACLES_TO_POLL;
    } catch (_) { /* keep default */ }

    const now = Math.floor(Date.now() / 1000);
    const inClass = oracles.filter(o => !o.error && Array.isArray(o.classes) && o.classes.includes(cls));

    const feeWei = (o) => {
      try { return ethers.parseEther(String(o.fee)); } catch { return null; }
    };
    const isBlocked = (o) => o.blocked && Number(o.lockedUntil) > now;

    const activeInClass = inClass.filter(o => o.isActive && !isBlocked(o));
    const eligible = activeInClass.filter(o => {
      const f = feeWei(o);
      return f != null && f <= maxFeeWei;
    });
    const pricedOut = activeInClass.length - eligible.length;

    // Owner concentration among the eligible pool.
    const ownerMap = await this.getOwnerMap(eligible.map(o => o.oracle));
    const ownerCounts = {};
    for (const o of eligible) {
      const owner = ownerMap[String(o.oracle).toLowerCase()] || `unknown:${String(o.oracle).toLowerCase()}`;
      ownerCounts[owner] = (ownerCounts[owner] || 0) + 1;
    }
    const distinctOwnersEligible = Object.keys(ownerCounts).length;
    let dominantOwner = null;
    let dominantOwnerCount = 0;
    for (const [owner, n] of Object.entries(ownerCounts)) {
      if (n > dominantOwnerCount) { dominantOwner = owner; dominantOwnerCount = n; }
    }

    const priceBoostEnabled = baseCostWei > 0n || scaling > 1;
    const alphaExtreme = alpha <= 100 || alpha >= 900;

    const warnings = [];
    if (inClass.length === 0) {
      warnings.push(`No arbiters are registered for class ${cls}. Evaluations for this bounty cannot be served until at least ${oraclesToPoll} join the class.`);
    } else if (eligible.length === 0) {
      warnings.push(`None of the ${inClass.length} arbiter(s) registered for class ${cls} is both active and priced at or below this bounty's max oracle fee (${ethers.formatEther(maxFeeWei)} ETH). Evaluations would stall — raise the fee or pick another class.`);
    } else if (eligible.length < oraclesToPoll) {
      warnings.push(`Only ${eligible.length} eligible arbiter(s) in class ${cls} (the aggregator polls ${oraclesToPoll} per round). Evaluations may time out or be served by the same few nodes.`);
    }
    if (pricedOut > 0) {
      warnings.push(`${pricedOut} active arbiter(s) in class ${cls} charge more than this bounty's max oracle fee (${ethers.formatEther(maxFeeWei)} ETH) and will not be selected.`);
    }
    if (eligible.length > 0 && dominantOwnerCount * 2 >= eligible.length) {
      const label = dominantOwner && !dominantOwner.startsWith('unknown:')
        ? `${dominantOwner.slice(0, 6)}…${dominantOwner.slice(-4)}`
        : 'one operator';
      warnings.push(`${label} controls ${dominantOwnerCount} of the ${eligible.length} eligible arbiter(s) — at least half the pool. A single party could dominate the jury.`);
    }
    if (priceBoostEnabled) {
      warnings.push(`Price boost is enabled (estimatedBaseCost ${ethers.formatEther(baseCostWei)} ETH, up to ${scaling}x). Cheaper arbiters are favoured in selection, which trades reputation for cost.`);
    }
    if (alphaExtreme) {
      warnings.push(alpha <= 100
        ? `alpha is ${alpha}: selection is weighted almost entirely on quality score, ignoring timeliness. Slow-but-accurate arbiters may be chosen and rounds can take longer.`
        : `alpha is ${alpha}: selection is weighted almost entirely on timeliness, ignoring quality score. Fast-but-inaccurate arbiters may be chosen.`);
    }

    return {
      available: true,
      classId: cls,
      oracleSettings: {
        maxOracleFee: maxFeeWei.toString(),
        maxOracleFeeEth: ethers.formatEther(maxFeeWei),
        alpha,
        estimatedBaseCost: baseCostWei.toString(),
        maxFeeBasedScaling: scaling
      },
      totalInClass: inClass.length,
      activeInClass: activeInClass.length,
      eligibleCount: eligible.length,
      pricedOutCount: pricedOut,
      distinctOwnersEligible,
      dominantOwner: dominantOwner && !dominantOwner.startsWith('unknown:') ? dominantOwner : null,
      dominantOwnerCount,
      oraclesToPoll,
      priceBoostEnabled,
      alphaExtreme,
      thresholds,
      eligibleArbiters: eligible.map(o => ({
        oracle: o.oracle,
        owner: ownerMap[String(o.oracle).toLowerCase()] || null,
        fee: o.fee,
        qualityScore: o.qualityScore,
        timelinessScore: o.timelinessScore,
        callCount: o.callCount
      })),
      warnings,
      checkedAt: new Date().toISOString()
    };
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
   * Get all oracles with their info (batched for efficiency)
   */
  async getAllOracles() {
    try {
      const count = await this.getOracleCount();
      logger.info('Fetching all oracles', { count });

      const oracles = [];

      // Fetch in batches to avoid overwhelming the RPC
      const batchSize = 10;
      for (let i = 0; i < count; i += batchSize) {
        const batchEnd = Math.min(i + batchSize, count);
        const batchPromises = [];

        for (let j = i; j < batchEnd; j++) {
          batchPromises.push(this.getOracleAtIndex(j));
        }

        const batchResults = await Promise.all(batchPromises);

        // Get detailed info and recent scores for each oracle
        const infoPromises = batchResults.map(o =>
          Promise.all([
            this.getOracleInfo(o.oracle, o.jobId),
            this.getRecentScores(o.oracle, o.jobId)
          ])
            .then(([info, recentScores]) => ({ ...o, ...info, recentScores }))
            .catch(err => {
              logger.warn('Failed to get oracle info', { oracle: o.oracle, msg: err.message });
              return { ...o, error: err.message };
            })
        );

        const oraclesWithInfo = await Promise.all(infoPromises);
        oracles.push(...oraclesWithInfo);
      }

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

        // Debug logging for 5050 class
        if (oracle.classes.includes(5050)) {
          logger.info('5050 class oracle analysis', {
            oracle: oracle.oracle.slice(0, 10) + '...',
            isActive: oracle.isActive,
            isBlocked,
            timelinessScore: oracle.timelinessScore,
            recentScoresCount: oracle.recentScores?.length || 0,
            recentScores: oracle.recentScores?.slice(-5).map(s => s.timelinessScore),
            responsiveness,
            status
          });
        }

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
   * Get full aggregation history for an aggId by querying contract events
   */
  async getAggHistory(aggId) {
    const currentBlock = await this.provider.getBlockNumber();

    // 1. Fetch contract params
    // K = oracles polled, M = commits required, N = reveals required
    const [K, M, N, maxLikLen] = await this._withRetry(() => Promise.all([
      this.aggregator.commitOraclesToPoll(),
      this.aggregator.oraclesToPoll(),
      this.aggregator.requiredResponses(),
      this.aggregator.maxLikelihoodLength()
    ]), 'contract-params');
    const contractParams = {
      K: Number(K),
      M: Number(M),
      N: Number(N),
      maxLikelihoodLength: Number(maxLikLen)
    };

    // 2. Fetch aggregation status (named view on the ETH aggregator)
    let aggStatus;
    try {
      const raw = await this._withRetry(() => this.aggregator.getAggregationStatus(aggId), 'getAggregationStatus');
      aggStatus = {
        commitPhaseComplete: raw.commitPhaseComplete,
        commitExpected: Number(raw.commitExpected),    // K
        commitCount: Number(raw.commitReceived),       // commits received
        responseCount: Number(raw.responseCount),      // reveals recorded
        requiredResponses: Number(raw.requiredN),      // N
        clusterSize: Number(raw.clusterP),             // P
        requester: raw.requester,
        startTimestamp: Number(raw.startTimestamp),    // unix secs
        isComplete: raw.isComplete,                    // aggregator-finished flag (bool)
        failed: raw.failed                             // bool; outcome still derived from events
      };
    } catch (err) {
      logger.warn('Failed to fetch getAggregationStatus', { aggId, msg: err.message });
      aggStatus = null;
    }

    // A successful read with startTimestamp 0 means the aggregator has no record
    // of this aggId — definitively not found. Return now instead of falling
    // through to an expensive (and potentially RPC-rate-limited) log scan.
    if (aggStatus && !(aggStatus.startTimestamp > 0)) {
      return { found: false, aggId, message: 'No aggregation found on-chain for this ID' };
    }

    // 3. Find RequestAIEvaluation event.
    // The struct stores startTimestamp (unix secs), not a block number. When it's
    // set, narrow the search to a window around the implied block (~2s/block on
    // Base, with a generous safety margin). Otherwise fall back to a full-history
    // search — the query is topic-filtered by the indexed aggId, so it stays cheap
    // on an indexing RPC even over a wide range.
    const aggIdTopic = aggId;
    const reqEventSig = this.aggregator.interface.getEvent('RequestAIEvaluation').topicHash;
    const reqTopics = [reqEventSig, aggIdTopic];
    const deployBlock = this.aggregatorDeployBlock || 0;
    let requestEvent = null;
    let searchFrom = deployBlock;
    let logs = [];

    if (aggStatus?.startTimestamp > 0) {
      // startTimestamp pinpoints when the request landed (~2s/block on Base);
      // scan a narrow window around the estimated block, not to the chain head.
      const nowSec = Math.floor(Date.now() / 1000);
      const ageBlocks = Math.floor((nowSec - aggStatus.startTimestamp) / 2);
      const estReqBlock = Math.max(deployBlock, currentBlock - ageBlocks);
      searchFrom = Math.max(deployBlock, estReqBlock - REQ_SEARCH_MARGIN);
      const searchTo = Math.min(currentBlock, estReqBlock + REQ_SEARCH_MARGIN);
      logs = await this._getLogsChunked(reqTopics, searchFrom, searchTo);
    }

    // Fallback: no timestamp anchor (status read failed) or the window missed it.
    // Scan a BOUNDED recent look-back — never an unbounded full-history scan,
    // which the public RPC rejects (eth_getLogs 10k-range limit).
    if (logs.length === 0) {
      searchFrom = Math.max(deployBlock, currentBlock - RECENT_FALLBACK_BLOCKS);
      logs = await this._getLogsChunked(reqTopics, searchFrom, currentBlock);
    }

    if (logs.length > 0) {
      const parsed = this.aggregator.interface.parseLog(logs[0]);
      requestEvent = {
        block: logs[0].blockNumber,
        txHash: logs[0].transactionHash,
        cids: parsed.args.cids
      };
    }

    if (!requestEvent && !aggStatus) {
      return { found: false, aggId, message: 'No matching aggregation found on-chain' };
    }

    // All lifecycle events land within the aggregation's lifetime (commit +
    // reveal + fulfill/timeout), so collect them in a bounded window after the
    // request rather than scanning to the chain head.
    const eventFromBlock = requestEvent ? requestEvent.block : searchFrom;
    const eventToBlock = Math.min(currentBlock, eventFromBlock + EVENT_WINDOW);

    // 4. Fetch OracleSelected events
    const oracleSelectedSig = this.aggregator.interface.getEvent('OracleSelected').topicHash;
    const oracleLogs = await this._getLogsChunked([oracleSelectedSig, aggIdTopic], eventFromBlock, eventToBlock);

    logger.info('AggHistory debug', {
      oracleSelectedSig,
      oracleLogsFound: oracleLogs.length,
      aggIdTopic,
      eventFromBlock,
      currentBlock
    });

    const slotMap = {};
    for (const log of oracleLogs) {
      const parsed = this.aggregator.interface.parseLog(log);
      logger.info('OracleSelected parsed', { args: Object.keys(parsed.args), pollIndex: String(parsed.args.pollIndex), oracle: parsed.args.oracle });
      const slot = Number(parsed.args.pollIndex);
      slotMap[slot] = {
        slot,
        oracle: parsed.args.oracle,
        jobId: parsed.args.jobId,
        committed: false,
        revealRequested: false,
        revealOK: false,
        hashMismatch: false,
        invalidFormat: false,
        tooManyScores: false,
        wrongScoreCount: false,
        tooFewScores: false,
        scores: null,
        // Timing (block numbers + tx hashes of each lifecycle event; timestamps
        // are filled in from block headers in step 8b)
        selectedBlock: log.blockNumber,
        selectedTx: log.transactionHash,
        commitBlock: null,
        commitTx: null,
        revealRequestBlock: null,
        revealRequestTx: null,
        revealBlock: null,
        revealTx: null,
        failureBlock: null,
        failureTx: null
      };
    }

    // 5. Fetch lifecycle events (all indexed by aggRequestId)
    const eventNames = [
      'CommitReceived', 'RevealRequestDispatched',
      'RevealHashMismatch', 'InvalidRevealFormat',
      'RevealTooManyScores', 'RevealWrongScoreCount', 'RevealTooFewScores'
    ];

    const lifecycleLogs = await Promise.all(
      eventNames.map(name => {
        const sig = this.aggregator.interface.getEvent(name).topicHash;
        return this._getLogsChunked([sig, aggIdTopic], eventFromBlock, eventToBlock);
      })
    );

    for (let i = 0; i < eventNames.length; i++) {
      logger.info(`Lifecycle ${eventNames[i]}`, { logsFound: lifecycleLogs[i].length });
      for (const log of lifecycleLogs[i]) {
        const parsed = this.aggregator.interface.parseLog(log);
        const slot = Number(parsed.args.pollIndex);
        logger.info(`  ${eventNames[i]} slot=${slot}`, { args: Object.keys(parsed.args) });
        if (!slotMap[slot]) continue;
        const entry = slotMap[slot];
        switch (eventNames[i]) {
          case 'CommitReceived':
            entry.committed = true;
            entry.commitBlock = log.blockNumber;
            entry.commitTx = log.transactionHash;
            break;
          case 'RevealRequestDispatched':
            entry.revealRequested = true;
            entry.revealRequestBlock = log.blockNumber;
            entry.revealRequestTx = log.transactionHash;
            break;
          case 'RevealHashMismatch': entry.hashMismatch = true; break;
          case 'InvalidRevealFormat': entry.invalidFormat = true; break;
          case 'RevealTooManyScores': entry.tooManyScores = true; break;
          case 'RevealWrongScoreCount': entry.wrongScoreCount = true; break;
          case 'RevealTooFewScores': entry.tooFewScores = true; break;
        }
        // Any reveal-failure event marks when the (rejected) reveal landed
        if (eventNames[i] !== 'CommitReceived' && eventNames[i] !== 'RevealRequestDispatched') {
          entry.failureBlock = log.blockNumber;
          entry.failureTx = log.transactionHash;
        }
      }
    }

    // 6. Fetch NewOracleResponseRecorded events
    const responseSig = this.aggregator.interface.getEvent('NewOracleResponseRecorded').topicHash;
    const responseLogs = await this._getLogsChunked([responseSig, aggIdTopic], eventFromBlock, eventToBlock);

    logger.info('NewOracleResponseRecorded', { logsFound: responseLogs.length });
    for (const log of responseLogs) {
      const parsed = this.aggregator.interface.parseLog(log);
      const slot = Number(parsed.args.pollIndex);
      logger.info(`  Response slot=${slot}`, { args: Object.keys(parsed.args) });
      if (!slotMap[slot]) continue;
      slotMap[slot].revealOK = true;
      slotMap[slot].revealBlock = log.blockNumber;
      slotMap[slot].revealTx = log.transactionHash;
    }

    // 7. Check for EvaluationFailed and FulfillAIEvaluation
    const failSig = this.aggregator.interface.getEvent('EvaluationFailed').topicHash;
    const fulfillSig = this.aggregator.interface.getEvent('FulfillAIEvaluation').topicHash;

    const [failLogs, fulfillLogs] = await Promise.all([
      this._getLogsChunked([failSig, aggIdTopic], eventFromBlock, eventToBlock),
      this._getLogsChunked([fulfillSig, aggIdTopic], eventFromBlock, eventToBlock)
    ]);

    let fulfillment = null;
    if (fulfillLogs.length > 0) {
      const parsed = this.aggregator.interface.parseLog(fulfillLogs[0]);
      fulfillment = {
        likelihoods: parsed.args.likelihoods.map(s => Number(s)),
        justificationCID: parsed.args.justificationCID,
        block: fulfillLogs[0].blockNumber,
        txHash: fulfillLogs[0].transactionHash
      };
    }

    // 8. Build slots array and analysis
    const slots = Object.values(slotMap).sort((a, b) => a.slot - b.slot);

    // 8b. Resolve block timestamps for every lifecycle event block (request,
    // per-slot selected/commit/reveal-request/reveal/failure, fulfillment).
    // Events cluster in a handful of blocks, so this is a few getBlock calls.
    const blockTimestamps = await this._getBlockTimestamps([
      requestEvent?.block,
      fulfillment?.block,
      ...slots.flatMap(s => [s.selectedBlock, s.commitBlock, s.revealRequestBlock, s.revealBlock, s.failureBlock])
    ]);
    const tsOf = (block) => (block != null && blockTimestamps[block] != null) ? blockTimestamps[block] : null;
    if (requestEvent) requestEvent.timestamp = tsOf(requestEvent.block);
    if (fulfillment) fulfillment.timestamp = tsOf(fulfillment.block);
    for (const s of slots) {
      s.timing = {
        selected: { block: s.selectedBlock, timestamp: tsOf(s.selectedBlock), txHash: s.selectedTx },
        commit: s.commitBlock != null ? { block: s.commitBlock, timestamp: tsOf(s.commitBlock), txHash: s.commitTx } : null,
        revealRequest: s.revealRequestBlock != null ? { block: s.revealRequestBlock, timestamp: tsOf(s.revealRequestBlock), txHash: s.revealRequestTx } : null,
        reveal: s.revealBlock != null ? { block: s.revealBlock, timestamp: tsOf(s.revealBlock), txHash: s.revealTx } : null,
        failure: s.failureBlock != null ? { block: s.failureBlock, timestamp: tsOf(s.failureBlock), txHash: s.failureTx } : null
      };
      delete s.selectedBlock; delete s.selectedTx;
      delete s.commitBlock; delete s.commitTx;
      delete s.revealRequestBlock; delete s.revealRequestTx;
      delete s.revealBlock; delete s.revealTx;
      delete s.failureBlock; delete s.failureTx;
    }
    const totalSlots = slots.length;
    const committedSlots = slots.filter(s => s.committed);
    const revealedSlots = slots.filter(s => s.revealOK);
    const failedSlots = slots.filter(s => s.hashMismatch || s.invalidFormat || s.tooManyScores || s.wrongScoreCount || s.tooFewScores);
    const nonRespondingSlots = slots.filter(s => !s.committed);
    const uniqueOracles = new Set(slots.map(s => s.oracle)).size;

    // Determine outcome
    // If still early (< 10 min since request), show IN PROCESS instead of FAILED.
    // Prefer the RequestAIEvaluation event block; fall back to the struct's
    // startTimestamp (unix secs) when the event wasn't found.
    const requestBlock = requestEvent?.block || null;
    let elapsedMinutes = null;
    if (requestBlock) {
      // ~2 seconds per block on Base
      const blocksSinceRequest = currentBlock - requestBlock;
      elapsedMinutes = Math.round(blocksSinceRequest * 2 / 60);
    } else if (aggStatus?.startTimestamp > 0) {
      elapsedMinutes = Math.round((Math.floor(Date.now() / 1000) - aggStatus.startTimestamp) / 60);
    }
    const IN_PROCESS_WINDOW_MINUTES = 10;
    const isEarly = elapsedMinutes !== null && elapsedMinutes < IN_PROCESS_WINDOW_MINUTES;

    // Outcome is derived from events + elapsed time, NOT the aggregator's `failed`
    // flag (which it leaves unset on timeouts — see ABI note). Phase of death:
    //   commit  → fewer than M commits, so it never entered the reveal phase
    //   reveal  → reached M commits but fewer than N reveals
    const failPhase = committedSlots.length < contractParams.M ? 'commit'
      : (revealedSlots.length < contractParams.N ? 'reveal' : 'aggregation');
    let outcome;
    if (fulfillment) {
      outcome = 'COMPLETED';
    } else if (isEarly) {
      // Within the in-process window (> the 5-min response timeout) — still settling.
      outcome = `IN PROCESS (${failPhase} phase, ${elapsedMinutes}m elapsed)`;
    } else if (elapsedMinutes === null) {
      // No request event and no timestamp — can't place it in time.
      outcome = 'RUNNING';
    } else if (committedSlots.length === 0) {
      // No arbiter committed at all: the request itself was most likely unusable.
      outcome = LIKELY_MALFORMED_OUTCOME;
    } else {
      // Past the window with no FulfillAIEvaluation → it failed / timed out.
      outcome = `FAILED (${failPhase} phase)`;
    }

    const analysis = {
      totalSlots,
      committed: committedSlots.length,
      revealed: revealedSlots.length,
      nonResponding: nonRespondingSlots.length,
      nonRespondingSlotIds: nonRespondingSlots.map(s => s.slot),
      likelyMalformed: outcome === LIKELY_MALFORMED_OUTCOME,
      uniqueOracles,
      failures: {
        hashMismatch: slots.filter(s => s.hashMismatch).length,
        invalidFormat: slots.filter(s => s.invalidFormat).length,
        tooManyScores: slots.filter(s => s.tooManyScores).length,
        wrongScoreCount: slots.filter(s => s.wrongScoreCount).length,
        tooFewScores: slots.filter(s => s.tooFewScores).length
      }
    };

    return {
      found: true,
      aggId,
      contractParams,
      aggregationStatus: aggStatus,
      requestEvent,
      slots,
      fulfillment,
      outcome,
      analysis
    };
  }

  /**
   * Check if the service is properly configured
   */
  async healthCheck() {
    try {
      const keeperAddress = await this.aggregator.reputationKeeper();
      const config = await this.getAggregatorConfig();

      // Get wVDKA token address from ReputationKeeper
      let wvdkaAddress = null;
      try {
        const keeper = await this.getReputationKeeper();
        wvdkaAddress = await keeper.verdiktaToken();
      } catch (err) {
        logger.debug('Could not get wVDKA token address', { msg: err.message });
      }

      return {
        healthy: true,
        aggregatorAddress: this.aggregatorAddress,
        keeperAddress,
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
}

// Singleton instance
let verdiktaService = null;

function initializeVerdiktaService(providerUrl, aggregatorAddress, aggregatorDeployBlock = 0) {
  if (!aggregatorAddress) {
    logger.warn('Verdikta service not initialized: VERDIKTA_AGGREGATOR_ADDRESS not set');
    return null;
  }

  verdiktaService = new VerdiktaService(providerUrl, aggregatorAddress, aggregatorDeployBlock);
  logger.info('Verdikta service initialized', { aggregatorAddress });
  return verdiktaService;
}

function getVerdiktaService() {
  return verdiktaService; // Can be null if not configured
}

function isVerdiktaServiceAvailable() {
  return verdiktaService !== null;
}

module.exports = {
  initializeVerdiktaService,
  getVerdiktaService,
  isVerdiktaServiceAvailable,
  VerdiktaService,
  LIKELY_MALFORMED_OUTCOME
};
