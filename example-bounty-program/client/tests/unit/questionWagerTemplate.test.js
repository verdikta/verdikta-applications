// The create page's "❓ Question Wager" template (mutual-wager-v4): offered, accepted by the server's
// rubric check, the very template the shared wager module embeds, and its "Add a terms block"
// skeleton refused until every placeholder is filled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getTemplate, getTemplateOptions } from '../../src/data/rubricTemplates.js';
import { questionWagerTermsSkeleton, checkMutualWagerTerms, QUESTION_WAGER_TEMPLATE, QUESTION_WAGER_RUBRIC, QUESTION_WAGER_CRITERIA } from '../../src/utils/mutualWagerTerms.js';
const require = createRequire(import.meta.url);
const { validateRubric } = require('../../../server/utils/validation.js');
const { measureEvaluationQuery } = require('../../../server/utils/archiveGenerator.js');
const { maxEvaluationQueryChars } = require('../../../server/utils/bountyValidator.js');

const template = getTemplate('questionWager');
const uploaded = { ...template, criteria: template.criteria.map(({ instructions, ...c }) => ({ ...c, description: instructions })) };
const jury = [{ provider: 'OpenAI', model: 'gpt-5.6-terra', weight: 0.5, runs: 1 }, { provider: 'Anthropic', model: 'claude-sonnet-5', weight: 0.5, runs: 1 }];
const oracle = { maxOracleFeeEth: '0.00002', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: '3', alpha: '500' };
const form = { posterWallet: '0x7ACbdBC2bB6e4fF8b705d695F77144eA619C0e2D', claimantWallet: '0x75fAc210bF1Dcd0BA3FaC294de7c50C5763Da6d9', stake: '0.0001',
  threshold: 80, classId: 128, jury, iterations: 1, oracle, site: 'https://bounties-testnet.verdikta.org', escrow: '0x1B4F0e43256d435DfcD5C0883799F0Eb3943e08f', chain: 'Base Sepolia Testnet (chain ID 84532)' };

test('the Question Wager template is offered and passes the server rubric check', () => {
  assert.ok(getTemplateOptions().some((o) => o.value === 'questionWager' && o.label.includes('Question Wager')));
  assert.deepEqual(validateRubric(uploaded), { valid: true, errors: [] });
  assert.ok(template.title.includes(QUESTION_WAGER_RUBRIC));
  assert.deepEqual(template.criteria.map((c) => c.id), QUESTION_WAGER_CRITERIA);
  for (const key of ['version', 'title', 'description', 'threshold', 'classId', 'criteria', 'forbiddenContent']) {
    assert.deepEqual(template[key], JSON.parse(JSON.stringify(QUESTION_WAGER_TEMPLATE[key])), key);
  }
});

test('"Add a terms block" writes the v4 lines with placeholders, which the pre-funding check refuses', () => {
  const skeleton = questionWagerTermsSkeleton(form);
  assert.match(skeleton, /=== MUTUAL WAGER TERMS \(mutual-wager-v4\) ===\nWager ID: <[^>]+>\nQuestion: <[^>]+>\nBets close: <[^>]+>\nResolves at: <[^>]+>\nClaims open: <[^>]+>\nYES wins if: <[^>]+>\.\nNO wins if: <[^>]+>\.\n/);
  assert.match(skeleton, /\nResolution sources \(start here, then search the web\): <https URL[^>]*> , <second https URL>\n/);
  assert.match(skeleton, /\nPoster \(creator\): 0x7ACbdBC2bB6e4fF8b705d695F77144eA619C0e2D; side: <YES wins or NO wins: your side>\.\n/);
  const { issues } = checkMutualWagerTerms(skeleton, { now: Date.parse('2026-10-22T12:00:00Z') / 1000, criteria: template.criteria, forbiddenContent: template.forbiddenContent });
  assert.equal(issues[0].code, 'WAGER_TERMS');
  assert.match(issues[0].message, /Replace every <\.\.\.> placeholder/);
  // Even unfilled, the query stays well under the arbiters' cap.
  const size = measureEvaluationQuery({ workProductType: 'Wager settlement claim', jobTitle: 'Wager X: pays if NO wins', jobDescription: skeleton,
    rubricCriteria: uploaded.criteria, forbiddenContent: uploaded.forbiddenContent }).composedLength;
  assert.ok(size < maxEvaluationQueryChars() / 2, `query ${size}`);
});
