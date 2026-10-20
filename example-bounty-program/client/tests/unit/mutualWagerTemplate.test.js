import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getTemplate, getTemplateOptions } from '../../src/data/rubricTemplates.js';
import {
  buildMutualWagerBounty, mutualWagerTermsSkeleton, hasMutualWagerTerms, parseMutualWagerTerms,
  checkMutualWagerTerms, checkCounterBounty, findWagerTwin, mirrorMutualWagerTerms, MUTUAL_WAGER_CRITERIA, MUTUAL_WAGER_RUBRIC,
} from '../../src/utils/mutualWagerTerms.js';
const require = createRequire(import.meta.url);
const { validateRubric } = require('../../../server/utils/validation.js');
const { measureEvaluationQuery } = require('../../../server/utils/archiveGenerator.js');
const { maxEvaluationQueryChars } = require('../../../server/utils/bountyValidator.js');

// The Commanders @ 49ers wager that settled on mainnet (bounties #301/#303), as a v3 pair.
const jury = [{ provider: 'OpenAI', model: 'gpt-5.6-terra', weight: 0.5, runs: 1 }, { provider: 'Anthropic', model: 'claude-sonnet-5', weight: 0.5, runs: 1 }];
const oracle = { maxOracleFeeEth: '0.00002', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: '3', alpha: '500' };
const site = 'https://bounties.verdikta.org', escrow = '0xA741eFf41Bcf14793E61CEbB4179E05C9124D3f6', chain = 'Base (chain ID 8453)';
const terms = {
  wagerId: 'VW-WSH-SF-20261019', shortEvent: 'Commanders @ 49ers',
  event: "NFL 2026 regular season, Week 6: Washington Commanders (WAS) at San Francisco 49ers (SF), Levi's Stadium, Santa Clara, California.",
  start: '2026-10-20T00:15:00Z', market: 'straight-up winner on the official final score, overtime included. No point spread.',
  stake: '0.0005', settle: '2026-10-22T00:00:00Z', classId: 128, threshold: 80, jury, iterations: 1, oracle, site, escrow, chain,
};
const sf = { wallet: '0xA3b423861e6D6501a05e87d1f500fFff2402f7B1', label: 'the San Francisco 49ers win', short: 'the 49ers' };
const wsh = { wallet: '0xF6DD9256D0091c6E773EBfDFC79783f9663e65Fc', label: 'the Washington Commanders win', short: 'the Commanders' };
const NOW = Date.parse('2026-10-19T22:00:00Z') / 1000;
const created = { unix: Date.parse('2026-10-19T21:30:00Z') / 1000, iso: '2026-10-19T21:30:00.000Z' };
const deadline = { unix: Date.parse('2026-10-22T02:00:00Z') / 1000, iso: '2026-10-22T02:00:00.000Z' };

// What the create page uploads: the template's instructions become each criterion's description.
const template = getTemplate('mutualWager');
const uploaded = { ...template, criteria: template.criteria.map(({ instructions, ...c }) => ({ ...c, description: instructions })) };
const query = (description) => measureEvaluationQuery({
  workProductType: 'Wager settlement claim', jobTitle: 'Wager VW-WSH-SF-20261019: Commanders @ 49ers, pays if the 49ers win',
  jobDescription: description, rubricCriteria: uploaded.criteria, forbiddenContent: uploaded.forbiddenContent,
}).composedLength;

