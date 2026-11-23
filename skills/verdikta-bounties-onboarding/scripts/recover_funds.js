#!/usr/bin/env node
// Explicit maintenance: close an expired bounty or withdraw this signer's pull-ledger ETH.
// Closing this wallet's own expired bounty first clears the claims still pending on it (finalizeSubmission for a
// stored result that does not pass, closeFailedRound for a round with no result that can get none, expireRerun for a
// re-run that can no longer happen): gas-only calls covered by the same --yes.
import { Contract } from 'ethers';
import { isMain } from './_cli.js';
import { abi, iface, deployments, reviewedApiOrigin, assertClearable, clearingCall, CLEARING_METHODS, escrowAddress } from './_transaction-guards.js';

export async function runRecover(lib, { withdraw = false, close = null, contract = (address, contractAbi, provider) => new Contract(address, contractAbi, provider), log = console.log } = {}) {
  const { getNetwork, providerFor, loadWallet, preflightDeployment, loadSpendPolicy, sendTx } = lib;
  const jobId = close == null ? null : String(close);
  if (Boolean(withdraw) === (jobId != null)) throw new Error('Select exactly --withdraw OR --close BOUNTY_ID');
  const network = getNetwork(), escrowAt = escrowAddress(network), provider = providerFor(network);
  try {
    await preflightDeployment(network, provider, reviewedApiOrigin(network, process.env.VERDIKTA_BOUNTIES_BASE_URL));
    const policy = await loadSpendPolicy(), signer = (await loadWallet()).connect(provider);
    const escrow = contract(escrowAt, abi, provider);
    const send = (method, args, review = []) => sendTx(signer, method, { to: escrowAt, chainId: deployments[network].chainId, data: iface.encodeFunctionData(method, args), value: '0' }, { network, args, policy, review });
    if (withdraw) {
      if (await escrow.withdrawable(signer.address) === 0n) throw new Error('No pull-ledger balance for this signer');
      return await send('withdraw', []);
    }
    if (!/^[0-9]+$/.test(jobId)) throw new Error('--close needs a bounty number');
    if (!await closable(escrow, jobId)) {
      const cleared = await clearClaims({ escrow, provider, signer, jobId, send, log, dryRun: lib.isDryRun?.() ?? false });
      if (cleared === null) return null;
      if (!await closable(escrow, jobId)) throw new Error(`Cleared ${cleared} claim(s) on bounty #${jobId}, but it still cannot be closed; run the close again`);
    }
    return await send('closeExpiredBounty', [BigInt(jobId)]);
  } finally { provider.destroy(); }
}

// closeExpiredBounty needs the pending list empty: rounds in flight AND submissions awaiting a re-run. The lens's
// canBeClosed counts only rounds in flight (activeEvaluations), so an AwaitingRerun claim would pass it and the close
// would revert; both are checked.
async function closable(escrow, jobId) {
  const [can, pending] = await Promise.all([escrow.canBeClosed(jobId), escrow.pendingSubmissionIds(jobId)]);
  return can && pending.length === 0;
}

// Every pending claim gets its clearing call planned first; nothing is sent unless all of them can be cleared now.
async function clearClaims({ escrow, provider, signer, jobId, send, log, dryRun }) {
  const bounty = await escrow.getBounty(jobId), chainNow = (await provider.getBlock('latest')).timestamp;
  assertClearable({ bounty, signer: signer.address, chainNow });
  const pending = [...await escrow.pendingSubmissionIds(jobId)];
  if (!pending.length) throw new Error(`Bounty #${jobId} cannot be closed yet, and no claim is pending on it; inspect it before retrying`);
  const plans = [];
  for (const id of pending) {
    const [next, result] = await Promise.all([escrow.nextAction(jobId, id), escrow.getOracleResult(jobId, id)]);
    plans.push({ id, result, ...clearingCall({ bounty, signer: signer.address, chainNow, submissionId: id, next, result }) });
  }
  const stops = plans.filter((p) => p.stop), waits = plans.filter((p) => p.wait);
  if (stops.length) throw new Error(`Bounty #${jobId} was not closed and nothing was sent:\n  - ${stops.map((p) => p.stop).join('\n  - ')}`);
  if (waits.length) {
    // A round still moving has a result, or can be closed (CLOSE_FAILED), by its deadline (a day after the request
    // while undrawn): the latest of those is when every claim can be cleared.
    const times = waits.map((p) => p.retryAfter);
    const after = times.some((t) => t == null) ? null : Math.max(...times, Number(chainNow));
    throw new Error(`Bounty #${jobId} was not closed and nothing was sent: ${waits.map((p) => p.wait).join('; ')}. Retry the close ${after == null ? 'in about 10 minutes' : `after ${new Date(after * 1000).toISOString()}`}`);
  }
  log(`Bounty #${jobId} has ${plans.length} pending claim(s) blocking the close. Clearing them first (gas only; none of these calls can change who wins):`);
  for (const p of plans) {
    if (!CLEARING_METHODS.includes(p.method)) throw new Error(`Refusing ${p.method}: not a clearing call`);
    log(`  submission ${p.id}: ${p.method}${p.outcome ? ` (${p.outcome})` : ''}`);
    await send(p.method, [BigInt(jobId), BigInt(p.id)], [`Clear claim ${p.id} on your expired bounty #${jobId} before closing it`]);
  }
  if (dryRun) { log(`Dry run: the close follows once these ${plans.length} clearing transaction(s) are mined.`); return null; }
  return plans.length;
}

if (isMain(import.meta.url)) {
  const lib = await import('./_lib.js');
  await runRecover(lib, { withdraw: lib.hasFlag('withdraw'), close: lib.arg('close') });
}
