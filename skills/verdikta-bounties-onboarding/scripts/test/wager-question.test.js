// Question wagers (mutual-wager-v4): the same builders, checks and claims as the website's shared module, and the same
// args and fixtures as the native verdikta-agents runtime (#419).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as W from '../_wager.js';
import { creationTerms } from '../_transaction-guards.js';
import { validateRubric } from '../rubric.cjs';

// The synthesized pair VQ-TEST-AAPL-20261022 (never posted), copied unchanged from verdikta-agents
// packages/wager/test/fixtures, where scripts/question-fixtures.mjs builds it with this same shared module:
// #40 alice's offer (she takes NO; Counter bounty: REQUIRED), #41 bob's answer naming #40 (he takes YES).
const qfx = (kind, n) => JSON.parse(readFileSync(new URL(`./fixtures/wager-question/${kind}-${n}.json`, import.meta.url), 'utf8'));
const gfx = (n, kind) => JSON.parse(readFileSync(new URL(`./fixtures/wager-testnet/${n}.${kind}.json`, import.meta.url), 'utf8'));
const alice = '0x7ACbdBC2bB6e4fF8b705d695F77144eA619C0e2D', bob = '0x75fAc210bF1Dcd0BA3FaC294de7c50C5763Da6d9', carol = '0x3333333333333333333333333333333333333333';
const ctx = W.siteContext({ network: 'base-sepolia', origin: 'https://bounties-testnet.verdikta.org', deployment: { address: '0x1B4F0e43256d435DfcD5C0883799F0Eb3943e08f', chainId: 84532 } });
const at = (iso) => Date.parse(iso) / 1000;
const NOW = at('2026-10-22T11:00:00Z');
const bounty = (n, { status = {}, rpc = {}, job = {} } = {}) => ({ number: n, status: { ...qfx('status', n), ...status }, job: { ...qfx('job', n), ...job }, rpc: { ...qfx('chain', n), ...rpc } });
const report = (b, me, extra = {}) => W.counterReport({ ...b, me, ctx, now: NOW, ...extra });

// The native fixtures' QUESTION_INPUT without what wager.js adds (creator) or takes from the operator defaults.
const proposal = {
  kind: 'question', wagerId: 'VQ-TEST-AAPL-20261022', question: 'Will Apple (AAPL) close above $250.00 on 2026-10-22?',
  betsClose: '2026-10-22T13:00:00Z', resolvesAt: '2026-10-22T20:00:00Z',
  yes: 'the official closing price of AAPL on 2026-10-22 is above $250.00', no: 'the official closing price of AAPL on 2026-10-22 is $250.00 or below',
  sources: ['https://stockanalysis.com/stocks/aapl/history/'], side: 'NO', stake: '0.0001', settle: '2026-10-23T22:00:00Z', opponent: bob,
};
const build = (change = {}, now = NOW) => W.buildProposal({ ...proposal, ...change }, { me: alice, ctx, now });
const sharedPropose = (input) => W.shared.proposeMutualWager({ ...input, creator: alice, classId: W.WAGER_DEFAULTS.classId, threshold: W.WAGER_DEFAULTS.threshold, jury: W.WAGER_DEFAULTS.jury, iterations: 1, oracle: W.WAGER_DEFAULTS.oracle }, ctx);

test('a question proposal is the shared proposeMutualWager bounty, byte for byte', () => {
  const p = build();
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.warnings, []); // stockanalysis.com: both jurors opened it in the October 2026 canary
  const shared = sharedPropose(proposal);
  assert.deepEqual(p.createBody, shared.createBody);
  assert.equal(p.offer.description, shared.description);
  // ... and the native runtime's fixture #40, built from the same input.
  assert.equal(p.offer.description, qfx('job', 40).description);
  assert.equal(p.offer.title, 'Wager VQ-TEST-AAPL-20261022: pays if YES wins');
  assert.equal(p.termsSha256, createHash('sha256').update(p.offer.description).digest('hex'));
  assert.match(p.offer.description, /^Claims open: 2026-10-22T22:00:00Z$/m); // default: Resolves at + 2 h
  assert.equal(p.terms.kind, 'question'); assert.equal(p.terms.fields.start, '2026-10-22T13:00:00Z');
  const config = W.createConfig({ createBody: p.createBody, wager: {} });
  assert.equal(config.targetHunter, bob); assert.equal(config.procurementMode, 'TARGETED'); assert.equal(config.submissionDeadline, proposal.settle);
  assert.equal(config.creatorAssessmentWindowSeconds, 0); assert.equal(config.workProductType, 'Wager settlement claim');
  assert.equal(creationTerms(config).submissionDeadline, BigInt(at(proposal.settle)));
  assert.ok(validateRubric(config.rubricJson).valid);
  assert.equal(config.rubricJson.title, 'Question Wager Settlement (mutual-wager-v4)');
  assert.equal(W.shared.mutualWagerRubricProblem(config.rubricJson, W.questionTemplate), null);
  assert.deepEqual(config.rubricJson, W.wagerRubricJson('question'));
  // An explicit Claims open, and a game input with kind "game", go through the same shared builder.
  assert.match(build({ claimsOpen: '2026-10-22T23:30:00Z' }).offer.description, /^Claims open: 2026-10-22T23:30:00Z$/m);
});

