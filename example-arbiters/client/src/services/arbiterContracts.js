/**
 * Arbiter contract write helpers (client-side, via the user's wallet signer).
 *
 * Owner-gated actions:
 *  - withdrawEth: claim ETH from the ReputationAggregator's pull-payment ledger
 *    (ethOwed) to the connected wallet. It holds arbiter earnings (base fees and
 *    bonuses, aggregated across all of the owner's operators), draw / promote
 *    rewards earned by calling drawJury or promote, and requester refunds — so
 *    this is a single per-wallet claim, not per operator.
 *  - claimLink: LEGACY — withdraw any LINK still sitting in an ArbiterOperator
 *    (Chainlink Operator) contract from the old LINK aggregator. Per operator.
 *  - v2 ReputationKeeper writes, all keyed by keyOf(oracle, jobId) and allowed to
 *    the operator contract's owner(): registerArbiter (stakes stakeRequirement
 *    wVDKA, pulled with transferFrom), requestExit then completeExit after the
 *    unbonding period (refunds the stake), setPaused, setFee, topUpStake,
 *    requestHealthCall.
 *
 * Each write does a staticCall dry-run first so on-chain revert reasons
 * (NotArbiterOwner, StillBonded, AlreadyRegistered, NothingOwed, …) surface before
 * we spend gas.
 */

import { ethers } from 'ethers';

const AGGREGATOR_ABI = [
  'function ethOwed(address) view returns (uint256)',
  'function withdrawEth()',
  'error NothingOwed()',
];

const OPERATOR_ABI = [
  'function withdrawable() view returns (uint256)',
  'function withdraw(address recipient, uint256 amount)',
];

// v2 ReputationKeeper. Custom errors are listed so ethers can name a revert.
const KEEPER_ABI = [
  'function registerArbiter(address oracle, bytes32 jobId, uint64 fee, uint64[] classes, bytes32 chainHead)',
  'function requestExit(bytes32 key)',
  'function completeExit(bytes32 key)',
  'function setPaused(bytes32 key, bool paused)',
  'function setFee(bytes32 key, uint64 fee)',
  'function topUpStake(bytes32 key, uint96 amount)',
  'function requestHealthCall(bytes32 key)',
  'function verdiktaToken() view returns (address)',
  'function stakeRequirement() view returns (uint256)',
  'function unbondingPeriod() view returns (uint40)',
  'function getArbiter(bytes32 key) view returns (tuple(address oracle, uint256 quality, uint256 timeliness, uint256 offenses, uint256 flags, uint256 blockedUntil, uint256 fee, uint256 callSentAt, uint256 callAnsweredAt, uint256 stake, uint256 checkpoints, uint256 exitAt))',
  'error NotArbiterOwner()',
  'error AlreadyRegistered()',
  'error AlreadyExiting()',
  'error NotRegistered()',
  'error BadClasses()',
  'error BadParams()',
  'error NotAuthorizedResponder()',
  'error StillBonded()',
  'error Blocked()',
  'error TransferFailed()',
];

/** Plain-language text for the contracts' custom errors. */
const CUSTOM_ERRORS = {
  NothingOwed: 'No ETH is currently available to claim.',
  NotArbiterOwner: 'The connected wallet does not own this operator contract (only its owner() may manage the arbiter).',
  AlreadyRegistered: 'This arbiter (operator + Job ID) is already registered. An exiting arbiter stays registered until its exit is completed.',
  AlreadyExiting: 'An exit is already in progress for this arbiter.',
  NotRegistered: 'This arbiter is not registered.',
  BadClasses: 'Give between 1 and 5 classes.',
  BadParams: 'Invalid parameters: the operator must be a contract and the fee must be above 0.',
  NotAuthorizedResponder: 'Only the operator owner or one of its node keys can ask for a health call.',
  StillBonded: 'The unbonding period has not ended yet.',
  Blocked: 'The arbiter is blocked; the exit can be completed once the block ends.',
  TransferFailed: 'The wVDKA transfer failed. Check your balance and the approval.',
};

