// A passing round proves nothing if its checks cannot fail. Each is handed what a good round observes,
// then that observation with one thing wrong: the abstention passed off as a verdict, the bond in the
// wrong hands, a record that says something else.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { abstainEndChecks, abstainRunChecks, abstainedRoundChecks, cleanupVerdict, evidenceChecks, gateSettledChecks, juryPathChecks, moneyChecks, pageChecks, recordChecks, requestChecks, servedRoundChecks, settlementChecks } from '../src/checks.js';

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
