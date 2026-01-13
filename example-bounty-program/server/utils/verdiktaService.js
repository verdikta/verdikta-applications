/**
 * Verdikta Service
 * Interacts with ReputationAggregator and ReputationKeeper contracts
 * for analytics data about arbiters/oracles
 */

const { ethers } = require('ethers');
const logger = require('./logger');

// ReputationAggregator ABI (functions needed for analytics)
const AGGREGATOR_ABI = [
  "function reputationKeeper() view returns (address)",
  "function commitOraclesToPoll() view returns (uint256)",
  "function oraclesToPoll() view returns (uint256)",
  "function requiredResponses() view returns (uint256)",
  "function clusterSize() view returns (uint256)",
  "function bonusMultiplier() view returns (uint256)",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function maxOracleFee() view returns (uint256)"
];

// ReputationKeeper ABI (functions needed for oracle data)
// Note: registeredOracles auto-getter doesn't return classes array - must use getOracleClasses separately
const KEEPER_ABI = [
  "function getRegisteredOraclesCount() view returns (uint256)",
  "function registeredOracles(uint256 index) view returns (address oracle, bytes32 jobId)",
  "function getOracleInfo(address _oracle, bytes32 _jobId) view returns (bool isActive, int256 qualityScore, int256 timelinessScore, uint256 callCount, bytes32 jobId, uint256 fee, uint256 stakeAmount, uint256 lockedUntil, bool blocked)",
  "function getOracleClasses(uint256 index) view returns (uint64[])"
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

        // Get detailed info for each oracle
        const infoPromises = batchResults.map(o =>
          this.getOracleInfo(o.oracle, o.jobId)
            .then(info => ({ ...o, ...info }))
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
      const oracles = await this.getAllOracles();
      const byClass = {};
      const now = Math.floor(Date.now() / 1000);

      for (const oracle of oracles) {
        if (oracle.error) continue;

        // Determine if oracle is currently blocked
        const isBlocked = oracle.blocked && oracle.lockedUntil > now;

        for (const classId of oracle.classes) {
          if (!byClass[classId]) {
            byClass[classId] = {
              classId,
              active: 0,
              blocked: 0,
              inactive: 0,
              total: 0,
              avgQualityScore: 0,
              avgTimelinessScore: 0,
              totalCallCount: 0,
              qualityScores: [],
              timelinessScores: []
            };
          }

          byClass[classId].total++;

          if (!oracle.isActive) {
            byClass[classId].inactive++;
          } else if (isBlocked) {
            byClass[classId].blocked++;
          } else {
            byClass[classId].active++;
          }

          byClass[classId].totalCallCount += oracle.callCount;
          byClass[classId].qualityScores.push(oracle.qualityScore);
          byClass[classId].timelinessScores.push(oracle.timelinessScore);
        }
      }

      // Calculate averages
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
        // Remove raw scores from output
        delete cls.qualityScores;
        delete cls.timelinessScores;
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
   * Check if the service is properly configured
   */
  async healthCheck() {
    try {
      const keeperAddress = await this.aggregator.reputationKeeper();
      const config = await this.getAggregatorConfig();

      return {
        healthy: true,
        aggregatorAddress: this.aggregatorAddress,
        keeperAddress,
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

function initializeVerdiktaService(providerUrl, aggregatorAddress) {
  if (!aggregatorAddress) {
    logger.warn('Verdikta service not initialized: VERDIKTA_AGGREGATOR_ADDRESS not set');
    return null;
  }

  verdiktaService = new VerdiktaService(providerUrl, aggregatorAddress);
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
  VerdiktaService
};
