// A passing round proves nothing if its checks cannot fail. Each is handed what a good round observes,
// then that observation with one thing wrong: the abstention passed off as a verdict, the bond in the
// wrong hands, a record that says something else.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { abstainEndChecks, abstainedRoundChecks, evidenceChecks, gateSettledChecks, juryPathChecks, moneyChecks, pageChecks, recordChecks, requestChecks, servedRoundChecks, settlementChecks } from '../src/checks.js';

const failing = (list) => list.filter((c) => !c.ok).map((c) => c.name);
const allPass = (list) => assert.deepEqual(failing(list), []);
const fails = (list, name) => assert.ok(failing(list).includes(name), `${name} should fail: ${JSON.stringify(failing(list))}`);

const jobs = (phase, n) => Array.from({ length: n }, (_, slot) => ({ phase, slot, status: 200 }));
const served = (over = {}) => ({ status: 'fulfilled', jobs: [...jobs('commit', 6), ...jobs('reveal', 4)], commits: 4, reveals: 3, clustered: 2, justifications: 'QmA,QmB', reverted: [], ignored: [], abstained: 0, ...over });

test('servedRoundChecks: K, M, N, P, or it fails', () => {
  allPass(servedRoundChecks('x', served()));
  fails(servedRoundChecks('x', served({ status: 'no-verdict' })), 'x.round.fulfilled');
  fails(servedRoundChecks('x', served({ jobs: jobs('commit', 1) })), 'x.round.polled');
  fails(servedRoundChecks('x', served({ commits: 1 })), 'x.round.commits');
  fails(servedRoundChecks('x', served({ jobs: jobs('commit', 6) })), 'x.round.revealJobs');
  fails(servedRoundChecks('x', served({ reveals: 1 })), 'x.round.reveals');
  fails(servedRoundChecks('x', served({ justifications: 'QmA' })), 'x.round.clustered');
  fails(servedRoundChecks('x', served({ reverted: [{ reason: 'MalformedPayload' }] })), 'x.round.noRevert');
  fails(servedRoundChecks('x', served({ ignored: [{ reason: 'RevealHashMismatch' }] })), 'x.round.noBadReveal');
  allPass(servedRoundChecks('x', served({ ignored: [{ reason: 'commit after the reveal phase began' }] })));
});

test('abstainedRoundChecks: an abstention stays an abstention', () => {
  const round = { status: 'no-verdict', abstained: 6, commits: 0, reveals: 0, likelihoods: null, justifications: null };
  allPass(abstainedRoundChecks('x', round));
  fails(abstainedRoundChecks('x', { ...round, status: 'fulfilled' }), 'x.round.noVerdict');
  fails(abstainedRoundChecks('x', { ...round, commits: 1 }), 'x.round.allAbstained');
  fails(abstainedRoundChecks('x', { ...round, likelihoods: [1n] }), 'x.round.noResult');
});

test('requestChecks: the composition the contract owes', () => {
  const disclosure = { parsed: { archiveSha256: '0xa', ciphertextSha256: '0xb', ciphertextCid: 'QmC' }, archiveSha256: '0xa', ciphertextSha256: '0xb', ciphertextCid: 'QmC' };
  const round = { cids: ['QmL', 'QmB', 'QmP'], requestedClass: 133n, addendum: 'verdikta-disclosure: x' };
  const o = { listingCid: 'QmL', bcid: 'QmB', priorBcids: ['QmP'], requestedClass: 133, disclosure };
  allPass(requestChecks('x', round, o));
  fails(requestChecks('x', { ...round, cids: ['QmL', 'QmB'] }, o), 'x.request.cids');
  fails(requestChecks('x', { ...round, requestedClass: 128n }, o), 'x.request.class');
  fails(requestChecks('x', round, { ...o, disclosure: { ...disclosure, parsed: null } }), 'x.request.disclosureLine');
  fails(requestChecks('x', round, { ...o, disclosure: { ...disclosure, archiveSha256: '0xz' } }), 'x.request.disclosureLine');
});

