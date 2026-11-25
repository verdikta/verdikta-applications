// A passing round proves nothing if its checks cannot fail. Each is handed what a good round observes,
// then that observation with one thing wrong: the abstention passed off as a verdict, the bond in the
// wrong hands, a record that says something else.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  abstainEndChecks, abstainRunChecks, abstainedRoundChecks, cleanupVerdict, documentsListingChecks, documentsPackChecks, noDocumentsTierChecks, evidenceChecks, gateSettledChecks, heldSiteChecks, holdChecks, holdPageChecks, lateNoAwardChecks, integrityPageChecks, integrityRecordChecks, integrityRunChecks, juryPathChecks, lateClaimChecks, laterRecordChecks, moneyChecks, pageChecks, recordChecks,
  refusedCommitChecks, requestChecks, rolledFromHoldChecks, servedRoundChecks, settlementChecks,
} from '../src/checks.js';

const failing = (list) => list.filter((c) => !c.ok).map((c) => c.name);
const allPass = (list) => assert.deepEqual(failing(list), []);
const fails = (list, name) => assert.ok(failing(list).includes(name), `${name} should fail: ${JSON.stringify(failing(list))}`);

const VECTOR = [0n, 700000n, 300000n];
const jobs = (phase, n) => Array.from({ length: n }, (_, slot) => ({ phase, slot, status: 200, scores: phase === 'reveal' ? VECTOR : null }));
const served = (over = {}) => ({ status: 'fulfilled', jobs: [...jobs('commit', 6), ...jobs('reveal', 4)], commits: 4, reveals: 3, clustered: 2, justifications: 'QmA,QmB', likelihoods: VECTOR, reverted: [], ignored: [], abstained: 0, ...over });

test('cleanupVerdict: the promise: nothing of the run left, or the run has failed, and an inventory it cannot give is a failure', () => {
  const clean = { containers: [], images: [], groups: [] };
  assert.equal(cleanupVerdict({ inventoryDue: true, leftovers: clean }), null);
  assert.equal(cleanupVerdict({ inventoryDue: false, leftovers: null }), null, 'a run that failed before it reached Docker has nothing to say');
  assert.match(cleanupVerdict({ inventoryDue: true, leftovers: { ...clean, groups: [123] } }), /left behind.*123/);
  assert.match(cleanupVerdict({ inventoryDue: true, leftovers: { ...clean, containers: ['c'] } }), /left behind/);
  assert.match(cleanupVerdict({ inventoryDue: true, leftovers: { ...clean, images: ['i'] } }), /left behind/);
  assert.match(cleanupVerdict({ inventoryDue: true, leftovers: null }), /no inventory/);
  assert.match(cleanupVerdict({ cleanupFailures: ['docker ps exited 1'], inventoryDue: true, leftovers: clean }), /docker ps exited 1/);
});

test('servedRoundChecks: K, M, N, P, or it fails', () => {
  allPass(servedRoundChecks('x', served(), { vector: VECTOR }));
  fails(servedRoundChecks('x', served({ status: 'no-verdict' }), { vector: VECTOR }), 'x.round.fulfilled');
  fails(servedRoundChecks('x', served({ jobs: jobs('commit', 1) }), { vector: VECTOR }), 'x.round.polled');
  fails(servedRoundChecks('x', served({ commits: 1 }), { vector: VECTOR }), 'x.round.commits');
  fails(servedRoundChecks('x', served({ jobs: jobs('commit', 6) }), { vector: VECTOR }), 'x.round.revealJobs');
  fails(servedRoundChecks('x', served({ reveals: 1 }), { vector: VECTOR }), 'x.round.reveals');
  fails(servedRoundChecks('x', served({ justifications: 'QmA' }), { vector: VECTOR }), 'x.round.clustered');
  const late = (phase) => ({ phase, reason: 'AggregationComplete' });
  allPass(servedRoundChecks('x', served({ reverted: [late('reveal')] }), { vector: VECTOR }), 'the M - N late reveals revert, as on the real contract');
  allPass(servedRoundChecks('x', served({ reverted: [late('reveal'), late('commit'), late('commit')] }), { vector: VECTOR }), 'and so do the K - M commits that land after it finalized');
  fails(servedRoundChecks('x', served({ reverted: [{ phase: 'reveal', reason: 'MalformedPayload' }] }), { vector: VECTOR }), 'x.round.noRevert');
  fails(servedRoundChecks('x', served({ reverted: [late('reveal'), late('reveal'), late('commit'), late('commit')] }), { vector: VECTOR }), 'x.round.noRevert');
  fails(servedRoundChecks('x', served({ ignored: [{ reason: 'RevealHashMismatch' }] }), { vector: VECTOR }), 'x.round.noBadReveal');
  allPass(servedRoundChecks('x', served({ ignored: [{ reason: 'commit after the reveal phase began' }] }), { vector: VECTOR }));
  // One job in six going wrong must not hide behind the others: M commits and N reveals can still come.
  fails(servedRoundChecks('x', served({ ignored: [{ reason: 'zero commit' }] }), { vector: VECTOR }), 'x.round.noBadReveal');
  fails(servedRoundChecks('x', served({ abstained: 1 }), { vector: VECTOR }), 'x.round.noAbstain');
  // What the mock was given, and what every reveal said: the one that lost the race is outside the mean.
  fails(servedRoundChecks('x', served({ likelihoods: [0n, 800000n, 200000n] }), { vector: VECTOR }), 'x.round.vector');
  fails(servedRoundChecks('x', served({ likelihoods: null }), { vector: VECTOR }), 'x.round.vector');
  const reveals = jobs('reveal', 4);
  reveals[3] = { ...reveals[3], scores: [1000000n, 0n, 0n] };
  fails(servedRoundChecks('x', served({ jobs: [...jobs('commit', 6), ...reveals] }), { vector: VECTOR }), 'x.round.everyRevealSame');
  const same = (phase, n) => Array.from({ length: n }, () => ({ phase, slot: 0, status: 200 }));
  fails(servedRoundChecks('x', served({ jobs: [...same('commit', 6), ...jobs('reveal', 4)] }), { vector: VECTOR }), 'x.round.polled');
  fails(servedRoundChecks('x', served({ jobs: [...jobs('commit', 6), ...same('reveal', 4)] }), { vector: VECTOR }), 'x.round.revealJobs');
});

test('abstainedRoundChecks: an abstention stays an abstention', () => {
  const round = { status: 'no-verdict', abstained: 6, commits: 0, reveals: 0, likelihoods: null, justifications: null };
  allPass(abstainedRoundChecks('x', round));
  fails(abstainedRoundChecks('x', { ...round, status: 'fulfilled' }), 'x.round.noVerdict');
  fails(abstainedRoundChecks('x', { ...round, commits: 1 }), 'x.round.allAbstained');
  fails(abstainedRoundChecks('x', { ...round, likelihoods: [1n] }), 'x.round.noResult');
});

test('abstainRunChecks: the arbiter ran it and abstained: an EA that is down leaves the same empty round', () => {
  const job = (over = {}) => ({ status: 500, error: 'CODE_REVIEW_RUNNER_ABSTAIN: the runner abstained (cause step_timeout, step poc:1)', ...over });
  const obs = { round: { jobs: [job(), job()] }, runnerCalls: [{ status: 503, response: { outcome: 'abstain', abstain: { cause: 'step_timeout' } } }], aiCalls: [], providerCalls: [], cause: 'step_timeout' };
  allPass(abstainRunChecks('x', obs));
  fails(abstainRunChecks('x', { ...obs, runnerCalls: [] }), 'x.runner.ranIt');
  fails(abstainRunChecks('x', { ...obs, runnerCalls: [{ response: { outcome: 'abstain', abstain: { cause: 'oom' } } }] }), 'x.runner.ranIt');
  fails(abstainRunChecks('x', { ...obs, runnerCalls: [{ response: { outcome: 'definitive' } }] }), 'x.runner.ranIt');
  fails(abstainRunChecks('x', { ...obs, round: { jobs: [] } }), 'x.ea.abstained');
  fails(abstainRunChecks('x', { ...obs, round: { jobs: [job({ status: 599, error: 'connect ECONNREFUSED' })] } }), 'x.ea.abstained');
  fails(abstainRunChecks('x', { ...obs, round: { jobs: [job({ error: 'CODE_REVIEW_AI_ABSTAIN: the AI Node answered 503' })] } }), 'x.ea.abstained');
  fails(abstainRunChecks('x', { ...obs, aiCalls: [{}] }), 'x.noAi');
});

