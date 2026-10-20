import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getTemplate, getTemplateOptions } from '../../src/data/rubricTemplates.js';
import {
  buildMutualWagerBounty, mutualWagerTermsSkeleton, hasMutualWagerTerms, MUTUAL_WAGER_CRITERIA, MUTUAL_WAGER_RUBRIC,
} from '../../src/utils/mutualWagerTerms.js';
const require = createRequire(import.meta.url);
const { validateRubric } = require('../../../server/utils/validation.js');
const { measureEvaluationQuery } = require('../../../server/utils/archiveGenerator.js');
const { maxEvaluationQueryChars } = require('../../../server/utils/bountyValidator.js');

// The Commanders @ 49ers wager that settled on mainnet (bounties #301/#303).
const terms = {
  wagerId: 'VW-WSH-SF-20261019', shortEvent: 'Commanders @ 49ers',
  event: "NFL 2026 regular season, Week 6: Washington Commanders (WAS) at San Francisco 49ers (SF), Levi's Stadium, Santa Clara, California.",
  start: '2026-10-20T00:15:00Z', market: 'straight-up winner on the official final score, overtime included. No point spread.',
  stake: '0.0005', settle: '2026-10-22T00:00:00Z', classId: 128, threshold: 80, jury: ['gpt-5.6-terra', 'claude-sonnet-5'],
  site: 'https://bounties.verdikta.org', escrow: '0xA741eFf41Bcf14793E61CEbB4179E05C9124D3f6', chain: 'Base (chain ID 8453)',
};
const sf = { wallet: '0xA3b423861e6D6501a05e87d1f500fFff2402f7B1', label: 'the San Francisco 49ers win', short: 'the 49ers' };
const wsh = { wallet: '0xF6DD9256D0091c6E773EBfDFC79783f9663e65Fc', label: 'the Washington Commanders win', short: 'the Commanders' };

// What the create page uploads: the template's instructions become each criterion's description.
const template = getTemplate('mutualWager');
const uploaded = { ...template, criteria: template.criteria.map(({ instructions, ...c }) => ({ ...c, description: instructions })) };
const query = (description) => measureEvaluationQuery({
  workProductType: 'Wager settlement claim', jobTitle: 'Wager VW-WSH-SF-20261019: Commanders @ 49ers, pays if the 49ers win',
  jobDescription: description, rubricCriteria: uploaded.criteria, forbiddenContent: uploaded.forbiddenContent,
}).composedLength;
const termsBlock = (description) => description.split('\n').filter((l) => /^[A-Z][A-Za-z ()]+: /.test(l));

test('the Mutual Wager template is offered and passes the server rubric check', () => {
  assert.ok(getTemplateOptions().some((o) => o.value === 'mutualWager' && o.label.includes('Mutual Wager')));
  assert.deepEqual(validateRubric(uploaded), { valid: true, errors: [] });
  assert.equal(template.threshold, 80);
  assert.equal(template.classId, 128);
  assert.ok(template.title.includes(MUTUAL_WAGER_RUBRIC));
  // The terms name these ids and the counter-bounty check compares them, so they must match exactly.
  assert.deepEqual(template.criteria.map((c) => c.id), MUTUAL_WAGER_CRITERIA);
  assert.ok(template.criteria.every((c) => c.must === true && c.weight === 0));
  assert.match(template.criteria.find((c) => c.id === 'integrity').instructions, /not started or in progress is a stale copy, not a contradiction/);
});

test('the two bounties of a wager carry mirrored terms', () => {
  const first = buildMutualWagerBounty(terms, sf, wsh, null);
  const second = buildMutualWagerBounty(terms, wsh, sf, { number: 301, createdAt: '2026-10-19T23:12:57Z', deadline: '2026-10-22T02:12:53Z' });
  assert.ok(hasMutualWagerTerms(first.description) && hasMutualWagerTerms(second.description));
  assert.equal(first.title, 'Wager VW-WSH-SF-20261019: Commanders @ 49ers, pays if the Commanders win');
  const shared = (d) => termsBlock(d).filter((l) => !/^(Poster|Claimant|Pays the Claimant|Counter bounty)/.test(l));
  assert.deepEqual(shared(first.description), shared(second.description));
  assert.ok(first.description.includes(`Poster (creator): ${sf.wallet}; side: ${sf.label}.`));
  assert.ok(second.description.includes(`Claimant (target, the only wallet that can claim): ${sf.wallet}; side: ${sf.label}.`));
  assert.ok(first.description.includes('Counter bounty: REQUIRED'));
  assert.ok(second.description.includes('Counter bounty: #301'));
  assert.ok(first.description.includes(`must-pass criteria ${MUTUAL_WAGER_CRITERIA.join(', ')}`));
});

test('the composed jury query stays under the 9,000-character budget the template was tested at', () => {
  // The site cap (maxEvaluationQueryChars) is far higher; the wager prompts proven on mainnet were about 8,000.
  for (const description of [
    buildMutualWagerBounty(terms, sf, wsh, null).description,
    buildMutualWagerBounty(terms, wsh, sf, { number: 301, createdAt: '2026-10-19T23:12:57Z', deadline: '2026-10-22T02:12:53Z' }).description,
    mutualWagerTermsSkeleton({ posterWallet: sf.wallet, claimantWallet: wsh.wallet, stake: '0.0005', threshold: 80, classId: 128 }),
  ]) {
    const n = query(description);
    assert.ok(n < 9000, `query ${n} chars`);
    assert.ok(n <= maxEvaluationQueryChars());
  }
});

test('the create-page skeleton fills what the form knows and marks the rest', () => {
  const d = mutualWagerTermsSkeleton({ posterWallet: sf.wallet, claimantWallet: '', stake: '0.0005', threshold: 80, classId: 128,
    site: 'https://bounties.verdikta.org', escrow: terms.escrow, chain: terms.chain });
  assert.ok(hasMutualWagerTerms(d));
  assert.ok(d.includes(`Poster (creator): ${sf.wallet}; side: <`));
  assert.ok(d.includes("Claimant (target, the only wallet that can claim): <Claimant's wallet (the Target Hunter)>"));
  assert.ok(d.includes('Stake: 0.0005 ETH per side.'));
  assert.ok(d.includes('threshold 80, class 128, jury <jury models'));
  assert.ok(d.includes('Counter bounty: REQUIRED'));
  assert.ok(d.includes('https://bounties.verdikta.org/api/jobs/N/onchain-status'));
  assert.equal(hasMutualWagerTerms('Write a blog post'), false);
});