const panel = [{ model: 'a' }, { model: 'b' }];
const justifier = { model: 'j' };
const providerCalls = () => Array.from({ length: 6 }, () => [{ model: 'a', outcome: 'answered', prompt: 'p' }, { model: 'b', outcome: 'answered', prompt: 'p' }, { model: 'j', outcome: 'answered', prompt: 'p' }]).flat();
const juryObs = (over = {}) => ({
  runnerCalls: [{ response: { outcome: 'definitive', report: {}, reportSha256: 'h', runner: { platform: 'linux/amd64' } } }],
  aiCalls: Array.from({ length: 6 }, () => ({ status: 200, request: { codeReview: {} } })),
  providerCalls: providerCalls(),
  panel,
  justifier,
  disclosureSecret: '0xsecret',
  report: { classPlatform: true, classPlatformName: 'linux/amd64' },
  ...over,
});

test('juryPathChecks: the sandbox ran, the jury was reached, the keys stayed out', () => {
  allPass(juryPathChecks('x', juryObs()));
  fails(juryPathChecks('x', juryObs({ runnerCalls: [] })), 'x.runner.oneSandbox');
  fails(juryPathChecks('x', juryObs({ runnerCalls: [{ response: { outcome: 'abstain', abstain: { cause: 'oom' } } }] })), 'x.runner.definitive');
  fails(juryPathChecks('x', juryObs({ runnerCalls: [{ response: { outcome: 'definitive', report: null, reportUnavailable: 'linux/arm64', runner: { platform: 'linux/amd64' } } }] })), 'x.runner.definitive');
  fails(juryPathChecks('x', juryObs({ runnerCalls: [{ response: { outcome: 'definitive', report: {}, runner: { platform: 'linux/arm64' } } }] })), 'x.runner.reportPlatform');
  allPass(juryPathChecks('x', juryObs({ runnerCalls: [{ response: { outcome: 'definitive', report: {}, runner: { platform: 'linux/arm64' } } }], report: { classPlatform: false } })));
  fails(juryPathChecks('x', juryObs({ aiCalls: [] })), 'x.jury.perJob');
  fails(juryPathChecks('x', juryObs({ providerCalls: [] })), 'x.jury.everyJuror');
  fails(juryPathChecks('x', juryObs({ providerCalls: providerCalls().map((c) => ({ ...c, outcome: 'failed' })) })), 'x.jury.everyJuror');
  fails(juryPathChecks('x', juryObs({ providerCalls: providerCalls().filter((c) => c.model !== 'j') })), 'x.jury.justifier');
  fails(juryPathChecks('x', juryObs({ providerCalls: [...providerCalls().slice(1), { model: 'a', outcome: 'answered', prompt: 'verdikta-disclosure: 0xsecret' }] })), 'x.jury.keysNotSeen');
});

test('gateSettledChecks: a gate settled it, and no model was asked', () => {
  const obs = { runnerCalls: [{ response: { outcome: 'definitive', gates: { testPathsOnly: { status: 'fail' } } } }], aiCalls: [], providerCalls: [], gate: 'testPathsOnly' };
  allPass(gateSettledChecks('x', obs));
  fails(gateSettledChecks('x', { ...obs, aiCalls: [{}] }), 'x.noAi');
  fails(gateSettledChecks('x', { ...obs, providerCalls: [{}] }), 'x.noAi');
  fails(gateSettledChecks('x', { ...obs, runnerCalls: [{ response: { outcome: 'definitive', gates: { testPathsOnly: { status: 'pass' } } } }] }), 'x.runner.gateFailed');
  fails(gateSettledChecks('x', { ...obs, runnerCalls: [{ response: { outcome: 'abstain' } }] }), 'x.runner.gateFailed');
});

test('evidenceChecks: the upload says what the settlement says', () => {
  const uploads = [{ justification: 'Execution evidence v1\nSettlement: jury\n' }];
  const evidence = { settlement: 'jury', reportSha256: 'h' };
  allPass(evidenceChecks('x', { uploads, evidence, settlement: 'jury', reportSha256: 'h' }));
  fails(evidenceChecks('x', { uploads: [], evidence, settlement: 'jury' }), 'x.evidence.uploads');
  fails(evidenceChecks('x', { uploads: [{ justification: 'jury text' }], evidence, settlement: 'jury' }), 'x.evidence.uploads');
  fails(evidenceChecks('x', { uploads, evidence, settlement: 'INVALID (testPathsOnly)' }), 'x.evidence.settlement');
  fails(evidenceChecks('x', { uploads, evidence: null, settlement: 'jury' }), 'x.evidence.settlement');
  fails(evidenceChecks('x', { uploads, evidence, settlement: 'jury', reportSha256: 'other' }), 'x.evidence.reportHash');
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
  allPass(moneyChecks('x', [{ name: 'prepay', before: 100n, after: 40n, gas: 10n, expected: -50n }]));
  fails(moneyChecks('x', [{ name: 'prepay', before: 100n, after: 40n, gas: 0n, expected: -50n }]), 'x.money.prepay');
});