// wVDKA (stake token) — only the bits the registration and top-up flows need.
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

/** Map ethers/wallet errors to a concise, user-facing message. */
function friendlyError(error) {
  if (error?.code === 'ACTION_REJECTED' || error?.code === 4001) {
    return new Error('Transaction rejected in wallet.');
  }
  if (error?.code === 'INSUFFICIENT_FUNDS') {
    return new Error('Connected wallet has insufficient ETH to cover this transfer plus gas.');
  }
  const errName = error?.revert?.name;
  if (errName && CUSTOM_ERRORS[errName]) return new Error(CUSTOM_ERRORS[errName]);
  const reason =
    error?.reason ||
    error?.revert?.args?.[0] ||
    error?.shortMessage ||
    error?.info?.error?.message;
  // ethers surfaces a failed gas estimate as "missing revert data", which is
  // meaningless to the user; for a plain transfer the practical cause is a
  // short ETH balance.
  if (reason && /missing revert data/i.test(reason)) {
    return new Error('Could not estimate the transaction — the connected wallet is likely short on ETH for the transfer plus gas.');
  }
  if (reason) return new Error(reason);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Withdraw the connected wallet's ETH from the aggregator's pull-payment ledger
 * (ethOwed). withdrawEth() always pays msg.sender its entire ethOwed balance — there is no
 * recipient/amount to pass. Reverts with NothingOwed if the balance is zero (surfaced by
 * the staticCall dry-run before spending gas).
 * @returns {Promise<{txHash: string, amount: bigint}>}
 */
export async function withdrawEth({ signer, aggregatorAddress }) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);
  let amount = 0n;
  try {
    amount = await aggregator.ethOwed(await signer.getAddress());
  } catch {
    // Non-fatal: the withdraw staticCall below is the authoritative guard.
  }
  if (amount === 0n) throw new Error('No ETH is currently available to claim.');

  try {
    await aggregator.withdrawEth.staticCall();
    const tx = await aggregator.withdrawEth();
    const receipt = await tx.wait();
    return { txHash: receipt.hash, amount };
  } catch (error) {
    throw friendlyError(error);
  }
}

/**
 * LEGACY: withdraw all currently-claimable LINK from an operator contract to `recipient`
 * (the connected owner). Reads the live withdrawable balance first. Under the ETH
 * aggregator operators accrue no new LINK; this only drains balances left from the old
 * LINK aggregator.
 * @returns {Promise<{txHash: string, amount: bigint}>}
 */
export async function claimLink({ signer, operatorAddress, recipient }) {
  const operator = new ethers.Contract(operatorAddress, OPERATOR_ABI, signer);
  let amount;
  try {
    amount = await operator.withdrawable();
  } catch (error) {
    throw friendlyError(error);
  }
  if (amount === 0n) throw new Error('No LINK is currently available to claim.');

  try {
    await operator.withdraw.staticCall(recipient, amount);
    const tx = await operator.withdraw(recipient, amount);
    const receipt = await tx.wait();
    return { txHash: receipt.hash, amount };
  } catch (error) {
    throw friendlyError(error);
  }
}

/** A keeper write with a staticCall dry-run first. */
async function keeperWrite({ signer, keeperAddress }, method, args) {
  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, signer);
  try {
    await keeper[method].staticCall(...args);
    const tx = await keeper[method](...args);
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  } catch (error) {
    throw friendlyError(error);
  }
}

/** The keeper's key for (oracle, jobId): keccak256(abi.encodePacked(oracle, jobId)). */
export function arbiterKey(oracle, jobId) {
  return ethers.solidityPackedKeccak256(['address', 'bytes32'], [oracle, jobId]);
}