test('requestChecks: the composition the contract owes', () => {
  const disclosure = { parsed: { archiveSha256: '0xa', ciphertextSha256: '0xb', ciphertextCid: 'QmC' }, archiveSha256: '0xa', ciphertextSha256: '0xb', ciphertextCid: 'QmC' };
  const oracle = { alpha: 500n, maxFee: 7n, estimatedBaseCost: 1n, maxFeeBasedScaling: 3n };
  const round = { cids: ['QmL', 'QmB', 'QmP'], requestedClass: 133n, addendum: 'verdikta-disclosure: x', oracle };
  const o = { listingCid: 'QmL', bcid: 'QmB', priorBcids: ['QmP'], requestedClass: 133, disclosure, oracle: { alpha: '500', maxOracleFee: '7', estimatedBaseCost: '1', maxFeeBasedScaling: '3' } };
  allPass(requestChecks('x', round, o));
  fails(requestChecks('x', { ...round, cids: ['QmL', 'QmB'] }, o), 'x.request.cids');
  fails(requestChecks('x', { ...round, requestedClass: 128n }, o), 'x.request.class');
  fails(requestChecks('x', round, { ...o, disclosure: { ...disclosure, parsed: null } }), 'x.request.disclosureLine');
  fails(requestChecks('x', round, { ...o, disclosure: { ...disclosure, archiveSha256: '0xz' } }), 'x.request.disclosureLine');
  fails(requestChecks('x', { ...round, oracle: { ...oracle, maxFee: 8n } }, o), 'x.request.oracle');
});

const AVERAGE = [0n, 700000n, 300000n];
const panel = [{ provider: 'p', model: 'a', weight: 0.5 }, { provider: 'q', model: 'b', weight: 0.5 }];
const justifier = { provider: 'o', model: 'j' };
const PROMPT = 'the claim, REPORT-HASH, MARK-1, MARK-2';
const OPTIONS = { webAccess: false, signal: true, maxTokens: 8000, effort: 'high' };
const jurorCall = (who, over = {}) => ({ provider: who.provider, model: who.model, outcome: 'answered', prompt: PROMPT, options: { ...OPTIONS }, ...over });
const justifierCall = (over = {}) => ({ provider: 'o', model: 'j', outcome: 'answered', prompt: 'write it up', options: { webAccess: false, signal: true }, ...over });
const providerCalls = () => Array.from({ length: 6 }, () => [jurorCall(panel[0]), jurorCall(panel[1]), justifierCall()]).flat();
const aiCall = (over = {}) => ({
  status: 200,
  request: { codeReview: {}, models: panel.map((p) => ({ provider: p.provider, model: p.model, weight: p.weight, count: 1 })) },
  response: {
    scores: [{ score: 0 }, { score: 700000 }, { score: 300000 }],
    model_results: panel.map((p) => ({ provider: p.provider, model: p.model, status: 'success' })),
    ...over,
  },
});
const juryObs = (over = {}) => ({
  runnerCalls: [{ response: { outcome: 'definitive', report: {}, reportSha256: 'REPORT-HASH', runner: { platform: 'linux/amd64' } } }],
  aiCalls: Array.from({ length: 6 }, () => aiCall()),
  providerCalls: providerCalls(),
  panel,
  justifier,
  disclosureKeys: ['0xAA11', '0xbb22'],
  markers: ['MARK-1', 'MARK-2'],
  average: AVERAGE,
  maxTokens: 8000,
  report: { classPlatform: true, classPlatformName: 'linux/amd64' },
  ...over,
});
/** A's calls and B's, as many of each as asked. */
const countsOf = (a, b) => [...Array.from({ length: a }, () => jurorCall(panel[0])), ...Array.from({ length: b }, () => jurorCall(panel[1])), ...Array.from({ length: 6 }, () => justifierCall())];

test('juryPathChecks: the sandbox ran, the jury was reached, the keys stayed out', () => {
  allPass(juryPathChecks('x', juryObs()));
  fails(juryPathChecks('x', juryObs({ runnerCalls: [] })), 'x.runner.oneSandbox');
  fails(juryPathChecks('x', juryObs({ runnerCalls: [{ response: { outcome: 'abstain', abstain: { cause: 'oom' } } }] })), 'x.runner.definitive');
  fails(juryPathChecks('x', juryObs({ runnerCalls: [{ response: { outcome: 'definitive', report: null, reportUnavailable: 'linux/arm64', runner: { platform: 'linux/amd64' } } }] })), 'x.runner.definitive');
  fails(juryPathChecks('x', juryObs({ runnerCalls: [{ response: { outcome: 'definitive', report: {}, runner: { platform: 'linux/arm64' } } }] })), 'x.runner.reportPlatform');
  allPass(juryPathChecks('x', juryObs({ runnerCalls: [{ response: { outcome: 'definitive', report: {}, reportSha256: 'REPORT-HASH', runner: { platform: 'linux/arm64' } } }], report: { classPlatform: false } })));
  fails(juryPathChecks('x', juryObs({ aiCalls: [] })), 'x.jury.perJob');
  fails(juryPathChecks('x', juryObs({ providerCalls: [] })), 'x.jury.everyJuror');
  const failed = providerCalls().map((c) => (c.model === 'a' ? { ...c, outcome: 'failed' } : c));
  fails(juryPathChecks('x', juryObs({ providerCalls: failed })), 'x.jury.everyJuror');
  fails(juryPathChecks('x', juryObs({ providerCalls: providerCalls().filter((c) => c.model !== 'j') })), 'x.jury.justifier');
  fails(juryPathChecks('x', juryObs({ providerCalls: providerCalls().map((c) => (c.model === 'j' ? { ...c, outcome: 'failed' } : c)) })), 'x.jury.justifier');
  const withPrompt = (prompt) => juryObs({ providerCalls: [...providerCalls().slice(1), jurorCall(panel[0], { prompt })] });
  fails(juryPathChecks('x', withPrompt('verdikta-disclosure: x')), 'x.jury.keysNotSeen');
  fails(juryPathChecks('x', withPrompt('the content key is 0xaa11')), 'x.jury.keysNotSeen');
  fails(juryPathChecks('x', withPrompt('the content key is AA11, with no prefix')), 'x.jury.keysNotSeen');
  fails(juryPathChecks('x', withPrompt('the ephemeral key is 0xBB22')), 'x.jury.keysNotSeen');
  fails(juryPathChecks('x', juryObs({ aiCalls: Array.from({ length: 6 }, () => { const c = aiCall(); c.request.prompt = 'bb22'; return c; }) })), 'x.jury.keysNotSeen');
  fails(juryPathChecks('x', juryObs({ disclosureKeys: [] })), 'x.jury.keysKnown');
});

test('juryPathChecks: K calls per juror, not K x jurors in all: 9 and 3 is not 12 (R4-F2)', () => {
  fails(juryPathChecks('x', juryObs({ providerCalls: countsOf(9, 3) })), 'x.jury.everyJuror');
  fails(juryPathChecks('x', juryObs({ providerCalls: countsOf(3, 9) })), 'x.jury.everyJuror');
  fails(juryPathChecks('x', juryObs({ providerCalls: countsOf(12, 0) })), 'x.jury.everyJuror');
  fails(juryPathChecks('x', juryObs({ providerCalls: countsOf(7, 6) })), 'x.jury.everyJuror');
  allPass(juryPathChecks('x', juryObs({ providerCalls: countsOf(6, 6) })));
  // The same model name under another provider is another juror, as the panel names them.
  const elsewhere = providerCalls().map((c) => (c.model === 'a' ? { ...c, provider: 'r' } : c));
  fails(juryPathChecks('x', juryObs({ providerCalls: elsewhere })), 'x.jury.everyJuror');
  // Nobody outside the panel and the justifier.
  fails(juryPathChecks('x', juryObs({ providerCalls: [...providerCalls(), jurorCall({ provider: 'z', model: 'stranger' })] })), 'x.jury.onlyThePanel');
});

test('juryPathChecks: one job that went wrong does not hide behind the others', () => {
  const oneOf = (bad) => juryObs({ aiCalls: [...Array.from({ length: 5 }, () => aiCall()), bad] });
  // A job the AI Node answered with something else: outside the winning cluster, the chain would never show it.
  fails(juryPathChecks('x', oneOf(aiCall({ scores: [{ score: 0 }, { score: 800000 }, { score: 200000 }] }))), 'x.jury.everyJobAverage');
  fails(juryPathChecks('x', oneOf(aiCall({ scores: [] }))), 'x.jury.everyJobAverage');
  fails(juryPathChecks('x', oneOf({ status: 503, request: aiCall().request, response: {} })), 'x.jury.perJob');
  // A job whose request named one juror, or whose answer says one of them failed.
  const oneJuror = aiCall();
  oneJuror.request.models = oneJuror.request.models.slice(0, 1);
  fails(juryPathChecks('x', oneOf(oneJuror)), 'x.jury.panelAskedEveryJob');
  fails(juryPathChecks('x', oneOf(aiCall({ model_results: [{ provider: 'p', model: 'a', status: 'success' }] }))), 'x.jury.everyJurorInEveryAnswer');
  fails(juryPathChecks('x', oneOf(aiCall({ model_results: [{ provider: 'p', model: 'a', status: 'success' }, { provider: 'q', model: 'b', status: 'parsing_error' }] }))), 'x.jury.everyJurorInEveryAnswer');
});