// The first bounty (mangosteen, REQUIRED) and the second (NigelVBot, naming #301).
const first = buildMutualWagerBounty(terms, wsh, sf, null).description;
const second = buildMutualWagerBounty(terms, sf, wsh, { number: 301, createdAt: created.iso, deadline: deadline.iso }).description;
// The form state the create page checks the second bounty's terms against.
const expectFor = (over = {}) => ({
  posterWallet: sf.wallet, targetHunter: wsh.wallet, stake: '0.0005', threshold: 80, classId: 128, jury, iterations: 1, oracle,
  approvalWindow: false, now: NOW, deadline: NOW + 52 * 3600, site, escrow, chain,
  criteria: template.criteria, forbiddenContent: template.forbiddenContent, template, ...over,
});
// The counter's live records, as GET /onchain-status and GET /api/jobs/301?includeRubric=true return them.
const counterStatus = (over = {}) => ({
  bountyId: 301, status: 'OPEN', deadlinePassed: false, creator: wsh.wallet, targetHunter: sf.wallet,
  bountyAmountWei: '500000000000000', arbiterDeterminationPaymentEth: '0.0005', creatorAssessmentWindowSize: 0,
  classId: 128, threshold: 80, createdAt: created.unix, createdAtIso: created.iso,
  submissionDeadline: deadline.unix, submissionDeadlineIso: deadline.iso, evaluationCid: 'QmCounterPackage',
  oracleSettings: { maxOracleFee: '20000000000000', maxOracleFeeEth: '0.00002', alpha: 500, estimatedBaseCost: '10000000000000', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: 3 },
  linkage: { state: 'linked' }, ...over,
});
const counterJob = (over = {}) => ({
  evaluationCid: 'QmCounterPackage', description: first, iterations: 1,
  juryNodes: jury.map((n) => ({ ...n, provider: n.provider.toLowerCase() })),
  rubricContent: { criteria: uploaded.criteria, forbiddenContent: uploaded.forbiddenContent }, ...over,
});
const checkCounter = ({ status = {}, job = {}, description = second } = {}) => {
  const t = checkMutualWagerTerms(description, expectFor());
  assert.deepEqual(t.problems, []);
  return checkCounterBounty({ terms: t.terms, status: counterStatus(status), job: counterJob(job), expect: expectFor() });
};
const hasProblem = (problems, re) => assert.ok(problems.some((p) => re.test(p)), `expected ${re} in ${JSON.stringify(problems)}`);

test('the Mutual Wager template is offered and passes the server rubric check', () => {
  assert.ok(getTemplateOptions().some((o) => o.value === 'mutualWager' && o.label.includes('Mutual Wager')));
  assert.deepEqual(validateRubric(uploaded), { valid: true, errors: [] });
  assert.equal(template.threshold, 80);
  assert.equal(template.classId, 128);
  assert.ok(template.title.includes(MUTUAL_WAGER_RUBRIC));
  assert.deepEqual(template.criteria.map((c) => c.id), MUTUAL_WAGER_CRITERIA);
  assert.ok(template.criteria.every((c) => c.must === true && c.weight === 0));
  const text = Object.fromEntries(template.criteria.map((c) => [c.id, c.instructions]));
  assert.match(text.integrity, /not started or in progress is a stale copy, not a contradiction/);
  // No claimant-only path: a juror that cannot browse fails instead of trusting copied evidence.
  assert.match(text.result_sources, /retrieved no page confirming the score \(for example, it has no web access\)/);
  assert.doesNotMatch(text.result_sources + text.counter_bounty_onchain, /without web access|no web access judges/);
  assert.match(text.counter_bounty_onchain, /copied values are never evidence/);
  assert.match(text.counter_bounty_onchain, /every oracleSettings value equals the oracle settings in the terms; linkage.state = linked/);
  assert.match(text.counter_bounty_terms, /job.evaluationCid equals the evaluationCid on the onchain-status page/);
  assert.match(text.counter_bounty_terms, /every line equals this bounty's/);
  assert.match(text.counter_bounty_terms, /compare the text, not just the ids: one changed word is a FAIL\); forbiddenContent is the same/);
  assert.match(text.counter_bounty_terms, /provider, model, weight, runs/);
});

