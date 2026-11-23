/**
 * Contract Service
 * Reads bounty data from deployed BountyEscrow smart contract
 *
 * Optimized for event-based sync: getBounty() uses 1 RPC call (not 4),
 * getEventsSince() fetches all events with one eth_getLogs call per 10K blocks,
 * getEvaluationByAggId() skips the redundant getSubmission() call.
 */

const { ethers } = require('ethers');
const { fundedBountyWei } = require('./bountyAmounts');
const { AGGREGATOR_ABI, PHASES, OUTCOMES, SUBMISSION_STATUSES } = require('./aggregatorAbi');
const logger = require('./logger');

// Largest block range per eth_getLogs call (Infura and public Base RPCs reject more).
const GET_LOGS_MAX_BLOCKS = 10_000;

// BountyEscrow ABI: the merged escrow + lens ABI generated from the contracts
// (onchain/abi/BountyEscrow.json, scripts/build-merged-abi.js). One source for every tuple, so a
// struct change can't leave a hand-written copy behind.
const rawEscrowAbi = require('../../onchain/abi/BountyEscrow.json');
const BOUNTY_ESCROW_ABI = rawEscrowAbi.abi || rawEscrowAbi;

// The v2 aggregator (see aggregatorAbi.js). Each bounty's rounds run on the aggregator its jury
// names (BountyEscrow.aggregatorOf).
const VERDIKTA_AGGREGATOR_ABI = AGGREGATOR_ABI;

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
      maxFeeBasedScaling: Number(oracle.maxFeeBasedScaling),
      // v2: the creator's fee floor (item 8) and beacon flag (item 9)
      minOracleFee: (oracle.minOracleFee ?? 0n).toString(),
      withBeacons: Boolean(oracle.withBeacons)
    };
  } catch {
    return null;
  }
}

/**
 * The v2 decision settings of a getBounty() tuple: the jury (approved aggregator index), item 12's
 * pass quota Q and forfeit line R, and the hunter bond (wei string).
 */
function normalizeDecisionSettings(bounty) {
  try {
    return {
      jury: Number(bounty.jury),
      quota: Number(bounty.quota),
      forfeitLine: Number(bounty.forfeitLine),
      bondWei: (bounty.bond ?? 0n).toString()
    };
  } catch {
    return null;
  }
}

/**
 * The aggregated scores as percentages: [DONT_FUND, FUND] or a one-number [FUND].
 * Returns { acceptance, rejection } on 0..100 (rejection = 100 - acceptance for one number).
 */
