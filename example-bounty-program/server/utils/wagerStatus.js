/**
 * Where each mutual wager stands (GET /api/wagers/status): which bounties form each pair,
 * whether they match each other, and what each bettor can do next. Pure: the route groups and
 * reads the records, this decides.
 *
 * bounty = { bountyId, group?, terms: parseMutualWagerTerms(description), status: GET /onchain-status
 *            body, job: GET /:id?includeRubric=true job (with wagerPackage) }
 *          or, when it could not be read now, { bountyId, group?, terms?, error }.
 *
 * The server cannot see the event. Its timing is the terms' scheduled start and settlement deadline:
 * a claim is advised from 5 hours after the start (about 2 hours after a typical final, so juror web
 * tools no longer serve a cached in-progress page), but never later than the deadlines allow.
 * A question wager (mutual-wager-v5, or v4) states its own times: bets close (its `start`), Resolves at and
 * Claims open, from which a claim is advised.
 */
const wager = require('../../shared/mutualWager');

const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const isoOf = (sec) => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null);
const lc = (a) => String(a || '').toLowerCase();
const pendingSubs = (b) => (b.job?.submissions || []).filter((s) => s.status === 'PENDING_EVALUATION' || s.onChainStatus === 'PendingVerdikta');

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

function describeBounty(b, site) {
  if (b.error) return { bountyId: b.bountyId, unreadable: b.error, url: `${site}/bounty/${b.bountyId}` };
  const s = b.status;
  const live = !['AWARDED', 'CLOSED'].includes(s.status);
  const pending = pendingSubs(b);
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
    claimsInEvaluation: pending.length,
    url: `${site}/bounty/${b.bountyId}`,
    // closeExpiredBounty: anyone may send it after the deadline; it refunds the poster.
    close: live && s.deadlinePassed && !pending.length ? { method: 'POST', path: `/api/jobs/${b.bountyId}/close` } : null,
    refundableAfter: live ? s.submissionDeadlineIso : null,
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

/** Claim window of a pair: advised start, and the last moment to start an evaluation. */
function claimWindow(members, terms) {
  const start = unix(terms.fields.start), settle = unix(terms.fields.settle);
  const deadlines = members.filter((x) => x.status.status === 'OPEN').map((x) => Number(x.status.submissionDeadline)).filter(Number.isFinite);
  const hardEnd = Math.min(settle, ...deadlines);
  const claimBy = hardEnd - wager.CLAIM_START_MARGIN_SECONDS;
  // The usual wait (5 h after the start; for a question, Claims open) is advice; when it does not fit
  // before the deadline, the winner claims as soon as the result is out, as POST /api/wagers/claim also says.
  const question = terms.kind === 'question';
  const advised = question ? unix(terms.fields.claimsOpen) : start + wager.CLAIM_AFTER_START_SECONDS;
  const conflict = advised > claimBy;
  const earliest = question ? unix(terms.fields.resolvesAt) : start;
  return { start, settle, hardEnd, claimBy, conflict, claimAfter: conflict ? earliest : advised };
}

function pairState({ a, b, problems }, now) {
  const members = [a, b].filter(Boolean);
  const paid = members.filter((x) => x.status.status === 'AWARDED');
  const w = claimWindow(members, a.terms);
  if (paid.length) return { state: 'PAID', paid, window: w };
  if (!b) {
    if (a.status.status === 'CLOSED') return { state: 'CLOSED', paid, window: w };
    // A bounty that names a counter is an answer: its counterpart is that bounty, never a new answer.
    if (a.terms.counter) return { state: 'MISMATCHED', paid, window: w, problems: [{ bounty: a.bountyId, counter: a.terms.counter.number, message: `Bounty #${a.bountyId} names counter bounty #${a.terms.counter.number}, which is not a linked bounty of this wager.` }] };
    return { state: now < w.start - wager.MIN_START_LEAD_SECONDS && !a.status.deadlinePassed ? 'AWAITING_COUNTERPARTY' : 'OFFER_EXPIRED', paid, window: w };
  }
  if (members.every((x) => x.status.status === 'CLOSED')) return { state: 'CLOSED', paid, window: w };
  if (problems.length) return { state: 'MISMATCHED', paid, window: w };
  if (now < w.start) return { state: 'VERIFIED', paid, window: w };
  if (members.some((x) => pendingSubs(x).length > 0)) return { state: 'CLAIM_PENDING', paid, window: w };
  if (now < w.claimAfter) return { state: 'EVENT_PENDING', paid, window: w };
  if (now < w.hardEnd && members.some((x) => x.status.status === 'OPEN' && !x.status.deadlinePassed)) return { state: 'READY_TO_CLAIM', paid, window: w };
  return { state: 'REFUNDABLE', paid, window: w };
}

const NEXT = {
  AWAITING_COUNTERPARTY: (p) => [`The Claimant (${p.bounties[0].claimant}) answers with POST /api/wagers/answer { "counter": ${p.bounties[0].bountyId}, "creator": "${p.bounties[0].claimant}" } before ${p.answerBy}.`,
    `Until then the Poster's stake is exposed: it stays locked until bounty #${p.bounties[0].bountyId}'s deadline (${p.bounties[0].deadline}) even if no counter bounty appears.`],
  OFFER_EXPIRED: (p) => [`No counter bounty arrived in time (answers had to exist 10 minutes before ${p.kind === 'question' ? 'bets close' : 'the start'}, ${p.start}). The Poster closes #${p.bounties[0].bountyId} after its deadline (${p.bounties[0].deadline}) to get the stake back: POST /api/jobs/${p.bounties[0].bountyId}/close.`],
  MISMATCHED: () => ['The bounties do not match (see problems), so neither claim can be relied on. Do not fund more; each creator closes their own bounty after its deadline with POST /api/jobs/:id/close.'],
  VERIFIED: (p) => [p.kind === 'question'
    ? `Both bounties match. The question resolves at ${p.resolvesAt}; claim from ${p.claimAfter} and by ${p.claimBy}.`
    : `Both bounties match. Wait for the event (scheduled ${p.start}); claim from ${p.claimAfter} and by ${p.claimBy}.`],
  EVENT_PENDING: (p) => [p.kind === 'question'
    ? `The question resolves at ${p.resolvesAt}, and its sources may not show the final value yet. Claim from ${p.claimAfter} (Claims open) and by ${p.claimBy}.`
    : `The event may still be under way. Claim from ${p.claimAfter}, about 2 hours after the final, and by ${p.claimBy}.`],
  READY_TO_CLAIM: (p) => (p.kind === 'question' ? [
    ...(p.deadlineConflict ? [`Claims open does not leave time before the deadline: claim as soon as the sources show the final value, by ${p.claimBy}.`] : []),
    `The winner claims the bounty that pays them (the one whose Claimant they are) by ${p.claimBy}: draft claim.md with POST /api/wagers/claim { "bounty": <that bounty>, "counter": <their own bounty>, "answer": "YES" | "NO", "value": "...", "asOf": "<ISO time the value is for>", "sources": [...] }, then submit it as the bounty's work file.`,
    'When the No winner rule holds (for example the value is exactly at the line, or no reputable source shows the answer) nobody claims; each creator closes their own bounty after its deadline.',
  ] : [...(p.deadlineConflict ? [`The usual wait of about 2 hours after the final does not fit before the deadline: claim as soon as the official final is out, by ${p.claimBy}.`] : []),
    `The winner claims the bounty that pays them (the one whose Claimant they are) by ${p.claimBy}: draft claim.md with POST /api/wagers/claim { "bounty": <that bounty>, "counter": <their own bounty>, "score": [...], "sources": [...] }, then submit it as the bounty's work file.`,
    'On a tie or no official result nobody claims; each creator closes their own bounty after its deadline.']),
  CLAIM_PENDING: (p) => [`A claim is being evaluated. When the oracle answers, finalize it (see actions); a failed claim may be resubmitted by ${p.claimBy}.`],
  PAID: (p) => [`Paid: ${p.paid.map((b) => `#${b.bountyId} to ${b.winner}`).join(', ')}. The winner's own bounty pays nobody: its creator closes it after its deadline (POST /api/jobs/:id/close).`],
  REFUNDABLE: () => ['No bounty paid by the settlement deadline. Each creator closes their own bounty after its deadline (POST /api/jobs/:id/close; anyone may send it, and it refunds the creator).'],
  CLOSED: () => ['Both bounties are closed.'],
  UNKNOWN: () => ['Some bounties of this wager could not be read just now (see bounties[].unreadable). This is an incomplete observation, not a state: ask again shortly before acting.'],
};

/**
 * Typed next actions: { type, actor, method, path, body?, notBefore?, notAfter?, spendsFunds, retryable }.
 * spendsFunds marks a step that moves the actor's ETH (funding a bounty, prepaying an evaluation);
 * drafting, checking and closing (gas only) do not.
 */
function actionsFor(pair, members) {
  const out = [];
  const closes = () => pair.bounties.filter((b) => b.refundableAfter && !b.unreadable).map((b) => ({
    type: 'CLOSE', actor: 'anyone', method: 'POST', path: `/api/jobs/${b.bountyId}/close`, notBefore: b.deadline, spendsFunds: false, retryable: true,
    note: `Refunds ${b.poster}. Reverts before the deadline or while an evaluation is pending.`,
  }));
  switch (pair.state) {
    case 'AWAITING_COUNTERPARTY': {
      const b = pair.bounties[0];
      out.push({ type: 'ANSWER', actor: b.claimant, method: 'POST', path: '/api/wagers/answer', body: { counter: b.bountyId, creator: b.claimant }, notAfter: pair.answerBy, spendsFunds: false, retryable: true, note: 'Builds the answering bounty; funding it (createBounty) spends the stake.' });
      break;
    }
    case 'VERIFIED': case 'EVENT_PENDING':
      out.push({ type: 'WAIT', actor: 'both', notBefore: pair.claimAfter, notAfter: pair.claimDeadline, recommendedBy: pair.claimBy, spendsFunds: false, retryable: true });
      break;
    case 'READY_TO_CLAIM':
      for (const [x, y] of [[members[0], members[1]], [members[1], members[0]]]) {
        out.push({ type: 'CLAIM', actor: x.terms.claimant.wallet, method: 'POST', path: '/api/wagers/claim', body: { bounty: x.bountyId, counter: y.bountyId },
          notBefore: pair.claimAfter, notAfter: pair.claimDeadline, recommendedBy: pair.claimBy, spendsFunds: false, retryable: true,
          note: `Only if ${x.terms.claimant.side}. Drafting is free; submitting the claim prepays the evaluation fee.` });
      }
      break;
    case 'CLAIM_PENDING':
      for (const m of members) {
        for (const s of pendingSubs(m)) out.push({ type: 'FINALIZE', actor: 'anyone', method: 'POST', path: `/api/jobs/${m.bountyId}/submissions/${s.submissionId}/finalize`, spendsFunds: false, retryable: true, note: 'Once the oracle has answered; AWAIT_ORACLE means retry later.' });
      }
      break;
    case 'UNKNOWN':
      out.push({ type: 'RETRY', actor: 'caller', method: 'GET', path: '/api/wagers/status', spendsFunds: false, retryable: true });
      break;
    default:
      out.push(...closes());
  }
  if (['PAID', 'MISMATCHED', 'OFFER_EXPIRED', 'REFUNDABLE'].includes(pair.state) && !out.some((a) => a.type === 'CLOSE')) out.push(...closes());
  return out;
}

const groupKeyOf = (b) => b.group ?? [b.terms.fields.wagerId, ...[lc(b.terms.poster.wallet), lc(b.terms.claimant.wallet)].sort()].join('|');

/**
 * Pairs for the given wager bounties, and the open offers targeted at `wallet` (if given).
 * Bounties carry `group` when the caller grouped them (complete wagers); a group with a member
 * that could not be read is UNKNOWN rather than a guess. Returns { pairs, offers }.
 */
function wagerStatus(bounties, { now, site, wallet } = {}) {
  const groups = new Map();
  for (const b of bounties) {
    const key = b.error && b.group === undefined ? `unreadable|${b.bountyId}` : groupKeyOf(b);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const pairs = [...groups.values()].map((group) => {
    const readable = group.filter((b) => !b.error);
    if (readable.length < group.length || !readable.length) {
      const any = readable[0]?.terms || group.find((b) => b.terms)?.terms;
      const pair = {
        wagerId: any?.fields?.wagerId ?? null, state: 'UNKNOWN', kind: any?.kind ?? null, event: any?.fields?.event ?? null, question: any?.fields?.question ?? null,
        start: any?.fields?.start ?? null, settle: any?.fields?.settle ?? null, bounties: group.map((b) => describeBounty(b, site)), extra: [], problems: [], paid: [],
      };
      pair.next = NEXT.UNKNOWN(pair);
      pair.actions = actionsFor(pair, []);
      return pair;
    }
    const first = [...readable].sort((x, y) => x.bountyId - y.bountyId)[0];
    const sideA = readable.filter((b) => lc(b.terms.poster.wallet) === lc(first.terms.poster.wallet));
    const sideB = readable.filter((b) => lc(b.terms.poster.wallet) !== lc(first.terms.poster.wallet));
    const chosen = choosePair(sideA, sideB, now);
    const result = pairState(chosen, now);
    const f = chosen.a.terms.fields;
    const members = [chosen.a, chosen.b].filter(Boolean);
    const pair = {
      wagerId: f.wagerId,
      state: result.state,
      // 'game' (mutual-wager-v3: event, market, start) or 'question' (v4, v5: question, start = bets close, resolvesAt, claimsOpen).
      kind: chosen.a.terms.kind,
      event: f.event ?? null,
      market: f.market ?? null,
      ...(chosen.a.terms.kind === 'question' ? { question: f.question, resolvesAt: f.resolvesAt, claimsOpen: f.claimsOpen, sources: wager.parseSourcesLine(f.sources) } : {}),
      start: f.start,
      settle: f.settle,
      stakeEth: wager.parseStakeLine(f.stake),
      answerBy: chosen.b ? null : isoOf(result.window.start - wager.MIN_START_LEAD_SECONDS),
      claimAfter: isoOf(result.window.claimAfter),
      claimBy: isoOf(result.window.claimBy),
      // The hard cutoff for starting a claim's evaluation; claimBy is the recommended latest start.
      claimDeadline: isoOf(result.window.hardEnd),
      deadlineConflict: result.window.conflict,
      bounties: members.map((b) => describeBounty(b, site)),
      // Other bounties of the same wager: they back nothing; their creators close them after the deadline.
      extra: readable.filter((b) => !members.includes(b)).map((b) => describeBounty(b, site)),
      problems: result.problems || chosen.problems,
    };
    pair.paid = result.paid.map((b) => ({ bountyId: b.bountyId, winner: b.status.winner }));
    pair.next = NEXT[pair.state](pair);
    pair.actions = actionsFor(pair, members);
    return pair;
  }).sort((x, y) => Math.max(...y.bounties.map((b) => b.bountyId)) - Math.max(...x.bounties.map((b) => b.bountyId)));

  const offers = wallet ? pairs.filter((p) => p.state === 'AWAITING_COUNTERPARTY' && lc(p.bounties[0].claimant) === lc(wallet)).map((p) => {
    const b = p.bounties[0];
    const t = bounties.find((x) => x.bountyId === b.bountyId).terms;
    return {
      bountyId: b.bountyId, wagerId: p.wagerId, kind: p.kind, from: b.poster, event: p.event, market: p.market,
      ...(p.kind === 'question' ? { question: p.question, resolvesAt: p.resolvesAt, claimsOpen: p.claimsOpen, sources: p.sources } : {}),
      start: p.start, settle: p.settle,
      stakeEth: p.stakeEth, yourSide: t.claimant.side, theirSide: t.poster.side, answerBy: p.answerBy,
      answer: { method: 'POST', path: '/api/wagers/answer', body: { counter: b.bountyId, creator: wallet } },
    };
  }) : [];
  return { pairs, offers };
}

module.exports = { wagerStatus, counterProblems, pairState, claimWindow };
