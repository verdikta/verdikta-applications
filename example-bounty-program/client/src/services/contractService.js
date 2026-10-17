/**
 * Frontend Contract Service (OPTIMIZED)
 * Handles WRITE-ONLY smart contract interactions via MetaMask
 *
 * PERFORMANCE OPTIMIZATIONS:
 * - Singleton provider/signer instances (avoid repeated MetaMask connections)
 * - Cached contract instances
 * - Debounced RPC calls
 * - Reduced polling frequency
 * - Connection state management
 *
 * IMPORTANT: This service is for USER TRANSACTIONS ONLY (writing to blockchain)
 * For READING job data, use apiService.getJob() which reads from backend cache
 */

import { ethers } from 'ethers';
import { config, currentNetwork } from '../config';
import { selectInjectedProvider, withTimeout, CONNECT_TIMEOUT_MS } from './injectedProvider';

// BountyEscrow ABI - only the functions we need to call
// (September 2026 revision: struct createBounty, 3-arg prepareSubmission, per-bounty
// oracle settings in getBounty().oracle, `funder` on getSubmission, `paid` on
// SubmissionFinalized, ethMaxBudget before the string in SubmissionPrepared.)
const BOUNTY_ESCROW_ABI = [
  // Events
  "event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)",
  "event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, uint256 ethMaxBudget, string evaluationCid)",
  "event SubmissionFinalized(uint256 indexed bountyId, uint256 indexed submissionId, bool passed, bool paid, uint256 acceptance, uint256 rejection, string justificationCids)",
  "event PaymentDeferred(address indexed to, uint256 amount)",
  "event RefundDeferred(uint256 indexed bountyId, uint256 indexed submissionId)",

  // Write Functions
  "function createBounty((string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, (uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) oracle) p) payable returns (uint256 bountyId)",
  "function prepareSubmission(uint256 bountyId, string evaluationCid, string hunterCid) returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget)",
  "function startPreparedSubmission(uint256 bountyId, uint256 submissionId) payable",
  "function finalizeSubmission(uint256 bountyId, uint256 submissionId)",
  "function failTimedOutSubmission(uint256 bountyId, uint256 submissionId)",
  "function closeExpiredBounty(uint256 bountyId)",
  "function creatorApproveSubmission(uint256 bountyId, uint256 submissionId)",
  "function withdraw()",
  "function recoverLeftoverEth(uint256 bountyId, uint256 submissionId)",

  // View Functions (used sparingly)
  "function getEffectiveBountyStatus(uint256) view returns (string)",
  "function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, uint256 submittedAt, uint256 finalizedAt, uint256 ethMaxBudget, uint64 creatorWindowEnd, address funder))",
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, tuple(uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) oracle))",
  "function verdikta() view returns (address)",
  "function withdrawable(address) view returns (uint256)",
  "function canBeClosed(uint256 bountyId) view returns (bool)",
  "function requiredPrepay(uint256 bountyId) view returns (uint256)",
  "function effectiveOracleParams(uint256 bountyId) view returns (tuple(uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling))",
  "function getSubmissions(uint256 bountyId) view returns (tuple(address hunter, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, uint256 submittedAt, uint256 finalizedAt, uint256 ethMaxBudget, uint64 creatorWindowEnd, address funder)[])",
  "function getBounties(uint256 start, uint256 count) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, tuple(uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) oracle)[])",
  "function getOracleResult(uint256 bountyId, uint256 submissionId) view returns (bool started, bool hasResult, bool settled, bool failed, uint256[] scores, string justificationCids, uint256 startTimestamp)",
  "function nextAction(uint256 bountyId, uint256 submissionId) view returns (string)",
  "function prepareCutoff(uint256 bountyId) view returns (uint256)",
  "function MAX_BATCH() view returns (uint256)",
  "function activeEvaluations(uint256) view returns (uint256)"
];

// Verdikta aggregator views used for oracle results and force-fail gating.
// getEvaluation takes bytes32 (NOT uint256) and returns (uint256[], string, bool).
const VERDIKTA_AGGREGATOR_ABI = [
  "function getEvaluation(bytes32 aggId) view returns (uint256[] memory scores, string justificationCids, bool ok)",
  "function getAggregationStatus(bytes32 aggId) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function maxOracleFee() view returns (uint256)"
];

// Contract bounds for creator oracle settings (BountyEscrow MAX_ALPHA / MAX_FEE_SCALING_FACTOR).
export const ORACLE_MAX_ALPHA = 1000;
export const ORACLE_MAX_FEE_SCALING = 1000;
// Aggregator per-oracle fee ceiling (0.0004 ETH). Used as a static pre-check.
export const ORACLE_FEE_CEILING_WEI = ethers.parseEther('0.0004');

/**
 * Map a raw BountyEscrow revert string to a user-facing message.
 * Returns null when the reason is not recognised (caller rethrows the original).
 * Order matters: more specific phrases first.
 */
