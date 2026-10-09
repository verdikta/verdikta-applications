'use strict';
const { address } = require('./config');
const key = (contract, id) => `8453:${contract}:${id}`;
// Events are independently fetched from the allowlisted escrow, sorted by canonical log order.
function project(logs, startAt) {
  const bounties = new Map(),
    history = { creators: {}, hunters: {} },
    pending = new Map();
  for (let logIndex = 0; logIndex < logs.length; logIndex++) {
    const event = logs[logIndex],
      args = event.args,
      bountyKey = key(event.contract, args.bountyId),
      bounty = bounties.get(bountyKey);
    if (event.name === 'BountyCreated') {
      const creator = address(args.creator);
      if (event.at < startAt) history.creators[creator] = true;
      bounties.set(bountyKey, {
        key: bountyKey,
        chainId: 8453,
        contract: event.contract,
        id: args.bountyId,
        creator,
        createdAt: event.at,
        originalWei: args.payoutWei,
        evaluationCid: args.evaluationCid,
        threshold: Number(args.threshold),
        deadline: Number(args.submissionDeadline),
        createdBlock: event.blockNumber,
        createdTx: event.tx,
        submissions: [],
        refunded: false,
      });
    }
    if (event.name === 'SubmissionPrepared' && event.at < startAt)
      history.hunters[address(args.hunter)] = true;
    if (event.name === 'SubmissionPrepared' && bounty)
      bounty.submissions.push({
        id: args.submissionId,
        hunter: address(args.hunter),
        submittedAt: event.at,
        preparedTx: event.tx,
      });
    const submission = bounty?.submissions.find(
      (submission) => submission.id === args.submissionId,
    );
    if (event.name === 'WorkSubmitted' && submission) {
      submission.started = true;
      submission.startedAt = event.at;
      submission.startedTx = event.tx;
    }
    if (event.name === 'SubmissionFinalized' && submission) {
      submission.passed = args.passed === true;
      submission.finalizedAt = event.at;
      submission.finalizedTx = event.tx;
    }
    if (event.name === 'CreatorApproved' && submission) {
      submission.started = true;
      submission.startedAt = event.at;
      submission.passed = true;
      submission.finalizedAt = event.at;
      submission.finalizedTx = event.tx;
    }
    if (event.name === 'BountyClosed' && bounty) bounty.refunded = true;
    if (event.name === 'PayoutSent' && bounty) {
      const winner = address(args.winner),
        next = logs[logIndex + 1];
      // Current audited escrow emits PaymentDeferred immediately after the failed payout call.
      const deferred =
        next?.contract === event.contract &&
        next.tx === event.tx &&
        next.name === 'PaymentDeferred' &&
        address(next.args.to) === winner &&
        next.args.amount === args.amountWei;
      const payment = {
        winner,
        amount: args.amountWei,
        awardAt: event.at,
        awardTx: event.tx,
        at: deferred ? null : event.at,
        tx: deferred ? null : event.tx,
      };
      bounty.payment = payment;
      if (deferred) {
        const pendingKey = `${event.contract}:${winner}`;
        if (!pending.has(pendingKey)) pending.set(pendingKey, []);
        pending.get(pendingKey).push(payment);
      }
    }
    if (event.name === 'Withdrawn') {
      const pendingKey = `${event.contract}:${address(args.account)}`;
      // withdraw() transfers the entire account credit, including all earlier deferred bounties.
      for (const payment of pending.get(pendingKey) || []) {
        payment.at = event.at;
        payment.tx = event.tx;
      }
      pending.delete(pendingKey);
    }
  }
  return { bounties: [...bounties.values()], history };
}
module.exports = { project, key };
