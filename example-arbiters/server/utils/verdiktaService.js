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
const { networks, normalizeNetwork, getRpcUrl } = require('../config');

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
  "function getContractConfig() view returns (address oracleAddr, address linkAddr, bytes32 jobId, uint256 fee)"
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
  "function verdiktaToken() view returns (address)"
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
  "function withdrawable() view returns (uint256)"
];

class VerdiktaService {
  constructor(providerUrl, aggregatorAddress) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.aggregatorAddress = aggregatorAddress;
    this.aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, this.provider);
    this.reputationKeeper = null;
    this.keeperAddress = null;
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
   * Get all oracles with their info (batched for efficiency)
   */
  async getAllOracles() {
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
      this.getAllOracles(),
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

    return {
      owner: ownerAddress,
      keeperAddress: this.keeperAddress,
      operators: Object.values(byOperator),
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
    const service = new VerdiktaService(getRpcUrl(key), net.verdiktaAggregatorAddress);
    instances.set(key, service);
    logger.info('Verdikta service initialized', { network: key, aggregatorAddress: net.verdiktaAggregatorAddress });
  }
  return instances.get(key);
}

module.exports = {
  getVerdiktaService,
  VerdiktaService
};