test('juryPathChecks: every juror\'s every call saw the evidence, under code mode\'s settings, on one prompt', () => {
  const one = (over) => juryObs({ providerCalls: [...providerCalls().slice(1), jurorCall(panel[0], over)] });
  fails(juryPathChecks('x', one({ prompt: 'the claim, MARK-1, MARK-2' })), 'x.jury.everyCallSawEvidence');
  fails(juryPathChecks('x', one({ prompt: 'the claim, REPORT-HASH, MARK-2' })), 'x.jury.everyCallSawEvidence');
  fails(juryPathChecks('x', juryObs({ markers: [] })), 'x.jury.everyCallSawEvidence');
  fails(juryPathChecks('x', one({ options: { ...OPTIONS, webAccess: true } })), 'x.jury.codeModeSettings');
  fails(juryPathChecks('x', one({ options: { ...OPTIONS, signal: false } })), 'x.jury.codeModeSettings');
  fails(juryPathChecks('x', one({ options: { ...OPTIONS, maxTokens: 100 } })), 'x.jury.codeModeSettings');
  fails(juryPathChecks('x', one({ options: { ...OPTIONS, effort: 'low' } })), 'x.jury.codeModeSettings');
  // Each juror held the same prompts, as many times: another prompt for one juror's job shows.
  const different = providerCalls();
  different[0] = jurorCall(panel[0], { prompt: `${PROMPT}, and more` });
  fails(juryPathChecks('x', juryObs({ providerCalls: different })), 'x.jury.onePrompt');
  fails(juryPathChecks('x', juryObs({ providerCalls: providerCalls().map((c) => (c.model === 'j' ? { ...c, options: { webAccess: true, signal: true } } : c)) })), 'x.jury.codeModeSettings');
});

test('gateSettledChecks: a gate settled it, and no model was asked', () => {
  const obs = { runnerCalls: [{ response: { outcome: 'definitive', gates: { testPathsOnly: { status: 'fail' } } } }], aiCalls: [], providerCalls: [], gate: 'testPathsOnly' };
  allPass(gateSettledChecks('x', obs));
  fails(gateSettledChecks('x', { ...obs, aiCalls: [{}] }), 'x.noAi');
  fails(gateSettledChecks('x', { ...obs, providerCalls: [{}] }), 'x.noAi');
  fails(gateSettledChecks('x', { ...obs, runnerCalls: [{ response: { outcome: 'definitive', gates: { testPathsOnly: { status: 'pass' } } } }] }), 'x.runner.gateFailed');
  fails(gateSettledChecks('x', { ...obs, runnerCalls: [{ response: { outcome: 'abstain' } }] }), 'x.runner.gateFailed');
});

test('evidenceChecks: every upload the chain points at says what the settlement says, not only the first', () => {
  const upload = { justification: 'Execution evidence v1\nSettlement: jury\n', metadata: { verdict_source: 'code-review-jury' } };
  const read = { settlement: 'jury', reportSha256: 'h' };
  const obs = { uploads: [upload, upload], evidences: [read, read], settlement: 'jury', source: 'code-review-jury', reportSha256: 'h', expectedCount: 2 };
  allPass(evidenceChecks('x', obs));
  fails(evidenceChecks('x', { ...obs, uploads: [], evidences: [] }), 'x.evidence.uploads');
  fails(evidenceChecks('x', { ...obs, uploads: [upload], evidences: [read] }), 'x.evidence.uploads');
  fails(evidenceChecks('x', { ...obs, uploads: [upload, null] }), 'x.evidence.uploads');
  fails(evidenceChecks('x', { ...obs, uploads: [upload, { justification: 'jury text', metadata: upload.metadata }] }), 'x.evidence.uploads');
  fails(evidenceChecks('x', { ...obs, settlement: 'INVALID (testPathsOnly)' }), 'x.evidence.settlement');
  fails(evidenceChecks('x', { ...obs, evidences: [read, null] }), 'x.evidence.settlement');
  fails(evidenceChecks('x', { ...obs, evidences: [read, { settlement: 'INVALID (build)', reportSha256: 'h' }] }), 'x.evidence.settlement');
  fails(evidenceChecks('x', { ...obs, reportSha256: 'other' }), 'x.evidence.reportHash');
  fails(evidenceChecks('x', { ...obs, evidences: [read, { settlement: 'jury', reportSha256: 'other' }] }), 'x.evidence.reportHash');
  fails(evidenceChecks('x', { ...obs, source: 'code-review-runner' }), 'x.evidence.source');
  allPass(evidenceChecks('x', { ...obs, reportSha256: null }));
});

test('settlementChecks: the keeper moved it, to the outcome and the vector expected', () => {
  const obs = { state: 'Settled', outcome: 'HIGH', expectedOutcome: 'HIGH', finalizeFrom: '0xk', settleFrom: '0xk', keeper: '0xk', vector: [1n], expectedVector: [1n] };
  allPass(settlementChecks('x', obs));
  fails(settlementChecks('x', { ...obs, state: 'Judged' }), 'x.settled.state');
  fails(settlementChecks('x', { ...obs, outcome: 'INVALID' }), 'x.settled.outcome');
  fails(settlementChecks('x', { ...obs, vector: [2n] }), 'x.settled.vector');
  fails(settlementChecks('x', { ...obs, finalizeFrom: '0xh' }), 'x.keeper.finalized');
  fails(settlementChecks('x', { ...obs, settleFrom: '0xh' }), 'x.keeper.settled');
});

test('moneyChecks: to the wei', () => {
  allPass(moneyChecks('x', [{ name: 'bond', before: 10n, after: 30n, expected: 20n }]));
  fails(moneyChecks('x', [{ name: 'bond', before: 10n, after: 29n, expected: 20n }]), 'x.money.bond');
  fails(moneyChecks('x', [{ name: 'bond', before: 10n, after: 31n, expected: 20n }]), 'x.money.bond');
});

test('abstainEndChecks: no verdict, ever, and it ended by E6', () => {
  const obs = { state: 'Expired', expiry: 'RoundsFailed', judgedEvents: 0, settledEvents: 0, record: { history: { noVerdict: '1' } }, uploads: [] };
  allPass(abstainEndChecks('x', obs));
  fails(abstainEndChecks('x', { ...obs, judgedEvents: 1 }), 'x.never.judged');
  fails(abstainEndChecks('x', { ...obs, settledEvents: 1 }), 'x.never.settled');
  fails(abstainEndChecks('x', { ...obs, state: 'Settled' }), 'x.ended.expired');
  fails(abstainEndChecks('x', { ...obs, expiry: 'SubmissionsRefused' }), 'x.ended.expired');
  fails(abstainEndChecks('x', { ...obs, record: { history: { noVerdict: '0' } } }), 'x.record.noVerdict');
  fails(abstainEndChecks('x', { ...obs, uploads: ['QmU'] }), 'x.nothingUploaded');
});

const finding = { claimId: '1', outcome: 'HIGH', paidWei: '4', owedWei: '0', bcid: 'QmB' };
const view = (over = {}) => ({
  artifactHash: '0xh',
  fresh: true,
  notCounted: { listings: [] },
  badge: { message: '1 valid finding at or above MEDIUM · staker named by the repository: yes' },
  record: {
    history: { outcomes: ['1', '0', '0', '0', '1', '0'], claims: '3', pending: '0', released: '3', noVerdict: '1' },
    findings: [finding],
    listings: [{ listingId: '1', state: 'Open', escrowWei: '6', bondWei: '2', awards: ['0', '1', '4', '20'], history: { outcomes: ['1', '0', '0', '0', '1', '0'] } }],
  },
  ...over,
});
const expected = { artifactHash: '0xh', listingId: 1n, outcomes: [1, 0, 0, 0, 1, 0], claims: 3, released: 3, noVerdict: 1, findings: [finding], escrowWei: 6n, bondWei: 2n, awards: [0n, 1n, 4n, 20n] };

test('recordChecks: every field of the record against the round', () => {
  allPass(recordChecks('x', view(), expected));
  const history = (over) => view({ record: { ...view().record, history: { ...view().record.history, ...over } } });
  fails(recordChecks('x', view({ artifactHash: '0xother' }), expected), 'x.record.hash');
  fails(recordChecks('x', view({ fresh: false }), expected), 'x.record.fresh');
  fails(recordChecks('x', view({ notCounted: { listings: [{}] } }), expected), 'x.record.counted');
  fails(recordChecks('x', history({ outcomes: ['0', '0', '0', '0', '2', '0'] }), expected), 'x.record.outcomes');
  fails(recordChecks('x', history({ claims: '2' }), expected), 'x.record.claims');
  fails(recordChecks('x', history({ pending: '1' }), expected), 'x.record.claims');
  fails(recordChecks('x', history({ released: '0' }), expected), 'x.record.released');
  fails(recordChecks('x', history({ noVerdict: '0' }), expected), 'x.record.noVerdictCount');
  fails(recordChecks('x', view({ record: { ...view().record, findings: [] } }), expected), 'x.record.findings');
  fails(recordChecks('x', view({ record: { ...view().record, findings: [{ ...finding, paidWei: '5' }] } }), expected), 'x.record.findings');
  const listing = (over) => view({ record: { ...view().record, listings: [{ ...view().record.listings[0], ...over }] } });
  fails(recordChecks('x', listing({ escrowWei: '7' }), expected), 'x.record.escrow');
  fails(recordChecks('x', listing({ bondWei: '3' }), expected), 'x.record.terms');
  fails(recordChecks('x', listing({ awards: ['0', '1', '4', '21'] }), expected), 'x.record.terms');
  fails(recordChecks('x', listing({ state: 'Depleted' }), expected), 'x.record.terms');
  fails(recordChecks('x', listing({ history: { outcomes: ['0', '0', '0', '0', '2', '0'] } }), expected), 'x.record.listingOutcomes');
  fails(recordChecks('x', view({ badge: { message: 'staker named by the repository: no' } }), expected), 'x.record.stakerNamed');
});

