/**
 * Contract Service
 * Reads bounty data from deployed BountyEscrow smart contract
 *
 * Optimized for event-based sync: getBounty() uses 1 RPC call (not 4),
 * getEventsSince() fetches all events in a single eth_getLogs call,
 * getEvaluationByAggId() skips the redundant getSubmission() call.
 */

const { ethers } = require('ethers');
const logger = require('./logger');

// BountyEscrow ABI — functions + events
const BOUNTY_ESCROW_ABI = [
  // Functions
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256 bountyId) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions))",
  "function getEffectiveBountyStatus(uint256 bountyId) view returns (string)",
  "function isAcceptingSubmissions(uint256 bountyId) view returns (bool)",
  "function canBeClosed(uint256 bountyId) view returns (bool)",
  "function submissionCount(uint256 bountyId) view returns (uint256)",
  "function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))",
  "function verdikta() view returns (address)",
  // Events
  "event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)",
  "event BountyClosed(uint256 indexed bountyId)",
  "event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, string evaluationCid, string hunterCid)",
  "event WorkSubmitted(uint256 indexed bountyId, uint256 indexed submissionId, bytes32 verdiktaAggId)",
  "event SubmissionFinalized(uint256 indexed bountyId, uint256 indexed submissionId, uint8 status, uint256 acceptance, uint256 rejection)",
  "event PayoutSent(uint256 indexed bountyId, address indexed winner, uint256 amount)",
  "event LinkRefunded(uint256 indexed bountyId, uint256 indexed submissionId, uint256 amount)"
];

// Verdikta Aggregator ABI (for checking evaluation results)
const VERDIKTA_AGGREGATOR_ABI = [
  "function getEvaluation(bytes32 aggId) view returns (uint256[] memory scores, string justificationCids, bool ok)"
];

// On-chain bounty status enum: 0=Open, 1=Awarded, 2=Closed
const BOUNTY_STATUS_ENUM = ['Open', 'Awarded', 'Closed'];

/**
 * Compute effective status locally from getBounty() struct fields.
 * Matches the contract's getEffectiveBountyStatus() logic:
 *   status=0 (Open) + deadline passed → EXPIRED
 *   status=0 (Open) + deadline not passed → OPEN
 *   status=1 → AWARDED
 *   status=2 → CLOSED
 */
function computeEffectiveStatus(bountyStruct) {
  const rawStatus = Number(bountyStruct.status);
  const deadline = Number(bountyStruct.submissionDeadline);
  const now = Math.floor(Date.now() / 1000);

  if (rawStatus === 1) return 'AWARDED';
  if (rawStatus === 2) return 'CLOSED';
  // rawStatus === 0 (Open)
  if (deadline > 0 && now > deadline) return 'EXPIRED';
  return 'OPEN';
}

/**
 * Compute isAcceptingSubmissions locally.
 * True only when status is Open AND deadline has not passed.
 */
function computeIsAccepting(bountyStruct) {
  const rawStatus = Number(bountyStruct.status);
  if (rawStatus !== 0) return false;
  const deadline = Number(bountyStruct.submissionDeadline);
  const now = Math.floor(Date.now() / 1000);
  return now <= deadline;
}

/**
 * Compute canBeClosed locally.
 * True when status is Open AND deadline has passed.
 * Note: the contract also checks that no submissions are PendingVerdikta,
 * but we can't check that without extra RPC calls. This is a local approximation.
 */
function computeCanBeClosed(bountyStruct) {
  const rawStatus = Number(bountyStruct.status);
  if (rawStatus !== 0) return false;
  const deadline = Number(bountyStruct.submissionDeadline);
  const now = Math.floor(Date.now() / 1000);
  return now > deadline;
}