function scoresToPercent(aggregated) {
  const v = (aggregated || []).map((x) => Number(x));
  if (v.length === 2) return { acceptance: v[1] / 10000, rejection: v[0] / 10000 };
  if (v.length === 1) return { acceptance: v[0] / 10000, rejection: 100 - v[0] / 10000 };
  return null;
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

// Gas guidance for the "resolve" calls (finalizeSubmission / closeFailedRound / rerunSubmission).
// See ContractService.estimateResolveGas for why 300k is NOT enough: closeFailedRound settles the
// round on the aggregator inside a try/catch (one keeper outcome per juror: up to ~1.6M gas at
// Jumbo's 50 jurors, measured on the v2 contracts), and finalize reads every counted score.
const RESOLVE_GAS_LIMIT_FALLBACK = 2_500_000n;
const RESOLVE_GAS_LIMIT_MIN = 300_000n;
const RESOLVE_GAS_MARGIN_PCT = 25n;
const RESOLVE_GAS_NOTE = 'closeFailedRound may need >1.5M gas: it settles the round on the aggregator (one outcome per juror, plus the prepay refund) inside a try/catch. With a smaller limit that inner call runs out of gas, the catch swallows it, and the tx fails with no revert reason (gasUsed == gasLimit) even though eth_call/estimateGas pass. Use this gasLimit or your own estimateGas + margin; never hard-code a lower value.';

class ContractService {
  constructor(providerUrl, contractAddress) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.contract = new ethers.Contract(contractAddress, BOUNTY_ESCROW_ABI, this.provider);
    this.contractAddress = contractAddress;
    this._iface = new ethers.Interface(BOUNTY_ESCROW_ABI);
    // The escrow's approved aggregators never change; a bounty's jury never changes either.
    this._aggregatorAt = new Map();      // address (lowercase) -> Contract
    this._aggregatorOfBounty = new Map(); // bountyId -> address
    this._aggregatorList = null;
  }

  /** A v2 aggregator contract (read-only) at `address`, cached. */
  getAggregatorAt(address) {
    const key = String(address).toLowerCase();
    let c = this._aggregatorAt.get(key);
    if (!c) {
      c = new ethers.Contract(address, VERDIKTA_AGGREGATOR_ABI, this.provider);
      this._aggregatorAt.set(key, c);
    }
    return c;
  }

  /** The aggregator a bounty's rounds run on (its jury's), cached. */
  async getAggregatorFor(bountyId) {
    const id = String(bountyId);
    let addr = this._aggregatorOfBounty.get(id);
    if (!addr) {
      addr = await this.contract.aggregatorOf(bountyId);
      this._aggregatorOfBounty.set(id, addr);
    }
    return this.getAggregatorAt(addr);
  }

  /** The escrow's approved aggregators, in jury order (fixed at deployment), cached. */
  async getAggregators() {
    if (!this._aggregatorList) {
      const n = Number(await this.contract.aggregatorCount());
      const list = [];
      for (let i = 0; i < n; i++) list.push(await this.contract.aggregators(i));
      this._aggregatorList = list;
    }
    return this._aggregatorList;
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
   * No topic filter (gets all events from contract). Returns array of
   * { name, args, blockNumber, transactionHash } in block order.
   *
   * RPCs cap eth_getLogs at 10,000 blocks, so a longer range (the sync fell
   * behind: an outage, or Base Sepolia's 0.2 s blocks, where 10K blocks is only
   * ~33 min) is fetched in 10K-block chunks. Without this, a gap over 10K blocks
   * failed every cycle and grew, so the sync never caught up.
   *
   * Retries with exponential backoff on rate-limit (429) or server errors.
   */
  async getEventsSince(fromBlock, toBlock) {
    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += GET_LOGS_MAX_BLOCKS) {
      const end = Math.min(toBlock, start + GET_LOGS_MAX_BLOCKS - 1);
      logs.push(...await this._getLogsWithRetry({ address: this.contractAddress, fromBlock: start, toBlock: end }));
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

  async _getLogsWithRetry(filter) {
    const { fromBlock, toBlock } = filter;
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
    return logs;
  }

  // ---------------------------------------------------------------------------
  // Evaluation checks
  // ---------------------------------------------------------------------------

  /**
   * A submission's current round, as the escrow's lens reports it — 2 RPC calls, no aggregator ABI:
   * getOracleResult (the round's phase, result and item 12's Q-of-N outcome, judged by the
   * contract's own rule) and nextAction (the call that will succeed now).
   *
   * Returns { started, hasResult, phase, phaseName, outcome ('not_ready' | 'no_result' | 'pass' |
   * 'soft_fail' | 'hard_fail'), passCount, rounds, deadline, requestTime, scores ({ acceptance,
   * rejection } percentages, or null), justificationCids, nextAction }, or { error } on an RPC
   * failure. Never throws.
   */
  async getRoundState(bountyId, submissionId) {
    try {
      const [r, nextAction] = await Promise.all([
        this.contract.getOracleResult(bountyId, submissionId),
        this.contract.nextAction(bountyId, submissionId)
      ]);
      const phase = Number(r.phase);
      return {
        started: Boolean(r.started),
        hasResult: Boolean(r.hasResult),
        phase,
        phaseName: PHASES[phase] || 'unknown',
        outcome: OUTCOMES[Number(r.outcome)] || 'unknown',
        passCount: Number(r.passCount),
        rounds: Number(r.rounds),
        deadline: Number(r.deadline),
        requestTime: Number(r.requestTime),
        scores: r.hasResult ? scoresToPercent(r.scores) : null,
        justificationCids: r.justificationCids || '',
        nextAction
      };
    } catch (error) {
      logger.warn('getRoundState failed', { bountyId, submissionId, msg: error.message });
      return { error: error.message };
    }
  }

  /**
   * Gas limit for a resolve call (finalizeSubmission / closeFailedRound / expireRerun).
   *
   * WHY THIS EXISTS: these calls may settle the aggregator round inside a try/catch
   * (closeFailedRound tries settle, then cancelUnsealed; finalize reads every arbiter's
   * scores). Settling pays or penalizes every drawn juror and refunds the prepay, which costs
   * well over 1.5M gas on a large jury. If the caller hard-codes a smaller limit the inner
   * call runs out of gas, the catch swallows it, and the outer call dies too (no revert
   * reason, gasUsed == gasLimit). eth_call / estimateGas pass because they are not capped,
   * so an agent sees "simulation OK, tx reverts every time". (v1: bounties 56/57 on Base
   * mainnet, 2026-09-16, were stuck exactly this way at 800k / 1M / 1.5M.)
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
   * Close-failed gate — mirrors BountyEscrow.closeFailedRound, whose gate is the aggregator's state:
   * the round has no result and can get none (failed or cancelled, a drawn round past its deadline,
   * or an undrawn one past the draw's 1-day limit). The lens's nextAction says CLOSE_FAILED exactly
   * then. A round with a result goes through finalizeSubmission.
   *
   * Returns { eligible, hasResult, phase, phaseName, deadline, secondsUntilDeadline, nextAction,
   * reason, hint }. Never throws; RPC failures are { eligible:false, reason:'rpc_error', error }.
   */
  async getCloseFailedEligibility(bountyId, submissionId) {
    const st = await this.getRoundState(bountyId, submissionId);
    if (st.error) {
      return {
        eligible: false, hasResult: false, reason: 'rpc_error', error: st.error,
        hint: 'Could not read the round state; retry shortly.'
      };
    }
    const now = Math.floor(Date.now() / 1000);
    const base = {
      hasResult: st.hasResult, phase: st.phase, phaseName: st.phaseName, deadline: st.deadline || null,
      secondsUntilDeadline: st.deadline ? Math.max(0, st.deadline - now) : null, nextAction: st.nextAction
    };
    if (!st.started) {
      return { ...base, eligible: false, reason: 'no_agg_id', hint: 'The submission has no aggregator round (it was never started).' };
    }
    if (st.hasResult) {
      return { ...base, eligible: false, reason: 'result_available',
        hint: 'The round has a result — call finalizeSubmission (POST /finalize) instead. closeFailedRound reverts with "result available - use finalizeSubmission".' };
    }
    if (st.nextAction === 'CLOSE_FAILED') {
      return { ...base, eligible: true, reason: st.phase === 8 ? 'failed' : st.phase === 9 ? 'cancelled' : 'dead',
        hint: 'The round has no result and can get none — closeFailedRound will settle or cancel it, refund what is left of the prepay, and let the submission re-run (it keeps its place and bond).' };
    }
    const waiting = {
      DRAW: 'The round is not drawn yet: drawJury (anyone, through the escrow) moves it on.',
      CLOSE_COMMITS: 'The commit window can be closed: closeCommits on the aggregator moves it on.',
      PROMOTE: 'The commit phase is closed: promote on the aggregator moves it on.',
    }[st.nextAction];
    return { ...base, eligible: false, reason: 'round_open',
      hint: waiting || (st.deadline
        ? `The round is still open; its deadline is unix ${st.deadline} (in ${base.secondsUntilDeadline}s). closeFailedRound reverts with "round still open" until then.`
        : 'The round is still open (an undrawn round never times out; it can be cancelled a day after its request).') };
  }

  /**
   * Check if evaluation results are ready for a submission (the lens's view of its current round).
   * @returns { ready, outcome, passCount, scores?: { acceptance, rejection }, justificationCids?,
   *   phase, nextAction } — `ready` when the round has a result; `outcome` is item 12's verdict.
   */
  async checkEvaluationReady(bountyId, submissionId) {
    const st = await this.getRoundState(bountyId, submissionId);
    if (st.error) return { ready: false, error: st.error };
    if (!st.started) return { ready: false, reason: 'no_agg_id' };
    if (!st.hasResult) {
      return { ready: false, reason: st.outcome === 'no_result' ? 'no_result' : 'not_ready',
        phase: st.phase, phaseName: st.phaseName, outcome: st.outcome, nextAction: st.nextAction };
    }
    return {
      ready: true,
      outcome: st.outcome,
      passCount: st.passCount,
      scores: st.scores || { acceptance: 0, rejection: 0 },
      justificationCids: st.justificationCids,
      phase: st.phase,
      phaseName: st.phaseName,
      nextAction: st.nextAction
    };
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
        decisionSettings: normalizeDecisionSettings(bounty),
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
        decisionSettings: normalizeDecisionSettings(bounty),
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
          const statusMap = SUBMISSION_STATUSES;

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
            // Who funded the current round (receives its unspent refund);
            // ZeroAddress until startPreparedSubmission.
            funder: sub.funder === ethers.ZeroAddress ? null : sub.funder,
            // v2 (item 12): the bond, the rounds run, the last pass count, the re-run deadline
            bondFunder: sub.bondFunder === ethers.ZeroAddress ? null : sub.bondFunder,
            bondHeldWei: (sub.bondHeld ?? 0n).toString(),
            rounds: Number(sub.rounds ?? 0),
            passCount: Number(sub.passCount ?? 0),
            rerunDeadline: Number(sub.rerunDeadline ?? 0),
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
  normalizeDecisionSettings,
  scoresToPercent,
  BOUNTY_ESCROW_ABI,
  VERDIKTA_AGGREGATOR_ABI
};
