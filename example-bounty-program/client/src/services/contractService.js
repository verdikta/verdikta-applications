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
import escrowAbiJson from '../../../onchain/abi/BountyEscrow.json';
import { presetByKey } from '../../../shared/classPresets.js';

// BountyEscrow v2 ABI: the merged escrow + lens ABI the contracts build writes
// (onchain/abi/BountyEscrow.json, the same file the bounty server requires). One source for
// every tuple: createBounty(CreateParams) with the oracle fee floor / beacons and the jury
// struct (K, M, N, P, timeout), quota (Q), forfeitLine (R) and bond; the v2 Submission (bondFunder, bondHeld, rerunDeadline,
// rounds, passCount); the lens's getOracleResult struct and nextAction.
const BOUNTY_ESCROW_ABI = escrowAbiJson.filter((e) => e.type === 'function' || e.type === 'event' || e.type === 'error');

// The v2 aggregator, for what only it answers: CLOSE_COMMITS and PROMOTE are calls on the
// escrow's one aggregator (escrow.aggregator()), and its limits for the create pre-checks. The
// jury is each bounty's (getBounty's juryK..juryTimeout); a round's is getJury(aggId). Round
// state and results come from the escrow's lens (getOracleResult, nextAction), not from here.
const VERDIKTA_AGGREGATOR_ABI = [
  'function getRoundInfo(bytes32 aggId) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)',
  'function getJury(bytes32 aggId) view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)',
  'function closeCommits(bytes32 aggId)',
  'function promote(bytes32 aggId)',
  'function maxOracleFee() view returns (uint256)',
  'function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) view returns (uint256)',
  'function maxJury() view returns (uint8)',
  'function maxTimeout() view returns (uint40)',
  'function tPlus() view returns (uint40)',
  'error BadJury()',
  'error WrongPhase()',
  'error TooEarly()',
  'error NotDue()',
  'error DrawExpired()',
];

/** getRoundInfo / getOracleResult phase numbers (the v2 aggregator). */
export const ROUND_PHASES = Object.freeze({
  0: 'none', 1: 'draw', 2: 'beacons', 3: 'commit', 4: 'closing', 5: 'reveal', 6: 'final', 7: 'settled', 8: 'failed', 9: 'cancelled',
});
/** The lens's OracleResult.outcome (BountyRules.Outcome, item 12's Q-of-N rule). */
export const ROUND_OUTCOMES = Object.freeze({ 0: 'not_ready', 1: 'no_result', 2: 'pass', 3: 'soft_fail', 4: 'hard_fail' });
/** BountyEscrow.SubmissionStatus by number. */
export const SUBMISSION_STATUSES = Object.freeze([
  'Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid', 'PendingCreatorApproval', 'AwaitingRerun',
]);
/** nextAction values that are one transaction anyone may send to move a round on. */
export const ROUND_STEP_ACTIONS = Object.freeze(['DRAW', 'CLOSE_COMMITS', 'PROMOTE', 'CLOSE_FAILED', 'EXPIRE_RERUN']);

// Contract bounds for creator oracle settings (BountyEscrow MAX_ALPHA / MAX_FEE_SCALING_FACTOR).
export const ORACLE_MAX_ALPHA = 1000;
export const ORACLE_MAX_FEE_SCALING = 1000;
// The per-oracle fee ceiling is the aggregator's live maxOracleFee() (one aggregator serves
// every jury); the contract rejects a higher maxOracleFee ("oracle fee above ceiling").
// The fee floor (minOracleFee) may exceed it: it prices jurors, it does not limit eligibility.
const UINT96_MAX = (1n << 96n) - 1n;

/**
 * Map a raw BountyEscrow revert string to a user-facing message.
 * Returns null when the reason is not recognised (caller rethrows the original).
 * Order matters: more specific phrases first.
 */
