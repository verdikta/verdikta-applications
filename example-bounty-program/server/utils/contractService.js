/**
 * Contract Service
 * Reads bounty data from deployed BountyEscrow smart contract
 */

const { ethers } = require('ethers');
const logger = require('./logger');

// BountyEscrow ABI (functions we need to read from the contract)
// Note: Submission struct now includes evaluationCid and hunterCid
const BOUNTY_ESCROW_ABI = [
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256 bountyId) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions))",
  "function getEffectiveBountyStatus(uint256 bountyId) view returns (string)",
  "function isAcceptingSubmissions(uint256 bountyId) view returns (bool)",
  "function canBeClosed(uint256 bountyId) view returns (bool)",
  "function submissionCount(uint256 bountyId) view returns (uint256)",
  "function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))",
  "function verdikta() view returns (address)"
];

// Verdikta Aggregator ABI (for checking evaluation results)
const VERDIKTA_AGGREGATOR_ABI = [
  "function getEvaluation(bytes32 aggId) view returns (uint256[] memory scores, string justificationCids, bool ok)"
];

class ContractService {
  constructor(providerUrl, contractAddress) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.contract = new ethers.Contract(contractAddress, BOUNTY_ESCROW_ABI, this.provider);
    this.contractAddress = contractAddress;
    this.verdiktaAggregator = null; // Lazy-loaded
    this.verdiktaAggregatorAddress = null;
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

  /**
   * Check if evaluation results are ready for a submission
   * Queries the Verdikta Aggregator contract directly
   * @param bountyId - The bounty ID
   * @param submissionId - The submission ID
   * @returns { ready: boolean, scores?: { acceptance, rejection }, justificationCids?: string }
   */
  async checkEvaluationReady(bountyId, submissionId) {
    try {
      // First, get the submission from contract to get verdiktaAggId
      const sub = await this.contract.getSubmission(bountyId, submissionId);
      const verdiktaAggId = sub.verdiktaAggId;

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
   * Get a single bounty from contract and map to API format
   * Status will be one of: OPEN, EXPIRED, AWARDED, CLOSED
   */
  async getBounty(bountyId) {
    try {
      const bounty = await this.contract.getBounty(bountyId);
      const effectiveStatus = await this.contract.getEffectiveBountyStatus(bountyId);
      const isAccepting = await this.contract.isAcceptingSubmissions(bountyId);
      const canClose = await this.contract.canBeClosed(bountyId);

      // Map contract data to API format
      // Note: evaluationCid is now the evaluation package (was rubricCid)
      return {
        jobId: Number(bountyId),
        bountyId: Number(bountyId), // Include both for compatibility
        creator: bounty.creator,
        evaluationCid: bounty.evaluationCid, // Renamed from rubricCid - now the evaluation package
        classId: Number(bounty.requestedClass),
        threshold: Number(bounty.threshold),
        bountyAmount: ethers.formatEther(bounty.payoutWei),
        bountyAmountWei: bounty.payoutWei.toString(),
        createdAt: Number(bounty.createdAt),
        submissionCloseTime: Number(bounty.submissionDeadline),
        status: effectiveStatus, // OPEN, EXPIRED, AWARDED, or CLOSED
        winner: bounty.winner === ethers.ZeroAddress ? null : bounty.winner,
        submissionCount: Number(bounty.submissions),
        isAcceptingSubmissions: isAccepting,
        canBeClosed: canClose, // New field: can closeExpiredBounty() be called?
        syncedFromBlockchain: true, // Mark as fresh on-chain data
        // These fields would come from off-chain storage or IPFS
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
   * List all bounties from contract
   */
  async listBounties(filters = {}) {
    try {
      const count = await this.getBountyCount();
      const bounties = [];

      for (let i = 0; i < count; i++) {
        try {
          const bounty = await this.getBounty(i);

          // Apply filters
          if (filters.status && bounty.status !== filters.status) continue;
          if (filters.creator && bounty.creator.toLowerCase() !== filters.creator.toLowerCase()) continue;
          if (filters.minPayout && parseFloat(bounty.bountyAmount) < parseFloat(filters.minPayout)) continue;

          bounties.push(bounty);
        } catch (err) {
          logger.warn(`Failed to fetch bounty ${i}:`, err);
        }
      }

      return bounties;
    } catch (error) {
      logger.error('Error listing bounties:', error);
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