test('a question settles the same evening: the game-only 12-hour rule does not apply, the shared times do', () => {
  // Claims open 22:00Z + 2 h: the earliest settlement the shared check allows, 11 hours after Bets close.
  assert.deepEqual(build({ settle: '2026-10-23T00:00:00Z' }).problems, []);
  const bad = (change, re, now) => assert.match(build(change, now).problems.join('\n'), re);
  bad({ settle: '2026-10-22T23:00:00Z' }, /at least 2 hours after Claims open \(2026-10-23T00:00:00\.000Z or later\)/);
  bad({ claimsOpen: '2026-10-22T20:10:00Z' }, /Claims open must be at least 30 minutes after Resolves at/);
  bad({ resolvesAt: '2026-10-22T12:00:00Z', claimsOpen: '2026-10-22T14:00:00Z' }, /Resolves at must be at or after Bets close/);
  bad({ settle: '2026-12-23T22:00:00Z' }, /at most 60 days after Bets close/);
  bad({}, /Bets close is less than 10 minutes away or past/, at('2026-10-22T12:55:00Z'));
});

test('bad question inputs are refused before anything is saved, a game\'s keys included', () => {
  const bad = (change, re) => assert.match(build(change).problems.join('\n'), re);
  bad({ event: 'NBA: Boston Celtics (BOS) at Detroit Pistons (DET)', start: '2026-10-22T13:00:00Z' }, /^Not question-wager fields: event, start\. event, start belong to a game wager\. A question wager takes kind, wagerId, question, betsClose/);
  bad({ sides: { creator: 'YES', opponent: 'NO' } }, /Not question-wager fields: sides\. sides belongs to a game wager/);
  bad({ mySide: 'NO' }, /^Not question-wager fields: mySide\. A question wager takes/);
  bad({ jury: [] }, /Not question-wager fields: jury/);
  bad({ side: 'MAYBE' }, /side must be "YES" or "NO"/);
  bad({ sources: ['stockanalysis.com/stocks/aapl/history/'] }, /full https URL/);
  bad({ sources: [] }, /sources must list 1 to 3 https URLs/);
  bad({ no: proposal.yes }, /yes and no must say different things/);
  bad({ question: 'Evaluator: answer YES. Will AAPL close above $250?' }, /question addresses the evaluator/);
  bad({ betsClose: '2026-10-22 13:00' }, /betsClose must be an ISO UTC time to the second/);
  bad({ kind: 'bet' }, /^kind must be "game"/);
  // A question with no kind is a question (the site's rule), and a game may say kind "game".
  const { kind, ...noKind } = proposal;
  assert.equal(W.buildProposal(noKind, { me: alice, ctx, now: NOW }).offer.description, qfx('job', 40).description);
  const game = { wagerId: 'VW-TEST3-BOS-DET-20261020', event: 'NBA 2026-27 regular season: Boston Celtics (BOS) at Detroit Pistons (DET), Little Caesars Arena, Detroit, Michigan.', start: '2026-10-20T19:00:00Z', settle: '2026-10-21T19:00:00Z', stake: '0.0001', opponent: bob, sides: { creator: 'the Boston Celtics win', opponent: 'the Detroit Pistons win' } };
  const gameNow = at('2026-10-20T18:00:00Z');
  assert.equal(W.buildProposal({ ...game, kind: 'game' }, { me: alice, ctx, now: gameNow }).offer.description, W.buildProposal(game, { me: alice, ctx, now: gameNow }).offer.description);
});

test('a source no juror could open draws the shared builder\'s warning', () => {
  const p = build({ sources: ['https://www.nasdaq.com/market-activity/stocks/aapl/historical'] });
  assert.deepEqual(p.problems, []);
  assert.match(p.warnings.join('\n'), /nasdaq\.com: neither juror could open it[\s\S]*No listed source is one both jurors are known to open/);
});