const REVERT_MESSAGES = [
  // Retryable, NOT a failure
  ['earlier submission pending', 'An earlier submission is still being evaluated; retry after it resolves (this is not a failure — your result is kept).'],
  ['evaluation slots full', 'This bounty already has the maximum number of evaluations in flight (256). A slot frees as soon as any of them resolves — retry in a few minutes (this is not a failure; your prepared submission is kept).'],
  ['earlier submission unresolved', 'An earlier submission must be resolved first (it is still in evaluation or in its approval window).'],
  // Force-fail / finalize routing
  ['result available - use finalizesubmission', 'The oracle produced a result for this submission — finalize it instead of force-failing.'],
  ['result available', 'The oracle produced a result for this submission — finalize it instead of force-failing.'],
  ['evaluation not settled', 'The aggregator round is still open (it times out about 5 minutes after the evaluation started). Wait for it to settle, or finalize if the oracle responds.'],
  ['verdikta not ready', 'The oracle has not completed this evaluation yet — please wait.'],
  ['another submission already passed', 'Another submission already passed — finalize it first.'],
  // Windowed bounties
  ['window would end after deadline', 'The creator approval window would end after the bounty deadline — this bounty no longer accepts submissions.'],
  ['creator window still open', 'The creator approval window is still open.'],
  ['window expired', 'The creator approval window has expired.'],
  ['not pending creator approval', 'Submission is not pending creator approval.'],
  ['only creator', 'Only the bounty creator can approve submissions.'],
  // CIDs / limits
  ['bad huntercid', 'The submission CID must be a bare IPFS CID (46–100 letters and digits, no path or punctuation).'],
  ['bad evaluationcid', 'The evaluation package CID must be a bare IPFS CID (46–100 letters and digits, no path or punctuation).'],
  ['evaluationcid mismatch', 'The evaluation CID does not match the bounty\'s stored evaluation package.'],
  ['submission limit reached', 'This windowed bounty has reached its limit of 128 submissions (bounties without a creator window have no such limit).'],
  // Creator oracle settings
  ['oracle fee above ceiling', 'Max oracle fee is above the aggregator\'s ceiling (0.0004 ETH).'],
  ['bad oracle fee', 'Max oracle fee must be greater than 0.'],
  ['base cost must be below fee', 'Estimated base cost must be below the max oracle fee.'],
  ['bad fee scaling', 'Max fee-based scaling must be between 1 and 1000.'],
  ['bad alpha', 'Alpha must be between 0 and 1000.'],
  ['bad budget', 'The aggregator currently quotes a zero oracle prepay (its fee ceiling may be 0). Nothing to change on your side — wait, or report it.'],
  // Lifecycle
  ['deadline passed', 'The submission deadline has passed.'],
  ['deadline in past', 'Deadline must be in the future.'],
  ['deadline not passed', 'Cannot close yet - deadline has not passed.'],
  ['active evaluation', 'Cannot close - active evaluations in progress. Finalize them first.'],
  ['bounty not open', 'Bounty is not open.'],
  ['bounty is targeted', 'This bounty is targeted at a specific hunter address.'],
  ['wrong eth amount', 'Incorrect ETH amount for the evaluation prepay.'],
  ['only hunter', 'Only the submitting hunter can start this evaluation.'],
  ['already started or resolved', 'This submission has already been started (or is already resolved) — nothing to start.'],
  ['not pending', 'This submission is not in evaluation — it was never started, or it has already been resolved. Check nextAction.'],
  ['no oracle result', 'The oracle round ended without a result — use "Fail timed-out submission" (failTimedOutSubmission) instead of finalizing.'],
  ['not resolved', 'The prepay can only be recovered once the submission has resolved (Failed / PassedPaid / PassedUnpaid).'],
  ['never started', 'This submission was never started, so it holds no oracle prepay to recover.'],
  ['nothing to recover', 'No unspent prepay is waiting for this submission.'],
  ['withdraw failed', 'Your wallet rejected the ETH transfer — withdraw from an address that can receive ETH.'],
  ['nothing to withdraw', 'Nothing is owed to this address on the pull ledger.'],
  ['unknown function', 'The contract has no such function — check the function name against the merged ABI.'],
  ['self only', 'lensDelegate is internal plumbing for the contract\'s read views and cannot be called directly.'],
  ['reentrant', 'Re-entrant call rejected.'],
  ['eth must equal max payment', 'The ETH sent must equal the larger of the creator and arbiter payments.'],
  ['window required when payments differ', 'Approval window is required when creator and arbiter payments differ.'],
  ['no creator payment', 'Creator approval payment must be > 0.'],
  ['no arbiter payment', 'Arbiter (oracle) payment must be > 0.'],
  ['bad threshold', 'Threshold must be 0..100.'],
  ['bad bountyid', 'That bounty does not exist on-chain.'],
  ['bad submissionid', 'That submission does not exist on-chain.'],
  ['nothing to withdraw', 'Nothing to withdraw for this address.'],
];

export function friendlyRevertMessage(rawMessage) {
  const msg = String(rawMessage || '').toLowerCase();
  if (!msg) return null;
  const compact = msg.replace(/\s+/g, '');
  for (const [needle, friendly] of REVERT_MESSAGES) {
    if (msg.includes(needle) || compact.includes(needle.replace(/\s+/g, ''))) return friendly;
  }
  return null;
}

/** Revert reasons that mean "retry later", not "the action failed". */
export function isRetryableRevert(rawMessage) {
  const msg = String(rawMessage || '').toLowerCase();
  return msg.includes('earlier submission pending') || msg.includes('verdikta not ready') ||
    msg.includes('evaluation not settled') || msg.includes('evaluation slots full');
}

// ============================================================================
// PERFORMANCE: Debounce utility
// ============================================================================

const pendingCalls = new Map();

/**
 * Debounce identical RPC calls within a time window
 * Prevents hammering MetaMask with duplicate requests
 */
function debounceRpcCall(key, fn, windowMs = 500) {
  const now = Date.now();
  const pending = pendingCalls.get(key);
  
  if (pending && (now - pending.timestamp) < windowMs) {
    // Return cached promise if within debounce window
    return pending.promise;
  }
  
  const promise = fn();
  pendingCalls.set(key, { promise, timestamp: now });
  
  // Clean up after resolution
  promise.finally(() => {
    setTimeout(() => {
      const current = pendingCalls.get(key);
      if (current && current.promise === promise) {
        pendingCalls.delete(key);
      }
    }, windowMs);
  });
  
  return promise;
}

// ============================================================================
// CONTRACT SERVICE CLASS
// ============================================================================

class ContractService {
  constructor(contractAddress) {
    this.contractAddress = contractAddress;
    
    // Singleton instances - created once, reused
    this.provider = null;
    this.signer = null;
    this.contract = null;
    this.userAddress = null;
    
    // Cached contract instances
    this._readOnlyProvider = null;
    
    // Connection state
    this._connecting = false;
    this._connectionPromise = null;
    
    // Cache for expensive reads
    this._statusCache = new Map();
    this._statusCacheTTL = 5000; // 5 seconds

    // Aggregator (read-only) + its constant response timeout
    this._aggregator = null;
    this._responseTimeoutSeconds = null;
  }

  // ==========================================================================
  // ERROR DECODING HELPER
  // ==========================================================================

  /**
   * Try to extract a human-readable revert reason from an error.
   * Handles both custom Solidity errors (parseError) and legacy string requires.
   * @param {Error} error - The caught error object
   * @param {ethers.Contract[]} contracts - Contract instances whose ABIs to try
   * @returns {string|null} Decoded error name/reason, or null if not decodable
   */
  _decodeRevertReason(error, contracts) {
    // Try custom error decoding first
    if (error.data) {
      for (const c of contracts) {
        try {
          const parsed = c.interface.parseError(error.data);
          if (parsed) {
            const args = parsed.args.length ? `(${parsed.args.join(', ')})` : '';
            return parsed.name + args;
          }
        } catch {}
      }
    }
    // Fall back to string reason or shortMessage
    return error.reason || error.shortMessage || null;
  }

  // ==========================================================================
  // PROVIDER MANAGEMENT (OPTIMIZED)
  // ==========================================================================

  /**
   * Get a read-only provider (doesn't prompt MetaMask)
   * Used for view calls that don't need signing
   */
  getReadOnlyProvider() {
    if (!this._readOnlyProvider) {
      // Prefer a public JSON-RPC provider so reads work without MetaMask.
      // BrowserProvider requires a connected/unlocked wallet — if MetaMask
      // is locked or absent, eth_call hangs forever, which freezes the UI.
      const rpcUrl = currentNetwork?.rpcUrl;
      if (rpcUrl) {
        this._readOnlyProvider = new ethers.JsonRpcProvider(rpcUrl, {
          chainId: currentNetwork.chainId,
          name: currentNetwork.name,
        });
      } else if (selectInjectedProvider()) {
        this._readOnlyProvider = new ethers.BrowserProvider(selectInjectedProvider());
      }
    }
    return this._readOnlyProvider;
  }

