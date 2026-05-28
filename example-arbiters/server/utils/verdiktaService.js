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
const { networks, normalizeNetwork, getRpcUrl, getArchiveRpcUrl, funding } = require('../config');

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

// ReputationAggregator ABI — view functions needed for analytics.
const AGGREGATOR_ABI = [
  "function reputationKeeper() view returns (address)",
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

// ArbiterOperator (Chainlink Operator) ABI — owner + claimable LINK balance.
// An operator contract serves one owner and may back several jobIds; earned
// LINK accrues here and is withdrawn by the owner (see client write path).
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

class VerdiktaService {
  constructor(providerUrl, aggregatorAddress, options = {}) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.aggregatorAddress = aggregatorAddress;
    this.aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, this.provider);
    this.reputationKeeper = null;
    this.keeperAddress = null;

    // Network identity (used in logging / data paths).
    this.networkKey = options.networkKey || 'base-sepolia';

    // Archive RPC for historical eth_getLogs (per-jobId sender derivation).
    // Lazy-init: only opened when an archive scan is requested.
    this.archiveRpcUrl = options.archiveRpcUrl || null;
    this._archiveProvider = null;

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
   * — the address allowed to withdraw earned LINK and to deregister. One operator
   * may back several jobIds, so claimable LINK is reported once per operator while
   * stake/lock state is reported per (oracle, jobId).
   *
   * The keeper address is returned so the client can build the deregister tx.
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

    return {
      owner: ownerAddress,
      keeperAddress: this.keeperAddress,
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

  /** operator (lowercased) -> withdrawable LINK (bigint) or null. Read fresh. */
  async getWithdrawableMap(operatorAddrs) {
    return this._batchOperatorRead(operatorAddrs, 'withdrawable');
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

  /**
   * Arbiters grouped by owner address (the ArbiterOperator owner), with totals
   * for the analytics "Arbiters by Owner" table: arbiter/operator counts,
   * average reputation, claimable LINK (Σ withdrawable) and node funding.
   * Sorted by owner address, numerically ascending.
   */
  async getOwnersAnalytics() {
    const [oracles, thresholds] = await Promise.all([
      this.getAllOracles(),
      this.getThresholds()
    ]);
    const valid = oracles.filter((o) => !o.error && o.oracle);
    const operatorAddrs = [...new Set(valid.map((o) => o.oracle))];

    const [ownerMap, withdrawableMap, fundingData] = await Promise.all([
      this.getOwnerMap(operatorAddrs),
      this.getWithdrawableMap(operatorAddrs),
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

    const owners = Object.values(byOwner).map((b) => {
      let claimable = 0n;
      let claimableKnown = true;
      let nodeWei = 0n;
      for (const op of b.operators) {
        const w = withdrawableMap[op];
        if (w == null) claimableKnown = false;
        else claimable += w;
        nodeWei += fundingPerOp[op]?.totalWei ?? 0n;
      }
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
        claimableLink: claimableKnown ? ethers.formatEther(claimable) : null,
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

      // Get LINK token address from aggregator's getContractConfig (legacy)
      let linkTokenAddress = null;
      try {
        const contractConfig = await withRetry(() => this.aggregator.getContractConfig());
        linkTokenAddress = contractConfig.linkAddr || contractConfig[1];
      } catch (err) {
        // May fail if getContractConfig is removed in future versions
        logger.debug('Could not get LINK token address', { msg: err.message });
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
   * Aggregator's Chainlink payment config: LINK token, job id, per-oracle fee.
   * Returned by the legacy getContractConfig() view.
   */
  async getPaymentConfig() {
    const cfg = await withRetry(() => this.aggregator.getContractConfig());
    return {
      linkTokenAddress: cfg.linkAddr || cfg[1],
      jobId: cfg.jobId || cfg[2],
      fee: ethers.formatEther(cfg.fee ?? cfg[3])
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
      archiveRpcUrl: getArchiveRpcUrl(key)
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
