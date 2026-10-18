/**
 * Contract Service
 * Reads bounty data from deployed BountyEscrow smart contract
 *
 * Optimized for event-based sync: getBounty() uses 1 RPC call (not 4),
 * getEventsSince() fetches all events in a single eth_getLogs call,
 * getEvaluationByAggId() skips the redundant getSubmission() call.
 */

const { ethers } = require('ethers');
const { fundedBountyWei } = require('./bountyAmounts');
const logger = require('./logger');

// BountyEscrow ABI — functions + events
const BOUNTY_ESCROW_ABI = [
  // Functions
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256 bountyId) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, tuple(uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) oracle))",
  "function getEffectiveBountyStatus(uint256 bountyId) view returns (string)",
  "function isAcceptingSubmissions(uint256 bountyId) view returns (bool)",
  "function canBeClosed(uint256 bountyId) view returns (bool)",
  "function requiredPrepay(uint256 bountyId) view returns (uint256)",
  "function effectiveOracleParams(uint256 bountyId) view returns (tuple(uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling))",
  "function getSubmissions(uint256 bountyId) view returns (tuple(address hunter, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, uint256 submittedAt, uint256 finalizedAt, uint256 ethMaxBudget, uint64 creatorWindowEnd, address funder)[])",
  "function getBounties(uint256 start, uint256 count) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, tuple(uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) oracle)[])",
  "function getOracleResult(uint256 bountyId, uint256 submissionId) view returns (bool started, bool hasResult, bool settled, bool failed, uint256[] scores, string justificationCids, uint256 startTimestamp)",
  "function nextAction(uint256 bountyId, uint256 submissionId) view returns (string)",
  "function prepareCutoff(uint256 bountyId) view returns (uint256)",
  "function MAX_BATCH() view returns (uint256)",
  "function submissionCount(uint256 bountyId) view returns (uint256)",
  "function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, uint256 submittedAt, uint256 finalizedAt, uint256 ethMaxBudget, uint64 creatorWindowEnd, address funder))",
  "function verdikta() view returns (address)",
  "function activeEvaluations(uint256) view returns (uint256)",
  "function pendingSubmissionIds(uint256 bountyId) view returns (uint256[])",
  "function withdrawable(address) view returns (uint256)",
  "function MAX_SUBMISSIONS_PER_BOUNTY() view returns (uint256)",
  "function recoverLeftoverEth(uint256 bountyId, uint256 submissionId)",
  // Events
  "event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)",
  "event BountyClosed(uint256 indexed bountyId, address indexed creator, uint256 amountReturned)",
  // FIELD ORDER: ethMaxBudget BEFORE the dynamic string (September 2026 revision).
  // Logs of the pre-September-2026 contract used (…, string evaluationCid, uint256 ethMaxBudget)
  // and a different topic0 — see server/utils/submissionEvents.js LEGACY_* if you ever
  // need to read that address again.
  "event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, uint256 ethMaxBudget, string evaluationCid)",
  "event WorkSubmitted(uint256 indexed bountyId, uint256 indexed submissionId, bytes32 verdiktaAggId)",
  // `paid` is true only for the winner in that tx (PassedPaid); false for Failed,
  // PassedUnpaid and TIMED_OUT.
  "event SubmissionFinalized(uint256 indexed bountyId, uint256 indexed submissionId, bool passed, bool paid, uint256 acceptance, uint256 rejection, string justificationCids)",
  "event PayoutSent(uint256 indexed bountyId, address indexed winner, uint256 amount)",
  "event CreatorApproved(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, uint256 amountPaid)",
  "event CreatorRefunded(uint256 indexed bountyId, address indexed creator, uint256 amountRefunded)",
  "event EthRefunded(uint256 indexed bountyId, uint256 indexed submissionId, uint256 amount)",
  "event RefundDeferred(uint256 indexed bountyId, uint256 indexed submissionId)",
  // Pull-payment ledger: a direct payout/refund that could not be delivered is credited
  // to `withdrawable[to]` and claimed via withdraw().
  "event PaymentDeferred(address indexed to, uint256 amount)",
  "event Withdrawn(address indexed account, uint256 amount)"
];

// Verdikta Aggregator ABI (for checking evaluation results + force-fail gating)
const VERDIKTA_AGGREGATOR_ABI = [
  "function getEvaluation(bytes32 aggId) view returns (uint256[] memory scores, string justificationCids, bool ok)",
  "function getAggregationStatus(bytes32 aggId) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function maxOracleFee() view returns (uint256)",
  "function maxTotalFee(uint256 maxFee) view returns (uint256)"
];

