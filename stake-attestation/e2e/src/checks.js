// What the round asserts, as pure functions over what it observed, so a test can hand them a
// tampered observation and see them fail. Each check is { name, ok, detail }. The round fails on
// the first one that is not ok, and a stage that makes no check is a failure of its own.
import { REAL_CONFIG } from './aggregatorRound.js';

const check = (name, ok, detail = '') => ({ name, ok: Boolean(ok), detail: String(detail) });
const eq = (a, b) => JSON.stringify(a, big) === JSON.stringify(b, big);
function big(_k, v) { return typeof v === 'bigint' ? v.toString() : v; }

/** A round the real rules finished: K polled, the first M commits, the first N reveals, P clustered. */
export function servedRoundChecks(prefix, round, config = REAL_CONFIG) {
  const cids = String(round?.justifications ?? '').split(',').filter(Boolean);
  const commitJobs = (round?.jobs ?? []).filter((j) => j.phase === 'commit');
  const revealJobs = (round?.jobs ?? []).filter((j) => j.phase === 'reveal');
  return [
    check(`${prefix}.round.fulfilled`, round?.status === 'fulfilled', `status ${round?.status}, ${round?.abstained} job(s) with no transaction`),
    check(`${prefix}.round.polled`, commitJobs.length === config.k, `${commitJobs.length} commit jobs, K = ${config.k}`),
    check(`${prefix}.round.commits`, round?.commits === config.m, `${round?.commits} commits recorded, M = ${config.m}`),
    check(`${prefix}.round.revealJobs`, revealJobs.length === config.m, `${revealJobs.length} reveal jobs: only the first M commits are asked`),
    check(`${prefix}.round.reveals`, round?.reveals === config.n, `${round?.reveals} reveals before it finalized, N = ${config.n}`),
    check(`${prefix}.round.clustered`, round?.clustered === config.p && cids.length === config.p, `${round?.clustered} clustered, ${cids.length} justification CIDs, P = ${config.p}`),
    // Only the M - N reveals that lose the race revert, on the real contract too: AggregationComplete.
    check(`${prefix}.round.noRevert`, (round?.reverted ?? []).length <= config.m - config.n && (round?.reverted ?? []).every((r) => r.reason === 'AggregationComplete' && r.phase === 'reveal'), JSON.stringify(round?.reverted ?? [])),
    check(`${prefix}.round.noBadReveal`, !(round?.ignored ?? []).some((i) => /Reveal|Invalid/.test(i.reason)), JSON.stringify(round?.ignored ?? [])),
  ];
}

/** A round no arbiter committed to: nothing recorded, and the bridge sent nothing to the mock. */
export function abstainedRoundChecks(prefix, round, config = REAL_CONFIG) {
  return [
    check(`${prefix}.round.noVerdict`, round?.status === 'no-verdict', `status ${round?.status}`),
    check(`${prefix}.round.allAbstained`, round?.abstained === config.k && round?.commits === 0 && round?.reveals === 0, `${round?.abstained} of ${config.k} jobs with no transaction, ${round?.commits} commits, ${round?.reveals} reveals`),
    check(`${prefix}.round.noResult`, round?.likelihoods === null && round?.justifications === null, `likelihoods ${JSON.stringify(round?.likelihoods, big)}`),
  ];
}

/** The request the contract sent: design §13.3 with errata E1 and E2, read at the aggregator. */
export function requestChecks(prefix, round, { listingCid, bcid, priorBcids = [], requestedClass, disclosure }) {
  const line = disclosure?.parsed;
  return [
    check(`${prefix}.request.cids`, eq(round?.cids, [listingCid, bcid, ...priorBcids]), JSON.stringify(round?.cids)),
    check(`${prefix}.request.class`, BigInt(round?.requestedClass ?? -1) === BigInt(requestedClass), String(round?.requestedClass)),
    check(`${prefix}.request.disclosureLine`, Boolean(line) && line.archiveSha256 === disclosure.archiveSha256 && line.ciphertextSha256 === disclosure.ciphertextSha256 && line.ciphertextCid === disclosure.ciphertextCid, round?.addendum ? `${round.addendum.split(' ')[0]} ...` : 'no addendum'),
  ];
}

