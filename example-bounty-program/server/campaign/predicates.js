'use strict';
const { DAY } = require('./config');
const timed = (t, c) => Number.isFinite(t) && t >= c.startAt && t < c.endAt;
function eligibility(c, state, quest, wallet, now) {
  const fail = code => ({ ok: false, code, evidence: [] });
  const pass = rows => ({ ok: true, code: 'VERIFIED', evidence: rows.map(b => b.key) });
  if (now < c.startAt) return fail('CAMPAIGN_NOT_STARTED');
  if (now >= c.claimEndAt) return fail('CLAIM_WINDOW_CLOSED');
  if (state.chain.error || now - state.chain.checkedAt > c.maxAgeSeconds || now < state.chain.checkedAt) return fail('INDEX_NOT_READY_RETRY');
  if (c.teamWallets.includes(wallet)) return fail('TEAM_WALLET_EXCLUDED');
  if (state.conflicts[wallet]) return fail('IDENTITY_REVIEW_REQUIRED');
  const allowed = new Set(c.deployments.filter(d => d.campaign).map(d => `${d.chainId}:${d.address}`));
  const funded = state.bounties.filter(b => allowed.has(`${b.chainId}:${b.contract}`) && timed(b.createdAt, c)
    && BigInt(b.originalWei) >= BigInt(c.minimumWei) && !b.refunded && b.open
    && b.workOrder?.ok && b.review?.approved === true && !b.duplicate
    && b.deadline - b.createdAt >= 2 * DAY && b.deadline - b.createdAt <= 4 * DAY);
  const paid = b => b.payment && timed(b.payment.at, c) && b.payment.amount !== '0'
    && b.payment.winner !== b.creator && !c.teamWallets.includes(b.payment.winner)
    && !state.conflicts[b.payment.winner] && b.review.independentHunters?.includes(b.payment.winner);
  const created = funded.filter(b => b.creator === wallet);
  const newness = role => c.historyInventoryComplete && state.chain.historyComplete && !state.history[role][wallet];
  const pairs = created.flatMap(a => created.filter(b => a.key !== b.key && paid(a)
    && b.createdAt > a.payment.at && b.createdAt - a.createdAt >= 3 * DAY
    && a.workOrder.requestDigest !== b.workOrder.requestDigest
    && b.review.distinctFrom?.includes(a.key)).map(b => [a, b]));
  const passing = funded.flatMap(b => (b.submissions || []).filter(s => s.hunter === wallet
    && s.started && s.passed && s.packageValid && timed(s.submittedAt, c) && timed(s.finalizedAt, c)
    && b.creator !== wallet && b.review.independentHunters?.includes(wallet)).map(s => ({ b, s })));
  if (['Q4','Q6','Q10'].includes(quest)) {
    if (!c.historyInventoryComplete || !state.chain.historyComplete) return fail('HISTORY_INCOMPLETE_REVIEW');
    if (!newness(quest === 'Q10' ? 'hunters' : 'creators')) return fail('PRE_CAMPAIGN_ACTIVITY');
  }
  if (['Q3','Q14'].includes(quest) && created.length) return pass([created[0]]);
  if (quest === 'Q4') { const b = created.find(paid); if (b) return pass([b]); }
  if (quest === 'Q5' && pairs.length) return pass(pairs[0]);
  if (quest === 'Q6') { const p = pairs.find(([a,b]) => paid(b) && a.payment.winner !== b.payment.winner); if (p) return pass(p); }
  if (quest === 'Q8' && passing.length) return pass([passing[0].b]);
  if (quest === 'Q9') { const p = passing.find(({ b }) => paid(b) && b.payment.winner === wallet); if (p) return pass([p.b]); }
  if (quest === 'Q10') {
    for (const a of passing) for (const b of passing) {
      if (a.b.key !== b.b.key && a.b.creator !== b.b.creator && b.s.submittedAt - a.s.submittedAt >= 3 * DAY
        && !c.teamWallets.includes(b.b.creator) && b.b.review.distinctFrom?.includes(a.b.key)
        && a.b.workOrder.requestDigest !== b.b.workOrder.requestDigest
        && [a,b].some(x => paid(x.b) && x.b.payment.winner === wallet)) return pass([a.b,b.b]);
    }
  }
  if (quest === 'Q15') { const p = pairs.find(([a,b]) => a.workOrder.templateId !== b.workOrder.templateId); if (p) return pass(p); }
  const related = state.bounties.filter(b => b.creator === wallet || b.submissions?.some(s => s.hunter === wallet));
  if (!related.length) return fail('NO_MATCHING_CHAIN_ACTIVITY');
  if (!related.some(b => timed(b.createdAt,c) && allowed.has(`${b.chainId}:${b.contract}`))) return fail('NO_QUALIFYING_CAMPAIGN_DEPLOYMENT_ACTIVITY');
  if (related.every(b => BigInt(b.originalWei) < BigInt(c.minimumWei))) return fail('MINIMUM_ORIGINAL_FUNDING_NOT_MET');
  if (related.every(b => b.refunded)) return fail('BOUNTY_REFUNDED');
  if (related.some(b => b.duplicate)) return fail('DUPLICATE_SCOPE_REVIEW');
  if (related.some(b => !b.workOrder?.ok || b.submissions?.some(s => s.hunter === wallet && !s.packageValid))) return fail('EVIDENCE_UNAVAILABLE_OR_INVALID');
  if (related.some(b => !b.review?.approved || !b.review.independentHunters?.length)) return fail('QUALITATIVE_REVIEW_REQUIRED');
  if (['Q5','Q6','Q10','Q15'].includes(quest)) return fail('REPEAT_TIMING_SCOPE_OR_OUTCOME_NOT_MET');
  if (['Q4','Q9'].includes(quest)) return fail('PAYMENT_NOT_RECEIVED_IN_WINDOW');
  if (quest === 'Q8') return fail('PASSING_PACKAGE_PENDING');
  return fail('MILESTONE_NOT_MET_OR_PENDING');
}
module.exports = { eligibility, timed };