test('the two bounties of a wager carry mirrored terms', () => {
  const a = parseMutualWagerTerms(first), b = parseMutualWagerTerms(second);
  assert.equal(a.rubric, MUTUAL_WAGER_RUBRIC);
  for (const key of Object.keys(a.fields)) {
    if (!['poster', 'claimant', 'pays', 'counter'].includes(key)) assert.equal(a.fields[key], b.fields[key], key);
  }
  assert.deepEqual(a.poster, b.claimant);
  assert.deepEqual(a.claimant, b.poster);
  assert.equal(b.pays, wsh.label);
  assert.equal(a.pays, sf.label);
  assert.equal(a.counter, null);
  assert.deepEqual(b.counter, { number: 301, createdAt: created.iso, deadline: deadline.iso });
  assert.match(b.fields.jury, /^OpenAI gpt-5.6-terra weight 0.5, 1 run \+ Anthropic claude-sonnet-5 weight 0.5, 1 run; 1 iteration\.$/);
  assert.equal(b.fields.oracle, 'maxOracleFeeEth 0.00002, estimatedBaseCostEth 0.00001, maxFeeBasedScaling 3, alpha 500.');
  assert.equal(b.fields.noWinner, 'a tie, or no official final score before the settlement deadline.');
});

test('the composed jury query stays under the 9,000-character budget the template was tested at', () => {
  // The site cap (maxEvaluationQueryChars) is far higher; the wager prompts proven on mainnet were about 8,000.
  const skeleton = mutualWagerTermsSkeleton({ posterWallet: sf.wallet, claimantWallet: wsh.wallet, stake: '0.0005', threshold: 80, classId: 128, jury, oracle, site, escrow, chain });
  for (const description of [first, second, skeleton]) {
    const n = query(description);
    assert.ok(n < 9000, `query ${n} chars`);
    assert.ok(n <= maxEvaluationQueryChars());
  }
});

test('the create-page skeleton fills what the form knows and marks the rest', () => {
  const d = mutualWagerTermsSkeleton({ posterWallet: sf.wallet, claimantWallet: '', stake: '0.0005', threshold: 80, classId: 128, jury, oracle, site, escrow, chain });
  assert.ok(hasMutualWagerTerms(d));
  assert.ok(d.includes(`Poster (creator): ${sf.wallet}; side: <`));
  assert.ok(d.includes("Claimant (target, the only wallet that can claim): <Claimant's wallet (the Target Hunter)>"));
  assert.ok(d.includes('Stake: 0.0005 ETH per side.'));
  assert.ok(d.includes('Jury (both bounties): OpenAI gpt-5.6-terra weight 0.5, 1 run'));
  assert.ok(d.includes('Counter bounty: REQUIRED'));
  assert.ok(d.includes('https://bounties.verdikta.org/api/jobs/N/onchain-status'));
  assert.equal(hasMutualWagerTerms('Write a blog post'), false);
});

test('complete terms that match the form pass the pre-funding check', () => {
  assert.deepEqual(checkMutualWagerTerms(second, expectFor()).problems, []);
  assert.deepEqual(checkMutualWagerTerms(first, expectFor({ posterWallet: wsh.wallet, targetHunter: sf.wallet })).problems, []);
});

test('a wager without a real target is refused before funding (review P1)', () => {
  // Complete terms naming the Claimant, but the Target Address left empty: an open bounty anyone could claim.
  hasProblem(checkMutualWagerTerms(second, expectFor({ targetHunter: '' })).problems, /Set Target Hunter/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ targetHunter: '0x0000000000000000000000000000000000000000' })).problems, /Set Target Hunter/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ targetHunter: '0x2222222222222222222222222222222222222222' })).problems, /is not the Target Hunter/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ targetHunter: sf.wallet })).problems, /your own wallet/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ posterWallet: '0x3333333333333333333333333333333333333333' })).problems, /not your connected wallet/);
});