/** What the jury path really did: one sandbox for the operator's K jobs, a jury per job, the keys kept from every model. */
export function juryPathChecks(prefix, { runnerCalls, aiCalls, providerCalls, panel, justifier, disclosureSecret, report, config = REAL_CONFIG }) {
  const jurorCalls = providerCalls.filter((c) => panel.some((p) => p.model === c.model));
  const justifierCalls = providerCalls.filter((c) => c.model === justifier.model);
  const definitive = runnerCalls.length === 1 && runnerCalls[0].response?.outcome === 'definitive';
  const reportNow = runnerCalls[0]?.response?.report;
  return [
    check(`${prefix}.runner.oneSandbox`, runnerCalls.length === 1, `${runnerCalls.length} run(s) for ${config.k} jobs`),
    check(`${prefix}.runner.definitive`, definitive && Boolean(reportNow) && !runnerCalls[0].response.reportUnavailable, definitive ? `report ${runnerCalls[0].response.reportSha256}` : JSON.stringify(runnerCalls[0]?.response?.abstain ?? runnerCalls[0]?.status)),
    check(`${prefix}.runner.reportPlatform`, !report?.classPlatform || (runnerCalls[0]?.response?.runner?.platform === report.classPlatformName), `the runner answered on ${runnerCalls[0]?.response?.runner?.platform}`),
    check(`${prefix}.jury.perJob`, aiCalls.length === config.k && aiCalls.every((c) => c.status === 200 && c.request?.codeReview), `${aiCalls.length} AI Node calls, ${aiCalls.filter((c) => c.status === 200).length} answered`),
    check(`${prefix}.jury.everyJuror`, jurorCalls.length === config.k * panel.length && jurorCalls.every((c) => c.outcome === 'answered'), `${jurorCalls.length} juror calls, ${config.k} jobs x ${panel.length} jurors`),
    check(`${prefix}.jury.justifier`, justifierCalls.length === config.k, `${justifierCalls.length} justifier calls`),
    check(`${prefix}.jury.keysNotSeen`, !providerCalls.some((c) => String(c.prompt).includes('verdikta-disclosure') || (disclosureSecret && String(c.prompt).includes(disclosureSecret))), 'no prompt carries the disclosure line or its keys'),
  ];
}

/** A claim the gates settled: nothing reached a model, and the runner said why. */
export function gateSettledChecks(prefix, { runnerCalls, aiCalls, providerCalls, gate, config = REAL_CONFIG }) {
  const answer = runnerCalls[0]?.response;
  return [
    check(`${prefix}.runner.oneSandbox`, runnerCalls.length === 1, `${runnerCalls.length} run(s) for ${config.k} jobs`),
    check(`${prefix}.runner.gateFailed`, answer?.outcome === 'definitive' && answer?.gates?.[gate]?.status === 'fail', `${gate}: ${answer?.gates?.[gate]?.status}`),
    check(`${prefix}.noAi`, aiCalls.length === 0 && providerCalls.length === 0, `${aiCalls.length} AI Node call(s), ${providerCalls.length} provider call(s)`),
  ];
}

/** Every upload the chain points at holds the block, and the first says what the settlement says. */
export function evidenceChecks(prefix, { uploads, evidence, settlement, reportSha256 = null }) {
  return [
    check(`${prefix}.evidence.uploads`, uploads.length > 0 && uploads.every((u) => typeof u?.justification === 'string' && u.justification.startsWith('Execution evidence v1')), `${uploads.length} upload(s)`),
    check(`${prefix}.evidence.settlement`, evidence?.settlement === settlement, `read ${evidence?.settlement}, expected ${settlement}`),
    check(`${prefix}.evidence.reportHash`, reportSha256 === null || evidence?.reportSha256 === reportSha256, `evidence ${evidence?.reportSha256}, runner ${reportSha256}`),
  ];
}

/** Who sent the contract's own moves, and what they left: measured from the chain. */
export function settlementChecks(prefix, { state, outcome, expectedOutcome, finalizeFrom, settleFrom, keeper, vector, expectedVector }) {
  return [
    check(`${prefix}.settled.state`, state === 'Settled', state),
    check(`${prefix}.settled.outcome`, outcome === expectedOutcome, `${outcome}, expected ${expectedOutcome}`),
    check(`${prefix}.settled.vector`, eq(vector, expectedVector), JSON.stringify(vector, big)),
    check(`${prefix}.keeper.finalized`, finalizeFrom === keeper, `from ${finalizeFrom}`),
    check(`${prefix}.keeper.settled`, settleFrom === keeper, `from ${settleFrom}`),
  ];
}

