// The skill must build and check wagers with the website's own code: example-bounty-program/shared/mutualWager.js, which
// the create page, the bounty server's /api/wagers and its /jobs/create check run. These tests compare the vendored
// copy and the skill's constants with the site's files; they need the repository (an installed skill copy skips them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { formatEther } from 'ethers';
import * as W from '../_wager.js';

const repo = new URL('../../../../example-bounty-program/', import.meta.url);
const sharedFile = new URL('shared/mutualWager.js', repo);
const skip = existsSync(sharedFile) ? false : 'website source not beside this skill (installed copy)';
const read = (rel) => readFileSync(new URL(rel, repo), 'utf8');
const fx = (n, kind) => JSON.parse(readFileSync(new URL(`./fixtures/wager-testnet/${n}.${kind}.json`, import.meta.url), 'utf8'));

test('vendored wager module is the shared module byte for byte (node sync_wager_assets.js)', { skip }, () => {
  const copy = readFileSync(new URL('../_mutual-wager.cjs', import.meta.url), 'utf8');
  const marker = '// ---- end of vendored header ----\n';
  assert.ok(copy.includes(marker));
  assert.equal(copy.slice(copy.indexOf(marker) + marker.length), read('shared/mutualWager.js'));
});

test('the create page serves the same template and terms functions', { skip }, async (t) => {
  let page, templates;
  try {
    [page, templates] = await Promise.all([import(new URL('client/src/utils/mutualWagerTerms.js', repo)), import(new URL('client/src/data/rubricTemplates.js', repo))]);
  } catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') return t.skip('client dependencies not installed'); throw e; }
  // The page's template (shared/rubricTemplates.json) adds display fields (label, icon, useWhen); the fields the jury reads match.
  for (const key of ['version', 'title', 'description', 'threshold', 'classId', 'criteria', 'forbiddenContent']) {
    assert.deepEqual(templates.getTemplate('mutualWager')[key], JSON.parse(JSON.stringify(W.template[key])), key);
  }
  const job = fx(18, 'job').job, status = fx(18, 'status');
  const mirror = { number: 18, createdAt: status.createdAtIso, deadline: status.submissionDeadlineIso };
  assert.deepEqual(page.mirrorMutualWagerTerms(job.description, mirror), W.shared.mirrorMutualWagerTerms(job.description, mirror));
  assert.deepEqual(page.parseMutualWagerTerms(job.description), W.shared.parseMutualWagerTerms(job.description));
  assert.equal(page.MUTUAL_WAGER_RUBRIC, W.shared.MUTUAL_WAGER_RUBRIC);
});

test('skill constants match the create page (chain names, provider names, oracle defaults, jury)', { skip }, () => {
  const config = read('client/src/config.js');
  for (const [network, chainId] of [['base-sepolia', 84532], ['base', 8453]]) assert.match(config, new RegExp(`'${network}': \\{\\s*name: '${W.shared.WAGER_CHAIN_NAMES[chainId]}',`));
  const defaults = /submissionDefaults: \{\s*maxOracleFeeWei: '(\d+)',[^\n]*\n\s*estimatedBaseCostWei: '(\d+)',[^\n]*\n\s*maxFeeBasedScaling: '(\d+)',[^\n]*\n\s*alpha: (\d+),/.exec(config);
  assert.ok(defaults, 'submissionDefaults block not found in client/src/config.js');
  assert.deepEqual(W.WAGER_DEFAULTS.oracle, { maxOracleFeeEth: formatEther(defaults[1]), estimatedBaseCostEth: formatEther(defaults[2]), maxFeeBasedScaling: Number(defaults[3]), alpha: Number(defaults[4]) });
  const providers = /providerDisplayNames = \{([^}]*)\}/.exec(read('client/src/services/modelProviderService.js'))[1];
  assert.deepEqual(W.PROVIDER_NAMES, Object.fromEntries([...providers.matchAll(/'([^']+)': '([^']+)'/g)].map((m) => [m[1], m[2]])));
  assert.deepEqual(W.WAGER_DEFAULTS.jury, W.shared.DEFAULT_WAGER_JURY);
  assert.equal(W.WAGER_DEFAULTS.classId, W.template.classId); assert.equal(W.WAGER_DEFAULTS.threshold, W.template.threshold);
});

test('the uploaded rubric is the template the server accepts, in the shape the create page uploads', () => {
  const live = fx(18, 'job').job.rubricContent, mine = W.wagerRubricJson();
  assert.equal(W.shared.mutualWagerRubricProblem(mine), null);
  assert.deepEqual(mine.criteria.map(({ id, label, must, weight }) => ({ id, label, must, weight })), live.criteria.map(({ id, label, must, weight }) => ({ id, label, must, weight })));
  assert.deepEqual(mine.criteria.map((c) => c.description), W.template.criteria.map((c) => c.instructions));
  assert.deepEqual(mine.forbiddenContent, live.forbiddenContent);
});

// Question wagers (mutual-wager-v4): the create page's Question Wager template and the rubric the skill uploads.
const qfx = (kind, n) => JSON.parse(readFileSync(new URL(`./fixtures/wager-question/${kind}-${n}.json`, import.meta.url), 'utf8'));

test('the create page serves the same question template and reads question terms the same way', { skip }, async (t) => {
  let page, templates;
  try {
    [page, templates] = await Promise.all([import(new URL('client/src/utils/mutualWagerTerms.js', repo)), import(new URL('client/src/data/rubricTemplates.js', repo))]);
  } catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') return t.skip('client dependencies not installed'); throw e; }
  for (const key of ['version', 'title', 'description', 'threshold', 'classId', 'criteria', 'forbiddenContent']) {
    assert.deepEqual(templates.getTemplate('questionWager')[key], JSON.parse(JSON.stringify(W.questionTemplate[key])), key);
  }
  const job = qfx('job', 40), status = qfx('status', 40);
  const mirror = { number: 40, createdAt: status.createdAtIso, deadline: status.submissionDeadlineIso };
  assert.deepEqual(page.mirrorMutualWagerTerms(job.description, mirror), W.shared.mirrorMutualWagerTerms(job.description, mirror));
  assert.deepEqual(page.parseMutualWagerTerms(job.description), W.shared.parseMutualWagerTerms(job.description));
  assert.equal(page.QUESTION_WAGER_RUBRIC, W.shared.QUESTION_WAGER_RUBRIC);
});

test('the uploaded question rubric is the v5 template; a v4 bounty keeps the v4 rubric the question fixtures store', () => {
  const mine = W.wagerRubricJson('question'), stored = qfx('job', 40).rubricContent;
  assert.equal(mine.title, 'Question Wager Settlement (mutual-wager-v5)');
  assert.equal(W.shared.mutualWagerRubricProblem(mine, W.questionTemplate), null);
  assert.ok(W.shared.mutualWagerRubricProblem(mine, W.template)); // never accepted as the game template
  assert.ok(W.shared.mutualWagerRubricProblem(mine, W.shared.QUESTION_WAGER_V4_TEMPLATE)); // nor as v4
  assert.deepEqual(mine.criteria.map((c) => c.description), W.questionTemplate.criteria.map((c) => c.instructions));
  assert.equal(W.questionTemplate.classId, W.WAGER_DEFAULTS.classId); assert.equal(W.questionTemplate.threshold, W.WAGER_DEFAULTS.threshold);
  const v4 = W.wagerRubricJson('question', W.shared.QUESTION_WAGER_V4_RUBRIC);
  assert.deepEqual(v4.criteria, stored.criteria);
  assert.deepEqual(v4.forbiddenContent, stored.forbiddenContent);
});
