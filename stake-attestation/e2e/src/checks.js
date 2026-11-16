// What the round asserts, as pure functions over what it observed, so a test can hand them a
// tampered observation and see them fail. Each check is { name, ok, detail }. The round fails on
// the first one that is not ok, and a stage that makes no check is a failure of its own.
import { REAL_CONFIG } from './aggregatorRound.js';

const check = (name, ok, detail = '') => ({ name, ok: Boolean(ok), detail: String(detail) });
const eq = (a, b) => JSON.stringify(a, big) === JSON.stringify(b, big);
function big(_k, v) { return typeof v === 'bigint' ? v.toString() : v; }
const sameVector = (a, b) => a != null && b != null && eq(a.map(String), b.map(String));

const distinctSlots = (jobs) => new Set(jobs.map((j) => j.slot)).size;

/**
 * A round the real rules finished: K polled, the first M commits, the first N reveals, P clustered. Counted
 * job by job: M commits and N reveals can still come with a job in six gone wrong, and that must show.
 */
export function servedRoundChecks(prefix, round, { vector, config = REAL_CONFIG }) {
  const cids = String(round?.justifications ?? '').split(',').filter(Boolean);
  const commitJobs = (round?.jobs ?? []).filter((j) => j.phase === 'commit');
  const revealJobs = (round?.jobs ?? []).filter((j) => j.phase === 'reveal');
  return [
    check(`${prefix}.round.fulfilled`, round?.status === 'fulfilled', `status ${round?.status}, ${round?.abstained} job(s) with no transaction`),
    check(`${prefix}.round.polled`, commitJobs.length === config.k && distinctSlots(commitJobs) === config.k, `${commitJobs.length} commit jobs on ${distinctSlots(commitJobs)} slots, K = ${config.k}`),
    check(`${prefix}.round.noAbstain`, round?.abstained === 0, `${round?.abstained} job(s) with no transaction`),
    check(`${prefix}.round.commits`, round?.commits === config.m, `${round?.commits} commits recorded, M = ${config.m}`),
    check(`${prefix}.round.revealJobs`, revealJobs.length === config.m && distinctSlots(revealJobs) === config.m, `${revealJobs.length} reveal jobs on ${distinctSlots(revealJobs)} slots: only the first M commits are asked`),
    check(`${prefix}.round.reveals`, round?.reveals === config.n, `${round?.reveals} reveals before it finalized, N = ${config.n}`),
    check(`${prefix}.round.clustered`, round?.clustered === config.p && cids.length === config.p, `${round?.clustered} clustered, ${cids.length} justification CIDs, P = ${config.p}`),
    // Only the jobs that lose the race revert, on the real contract too: the K - M late commits and the
    // M - N late reveals that land after the N-th reveal finalized it (AggregationComplete comes first there).
    check(`${prefix}.round.noRevert`, (round?.reverted ?? []).length <= config.k - config.n && (round?.reverted ?? []).every((r) => r.reason === 'AggregationComplete'), JSON.stringify(round?.reverted ?? [])),
    // And what is ignored is only a commit that came after the reveal phase began: never a bad reveal or a zero commit.
    check(`${prefix}.round.noBadReveal`, (round?.ignored ?? []).every((i) => i.reason === 'commit after the reveal phase began'), JSON.stringify(round?.ignored ?? [])),
    check(`${prefix}.round.vector`, sameVector(round?.likelihoods, vector), `the mock was given ${JSON.stringify(round?.likelihoods ?? null, big)}`),
    // Every reveal, the one that lost the race too: the mean of a cluster shows only two of them.
    check(`${prefix}.round.everyRevealSame`, revealJobs.length > 0 && revealJobs.every((j) => sameVector(j.scores, vector)), JSON.stringify(revealJobs.map((j) => j.scores), big)),
  ];
}