/**
 * Normalize the `oracle` member of a getBounty() tuple into the serializable shape
 * persisted on job records and returned by GET /api/jobs/:id (`oracleSettings`).
 * Wei values are strings (BigInt-safe); alpha / scaling are plain integers.
 */
function normalizeOracleSettings(oracle) {
  if (!oracle) return null;
  try {
    return {
      maxOracleFee: oracle.maxOracleFee.toString(),
      alpha: Number(oracle.alpha),
      estimatedBaseCost: oracle.estimatedBaseCost.toString(),
      maxFeeBasedScaling: Number(oracle.maxFeeBasedScaling)
    };
  } catch {
    return null;
  }
}

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

// Gas guidance for the two "resolve" calls (finalizeSubmission / failTimedOutSubmission).
// See ContractService.estimateResolveGas for why 300k is NOT enough: settling a timed-out
// 6-oracle round inside the call costs ~2M gas (measured 1.97M on Base mainnet).
const RESOLVE_GAS_LIMIT_FALLBACK = 2_500_000n;
const RESOLVE_GAS_LIMIT_MIN = 300_000n;
const RESOLVE_GAS_MARGIN_PCT = 25n;
const RESOLVE_GAS_NOTE = 'finalizeSubmission and failTimedOutSubmission may need >2M gas: when the oracle round has timed out they settle it on the aggregator (per-oracle penalties + prepay refund) inside a try/catch. With a smaller limit that inner call runs out of gas, the catch swallows it, and the tx fails with no revert reason (gasUsed == gasLimit) even though eth_call/estimateGas pass. Use this gasLimit or your own estimateGas + margin; never hard-code a lower value.';