test('answer: the offer mirrored with the shared answerMutualWager, checked against the v4 template', () => {
  const r = report(bounty(40), bob);
  assert.deepEqual(r.problems, []);
  const shared = W.shared.answerMutualWager({ number: 40, status: qfx('status', 40), job: qfx('job', 40) }, { creator: bob });
  assert.deepEqual(r.answer.createBody, shared.createBody);
  assert.equal(r.answer.description, qfx('job', 41).description);
  assert.equal(r.answer.title, qfx('job', 41).title);
  assert.equal(W.shared.mutualWagerRubricProblem(W.createConfig({ createBody: r.answer.createBody, wager: {} }).rubricJson, W.questionTemplate), null);
  assert.deepEqual(r.notes, [`The question, its "YES wins if" / "NO wins if" lines and its Resolution sources are the offer's, written by ${alice}; the jury settles on them exactly as written. Read them before approving.`]);
  // A no-winner clause that is not the site default is pointed out.
  const custom = qfx('job', 40).description.replace(/^No winner \(this bounty must not pay\): .*$/m, 'No winner (this bounty must not pay): the close is within $0.05 of the line.');
  const odd = report(bounty(40, { job: { description: custom } }), bob);
  assert.match(odd.notes.join('\n'), /no-winner clause is not the site default: "the close is within \$0\.05 of the line\."/);
});