test('pageChecks: what the browser read', () => {
  const pages = { record: { hash: '0xh', claims: '3', judged: '2', released: '3', state: 'open', pending: '0', verdicts: 'INVALID: 1\nHIGH: 1', noVerdict: '1', findings: 'HIGH QmB', main: 'the page' }, feed: 'listing', errors: [] };
  const o = { artifactHash: '0xH', claims: 3, judged: 2, released: 3, state: 'open', verdicts: ['INVALID: 1', 'HIGH: 1'], noVerdict: 1, findingBcid: 'QmB', invalidBcid: 'QmI' };
  allPass(pageChecks('x', pages, o));
  const r = (over) => ({ ...pages, record: { ...pages.record, ...over } });
  fails(pageChecks('x', r({ hash: '0xother' }), o), 'x.page.hash');
  fails(pageChecks('x', r({ claims: '2' }), o), 'x.page.claims');
  fails(pageChecks('x', r({ verdicts: 'HIGH: 1' }), o), 'x.page.verdicts');
  fails(pageChecks('x', r({ verdicts: 'INVALID: 1\nHIGH: 10' }), o), 'x.page.verdicts');
  fails(pageChecks('x', r({ judged: '3' }), o), 'x.page.judged');
  fails(pageChecks('x', r({ released: '2' }), o), 'x.page.released');
  fails(pageChecks('x', r({ state: 'closed' }), o), 'x.page.state');
  fails(pageChecks('x', r({ noVerdict: '0' }), o), 'x.page.noVerdict');
  fails(pageChecks('x', r({ findings: 'none' }), o), 'x.page.finding');
  fails(pageChecks('x', r({ main: 'it names QmI' }), o), 'x.page.invalidNotPublished');
  fails(pageChecks('x', { ...pages, errors: ['boom'] }, o), 'x.page.noErrors');
  fails(pageChecks('x', { ...pages, feed: '' }, o), 'x.page.feed');
});

test('integrityRunChecks: the proof failed where it reproduces, and a measured check is why: not a tamper flag, and no model asked', () => {
  const answer = (over = {}, poc = {}) => ({
    outcome: 'definitive',
    gates: { build: { status: 'pass' }, reproduces: { status: 'fail', basis: 'integrity' }, integrity: { status: 'fail' } },
    report: { poc: { testCount: 1, tests: [{ runs: ['fail', 'fail', 'fail'] }], integrity: { protectedPathsUnchanged: false, frameworkUnchanged: true, tamperFlags: [] }, ...poc } },
    ...over,
  });
  const obs = (a = answer(), over = {}) => ({ runnerCalls: [{ response: a }], aiCalls: [], providerCalls: [], failedCheck: 'protectedPathsUnchanged', ...over });
  allPass(integrityRunChecks('x', obs()));
  fails(integrityRunChecks('x', obs(answer({ outcome: 'abstain' }))), 'x.runner.gateFailed');
  fails(integrityRunChecks('x', obs(answer({ gates: { reproduces: { status: 'pass' }, integrity: { status: 'pass' } } }))), 'x.runner.gateFailed');
  fails(integrityRunChecks('x', obs(answer({ gates: { reproduces: { status: 'fail', basis: 'junit' }, integrity: { status: 'fail' } } }))), 'x.runner.reproducesOnlyThroughIntegrity');
  fails(integrityRunChecks('x', obs(answer({}, { integrity: { protectedPathsUnchanged: true, tamperFlags: [] } }))), 'x.runner.checkFailed');
  fails(integrityRunChecks('x', obs(answer({}, { integrity: { protectedPathsUnchanged: false, tamperFlags: [{ kind: 'framework-patched', file: 'test/E.t.sol', line: 9 }] } }))), 'x.runner.noTamperFlag');
  fails(integrityRunChecks('x', obs(answer({}, { tests: [{ runs: ['fail', 'pass', 'fail'] }] }))), 'x.runner.everyRunFailed');
  fails(integrityRunChecks('x', obs(answer(), { runnerCalls: [{ response: answer() }, { response: answer() }] })), 'x.runner.oneSandbox');
  fails(integrityRunChecks('x', obs(answer(), { aiCalls: [{}] })), 'x.noAi');
  fails(integrityRunChecks('x', obs(answer(), { providerCalls: [{}] })), 'x.noAi');
});

test('integrityRecordChecks: the record counts it under the check it names, apart from the other duplicates, read and not guessed', () => {
  const entry = { failed: 1, checks: [{ check: 'protectedPathsUnchanged', count: 1 }], otherDuplicates: 0, unread: 0, disagree: 0, late: { failed: 0, checks: [] } };
  const view = (over = {}, note = 'These claims settled as DUPLICATE on-chain: bond back, no award.') => ({ integrity: { note, listings: { 7: { ...entry, ...over } } } });
  const expected = { listingId: 7n, failed: 1, checks: [{ check: 'protectedPathsUnchanged', count: 1 }], note: 'These claims settled as DUPLICATE on-chain: bond back, no award.' };
  allPass(integrityRecordChecks('x', view(), expected));
  fails(integrityRecordChecks('x', view({ failed: 0 }), expected), 'x.record.integrityFailed');
  fails(integrityRecordChecks('x', view({ checks: [] }), expected), 'x.record.integrityChecks');
  fails(integrityRecordChecks('x', view({ checks: [{ check: 'identityComplete', count: 1 }] }), expected), 'x.record.integrityChecks');
  fails(integrityRecordChecks('x', view({ otherDuplicates: 1 }), expected), 'x.record.integrityApart');
  fails(integrityRecordChecks('x', view({ unread: 1 }), expected), 'x.record.integrityApart');
  fails(integrityRecordChecks('x', view({ disagree: 1 }), expected), 'x.record.integrityApart');
  fails(integrityRecordChecks('x', view({ late: { failed: 1, checks: [] } }), expected), 'x.record.integrityApart');
  fails(integrityRecordChecks('x', view({}, 'the maker set a trap'), expected), 'x.record.integrityNote');
  fails(integrityRecordChecks('x', {}, expected), 'x.record.integrityFailed');
});

test('integrityPageChecks: what the browser read: the count, the check, the note, and nothing published', () => {
  const pages = { record: { integrity: '1', integrityChecks: 'protectedPathsUnchanged: 1', integrityOther: '0', integrityNote: 'NOTE', main: 'the record' } };
  const o = { failed: 1, check: 'protectedPathsUnchanged', count: 1, note: 'NOTE', bcid: 'QmDup' };
  const r = (over) => ({ record: { ...pages.record, ...over } });
  allPass(integrityPageChecks('x', pages, o));
  fails(integrityPageChecks('x', r({ integrity: '0' }), o), 'x.page.integrityFailed');
  fails(integrityPageChecks('x', r({ integrityChecks: 'identityComplete: 1' }), o), 'x.page.integrityChecks');
  fails(integrityPageChecks('x', r({ integrityOther: '1' }), o), 'x.page.integrityOther');
  fails(integrityPageChecks('x', r({ integrityNote: 'the maker set a trap' }), o), 'x.page.integrityNote');
  fails(integrityPageChecks('x', r({ main: 'it names QmDup' }), o), 'x.page.duplicateNotPublished');
});

// Node P20: one listing of the round names documents. The builder's report says what the tier would read, and the
// hunter's check shows the pack the real runner at the pin built for it: the documents tier, right after the source,
// with the expected files in order and the binary one left out as not text. The round's other listing names none,
// and its packs have no documents tier.
const DOCUMENT_LABEL = 'the maker\'s document at the listed commit (stake.documents): ';
const TIERS = ['poc', 'claim', 'source', 'documents', 'callSites', 'knownIssues', 'priorFindings', 'fix', 'tree'];
const docsPack = (over = {}) => ({
  tiers: TIERS.map((name, i) => ({ rank: i + 1, name, status: 'full', asked: name === 'documents' ? 3 : 1, delivered: name === 'documents' ? 2 : 1, omitted: name === 'documents' ? { notText: 1 } : {}, cut: 0 })),
  files: [
    { name: '00-manifest.json', tier: 'manifest', text: '{}' },
    { name: '04-document-001.txt', tier: 'documents', text: `# ${DOCUMENT_LABEL}README.md\n# Vault\n` },
    { name: '04-document-002.txt', tier: 'documents', text: `# ${DOCUMENT_LABEL}docs/spec.md\nspec\n` },
  ],
  ...over,
});
const docsCheck = (pack = docsPack()) => ({ code: 0, json: { forecast: { verdict: 'pass', documents: { globs: ['README.md', 'docs/**', 'SPEC/**'], tier: { rank: 4, status: 'full', asked: 3, delivered: 2, omitted: { notText: 1 }, cut: 0 } } }, pack } });
const DOCS_EXPECTED = { globs: ['README.md', 'docs/**', 'SPEC/**'], files: ['README.md', 'docs/spec.md'], omitted: { notText: 1 } };

