/**
 * Where each mutual wager stands (GET /api/wagers/status): which bounties form each pair,
 * whether they match each other, and what each bettor does next. Pure: the route reads the
 * records, this decides.
 *
 * bounty = { bountyId, terms: parseMutualWagerTerms(description), status: GET /onchain-status
 *            body, job: GET /:id?includeRubric=true job }
 *
 * The server cannot see the event. Its timing is the terms' scheduled start and settlement
 * deadline: a claim is expected from 5 hours after the start (about 2 hours after a typical
 * final, so juror web tools no longer serve a cached in-progress page) until settlement.
 */
const wager = require('../../shared/mutualWager');

const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const isoOf = (sec) => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null);
const lc = (a) => String(a || '').toLowerCase();
const inEvaluation = (b) => (b.job?.submissions || []).filter((s) => s.status === 'PENDING_EVALUATION' || s.onChainStatus === 'PendingVerdikta').length;

const expectOf = (b) => ({
  classId: b.status.classId, threshold: b.status.threshold, oracle: b.status.oracleSettings,
  jury: b.job?.juryNodes, iterations: b.job?.iterations,
});

/**
 * Problems with `counter` backing `own`: the create page's counter check, from own's side.
 * After the scheduled start a counter's status no longer matters (the rubric ignores it), so
 * a paid or expired counter is judged as it was.
 */
function counterProblems(own, counter, now) {
  if (own.terms.counter && own.terms.counter.number !== counter.bountyId) {
    return [`Bounty #${own.bountyId} names counter bounty #${own.terms.counter.number}, not #${counter.bountyId}.`];
  }
  const started = now >= unix(own.terms.fields.start);
  const status = started ? { ...counter.status, status: 'OPEN', deadlinePassed: false } : counter.status;
  return wager.checkCounterBounty({ terms: own.terms, status, job: counter.job, expect: expectOf(own), number: counter.bountyId });
}

function describeBounty(b, site, now) {
  const s = b.status;
  const live = !['AWARDED', 'CLOSED'].includes(s.status);
  const pending = inEvaluation(b);
  return {
    bountyId: b.bountyId,
    poster: b.terms.poster.wallet,
    claimant: b.terms.claimant.wallet,
    paysClaimantIf: b.terms.claimant.side,
    stakeEth: wager.parseStakeLine(b.terms.fields.stake),
    status: s.status,
    createdAt: s.createdAtIso,
    deadline: s.submissionDeadlineIso,
    deadlinePassed: !!s.deadlinePassed,
    winner: s.winner || null,
    namesCounter: b.terms.counter?.number ?? null,
    claimsInEvaluation: pending,
    url: `${site}/bounty/${b.bountyId}`,
    // closeExpiredBounty: anyone may send it after the deadline; it refunds the poster.
    close: live && s.deadlinePassed && !pending ? { method: 'POST', path: `/api/jobs/${b.bountyId}/close` } : null,
    refundableAfter: live ? s.submissionDeadlineIso : null,
    checkedAt: isoOf(now),
  };
}

/** The best-matching pair in a group of bounties sharing a Wager ID and two wallets. */
function choosePair(sideA, sideB, now) {
  const newest = (list) => [...list].sort((x, y) => y.bountyId - x.bountyId);
  if (!sideA.length || !sideB.length) {
    const only = newest(sideA.length ? sideA : sideB);
    return { a: only.find((b) => b.status.status === 'OPEN') || only[0], b: null, problems: [] };
  }
  let best = null;
  for (const a of newest(sideA)) {
    for (const b of newest(sideB)) {
      const problems = [
        ...counterProblems(a, b, now).map((message) => ({ bounty: a.bountyId, counter: b.bountyId, message })),
        ...counterProblems(b, a, now).map((message) => ({ bounty: b.bountyId, counter: a.bountyId, message })),
      ];
      const named = (a.terms.counter?.number === b.bountyId) + (b.terms.counter?.number === a.bountyId);
      if (!best || problems.length < best.problems.length || (problems.length === best.problems.length && named > best.named)) best = { a, b, problems, named };
    }
  }
  return best;
}

