/**
 * Arbiter contract write helpers (client-side, via the user's wallet signer).
 *
 * Two owner-gated actions:
 *  - claimLink: withdraw earned LINK from an ArbiterOperator (Chainlink Operator)
 *    contract to the connected owner. Balance is per operator contract.
 *  - deregisterArbiter: deregister an (oracle, jobId) on the ReputationKeeper,
 *    which refunds the 100 wVDKA stake to the operator's owner.
 *
 * Each write does a staticCall dry-run first so on-chain require() reasons
 * ("Oracle is locked…", "Not authorized…") surface before we spend gas.
 */

import { ethers } from 'ethers';

const OPERATOR_ABI = [
  'function withdrawable() view returns (uint256)',
  'function withdraw(address recipient, uint256 amount)',
];

const KEEPER_ABI = [
  'function deregisterOracle(address _oracle, bytes32 _jobId)',
  'function registerOracle(address _oracle, bytes32 _jobId, uint256 fee, uint64[] _classes)',
  'function verdiktaToken() view returns (address)',
  'function STAKE_REQUIREMENT() view returns (uint256)',
  'function getOracleInfo(address _oracle, bytes32 _jobId) view returns (bool isActive, int256 qualityScore, int256 timelinessScore, uint256 callCount, bytes32 jobId, uint256 fee, uint256 stakeAmount, uint256 lockedUntil, bool blocked)',
];

// wVDKA (stake token) — only the bits the re-register flow needs.
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
  const reason =
    error?.reason ||
    error?.revert?.args?.[0] ||
    error?.shortMessage ||
    error?.info?.error?.message;
  if (reason) return new Error(reason);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Withdraw all currently-claimable LINK from an operator contract to `recipient`
 * (the connected owner). Reads the live withdrawable balance first.
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

/**
 * Deregister an arbiter (oracle, jobId), refunding the 100 wVDKA stake to the
 * owner. Reverts on-chain if the oracle is locked.
 * @returns {Promise<{txHash: string}>}
 */
export async function deregisterArbiter({ signer, keeperAddress, oracle, jobId }) {
  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, signer);
  try {
    await keeper.deregisterOracle.staticCall(oracle, jobId);
    const tx = await keeper.deregisterOracle(oracle, jobId);
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  } catch (error) {
    throw friendlyError(error);
  }
}

/**
 * Read what the re-register step needs to decide whether a wVDKA approval is
 * required and whether the owner can cover the stake:
 *  - tokenAddress: the wVDKA stake token the keeper pulls from (transferFrom)
 *  - stakeRequired: STAKE_REQUIREMENT (bigint, normally 100e18)
 *  - currentStake: the (oracle, jobId)'s on-chain stake, i.e. the amount that
 *    will be refunded on deregister. Normally == stakeRequired, but a future
 *    slashing path could leave it lower. Reads 0 when the record no longer
 *    exists (already deregistered) — callers treat that as "refund already
 *    received". Defaults to stakeRequired if the read throws (RPC hiccup) so a
 *    transient failure never false-blocks the flow. 0n when oracle/jobId absent.
 *  - allowance: current owner→keeper allowance (bigint)
 *  - balance: owner's wVDKA balance (bigint)
 *  - ethBalance: owner's native ETH balance (bigint) — for the gas-sufficiency
 *    warning; 0n if it can't be read.
 *  - gasPrice: current gas price in wei (bigint, maxFeePerGas ?? gasPrice), or
 *    null if unavailable. The caller turns these two into a "may not have enough
 *    ETH for gas" warning.
 * @returns {Promise<{tokenAddress: string, stakeRequired: bigint, currentStake: bigint, allowance: bigint, balance: bigint, ethBalance: bigint, gasPrice: (bigint|null)}>}
 */
export async function getStakeContext({ signer, keeperAddress, owner, oracle, jobId }) {
  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, signer);
  let tokenAddress;
  let stakeRequired;
  try {
    [tokenAddress, stakeRequired] = await Promise.all([
      keeper.verdiktaToken(),
      keeper.STAKE_REQUIREMENT(),
    ]);
  } catch (error) {
    throw friendlyError(error);
  }
  let currentStake = 0n;
  if (oracle && jobId) {
    // Index 6 is stakeAmount; default to stakeRequired only on read error so a
    // transient RPC failure preserves the historical (no-slash) behaviour.
    currentStake = await keeper
      .getOracleInfo(oracle, jobId)
      .then((info) => info.stakeAmount)
      .catch(() => stakeRequired);
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
  return { tokenAddress, stakeRequired, currentStake, allowance, balance, ethBalance, gasPrice };
}

/**
 * Approve the keeper to pull `amount` wVDKA from the connected owner. Required
 * before registerOracle, which stakes via transferFrom.
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
 * Register an (oracle, jobId) on the keeper, staking 100 wVDKA. Re-registering
 * a previously-deregistered pair starts its reputation fresh at zero (the
 * contract deletes the old record on deregister). `fee` is a bigint in wei;
 * `classes` an array of numbers. Reverts if already registered, fee is 0, or
 * the stake allowance/balance is insufficient — surfaced via the staticCall.
 * @returns {Promise<{txHash: string}>}
 */
export async function registerArbiter({ signer, keeperAddress, oracle, jobId, fee, classes }) {
  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, signer);
  try {
    await keeper.registerOracle.staticCall(oracle, jobId, fee, classes);
    const tx = await keeper.registerOracle(oracle, jobId, fee, classes);
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
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
    const tx = await signer.sendTransaction({ to, value: ethers.parseEther(String(amountEth)) });
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  } catch (error) {
    throw friendlyError(error);
  }
}