test('documentsPackChecks: the runner\'s documents tier, at rank 4, with the expected files in order, as the tool shows it', () => {
  const runnerAnswer = { contextPack: docsPack() };
  const sent = { spec: { stake: { documents: DOCS_EXPECTED.globs } } };
  allPass(documentsPackChecks('d', { check: docsCheck(), runnerAnswer, sent, ...DOCS_EXPECTED }));
  fails(documentsPackChecks('d', { check: { ...docsCheck(), code: 1 }, runnerAnswer, sent, ...DOCS_EXPECTED }), 'd.check.passes');
  fails(documentsPackChecks('d', { check: docsCheck(docsPack({ tiers: docsPack().tiers.filter((t) => t.name !== 'documents') })), runnerAnswer, sent, ...DOCS_EXPECTED }), 'd.pack.documentsTier');
  const swapped = docsPack();
  swapped.files = [swapped.files[0], swapped.files[2], swapped.files[1]];
  fails(documentsPackChecks('d', { check: docsCheck(swapped), runnerAnswer: { contextPack: swapped }, sent, ...DOCS_EXPECTED }), 'd.pack.documentFiles');
  const moved = docsPack();
  moved.tiers = [...moved.tiers.slice(0, 2), moved.tiers[3], moved.tiers[2], ...moved.tiers.slice(4)];
  fails(documentsPackChecks('d', { check: docsCheck(moved), runnerAnswer: { contextPack: moved }, sent, ...DOCS_EXPECTED }), 'd.pack.documentsTier');
  fails(documentsPackChecks('d', { check: docsCheck(), runnerAnswer: { contextPack: { ...docsPack(), files: [] } }, sent, ...DOCS_EXPECTED }), 'd.pack.isTheRunners');
  fails(documentsPackChecks('d', { check: docsCheck(), runnerAnswer, sent: { spec: { stake: {} } }, ...DOCS_EXPECTED }), 'd.request.documents');
  const forecast = docsCheck();
  forecast.json.forecast.documents.tier.delivered = 3;
  fails(documentsPackChecks('d', { check: forecast, runnerAnswer, sent, ...DOCS_EXPECTED }), 'd.forecast.documents');
});

test('documentsListingChecks: the builder\'s documents step, read, skipped and unmatched, and its warning', () => {
  const report = {
    steps: [{ name: 'spec', status: 'ok' }, { name: 'control', status: 'ok' }, { name: 'fetch', status: 'ok' }, { name: 'documents', status: 'ok' }, { name: 'build', status: 'ok' }],
    documents: { globs: DOCS_EXPECTED.globs, candidates: 9, read: [{ path: 'README.md', bytes: 8 }, { path: 'docs/spec.md', bytes: 5 }], pastCap: [], skipped: [{ path: 'docs/diagram.bin', reason: 'notText', bytes: 7 }], unmatched: [{ index: 2, glob: 'SPEC/**' }] },
    warnings: [{ code: 'STAKE_DOCUMENT_MATCHES_NOTHING', path: '/stake/documents/2', detail: '"SPEC/**" matches nothing' }],
  };
  const expected = { read: ['README.md', 'docs/spec.md'], skipped: [['docs/diagram.bin', 'notText']], unmatched: ['SPEC/**'] };
  allPass(documentsListingChecks('d', { status: 'ready', validationReport: report }, expected));
  fails(documentsListingChecks('d', { status: 'refused', validationReport: report }, expected), 'd.listing.ready');
  fails(documentsListingChecks('d', { status: 'ready', validationReport: { ...report, steps: report.steps.filter((x) => x.name !== 'documents') } }, expected), 'd.listing.documentsStep');
  fails(documentsListingChecks('d', { status: 'ready', validationReport: { ...report, documents: { ...report.documents, read: [] } } }, expected), 'd.listing.read');
  fails(documentsListingChecks('d', { status: 'ready', validationReport: { ...report, documents: { ...report.documents, skipped: [] } } }, expected), 'd.listing.skipped');
  fails(documentsListingChecks('d', { status: 'ready', validationReport: { ...report, warnings: [] } }, expected), 'd.listing.unmatchedWarned');
});

test('noDocumentsTierChecks: a pack for a listing without documents has no documents tier, and its ranks run 1-8', () => {
  const plain = { tiers: TIERS.filter((t) => t !== 'documents').map((name, i) => ({ rank: i + 1, name })), files: [{ name: '00-manifest.json', tier: 'manifest', text: '{}' }] };
  allPass(noDocumentsTierChecks('v', plain));
  fails(noDocumentsTierChecks('v', docsPack()), 'v.pack.noDocumentsTier');
  fails(noDocumentsTierChecks('v', null), 'v.pack.noDocumentsTier');
});

// Node P42: the maker's hold in the round (StakeAttestation.hold, node P39). One maker call stops new commits on the
// listing at once and leaves its pending claims alone; a commit is then refused, a late claim is taken behind the
// claim from before the hold, that earlier claim is judged and paid as before, and the listing rolls forward from the
// hold. Each step is checked by what it left on the chain and in the site's answers, never by its having run.
const MAKER = '0xMaker';
const HELD_AT = 1_800_000_123n;
const ISO = '2027-01-15T08:02:03Z';
const onChain = (over = {}) => ({ state: 'Open', heldAt: 0n, acceptsCommits: true, acceptsLateClaims: false, pendingClaims: 1n, headClaim: 9n, tailClaim: 9n, claimsCommitted: 7n, lateClaims: 0n, escrowWei: 26n, fundedUntil: 1_802_000_000n, ...over });
const held = (over = {}) => onChain({ heldAt: HELD_AT, acceptsCommits: false, acceptsLateClaims: true, ...over });

test('holdChecks: the maker\'s call, its time the block\'s, no commit and late claims from then on, and nothing else moved', () => {
  const o = (over = {}) => ({ event: { listingId: 1n, heldAt: HELD_AT, from: MAKER, blockTimestamp: Number(HELD_AT) }, maker: MAKER, before: onChain(), after: held(), ...over });
  allPass(holdChecks('x', o()));
  allPass(holdChecks('x', o({ before: onChain({ state: 'Depleted', acceptsCommits: false }), after: held({ state: 'Depleted' }) })), 'a Depleted listing took no commit before it either');
  fails(holdChecks('x', o({ event: null })), 'x.hold.byTheMaker');
  fails(holdChecks('x', o({ event: { ...o().event, from: '0xOther' } })), 'x.hold.byTheMaker');
  // the time is the hold's own block's: not a later one, and not a time the view does not say
  fails(holdChecks('x', o({ event: { ...o().event, blockTimestamp: Number(HELD_AT) - 1 } })), 'x.hold.time');
  fails(holdChecks('x', o({ after: held({ heldAt: HELD_AT + 1n }) })), 'x.hold.time');
  fails(holdChecks('x', o({ after: held({ heldAt: 0n }) })), 'x.hold.time');
  fails(holdChecks('x', o({ before: onChain({ heldAt: HELD_AT }) })), 'x.hold.time');
  // a hold is not a state
  fails(holdChecks('x', o({ after: held({ state: 'Rolled' }) })), 'x.hold.stateAsItWas');
  fails(holdChecks('x', o({ before: onChain({ state: 'Depleted', acceptsCommits: false }), after: held({ state: 'Open' }) })), 'x.hold.stateAsItWas');
  fails(holdChecks('x', o({ after: held({ acceptsCommits: true }) })), 'x.hold.noCommitFromNow');
  fails(holdChecks('x', o({ after: held({ acceptsLateClaims: false }) })), 'x.hold.lateClaimsFromNow');
  fails(holdChecks('x', o({ before: onChain({ acceptsLateClaims: true }) })), 'x.hold.lateClaimsFromNow');
  // every pending claim and the escrow are what they were
  for (const moved of [{ pendingClaims: 0n }, { headClaim: 0n }, { tailClaim: 10n }, { claimsCommitted: 8n }, { lateClaims: 1n }, { escrowWei: 25n }, { fundedUntil: 1n }]) {
    fails(holdChecks('x', o({ after: held(moved) })), 'x.hold.pendingUntouched');
  }
});

const heldRecord = (over = {}) => ({
  fresh: true,
  record: { listings: [{ listingId: '1', state: 'Open' }], history: { pending: '1' } },
  labels: { listings: { 1: { heldAt: Number(HELD_AT), live: false, lapsed: false } } },
  badge: { state: 'ended', message: 'stake on hold since 2027-01-15' },
  ...over,
});
const feedOf = (ids = [], apart = []) => ({ fresh: true, listings: ids.map((listingId) => ({ listingId })), notCounted: apart.map((listingId) => ({ listingId })) });