test('incomplete or stale terms are refused before funding (review P2)', () => {
  const skeleton = mutualWagerTermsSkeleton({ posterWallet: sf.wallet, claimantWallet: wsh.wallet, stake: '0.0005', threshold: 80, classId: 128, jury, oracle, site, escrow, chain });
  hasProblem(checkMutualWagerTerms(skeleton, expectFor()).problems, /Replace every <\.\.\.> placeholder/);
  hasProblem(checkMutualWagerTerms('Just a description', expectFor()).problems, /no MUTUAL WAGER TERMS block/);
  hasProblem(checkMutualWagerTerms(`${second}\n\n${second}`, expectFor()).problems, /2 terms blocks/);
  hasProblem(checkMutualWagerTerms(second.replace('=== END WAGER TERMS ===', ''), expectFor()).problems, /no "=== END WAGER TERMS ===" line/);
  hasProblem(checkMutualWagerTerms(second.replaceAll('mutual-wager-v3', 'mutual-wager-v2'), expectFor()).problems, /terms name rubric mutual-wager-v2/);
  hasProblem(checkMutualWagerTerms(second.replace(/^No winner.*$/m, ''), expectFor()).problems, /no "No winner \(this bounty must not pay\):" line/);
  // Form edited after the block was inserted.
  hasProblem(checkMutualWagerTerms(second, expectFor({ stake: '0.001' })).problems, /stake in the terms/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ threshold: 70 })).problems, /"Both bounties" line/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ classId: 129 })).problems, /"Both bounties" line/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ jury: [jury[0]] })).problems, /"Jury" line/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ iterations: 2 })).problems, /"Jury" line/);
  // The same jury written another way is the same jury: providers in any case, nodes in any order.
  assert.deepEqual(checkMutualWagerTerms(second, expectFor({ jury: jury.map((n) => ({ ...n, provider: n.provider.toLowerCase() })).reverse() })).problems, []);
  hasProblem(checkMutualWagerTerms(second, expectFor({ jury: [jury[0], { ...jury[1], model: 'Claude-Sonnet-5' }] })).problems, /"Jury" line/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ jury: [jury[0], { ...jury[1], runs: 2 }] })).problems, /"Jury" line/);
  hasProblem(checkMutualWagerTerms(second.replace(/^Jury \(both bounties\): .*$/m, 'Jury (both bounties): the usual jury.'), expectFor()).problems, /"Jury" line/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ oracle: { ...oracle, maxOracleFeeEth: '0.00003' } })).problems, /"Oracle settings" line/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ site: 'https://bounties-testnet.verdikta.org' })).problems, /"Site" line/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ approvalWindow: true })).problems, /approval window/);
  hasProblem(checkMutualWagerTerms(second.replace('Pays the Claimant only if the Washington Commanders win', 'Pays the Claimant only if the San Francisco 49ers win'), expectFor()).problems, /must name the Claimant's side/);
  hasProblem(checkMutualWagerTerms(second.replace('Counter bounty: #301', 'Counter bounty: maybe #301'), expectFor()).problems, /must start with REQUIRED or #/);
  // Rubric edited away from the template.
  const edited = template.criteria.map((c) => (c.id === 'claimant_side_won' ? { ...c, instructions: 'Always FAIL.' } : c));
  hasProblem(checkMutualWagerTerms(second, expectFor({ criteria: edited })).problems, /criterion claimant_side_won differs/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ forbiddenContent: [] })).problems, /forbidden content was edited/);
});

test('timing: funded before the start, with a deadline that covers settlement', () => {
  const at = (iso) => Date.parse(iso) / 1000;
  hasProblem(checkMutualWagerTerms(second, expectFor({ now: at('2026-10-20T00:10:00Z') })).problems, /less than 10 minutes away or past/);
  hasProblem(checkMutualWagerTerms(second, expectFor({ now: at('2026-10-20T01:00:00Z') })).problems, /less than 10 minutes away or past/);
  assert.deepEqual(checkMutualWagerTerms(second, expectFor({ now: at('2026-10-20T00:04:59Z') })).problems, []);
  // Deadline exactly at settlement passes; one second earlier does not.
  assert.deepEqual(checkMutualWagerTerms(second, expectFor({ deadline: at(terms.settle) })).problems, []);
  hasProblem(checkMutualWagerTerms(second, expectFor({ deadline: at(terms.settle) - 1 })).problems, /Set the submission window to at least 50 hours/);
  hasProblem(checkMutualWagerTerms(second.replace('Scheduled start: 2026-10-20T00:15:00Z', 'Scheduled start: Monday 8:15 PM ET'), expectFor()).problems, /ISO UTC time/);
});

