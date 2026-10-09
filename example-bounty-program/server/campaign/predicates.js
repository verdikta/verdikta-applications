'use strict';
const { DAY, CASH_QUESTS } = require('./config');
const { emptyExceptions } = require('./exceptions');
const timed = (timestamp, config) =>
  Number.isFinite(timestamp) &&
  timestamp >= config.startAt &&
  timestamp < config.endAt;
const fail = (code) => ({ ok: false, code, evidence: [] });
const pass = (bounties) => ({
  ok: true,
  code: 'VERIFIED',
  evidence: bounties.map((bounty) => bounty.key),
});
function eligibility(config, state, quest, wallet, now) {
  if (now < config.startAt) return fail('CAMPAIGN_NOT_STARTED');
  if (now >= config.claimEndAt) return fail('CLAIM_WINDOW_CLOSED');
  if (state.chain.error === 'EXCEPTIONS_FILE_INVALID')
    return fail('EXCEPTIONS_FILE_INVALID');
  if (
    state.chain.error ||
    now - state.chain.checkedAt > config.maxAgeSeconds ||
    now < state.chain.checkedAt
  )
    return fail('INDEX_NOT_READY_RETRY');
  const exceptions = state.exceptions || emptyExceptions();
  if (config.teamWallets.includes(wallet)) return fail('TEAM_WALLET_EXCLUDED');
  if (exceptions.holdWallets[wallet]) return fail('WALLET_HELD_FOR_REVIEW');
  const isVerdiktaAgent = (hunter) =>
    config.teamWallets.includes(hunter) &&
    (config.verdiktaAgentWallets || []).includes(hunter);
  const creatorPaymentQuest = ['Q4', 'Q5', 'Q6', 'Q15'].includes(quest);
  const eligibleCounterparty = (creator, hunter, allowAgent = false) =>
    creator !== hunter &&
    (!config.teamWallets.includes(hunter) ||
      (allowAgent &&
        !config.teamWallets.includes(creator) &&
        isVerdiktaAgent(hunter))) &&
    !exceptions.holdWallets[hunter] &&
    !(
      state.wallets[creator] &&
      state.wallets[hunter] &&
      state.wallets[creator] === state.wallets[hunter]
    );
  const windowValid = (bounty) =>
    bounty.deadline - bounty.createdAt >= config.minimumWindowHours * 3600 &&
    bounty.deadline - bounty.createdAt <= config.maximumWindowHours * 3600;
  const cashQuest = CASH_QUESTS.includes(quest);
  const templateQuest = ['Q14', 'Q15'].includes(quest);
  const kindValid = (bounty) =>
    bounty.evidence?.kind === 'workOrder' ||
    (!templateQuest && bounty.evidence?.kind === 'standard');
  const campaignBounties = state.bounties.filter(
    (bounty) =>
      bounty.chainId === config.deployment.chainId &&
      bounty.contract === config.deployment.address &&
      timed(bounty.createdAt, config),
  );
  const related = campaignBounties.filter((bounty) =>
    ['Q8', 'Q9', 'Q10'].includes(quest)
      ? bounty.submissions.some((submission) => submission.hunter === wallet)
      : bounty.creator === wallet,
  );
  const funded = campaignBounties.filter(
    (bounty) =>
      BigInt(bounty.originalWei) >= BigInt(config.minimumWei) &&
      (['Q3', 'Q14'].includes(quest) || !bounty.refunded) &&
      bounty.open &&
      windowValid(bounty) &&
      bounty.evidence?.ok &&
      kindValid(bounty) &&
      !bounty.duplicate &&
      !exceptions.denyBounties[bounty.key] &&
      !exceptions.holdWallets[bounty.creator],
  );
  const paid = (bounty) =>
    bounty.payment &&
    timed(bounty.payment.at, config) &&
    BigInt(bounty.payment.amount) > 0n &&
    eligibleCounterparty(
      bounty.creator,
      bounty.payment.winner,
      creatorPaymentQuest,
    );
  const creatorPass = (bounties, paidBounties = bounties) => {
    const agentAssistedEvidence = paidBounties
      .filter((bounty) => isVerdiktaAgent(bounty.payment.winner))
      .map((bounty) => ({
        bountyKey: bounty.key,
        hunter: bounty.payment.winner,
        amountWei: bounty.payment.amount,
        paidAt: bounty.payment.at,
        paymentTx: bounty.payment.tx ?? null,
      }));
    return {
      ...pass(bounties),
      creatorCompletionKind: agentAssistedEvidence.length
        ? 'agent-assisted'
        : 'organic',
      agentAssistedEvidence,
    };
  };
  const distinct = (first, second) =>
    first.key !== second.key &&
    first.evidence.scopeDigest !== second.evidence.scopeDigest;
  const created = funded.filter((bounty) => bounty.creator === wallet);
  const pairs = created.flatMap((first) =>
    created
      .filter(
        (second) =>
          distinct(first, second) &&
          paid(first) &&
          second.createdAt > first.payment.at &&
          second.createdAt - first.createdAt >= 3 * DAY,
      )
      .map((second) => [first, second]),
  );
  const passing = funded.flatMap((bounty) =>
    bounty.submissions
      .filter(
        (submission) =>
          submission.hunter === wallet &&
          submission.started &&
          submission.passed &&
          submission.packageValid &&
          timed(submission.submittedAt, config) &&
          timed(submission.finalizedAt, config) &&
          eligibleCounterparty(bounty.creator, wallet),
      )
      .map((submission) => ({ bounty, submission })),
  );
  if (cashQuest) {
    const role = quest === 'Q10' ? 'hunters' : 'creators';
    if (!state.chain.historyComplete) return fail('HISTORY_INCOMPLETE_RETRY');
    if (
      state.history[role][wallet] ||
      config.priorWallets[role].includes(wallet)
    )
      return fail('PRE_CAMPAIGN_ACTIVITY');
  }
  if (['Q3', 'Q14'].includes(quest) && created.length)
    return pass([created[0]]);
  if (quest === 'Q4') {
    const paidBounty = created.find(paid);
    if (paidBounty) return creatorPass([paidBounty]);
  }
  if (quest === 'Q5' && pairs.length)
    return creatorPass(pairs[0], [pairs[0][0]]);
  if (quest === 'Q6') {
    const pair = pairs.find(
      ([first, second]) =>
        paid(second) &&
        (first.payment.winner !== second.payment.winner ||
          isVerdiktaAgent(first.payment.winner)),
    );
    if (pair) return creatorPass(pair);
  }
  if (quest === 'Q8' && passing.length) return pass([passing[0].bounty]);
  if (quest === 'Q9') {
    const paidResult = passing.find(
      ({ bounty }) => paid(bounty) && bounty.payment.winner === wallet,
    );
    if (paidResult) return pass([paidResult.bounty]);
  }
  if (quest === 'Q10') {
    for (const first of passing) {
      for (const second of passing) {
        if (
          distinct(first.bounty, second.bounty) &&
          first.bounty.creator !== second.bounty.creator &&
          second.submission.submittedAt - first.submission.submittedAt >=
            3 * DAY &&
          !config.teamWallets.includes(second.bounty.creator) &&
          [first, second].some(
            (result) =>
              paid(result.bounty) && result.bounty.payment.winner === wallet,
          )
        )
          return pass([first.bounty, second.bounty]);
      }
    }
  }
  if (quest === 'Q15') {
    const pair = pairs.find(
      ([first, second]) =>
        first.evidence.templateId !== second.evidence.templateId,
    );
    if (pair) return creatorPass(pair, [pair[0]]);
  }
  if (!related.length) return fail('NO_MATCHING_CHAIN_ACTIVITY');
  if (related.every((bounty) => !!exceptions.denyBounties[bounty.key]))
    return fail('BOUNTY_DENIED');
  if (related.some((bounty) => bounty.duplicate))
    return fail('DUPLICATE_SCOPE_REVIEW');
  if (related.every((bounty) => !windowValid(bounty)))
    return fail('SUBMISSION_WINDOW_OUT_OF_RANGE');
  if (
    related.every(
      (bounty) => BigInt(bounty.originalWei) < BigInt(config.minimumWei),
    )
  )
    return fail('MINIMUM_ORIGINAL_FUNDING_NOT_MET');
  if (
    related.some((bounty) =>
      !bounty.evidence?.ok || !['standard', 'workOrder'].includes(bounty.evidence.kind),
    )
  )
    return fail('EVIDENCE_UNAVAILABLE_OR_INVALID');
  if (templateQuest && related.every((bounty) => !kindValid(bounty)))
    return fail('APPROVED_WORK_ORDER_REQUIRED');
  if (
    related.every((bounty) => bounty.refunded) &&
    !['Q3', 'Q14'].includes(quest)
  )
    return fail('BOUNTY_REFUNDED');
  if (['Q5', 'Q6', 'Q10', 'Q15'].includes(quest))
    return fail('REPEAT_TIMING_SCOPE_OR_OUTCOME_NOT_MET');
  if (['Q4', 'Q9'].includes(quest))
    return fail('PAYMENT_NOT_RECEIVED_IN_WINDOW');
  if (quest === 'Q8') return fail('PASSING_PACKAGE_PENDING');
  return fail('MILESTONE_NOT_MET_OR_PENDING');
}
module.exports = { eligibility, timed };