test('abstainEndChecks: no verdict, ever, and it ended by E6', () => {
  const obs = { state: 'Expired', expiry: 'RoundsFailed', judgedEvents: 0, settledEvents: 0, record: { history: { noVerdict: '1' } }, pinsBefore: 5, pinsAfter: 5 };
  allPass(abstainEndChecks('x', obs));
  fails(abstainEndChecks('x', { ...obs, judgedEvents: 1 }), 'x.never.judged');
  fails(abstainEndChecks('x', { ...obs, settledEvents: 1 }), 'x.never.settled');
  fails(abstainEndChecks('x', { ...obs, state: 'Settled' }), 'x.ended.expired');
  fails(abstainEndChecks('x', { ...obs, expiry: 'SubmissionsRefused' }), 'x.ended.expired');
  fails(abstainEndChecks('x', { ...obs, record: { history: { noVerdict: '0' } } }), 'x.record.noVerdict');
  fails(abstainEndChecks('x', { ...obs, pinsAfter: 6 }), 'x.nothingUploaded');
});

const finding = { claimId: '1', outcome: 'HIGH', paidWei: '4', owedWei: '0', bcid: 'QmB' };
const view = (over = {}) => ({
  artifactHash: '0xh',
  fresh: true,
  notCounted: { listings: [] },
  badge: { message: '1 valid finding at or above MEDIUM · staker named by the repository: yes' },
  record: { history: { outcomes: ['1', '0', '0', '0', '1', '0'], claims: '3', pending: '0', released: '3', noVerdict: '1' }, findings: [finding], listings: [{ listingId: '1', escrowWei: '6' }] },
  ...over,
});
const expected = { artifactHash: '0xh', listingId: 1n, outcomes: [1, 0, 0, 0, 1, 0], claims: 3, released: 3, noVerdict: 1, findings: [finding], escrowWei: 6n };

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
  fails(recordChecks('x', view({ record: { ...view().record, listings: [{ listingId: '1', escrowWei: '7' }] } }), expected), 'x.record.escrow');
  fails(recordChecks('x', view({ badge: { message: 'staker named by the repository: no' } }), expected), 'x.record.stakerNamed');
});

test('pageChecks: what the browser read', () => {
  const pages = { record: { hash: '0xh', claims: '3', pending: '0', verdicts: 'INVALID: 1 HIGH: 1', noVerdict: '1', findings: 'HIGH QmB', main: 'the page' }, feed: 'listing', errors: [] };
  const o = { artifactHash: '0xH', claims: 3, verdicts: ['INVALID: 1', 'HIGH: 1'], noVerdict: 1, findingBcid: 'QmB', invalidBcid: 'QmI' };
  allPass(pageChecks('x', pages, o));
  const r = (over) => ({ ...pages, record: { ...pages.record, ...over } });
  fails(pageChecks('x', r({ hash: '0xother' }), o), 'x.page.hash');
  fails(pageChecks('x', r({ claims: '2' }), o), 'x.page.claims');
  fails(pageChecks('x', r({ verdicts: 'HIGH: 1' }), o), 'x.page.verdicts');
  fails(pageChecks('x', r({ noVerdict: '0' }), o), 'x.page.noVerdict');
  fails(pageChecks('x', r({ findings: 'none' }), o), 'x.page.finding');
  fails(pageChecks('x', r({ main: 'it names QmI' }), o), 'x.page.invalidNotPublished');
  fails(pageChecks('x', { ...pages, errors: ['boom'] }, o), 'x.page.noErrors');
  fails(pageChecks('x', { ...pages, feed: '' }, o), 'x.page.feed');
});
