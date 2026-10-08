'use strict';
const { address } = require('./config');
const key = (contract, id) => `8453:${contract}:${id}`;
// Events are independently fetched from the allowlisted escrow, sorted by canonical log order.
function project(logs, startAt) {
  const bounties = new Map(), history = { creators:{}, hunters:{} }, pending = new Map();
  for (let i = 0; i < logs.length; i++) {
    const e = logs[i], a = e.args, k = key(e.contract, a.bountyId), b = bounties.get(k);
    if (e.name === 'BountyCreated') {
      const creator = address(a.creator);
      if (e.at < startAt) history.creators[creator] = true;
      bounties.set(k, { key:k, chainId:8453, contract:e.contract, id:a.bountyId, creator, createdAt:e.at,
        originalWei:a.payoutWei, evaluationCid:a.evaluationCid, threshold:Number(a.threshold), deadline:Number(a.submissionDeadline),
        createdBlock:e.blockNumber, createdTx:e.tx, submissions:[], refunded:false });
    }
    if (e.name === 'SubmissionPrepared' && e.at < startAt) history.hunters[address(a.hunter)] = true;
    if (e.name === 'SubmissionPrepared' && b) b.submissions.push({ id:a.submissionId, hunter:address(a.hunter), submittedAt:e.at, preparedTx:e.tx });
    const s = b?.submissions.find(s => s.id === a.submissionId);
    if (e.name === 'WorkSubmitted' && s) { s.started = true; s.startedAt = e.at; s.startedTx = e.tx; }
    if (e.name === 'SubmissionFinalized' && s) { s.passed = a.passed === true; s.finalizedAt = e.at; s.finalizedTx = e.tx; }
    if (e.name === 'BountyClosed' && b) b.refunded = true;
    if (e.name === 'PayoutSent' && b) {
      const winner = address(a.winner), next = logs[i + 1];
      // Current audited escrow emits PaymentDeferred immediately after the failed payout call.
      const deferred = next?.contract === e.contract && next.tx === e.tx && next.name === 'PaymentDeferred'
        && address(next.args.to) === winner && next.args.amount === a.amountWei;
      const payment = { winner, amount:a.amountWei, awardAt:e.at, awardTx:e.tx, at:deferred ? null : e.at, tx:deferred ? null : e.tx };
      b.payment = payment;
      if (deferred) { const pk = `${e.contract}:${winner}`; if (!pending.has(pk)) pending.set(pk, []); pending.get(pk).push(payment); }
    }
    if (e.name === 'Withdrawn') {
      const pk = `${e.contract}:${address(a.account)}`;
      // withdraw() transfers the entire account credit, including all earlier deferred bounties.
      for (const p of pending.get(pk) || []) { p.at = e.at; p.tx = e.tx; }
      pending.delete(pk);
    }
  }
  return { bounties:[...bounties.values()], history };
}
module.exports = { project, key };