  /**
   * Connect to MetaMask and initialize contract
   * OPTIMIZED: Prevents duplicate connection attempts
   */
  async connect() {
    // Return existing connection if already connected
    if (this.contract && this.userAddress) {
      return {
        address: this.userAddress,
        chainId: (await this.provider.getNetwork()).chainId
      };
    }

    // Prevent duplicate concurrent connection attempts
    if (this._connecting && this._connectionPromise) {
      return this._connectionPromise;
    }

    this._connecting = true;
    this._connectionPromise = this._doConnect();
    
    try {
      return await this._connectionPromise;
    } finally {
      this._connecting = false;
      this._connectionPromise = null;
    }
  }

  async _doConnect() {
    // Same provider-selection logic as walletService (EIP-6963 first) so a
    // transaction never goes to a different wallet than the one in the header.
    const injected = selectInjectedProvider();
    if (!injected) {
      const err = new Error('No wallet extension detected. Please install MetaMask to continue.');
      err.code = 'VERDIKTA_NO_PROVIDER';
      throw err;
    }

    try {
      // Request account access (bounded so a stuck wallet surfaces as an error)
      await withTimeout(
        injected.request({ method: 'eth_requestAccounts' }),
        CONNECT_TIMEOUT_MS,
        'eth_requestAccounts'
      );

      // Create provider and signer (ONCE)
      this.provider = new ethers.BrowserProvider(injected);
      this.signer = await this.provider.getSigner();
      this.userAddress = await this.signer.getAddress();

      // Initialize main contract
      this.contract = new ethers.Contract(
        this.contractAddress,
        BOUNTY_ESCROW_ABI,
        this.signer
      );

      // Update read-only provider reference
      this._readOnlyProvider = this.provider;

      console.log('✅ Connected to MetaMask:', this.userAddress);

      return {
        address: this.userAddress,
        chainId: (await this.provider.getNetwork()).chainId
      };

    } catch (error) {
      console.error('Error connecting to MetaMask:', error);
      throw error;
    }
  }

  // ==========================================================================
  // WRITE OPERATIONS
  // ==========================================================================

  /**
   * Resolve + validate the creator oracle settings for createBounty's `oracle` struct.
   * Accepts wei strings/bigints (or decimal-ETH strings containing a '.') for the two
   * fee fields, integers for alpha / scaling. Defaults come from config.submissionDefaults.
   * Enforces the same bounds as the contract so a bad value fails before MetaMask opens.
   */
  static resolveOracleParams(oracle = {}) {
    const d = config.submissionDefaults;
    const toWei = (v, label) => {
      if (v === undefined || v === null || v === '') return null;
      const str = String(v).trim();
      try {
        return str.includes('.') ? ethers.parseEther(str) : BigInt(str);
      } catch {
        throw new Error(`${label} must be a decimal-ETH amount or an integer wei value`);
      }
    };
    const maxOracleFee = toWei(oracle.maxOracleFee, 'Max oracle fee') ?? BigInt(d.maxOracleFeeWei);
    const estimatedBaseCost = toWei(oracle.estimatedBaseCost, 'Estimated base cost') ?? BigInt(d.estimatedBaseCostWei);
    const alpha = oracle.alpha === undefined || oracle.alpha === null || oracle.alpha === '' ? Number(d.alpha) : Number(oracle.alpha);
    const maxFeeBasedScaling = oracle.maxFeeBasedScaling === undefined || oracle.maxFeeBasedScaling === null || oracle.maxFeeBasedScaling === ''
      ? Number(d.maxFeeBasedScaling) : Number(oracle.maxFeeBasedScaling);

    if (maxOracleFee <= 0n) throw new Error('Max oracle fee must be greater than 0');
    if (maxOracleFee > ORACLE_FEE_CEILING_WEI) throw new Error(`Max oracle fee is above the aggregator ceiling of ${ethers.formatEther(ORACLE_FEE_CEILING_WEI)} ETH`);
    if (estimatedBaseCost < 0n) throw new Error('Estimated base cost must be >= 0');
    if (estimatedBaseCost >= maxOracleFee) throw new Error('Estimated base cost must be below the max oracle fee');
    if (!Number.isInteger(maxFeeBasedScaling) || maxFeeBasedScaling < 1 || maxFeeBasedScaling > ORACLE_MAX_FEE_SCALING) {
      throw new Error(`Max fee-based scaling must be an integer between 1 and ${ORACLE_MAX_FEE_SCALING}`);
    }
    if (!Number.isInteger(alpha) || alpha < 0 || alpha > ORACLE_MAX_ALPHA) {
      throw new Error(`Alpha must be an integer between 0 and ${ORACLE_MAX_ALPHA}`);
    }
    return {
      maxOracleFee,
      alpha: BigInt(alpha),
      estimatedBaseCost,
      maxFeeBasedScaling: BigInt(maxFeeBasedScaling)
    };
  }

