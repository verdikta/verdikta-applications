// The skill must build and check wager terms with the website's own code. These tests compare the vendored copy and
// the skill's constants with the site's files; they need the repository (an installed skill copy skips them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { formatEther } from 'ethers';
import * as vendored from '../_mutual-wager-terms.js';
import * as W from '../_wager.js';

const client = new URL('../../../../example-bounty-program/client/src/', import.meta.url);
const siteFile = new URL('utils/mutualWagerTerms.js', client);
const skip = existsSync(siteFile) ? false : 'website source not beside this skill (installed copy)';
const read = (rel) => readFileSync(new URL(rel, client), 'utf8');
const fx = (n, kind) => JSON.parse(readFileSync(new URL(`./fixtures/wager-testnet/${n}.${kind}.json`, import.meta.url), 'utf8'));

test('vendored terms helper is the website file byte for byte (node sync_wager_assets.js)', { skip }, () => {
  const copy = readFileSync(new URL('../_mutual-wager-terms.js', import.meta.url), 'utf8');
  const marker = '// ---- end of vendored header ----\n';
  assert.ok(copy.includes(marker));
  assert.equal(copy.slice(copy.indexOf(marker) + marker.length), read('utils/mutualWagerTerms.js'));
});

test('vendored rubric template is the website template (node sync_wager_assets.js)', { skip }, async () => {
  const { getTemplate } = await import(new URL('data/rubricTemplates.js', client));
  assert.deepEqual(W.template, getTemplate('mutualWager'));
  assert.equal(vendored.MUTUAL_WAGER_RUBRIC, 'mutual-wager-v3');
  assert.deepEqual(W.template.criteria.map((c) => c.id), vendored.MUTUAL_WAGER_CRITERIA);
});

test('the site module and the vendored copy give the same answers', { skip }, async (t) => {
  let site;
  try { site = await import(siteFile); } catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') return t.skip('client dependencies not installed'); throw e; }
  const jury = W.WAGER_DEFAULTS.jury, oracle = W.WAGER_DEFAULTS.oracle;
  const terms = { wagerId: 'VW-P', event: 'E (A) at F (B)', shortEvent: 'A @ B', start: '2026-10-20T19:00:00Z', market: W.DEFAULT_MARKET, stake: '0.0001',
    settle: '2026-10-21T19:00:00Z', classId: 128, threshold: 80, jury, iterations: 1, oracle, site: 'https://s', escrow: '0x1B4F0e43256d435DfcD5C0883799F0Eb3943e08f', chain: 'Base Sepolia Testnet (chain ID 84532)' };
  const a = { wallet: '0x7ACbdBC2bB6e4fF8b705d695F77144eA619C0e2D', label: 'A wins', short: 'A' }, b = { wallet: '0x75fAc210bF1Dcd0BA3FaC294de7c50C5763Da6d9', label: 'B wins', short: 'B' };
  const counter = { number: 18, createdAt: '2026-10-20T16:39:00.000Z', deadline: '2026-10-21T20:38:58.000Z' };
  const same = (fn, ...args) => assert.deepEqual(JSON.parse(JSON.stringify(vendored[fn](...args))), JSON.parse(JSON.stringify(site[fn](...args))), fn);
  same('buildMutualWagerBounty', terms, a, b, null); same('buildMutualWagerBounty', terms, b, a, counter);
  same('mutualWagerTermsSkeleton', { posterWallet: a.wallet, stake: '0.01', threshold: 80, classId: 128, jury, oracle, site: 'https://s', escrow: terms.escrow, chain: terms.chain });
  same('formatJury', jury, 1); same('formatOracle', oracle);
  const template = W.template;
  for (const n of [18, 19, 20, 21, 22, 23, 24, 25]) {
    const job = fx(n, 'job').job, status = fx(n, 'status');
    same('parseMutualWagerTerms', job.description); same('hasMutualWagerTerms', job.description);
    same('mirrorMutualWagerTerms', job.description, { number: n, createdAt: status.createdAtIso, deadline: status.submissionDeadlineIso });
    const mine = vendored.mirrorMutualWagerTerms(job.description, { number: n, createdAt: status.createdAtIso, deadline: status.submissionDeadlineIso }).description;
    const expect = { posterWallet: job.targetHunter, targetHunter: job.creator, stake: '0.0001', threshold: 80, classId: 128, jury, iterations: 1, oracle, approvalWindow: false,
      now: Date.parse('2026-10-20T18:00:00Z') / 1000, deadline: Date.parse('2026-10-21T19:00:00Z') / 1000, site: 'https://bounties-testnet.verdikta.org', escrow: terms.escrow, chain: terms.chain,
      criteria: template.criteria, forbiddenContent: template.forbiddenContent, template };
    same('checkMutualWagerTerms', mine, expect);
    same('checkCounterBounty', { terms: vendored.parseMutualWagerTerms(mine), status, job, expect });
    same('findWagerTwin', [{ jobId: n, status: 'OPEN', description: job.description }], 'VW-TEST3-BOS-DET-20261020');
  }
});

test('skill constants match the create page (markets, chain names, provider names, oracle defaults)', { skip }, () => {
  const skeleton = vendored.parseMutualWagerTerms(vendored.mutualWagerTermsSkeleton({}));
  assert.equal(skeleton.fields.market, W.DEFAULT_MARKET);
  assert.equal(skeleton.fields.noWinner, `${W.DEFAULT_NO_WINNER}.`);
  const config = read('config.js');
  for (const [network, name] of Object.entries(W.SITE_CHAIN_NAMES)) assert.match(config, new RegExp(`'${network}': \\{\\s*name: '${name}',`));
  const defaults = /submissionDefaults: \{\s*maxOracleFeeWei: '(\d+)',[^\n]*\n\s*estimatedBaseCostWei: '(\d+)',[^\n]*\n\s*maxFeeBasedScaling: '(\d+)',[^\n]*\n\s*alpha: (\d+),/.exec(config);
  assert.ok(defaults, 'submissionDefaults block not found in client/src/config.js');
  assert.deepEqual(W.WAGER_DEFAULTS.oracle, { maxOracleFeeEth: formatEther(defaults[1]), estimatedBaseCostEth: formatEther(defaults[2]), maxFeeBasedScaling: Number(defaults[3]), alpha: Number(defaults[4]) });
  const providers = /providerDisplayNames = \{([^}]*)\}/.exec(read('services/modelProviderService.js'))[1];
  assert.deepEqual(W.PROVIDER_NAMES, Object.fromEntries([...providers.matchAll(/'([^']+)': '([^']+)'/g)].map((m) => [m[1], m[2]])));
  assert.equal(W.WAGER_DEFAULTS.classId, W.template.classId); assert.equal(W.WAGER_DEFAULTS.threshold, W.template.threshold);
});

test('the uploaded rubric has the shape the create page uploads, with the template text', () => {
  const live = fx(18, 'job').job.rubricContent, mine = W.wagerRubricJson();
  assert.deepEqual(mine.criteria.map((c) => Object.keys(c)), live.criteria.map((c) => ['id', 'label', 'must', 'weight', 'description']));
  assert.deepEqual(mine.criteria.map(({ id, label, must, weight }) => ({ id, label, must, weight })), live.criteria.map(({ id, label, must, weight }) => ({ id, label, must, weight })));
  assert.deepEqual(mine.criteria.map((c) => c.description), W.template.criteria.map((c) => c.instructions));
  assert.deepEqual(mine.forbiddenContent, live.forbiddenContent);
});
