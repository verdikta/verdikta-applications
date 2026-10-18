/**
 * Which earlier submissions are holding up a passing finalize.
 *
 * BountyEscrow pays by submission index: finalizeSubmission on a passing result reverts
 * "earlier submission pending - retry after it resolves" while a LOWER-index submission
 * by ANOTHER hunter is still PendingVerdikta (see _hasEarlierPendingByOther). That
 * earlier submission may still be in evaluation, or its oracle may have answered long
 * ago (usually a failing score nobody bothered to finalize). In the second case nothing
 * changes until somebody sends one transaction, which anyone may do: finalize it, or
 * force-fail it if the round ended with no result. Doing so cannot change who wins (the
 * contract pays the same submission whatever order the calls arrive in) and refunds that
 * hunter's unused prepay. This module lists the blockers and what each one needs.
 *
 * 2026-10-18: mainnet bounty 255 — sub 1 passed (AWAIT_EARLIER) behind sub 0, which had
 * a failing result in for hours (FINALIZE).
 */

const { ethers } = require('ethers');

// nextAction values that a single permissionless transaction resolves right now.
const RESOLVE_CALLS = {
  FINALIZE: 'finalizeSubmission',
  FORCE_FAIL: 'failTimedOutSubmission',
};

const RESOLVE_IFACE = new ethers.Interface([
  'function finalizeSubmission(uint256 bountyId, uint256 submissionId)',
  'function failTimedOutSubmission(uint256 bountyId, uint256 submissionId)',
]);

/**
 * Earlier in-flight submissions by other hunters, lowest index first, each with the
 * contract's nextAction for it.
 *
 * @param {object} contract  BountyEscrow with pendingSubmissionIds, getSubmission, nextAction
 * @returns {Promise<Array<{ submissionId: number, hunter: string, nextAction: string, method: string|null }>>}
 */
async function findFinalizeBlockers(contract, bountyId, submissionId) {
  const subId = Number(submissionId);
  const [pending, me] = await Promise.all([
    contract.pendingSubmissionIds(bountyId),
    contract.getSubmission(bountyId, subId),
  ]);
  const hunter = String(me.hunter).toLowerCase();
  const earlier = [...pending].map(Number).filter((id) => id < subId).sort((a, b) => a - b);

  const rows = await Promise.all(earlier.map(async (id) => {
    const s = await contract.getSubmission(bountyId, id);
    if (String(s.hunter).toLowerCase() === hunter) return null;   // same hunter never blocks
    const nextAction = String(await contract.nextAction(bountyId, id));
    return { submissionId: id, hunter: s.hunter, nextAction, method: RESOLVE_CALLS[nextAction] || null };
  }));
  return rows.filter(Boolean);
}

/** Calldata that resolves one blocker, or null when it can only be waited out. */
function blockerCalldata(bountyId, blocker) {
  if (!blocker.method) return null;
  return RESOLVE_IFACE.encodeFunctionData(blocker.method, [bountyId, blocker.submissionId]);
}

/** One sentence for people and agents: what to do about the blockers. */
function blockersHint(blockers) {
  if (!blockers.length) return null;
  const ids = (list) => list.map((b) => `#${b.submissionId}`).join(', ');
  const waiting = blockers.filter((b) => !b.method);
  const resolvable = blockers.filter((b) => b.method);
  if (waiting.length) {
    return `This passing result is kept, but payout waits for earlier submission(s) ${ids(waiting)} by another hunter, still in evaluation. ` +
      'Retry after they resolve: the oracle answers, or the round times out (about 5 minutes after it started) and anyone may force-fail it.' +
      (resolvable.length ? ` Earlier submission(s) ${ids(resolvable)} also need resolving; anyone may send their blockedBy transactions now.` : '');
  }
  return `This passing result is kept, but payout waits for earlier submission(s) ${ids(resolvable)} by another hunter. ` +
    'Their evaluation is over and only needs resolving, which anyone may do: send each blockedBy[].transaction ' +
    '(it cannot change who wins and refunds that hunter\'s unused prepay), then finalize this submission.';
}

module.exports = { RESOLVE_CALLS, findFinalizeBlockers, blockerCalldata, blockersHint };