const NEXT = {
  AWAITING_COUNTERPARTY: (p) => [`The Claimant (${p.bounties[0].claimant}) answers with POST /api/wagers/answer { "counter": ${p.bounties[0].bountyId}, "creator": "${p.bounties[0].claimant}" } before ${p.answerBy}.`,
    `Until then the Poster's stake is exposed: it stays locked until bounty #${p.bounties[0].bountyId}'s deadline (${p.bounties[0].deadline}) even if no counter bounty appears.`],
  OFFER_EXPIRED: (p) => [`No counter bounty arrived in time (answers had to exist 10 minutes before the start, ${p.start}). The Poster closes #${p.bounties[0].bountyId} after its deadline (${p.bounties[0].deadline}) to get the stake back: POST /api/jobs/${p.bounties[0].bountyId}/close.`],
  MISMATCHED: () => ['The two bounties do not match (see problems), so neither claim can be relied on. Do not fund more; each creator closes their own bounty after its deadline with POST /api/jobs/:id/close.'],
  VERIFIED: (p) => [`Both bounties match. Wait for the event (scheduled ${p.start}); claim no earlier than ${p.claimAfter}.`],
  EVENT_PENDING: (p) => [`The event may still be under way. Claim no earlier than ${p.claimAfter}, about 2 hours after the final, and before ${p.settle}.`],
  READY_TO_CLAIM: (p) => [`The winner claims the bounty that pays them (the one whose Claimant they are) before ${p.settle}: draft claim.md with POST /api/wagers/claim { "bounty": <that bounty>, "counter": <their own bounty>, "score": [...], "sources": [...] }, then submit it as the bounty's work file.`,
    'On a tie or no official result nobody claims; each creator closes their own bounty after its deadline.'],
  CLAIM_PENDING: (p) => [`A claim is being evaluated. When the oracle answers, finalize it (POST /api/jobs/<bounty>/submissions/<id>/finalize); a failed claim may be resubmitted before ${p.settle}.`],
  PAID: (p) => [`Paid: ${p.paid.map((b) => `#${b.bountyId} to ${b.winner}`).join(', ')}. The winner's own bounty pays nobody: its creator closes it after its deadline (POST /api/jobs/:id/close).`],
  REFUNDABLE: () => ['No bounty paid by the settlement deadline. Each creator closes their own bounty after its deadline (POST /api/jobs/:id/close; anyone may send it, and it refunds the creator).'],
  CLOSED: () => ['Both bounties are closed.'],
};

function pairState({ a, b, problems }, now) {
  const f = a.terms.fields;
  const start = unix(f.start), settle = unix(f.settle);
  const members = [a, b].filter(Boolean);
  const paid = members.filter((x) => x.status.status === 'AWARDED');
  if (paid.length) return { state: 'PAID', paid };
  if (!b) {
    if (a.status.status === 'CLOSED') return { state: 'CLOSED', paid };
    return { state: now < start - wager.MIN_START_LEAD_SECONDS && !a.status.deadlinePassed ? 'AWAITING_COUNTERPARTY' : 'OFFER_EXPIRED', paid };
  }
  if (members.every((x) => x.status.status === 'CLOSED')) return { state: 'CLOSED', paid };
  if (problems.length) return { state: 'MISMATCHED', paid };
  if (now < start) return { state: 'VERIFIED', paid };
  if (members.some((x) => inEvaluation(x) > 0)) return { state: 'CLAIM_PENDING', paid };
  if (now < start + wager.CLAIM_AFTER_START_SECONDS) return { state: 'EVENT_PENDING', paid };
  if (now <= settle && members.some((x) => x.status.status === 'OPEN' && !x.status.deadlinePassed)) return { state: 'READY_TO_CLAIM', paid };
  return { state: 'REFUNDABLE', paid };
}

/**
 * Pairs for the given wager bounties, and the open offers targeted at `wallet` (if given).
 * Returns { pairs, offers }.
 */
function wagerStatus(bounties, { now, site, wallet } = {}) {
  const groups = new Map();
  for (const b of bounties) {
    const key = [b.terms.fields.wagerId, ...[lc(b.terms.poster.wallet), lc(b.terms.claimant.wallet)].sort()].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const pairs = [...groups.values()].map((group) => {
    const first = [...group].sort((x, y) => x.bountyId - y.bountyId)[0];
    const sideA = group.filter((b) => lc(b.terms.poster.wallet) === lc(first.terms.poster.wallet));
    const sideB = group.filter((b) => lc(b.terms.poster.wallet) !== lc(first.terms.poster.wallet));
    const chosen = choosePair(sideA, sideB, now);
    const { state, paid } = pairState(chosen, now);
    const f = chosen.a.terms.fields;
    const start = unix(f.start);
    const members = [chosen.a, chosen.b].filter(Boolean);
    const pair = {
      wagerId: f.wagerId,
      state,
      event: f.event,
      market: f.market,
      start: f.start,
      settle: f.settle,
      stakeEth: wager.parseStakeLine(f.stake),
      answerBy: chosen.b ? null : isoOf(start - wager.MIN_START_LEAD_SECONDS),
      claimAfter: isoOf(start + wager.CLAIM_AFTER_START_SECONDS),
      bounties: members.map((b) => describeBounty(b, site, now)),
      // Other bounties with the same Wager ID and wallets: they back nothing; their creators close them after the deadline.
      extra: group.filter((b) => !members.includes(b)).map((b) => describeBounty(b, site, now)),
      problems: chosen.problems,
    };
    pair.paid = paid.map((b) => ({ bountyId: b.bountyId, winner: b.status.winner }));
    pair.next = NEXT[state](pair);
    return pair;
  }).sort((x, y) => Math.max(...y.bounties.map((b) => b.bountyId)) - Math.max(...x.bounties.map((b) => b.bountyId)));

  const offers = wallet ? pairs.filter((p) => p.state === 'AWAITING_COUNTERPARTY' && lc(p.bounties[0].claimant) === lc(wallet)).map((p) => {
    const b = p.bounties[0];
    const t = bounties.find((x) => x.bountyId === b.bountyId).terms;
    return {
      bountyId: b.bountyId, wagerId: p.wagerId, from: b.poster, event: p.event, market: p.market, start: p.start, settle: p.settle,
      stakeEth: p.stakeEth, yourSide: t.claimant.side, theirSide: t.poster.side, answerBy: p.answerBy,
      answer: { method: 'POST', path: '/api/wagers/answer', body: { counter: b.bountyId, creator: wallet } },
    };
  }) : [];
  return { pairs, offers };
}

module.exports = { wagerStatus, counterProblems, pairState };