test('heldSiteChecks: the site says on hold, since when, not live, no feed entry, and the claims from before it still pending', () => {
  const o = (over = {}) => ({ record: heldRecord(), feed: feedOf(['2']), listingId: 1n, heldAt: HELD_AT, state: 'Open', pending: 1, ...over });
  allPass(heldSiteChecks('x', o()));
  allPass(heldSiteChecks('x', o({ feed: feedOf() })), 'an empty feed is a feed without it');
  const labels = (l) => heldRecord({ labels: { listings: { 1: { ...heldRecord().labels.listings[1], ...l } } } });
  fails(heldSiteChecks('x', o({ record: labels({ heldAt: null }) })), 'x.site.heldAt');
  fails(heldSiteChecks('x', o({ record: labels({ heldAt: Number(HELD_AT) + 1 }) })), 'x.site.heldAt');
  fails(heldSiteChecks('x', o({ record: labels({ heldAt: String(HELD_AT) }) })), 'x.site.heldAt');
  fails(heldSiteChecks('x', o({ record: labels({ live: true }) })), 'x.site.notLive');
  fails(heldSiteChecks('x', o({ record: heldRecord({ record: { ...heldRecord().record, listings: [{ listingId: '1', state: 'Rolled' }] } }) })), 'x.site.stateIsTheChains');
  fails(heldSiteChecks('x', o({ record: heldRecord({ record: { ...heldRecord().record, history: { pending: '0' } } }) })), 'x.site.pendingStays');
  fails(heldSiteChecks('x', o({ feed: feedOf(['1', '2']) })), 'x.site.feedWithoutIt');
  fails(heldSiteChecks('x', o({ feed: feedOf(['2'], ['1']) })), 'x.site.feedWithoutIt');
  fails(heldSiteChecks('x', o({ feed: {} })), 'x.site.feedWithoutIt');
  fails(heldSiteChecks('x', o({ record: heldRecord({ badge: { state: 'live', message: 'no finding at or above MEDIUM while staked' } }) })), 'x.site.badge');
  fails(heldSiteChecks('x', o({ record: heldRecord({ badge: { state: 'ended', message: 'stake on hold since 2027-01-16' } }) })), 'x.site.badge');
  fails(heldSiteChecks('x', o({ record: heldRecord({ fresh: false }) })), 'x.site.fresh');
  fails(heldSiteChecks('x', o({ feed: { ...feedOf(['2']), fresh: false } })), 'x.site.fresh');
});

const counts = (over = {}) => ({ pins: 12, nonce: 30, claimCount: 9n, claimsCommitted: 7n, pendingClaims: 1n, lateClaims: 0n, tailClaim: 9n, acceptsCommits: false, ...over });
const refusal = (over = {}) => ({ code: 1, json: null, stdout: '', stderr: 'verdikta-attest: LISTING_NOT_ACCEPTING: This listing takes no commits now.\n', ...over });

// the invocation's JSON-RPC calls as the round reads them back from its recording: one HTTP request each, in order
const trace = (...calls) => ({ calls: calls.map((c, batch) => ({ batch, ...c })) });
const eligibilityRead = (asks, answer) => ({ method: 'eth_call', view: asks, asks, answer });
const viewCall = (name) => ({ method: 'eth_call', view: name });
const rpcCall = (method) => ({ method });
// the tool as it is: the chain, the listing, the commit's price, then whether the listing takes a commit
const BEFORE_THE_ANSWER = [rpcCall('eth_chainId'), viewCall('getListing'), viewCall('commitPrice')];
const askedAndRefused = trace(...BEFORE_THE_ANSWER, eligibilityRead('acceptsCommits', false));

test('refusedCommitChecks: by what a refused commit leaves. The tool refused, nothing was pinned, nothing was sent, the counts are what they were', () => {
  const o = (over = {}) => ({ run: refusal(), before: counts(), after: counts(), asked: askedAndRefused, ...over });
  allPass(refusedCommitChecks('x', o()));
  // whatever code and words the refusal carries: a later node gives a listing on hold its own
  allPass(refusedCommitChecks('x', o({ run: refusal({ stderr: 'verdikta-attest: SOME_LATER_CODE: Whatever it says then.\n' }) })));
  // a commit that went through is no refusal, and neither is a crash, a usage error or a failure to reach the chain
  fails(refusedCommitChecks('x', o({ run: refusal({ code: 0, json: { claimId: '10' } }) })), 'x.commit.refused');
  fails(refusedCommitChecks('x', o({ run: refusal({ json: { claimId: '10' } }) })), 'x.commit.refused');
  fails(refusedCommitChecks('x', o({ run: refusal({ code: null }) })), 'x.commit.refused');
  fails(refusedCommitChecks('x', o({ run: refusal({ code: 2 }) })), 'x.commit.refused');
  fails(refusedCommitChecks('x', o({ run: refusal({ code: 3 }) })), 'x.commit.refused');
  fails(refusedCommitChecks('x', o({ run: refusal({ stderr: 'verdikta-attest: INTERNAL: TypeError\n' }) })), 'x.commit.refused');
  fails(refusedCommitChecks('x', o({ run: refusal({ stderr: 'verdikta-attest: RPC_UNAVAILABLE: The RPC did not give a usable answer.\n' }) })), 'x.commit.refused');
  fails(refusedCommitChecks('x', o({ run: refusal({ stderr: '' }) })), 'x.commit.refused');
  fails(refusedCommitChecks('x', o({ after: counts({ pins: 13 }) })), 'x.commit.nothingPinned');
  fails(refusedCommitChecks('x', o({ after: counts({ nonce: 31 }) })), 'x.commit.nothingSent');
  fails(refusedCommitChecks('x', o({ after: counts({ claimCount: 10n }) })), 'x.commit.nothingSent');
  for (const moved of [{ claimsCommitted: 8n }, { pendingClaims: 2n }, { lateClaims: 1n }, { tailClaim: 10n }]) {
    fails(refusedCommitChecks('x', o({ after: counts(moved) })), 'x.commit.claimCountAsItWas');
  }
  fails(refusedCommitChecks('x', o({ after: counts({ acceptsCommits: true }) })), 'x.commit.chainRefuses');
  fails(refusedCommitChecks('x', o({ before: counts({ acceptsCommits: true }) })), 'x.commit.chainRefuses');
});

test('refusedCommitChecks: an unrelated failure leaves the same things untouched, so the tool\'s own reads must show it reached the chain\'s refusal', () => {
  const o = (over = {}) => ({ run: refusal(), before: counts(), after: counts(), asked: askedAndRefused, ...over });
  // the tool may read the listing's eligibility as acceptsCommits, as heldAt, or both; either answer that refuses will do
  allPass(refusedCommitChecks('x', o({ asked: trace(eligibilityRead('heldAt', HELD_AT)) })));
  allPass(refusedCommitChecks('x', o({ asked: trace(eligibilityRead('acceptsCommits', false), eligibilityRead('heldAt', HELD_AT)) })));
  allPass(refusedCommitChecks('x', o({ asked: trace(eligibilityRead('heldAt', 0n), eligibilityRead('acceptsCommits', false)) })));
  // exit 1 with one of the tool's own errors, and nothing pinned, sent or counted: an archive it could not read, a
  // folder in use, a file it could not open. It never asked the chain about the listing, and that is what fails it.
  for (const unrelated of ['ARCHIVE_UNAVAILABLE', 'FOLDER_BUSY', 'FILE_ERROR']) {
    const run = refusal({ stderr: `verdikta-attest: ${unrelated}: Something else went wrong.\n` });
    for (const asked of [trace(), trace(...BEFORE_THE_ANSWER)]) {
      assert.deepEqual(failing(refusedCommitChecks('x', o({ run, asked }))), ['x.commit.stoppedAtTheChainsAnswer'], unrelated);
    }
  }
  fails(refusedCommitChecks('x', o({ asked: undefined })), 'x.commit.stoppedAtTheChainsAnswer');
  // it asked, and the answer did not come: no refusal of the chain's was read
  fails(refusedCommitChecks('x', o({ asked: trace(eligibilityRead('acceptsCommits', null)) })), 'x.commit.stoppedAtTheChainsAnswer');
  // a hold view that answers 0 refuses nothing
  fails(refusedCommitChecks('x', o({ asked: trace(eligibilityRead('heldAt', 0n)) })), 'x.commit.stoppedAtTheChainsAnswer');
  // the chain said the listing takes a commit: whatever stopped the tool, it was not the listing
  fails(refusedCommitChecks('x', o({ asked: trace(eligibilityRead('acceptsCommits', true)) })), 'x.commit.stoppedAtTheChainsAnswer');
  fails(refusedCommitChecks('x', o({ asked: trace(eligibilityRead('acceptsCommits', false), eligibilityRead('acceptsCommits', true)) })), 'x.commit.stoppedAtTheChainsAnswer');
  // the same views of another listing are no read of this one's eligibility: the round marks only this listing's
  fails(refusedCommitChecks('x', o({ asked: trace(viewCall('acceptsCommits'), viewCall('heldAt')) })), 'x.commit.stoppedAtTheChainsAnswer');
  // and a transaction went out through that node
  fails(refusedCommitChecks('x', o({ asked: trace(eligibilityRead('acceptsCommits', false), rpcCall('eth_sendRawTransaction')) })), 'x.commit.stoppedAtTheChainsAnswer');
});

