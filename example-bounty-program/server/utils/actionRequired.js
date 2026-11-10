/**
 * Creator "action required" report: expired bounties that still need the
 * creator to close them (or resolve pending submissions first).
 *
 * Backs GET /api/jobs/mine/action-required, which feeds the My Bounties
 * banner and the header badge. A chain read that fails must never be counted
 * as "needs attention": before 2026-11-10 an RPC failure pushed the bounty
 * into `count` (false "expired bounty needs your attention" banner for
 * bounties already closed/awarded on-chain), and a failed submission read was
 * silently dropped (false "Ready to close"). Bounties whose state could not be
 * read are now reported separately as `unverified`.
 */

const { ethers } = require('ethers');

const BOUNTY_STATUS = ['Open', 'Awarded', 'Closed'];
const PENDING_VERDIKTA = 1;
// Local statuses that are only ever set from chain facts (PayoutSent /
// BountyClosed events, or the sync reconcile's on-chain read). On-chain
// terminal states are irreversible, so these bounties need no RPC at all.
const LOCAL_TERMINAL = new Set(['AWARDED', 'CLOSED']);

async function withRetry(fn, tries = 2, delayMs = 300) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Read one expired bounty's on-chain state.
 * @returns {{ state: 'resolved' } |
 *           { state: 'ready', payoutWei: bigint } |
 *           { state: 'blocked', pendingSubmissions: object[] } |
 *           { state: 'unverified', error: string }}
 */
async function checkExpiredBounty({ contract, cs, bountyId, nowSeconds, retryDelayMs }) {
  const retry = (fn) => withRetry(fn, 2, retryDelayMs);
  let chainBounty;
  let pendingIds;
  try {
    chainBounty = await retry(() => contract.getBounty(bountyId));
  } catch (err) {
    return { state: 'unverified', error: err.message };
  }
  if (BOUNTY_STATUS[Number(chainBounty.status)] !== 'Open') return { state: 'resolved' };

  try {
    pendingIds = (await retry(() => contract.pendingSubmissionIds(bountyId))).map(Number);
  } catch (err) {
    return { state: 'unverified', error: err.message };
  }

  const pendingSubmissions = [];
  for (const id of pendingIds) {
    let chainSub;
    try {
      chainSub = await retry(() => contract.getSubmission(bountyId, id));
    } catch (err) {
      // Can't tell whether this submission still blocks close — don't guess.
      return { state: 'unverified', error: err.message };
    }
    if (Number(chainSub.status) !== PENDING_VERDIKTA) continue;
    const submittedAt = Number(chainSub.submittedAt);
    // Aggregator-state gate (same rule as failTimedOutSubmission). On RPC
    // error it returns reason 'rpc_error' with eligible/hasResult false, i.e.
    // action 'wait' — the bounty is still correctly reported as blocked.
    const gate = await cs.getForceFailEligibility(chainSub.verdiktaAggId);
    pendingSubmissions.push({
      submissionId: id,
      hunter: chainSub.hunter,
      submittedAt,
      ageMinutes: Math.floor((nowSeconds - submittedAt) / 60),
      timeoutEligible: gate.eligible === true,
      hasResult: gate.hasResult === true,
      action: gate.hasResult ? 'finalize' : (gate.eligible ? 'timeout' : 'wait'),
      secondsUntilTimeout: gate.secondsUntilTimeout ?? null,
      forceFail: gate
    });
  }

  if (pendingSubmissions.length > 0) return { state: 'blocked', pendingSubmissions };
  let payoutWei = 0n;
  try { payoutWei = BigInt(chainBounty.payoutWei.toString()); } catch (_) { /* totals only */ }
  return { state: 'ready', payoutWei };
}

/**
 * Build the /mine/action-required response body.
 * `count`, `readyToCloseCount` and `blockedCount` cover only bounties whose
 * on-chain state was read; `unverified` lists the ones that could not be.
 */
async function buildActionRequired({ jobs, creator, contract, cs, nowSeconds, retryDelayMs }) {
  const creatorLc = creator.toLowerCase();
  const bounties = [];
  const unverified = [];
  let totalReclaimableWei = 0n;

  for (const job of jobs) {
    if (!job.creator || job.creator.toLowerCase() !== creatorLc) continue;
    const deadline = job.submissionCloseTime || 0;
    if (deadline === 0 || nowSeconds < deadline) continue;
    if (!job.onChain && !job.syncedFromBlockchain) continue;
    if (LOCAL_TERMINAL.has(String(job.status || '').toUpperCase())) continue;

    const entry = {
      jobId: job.jobId,
      title: job.title,
      bountyAmount: job.bountyAmount,
      bountyAmountWei: job.bountyAmountWei,
      deadline,
      expiredMinutesAgo: Math.floor((nowSeconds - deadline) / 60),
      canClose: false,
      blockedBy: null,
      pendingSubmissions: []
    };

    const result = contract
      ? await checkExpiredBounty({ contract, cs, bountyId: job.jobId, nowSeconds, retryDelayMs })
      : { state: 'unverified', error: 'Chain read unavailable' };

    if (result.state === 'resolved') continue; // Closed/awarded on-chain — nothing to do
    if (result.state === 'unverified') {
      unverified.push({ ...entry, unverified: true, blockedBy: `Could not read on-chain state: ${result.error}` });
      continue;
    }
    if (result.state === 'blocked') {
      entry.pendingSubmissions = result.pendingSubmissions;
      entry.blockedBy = `${result.pendingSubmissions.length} submission(s) still pending evaluation`;
    } else {
      entry.canClose = true;
      totalReclaimableWei += result.payoutWei;
    }
    bounties.push(entry);
  }

  return {
    success: true,
    creator,
    count: bounties.length,
    readyToCloseCount: bounties.filter(b => b.canClose).length,
    blockedCount: bounties.filter(b => !b.canClose).length,
    totalReclaimableWei: totalReclaimableWei.toString(),
    totalReclaimableEth: ethers.formatEther(totalReclaimableWei),
    bounties,
    unverifiedCount: unverified.length,
    unverified
  };
}

module.exports = { buildActionRequired, checkExpiredBounty, withRetry, LOCAL_TERMINAL };