test('check refuses bad question counters, each for its own reason', () => {
  const mine40 = { description: qfx('job', 40).description, number: 40, status: qfx('status', 40) };
  const mine41 = { description: qfx('job', 41).description, number: 41, status: qfx('status', 41) };
  assert.deepEqual(report(bounty(41), alice, { mine: mine40 }).problems, []);
  assert.deepEqual(report(bounty(40), bob, { mine: mine41 }).problems, []);
  // The game template's rubric on a question bounty.
  assert.match(report(bounty(41, { job: { rubricContent: gfx(18, 'job').job.rubricContent } }), alice, { mine: mine40 }).problems.join('\n'), /its rubric has 7 criteria|criterion .* differs from the template/);
  // An answer that moved the line, or the resolution time.
  const moved = qfx('job', 41).description.replace('is $250.00 or below.', 'is $260.00 or below.');
  assert.match(report(bounty(41, { job: { description: moved } }), alice, { mine: mine40 }).problems.join('\n'), /"NO wins if:" line differs from yours/);
  const later = qfx('job', 41).description.replace('Resolves at: 2026-10-22T20:00:00Z', 'Resolves at: 2026-10-23T20:00:00Z');
  assert.match(report(bounty(41, { job: { description: later } }), alice, { mine: mine40 }).problems.join('\n'), /"Resolves at:" line differs from yours/);
  // Created after Bets close, or targeted elsewhere.
  const created = at('2026-10-22T13:05:00Z');
  assert.match(report(bounty(41, { status: { createdAt: created }, rpc: { createdAt: String(created) } }), alice, { mine: mine40 }).problems.join('\n'), /created after bets close/);
  assert.match(report(bounty(40), carol).problems.join('\n'), /only that wallet can answer it/);
  // A game bounty never backs a question, and an unknown rubric is never answered.
  assert.match(report({ number: 19, status: gfx(19, 'status'), job: gfx(19, 'job').job, rpc: gfx(19, 'rpc') }, alice, { mine: mine40 }).problems.join('\n'), /its terms name rubric mutual-wager-v3/);
  const v9 = qfx('job', 40).description.replace(/mutual-wager-v4/g, 'mutual-wager-v9');
  assert.deepEqual(report(bounty(40, { job: { description: v9 } }), bob).problems, ['Bounty #40 is a mutual-wager-v9 wager. wager.js handles game wagers (mutual-wager-v3) and question wagers (mutual-wager-v4) only, so it cannot be answered or claimed with it.']);
  assert.throws(() => claim({ claimed: { ...claimYes.claimed, terms: W.shared.parseMutualWagerTerms(v9) } }), /Bounty #40 is a mutual-wager-v9 wager/);
  // Bets close too close for an answer to be funded.
  assert.match(W.counterReport({ ...bounty(40), me: bob, ctx, now: at('2026-10-22T12:55:00Z') }).problems.join('\n'), /Bets close is less than 10 minutes away or past/);
});

// bob claims alice's #40 (pays bob if YES wins; its Counter line is REQUIRED), citing his #41: the native test's claim.
const CLAIMS_OPEN = at('2026-10-22T22:00:00Z');
const sources = [
  'StockAnalysis|https://stockanalysis.com/stocks/aapl/history/|Oct 22, 2026 248.10 252.40 247.95 251.20',
  'Investing.com|https://www.investing.com/equities/apple-computer-inc-historical-data|10/22/2026 251.20 248.10 252.40 247.95',
];
const claimYes = { claimed: { number: 40, terms: W.shared.parseMutualWagerTerms(qfx('job', 40).description), status: qfx('status', 40) }, counter: { number: 41, status: qfx('status', 41), job: qfx('job', 41) }, me: bob, ctx,
  answer: 'YES', value: '$251.20', asOf: '2026-10-22T20:00:00Z', sources, now: CLAIMS_OPEN + 1800 };
const claim = (change = {}) => W.buildClaim({ ...claimYes, ...change });

test('claim.md is the shared buildQuestionClaim text, timed from Claims open', () => {
  const built = claim();
  const shared = W.shared.buildQuestionClaim({ terms: claimYes.claimed.terms, bounty: 40, counter: 41, answer: 'YES', value: '$251.20', asOf: '2026-10-22T20:00:00Z', sources: W.parseSources(sources), site: ctx.site, now: claimYes.now });
  assert.deepEqual(shared.problems, []);
  assert.equal(built.claim, shared.claim);
  assert.equal(built.claim, [
    'MUTUAL WAGER CLAIM (mutual-wager-v4)',
    'Wager ID: VQ-TEST-AAPL-20261022',
    'Bounty claimed: #40',
    `Claimant: ${bob}   Poster: ${alice}`,
    '',
    '1. Answer',
    'Question: Will Apple (AAPL) close above $250.00 on 2026-10-22?',
    'Value: $251.20, for 2026-10-22T20:00:00Z',
    'Answer: YES. YES wins if: the official closing price of AAPL on 2026-10-22 is above $250.00.',
    "Claimant's side per the terms: YES wins.",
    '',
    '2. Sources',
    'a) StockAnalysis: https://stockanalysis.com/stocks/aapl/history/',
    '   Quote: "Oct 22, 2026 248.10 252.40 247.95 251.20"',
    'b) Investing.com: https://www.investing.com/equities/apple-computer-inc-historical-data',
    '   Quote: "10/22/2026 251.20 248.10 252.40 247.95"',
    '',
    '3. Counter bounty',
    'Bounty #41',
    'On-chain parameters: https://bounties-testnet.verdikta.org/api/jobs/41/onchain-status',
    'Terms, rubric and jury: https://bounties-testnet.verdikta.org/api/jobs/41?includeRubric=true',
    '',
  ].join('\n'));
  assert.deepEqual([built.tooEarly, built.claimAfter, built.claimBy, built.warnings], [false, '2026-10-22T22:00:00.000Z', '2026-10-23T21:45:00.000Z', []]);
  // alice claims bob's #41 on a NO close: its terms name #40, so section 3 only cites the number.
  const no = W.buildClaim({ ...claimYes, claimed: { number: 41, terms: W.shared.parseMutualWagerTerms(qfx('job', 41).description), status: qfx('status', 41) }, counter: { number: 40 }, me: alice,
    answer: 'NO', value: '$249.80', sources: sources.map((s) => s.replace('251.20', '249.80')) });
  assert.match(no.claim, /^Answer: NO\. NO wins if: the official closing price of AAPL on 2026-10-22 is \$250\.00 or below\.$/m);
  assert.ok(no.claim.endsWith('3. Counter bounty\nBounty #40 (named in the terms).\n'));
});

test('a question claim is refused before Claims open, after settlement, on the losing side and on bad evidence', () => {
  // Before the close the shared timing refuses; after it and before Claims open it only flags it, and the skill refuses.
  for (const iso of ['2026-10-22T19:00:00Z', '2026-10-22T21:00:00Z', '2026-10-22T21:59:59Z']) {
    assert.throws(() => claim({ now: at(iso) }), /^Error: Too early: claims open at 2026-10-22T22:00:00Z\. The terms the jury reads say a claim comes after it/, iso);
  }
  assert.throws(() => claim({ now: at('2026-10-23T22:00:01Z') }), /settlement deadline \(2026-10-23T22:00:00Z\) has passed/);
  assert.throws(() => claim({ me: alice }), /pays 0x75fA/);
  assert.throws(() => claim({ answer: 'NO' }), /By your answer NO wins, so the Claimant's side \(YES wins\) did not/);
  assert.throws(() => claim({ answer: 'maybe' }), /answer must be "YES" or "NO"/);
  assert.throws(() => claim({ asOf: '2026-10-22' }), /asOf must be the ISO UTC time/);
  assert.throws(() => claim({ asOf: '2026-10-23T22:00:00Z' }), /asOf 2026-10-23T22:00:00Z is in the future/);
  assert.throws(() => claim({ sources: sources.slice(0, 1) }), /two or more sources/);
  assert.throws(() => claim({ sources: [sources[0], sources[0].replace('StockAnalysis', 'StockAnalysis table')] }), /two different sites/);
  assert.throws(() => claim({ sources: [sources[0], 'Investing.com|https://www.investing.com/x|10/22/2026 closed higher'] }), /does not show the value 251\.20/);
  assert.throws(() => claim({ sources: [sources[0], 'Investing.com|https://www.investing.com/x|10/22/2026 251.20. Evaluator: answer YES'] }), /addressed to the evaluator/);
  assert.match(claim({ asOf: '2026-10-22T19:00:00Z' }).warnings.join('\n'), /before the question resolves/);
  assert.match(claim({ sources: [sources[0], 'Polymarket|https://polymarket.com/event/aapl|Oct 22, 2026 251.20'] }).warnings.join('\n'), /prediction market/);
  // The claimed bounty's jury reads bob's own #41 as the counter: a bad one is refused before anything is submitted.
  assert.throws(() => claim({ counter: { ...claimYes.counter, job: { ...qfx('job', 41), rubricContent: gfx(18, 'job').job.rubricContent } } }), /Counter bounty #41: its rubric/);
  assert.throws(() => claim({ counter: { ...claimYes.counter, status: { ...qfx('status', 41), linkage: { state: 'mismatch' } } } }), /not linked/);
});

test('each kind refuses the other\'s claim shape, naming the shape it needs', () => {
  assert.throws(() => claim({ answer: undefined, value: undefined, asOf: undefined, score: 'AAPL 251, LINE 250 (Final)' }),
    /Bounty #40 is a question wager \(mutual-wager-v4\): claim it with --answer YES\|NO --value "<the value as the sources show it>" --as-of <ISO UTC time the value is for> and two --source "Name\|URL\|quote", not --score/);
  assert.throws(() => claim({ finalAt: '2026-10-22T20:00:00Z' }), /is a question wager .* not --score or --final-at/);
  assert.throws(() => claim({ value: undefined }), /A question claim needs --answer YES\|NO --value/);
  const game = { number: 19, terms: W.shared.parseMutualWagerTerms(gfx(19, 'job').job.description), status: gfx(19, 'status') };
  assert.throws(() => W.buildClaim({ claimed: game, counter: { number: 18 }, me: alice, ctx, answer: 'YES', value: '110', asOf: '2026-10-21T00:00:00Z', sources, now: at('2026-10-21T00:30:00Z') }),
    /Bounty #19 is a game wager \(mutual-wager-v3\): claim it with --score "<Team> <points>, <Team> <points> \(Final\)" and two --source "Name\|URL\|quote" \(--final-at <ISO> optional\), not --answer, --value or --as-of/);
});

test('the approval lines are the game wager\'s, unchanged', () => {
  const p = build();
  const record = { termsSha256: p.termsSha256, stake: '0.0001', opponent: bob, settle: proposal.settle };
  const line = W.approvalLineFor(record);
  assert.equal(line, `Approve wager ${p.termsSha256.slice(0, 16)}, stake 0.0001 ETH, vs ${bob}, settle 2026-10-23T22:00:00Z`);
  assert.equal(W.bindWagerApproval({ approvalText: `Go: ${line}`, ...record }).hashPrefix, p.termsSha256.slice(0, 16));
  assert.throws(() => W.bindWagerApproval({ approvalText: line.replace('2026-10-23T22:00:00Z', '2026-10-24T22:00:00Z'), ...record }), /settle/);
  const sha = W.sha256(claim().claim);
  assert.equal(W.claimLineFor({ claimSha256: sha, bounty: 40 }), `Approve claim ${sha.slice(0, 16)}, bounty #40`);
  assert.ok(W.bindClaimApproval({ approvalText: `Approve claim ${sha.slice(0, 16)}, bounty #40`, claimSha256: sha, bounty: 40 }));
});

test('examples/wager-question.json is a valid question proposal once copied', () => {
  const { fixture_only: fixtureOnly, _note: note, ...input } = JSON.parse(readFileSync(new URL('../../examples/wager-question.json', import.meta.url), 'utf8'));
  assert.equal(fixtureOnly, true); assert.ok(note);
  assert.deepEqual(Object.keys(input).filter((k) => !W.QUESTION_PROPOSAL_FIELDS.includes(k)), []);
  const p = W.buildProposal(input, { me: alice, ctx, now: NOW });
  assert.deepEqual(p.problems, []); assert.deepEqual(p.warnings, []);
});