/**
 * The harness's promise, as the one thing that decides it: after exit no process group it started and no
 * container or image it labelled remains, and if one does, or if it cannot say, the run has failed. A process
 * it did not start is out of scope.
 * @returns {string|null} why the run has not kept it
 */
export function cleanupVerdict({ cleanupFailures = [], inventoryDue = false, leftovers = null }) {
  if (cleanupFailures.length) return `the cleanup failed: ${cleanupFailures.join('; ')}`;
  if (inventoryDue && !leftovers) return 'no inventory of what the run left';
  if (leftovers && (leftovers.containers.length || leftovers.images.length || leftovers.groups.length)) return `left behind: ${JSON.stringify(leftovers)}`;
  return null;
}

/** A round no arbiter committed to: nothing recorded, and the bridge sent nothing to the mock. */
export function abstainedRoundChecks(prefix, round, config = REAL_CONFIG) {
  return [
    check(`${prefix}.round.noVerdict`, round?.status === 'no-verdict', `status ${round?.status}`),
    check(`${prefix}.round.allAbstained`, round?.abstained === config.k && round?.commits === 0 && round?.reveals === 0, `${round?.abstained} of ${config.k} jobs with no transaction, ${round?.commits} commits, ${round?.reveals} reveals`),
    check(`${prefix}.round.noResult`, round?.likelihoods === null && round?.justifications === null, `likelihoods ${JSON.stringify(round?.likelihoods, big)}`),
  ];
}

/**
 * That the arbiter really ran the proof and really abstained: an EA that is down leaves the same empty
 * round. What the runner answered the EA, and what the EA said about it, for every job of the round.
 */
export function abstainRunChecks(prefix, { round, runnerCalls, aiCalls, providerCalls, cause }) {
  const jobs = round?.jobs ?? [];
  return [
    check(`${prefix}.runner.ranIt`, runnerCalls.length >= 1 && runnerCalls.every((c) => c.response?.outcome === 'abstain' && c.response?.abstain?.cause === cause), JSON.stringify(runnerCalls.map((c) => [c.status, c.response?.outcome, c.response?.abstain?.cause]))),
    check(`${prefix}.ea.abstained`, jobs.length > 0 && jobs.every((j) => j.status === 500 && j.error.startsWith('CODE_REVIEW_RUNNER_ABSTAIN') && j.error.includes(cause)), JSON.stringify(jobs.map((j) => [j.status, j.error.slice(0, 60)]))),
    check(`${prefix}.noAi`, aiCalls.length === 0 && providerCalls.length === 0, `${aiCalls.length} AI Node call(s), ${providerCalls.length} provider call(s)`),
  ];
}

/** The request the contract sent: design §13.3 with errata E1 and E2, read at the aggregator. */
export function requestChecks(prefix, round, { listingCid, bcid, priorBcids = [], requestedClass, disclosure, oracle }) {
  const line = disclosure?.parsed;
  const asked = round?.oracle;
  return [
    check(`${prefix}.request.cids`, eq(round?.cids, [listingCid, bcid, ...priorBcids]), JSON.stringify(round?.cids)),
    check(`${prefix}.request.class`, BigInt(round?.requestedClass ?? -1) === BigInt(requestedClass), String(round?.requestedClass)),
    check(`${prefix}.request.disclosureLine`, Boolean(line) && line.archiveSha256 === disclosure.archiveSha256 && line.ciphertextSha256 === disclosure.ciphertextSha256 && line.ciphertextCid === disclosure.ciphertextCid, round?.addendum ? `${round.addendum.split(' ')[0]} ...` : 'no addendum'),
    check(`${prefix}.request.oracle`, Boolean(asked) && BigInt(asked.alpha) === BigInt(oracle.alpha) && BigInt(asked.maxFee) === BigInt(oracle.maxOracleFee) && BigInt(asked.estimatedBaseCost) === BigInt(oracle.estimatedBaseCost) && BigInt(asked.maxFeeBasedScaling) === BigInt(oracle.maxFeeBasedScaling), JSON.stringify(asked ?? null, big)),
  ];
}