  /**
   * Create a bounty on-chain via MetaMask.
   *
   * createBounty takes ONE CreateParams struct (no more 5/8-arg overloads).
   * msg.value == max(creatorDeterminationPayment, arbiterDeterminationPayment);
   * a non-windowed bounty passes both payments equal to the amount and window 0.
   * `oracle` (creator-chosen oracle request settings) is optional — defaults from
   * config.submissionDefaults: { maxOracleFee, alpha, estimatedBaseCost, maxFeeBasedScaling }.
   *
   * `onStep(step, data)` (optional) is told how far the create got: 'staticCall'
   * before the pre-check, 'send' before the wallet is asked to sign, 'wait' with
   * { txHash } once the wallet returned a hash. Errors keep the original in `cause`.
   */
  async createBounty({ evaluationCid, classId, threshold, bountyAmountEth, submissionWindowHours, targetHunter,
                       creatorDeterminationPaymentEth, arbiterDeterminationPaymentEth, creatorAssessmentWindowHours,
                       oracle, onStep }) {
    const step = (name, data) => { try { onStep?.(name, data); } catch { /* reporting never breaks the create */ } };
    if (!this.contract) throw new Error('Contract not initialized. Call connect() first.');

    // Quick UI validations
    if (!evaluationCid || typeof evaluationCid !== 'string') throw new Error('Evaluation CID is empty');
    if (!/^[A-Za-z0-9]{46,100}$/.test(evaluationCid)) throw new Error('Evaluation CID must be a bare IPFS CID (46–100 letters and digits)');
    const winHrs = Number(submissionWindowHours);
    if (!Number.isFinite(winHrs) || winHrs <= 0) throw new Error('Submission window (hours) must be > 0');
    const thrNum = Number(threshold);
    if (!Number.isFinite(thrNum) || thrNum < 0 || thrNum > 100) throw new Error('Threshold must be 0..100');
    const ethStr = String(bountyAmountEth);
    if (isNaN(Number(ethStr)) || Number(ethStr) <= 0) throw new Error('Payout amount (ETH) must be > 0');

    // Determine if this is a windowed bounty
    const hasApprovalWindow = creatorAssessmentWindowHours != null && Number(creatorAssessmentWindowHours) > 0;

    // Creator oracle settings (validated against contract bounds)
    const oracleParams = ContractService.resolveOracleParams(oracle || {});

    try {
      // Encode exact solidity widths
      const now = Math.floor(Date.now() / 1000);
      // Round (not truncate) to match the server's stored deadline exactly.
      const submissionDeadline = BigInt(now + Math.round(winHrs * 3600));
      const classId64 = BigInt(classId);
      const thresh8 = BigInt(thrNum);

      // Validate ranges
      const mask64 = (1n << 64n) - 1n;
      const mask8 = (1n << 8n) - 1n;
      if ((classId64 & ~mask64) !== 0n) throw new Error('classId exceeds uint64');
      if ((thresh8 & ~mask8) !== 0n) throw new Error('threshold exceeds uint8');

      const amountWei = ethers.parseEther(ethStr);
      let creatorPayWei, arbiterPayWei, windowSizeSec;
      if (hasApprovalWindow) {
        creatorPayWei = ethers.parseEther(String(creatorDeterminationPaymentEth));
        arbiterPayWei = ethers.parseEther(String(arbiterDeterminationPaymentEth));
        windowSizeSec = BigInt(Math.round(Number(creatorAssessmentWindowHours) * 3600));
      } else {
        // Non-windowed: both payments equal the escrowed amount, window 0.
        creatorPayWei = amountWei;
        arbiterPayWei = amountWei;
        windowSizeSec = 0n;
      }
      // Escrow = max(creatorPay, arbiterPay)
      const valueWei = creatorPayWei > arbiterPayWei ? creatorPayWei : arbiterPayWei;

      const params = {
        evaluationCid,
        requestedClass: classId64,
        threshold: thresh8,
        submissionDeadline,
        targetHunter: targetHunter || '0x0000000000000000000000000000000000000000',
        creatorDeterminationPayment: creatorPayWei,
        arbiterDeterminationPayment: arbiterPayWei,
        creatorAssessmentWindowSize: windowSizeSec,
        oracle: oracleParams
      };

      console.log(`🔍 createBounty${hasApprovalWindow ? ' (windowed)' : ''} params`, {
        evaluationCid: evaluationCid.substring(0, 20) + '...',
        requestedClass: classId64.toString(),
        threshold: thresh8.toString(),
        submissionDeadline: submissionDeadline.toString(),
        creatorPayWei: creatorPayWei.toString(),
        arbiterPayWei: arbiterPayWei.toString(),
        windowSizeSec: windowSizeSec.toString(),
        oracle: {
          maxOracleFee: oracleParams.maxOracleFee.toString(),
          alpha: oracleParams.alpha.toString(),
          estimatedBaseCost: oracleParams.estimatedBaseCost.toString(),
          maxFeeBasedScaling: oracleParams.maxFeeBasedScaling.toString()
        },
        valueWei: valueWei.toString()
      });

      const args = [params, { value: valueWei }];
      const callFn = this.contract.createBounty;

      // Dry-run to surface revert reasons
      step('staticCall');
      try {
        await callFn.staticCall(...args);
      } catch (e) {
        const decoded = this._decodeRevertReason(e, [this.contract]);
        const msg = (decoded || e?.message || '').toLowerCase();
        if (msg.includes('no eth') || msg.includes('noeth')) throw new Error('Bounty requires ETH value (msg.value > 0)', { cause: e });
        if (msg.includes('empty evaluationcid') || msg.includes('emptyevaluationcid')) throw new Error('Evaluation CID is empty', { cause: e });
        const friendly = friendlyRevertMessage(msg);
        if (friendly) throw new Error(friendly, { cause: e });
        throw e;
      }

      // Send the tx
      step('send');
      const tx = await callFn(...args);
      console.log('📤 Transaction sent:', tx.hash);
      step('wait', { txHash: tx.hash });

      const receipt = await tx.wait();
      console.log('✅ Transaction confirmed:', receipt.hash);

      // Parse bountyId from event
      let bountyId = null;
      for (const log of receipt.logs ?? []) {
        try {
          const parsed = this.contract.interface.parseLog(log);
          if (parsed?.name === 'BountyCreated') {
            bountyId = Number(parsed.args.bountyId);
            break;
          }
        } catch {}
      }

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        bountyId,
        gasUsed: receipt.gasUsed?.toString?.() ?? null
      };

    } catch (error) {
      console.error('Error creating bounty:', error);
      if (error.code === 'ACTION_REJECTED') {
        const rejected = new Error('Transaction rejected by user', { cause: error });
        rejected.code = 'ACTION_REJECTED';
        throw rejected;
      }
      throw error;
    }
  }

  /**
   * STEP 1: Prepare a submission (deploys EvaluationWallet)
   *
   * prepareSubmission(bountyId, evaluationCid, hunterCid) — the oracle request
   * settings (maxOracleFee, alpha, estimatedBaseCost, maxFeeBasedScaling) are chosen
   * by the bounty CREATOR at createBounty and applied by the contract with an empty
   * addendum; hunters supply only the two CIDs. Extra trailing arguments from the
   * legacy 8-arg form are accepted and ignored.
   * hunterCid must be a bare CID (46–100 alphanumeric chars) or the contract reverts
   * "bad hunterCid".
   */
  async prepareSubmission(bountyId, evaluationCid, hunterCid, ..._legacyIgnored) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }
    if (_legacyIgnored.length) {
      console.warn('prepareSubmission: ignoring legacy hunter-side oracle arguments (addendum/alpha/fee/baseCost/scaling); the bounty creator sets these at createBounty.');
    }
    if (!/^[A-Za-z0-9]{46,100}$/.test(String(hunterCid || ''))) {
      throw new Error('The submission CID must be a bare IPFS CID (46–100 letters and digits, no path or punctuation).');
    }

    try {
      console.log('🔍 Preparing submission...', {
        bountyId,
        evaluationCid: evaluationCid?.substring(0, 20) + '...',
        hunterCid: hunterCid?.substring(0, 20) + '...'
      });

      // Dry-run to surface revert reasons before prompting MetaMask
      try {
        await this.contract.prepareSubmission.staticCall(bountyId, evaluationCid, hunterCid);
      } catch (e) {
        const decoded = this._decodeRevertReason(e, [this.contract]);
        const friendly = friendlyRevertMessage(decoded || e?.message);
        if (friendly) throw new Error(friendly);
        throw e;
      }

      const tx = await this.contract.prepareSubmission(
        bountyId,
        evaluationCid,
        hunterCid
      );

      console.log('📤 Transaction sent:', tx.hash);
      const receipt = await tx.wait();
      console.log('✅ Submission prepared:', receipt.hash);

      // Parse SubmissionPrepared event
      let result = null;
      for (const log of receipt.logs ?? []) {
        try {
          const parsed = this.contract.interface.parseLog(log);
          if (parsed?.name === 'SubmissionPrepared') {
            result = {
              submissionId: Number(parsed.args.submissionId),
              evalWallet: parsed.args.evalWallet,
              ethMaxBudget: parsed.args.ethMaxBudget.toString(),
              txHash: receipt.hash
            };
            break;
          }
        } catch {}
      }

      if (!result) {
        throw new Error('Could not parse SubmissionPrepared event from transaction');
      }

      return result;

    } catch (error) {
      console.error('Error preparing submission:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }
      const friendly = friendlyRevertMessage(this._decodeRevertReason(error, [this.contract]) || error?.message);
      if (friendly) throw new Error(friendly);
      throw error;
    }
  }

  /**
   * STEP 2: Start the prepared submission (triggers Verdikta evaluation).
   *
   * Funds the oracle evaluation with ETH: msg.value must equal requiredPrepay(bountyId),
   * read live here (the ethMaxBudget from prepareSubmission is only an estimate). No ERC20
   * approval. Unspent prepay is refunded to the funder automatically at finalization.
   *
   * @param {string|number} bountyId
   * @param {string|number} submissionId
   * @param {string|bigint} [ethMaxBudget] - prepare-time estimate, used only if the live read fails
   */
  async startPreparedSubmission(bountyId, submissionId, ethMaxBudget) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    // The contract checks msg.value against the LIVE requirement for the bounty
    // (requiredPrepay = aggregator maxTotalFee for the bounty's fee, which can change if
    // aggregator parameters change). The prepare-time ethMaxBudget is only an estimate.
    let value;
    try {
      value = BigInt(await this.contract.requiredPrepay(bountyId));
      if (ethMaxBudget != null && BigInt(ethMaxBudget) !== value) {
        console.warn('Prepay requirement changed since prepare; using the live value', {
          estimate: ethers.formatEther(BigInt(ethMaxBudget)), live: ethers.formatEther(value)
        });
      }
    } catch (e) {
      if (ethMaxBudget == null) {
        throw new Error('Could not read the required prepay from the contract, and no estimate was provided');
      }
      console.warn('requiredPrepay read failed; using the prepare-time estimate', e.message);
      value = BigInt(ethMaxBudget);
    }

    try {
      console.log('🔍 Starting submission evaluation...', {
        bountyId, submissionId, valueEth: ethers.formatEther(value)
      });

      // Dry-run to surface revert reasons before prompting MetaMask
      try {
        await this.contract.startPreparedSubmission.staticCall(bountyId, submissionId, { value });
      } catch (e) {
        const decoded = this._decodeRevertReason(e, [this.contract]);
        const msg = (decoded || e?.message || '').toLowerCase();
        if (msg.includes('wrong eth amount')) throw new Error('Incorrect ETH amount for the evaluation prepay');
        if (msg.includes('only hunter')) throw new Error('Only the submitting hunter can start this evaluation');
        if (msg.includes('creator window still open')) throw new Error('The creator approval window is still open');
        if (msg.includes('already passed')) throw new Error('Another submission already passed — finalize it first');
        if (msg.includes('deadline passed')) throw new Error('The submission deadline has passed — evaluations can no longer be started for this bounty');
        // "evaluation slots full - retry later": the concurrency cap (MAX_ACTIVE_EVALUATIONS).
        // Handled by the table below; isRetryableRevert() reports it as retry-later.
        const friendly = friendlyRevertMessage(msg);
        if (friendly) throw new Error(friendly);
        throw e;
      }

      const tx = await this.contract.startPreparedSubmission(bountyId, submissionId, { value });
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Evaluation started:', receipt.hash);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error starting submission:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }
      throw error;
    }
  }

  /**
   * Finalize a submission - reads results from Verdikta
   */
  async finalizeSubmission(bountyId, submissionId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('🔍 Finalizing submission...', { bountyId, submissionId });

      // Dry-run to surface revert reasons before prompting MetaMask. "earlier
      // submission pending - retry after it resolves" is retryable, not a failure.
      try {
        await this.contract.finalizeSubmission.staticCall(bountyId, submissionId);
      } catch (e) {
        const decoded = this._decodeRevertReason(e, [this.contract]);
        const friendly = friendlyRevertMessage(decoded || e?.message);
        if (friendly) {
          const err = new Error(friendly);
          err.retryable = isRetryableRevert(decoded || e?.message);
          throw err;
        }
        throw e;
      }

      const tx = await this.contract.finalizeSubmission(bountyId, submissionId);
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Submission finalized:', receipt.hash);

      // Invalidate status cache
      this._statusCache.delete(`${bountyId}`);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error finalizing submission:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }
      if (error.retryable !== undefined) throw error;
      const friendly = friendlyRevertMessage(this._decodeRevertReason(error, [this.contract]) || error?.message);
      if (friendly) throw new Error(friendly);
      throw error;
    }
  }

  /**
   * Try to finalize a submission using a dry-run (staticCall) first.
   * If the dry-run passes, sends the real transaction.
   * If the dry-run reverts, returns structured failure info instead of prompting MetaMask.
   *
   * Returns: { success: true, txHash, ... }
   *       or { success: false, reason, canFallbackToTimeout? }
   */
  async tryFinalizeSubmission(bountyId, submissionId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      // Dry-run: staticCall to check if finalizeSubmission would succeed
      console.log(`🔍 Dry-run finalizeSubmission(${bountyId}, ${submissionId})...`);
      await this.contract.finalizeSubmission.staticCall(bountyId, submissionId);
    } catch (staticErr) {
      const decoded = this._decodeRevertReason(staticErr, [this.contract]);
      const msg = (decoded || staticErr?.message || '').toLowerCase();
      console.warn(`staticCall reverted for submission #${submissionId}:`, msg);

      if (msg.includes('not pending') || msg.includes('notpending') || msg.includes('not pendingverdikta')) {
        return { success: false, reason: 'already_terminal' };
      }
      // Windowed priority: an earlier submission is still being evaluated. Retryable —
      // NOT a failure and NOT a force-fail candidate (a result exists and is kept).
      if (msg.includes('earlier submission pending')) {
        return { success: false, reason: 'earlier_pending', retryable: true, canFallbackToTimeout: false,
                 message: friendlyRevertMessage(msg) };
      }
      // The round is settled with no result: finalize can never succeed — force-fail is the call.
      if (msg.includes('no oracle result')) {
        return { success: false, reason: 'oracle_no_result', canFallbackToTimeout: true,
                 message: friendlyRevertMessage(msg) };
      }
      if (msg.includes('verdikta') || msg.includes('not ready') || msg.includes('notready') || msg.includes('evaluation')) {
        // Oracle has no result yet. Whether force-fail is possible depends on the
        // aggregator state — callers must check getForceFailEligibility().
        return { success: false, reason: 'oracle_not_ready', canFallbackToTimeout: true };
      }
      // Unknown revert — still flag as potential timeout fallback
      return { success: false, reason: msg || 'unknown_revert', canFallbackToTimeout: true, message: friendlyRevertMessage(msg) };
    }

    // Dry-run passed — send the real transaction
    try {
      console.log(`📤 Sending finalizeSubmission(${bountyId}, ${submissionId})...`);
      const tx = await this.contract.finalizeSubmission(bountyId, submissionId);
      const receipt = await tx.wait();
      console.log(`✅ Submission #${submissionId} finalized:`, receipt.hash);

      this._statusCache.delete(`${bountyId}`);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed?.toString?.() ?? null,
      };
    } catch (txErr) {
      if (txErr.code === 'ACTION_REJECTED') {
        return { success: false, reason: 'user_rejected' };
      }
      throw txErr;
    }
  }

  /**
   * Force-fail a timed-out submission
   */
  async failTimedOutSubmission(bountyId, submissionId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('⏱️ Failing timed-out submission...', { bountyId, submissionId });

      // Dry-run: the contract has no timer — it reverts "result available - use
      // finalizeSubmission" when the oracle answered, and "evaluation not settled"
      // while the aggregator round is still open. Surface those before MetaMask.
      try {
        await this.contract.failTimedOutSubmission.staticCall(bountyId, submissionId);
      } catch (e) {
        const decoded = this._decodeRevertReason(e, [this.contract]);
        const friendly = friendlyRevertMessage(decoded || e?.message);
        if (friendly) {
          const err = new Error(friendly);
          const raw = String(decoded || e?.message || '').toLowerCase();
          err.shouldFinalize = raw.includes('result available');
          err.retryable = raw.includes('evaluation not settled');
          throw err;
        }
        throw e;
      }

      const tx = await this.contract.failTimedOutSubmission(bountyId, submissionId);
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Submission failed:', receipt.hash);

      // Invalidate status cache
      this._statusCache.delete(`${bountyId}`);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error failing timed-out submission:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }
      if (error.shouldFinalize !== undefined) throw error;
      const friendly = friendlyRevertMessage(this._decodeRevertReason(error, [this.contract]) || error?.message);
      if (friendly) throw new Error(friendly);
      throw error;
    }
  }

  /**
   * Claim ETH credited to the connected wallet on the escrow's pull-payment ledger
   * (a payout / refund whose direct delivery failed — see PaymentDeferred).
   */
  async withdraw() {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }
    try {
      const tx = await this.contract.withdraw();
      const receipt = await tx.wait();
      return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber };
    } catch (error) {
      if (error.code === 'ACTION_REJECTED') throw new Error('Transaction rejected by user');
      const friendly = friendlyRevertMessage(this._decodeRevertReason(error, [this.contract]) || error?.message);
      if (friendly) throw new Error(friendly);
      throw error;
    }
  }

  /**
   * Retry recovery of a resolved submission's unspent oracle prepay (after a resolving
   * tx emitted RefundDeferred). Anyone may call; the funder is paid.
   */
  async recoverLeftoverEth(bountyId, submissionId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }
    try {
      await this.contract.recoverLeftoverEth.staticCall(bountyId, submissionId);
      const tx = await this.contract.recoverLeftoverEth(bountyId, submissionId);
      const receipt = await tx.wait();
      return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber };
    } catch (error) {
      if (error.code === 'ACTION_REJECTED') throw new Error('Transaction rejected by user');
      const reason = this._decodeRevertReason(error, [this.contract]) || error?.message || '';
      if (/nothing to recover/i.test(reason)) throw new Error('Nothing to recover: the prepay for this submission has already been refunded.');
      if (/not resolved/i.test(reason)) throw new Error('This submission is still being evaluated; recovery is possible once it is finalized or force-failed.');
      const friendly = friendlyRevertMessage(reason);
      if (friendly) throw new Error(friendly);
      throw error;
    }
  }

  /**
   * Close an expired bounty and return funds to creator
   */
  async closeExpiredBounty(bountyId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('Closing expired bounty...', { bountyId });

      const tx = await this.contract.closeExpiredBounty(bountyId);
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Expired bounty closed:', receipt.hash);

      // Invalidate status cache
      this._statusCache.delete(`${bountyId}`);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error closing expired bounty:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }

      const decoded = this._decodeRevertReason(error, [this.contract]);
      const msg = (decoded || error?.message || '').toLowerCase();
      if (msg.includes('not open') || msg.includes('notopen')) {
        throw new Error('Bounty is not open - it may already be closed or awarded');
      }
      if (msg.includes('deadline not passed') || msg.includes('deadlinenotpassed')) {
        throw new Error('Cannot close yet - deadline has not passed');
      }
      if (msg.includes('active evaluation') || msg.includes('activeevaluation')) {
        throw new Error('Cannot close - active evaluations in progress. Finalize them first.');
      }
      const friendly = friendlyRevertMessage(msg);
      if (friendly) throw new Error(friendly);

      throw error;
    }
  }

  /**
   * Creator approves a submission during the approval window
   * Uses dry-run first to surface revert reasons before prompting MetaMask.
   */
  async creatorApproveSubmission(bountyId, submissionId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    try {
      console.log('🔍 Creator approving submission...', { bountyId, submissionId });

      // Dry-run to surface revert reasons
      try {
        await this.contract.creatorApproveSubmission.staticCall(bountyId, submissionId);
      } catch (e) {
        const decoded = this._decodeRevertReason(e, [this.contract]);
        const msg = (decoded || e?.message || '').toLowerCase();
        if (msg.includes('only creator')) throw new Error('Only the bounty creator can approve submissions');
        if (msg.includes('window expired')) throw new Error('The creator approval window has expired');
        if (msg.includes('not pending creator approval')) throw new Error('Submission is not pending creator approval');
        if (msg.includes('earlier submission unresolved')) throw new Error('An earlier submission must be resolved first (it is still in evaluation or in its approval window)');
        if (msg.includes('bounty not open')) throw new Error('Bounty is not open');
        const friendly = friendlyRevertMessage(msg);
        if (friendly) throw new Error(friendly);
        throw e;
      }

      const tx = await this.contract.creatorApproveSubmission(bountyId, submissionId);
      console.log('📤 Transaction sent:', tx.hash);

      const receipt = await tx.wait();
      console.log('✅ Submission approved by creator:', receipt.hash);

      // Invalidate status cache
      this._statusCache.delete(`${bountyId}`);

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed?.toString?.() ?? null,
      };

    } catch (error) {
      console.error('Error in creator approval:', error);
      if (error.code === 'ACTION_REJECTED') {
        throw new Error('Transaction rejected by user');
      }
      throw error;
    }
  }

  // ==========================================================================
  // READ OPERATIONS (OPTIMIZED with caching)
  // ==========================================================================

  /**
   * Get the effective status of a bounty (CACHED)
   * Uses debouncing and short-term cache to avoid hammering MetaMask
   */
  async getBountyStatus(bountyId) {
    const cacheKey = `${bountyId}`;
    const cached = this._statusCache.get(cacheKey);
    
    // Return cached value if still valid
    if (cached && (Date.now() - cached.timestamp) < this._statusCacheTTL) {
      return cached.status;
    }

    // Debounce identical requests
    return debounceRpcCall(`status-${bountyId}`, async () => {
      const provider = this.getReadOnlyProvider();
      if (!provider) {
        throw new Error('Provider not initialized. Call connect() first.');
      }

      try {
        const contract = new ethers.Contract(
          this.contractAddress,
          ["function getEffectiveBountyStatus(uint256) view returns (string)"],
          provider
        );

        const status = await contract.getEffectiveBountyStatus(bountyId);

        // Cache the result
        this._statusCache.set(cacheKey, { status, timestamp: Date.now() });

        return status;

      } catch (error) {
        console.error('Error getting bounty status:', error);
        const decoded = this._decodeRevertReason(error, [contract]);
        const msg = (decoded || error?.message || '').toLowerCase();
        if (msg.includes('bad bountyid') || msg.includes('badbountyid')) {
          throw new Error(`Bounty #${bountyId} does not exist on-chain`);
        }
        throw error;
      }
    });
  }

  /**
   * Get submission details (debounced)
   */
  async getSubmission(bountyId, submissionId) {
    return debounceRpcCall(`submission-${bountyId}-${submissionId}`, async () => {
      const provider = this.getReadOnlyProvider();
      if (!provider) {
        throw new Error('Provider not initialized. Call connect() first.');
      }

      try {
        const contract = new ethers.Contract(
          this.contractAddress,
          BOUNTY_ESCROW_ABI,
          provider
        );

        const sub = await contract.getSubmission(bountyId, submissionId);
        
        const statusMap = ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid', 'PendingCreatorApproval'];

        return {
          hunter: sub.hunter,
          hunterCid: sub.hunterCid,
          evalWallet: sub.evalWallet,
          verdiktaAggId: sub.verdiktaAggId,
          status: statusMap[Number(sub.status)] || 'UNKNOWN',
          statusCode: Number(sub.status),
          submittedAt: Number(sub.submittedAt),
          finalizedAt: Number(sub.finalizedAt),
          acceptance: Number(sub.acceptance),
          rejection: Number(sub.rejection),
          // Not stored on-chain (v0.5.0): use checkEvaluationReady() (aggregator) or the API's job data.
          justificationCids: '',
          ethMaxBudget: sub.ethMaxBudget.toString(),
          creatorWindowEnd: Number(sub.creatorWindowEnd),
          // Who attached the prepay at start (receives the unspent refund)
          funder: sub.funder === '0x0000000000000000000000000000000000000000' ? null : sub.funder,
        };

      } catch (error) {
        console.error('Error getting submission:', error);
        throw error;
      }
    });
  }

  /**
   * Check if Verdikta evaluation results are ready for a submission
   * Polls the VerdiktaAggregator contract directly
   * Returns: { ready: boolean, scores?: { acceptance, rejection }, justificationCids?: string[] }
   */
  async checkEvaluationReady(bountyId, submissionId) {
    // Try to get a provider - prefer MetaMask but fall back to public RPC
    let provider = this.getReadOnlyProvider();
    
    if (!provider) {
      console.log('⚠️ No MetaMask provider, trying public RPC...');
      try {
        provider = new ethers.JsonRpcProvider(currentNetwork.rpcUrl);
      } catch (e) {
        console.warn('⚠️ checkEvaluationReady: Could not create provider');
        return { ready: false, error: 'No provider available' };
      }
    }

    try {
      // Submission struct (September 2026 revision: 13 fields, no hunter-side oracle params)
      const tempContract = new ethers.Contract(this.contractAddress, BOUNTY_ESCROW_ABI, provider);
      const submission = await tempContract.getSubmission(bountyId, submissionId);

      const verdiktaAggId = submission.verdiktaAggId;
      const statusCode = Number(submission.status);

      // Status codes: 0=Prepared, 1=PendingVerdikta, 2=Failed, 3=PassedPaid, 4=PassedUnpaid, 5=PendingCreatorApproval
      if (statusCode !== 0 && statusCode !== 1) {
        return { ready: false };
      }

      // Check if aggId is zero (not yet assigned)
      const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
      if (!verdiktaAggId || verdiktaAggId === zeroBytes32) {
        return { ready: false };
      }

      const verdikta = await this._getAggregator(provider);

      let scores, justCids, ok;
      try {
        [scores, justCids, ok] = await verdikta.getEvaluation(verdiktaAggId);
      } catch (evalError) {
        // CALL_EXCEPTION is expected when evaluation data doesn't exist yet
        if (evalError.code === 'CALL_EXCEPTION') {
          return { ready: false };
        }
        throw evalError;
      }

      if (!ok || !scores || scores.length < 2) {
        return { ready: false };
      }

      // Scores are in format: [rejection, acceptance] with 6 decimal precision (0-1000000)
      const rejectionScore = Number(scores[0]) / 10000;
      const acceptanceScore = Number(scores[1]) / 10000;

      console.log(`✅ Evaluation ready: acceptance=${acceptanceScore.toFixed(1)}%, rejection=${rejectionScore.toFixed(1)}%`);

      return {
        ready: true,
        scores: {
          rejection: rejectionScore,
          acceptance: acceptanceScore
        },
        justificationCids: justCids || []
      };

    } catch (error) {
      // Log more details about the error
      console.error(`❌ checkEvaluationReady error for bounty ${bountyId}, submission ${submissionId}:`, {
        message: error.message,
        code: error.code,
        reason: error.reason
      });
      return { ready: false, error: error.message };
    }
  }

  // ==========================================================================
  // AGGREGATOR READS (force-fail gating)
  // ==========================================================================

  /**
   * Read-only VerdiktaAggregator contract (address from escrow.verdikta(), cached).
   * Prefers the public RPC over MetaMask for reliability.
   */
  async _getAggregator(fallbackProvider = null) {
    if (this._aggregator) return this._aggregator;
    const provider = this.getReadOnlyProvider() || fallbackProvider;
    if (!provider) throw new Error('No provider available');

    let verdiktaAddr = config.verdiktaAggregatorAddress || null;
    if (!verdiktaAddr) {
      const verdiktaSelector = ethers.id('verdikta()').slice(0, 10);
      const verdiktaResult = await provider.call({ to: this.contractAddress, data: verdiktaSelector });
      verdiktaAddr = '0x' + verdiktaResult.slice(26);
    }

    let readProvider;
    try {
      readProvider = new ethers.JsonRpcProvider(currentNetwork.rpcUrl);
    } catch (e) {
      readProvider = provider;
    }
    this._aggregator = new ethers.Contract(verdiktaAddr, VERDIKTA_AGGREGATOR_ABI, readProvider);
    return this._aggregator;
  }

  /** Aggregator response timeout in seconds (a constant, ~300 s). Cached. */
  async getResponseTimeoutSeconds() {
    if (this._responseTimeoutSeconds != null) return this._responseTimeoutSeconds;
    const agg = await this._getAggregator();
    this._responseTimeoutSeconds = Number(await agg.responseTimeoutSeconds());
    return this._responseTimeoutSeconds;
  }

  /** getAggregationStatus(aggId) as a plain object. */
  async getAggregationStatus(aggId) {
    const agg = await this._getAggregator();
    const r = await agg.getAggregationStatus(aggId);
    return {
      isComplete: Boolean(r.isComplete),
      failed: Boolean(r.failed),
      commitPhaseComplete: Boolean(r.commitPhaseComplete),
      commitExpected: Number(r.commitExpected),
      commitReceived: Number(r.commitReceived),
      responseCount: Number(r.responseCount),
      requiredN: Number(r.requiredN),
      clusterP: Number(r.clusterP),
      requester: r.requester,
      startTimestamp: Number(r.startTimestamp),
    };
  }

  /**
   * Force-fail gate — the SAME rule BountyEscrow.failTimedOutSubmission applies
   * (there is no timer): eligible iff getEvaluation(aggId).exists === false AND
   * (getAggregationStatus(aggId).isComplete === true OR now >= startTimestamp +
   * responseTimeoutSeconds). If a result exists the caller must finalize instead.
   *
   * @param {string} verdiktaAggId bytes32 aggregation id (from getSubmission)
   * @returns {{eligible:boolean, hasResult:boolean, settled:boolean, isComplete:boolean,
   *   startTimestamp:number, timeoutAt:number|null, secondsUntilTimeout:number|null,
   *   reason:string, hint:string}}
   */
  async getForceFailEligibility(verdiktaAggId) {
    const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
    if (!verdiktaAggId || verdiktaAggId === zeroBytes32) {
      return { eligible: false, hasResult: false, settled: false, isComplete: false, startTimestamp: 0,
               timeoutAt: null, secondsUntilTimeout: null, reason: 'no_agg_id',
               hint: 'The evaluation was never started.' };
    }
    try {
      const agg = await this._getAggregator();
      const [evalRes, status, responseTimeoutSeconds] = await Promise.all([
        agg.getEvaluation(verdiktaAggId).then(r => Boolean(r[2])).catch(e => {
          if (e.code === 'CALL_EXCEPTION') return false;
          throw e;
        }),
        this.getAggregationStatus(verdiktaAggId),
        this.getResponseTimeoutSeconds(),
      ]);
      const hasResult = evalRes;
      const now = Math.floor(Date.now() / 1000);
      const timeoutAt = status.startTimestamp > 0 ? status.startTimestamp + responseTimeoutSeconds : null;
      const timedOut = timeoutAt != null && now >= timeoutAt;
      const settled = status.isComplete || timedOut;
      const secondsUntilTimeout = timeoutAt != null ? Math.max(0, timeoutAt - now) : null;

      let eligible = false, reason, hint;
      if (hasResult) {
        reason = 'result_available';
        hint = 'The oracle produced a result — finalize this submission instead.';
      } else if (status.startTimestamp === 0) {
        reason = 'unknown_aggregation';
        hint = 'The aggregator has no record of this round.';
      } else if (!settled) {
        reason = 'not_settled';
        hint = `The aggregator round is still open; it settles in ${secondsUntilTimeout}s unless the oracle responds first.`;
      } else {
        eligible = true;
        reason = status.isComplete ? 'settled_no_result' : 'timed_out_no_result';
        hint = 'The round settled with no result — the submission can be force-failed and the prepay refunded.';
      }
      return { eligible, hasResult, settled, isComplete: status.isComplete, startTimestamp: status.startTimestamp,
               responseTimeoutSeconds, timeoutAt, secondsUntilTimeout, reason, hint };
    } catch (error) {
      console.warn('getForceFailEligibility failed:', error.message);
      return { eligible: false, hasResult: false, settled: false, isComplete: false, startTimestamp: 0,
               timeoutAt: null, secondsUntilTimeout: null, reason: 'rpc_error', error: error.message,
               hint: 'Could not read the aggregator state; retry shortly.' };
    }
  }

  // ==========================================================================
  // CONNECTION STATE
  // ==========================================================================

  isConnected() {
    return this.contract !== null && this.userAddress !== null;
  }

  getAddress() {
    return this.userAddress;
  }

  async getNetwork() {
    if (!this.provider) return null;
    return await this.provider.getNetwork();
  }

  /**
   * Clear all caches (useful after transactions)
   */
  clearCache() {
    this._statusCache.clear();
    pendingCalls.clear();
  }

  /**
   * Disconnect and clear all state
   */
  disconnect() {
    this.provider = null;
    this.signer = null;
    this.contract = null;
    this.userAddress = null;
    this._readOnlyProvider = null;
    this._aggregator = null;
    this.clearCache();
  }
}