class ContractService {
  constructor(providerUrl, contractAddress) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.contract = new ethers.Contract(contractAddress, BOUNTY_ESCROW_ABI, this.provider);
    this.contractAddress = contractAddress;
    this.verdiktaAggregator = null; // Lazy-loaded
    this.verdiktaAggregatorAddress = null;
    this._iface = new ethers.Interface(BOUNTY_ESCROW_ABI);
    // responseTimeoutSeconds is an aggregator constant (300 s) — read once.
    this._responseTimeoutSeconds = null;
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
        // Try to decode custom error from the aggregator contract
        let decoded = null;
        if (error.data) {
          try {
            const agg = await this.getVerdiktaAggregator();
            const parsed = agg.interface.parseError(error.data);
            if (parsed) {
              const args = parsed.args.length ? `(${parsed.args.join(', ')})` : '';
              decoded = parsed.name + args;
            }
          } catch {}
        }
        return { ready: false, reason: decoded || 'call_exception' };
      }
      logger.warn('Error in getEvaluationByAggId', { verdiktaAggId, msg: error.message });
      return { ready: false, error: error.message };
    }
  }

  /**
   * The aggregator's response timeout (seconds after startPreparedSubmission at
   * which an unanswered round is considered timed out). Cached after first read.
   */
  async getResponseTimeoutSeconds() {
    if (this._responseTimeoutSeconds == null) {
      const aggregator = await this.getVerdiktaAggregator();
      this._responseTimeoutSeconds = Number(await aggregator.responseTimeoutSeconds());
    }
    return this._responseTimeoutSeconds;
  }

  /**
   * Gas limit for a resolve call (finalizeSubmission / failTimedOutSubmission).
   *
   * WHY THIS EXISTS: both calls try `verdikta.finalizeEvaluationTimeout(aggId)` inside a
   * try/catch before checking the round. When the round has timed out that inner call
   * settles it — timeout penalties for every selected oracle plus the prepay refund —
   * and costs ~2M gas on a 6-oracle round. If the caller hard-codes a smaller limit the
   * inner call runs out of gas, the catch swallows it, and the outer call dies too (no
   * revert reason, gasUsed == gasLimit). eth_call / estimateGas pass because they are
   * not capped, so an agent sees "simulation OK, tx reverts every time". Bounties 56/57
   * on Base mainnet (2026-09-16) were stuck exactly this way at 800k / 1M / 1.5M.
   *
   * Returns { gasLimit (string), estimatedGas (string|null), source: 'estimate'|'fallback',
   * reason? } — estimate + margin when the node can simulate the call, otherwise the
   * RESOLVE_GAS_LIMIT_FALLBACK (which covers the settle path). Never throws.
   */
  async estimateResolveGas({ data, value = 0n, from } = {}, { timeoutMs = 8000 } = {}) {
    const fallback = { gasLimit: RESOLVE_GAS_LIMIT_FALLBACK.toString(), estimatedGas: null, source: 'fallback' };
    if (!data) return { ...fallback, reason: 'no calldata' };
    try {
      const tx = { to: this.contractAddress, data, value };
      if (from && ethers.isAddress(from)) tx.from = from;
      const estimated = await Promise.race([
        this.provider.estimateGas(tx),
        new Promise((_, rej) => setTimeout(() => rej(new Error('estimateGas timed out')), timeoutMs))
      ]);
      const withMargin = (BigInt(estimated) * (100n + RESOLVE_GAS_MARGIN_PCT)) / 100n;
      const gasLimit = withMargin > RESOLVE_GAS_LIMIT_MIN ? withMargin : RESOLVE_GAS_LIMIT_MIN;
      return { gasLimit: gasLimit.toString(), estimatedGas: BigInt(estimated).toString(), source: 'estimate' };
    } catch (err) {
      // A revert here ("Verdikta not ready", "evaluation not settled", …) or an RPC
      // hiccup: hand back the safe fallback and say why — the caller's own gate decides
      // whether the tx is callable at all.
      return { ...fallback, reason: err.reason || err.shortMessage || err.message };
    }
  }

  /**
   * Force-fail gate — mirrors BountyEscrow.failTimedOutSubmission, which has NO
   * local timer. A PendingVerdikta submission can be force-failed iff:
   *   getEvaluation(aggId).exists === false
   *   AND (getAggregationStatus(aggId).isComplete === true
   *        OR now >= startTimestamp + responseTimeoutSeconds)
   * If a result exists the caller must finalizeSubmission instead.
   *
   * Returns:
   *   { eligible, hasResult, settled, isComplete, startTimestamp,
   *     responseTimeoutSeconds, timeoutAt, secondsUntilTimeout, reason, hint }
   * Never throws for a missing/zero aggId (eligible:false, reason:'no_agg_id');
   * RPC failures are reported as { eligible:false, reason:'rpc_error', error }.
   */
  async getForceFailEligibility(verdiktaAggId) {
    if (!verdiktaAggId || verdiktaAggId === ethers.ZeroHash) {
      return {
        eligible: false, hasResult: false, settled: false, reason: 'no_agg_id',
        hint: 'The submission has no aggregator round (it was never started).'
      };
    }
    try {
      const aggregator = await this.getVerdiktaAggregator();
      const [evalRes, statusRes, responseTimeoutSeconds] = await Promise.all([
        aggregator.getEvaluation(verdiktaAggId).then(r => ({ ok: Boolean(r[2]) })).catch(err => {
          // CALL_EXCEPTION = no evaluation record → no result
          if (err.code === 'CALL_EXCEPTION') return { ok: false };
          throw err;
        }),
        aggregator.getAggregationStatus(verdiktaAggId),
        this.getResponseTimeoutSeconds()
      ]);

      const hasResult = evalRes.ok;
      const isComplete = Boolean(statusRes.isComplete);
      const failed = Boolean(statusRes.failed);
      const startTimestamp = Number(statusRes.startTimestamp);
      const now = Math.floor(Date.now() / 1000);
      const timeoutAt = startTimestamp > 0 ? startTimestamp + responseTimeoutSeconds : null;
      const timedOut = timeoutAt != null && now >= timeoutAt;
      const settled = isComplete || timedOut;
      const secondsUntilTimeout = timeoutAt != null ? Math.max(0, timeoutAt - now) : null;

      let eligible = false;
      let reason;
      let hint;
      if (hasResult) {
        reason = 'result_available';
        hint = 'The oracle produced a result — call finalizeSubmission (POST /finalize) instead. failTimedOutSubmission reverts with "result available - use finalizeSubmission".';
      } else if (startTimestamp === 0) {
        reason = 'unknown_aggregation';
        hint = 'The aggregator has no record of this round.';
      } else if (!settled) {
        reason = 'not_settled';
        hint = `The aggregator round is still open; it times out ${responseTimeoutSeconds}s after start (at unix ${timeoutAt}, in ${secondsUntilTimeout}s). failTimedOutSubmission reverts with "evaluation not settled" until then.`;
      } else {
        eligible = true;
        reason = isComplete ? 'settled_no_result' : 'timed_out_no_result';
        hint = 'The round is settled with no result — failTimedOutSubmission will succeed and refund the unspent prepay.';
      }

      return {
        eligible, hasResult, settled, isComplete, failed,
        startTimestamp, responseTimeoutSeconds, timeoutAt, secondsUntilTimeout,
        reason, hint
      };
    } catch (error) {
      logger.warn('getForceFailEligibility failed', { verdiktaAggId, msg: error.message });
      return {
        eligible: false, hasResult: false, settled: false, reason: 'rpc_error',
        error: error.message,
        hint: 'Could not read the aggregator state; retry shortly.'
      };
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
        // Funded amount (max of the two determination payments), NOT the live
        // payoutWei, which the contract zeroes after payout/refund.
        bountyAmount: ethers.formatEther(fundedBountyWei(bounty)),
        bountyAmountWei: fundedBountyWei(bounty).toString(),
        // Live escrow balance (raw payoutWei): what the contract still holds.
        escrowWei: bounty.payoutWei.toString(),
        createdAt: Number(bounty.createdAt),
        submissionCloseTime: Number(bounty.submissionDeadline),
        status: effectiveStatus,
        winner: bounty.winner === ethers.ZeroAddress ? null : bounty.winner,
        submissionCount: Number(bounty.submissions),
        targetHunter: bounty.targetHunter === ethers.ZeroAddress ? null : bounty.targetHunter,
        creatorDeterminationPayment: ethers.formatEther(bounty.creatorDeterminationPayment),
        arbiterDeterminationPayment: ethers.formatEther(bounty.arbiterDeterminationPayment),
        creatorAssessmentWindowSize: Number(bounty.creatorAssessmentWindowSize),
        oracleSettings: normalizeOracleSettings(bounty.oracle),
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
        // Funded amount (max of the two determination payments), NOT the live
        // payoutWei, which the contract zeroes after payout/refund.
        bountyAmount: ethers.formatEther(fundedBountyWei(bounty)),
        bountyAmountWei: fundedBountyWei(bounty).toString(),
        // Live escrow balance (raw payoutWei): what the contract still holds.
        escrowWei: bounty.payoutWei.toString(),
        createdAt: Number(bounty.createdAt),
        submissionCloseTime: Number(bounty.submissionDeadline),
        status: effectiveStatus,
        winner: bounty.winner === ethers.ZeroAddress ? null : bounty.winner,
        submissionCount: Number(bounty.submissions),
        targetHunter: bounty.targetHunter === ethers.ZeroAddress ? null : bounty.targetHunter,
        creatorDeterminationPayment: ethers.formatEther(bounty.creatorDeterminationPayment),
        arbiterDeterminationPayment: ethers.formatEther(bounty.arbiterDeterminationPayment),
        creatorAssessmentWindowSize: Number(bounty.creatorAssessmentWindowSize),
        oracleSettings: normalizeOracleSettings(bounty.oracle),
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
          const statusMap = ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid', 'PendingCreatorApproval'];

          submissions.push({
            submissionId: i,
            hunter: sub.hunter,
            hunterCid: sub.hunterCid,
            evalWallet: sub.evalWallet,
            verdiktaAggId: sub.verdiktaAggId,
            status: statusMap[sub.status] || 'UNKNOWN',
            acceptance: Number(sub.acceptance),
            rejection: Number(sub.rejection),
            // Not stored on-chain (v0.5.0): the sync service records the CIDs from the
            // SubmissionFinalized event / the aggregator (getEvaluationByAggId). Empty here.
            justificationCids: '',
            submittedAt: Number(sub.submittedAt),
            finalizedAt: Number(sub.finalizedAt),
            ethMaxBudget: sub.ethMaxBudget.toString(),
            score: sub.acceptance > 0 ? Number(sub.acceptance) : null,
            creatorWindowEnd: Number(sub.creatorWindowEnd),
            // Who attached the prepay at start (receives the unspent refund);
            // ZeroAddress until startPreparedSubmission.
            funder: sub.funder === ethers.ZeroAddress ? null : sub.funder,
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
  RESOLVE_GAS_LIMIT_FALLBACK,
  RESOLVE_GAS_NOTE,
  getContractService,
  ContractService,
  normalizeOracleSettings,
  BOUNTY_ESCROW_ABI
};