/**
 * Start unbonding: the arbiter stops being selected at once, but blocks and bans
 * still apply until completeExit, allowed from exitAt = now + unbondingPeriod.
 * @returns {Promise<{txHash: string}>}
 */
export function requestExit({ signer, keeperAddress, key }) {
  return keeperWrite({ signer, keeperAddress }, 'requestExit', [key]);
}

/**
 * Finish unbonding: refunds the remaining stake to the operator's owner and frees
 * the arbiter's class slots. Reverts (StillBonded) before exitAt, or (Blocked)
 * while the arbiter is blocked.
 * @returns {Promise<{txHash: string}>}
 */
export function completeExit({ signer, keeperAddress, key }) {
  return keeperWrite({ signer, keeperAddress }, 'completeExit', [key]);
}

/** Pause (never selected while paused) or resume an arbiter. */
export function setPaused({ signer, keeperAddress, key, paused }) {
  return keeperWrite({ signer, keeperAddress }, 'setPaused', [key, paused]);
}

/** Change the posted fee (wei, bigint; uint64 on-chain). */
export function setFee({ signer, keeperAddress, key, fee }) {
  return keeperWrite({ signer, keeperAddress }, 'setFee', [key, fee]);
}

/** Add wVDKA to the stake (wei, bigint). Needs an allowance first (see approveStake). */
export function topUpStake({ signer, keeperAddress, key, amount }) {
  return keeperWrite({ signer, keeperAddress }, 'topUpStake', [key, amount]);
}

/**
 * Ask the keeper to send this arbiter a health call (the self-service call), e.g.
 * to end a freeze after a node restart; the node's health job answers it.
 * @returns {Promise<{txHash: string}>}
 */
export function requestHealthCall({ signer, keeperAddress, key }) {
  return keeperWrite({ signer, keeperAddress }, 'requestHealthCall', [key]);
}

/**
 * Read what a stake-pulling step (registerArbiter, topUpStake) needs to decide
 * whether a wVDKA approval is required and whether the owner can cover it:
 *  - tokenAddress: the wVDKA stake token the keeper pulls from (transferFrom)
 *  - stakeRequired: stakeRequirement (bigint, 100e18 by default)
 *  - unbondingPeriod: seconds between requestExit and completeExit (number|null)
 *  - arbiter: getArbiter(keyOf(oracle, jobId)) when both are given, else null.
 *    Its flags say whether it is still registered (an exiting arbiter is, until
 *    completeExit), its stake is what completeExit will refund, and a key that
 *    registered before keeps its scores and offenses.
 *  - allowance: current owner→keeper allowance (bigint)
 *  - balance: owner's wVDKA balance (bigint)
 *  - ethBalance / gasPrice: for the best-effort "enough ETH for gas?" warning
 * @returns {Promise<object>}
 */
export async function getStakeContext({ signer, keeperAddress, owner, oracle, jobId }) {
  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, signer);
  let tokenAddress;
  let stakeRequired;
  try {
    [tokenAddress, stakeRequired] = await Promise.all([
      keeper.verdiktaToken(),
      keeper.stakeRequirement(),
    ]);
  } catch (error) {
    throw friendlyError(error);
  }
  const unbondingPeriod = await keeper.unbondingPeriod().then(Number).catch(() => null);
  let arbiter = null;
  if (oracle && jobId) {
    arbiter = await keeper
      .getArbiter(arbiterKey(oracle, jobId))
      .then((a) => ({
        flags: Number(a.flags),
        stake: a.stake,
        exitAt: Number(a.exitAt),
        blockedUntil: Number(a.blockedUntil),
        quality: Number(a.quality),
        timeliness: Number(a.timeliness),
        offenses: Number(a.offenses),
        checkpoints: Number(a.checkpoints),
      }))
      .catch(() => null);
  }
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const provider = signer?.provider ?? null;
  // ETH balance + gas price feed a best-effort gas-sufficiency warning; all
  // .catch-guarded so a read failure degrades to "no warning", never an error.
  const [allowance, balance, ethBalance, feeData] = await Promise.all([
    token.allowance(owner, keeperAddress).catch(() => 0n),
    token.balanceOf(owner).catch(() => 0n),
    provider ? provider.getBalance(owner).catch(() => 0n) : Promise.resolve(0n),
    provider ? provider.getFeeData().catch(() => null) : Promise.resolve(null),
  ]);
  const gasPrice = feeData ? (feeData.maxFeePerGas ?? feeData.gasPrice ?? null) : null;
  return { tokenAddress, stakeRequired, unbondingPeriod, arbiter, allowance, balance, ethBalance, gasPrice };
}