// ============================================================================
// HELPER FUNCTIONS (OPTIMIZED - use singleton provider)
// ============================================================================

/**
 * Get or create a shared BrowserProvider instance
 */
let sharedProvider = null;
function getSharedProvider() {
  const injected = selectInjectedProvider();
  if (!sharedProvider && injected) {
    sharedProvider = new ethers.BrowserProvider(injected);
  }
  return sharedProvider;
}

/**
 * Derive bountyId from a known tx hash by parsing the event
 */
export async function deriveBountyIdFromTx(txHash, escrowAddress) {
  const provider = getSharedProvider();
  if (!provider) throw new Error('Wallet not available');
  const iface = new ethers.Interface([
    "event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)"
  ]);

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt?.logs?.length) throw new Error('No logs in receipt');

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "BountyCreated") {
        return Number(parsed.args.bountyId);
      }
    } catch { /* non-matching log */ }
  }
  throw new Error('BountyCreated not found in tx logs');
}

/**
 * Resolve on-chain bountyId by reading contract state
 * OPTIMIZED: Uses shared provider
 */
export async function resolveBountyIdByStateLoose({
  escrowAddress,
  creator,
  evaluationCid,
  submissionDeadline,
  deadlineToleranceSec = 300,
  lookback = 1000
}) {
  const provider = getSharedProvider();
  if (!provider) throw new Error('Wallet not available');
  const abi = [
    "function bountyCount() view returns (uint256)",
    // Full Bounty tuple (incl. trailing `oracle` struct); positional reads b[0]/b[1]/b[6] below are unchanged.
    "function getBounty(uint256) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, tuple(uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) oracle))"
  ];

  const c = new ethers.Contract(escrowAddress, abi, provider);
  const total = Number(await c.bountyCount());
  if (total === 0) throw new Error("No bounties on chain yet");

  const start = Math.max(0, total - 1);
  const stop = Math.max(0, total - 1 - Math.max(1, lookback));

  const wantCreator = (creator || "").toLowerCase();
  const wantCid = evaluationCid || "";
  const wantDeadline = Number(submissionDeadline || 0);

  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (let i = start; i >= stop; i--) {
    const b = await c.getBounty(i);
    const bCreator = (b[0] || "").toLowerCase();
    if (bCreator !== wantCreator) continue;

    const bCid = b[1] || "";
    const bDeadline = Number(b[6] || 0);
    const delta = Math.abs(bDeadline - wantDeadline);

    const cidOk = !wantCid || wantCid === bCid;
    const deadlineOk = delta <= deadlineToleranceSec;

    if ((cidOk && deadlineOk) || (cidOk && delta < bestDelta)) {
      best = i;
      bestDelta = delta;
      if (cidOk && delta === 0) break;
    }
  }

  if (best != null) return best;
  throw new Error("No matching bounty found with loose state match");
}

export async function resolveBountyIdByState(args) {
  return resolveBountyIdByStateLoose(args);
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

let contractService = null;

// Default contract address from config (supports both networks)
const DEFAULT_CONTRACT_ADDRESS = config.bountyEscrowAddress;

export function initializeContractService(contractAddress) {
  contractService = new ContractService(contractAddress);
  return contractService;
}

export function getContractService() {
  // Auto-initialize with default address if not already initialized
  if (!contractService) {
    console.warn('⚠️ Contract service was not initialized, auto-initializing with default address');
    contractService = new ContractService(DEFAULT_CONTRACT_ADDRESS);
  }
  return contractService;
}

export default ContractService;

