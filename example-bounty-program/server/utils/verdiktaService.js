/**
 * Verdikta Service
 * Interacts with ReputationAggregator and ReputationKeeper contracts
 * for analytics data about arbiters/oracles
 */

const { ethers } = require('ethers');
const logger = require('./logger');

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
  "function getContractConfig() view returns (address oracleAddr, address linkAddr, bytes32 jobId, uint256 fee)",
  // Agg history view functions
  "function maxLikelihoodLength() view returns (uint256)",
  "function aggregatedEvaluations(bytes32) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitCount, uint256 responseCount, uint256 requestBlock)",
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

      // Check 3: Rapid recent decline - look at last 3 scores
      if (recentScores.length >= 3) {
        const last3 = recentScores.slice(-3);
        const recentDrop = last3[0].timelinessScore - last3[last3.length - 1].timelinessScore;
        // If dropped by 40+ points in last 3 updates (2+ missed responses recently)
        if (recentDrop >= 40) {
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

        // Debug logging for 5050 class
        if (oracle.classes.includes(5050)) {
          logger.info('5050 class oracle analysis', {
            oracle: oracle.oracle.slice(0, 10) + '...',
            isActive: oracle.isActive,
            isBlocked,
            timelinessScore: oracle.timelinessScore,
            recentScoresCount: oracle.recentScores?.length || 0,
            recentScores: oracle.recentScores?.slice(-5).map(s => s.timelinessScore),
            responsiveness
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
              classes: oracle.classes || [classId]
            });
          }

          // Determine arbiter status - "new" if called fewer than 3 times
          const isNew = oracle.callCount < 3;

          if (!oracle.isActive) {
            byClass[classId].inactive++;
          } else if (isBlocked) {
            byClass[classId].blocked++;
          } else if (responsiveness.isUnresponsive) {
            byClass[classId].unresponsive++;
          } else if (isNew) {
            byClass[classId].new++;
          } else {
            byClass[classId].active++;
          }

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
    const [K, M, N, maxLikLen] = await Promise.all([
      this.aggregator.commitOraclesToPoll(),
      this.aggregator.oraclesToPoll(),
      this.aggregator.requiredResponses(),
      this.aggregator.maxLikelihoodLength()
    ]);
    const contractParams = {
      K: Number(K),
      M: Number(M),
      N: Number(N),
      maxLikelihoodLength: Number(maxLikLen)
    };

    // 2. Fetch aggregation status
    let aggStatus;
    try {
      const raw = await this.aggregator.aggregatedEvaluations(aggId);
      aggStatus = {
        isComplete: raw.isComplete,
        failed: raw.failed,
        commitPhaseComplete: raw.commitPhaseComplete,
        commitCount: Number(raw.commitCount),
        responseCount: Number(raw.responseCount),
        requestBlock: Number(raw.requestBlock)
      };
    } catch (err) {
      logger.warn('Failed to fetch aggregatedEvaluations', { aggId, msg: err.message });
      aggStatus = null;
    }

    // 3. Find RequestAIEvaluation event
    // Use requestBlock from on-chain storage when available for precise search
    const aggIdTopic = aggId;
    const reqEventSig = this.aggregator.interface.getEvent('RequestAIEvaluation').topicHash;
    let requestEvent = null;
    const searchFrom = aggStatus?.requestBlock
      ? Math.max(0, aggStatus.requestBlock - 1)
      : Math.max(0, currentBlock - 50000);

    const logs = await this.provider.getLogs({
      address: this.aggregatorAddress,
      topics: [reqEventSig, aggIdTopic],
      fromBlock: searchFrom,
      toBlock: currentBlock
    });

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

    const eventFromBlock = requestEvent ? requestEvent.block : searchFrom;

    // 4. Fetch OracleSelected events
    const oracleSelectedSig = this.aggregator.interface.getEvent('OracleSelected').topicHash;
    const oracleLogs = await this.provider.getLogs({
      address: this.aggregatorAddress,
      topics: [oracleSelectedSig, aggIdTopic],
      fromBlock: eventFromBlock,
      toBlock: currentBlock
    });

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
        scores: null
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
        return this.provider.getLogs({
          address: this.aggregatorAddress,
          topics: [sig, aggIdTopic],
          fromBlock: eventFromBlock,
          toBlock: currentBlock
        });
      })
    );

    for (let i = 0; i < eventNames.length; i++) {
      logger.info(`Lifecycle ${eventNames[i]}`, { logsFound: lifecycleLogs[i].length });
      for (const log of lifecycleLogs[i]) {
        const parsed = this.aggregator.interface.parseLog(log);
        const slot = Number(parsed.args.pollIndex);
        logger.info(`  ${eventNames[i]} slot=${slot}`, { args: Object.keys(parsed.args) });
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

    // 6. Fetch NewOracleResponseRecorded events
    const responseSig = this.aggregator.interface.getEvent('NewOracleResponseRecorded').topicHash;
    const responseLogs = await this.provider.getLogs({
      address: this.aggregatorAddress,
      topics: [responseSig, aggIdTopic],
      fromBlock: eventFromBlock,
      toBlock: currentBlock
    });

    logger.info('NewOracleResponseRecorded', { logsFound: responseLogs.length });
    for (const log of responseLogs) {
      const parsed = this.aggregator.interface.parseLog(log);
      const slot = Number(parsed.args.pollIndex);
      logger.info(`  Response slot=${slot}`, { args: Object.keys(parsed.args) });
      if (!slotMap[slot]) continue;
      slotMap[slot].revealOK = true;
    }

    // 7. Check for EvaluationFailed and FulfillAIEvaluation
    const failSig = this.aggregator.interface.getEvent('EvaluationFailed').topicHash;
    const fulfillSig = this.aggregator.interface.getEvent('FulfillAIEvaluation').topicHash;

    const [failLogs, fulfillLogs] = await Promise.all([
      this.provider.getLogs({
        address: this.aggregatorAddress,
        topics: [failSig, aggIdTopic],
        fromBlock: eventFromBlock,
        toBlock: currentBlock
      }),
      this.provider.getLogs({
        address: this.aggregatorAddress,
        topics: [fulfillSig, aggIdTopic],
        fromBlock: eventFromBlock,
        toBlock: currentBlock
      })
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
    const totalSlots = slots.length;
    const committedSlots = slots.filter(s => s.committed);
    const revealedSlots = slots.filter(s => s.revealOK);
    const failedSlots = slots.filter(s => s.hashMismatch || s.invalidFormat || s.tooManyScores || s.wrongScoreCount || s.tooFewScores);
    const nonRespondingSlots = slots.filter(s => !s.committed);
    const uniqueOracles = new Set(slots.map(s => s.oracle)).size;

    // Determine outcome
    // If still early (< 10 min since request), show IN PROCESS instead of FAILED
    // Prefer the event block (reliable) over aggStatus.requestBlock (may be an internal index, not a block number)
    const requestBlock = requestEvent?.block
      || (aggStatus?.requestBlock > 1000 ? aggStatus.requestBlock : null);
    let elapsedMinutes = null;
    if (requestBlock) {
      // ~2 seconds per block on Base
      const blocksSinceRequest = currentBlock - requestBlock;
      elapsedMinutes = Math.round(blocksSinceRequest * 2 / 60);
    }
    const IN_PROCESS_WINDOW_MINUTES = 10;
    const isEarly = elapsedMinutes !== null && elapsedMinutes < IN_PROCESS_WINDOW_MINUTES;

    let outcome;
    if (fulfillment) {
      outcome = 'COMPLETED';
    } else if (failLogs.length > 0 || (aggStatus && aggStatus.failed)) {
      let failPhase = 'unknown';
      if (committedSlots.length < contractParams.M) failPhase = 'commit';
      else if (revealedSlots.length < contractParams.N) failPhase = 'reveal';
      if (isEarly) {
        outcome = `IN PROCESS (${failPhase} phase, ${elapsedMinutes}m elapsed)`;
      } else {
        outcome = `FAILED (${failPhase} phase)`;
      }
    } else {
      if (elapsedMinutes !== null) {
        outcome = `RUNNING (${elapsedMinutes}m elapsed)`;
      } else {
        outcome = 'RUNNING';
      }
    }

    const analysis = {
      totalSlots,
      committed: committedSlots.length,
      revealed: revealedSlots.length,
      nonResponding: nonRespondingSlots.length,
      nonRespondingSlotIds: nonRespondingSlots.map(s => s.slot),
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

      // Get LINK token address from aggregator's getContractConfig (legacy)
      let linkTokenAddress = null;
      try {
        const contractConfig = await this.aggregator.getContractConfig();
        linkTokenAddress = contractConfig.linkAddr || contractConfig[1];
      } catch (err) {
        // May fail if getContractConfig is removed in future versions
        logger.debug('Could not get LINK token address', { msg: err.message });
      }

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