/** Exact balance moves, over stretches where the account sent no transaction: no gas to account for. */
export function moneyChecks(prefix, entries) {
  return entries.map(({ name, before, after, expected }) => check(
    `${prefix}.money.${name}`,
    after - before === expected,
    `moved ${after - before} wei, expected ${expected}`,
  ));
}

/** An abstaining claim's end: E6. No verdict, the bond to the maker, nothing published. */
export function abstainEndChecks(prefix, { state, expiry, judgedEvents, settledEvents, record, pinsBefore, pinsAfter }) {
  return [
    check(`${prefix}.never.judged`, judgedEvents === 0, `${judgedEvents} Judged event(s)`),
    check(`${prefix}.never.settled`, settledEvents === 0, `${settledEvents} Settled event(s)`),
    check(`${prefix}.ended.expired`, state === 'Expired' && expiry === 'RoundsFailed', `${state}, ${expiry}`),
    check(`${prefix}.record.noVerdict`, record?.history?.noVerdict === '1', `noVerdict ${record?.history?.noVerdict}`),
    check(`${prefix}.nothingUploaded`, pinsAfter === pinsBefore, `${pinsAfter - pinsBefore} upload(s) during the rounds`),
  ];
}

/** The API's record against what the round did, field by field. */
export function recordChecks(prefix, view, { artifactHash, listingId, outcomes, claims, released, noVerdict, findings, escrowWei }) {
  const rec = view?.record ?? {};
  const history = rec.history ?? {};
  const listing = (rec.listings ?? []).find((l) => l.listingId === String(listingId));
  return [
    check(`${prefix}.record.hash`, view?.artifactHash === artifactHash, view?.artifactHash),
    check(`${prefix}.record.fresh`, view?.fresh === true, `fresh ${view?.fresh}, ${view?.staleReason}`),
    check(`${prefix}.record.counted`, (view?.notCounted?.listings ?? [1]).length === 0 && Boolean(listing), `${(view?.notCounted?.listings ?? []).length} not counted`),
    check(`${prefix}.record.outcomes`, eq(history.outcomes, outcomes.map(String)), JSON.stringify(history.outcomes)),
    check(`${prefix}.record.claims`, history.claims === String(claims) && history.pending === '0', `claims ${history.claims}, pending ${history.pending}`),
    check(`${prefix}.record.released`, history.released === String(released), `released ${history.released}`),
    check(`${prefix}.record.noVerdictCount`, history.noVerdict === String(noVerdict), `noVerdict ${history.noVerdict}`),
    check(`${prefix}.record.findings`, eq((rec.findings ?? []).map((f) => ({ claimId: f.claimId, outcome: f.outcome, paidWei: f.paidWei, owedWei: f.owedWei, bcid: f.bcid })), findings), JSON.stringify(rec.findings ?? [], big)),
    check(`${prefix}.record.escrow`, listing?.escrowWei === String(escrowWei), `escrow ${listing?.escrowWei}, expected ${escrowWei}`),
    check(`${prefix}.record.stakerNamed`, String(view?.badge?.message).includes('staker named by the repository: yes'), view?.badge?.message),
  ];
}

/** What the browser read off the client's pages, against the same facts. */
export function pageChecks(prefix, pages, { artifactHash, claims, verdicts, noVerdict, findingBcid, invalidBcid }) {
  const r = pages?.record ?? {};
  return [
    check(`${prefix}.page.hash`, r.hash === artifactHash.toLowerCase(), r.hash),
    check(`${prefix}.page.claims`, r.claims === String(claims) && r.pending === '0', `claims ${r.claims}, pending ${r.pending}`),
    check(`${prefix}.page.verdicts`, verdicts.every((v) => String(r.verdicts).includes(v)), r.verdicts),
    check(`${prefix}.page.noVerdict`, r.noVerdict === String(noVerdict), r.noVerdict),
    check(`${prefix}.page.finding`, String(r.findings).includes(findingBcid) && String(r.findings).includes('HIGH'), 'the valid finding is listed'),
    check(`${prefix}.page.invalidNotPublished`, !String(r.main).includes(invalidBcid), 'an INVALID claim is a count, not a publication'),
    check(`${prefix}.page.noErrors`, (pages?.errors ?? [1]).length === 0, JSON.stringify(pages?.errors ?? [])),
    check(`${prefix}.page.feed`, typeof pages?.feed === 'string' && pages.feed.length > 0, 'the listing is on the feed'),
  ];
}