class ContractService {
  constructor(providerUrl, contractAddress) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.contract = new ethers.Contract(contractAddress, BOUNTY_ESCROW_ABI, this.provider);
    this.contractAddress = contractAddress;
    this.verdiktaAggregator = null; // Lazy-loaded
    this.verdiktaAggregatorAddress = null;
    this._iface = new ethers.Interface(BOUNTY_ESCROW_ABI);
  }

  /**
   * Get the Verdikta Aggregator contract instance (lazy-loaded)
   */
  async getVerdiktaAggregator() {
    if (!this.verdiktaAggregator) {
      try {
        this.verdiktaAggregatorAddress = await this.contract.verdikta();
        this.verdiktaAggregator = new ethers.Contract(
          this.verdiktaAggregatorAddress,
          VERDIKTA_AGGREGATOR_ABI,
          this.provider
        );
        logger.info('Verdikta Aggregator loaded', { address: this.verdiktaAggregatorAddress });
      } catch (error) {
        logger.error('Failed to get Verdikta Aggregator address', { msg: error.message });
        throw error;
      }
    }
    return this.verdiktaAggregator;
  }

  // ---------------------------------------------------------------------------
  // Block number
  // ---------------------------------------------------------------------------

  /**
   * Get the current block number — 1 RPC call
   */
  async getBlockNumber() {
    return await this.provider.getBlockNumber();
  }

  // ---------------------------------------------------------------------------
  // Event fetching
  // ---------------------------------------------------------------------------

  /**
   * Fetch all BountyEscrow events between fromBlock and toBlock (inclusive).
   * Single eth_getLogs call with no topic filter (gets all events from contract).
   * Returns array of { name, args, blockNumber, transactionHash }.
   *
   * Retries with exponential backoff on rate-limit (429) or server errors.
   */
  async getEventsSince(fromBlock, toBlock) {
    const filter = {
      address: this.contractAddress,
      fromBlock,
      toBlock
    };

    let logs;
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        logs = await this.provider.getLogs(filter);
        break;
      } catch (error) {
        const isRateLimit = error.code === 'SERVER_ERROR' ||
          error.message?.includes('429') ||
          error.message?.includes('rate limit') ||
          error.message?.includes('Too Many Requests');

        if (isRateLimit && attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          logger.warn(`getEventsSince: rate limited, retrying in ${delay}ms`, {
            attempt: attempt + 1,
            fromBlock,
            toBlock
          });
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }

    const events = [];
    for (const log of logs) {
      try {
        const parsed = this._iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed) {
          events.push({
            name: parsed.name,
            args: parsed.args,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash
          });
        }
      } catch {
        // Unknown event (not in our ABI) — skip
      }
    }

    return events;
  }

  // ---------------------------------------------------------------------------
  // Evaluation checks
  // ---------------------------------------------------------------------------

  /**
   * Check evaluation by aggregator ID directly — 1 RPC call.
   * Skips the redundant getSubmission() call since callers already have the aggId.
   */
  async getEvaluationByAggId(verdiktaAggId) {
    try {
      if (!verdiktaAggId || verdiktaAggId === ethers.ZeroHash) {
        return { ready: false, reason: 'no_agg_id' };
      }

      const aggregator = await this.getVerdiktaAggregator();
      const [scores, justCids, ok] = await aggregator.getEvaluation(verdiktaAggId);

      if (!ok) {
        return { ready: false, reason: 'not_ok' };
      }

      if (!scores || scores.length < 2) {
        return { ready: false, reason: 'invalid_scores' };
      }

      // scores[0] = rejection likelihood, scores[1] = acceptance likelihood
      // Scores are in 6 decimal precision (0-1000000), divide by 10000 to get percentages
      const acceptance = Number(scores[1]) / 10000;
      const rejection = Number(scores[0]) / 10000;

      return {
        ready: true,
        scores: { rejection, acceptance },
        justificationCids: justCids || ''
      };
    } catch (error) {
      if (error.code === 'CALL_EXCEPTION') {
        return { ready: false, reason: 'call_exception' };
      }
      logger.warn('Error in getEvaluationByAggId', { verdiktaAggId, msg: error.message });
      return { ready: false, error: error.message };
    }
  }

  /**
   * Check if evaluation results are ready for a submission
   * Queries the Verdikta Aggregator contract directly
   * @param bountyId - The bounty ID
   * @param submissionId - The submission ID
   * @param verdiktaAggIdHint - Optional: skip the getSubmission() call if aggId is known
   * @returns { ready: boolean, scores?: { acceptance, rejection }, justificationCids?: string }
   */
  async checkEvaluationReady(bountyId, submissionId, verdiktaAggIdHint) {
    try {
      let verdiktaAggId = verdiktaAggIdHint;

      // Only fetch submission if we don't have the aggId
      if (!verdiktaAggId) {
        const sub = await this.contract.getSubmission(bountyId, submissionId);
        verdiktaAggId = sub.verdiktaAggId;
      }

      // Skip if no aggId or it's zero
      if (!verdiktaAggId || verdiktaAggId === ethers.ZeroHash) {
        logger.debug('checkEvaluationReady: No verdiktaAggId', { bountyId, submissionId });
        return { ready: false, reason: 'no_agg_id' };
      }

      const aggregator = await this.getVerdiktaAggregator();
      const [scores, justCids, ok] = await aggregator.getEvaluation(verdiktaAggId);

      if (!ok) {
        logger.debug('checkEvaluationReady: Aggregator returned ok=false', { bountyId, submissionId, verdiktaAggId });
        return { ready: false, reason: 'not_ok' };
      }

      if (!scores || scores.length < 2) {
        logger.debug('checkEvaluationReady: Invalid scores', { bountyId, submissionId, scores });
        return { ready: false, reason: 'invalid_scores' };
      }

      // scores[0] = rejection likelihood, scores[1] = acceptance likelihood
      // Scores are in 6 decimal precision (0-1000000), divide by 10000 to get percentages
      const acceptance = Number(scores[1]) / 10000;
      const rejection = Number(scores[0]) / 10000;

      logger.info('checkEvaluationReady: Found result', {
        bountyId,
        submissionId,
        acceptance: acceptance.toFixed(1),
        rejection: rejection.toFixed(1)
      });

      return {
        ready: true,
        scores: { rejection, acceptance },
        justificationCids: justCids || ''
      };
    } catch (error) {
      // CALL_EXCEPTION is expected when evaluation data doesn't exist yet
      if (error.code === 'CALL_EXCEPTION') {
        logger.debug('checkEvaluationReady: CALL_EXCEPTION', { bountyId, submissionId });
        return { ready: false, reason: 'call_exception' };
      }
      logger.warn('Error checking evaluation ready', { bountyId, submissionId, msg: error.message, code: error.code });
      return { ready: false, error: error.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Bounty / submission reads
  // ---------------------------------------------------------------------------

  /**
   * Get bounty count from contract
   */
  async getBountyCount() {
    try {
      const count = await this.contract.bountyCount();
      return Number(count);
    } catch (error) {
      logger.error('Error getting bounty count:', error);
      throw error;
    }
  }

  /**
   * Get a single bounty from contract — 1 RPC call.
   * Status, isAcceptingSubmissions, canBeClosed are computed locally
   * from the struct fields instead of making 3 extra view calls.
   */
  async getBounty(bountyId) {
    try {
      const bounty = await this.contract.getBounty(bountyId);

      const effectiveStatus = computeEffectiveStatus(bounty);
      const isAccepting = computeIsAccepting(bounty);
      const canClose = computeCanBeClosed(bounty);

      return {
        jobId: Number(bountyId),
        bountyId: Number(bountyId),
        creator: bounty.creator,
        evaluationCid: bounty.evaluationCid,
        classId: Number(bounty.requestedClass),
        threshold: Number(bounty.threshold),
        bountyAmount: ethers.formatEther(bounty.payoutWei),
        bountyAmountWei: bounty.payoutWei.toString(),
        createdAt: Number(bounty.createdAt),
        submissionCloseTime: Number(bounty.submissionDeadline),
        status: effectiveStatus,
        winner: bounty.winner === ethers.ZeroAddress ? null : bounty.winner,
        submissionCount: Number(bounty.submissions),
        isAcceptingSubmissions: isAccepting,
        canBeClosed: canClose,
        syncedFromBlockchain: true,
        title: `Bounty #${bountyId}`,
        description: 'Fetched from blockchain',
        workProductType: 'On-chain Bounty'
      };
    } catch (error) {
      logger.error(`Error getting bounty ${bountyId}:`, error);
      throw error;
    }
  }

  /**
   * Get a single bounty with on-chain computed status values (4 RPC calls).
   * Use only when you truly need the contract's own computed values
   * (e.g., canBeClosed that also checks pending submissions on-chain).
   */
  async getBountyFull(bountyId) {
    try {
      const bounty = await this.contract.getBounty(bountyId);
      const effectiveStatus = await this.contract.getEffectiveBountyStatus(bountyId);
      const isAccepting = await this.contract.isAcceptingSubmissions(bountyId);
      const canClose = await this.contract.canBeClosed(bountyId);

      return {
        jobId: Number(bountyId),
        bountyId: Number(bountyId),
        creator: bounty.creator,
        evaluationCid: bounty.evaluationCid,
        classId: Number(bounty.requestedClass),
        threshold: Number(bounty.threshold),
        bountyAmount: ethers.formatEther(bounty.payoutWei),
        bountyAmountWei: bounty.payoutWei.toString(),
        createdAt: Number(bounty.createdAt),
        submissionCloseTime: Number(bounty.submissionDeadline),
        status: effectiveStatus,
        winner: bounty.winner === ethers.ZeroAddress ? null : bounty.winner,
        submissionCount: Number(bounty.submissions),
        isAcceptingSubmissions: isAccepting,
        canBeClosed: canClose,
        syncedFromBlockchain: true,
        title: `Bounty #${bountyId}`,
        description: 'Fetched from blockchain',
        workProductType: 'On-chain Bounty'
      };
    } catch (error) {
      logger.error(`Error getting bounty (full) ${bountyId}:`, error);
      throw error;
    }
  }

  /**
   * Get all submissions for a bounty
   */
  async getSubmissions(bountyId) {
    try {
      const submissionCount = await this.contract.submissionCount(bountyId);
      const submissions = [];

      for (let i = 0; i < submissionCount; i++) {
        try {
          const sub = await this.contract.getSubmission(bountyId, i);

          // Map submission status enum to string
          const statusMap = ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid'];

          submissions.push({
            submissionId: i,
            hunter: sub.hunter,
            evaluationCid: sub.evaluationCid,
            hunterCid: sub.hunterCid,
            evalWallet: sub.evalWallet,
            verdiktaAggId: sub.verdiktaAggId,
            status: statusMap[sub.status] || 'UNKNOWN',
            acceptance: Number(sub.acceptance),
            rejection: Number(sub.rejection),
            justificationCids: sub.justificationCids,
            submittedAt: Number(sub.submittedAt),
            finalizedAt: Number(sub.finalizedAt),
            linkMaxBudget: sub.linkMaxBudget.toString(),
            score: sub.acceptance > 0 ? Number(sub.acceptance) : null
          });
        } catch (err) {
          logger.warn(`Failed to fetch submission ${i} for bounty ${bountyId}:`, err);
        }
      }

      return submissions;
    } catch (error) {
      logger.error(`Error getting submissions for bounty ${bountyId}:`, error);
      throw error;
    }
  }

  /**
   * Check if a bounty can be closed right now
   * Returns true if: status is EXPIRED and no active evaluations
   */
  async canBeClosed(bountyId) {
    try {
      return await this.contract.canBeClosed(bountyId);
    } catch (error) {
      logger.error(`Error checking if bounty ${bountyId} can be closed:`, error);
      return false;
    }
  }

  /**
   * Check if a bounty is accepting new submissions
   * Returns true only if: status is OPEN (before deadline)
   */
  async isAcceptingSubmissions(bountyId) {
    try {
      return await this.contract.isAcceptingSubmissions(bountyId);
    } catch (error) {
      logger.error(`Error checking if bounty ${bountyId} is accepting submissions:`, error);
      return false;
    }
  }

  /**
   * Get the effective status string from contract
   * Returns: "OPEN", "EXPIRED", "AWARDED", or "CLOSED"
   */
  async getEffectiveStatus(bountyId) {
    try {
      return await this.contract.getEffectiveBountyStatus(bountyId);
    } catch (error) {
      logger.error(`Error getting effective status for bounty ${bountyId}:`, error);
      return 'UNKNOWN';
    }
  }
}

// Export singleton instance
let contractService = null;

function initializeContractService(providerUrl, contractAddress) {
  contractService = new ContractService(providerUrl, contractAddress);
  logger.info('Contract service initialized', { contractAddress });
  return contractService;
}

function getContractService() {
  if (!contractService) {
    throw new Error('Contract service not initialized. Call initializeContractService first.');
  }
  return contractService;
}

module.exports = {
  initializeContractService,
  getContractService,
  ContractService
};