const jurorKey = (c) => `${c.provider}:${c.model}`;
/** How many times each prompt was sent, as one comparable value. */
const promptCounts = (calls) => {
  const seen = new Map();
  for (const c of calls) seen.set(c.prompt, (seen.get(c.prompt) ?? 0) + 1);
  return JSON.stringify([...seen.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
};

/**
 * What the jury path really did: one sandbox for the operator's K jobs, and a jury per job. Every count here
 * is per juror and every look is per call or per job, never a total: the chain shows only the winning
 * cluster, so a job or a juror gone wrong outside it would show nowhere else.
 */
export function juryPathChecks(prefix, { runnerCalls, aiCalls, providerCalls, panel, justifier, disclosureKeys, markers, average, maxTokens, report, config = REAL_CONFIG }) {
  const definitive = runnerCalls.length === 1 && runnerCalls[0].response?.outcome === 'definitive';
  const answer = runnerCalls[0]?.response;
  const reportHash = answer?.reportSha256;
  const callsOf = (juror) => providerCalls.filter((c) => jurorKey(c) === jurorKey(juror));
  const jurorCalls = panel.flatMap(callsOf);
  const justifierCalls = callsOf(justifier);
  const known = new Set([...panel, justifier].map(jurorKey));
  const everyJuror = panel.map((p) => {
    const calls = callsOf(p);
    return { juror: jurorKey(p), calls: calls.length, answered: calls.filter((c) => c.outcome === 'answered').length };
  });
  // Both keys of the line, in either spelling, in what any model was sent and in what the EA sent the AI Node.
  const forms = (disclosureKeys ?? []).flatMap((k) => [String(k).toLowerCase(), String(k).toLowerCase().replace(/^0x/, '')]);
  const holdsAKey = (text) => {
    const t = String(text).toLowerCase();
    return t.includes('verdikta-disclosure') || forms.some((f) => t.includes(f));
  };
  const panelKeys = panel.map(jurorKey).sort();
  const askedOf = (c) => (c.request?.models ?? []).map(jurorKey).sort();
  const scoresOf = (c) => (c.response?.scores ?? []).map((s) => s.score);
  const resultsOf = (c) => c.response?.model_results ?? [];
  const everyJurorAnswered = (c) => {
    const results = resultsOf(c);
    return results.length === panel.length && panelKeys.every((k) => results.some((r) => jurorKey(r) === k && r.status === 'success'));
  };
  const seesEvidence = (c) => String(c.prompt).includes(reportHash ?? '\0') && (markers ?? []).length > 0 && markers.every((m) => String(c.prompt).includes(m));
  const jurorSettings = (c) => c.options?.webAccess === false && c.options?.signal === true && c.options?.maxTokens === maxTokens && c.options?.effort === 'high';
  const justifierSettings = (c) => c.options?.webAccess === false && c.options?.signal === true;
  return [
    check(`${prefix}.runner.oneSandbox`, runnerCalls.length === 1, `${runnerCalls.length} run(s) for ${config.k} jobs`),
    check(`${prefix}.runner.definitive`, definitive && Boolean(answer?.report) && !answer.reportUnavailable, definitive ? `report ${reportHash}` : JSON.stringify(answer?.abstain ?? runnerCalls[0]?.status)),
    check(`${prefix}.runner.reportPlatform`, !report?.classPlatform || (answer?.runner?.platform === report.classPlatformName), `the runner answered on ${answer?.runner?.platform}`),
    check(`${prefix}.jury.perJob`, aiCalls.length === config.k && aiCalls.every((c) => c.status === 200 && c.request?.codeReview), `${aiCalls.length} AI Node calls, ${aiCalls.filter((c) => c.status === 200).length} answered`),
    check(`${prefix}.jury.panelAskedEveryJob`, aiCalls.length > 0 && aiCalls.every((c) => eq(askedOf(c), panelKeys)), `each job asked for ${panelKeys.join(', ')}`),
    check(`${prefix}.jury.everyJuror`, panel.length > 0 && everyJuror.every((j) => j.calls === config.k && j.answered === config.k), `K = ${config.k}: ${JSON.stringify(everyJuror)}`),
    check(`${prefix}.jury.onlyThePanel`, providerCalls.every((c) => known.has(jurorKey(c))), [...new Set(providerCalls.map(jurorKey))].join(', ')),
    check(`${prefix}.jury.everyJobAverage`, aiCalls.length > 0 && aiCalls.every((c) => sameVector(scoresOf(c), average)), `every job's answer is the jurors' weighted average ${(average ?? []).join(',')}: ${JSON.stringify(aiCalls.map(scoresOf))}`),
    check(`${prefix}.jury.everyJurorInEveryAnswer`, aiCalls.length > 0 && aiCalls.every(everyJurorAnswered), JSON.stringify(aiCalls.map((c) => resultsOf(c).map((r) => [r.model, r.status])))),
    check(`${prefix}.jury.everyCallSawEvidence`, jurorCalls.length > 0 && jurorCalls.every(seesEvidence), `each of ${jurorCalls.length} prompts holds the report's hash and ${(markers ?? []).length} marker(s) from the report and the pack`),
    check(`${prefix}.jury.codeModeSettings`, jurorCalls.length > 0 && jurorCalls.every(jurorSettings) && justifierCalls.every(justifierSettings), `web off, an abort signal, and for each juror ${maxTokens} tokens and effort high`),
    check(`${prefix}.jury.onePrompt`, panel.length > 0 && panel.every((p) => promptCounts(callsOf(p)) === promptCounts(callsOf(panel[0]))), 'each juror was sent the same prompts, as many times'),
    check(`${prefix}.jury.justifier`, justifierCalls.length === config.k && justifierCalls.every((c) => c.outcome === 'answered'), `${justifierCalls.length} justifier calls`),
    check(`${prefix}.jury.keysKnown`, (disclosureKeys ?? []).length === 2, `${(disclosureKeys ?? []).length} keys read from the request's line`),
    check(`${prefix}.jury.keysNotSeen`, !providerCalls.some((c) => holdsAKey(c.prompt)) && !aiCalls.some((c) => holdsAKey(JSON.stringify(c.request))), 'no prompt and no AI Node request carries the disclosure line or either key'),
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

/**
 * A claim a non-tamper integrity check settled: the proof ran on real forge and failed where a good one does, a
 * check measured from outside it failed, no tamper flag fired, and nothing reached a model.
 */
export function integrityRunChecks(prefix, { runnerCalls, aiCalls, providerCalls, failedCheck, config = REAL_CONFIG }) {
  const answer = runnerCalls[0]?.response;
  const poc = answer?.report?.poc;
  const integrity = poc?.integrity ?? {};
  const tests = poc?.tests ?? [];
  const failedChecks = Object.keys(integrity).filter((k) => integrity[k] === false);
  return [
    check(`${prefix}.runner.oneSandbox`, runnerCalls.length === 1, `${runnerCalls.length} run(s) for ${config.k} jobs`),
    check(`${prefix}.runner.gateFailed`, answer?.outcome === 'definitive' && answer?.gates?.integrity?.status === 'fail' && answer?.gates?.reproduces?.status === 'fail', `integrity ${answer?.gates?.integrity?.status}, reproduces ${answer?.gates?.reproduces?.status}`),
    check(`${prefix}.runner.reproducesOnlyThroughIntegrity`, answer?.gates?.reproduces?.basis === 'integrity', `reproduces failed on ${answer?.gates?.reproduces?.basis}`),
    check(`${prefix}.runner.checkFailed`, failedChecks.includes(failedCheck), `failed: ${failedChecks.join(', ')}`),
    check(`${prefix}.runner.noTamperFlag`, Array.isArray(integrity.tamperFlags) && integrity.tamperFlags.length === 0, JSON.stringify(integrity.tamperFlags ?? null)),
    check(`${prefix}.runner.everyRunFailed`, tests.length > 0 && tests.every((t) => t.runs?.[0] === 'fail' && t.runs.every((r) => r === 'fail' || r === 'not-run')), JSON.stringify(tests.map((t) => t.runs))),
    check(`${prefix}.noAi`, aiCalls.length === 0 && providerCalls.length === 0, `${aiCalls.length} AI Node call(s), ${providerCalls.length} provider call(s)`),
  ];
}

/** Every upload the chain points at, not only the first: it holds the block, and says what the settlement says. */
export function evidenceChecks(prefix, { uploads, evidences, settlement, source, reportSha256 = null, expectedCount }) {
  return [
    check(`${prefix}.evidence.uploads`, uploads.length === expectedCount && uploads.every((u) => typeof u?.justification === 'string' && u.justification.startsWith('Execution evidence v1')), `${uploads.length} upload(s), ${expectedCount} expected`),
    check(`${prefix}.evidence.settlement`, evidences.length > 0 && evidences.every((e) => e?.settlement === settlement), `read ${JSON.stringify(evidences.map((e) => e?.settlement))}, expected ${settlement}`),
    check(`${prefix}.evidence.reportHash`, reportSha256 === null || (evidences.length > 0 && evidences.every((e) => e?.reportSha256 === reportSha256)), `evidence ${JSON.stringify(evidences.map((e) => e?.reportSha256))}, runner ${reportSha256}`),
    check(`${prefix}.evidence.source`, uploads.length > 0 && uploads.every((u) => u?.metadata?.verdict_source === source), `read ${JSON.stringify(uploads.map((u) => u?.metadata?.verdict_source))}, expected ${source}`),
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
export function abstainEndChecks(prefix, { state, expiry, judgedEvents, settledEvents, record, uploads }) {
  return [
    check(`${prefix}.never.judged`, judgedEvents === 0, `${judgedEvents} Judged event(s)`),
    check(`${prefix}.never.settled`, settledEvents === 0, `${settledEvents} Settled event(s)`),
    check(`${prefix}.ended.expired`, state === 'Expired' && expiry === 'RoundsFailed', `${state}, ${expiry}`),
    check(`${prefix}.record.noVerdict`, record?.history?.noVerdict === '1', `noVerdict ${record?.history?.noVerdict}`),
    check(`${prefix}.nothingUploaded`, uploads?.length === 0, `${uploads?.length} upload(s) during the rounds`),
  ];
}

/** The API's record against what the round did, field by field. */
export function recordChecks(prefix, view, { artifactHash, listingId, outcomes, claims, released, noVerdict, findings, escrowWei, bondWei, awards }) {
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
    check(`${prefix}.record.terms`, listing?.state === 'Open' && listing?.bondWei === String(bondWei) && eq(listing?.awards, awards.map(String)), `${listing?.state}, bond ${listing?.bondWei}, awards ${JSON.stringify(listing?.awards)}`),
    check(`${prefix}.record.listingOutcomes`, eq(listing?.history?.outcomes, outcomes.map(String)), JSON.stringify(listing?.history?.outcomes)),
    check(`${prefix}.record.stakerNamed`, String(view?.badge?.message).includes('staker named by the repository: yes'), view?.badge?.message),
  ];
}

/** What the API's record says of the claims that failed integrity (owner decision Q35, node P10), read from the real writer's uploads. */
export function integrityRecordChecks(prefix, view, { listingId, failed, checks, note }) {
  const got = view?.integrity?.listings?.[String(listingId)];
  return [
    check(`${prefix}.record.integrityFailed`, got?.failed === failed, `failed ${got?.failed}, expected ${failed}`),
    check(`${prefix}.record.integrityChecks`, eq(got?.checks, checks), JSON.stringify(got?.checks ?? null)),
    check(`${prefix}.record.integrityApart`, got?.otherDuplicates === 0 && got?.unread === 0 && got?.disagree === 0 && got?.late?.failed === 0, JSON.stringify({ otherDuplicates: got?.otherDuplicates, unread: got?.unread, disagree: got?.disagree, late: got?.late?.failed })),
    check(`${prefix}.record.integrityNote`, view?.integrity?.note === note, 'the neutral words beside the count'),
  ];
}

/** The same on the page. */
export function integrityPageChecks(prefix, pages, { failed, check: name, count, note, bcid }) {
  const r = pages?.record ?? {};
  return [
    check(`${prefix}.page.integrityFailed`, r.integrity === String(failed), r.integrity),
    check(`${prefix}.page.integrityChecks`, String(r.integrityChecks).includes(`${name}: ${count}`), r.integrityChecks),
    check(`${prefix}.page.integrityOther`, r.integrityOther === '0', r.integrityOther),
    check(`${prefix}.page.integrityNote`, r.integrityNote === note, r.integrityNote),
    check(`${prefix}.page.duplicateNotPublished`, !String(r.main).includes(bcid), 'a DUPLICATE is a count, not a publication'),
  ];
}

/** What the browser read off the client's pages, against the same facts. */
export function pageChecks(prefix, pages, { artifactHash, claims, judged, released, state, verdicts, noVerdict, findingBcid, invalidBcid }) {
  const r = pages?.record ?? {};
  const verdictLines = String(r.verdicts).split('\n').map((l) => l.trim());
  return [
    check(`${prefix}.page.hash`, r.hash === artifactHash.toLowerCase(), r.hash),
    check(`${prefix}.page.claims`, r.claims === String(claims) && r.pending === '0', `claims ${r.claims}, pending ${r.pending}`),
    check(`${prefix}.page.judged`, r.judged === String(judged), r.judged),
    check(`${prefix}.page.released`, r.released === String(released), r.released),
    check(`${prefix}.page.state`, r.state === state, r.state),
    check(`${prefix}.page.verdicts`, verdicts.every((v) => verdictLines.includes(v)), r.verdicts),
    check(`${prefix}.page.noVerdict`, r.noVerdict === String(noVerdict), r.noVerdict),
    check(`${prefix}.page.finding`, String(r.findings).includes(findingBcid) && String(r.findings).includes('HIGH'), 'the valid finding is listed'),
    check(`${prefix}.page.invalidNotPublished`, !String(r.main).includes(invalidBcid), 'an INVALID claim is a count, not a publication'),
    check(`${prefix}.page.noErrors`, (pages?.errors ?? [1]).length === 0, JSON.stringify(pages?.errors ?? [])),
    check(`${prefix}.page.feed`, typeof pages?.feed === 'string' && pages.feed.length > 0, 'the listing is on the feed'),
  ];
}

// Node P20 (owner decision Q61 (a)): the round's listing that names stake.documents, and the pack the real runner at
// the pin builds for a claim on it. The tier is the runner's; what is checked here is that it is there, in common's
// place, with the files the listed commit holds, and that the tool shows that pack and nothing of its own.
const DOCUMENT_LABEL = 'the maker\'s document at the listed commit (stake.documents): ';
const tierNames = (pack) => (Array.isArray(pack?.tiers) ? pack.tiers.map((t) => t.name) : null);
const documentPaths = (pack) => (pack?.files ?? []).filter((f) => f.tier === 'documents').map((f) => {
  const head = String(f.text).split('\n')[0];
  return head.startsWith(`# ${DOCUMENT_LABEL}`) ? head.slice(DOCUMENT_LABEL.length + 2) : null;
});

/**
 * The documents listing's validation report: accepted and ready, its documents step right after the fetch, and its
 * account of what the tier would read, what it skips and which glob matched nothing, with the warning for that glob.
 */
export function documentsListingChecks(prefix, view, { read, skipped, unmatched }) {
  const report = view?.validationReport ?? {};
  const steps = (report.steps ?? []).map((s) => `${s.name}:${s.status}`);
  const d = report.documents ?? {};
  const warned = (report.warnings ?? []).filter((w) => w.code === 'STAKE_DOCUMENT_MATCHES_NOTHING').map((w) => w.detail);
  return [
    check(`${prefix}.listing.ready`, view?.status === 'ready', JSON.stringify({ status: view?.status, refusals: report.refusals, error: view?.error ?? report.error }).slice(0, 400)),
    check(`${prefix}.listing.documentsStep`, steps.indexOf('documents:ok') === steps.indexOf('fetch:ok') + 1 && steps.indexOf('fetch:ok') >= 0, steps.join(', ')),
    check(`${prefix}.listing.read`, eq((d.read ?? []).map((f) => f.path), read), JSON.stringify(d.read ?? null)),
    check(`${prefix}.listing.skipped`, eq((d.skipped ?? []).map((f) => [f.path, f.reason]), skipped), JSON.stringify(d.skipped ?? null)),
    check(`${prefix}.listing.unmatchedWarned`, eq((d.unmatched ?? []).map((u) => u.glob), unmatched) && unmatched.every((g) => warned.some((w) => w.includes(JSON.stringify(g)))), JSON.stringify({ unmatched: d.unmatched, warned })),
  ];
}

/**
 * The hunter's check on the documents listing: it ran, the request the runner got carried the listing's documents,
 * the pack the tool printed is the one the runner answered, and that pack has the documents tier at its place in
 * common's order (right after the source) with the expected files, in order, and the expected ones left out.
 */
export function documentsPackChecks(prefix, { check: run, runnerAnswer, sent, globs, files, omitted }) {
  const pack = run?.json?.pack ?? null;
  const tier = (pack?.tiers ?? []).find((t) => t.name === 'documents');
  const names = tierNames(pack) ?? [];
  const f = run?.json?.forecast ?? {};
  return [
    check(`${prefix}.check.passes`, run?.code === 0 && f.verdict === 'pass', `exit ${run?.code}, ${f.verdict}`),
    check(`${prefix}.request.documents`, eq(sent?.spec?.stake?.documents, globs), JSON.stringify(sent?.spec?.stake?.documents ?? null)),
    check(`${prefix}.pack.isTheRunners`, pack !== null && eq(pack, runnerAnswer?.contextPack), 'the pack the tool printed is the runner\'s answer'),
    check(`${prefix}.pack.documentsTier`, tier !== undefined && names.indexOf('documents') === names.indexOf('source') + 1 && tier.rank === names.indexOf('documents') + 1, names.join(', ')),
    check(`${prefix}.pack.documentFiles`, eq(documentPaths(pack), files) && tier?.delivered === files.length && eq(tier?.omitted ?? null, omitted), JSON.stringify({ files: documentPaths(pack), tier })),
    check(`${prefix}.forecast.documents`, eq(f.documents?.globs, globs) && tier !== undefined && eq(f.documents?.tier, { rank: tier.rank, status: tier.status, asked: tier.asked, delivered: tier.delivered, omitted: tier.omitted, cut: tier.cut }), JSON.stringify(f.documents ?? null)),
  ];
}

/** A pack for a claim on a listing that names no documents: no documents tier, so its ranks are what they were. */
export function noDocumentsTierChecks(prefix, pack) {
  const names = tierNames(pack);
  return [
    check(`${prefix}.pack.noDocumentsTier`, names !== null && !names.includes('documents') && pack.tiers.every((t, i) => t.rank === i + 1) && !(pack.files ?? []).some((x) => x.tier === 'documents'), JSON.stringify(names)),
  ];
}