test('refusedCommitChecks: a tool that read the refusal and went on preparing the commit did not stop at the chain\'s answer, whatever it failed on later', () => {
  const o = (over = {}) => ({ run: refusal(), before: counts(), after: counts(), asked: askedAndRefused, ...over });
  // It read "no commit", ignored it, went through the allowlist and the wallet's balance, and then failed on a file
  // of the claim: exit 1 with an error of its own, nothing pinned, nothing sent, the counts as they were. Every other
  // check passes; this one does not.
  const fileError = refusal({ stderr: 'verdikta-attest: FILE_ERROR: The archive could not be written.\n' });
  const wentOn = trace(...BEFORE_THE_ANSWER, eligibilityRead('acceptsCommits', false), viewCall('isAllowed'), rpcCall('eth_maxPriorityFeePerGas'), rpcCall('eth_getBalance'));
  assert.deepEqual(failing(refusedCommitChecks('x', o({ run: fileError, asked: wentOn }))), ['x.commit.stoppedAtTheChainsAnswer']);
  assert.match(refusedCommitChecks('x', o({ run: fileError, asked: wentOn })).find((c) => c.name === 'x.commit.stoppedAtTheChainsAnswer').detail, /after the refusing answer it went on with: isAllowed, eth_getBalance;/);
  // each of them alone is enough, and so is the hold's own view as the refusing read
  for (const next of [viewCall('isAllowed'), rpcCall('eth_getBalance'), rpcCall('eth_getTransactionCount'), rpcCall('eth_estimateGas')]) {
    fails(refusedCommitChecks('x', o({ asked: trace(eligibilityRead('acceptsCommits', false), next) })), 'x.commit.stoppedAtTheChainsAnswer');
    fails(refusedCommitChecks('x', o({ asked: trace(eligibilityRead('heldAt', 0n), eligibilityRead('heldAt', HELD_AT), next) })), 'x.commit.stoppedAtTheChainsAnswer');
  }
  // Only what came after the answer counts. The same calls before it are a tool that checks in another order; and
  // calls sent in one request with the refusing read were asked with it, not after it.
  allPass(refusedCommitChecks('x', o({ asked: trace(viewCall('isAllowed'), rpcCall('eth_getBalance'), eligibilityRead('acceptsCommits', false)) })));
  allPass(refusedCommitChecks('x', o({ asked: { calls: [{ batch: 0, ...viewCall('commitPrice') }, { batch: 1, ...eligibilityRead('acceptsCommits', false) }, { batch: 1, ...viewCall('isAllowed') }, { batch: 1, ...rpcCall('eth_getBalance') }] } })));
  // What a tool may still ask once it has the refusal, to say why and what is left: the hold's time, whether a late
  // claim is taken, the listing, the price, the chain's time. None of it prepares a commit.
  allPass(refusedCommitChecks('x', o({ asked: trace(...BEFORE_THE_ANSWER, eligibilityRead('acceptsCommits', false), eligibilityRead('heldAt', HELD_AT), viewCall('acceptsLateClaims'), viewCall('getListing'), viewCall('commitPrice'), rpcCall('eth_getBlockByNumber'), rpcCall('eth_blockNumber')) })));
});

test('lateClaimChecks: taken on the listing on hold as a late claim, behind the claim from before it, and never one of its pending claims', () => {
  const claim = (over = {}) => ({ late: true, disclosedAt: 5n, prevInOrder: 9n, listingId: 1n, ...over });
  const o = (over = {}) => ({ run: { code: 0, json: { claimId: '10' } }, claimId: 10n, claim: claim(), events: { late: 1, committed: 0 }, before: held(), after: held({ lateClaims: 1n, tailClaim: 10n }), earlier: 9n, listingId: 1n, ...over });
  allPass(lateClaimChecks('x', o()));
  fails(lateClaimChecks('x', o({ run: { code: 1, json: null } })), 'x.late.taken');
  fails(lateClaimChecks('x', o({ claimId: 0n })), 'x.late.taken');
  fails(lateClaimChecks('x', o({ claim: claim({ listingId: 2n }) })), 'x.late.taken');
  // an ordinary commit that slipped through would show here: Committed, not LateClaim, and one more pending claim
  fails(lateClaimChecks('x', o({ claim: claim({ late: false }) })), 'x.late.isALateClaim');
  fails(lateClaimChecks('x', o({ events: { late: 0, committed: 1 } })), 'x.late.isALateClaim');
  fails(lateClaimChecks('x', o({ events: { late: 1, committed: 1 } })), 'x.late.isALateClaim');
  fails(lateClaimChecks('x', o({ after: held({ lateClaims: 1n, tailClaim: 10n, pendingClaims: 2n }) })), 'x.late.neverPending');
  fails(lateClaimChecks('x', o({ after: held({ lateClaims: 1n, tailClaim: 10n, claimsCommitted: 8n }) })), 'x.late.neverPending');
  fails(lateClaimChecks('x', o({ after: held({ lateClaims: 0n, tailClaim: 10n }) })), 'x.late.neverPending');
  // commit order: the claim from before the hold stays first, and the late claim joins the tail behind it
  fails(lateClaimChecks('x', o({ after: held({ lateClaims: 1n, tailClaim: 10n, headClaim: 10n }) })), 'x.late.behindTheEarlierClaim');
  fails(lateClaimChecks('x', o({ after: held({ lateClaims: 1n, tailClaim: 9n }) })), 'x.late.behindTheEarlierClaim');
  fails(lateClaimChecks('x', o({ claim: claim({ prevInOrder: 0n }) })), 'x.late.behindTheEarlierClaim');
  fails(lateClaimChecks('x', o({ claim: claim({ disclosedAt: 0n }) })), 'x.late.disclosed');
  fails(lateClaimChecks('x', o({ after: held({ lateClaims: 1n, tailClaim: 10n, escrowWei: 25n }) })), 'x.late.escrowUntouched');
  fails(lateClaimChecks('x', o({ after: held({ lateClaims: 1n, tailClaim: 10n, heldAt: 0n }) })), 'x.late.stillOnHold');
});

test('lateNoAwardChecks: the escrow is the one from before the late claim was released, when it is judged and when it is settled (PR 242, R7-F3)', () => {
  const o = (over = {}) => ({ paidWei: 0n, owedWei: 0n, baseline: 900n, judged: 900n, settled: 900n, ...over });
  allPass(lateNoAwardChecks('x', o()));
  // A debit while the late claim was revealed or judged. The comparison this replaced began at Judged, so it had the
  // reduced balance on both sides and passed; the baseline is from before the late claim's release.
  const debited = o({ judged: 850n, settled: 850n });
  assert.equal(debited.settled, debited.judged, 'what the old comparison saw: no change');
  fails(lateNoAwardChecks('x', debited), 'x.late.judged.escrowUntouched');
  fails(lateNoAwardChecks('x', debited), 'x.late.noAward');
  // a debit at the settle alone, and a credit either time: the escrow does not move at all
  assert.deepEqual(failing(lateNoAwardChecks('x', o({ settled: 850n }))), ['x.late.noAward']);
  fails(lateNoAwardChecks('x', o({ judged: 950n })), 'x.late.judged.escrowUntouched');
  fails(lateNoAwardChecks('x', o({ settled: 950n })), 'x.late.noAward');
  // debited while judged and put back by the settle: the first check says so
  assert.deepEqual(failing(lateNoAwardChecks('x', o({ judged: 850n }))), ['x.late.judged.escrowUntouched']);
  // an award paid or owed to the claim, with the escrow as it was
  fails(lateNoAwardChecks('x', o({ paidWei: 1n })), 'x.late.noAward');
  fails(lateNoAwardChecks('x', o({ owedWei: 1n })), 'x.late.noAward');
  // a balance that was not read is no evidence
  fails(lateNoAwardChecks('x', o({ baseline: undefined, judged: undefined, settled: undefined })), 'x.late.judged.escrowUntouched');
  fails(lateNoAwardChecks('x', o({ baseline: undefined, judged: undefined, settled: undefined })), 'x.late.noAward');
});