/**
 * Approve the keeper to pull `amount` wVDKA from the connected owner. Required
 * before registerArbiter and topUpStake, which stake via transferFrom.
 * @returns {Promise<{txHash: string}>}
 */
export async function approveStake({ signer, tokenAddress, keeperAddress, amount }) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  try {
    const tx = await token.approve(keeperAddress, amount);
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  } catch (error) {
    throw friendlyError(error);
  }
}

/**
 * Register an (oracle, jobId) on the keeper, staking stakeRequirement wVDKA.
 *
 * Always registers with chainHead = 0x00…00. The hash chain behind the health
 * calls lives on the arbiter's node, which a browser cannot hold. The keeper
 * accepts head 0 by starting the arbiter frozen in re-sync (flag 64): it is not
 * selectable until its node's health job re-syncs onto a fresh chain and answers
 * a health call, which it does on its own within a minute or so of the job
 * running. A key that registered before keeps its scores and offenses.
 *
 * `fee` is a bigint in wei (uint64 on-chain); `classes` an array of 1–5 numbers.
 * Reverts (surfaced by the staticCall) if already registered, the fee is 0, the
 * wallet does not own the operator, or the stake allowance/balance is short.
 * Pass `afterExit` when completeExit was sent just before (see the retry below).
 * @returns {Promise<{txHash: string, key: string}>}
 */
export async function registerArbiter({ signer, keeperAddress, oracle, jobId, fee, classes, afterExit = false }) {
  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, signer);
  const args = [oracle, jobId, fee, classes, ethers.ZeroHash];

  // Dry-run first so revert reasons surface before we spend gas. Right after a
  // completeExit in the re-register flow, a load-balanced public RPC can still
  // serve state a block or two behind, so the dry-run reverts AlreadyRegistered
  // although the exit has landed. That is transient: retry it over a bounded
  // window until the reading node catches up. Any other revert is surfaced at once.
  const deadline = Date.now() + 45000;
  for (;;) {
    try {
      await keeper.registerArbiter.staticCall(...args);
      break;
    } catch (error) {
      if (afterExit && error?.revert?.name === 'AlreadyRegistered' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw friendlyError(error);
    }
  }

  try {
    const tx = await keeper.registerArbiter(...args);
    const receipt = await tx.wait();
    return { txHash: receipt.hash, key: arbiterKey(oracle, jobId) };
  } catch (error) {
    throw friendlyError(error);
  }
}

/**
 * Send ETH from the connected wallet to `to` (used to fund an arbiter node's
 * sending keys). `amountEth` is a decimal string/number.
 * @returns {Promise<{txHash: string}>}
 */
export async function sendEth({ signer, to, amountEth }) {
  try {
    // A plain EOA→EOA transfer always costs exactly 21000 gas. Setting the
    // limit explicitly skips eth_estimateGas, whose failure path surfaces as
    // the opaque "missing revert data" CALL_EXCEPTION (e.g. when the wallet
    // is short on ETH for value + fees while topping up multiple keys).
    const tx = await signer.sendTransaction({
      to,
      value: ethers.parseEther(String(amountEth)),
      gasLimit: 21000n,
    });
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  } catch (error) {
    throw friendlyError(error);
  }
}