const REVERT_MESSAGES = [
  // Retryable, NOT a failure
  ['earlier submission pending', 'An earlier submission by another hunter has payout priority and is not resolved yet (still in evaluation, or evaluated but never finalized). This is not a failure — your result is kept; it can be paid once that submission is resolved.'],
  ['evaluation slots full', 'This bounty already has the maximum number of evaluations in flight (64). A slot frees as soon as any of them resolves — retry in a few minutes (this is not a failure; your prepared submission is kept).'],
  ['earlier submission unresolved', 'An earlier submission must be resolved first (it is still in evaluation or in its approval window).'],
  // Round routing (v2: closeFailedRound / re-runs, item 12)
  ['result available - use finalizesubmission', 'The jury produced a result for this round — finalize it instead of closing it as failed.'],
  ['result available', 'The jury produced a result for this round — finalize it instead of closing it as failed.'],
  ['round still open', 'The round is still open (it is being drawn, committed or revealed, or has not reached its deadline). Wait, or move it on with the step the contract suggests.'],
  ['verdikta not ready', 'The jury has not completed this round yet — please wait.'],
  ['no oracle result - use closefailedround', 'The round ended without a result — close it as failed (closeFailedRound); the submission then may re-run, keeping its place and bond.'],
  ['not awaiting rerun', 'This submission is not awaiting a re-run.'],
  ['only hunter or funder', 'Only the hunter or whoever funded the bond may re-run this submission.'],
  ['rerun window closed', 'The 2-hour re-run window has closed — expire the re-run instead (anyone may; the bond goes back).'],
  ['rerun limit reached', 'This submission has used all 6 rounds.'],
  ['rerun window open', 'The re-run window is still open — only the hunter or bond funder can act until it closes.'],
  ['bad quota', 'Quota and forfeit line must satisfy 1 ≤ Q, R ≤ Q and Q ≤ the jury\'s N.'],
  ['bad jury', 'The jury must satisfy K ≥ M ≥ N ≥ P ≥ 1, N ≤ 40, and P ≥ 2 unless N = 1.'],
  ['badjury', 'The aggregator refused this bounty\'s jury: K above its maxJury (or the keeper\'s shortlist), or a timeout outside T+ < timeout ≤ maxTimeout.'],
  ['bad bond', 'The bond is too large.'],
  ['bad fee floor', 'The fee floor is too large.'],
  ['wrongphase', 'The round is not in the phase this step needs — re-read the next action and retry.'],
  ['tooearly', 'Too early for this step (a draw needs two blocks after the start; promote two blocks after closing). Retry in a few seconds.'],
  ['notdue', 'The round is not due for this step yet.'],
  ['drawexpired', 'The draw window expired — the round can be closed as failed.'],
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
  ['oracle fee above ceiling', 'Max oracle fee is above the aggregator\'s live ceiling (maxOracleFee()).'],
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
  ['wrong eth amount', 'Incorrect ETH amount: start attaches startValue (the round prepay plus the hunter bond); a re-run attaches requiredPrepay.'],
  ['only hunter', 'Only the submitting hunter can start this evaluation.'],
  ['already started or resolved', 'This submission has already been started (or is already resolved) — nothing to start.'],
  ['not pending', 'This submission is not in evaluation — it was never started, or it has already been resolved. Check nextAction.'],
  ['no oracle result', 'The round ended without a result — close it as failed (closeFailedRound) instead of finalizing; the submission may then re-run.'],
  ['not resolved', 'The prepay can only be recovered once the submission has resolved (Failed / PassedPaid / PassedUnpaid) or its round was closed.'],
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
    msg.includes('round still open') || msg.includes('evaluation slots full') || msg.includes('tooearly');
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

    // The escrow's aggregator (read-only; one serves every jury)
    this._aggregator = null;
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
   * Accepts wei strings/bigints (or decimal-ETH strings containing a '.') for the fee fields,
   * integers for alpha / scaling, a boolean for withBeacons. Defaults come from
   * config.submissionDefaults (fee floor 0, no beacons). Enforces the contract's static bounds so
   * a bad value fails before the wallet opens; the aggregator's live fee ceiling is checked in
   * createBounty (maxOracleFee()).
   * minOracleFee (v2) is the fee floor: every juror (and beacon) is paid at least that.
   */
  static resolveOracleParams(oracle = {}) {
    const d = config.submissionDefaults;
    const toWei = (v, label) => {
      if (v === undefined || v === null || v === '') return null;
      if (typeof v === 'bigint') return v;
      const str = String(v).trim();
      try {
        return str.includes('.') ? ethers.parseEther(str) : BigInt(str);
      } catch {
        throw new Error(`${label} must be a decimal-ETH amount or an integer wei value`);
      }
    };
    const maxOracleFee = toWei(oracle.maxOracleFee, 'Max oracle fee') ?? BigInt(d.maxOracleFeeWei);
    const estimatedBaseCost = toWei(oracle.estimatedBaseCost, 'Estimated base cost') ?? BigInt(d.estimatedBaseCostWei);
    const minOracleFee = toWei(oracle.minOracleFee, 'Fee floor') ?? BigInt(d.minOracleFeeWei || 0);
    const withBeacons = Boolean(oracle.withBeacons ?? false);
    const alpha = oracle.alpha === undefined || oracle.alpha === null || oracle.alpha === '' ? Number(d.alpha) : Number(oracle.alpha);
    const maxFeeBasedScaling = oracle.maxFeeBasedScaling === undefined || oracle.maxFeeBasedScaling === null || oracle.maxFeeBasedScaling === ''
      ? Number(d.maxFeeBasedScaling) : Number(oracle.maxFeeBasedScaling);

    if (maxOracleFee <= 0n) throw new Error('Max oracle fee must be greater than 0');
    if (estimatedBaseCost < 0n) throw new Error('Estimated base cost must be >= 0');
    if (estimatedBaseCost >= maxOracleFee) throw new Error('Estimated base cost must be below the max oracle fee');
    if (minOracleFee < 0n || minOracleFee > UINT96_MAX) throw new Error('Fee floor must be between 0 and 2^96-1 wei');
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
      maxFeeBasedScaling: BigInt(maxFeeBasedScaling),
      minOracleFee,
      withBeacons,
    };
  }

  /**
   * Resolve + validate the v2 decision settings (item 12 / item 15): the bounty's jury
   * { K, M, N, P, timeout } (K drawn, M promoted, N counted, P clustered, the round timeout in
   * seconds), quota Q (arbiter scores at the threshold needed to pass), forfeitLine R (below R the
   * hunter's bond goes to the creator) and bond (wei). Defaults: the Small class (its jury, Q 3,
   * R 1, no bond). Checked as the escrow does: K >= M >= N >= P >= 1, N <= 40, P >= 2 unless
   * N = 1, and R <= Q <= N.
   */
  static resolveDecisionParams(decision = {}) {
    const given = decision.jury;
    if (given !== undefined && given !== null && given !== '' && typeof given !== 'object') {
      throw new Error('Jury must be the bounty\'s own { K, M, N, P, timeout } (an aggregator index is no longer used)');
    }
    const j = { ...presetByKey('small').jury, ...(given || {}) };
    const jury = { K: Number(j.K), M: Number(j.M), N: Number(j.N), P: Number(j.P), timeout: Number(j.timeout) };
    const quota = decision.quota === undefined || decision.quota === null || decision.quota === '' ? 3 : Number(decision.quota);
    const forfeitLine = decision.forfeitLine === undefined || decision.forfeitLine === null || decision.forfeitLine === '' ? 1 : Number(decision.forfeitLine);
    let bond = 0n;
    if (decision.bond !== undefined && decision.bond !== null && decision.bond !== '') {
      const str = String(decision.bond).trim();
      try { bond = typeof decision.bond === 'bigint' ? decision.bond : (str.includes('.') ? ethers.parseEther(str) : BigInt(str)); }
      catch { throw new Error('Bond must be a decimal-ETH amount or an integer wei value'); }
    }
    for (const f of ['K', 'M', 'N', 'P']) {
      if (!Number.isInteger(jury[f]) || jury[f] < 1 || jury[f] > 255) throw new Error(`Jury ${f} must be an integer from 1 to 255`);
    }
    if (!Number.isInteger(jury.timeout) || jury.timeout < 1 || jury.timeout > 2 ** 40 - 1) throw new Error('Jury timeout must be a positive whole number of seconds');
    if (!(jury.P <= jury.N && jury.N <= jury.M && jury.M <= jury.K && jury.N <= 40 && (jury.P !== 1 || jury.N === 1))) {
      throw new Error(`Jury ${jury.K}/${jury.M}/${jury.N}/${jury.P} must satisfy K >= M >= N >= P >= 1, N <= 40 and P >= 2 unless N = 1`);
    }
    if (!Number.isInteger(quota) || quota < 1 || quota > 255) throw new Error('Quota (Q) must be an integer of at least 1');
    if (!Number.isInteger(forfeitLine) || forfeitLine < 0 || forfeitLine > quota) throw new Error('Forfeit line (R) must be an integer between 0 and Q');
    if (quota > jury.N) throw new Error(`Quota (Q = ${quota}) is above this jury's size N = ${jury.N}`);
    if (bond < 0n || bond > UINT96_MAX) throw new Error('Bond must be between 0 and 2^96-1 wei');
    return { jury, quota, forfeitLine, bond };
  }

  /**
   * Create a bounty on-chain via MetaMask.
   *
   * createBounty takes ONE CreateParams struct (no more 5/8-arg overloads).
   * msg.value == max(creatorDeterminationPayment, arbiterDeterminationPayment);
   * a non-windowed bounty passes both payments equal to the amount and window 0.
   * `oracle` (creator-chosen oracle request settings) is optional — defaults from
   * config.submissionDefaults: { maxOracleFee, alpha, estimatedBaseCost, maxFeeBasedScaling,
   * minOracleFee, withBeacons }. `decision` (v2) is { jury: {K, M, N, P, timeout}, quota, forfeitLine, bond } — see
   * resolveDecisionParams; the create page fills it from the class presets (shared/classPresets.js).
   *
   * `onStep(step, data)` (optional) is told how far the create got: 'staticCall'
   * before the pre-check, 'send' before the wallet is asked to sign, 'wait' with
   * { txHash } once the wallet returned a hash. Errors keep the original in `cause`.
   */
  async createBounty({ evaluationCid, classId, threshold, bountyAmountEth, submissionWindowHours, targetHunter,
                       creatorDeterminationPaymentEth, arbiterDeterminationPaymentEth, creatorAssessmentWindowHours,
                       oracle, decision, onStep }) {
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
    const decisionParams = ContractService.resolveDecisionParams(decision || {});

    // The aggregator's live fee ceiling and jury limits (the escrow checks the ceiling at create;
    // every request checks K <= maxJury and T+ < timeout <= maxTimeout).
    try {
      const agg = await this.getAggregator();
      if (agg) {
        const [ceiling, maxJury, maxTimeout, tPlus] = await Promise.all([agg.maxOracleFee(), agg.maxJury(), agg.maxTimeout(), agg.tPlus()]);
        if (oracleParams.maxOracleFee > BigInt(ceiling)) {
          throw new Error(`Max oracle fee is above the aggregator's live ceiling of ${ethers.formatEther(ceiling)} ETH`);
        }
        const j = decisionParams.jury;
        if (j.K > Number(maxJury)) throw new Error(`This jury draws K = ${j.K}, above the aggregator's limit of ${Number(maxJury)}`);
        if (!(j.timeout > Number(tPlus) && j.timeout <= Number(maxTimeout))) {
          throw new Error(`This jury's timeout (${j.timeout} s) must be above ${Number(tPlus)} s and at most the aggregator's limit of ${Number(maxTimeout)} s`);
        }
      }
    } catch (e) {
      if (/above the aggregator|aggregator's limit/.test(e.message)) throw e;
      console.warn('Could not read the aggregator for pre-checks; the dry-run still checks', e.message);
    }

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
        oracle: oracleParams,
        jury: decisionParams.jury,   // { K, M, N, P, timeout }: the CreateParams.jury tuple
        quota: decisionParams.quota,
        forfeitLine: decisionParams.forfeitLine,
        bond: decisionParams.bond
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
          maxFeeBasedScaling: oracleParams.maxFeeBasedScaling.toString(),
          minOracleFee: oracleParams.minOracleFee.toString(),
          withBeacons: oracleParams.withBeacons
        },
        decision: { ...decisionParams, bond: decisionParams.bond.toString() },
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
   * The ETH a start attaches, read live: startValue(bountyId) = requiredPrepay (the round's
   * oracle prepay, escrowed with the jury's aggregator; the unspent part comes back to the
   * funder) + the bounty's hunter bond (held by the escrow; returned on a pass, a no-result or
   * an expired re-run, forfeited to the creator on a hard fail).
   * @returns {Promise<{ startValue: bigint, prepay: bigint, bond: bigint }>}
   */
  async getStartValue(bountyId) {
    const c = this.contract || new ethers.Contract(this.contractAddress, BOUNTY_ESCROW_ABI, this.getReadOnlyProvider());
    const [startValue, prepay] = await Promise.all([c.startValue(bountyId), c.requiredPrepay(bountyId)]);
    return { startValue: BigInt(startValue), prepay: BigInt(prepay), bond: BigInt(startValue) - BigInt(prepay) };
  }

  /** requiredPrepay(bountyId): what one round (a re-run) attaches, read live. */
  async getRequiredPrepay(bountyId) {
    const c = this.contract || new ethers.Contract(this.contractAddress, BOUNTY_ESCROW_ABI, this.getReadOnlyProvider());
    return BigInt(await c.requiredPrepay(bountyId));
  }

  /**
   * STEP 2: Start the prepared submission (opens the first round of its evaluation).
   *
   * msg.value must equal startValue(bountyId) — the round prepay plus the hunter bond — read
   * live here (the ethMaxBudget from prepareSubmission is only a prepay estimate and misses the
   * bond). No ERC20 approval. The round must then be drawn (drawJury, anyone, from two blocks
   * after the start; the server's keeper usually sends it).
   *
   * @param {string|number} bountyId
   * @param {string|number} submissionId
   * @returns {Promise<{success, txHash, blockNumber, gasUsed, valueWei, prepayWei, bondWei}>}
   */
  async startPreparedSubmission(bountyId, submissionId) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }

    let sv;
    try {
      sv = await this.getStartValue(bountyId);
    } catch (e) {
      throw new Error(`Could not read startValue(bountyId) (the round prepay plus the hunter bond) from the escrow — retry shortly. ${e.shortMessage || e.message || ''}`.trim());
    }
    const value = sv.startValue;

    try {
      console.log('🔍 Starting submission evaluation...', {
        bountyId, submissionId, valueEth: ethers.formatEther(value),
        prepayEth: ethers.formatEther(sv.prepay), bondEth: ethers.formatEther(sv.bond)
      });

      // Dry-run to surface revert reasons before prompting MetaMask
      try {
        await this.contract.startPreparedSubmission.staticCall(bountyId, submissionId, { value });
      } catch (e) {
        const decoded = this._decodeRevertReason(e, [this.contract]);
        const msg = (decoded || e?.message || '').toLowerCase();
        if (msg.includes('wrong eth amount')) throw new Error('Incorrect ETH amount: start attaches startValue (the round prepay plus the hunter bond), and it changed — retry');
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
        gasUsed: receipt.gasUsed.toString(),
        valueWei: value.toString(),
        prepayWei: sv.prepay.toString(),
        bondWei: sv.bond.toString()
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
      // The round ended with no result: finalize can never succeed — closeFailedRound is the call.
      if (msg.includes('no oracle result')) {
        return { success: false, reason: 'oracle_no_result', canFallbackToTimeout: true,
                 message: friendlyRevertMessage(msg) };
      }
      if (msg.includes('verdikta') || msg.includes('not ready') || msg.includes('notready') || msg.includes('evaluation')) {
        // The jury has no result yet. Whether the round can be closed as failed depends on
        // its phase — callers must check getCloseFailedEligibility() / nextAction.
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
   * Submission ids in evaluation (PendingVerdikta) on-chain, lowest first. This is the
   * list closeExpiredBounty requires to be empty; read it instead of local statuses,
   * which label these PENDING_EVALUATION, ACCEPTED_PENDING_CLAIM or
   * REJECTED_PENDING_FINALIZATION depending on what the sync has seen.
   */
  async getPendingSubmissionIds(bountyId) {
    const c = new ethers.Contract(this.contractAddress, BOUNTY_ESCROW_ABI, this.getReadOnlyProvider());
    return [...await c.pendingSubmissionIds(bountyId)].map(Number).sort((a, b) => a - b);
  }

  /** The contract's own verdict on what to do with a submission (BountyEscrow.nextAction). */
  async getNextAction(bountyId, submissionId) {
    const c = new ethers.Contract(this.contractAddress, BOUNTY_ESCROW_ABI, this.getReadOnlyProvider());
    return String(await c.nextAction(bountyId, submissionId));
  }

  /**
   * Why a passing submission cannot be paid yet: the earlier in-flight submissions by
   * other hunters that hold payout priority (finalize reverts "earlier submission
   * pending" while any remain). Each comes with the contract's nextAction for it —
   * FINALIZE / CLOSE_FAILED / EXPIRE_RERUN mean one transaction, which anyone may send,
   * resolves it (it cannot change who wins and refunds that hunter's unused prepay); DRAW /
   * CLOSE_COMMITS / PROMOTE move its round on (anyone); anything else (AWAIT_ORACLE, RERUN —
   * the hunter's call) must be waited out. Lowest index first.
   * @returns {Promise<Array<{ submissionId: number, hunter: string, nextAction: string, resolvable: boolean }>>}
   */
  async getFinalizeBlockers(bountyId, submissionId) {
    const c = new ethers.Contract(this.contractAddress, BOUNTY_ESCROW_ABI, this.getReadOnlyProvider());
    const subId = Number(submissionId);
    const [pending, me] = await Promise.all([c.pendingSubmissionIds(bountyId), c.getSubmission(bountyId, subId)]);
    const hunter = String(me.hunter).toLowerCase();
    const earlier = [...pending].map(Number).filter((id) => id < subId).sort((a, b) => a - b);
    const rows = await Promise.all(earlier.map(async (id) => {
      const s = await c.getSubmission(bountyId, id);
      if (String(s.hunter).toLowerCase() === hunter) return null;   // same hunter never blocks
      const nextAction = String(await c.nextAction(bountyId, id));
      return { submissionId: id, hunter: s.hunter, nextAction,
               resolvable: nextAction === 'FINALIZE' || ROUND_STEP_ACTIONS.includes(nextAction) };
    }));
    return rows.filter(Boolean);
  }

  /** Resolve (or move on) a blocker found by getFinalizeBlockers: finalize it or send its round step. */
  async resolveBlocker(bountyId, blocker) {
    if (blocker.nextAction === 'FINALIZE') return this.finalizeSubmission(bountyId, blocker.submissionId);
    if (ROUND_STEP_ACTIONS.includes(blocker.nextAction)) return this.roundStep(bountyId, blocker.submissionId, blocker.nextAction);
    throw new Error(`Submission #${blocker.submissionId} cannot be resolved yet (${blocker.nextAction}).`);
  }

  /**
   * Send one escrow write after a dry-run that maps the revert to a friendly message.
   * Errors carry `retryable` (retry later), `shouldFinalize` (the round has a result) and `raw`.
   */
  async _sendEscrowCall(method, args, { value, label } = {}) {
    if (!this.contract) {
      throw new Error('Contract not initialized. Call connect() first.');
    }
    const overrides = value != null ? [{ value }] : [];
    try {
      try {
        await this.contract[method].staticCall(...args, ...overrides);
      } catch (e) {
        const decoded = this._decodeRevertReason(e, [this.contract]);
        const raw = String(decoded || e?.message || '');
        const friendly = friendlyRevertMessage(raw);
        const err = new Error(friendly || raw || `${label || method} would revert`);
        err.raw = raw;
        err.retryable = isRetryableRevert(raw);
        err.shouldFinalize = raw.toLowerCase().includes('result available');
        throw err;
      }
      const tx = await this.contract[method](...args, ...overrides);
      console.log(`📤 ${method} sent:`, tx.hash);
      const receipt = await tx.wait();
      console.log(`✅ ${method} confirmed:`, receipt.hash);
      this._statusCache.delete(`${args[0]}`);
      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed?.toString?.() ?? null
      };
    } catch (error) {
      if (error.code === 'ACTION_REJECTED') throw new Error('Transaction rejected by user');
      if (error.raw !== undefined) throw error;
      console.error(`Error in ${method}:`, error);
      const friendly = friendlyRevertMessage(this._decodeRevertReason(error, [this.contract]) || error?.message);
      if (friendly) throw new Error(friendly);
      throw error;
    }
  }

  /**
   * Close a round that has no result and can get none (failed, cancelled, past its deadline, or
   * undrawn for a day): closeFailedRound settles or cancels it, returns what is left of the
   * prepay to the round's funder, and puts the submission in AwaitingRerun (it keeps its place
   * and bond). Anyone may call. Replaces v1's failTimedOutSubmission.
   */
  async closeFailedRound(bountyId, submissionId) {
    return this._sendEscrowCall('closeFailedRound', [bountyId, submissionId]);
  }

  /** v1 name, kept for callers not yet renamed. */
  async failTimedOutSubmission(bountyId, submissionId) {
    return this.closeFailedRound(bountyId, submissionId);
  }

  /**
   * Draw the jury of a submission's current round (anyone, from two blocks after the start;
   * a beacon bounty needs a second draw once the beacon values are in). Sent through the escrow
   * so the draw reward goes back to the round's funder.
   */
  async drawJury(bountyId, submissionId) {
    return this._sendEscrowCall('drawJury', [bountyId, submissionId]);
  }

  /**
   * Re-run a submission awaiting one (soft fail or no result): a new round with a fresh jury,
   * keeping the submission's place and bond. Only the hunter or the bond's funder; attaches
   * requiredPrepay(bountyId), read live. Max 6 rounds, within the 2-hour re-run window.
   */
  async rerunSubmission(bountyId, submissionId) {
    const value = await this.getRequiredPrepay(bountyId);
    const res = await this._sendEscrowCall('rerunSubmission', [bountyId, submissionId], { value });
    return { ...res, valueWei: value.toString() };
  }

  /** Fail a submission whose re-run window closed (anyone); its bond goes back to its funder. */
  async expireRerun(bountyId, submissionId) {
    return this._sendEscrowCall('expireRerun', [bountyId, submissionId]);
  }

  /**
   * Send whichever round step the lens's nextAction names now (DRAW / CLOSE_COMMITS / PROMOTE /
   * CLOSE_FAILED / EXPIRE_RERUN). CLOSE_COMMITS and PROMOTE are calls on the bounty's own
   * aggregator (closeCommits / promote with the round's aggId); the rest go to the escrow.
   * `expected` (optional): refuse when the live nextAction differs (the state moved on).
   */
  async roundStep(bountyId, submissionId, expected = null) {
    if (!this.contract) throw new Error('Contract not initialized. Call connect() first.');
    const action = String(await this.contract.nextAction(bountyId, submissionId));
    if (expected && action !== expected) {
      const err = new Error(`The round moved on: the next step is now ${action}, not ${expected}. Refresh and retry.`);
      err.retryable = true;
      err.nextAction = action;
      throw err;
    }
    if (action === 'DRAW') return { ...(await this.drawJury(bountyId, submissionId)), action };
    if (action === 'CLOSE_FAILED') return { ...(await this.closeFailedRound(bountyId, submissionId)), action };
    if (action === 'EXPIRE_RERUN') return { ...(await this.expireRerun(bountyId, submissionId)), action };
    if (action === 'CLOSE_COMMITS' || action === 'PROMOTE') {
      const sub = await this.contract.getSubmission(bountyId, submissionId);
      const aggAddr = await this.contract.aggregator();
      const agg = new ethers.Contract(aggAddr, VERDIKTA_AGGREGATOR_ABI, this.signer);
      const method = action === 'PROMOTE' ? 'promote' : 'closeCommits';
      try {
        await agg[method].staticCall(sub.verdiktaAggId);
        const tx = await agg[method](sub.verdiktaAggId);
        const receipt = await tx.wait();
        this._statusCache.delete(`${bountyId}`);
        return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber, action };
      } catch (error) {
        if (error.code === 'ACTION_REJECTED') throw new Error('Transaction rejected by user');
        const raw = this._decodeRevertReason(error, [agg]) || error?.message || '';
        const err = new Error(friendlyRevertMessage(raw) || raw);
        err.retryable = isRetryableRevert(raw);
        throw err;
      }
    }
    const err = new Error(`No round step to send now (next action: ${action}).`);
    err.nextAction = action;
    throw err;
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
      if (/not resolved/i.test(reason)) throw new Error('This submission is still being evaluated; recovery is possible once its round is finalized or closed.');
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
        

        return {
          hunter: sub.hunter,
          hunterCid: sub.hunterCid,
          evalWallet: sub.evalWallet,
          verdiktaAggId: sub.verdiktaAggId,
          status: SUBMISSION_STATUSES[Number(sub.status)] || 'UNKNOWN',
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
          funder: sub.funder === ethers.ZeroAddress ? null : sub.funder,
          // v2 (item 12): who funded the hunter bond, the bond still held, the re-run window's end
          // (0 unless AwaitingRerun), rounds run so far (max 6) and the last result's pass count.
          bondFunder: sub.bondFunder === ethers.ZeroAddress ? null : sub.bondFunder,
          bondHeld: sub.bondHeld.toString(),
          rerunDeadline: Number(sub.rerunDeadline),
          rounds: Number(sub.rounds),
          passCount: Number(sub.passCount),
        };

      } catch (error) {
        console.error('Error getting submission:', error);
        throw error;
      }
    });
  }

  /**
   * Is the current round's result in? Reads the escrow's lens (getOracleResult), so no
   * aggregator ABI is needed. Returns { ready, outcome, passCount, scores?: { acceptance,
   * rejection }, justificationCids?, phase, rounds } — `ready` when the round has a result;
   * `outcome` is item 12's verdict (pass / soft_fail / hard_fail; no_result when it ended empty).
   */
  async checkEvaluationReady(bountyId, submissionId) {
    const st = await this.getRoundState(bountyId, submissionId);
    if (st.error) return { ready: false, error: st.error };
    if (!st.started || !st.hasResult) {
      return { ready: false, outcome: st.outcome, phase: st.phase, phaseName: st.phaseName, nextAction: st.nextAction };
    }
    return {
      ready: true,
      outcome: st.outcome,
      passCount: st.passCount,
      rounds: st.rounds,
      scores: st.scores || { acceptance: 0, rejection: 0 },
      justificationCids: st.justificationCids ? String(st.justificationCids).split(',').filter(Boolean) : [],
      phase: st.phase,
      phaseName: st.phaseName,
      nextAction: st.nextAction,
    };
  }

  // ==========================================================================
  // ROUND STATE (v2: the escrow's lens; per-bounty aggregators)
  // ==========================================================================

  _readEscrow() {
    const provider = this.getReadOnlyProvider();
    if (!provider) throw new Error('No provider available');
    return new ethers.Contract(this.contractAddress, BOUNTY_ESCROW_ABI, provider);
  }

  _publicProvider() {
    try { return new ethers.JsonRpcProvider(currentNetwork.rpcUrl); } catch { return this.getReadOnlyProvider(); }
  }

  /** The escrow's aggregator (escrow.aggregator(), immutable; serves every jury), read-only, cached. */
  async getAggregator() {
    if (!this._aggregator) {
      const addr = await this._readEscrow().aggregator();
      this._aggregator = new ethers.Contract(addr, VERDIKTA_AGGREGATOR_ABI, this._publicProvider());
    }
    return this._aggregator;
  }

  /** The aggregator's live per-oracle fee ceiling (wei, bigint). */
  async getOracleFeeCeilingWei() {
    const agg = await this.getAggregator();
    return BigInt(await agg.maxOracleFee());
  }

  /**
   * One submission's round, from the lens: getOracleResult (phase, Q-of-N outcome, pass count,
   * deadline, scores) + nextAction (the call that succeeds now) + the submission's v2 fields
   * (rounds, rerunDeadline, bond). Never throws: { error } on an RPC failure.
   */
  async getRoundState(bountyId, submissionId) {
    try {
      const c = this._readEscrow();
      const [r, nextAction, sub] = await Promise.all([
        c.getOracleResult(bountyId, submissionId),
        c.nextAction(bountyId, submissionId),
        c.getSubmission(bountyId, submissionId),
      ]);
      const phase = Number(r.phase);
      const raw = [...(r.scores || [])].map(Number);
      const scores = !r.hasResult ? null
        : raw.length === 2 ? { acceptance: raw[1] / 10000, rejection: raw[0] / 10000 }
          : raw.length === 1 ? { acceptance: raw[0] / 10000, rejection: 100 - raw[0] / 10000 } : null;
      return {
        started: Boolean(r.started),
        hasResult: Boolean(r.hasResult),
        phase,
        phaseName: ROUND_PHASES[phase] || 'unknown',
        outcome: ROUND_OUTCOMES[Number(r.outcome)] || 'unknown',
        passCount: Number(r.passCount),
        rounds: Number(r.rounds),
        deadline: Number(r.deadline),
        requestTime: Number(r.requestTime),
        scores,
        justificationCids: r.justificationCids || '',
        nextAction: String(nextAction),
        status: SUBMISSION_STATUSES[Number(sub.status)] || 'UNKNOWN',
        statusCode: Number(sub.status),
        rerunDeadline: Number(sub.rerunDeadline),
        bondHeld: sub.bondHeld.toString(),
        bondFunder: sub.bondFunder === ethers.ZeroAddress ? null : sub.bondFunder,
        hunter: sub.hunter,
        verdiktaAggId: sub.verdiktaAggId,
      };
    } catch (error) {
      console.warn('getRoundState failed:', error.message);
      return { error: error.message };
    }
  }

  /**
   * Can the round be closed as failed (closeFailedRound) now? The lens's nextAction decides
   * (CLOSE_FAILED): the round failed, was cancelled, passed its deadline with no result, or was
   * never drawn for a day. If it has a result the caller must finalize instead.
   * @returns {{eligible, hasResult, phase, phaseName, outcome, deadline, secondsUntilDeadline,
   *   nextAction, rounds, passCount, reason, hint}}
   */
  async getCloseFailedEligibility(bountyId, submissionId) {
    const st = await this.getRoundState(bountyId, submissionId);
    if (st.error) {
      return { eligible: false, hasResult: false, reason: 'rpc_error', error: st.error, nextAction: null,
               hint: 'Could not read the round state; retry shortly.' };
    }
    const now = Math.floor(Date.now() / 1000);
    const base = {
      ...st,
      secondsUntilDeadline: st.deadline ? Math.max(0, st.deadline - now) : null,
    };
    if (!st.started) return { ...base, eligible: false, reason: 'no_agg_id', hint: 'The evaluation was never started.' };
    if (st.hasResult) return { ...base, eligible: false, reason: 'result_available', hint: 'The jury produced a result — finalize this submission.' };
    if (st.nextAction === 'CLOSE_FAILED') {
      return { ...base, eligible: true, reason: st.phase === 8 ? 'failed' : st.phase === 9 ? 'cancelled' : 'dead',
               hint: 'The round has no result and can get none — closing it refunds what is left of the prepay; the submission may then re-run (it keeps its place and bond).' };
    }
    return { ...base, eligible: false, reason: 'round_open',
             hint: st.deadline ? `The round is still open (${st.phaseName}).` : 'The round is waiting to be drawn.' };
  }

  /** v1 name: the gate now comes from the lens, keyed by bounty and submission. */
  async getForceFailEligibility(bountyId, submissionId) {
    return this.getCloseFailedEligibility(bountyId, submissionId);
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
  // The merged v2 ABI; positional reads b[0]/b[1]/b[6] below are unchanged.
  const c = new ethers.Contract(escrowAddress, BOUNTY_ESCROW_ABI, provider);
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