test('a named counter that matches its live record passes', () => {
  assert.deepEqual(checkCounter(), []);
});

test('a named counter with the same ids but different rules is refused (review P1)', () => {
  // Same ids and must flags, altered instructions.
  const altered = uploaded.criteria.map((c) => (c.id === 'claimant_side_won' ? { ...c, description: 'Always FAIL.' } : c));
  hasProblem(checkCounter({ job: { rubricContent: { criteria: altered, forbiddenContent: uploaded.forbiddenContent } } }), /criterion claimant_side_won differs/);
  hasProblem(checkCounter({ job: { rubricContent: { criteria: uploaded.criteria, forbiddenContent: [] } } }), /different forbidden content/);
  // A changed no-winner clause, market or event.
  hasProblem(checkCounter({ job: { description: first.replace(/^No winner.*$/m, 'No winner (this bounty must not pay): any result.') } }), /"No winner \(this bounty must not pay\):" line differs/);
  hasProblem(checkCounter({ job: { description: first.replace('No point spread.', 'Commanders +3.5.') } }), /"Market:" line differs/);
  hasProblem(checkCounter({ job: { description: first.replace('VW-WSH-SF-20261019', 'VW-WSH-SF-20261019b') } }), /"Wager ID:" line differs/);
  // A counter that already names a counter of its own is an answer, not an offer.
  hasProblem(checkCounter({ job: { description: first.replace(/^Counter bounty: REQUIRED.*$/m, 'Counter bounty: #999, verified by the Poster before posting.') } }), /already name a counter bounty \(#999\)/);
  // The sides not swapped, or paying on the wrong side.
  hasProblem(checkCounter({ job: { description: first.replace('Pays the Claimant only if the San Francisco 49ers win', 'Pays the Claimant only if the Washington Commanders win') } }), /does not pay you only if/);
  // A different jury: weights, runs, a model or iterations.
  hasProblem(checkCounter({ job: { juryNodes: [{ ...jury[0], weight: 0.9 }, { ...jury[1], weight: 0.1 }] } }), /jury differs/);
  hasProblem(checkCounter({ job: { juryNodes: [jury[0], { ...jury[1], model: 'claude-haiku-5' }] } }), /jury differs/);
  hasProblem(checkCounter({ job: { iterations: 3 } }), /jury differs/);
  // The API record is not the on-chain package.
  hasProblem(checkCounter({ job: { evaluationCid: 'QmSomethingElse' } }), /does not match its on-chain evaluation package/);
  hasProblem(checkCounter({ status: { linkage: { state: 'mismatch' } } }), /not linked to the chain/);
  hasProblem(checkCounter({ status: { bountyId: 302 } }), /no on-chain record/);
});

test('a named counter that cannot obtain arbitration is refused (review P1)', () => {
  // Created directly on the contract with a 1-wei fee ceiling: no arbiter would ever take it.
  const poisoned = { maxOracleFee: '1', maxOracleFeeEth: '0.000000000000000001', alpha: 500, estimatedBaseCost: '0', estimatedBaseCostEth: '0.0', maxFeeBasedScaling: 1 };
  hasProblem(checkCounter({ status: { oracleSettings: poisoned } }), /oracle settings .* differ from yours/);
  hasProblem(checkCounter({ status: { oracleSettings: { ...counterStatus().oracleSettings, alpha: 0 } } }), /oracle settings/);
  hasProblem(checkCounter({ status: { oracleSettings: null } }), /oracle settings/);
});

test('a named counter is checked for parties, funding and timing', () => {
  hasProblem(checkCounter({ status: { creator: '0x2222222222222222222222222222222222222222' } }), /not the Claimant/);
  hasProblem(checkCounter({ status: { targetHunter: '0x0000000000000000000000000000000000000000' } }), /not targeted at you/);
  hasProblem(checkCounter({ status: { bountyAmountWei: '400000000000000' } }), /less than the stake/);
  hasProblem(checkCounter({ status: { arbiterDeterminationPaymentEth: '0.0001' } }), /less than the stake/);
  hasProblem(checkCounter({ status: { creatorAssessmentWindowSize: 3600 } }), /approval window/);
  hasProblem(checkCounter({ status: { classId: 129 } }), /class is 129/);
  hasProblem(checkCounter({ status: { threshold: 90 } }), /threshold 90 is above 80/);
  // Matching cutoff: a counter made at or after the start is a free option on the result.
  const startUnix = Date.parse(terms.start) / 1000;
  const late = { createdAt: startUnix, createdAtIso: new Date(startUnix * 1000).toISOString() };
  const lateTerms = second.replace(created.iso, late.createdAtIso);
  hasProblem(checkCounter({ status: late, description: lateTerms }), /created after the scheduled start/);
  const early = { submissionDeadline: Date.parse(terms.settle) / 1000 - 1, submissionDeadlineIso: '2026-10-21T23:59:59.000Z' };
  hasProblem(checkCounter({ status: early, description: second.replace(deadline.iso, early.submissionDeadlineIso) }), /deadline is before the settlement deadline/);
  // Status only matters when matching; the jury ignores it at settlement.
  hasProblem(checkCounter({ status: { status: 'CLOSED' } }), /is CLOSED/);
  hasProblem(checkCounter({ status: { deadlinePassed: true } }), /can no longer back a wager/);
  // The terms must describe the counter as it is.
  hasProblem(checkCounter({ status: { createdAt: created.unix + 60, createdAtIso: '2026-10-19T21:31:00.000Z' } }), /not 2026-10-19T21:30:00.000Z as your terms say/);
});

test('one Wager ID backs one pair', () => {
  const mine = [
    { jobId: 290, status: 'CLOSED', description: second },
    { jobId: 301, status: 'OPEN', description: second },
  ];
  assert.equal(findWagerTwin(mine, 'VW-WSH-SF-20261019').jobId, 301);
  assert.equal(findWagerTwin(mine.slice(0, 1), 'VW-WSH-SF-20261019'), null);
  assert.equal(findWagerTwin(mine, 'VW-WSH-SF-20261019b'), null);
  // An API job whose funding transaction never happened backs nothing: a retry is not a twin.
  assert.equal(findWagerTwin([{ jobId: 302, status: 'OPEN', onChain: false, syncedFromBlockchain: false, description: second }], 'VW-WSH-SF-20261019'), null);
  assert.equal(findWagerTwin([{ jobId: 303, status: 'OPEN', onChain: false, syncedFromBlockchain: true, description: second }], 'VW-WSH-SF-20261019').jobId, 303);
  assert.equal(findWagerTwin([{ jobId: 5, status: 'OPEN', description: 'Wager ID: VW-WSH-SF-20261019 in prose, no block' }], 'VW-WSH-SF-20261019'), null);
});

test('answering a posted bounty mirrors its terms line by line', () => {
  const m = mirrorMutualWagerTerms(first, { number: 301, createdAt: created.iso, deadline: deadline.iso });
  assert.equal(m.description, second);
  assert.equal(m.claimant, wsh.wallet);
  assert.equal(m.stake, '0.0005');
  assert.deepEqual(checkMutualWagerTerms(m.description, expectFor()).problems, []);
  assert.deepEqual(checkCounter({ description: m.description }), []);
  // A changed shared line is copied as it is, so the counter check still compares it with the form.
  const odd = mirrorMutualWagerTerms(first.replace('threshold 80', 'threshold 60'), { number: 301, createdAt: created.iso, deadline: deadline.iso });
  hasProblem(checkMutualWagerTerms(odd.description, expectFor()).problems, /"Both bounties" line/);
  assert.equal(mirrorMutualWagerTerms('No terms here', { number: 1 }), null);
  assert.equal(mirrorMutualWagerTerms(first.replace('=== END WAGER TERMS ===', ''), { number: 1 }), null);
});