test('laterRecordChecks: the late claim is under the record\'s late claims, by its outcome, with no award, and not among the claims', () => {
  const record = (h = {}, findings = []) => ({ record: { history: { claims: '7', outcomes: ['3', '1', '0', '0', '2', '0'], lateClaims: '1', lateOutcomes: ['0', '1', '0', '0', '0', '0'], lateExpired: '0', ...h }, findings } });
  const o = (over = {}) => ({ record: record(), lateClaims: 1, lateOutcomes: [0, 1, 0, 0, 0, 0], claims: 7, outcomes: [3, 1, 0, 0, 2, 0], ...over });
  allPass(laterRecordChecks('x', o()));
  fails(laterRecordChecks('x', o({ record: record({ lateClaims: '0' }) })), 'x.record.lateClaims');
  fails(laterRecordChecks('x', o({ record: record({ lateOutcomes: ['0', '0', '0', '0', '0', '0'] }) })), 'x.record.lateOutcomes');
  fails(laterRecordChecks('x', o({ record: record({ lateExpired: '1' }) })), 'x.record.lateOutcomes');
  // a late claim counted with the stake's own claims would move these
  fails(laterRecordChecks('x', o({ record: record({ claims: '8' }) })), 'x.record.notAmongTheClaims');
  fails(laterRecordChecks('x', o({ record: record({ outcomes: ['3', '2', '0', '0', '2', '0'] }) })), 'x.record.notAmongTheClaims');
  // an outcome that publishes nothing (INVALID, DUPLICATE): no late finding is expected, and none may appear
  fails(laterRecordChecks('x', o({ record: record({}, [{ claimId: '10', outcome: 'LOW', late: true, paidWei: '0', owedWei: '0' }]) })), 'x.record.lateFindings');
  // a late finding that is valid is published, with `late` set, and never paid
  const valid = { lateOutcomes: [0, 0, 1, 0, 0, 0], findings: [{ claimId: '10', outcome: 'LOW' }] };
  const lateLow = (f = {}) => record({ lateOutcomes: ['0', '0', '1', '0', '0', '0'] }, [{ claimId: '10', outcome: 'LOW', late: true, paidWei: '0', owedWei: '0', ...f }, { claimId: '2', outcome: 'HIGH', late: false, paidWei: '4', owedWei: '0' }]);
  allPass(laterRecordChecks('x', o({ ...valid, record: lateLow() })));
  // the verdict is counted, and the finding is not there, or is there without its `late` flag, or by another outcome
  fails(laterRecordChecks('x', o({ ...valid, record: record({ lateOutcomes: ['0', '0', '1', '0', '0', '0'] }, [{ claimId: '2', outcome: 'HIGH', late: false, paidWei: '4', owedWei: '0' }]) })), 'x.record.lateFindings');
  fails(laterRecordChecks('x', o({ ...valid, record: lateLow({ late: false }) })), 'x.record.lateFindings');
  fails(laterRecordChecks('x', o({ ...valid, record: lateLow({ outcome: 'MEDIUM' }) })), 'x.record.lateFindings');
  fails(laterRecordChecks('x', o({ ...valid, record: lateLow({ claimId: '11' }) })), 'x.record.lateFindings');
  fails(laterRecordChecks('x', o({ ...valid, record: lateLow({ paidWei: '4' }) })), 'x.record.noAward');
  fails(laterRecordChecks('x', o({ ...valid, record: lateLow({ owedWei: '4' }) })), 'x.record.noAward');
});

test('rolledFromHoldChecks: the roll is the maker\'s, the hold ends in it, the lineage links both ways, and the site says both', () => {
  const HASH = '0xold';
  const NEXT = '0xnew';
  const old = (over = {}) => ({ state: 'Rolled', successor: 2n, heldAt: 0n, acceptsCommits: false, acceptsLateClaims: true, ...over });
  const successor = (over = {}) => ({ state: 'Open', predecessor: 1n, heldAt: 0n, acceptsCommits: true, ...over });
  const record = (l = {}, labels = {}) => ({ record: { listings: [{ listingId: '1', state: 'Rolled', successor: '2', successorHash: NEXT, ...l }] }, labels: { listings: { 1: { heldAt: null, live: false, ...labels } } } });
  const successorRecord = (l = {}, labels = {}) => ({ artifactHash: NEXT, record: { listings: [{ listingId: '2', state: 'Open', predecessor: '1', predecessorHash: HASH, ...l }] }, labels: { listings: { 2: { heldAt: null, live: true, ...labels } } } });
  const o = (over = {}) => ({ event: { from: MAKER, successorListingId: 2n }, maker: MAKER, listingId: 1n, successorId: 2n, artifactHash: HASH, successorHash: NEXT, old: old(), successor: successor(), record: record(), successorRecord: successorRecord(), feed: feedOf(['2']), ...over });
  allPass(rolledFromHoldChecks('x', o()));
  fails(rolledFromHoldChecks('x', o({ event: null })), 'x.roll.byTheMaker');
  fails(rolledFromHoldChecks('x', o({ event: { from: '0xOther', successorListingId: 2n } })), 'x.roll.byTheMaker');
  fails(rolledFromHoldChecks('x', o({ event: { from: MAKER, successorListingId: 3n } })), 'x.roll.byTheMaker');
  fails(rolledFromHoldChecks('x', o({ old: old({ state: 'Open' }) })), 'x.roll.rolled');
  fails(rolledFromHoldChecks('x', o({ old: old({ successor: 0n }) })), 'x.roll.rolled');
  fails(rolledFromHoldChecks('x', o({ successor: successor({ predecessor: 0n }) })), 'x.roll.rolled');
  // the hold has ended: the view answers 0, and the listing takes late claims as a Rolled one, never a commit
  fails(rolledFromHoldChecks('x', o({ old: old({ heldAt: HELD_AT }) })), 'x.roll.holdEnded');
  fails(rolledFromHoldChecks('x', o({ old: old({ acceptsCommits: true }) })), 'x.roll.holdEnded');
  fails(rolledFromHoldChecks('x', o({ old: old({ acceptsLateClaims: false }) })), 'x.roll.holdEnded');
  // the fixed version was never on hold, and takes commits
  fails(rolledFromHoldChecks('x', o({ successor: successor({ acceptsCommits: false }) })), 'x.roll.successorTakesCommits');
  fails(rolledFromHoldChecks('x', o({ successor: successor({ heldAt: HELD_AT }) })), 'x.roll.successorTakesCommits');
  fails(rolledFromHoldChecks('x', o({ successor: successor({ state: 'Depleted' }) })), 'x.roll.successorTakesCommits');
  // the site: the old version's record says Rolled, no longer on hold, and names the successor
  fails(rolledFromHoldChecks('x', o({ record: record({ state: 'Open' }) })), 'x.roll.record');
  fails(rolledFromHoldChecks('x', o({ record: record({}, { heldAt: Number(HELD_AT) }) })), 'x.roll.record');
  fails(rolledFromHoldChecks('x', o({ record: record({}, { live: true }) })), 'x.roll.record');
  fails(rolledFromHoldChecks('x', o({ record: record({ successor: '0' }) })), 'x.roll.record');
  fails(rolledFromHoldChecks('x', o({ record: record({ successorHash: '0xother' }) })), 'x.roll.record');
  // and the successor's record names the version it fixed
  fails(rolledFromHoldChecks('x', o({ successorRecord: successorRecord({ predecessor: '0' }) })), 'x.roll.successorRecord');
  fails(rolledFromHoldChecks('x', o({ successorRecord: successorRecord({ predecessorHash: '0xother' }) })), 'x.roll.successorRecord');
  fails(rolledFromHoldChecks('x', o({ successorRecord: successorRecord({}, { live: false }) })), 'x.roll.successorRecord');
  fails(rolledFromHoldChecks('x', o({ successorRecord: successorRecord({}, { heldAt: Number(HELD_AT) }) })), 'x.roll.successorRecord');
  fails(rolledFromHoldChecks('x', o({ successorRecord: { ...successorRecord(), artifactHash: HASH } })), 'x.roll.successorRecord');
  fails(rolledFromHoldChecks('x', o({ successorRecord: null })), 'x.roll.successorRecord');
  // the feed offers the successor, and not the version that rolled
  fails(rolledFromHoldChecks('x', o({ feed: feedOf() })), 'x.roll.feed');
  fails(rolledFromHoldChecks('x', o({ feed: feedOf(['1', '2']) })), 'x.roll.feed');
});

test('holdPageChecks: what the browser read while the listing was on hold: its own page, the record, and a feed without it', () => {
  const pages = {
    listing: { state: 'open', heldSince: ISO, held: `Listing 1 is on hold since ${ISO}: it takes no new claims.`, holdSection: `This listing is on hold since ${ISO}.` },
    record: { state: 'open', labels: 'staked, on hold', held: ISO },
    feed: { hasListing: false },
    errors: [],
  };
  const o = { listingId: 1n, heldAt: HELD_AT, state: 'open' };
  assert.equal(new Date(Number(HELD_AT) * 1000).toISOString().replace('.000Z', 'Z'), ISO);
  allPass(holdPageChecks('x', pages, o));
  const l = (over) => ({ ...pages, listing: { ...pages.listing, ...over } });
  const r = (over) => ({ ...pages, record: { ...pages.record, ...over } });
  fails(holdPageChecks('x', l({ heldSince: '2027-01-15T08:02:04Z' }), o), 'x.page.listingOnHold');
  fails(holdPageChecks('x', l({ heldSince: null }), o), 'x.page.listingOnHold');
  fails(holdPageChecks('x', l({ held: 'Listing 1 is open until then.' }), o), 'x.page.listingOnHold');
  fails(holdPageChecks('x', l({ holdSection: null }), o), 'x.page.listingOnHold');
  // the state is the chain's, said beside the hold
  fails(holdPageChecks('x', l({ state: 'rolled forward' }), o), 'x.page.listingState');
  fails(holdPageChecks('x', r({ held: null }), o), 'x.page.recordOnHold');
  fails(holdPageChecks('x', r({ labels: 'staked' }), o), 'x.page.recordOnHold');
  fails(holdPageChecks('x', r({ labels: 'staked, on hold\nmore' }), o), 'x.page.recordOnHold');
  fails(holdPageChecks('x', r({ state: 'rolled forward' }), o), 'x.page.recordOnHold');
  fails(holdPageChecks('x', { ...pages, feed: { hasListing: true } }, o), 'x.page.feedWithoutIt');
  fails(holdPageChecks('x', { ...pages, feed: null }, o), 'x.page.feedWithoutIt');
  fails(holdPageChecks('x', { ...pages, errors: ['boom'] }, o), 'x.page.noErrors');
  fails(holdPageChecks('x', null, o), 'x.page.noErrors');
});
