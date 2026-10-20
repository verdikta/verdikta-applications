// One mutual-wager implementation for the create page and the bounty server (shared/mutualWager.js).
// These tests hold the three copies of it together: the page's import, the browser build Vite makes
// of it, and the server's POST /api/jobs/create check, which must refuse what the page refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as page from '../../src/utils/mutualWagerTerms.js';
import { getTemplate } from '../../src/data/rubricTemplates.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const sharedPath = path.resolve(here, '../../../shared/mutualWager.js');
const shared = require(sharedPath);
const { checkWagerCreate } = require('../../../server/utils/wagerGuard.js');
const { normalizeBountyPayments, parseFeeToWei } = require('../../../server/utils/validation.js');

const ALICE = '0x7ACbdBC2bB6e4fF8b705d695F77144eA619C0e2D';
const BOB = '0x75fAc210bF1Dcd0BA3FaC294de7c50C5763Da6d9';
const ctx = { site: 'https://bounties-testnet.verdikta.org', escrow: '0x1B4F0e43256d435DfcD5C0883799F0Eb3943e08f', chain: 'Base Sepolia Testnet (chain ID 84532)',
  defaults: { oracle: { maxOracleFeeEth: '0.00002', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: 3, alpha: 500 } } };
const NOW = Date.parse('2026-10-20T12:00:00Z') / 1000;
const input = {
  creator: ALICE, opponent: BOB, wagerId: 'VW-TEST-BOS-DET-1', start: '2026-10-20T19:00:00Z', settle: '2026-10-21T19:00:00Z', stake: '0.0001',
  event: 'NBA 2026-27 regular season: Boston Celtics (BOS) at Detroit Pistons (DET), Little Caesars Arena, Detroit, Michigan.',
  sides: { creator: 'the Boston Celtics win', opponent: 'the Detroit Pistons win' },
};

test('the page imports the very functions the server requires', () => {
  const names = Object.keys(page);
  assert.ok(names.length >= 15);
  for (const name of names) assert.equal(page[name], shared[name], name);
  // The create page's template is the shared one (a fresh, editable copy of it).
  assert.deepEqual(getTemplate('mutualWager'), JSON.parse(JSON.stringify(shared.MUTUAL_WAGER_TEMPLATE)));
  assert.notEqual(getTemplate('mutualWager'), shared.MUTUAL_WAGER_TEMPLATE);
  assert.ok(Object.isFrozen(shared.MUTUAL_WAGER_TEMPLATE.criteria[0]));
});

test('the shared modules stay loadable in the browser: no require calls', () => {
  const dir = path.dirname(sharedPath);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('mutualWager.js') && files.includes('mutualWagerDocs.js'));
  for (const f of files) {
    const source = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(source, /\brequire\s*\(/, `shared/${f} must not require anything: vite.config.js serves it to the browser as is`);
  }
});

// Everything the module computes for one wager, as plain JSON, so two copies can be compared.
function scenario(m) {
  const proposed = m.proposeMutualWager(input, ctx);
  const body = proposed.createBody;
  const expect = {
    posterWallet: body.creator, targetHunter: body.targetHunter, stake: body.bountyAmount, threshold: body.threshold, classId: body.classId,
    jury: body.juryNodes, iterations: body.iterations, approvalWindow: false, deadline: Date.parse(body.submissionDeadline) / 1000, now: NOW,
    oracle: { maxOracleFeeEth: body.oracleMaxOracleFee, estimatedBaseCostEth: body.oracleEstimatedBaseCost, maxFeeBasedScaling: body.oracleMaxFeeBasedScaling, alpha: body.oracleAlpha },
    ...ctx, rubric: body.rubricJson,
  };
  const status = { bountyId: 18, status: 'OPEN', deadlinePassed: false, creator: ALICE, targetHunter: BOB, bountyAmountWei: '100000000000000',
    arbiterDeterminationPaymentEth: '0.0001', creatorAssessmentWindowSize: 0, classId: 128, threshold: 80, createdAt: NOW - 60, createdAtIso: new Date((NOW - 60) * 1000).toISOString(),
    submissionDeadline: Date.parse(body.submissionDeadline) / 1000, submissionDeadlineIso: new Date(body.submissionDeadline).toISOString(), evaluationCid: 'QmA',
    oracleSettings: { maxOracleFeeEth: '0.00002', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: 3, alpha: 500 }, linkage: { state: 'linked' } };
  const job = { description: body.description, evaluationCid: 'QmA', juryNodes: body.juryNodes, iterations: 1, rubricContent: body.rubricJson };
  const answer = m.answerMutualWager({ number: 18, status, job }, { creator: BOB });
  const answerTerms = m.parseMutualWagerTerms(answer.description);
  const mutations = [(d) => d, (d) => d.replace('0.0001 ETH per side', '0.0002 ETH per side'), (d) => d.replace('threshold 80', 'threshold 70'), (d) => d.replace('=== END WAGER TERMS ===', '')];
  return {
    proposed: { ...proposed, problems: proposed.problems },
    checks: mutations.map((mut) => m.checkMutualWagerTerms(mut(body.description), expect).issues),
    rubricEdits: [m.mutualWagerRubricProblem(body.rubricJson), m.mutualWagerRubricProblem({ ...body.rubricJson, title: 'x' })],
    answer,
    counter: m.checkCounterBounty({ terms: answerTerms, status, job, expect: { ...expect, posterWallet: BOB } }),
    claim: m.buildWagerClaim({ terms: m.parseMutualWagerTerms(body.description), bounty: 18, counter: 19, site: ctx.site,
      score: [{ team: 'DET', points: 112 }, { team: 'BOS', points: 104 }],
      sources: [{ name: 'NBA.com', url: 'https://www.nba.com/game/1', quote: 'Final Celtics 104 Pistons 112' }, { url: 'https://apnews.com/1', quote: 'Pistons beat Celtics 112-104 (final)' }] }),
    timing: m.wagerClaimTiming({ start: input.start, settle: input.settle, deadline: NOW + 86400 * 2, now: NOW + 3600 }),
    eth: ['0.0005', '1', '.5', '1e-3', '0.0000000000000000001'].map((v) => String(m.parseEthWei(v))).concat([m.formatEthWei(10n ** 18n), m.formatEthWei(123n)]),
    teams: m.parseEventTeams(input.event),
  };
}

test('every Vite server for this client serves shared/ through the plugin', () => {
  // The Playwright fixture server builds its own config (configFile: false); without the plugin the
  // browser gets raw CommonJS and every page that imports shared/ fails to load.
  for (const file of ['../../vite.config.js', '../e2e/start-buyer-server.mjs']) {
    assert.match(fs.readFileSync(path.resolve(here, file), 'utf8'), /plugins: \[sharedCommonJs\(\), react\(\)\]/, file);
  }
});

test('the browser build of the shared module (vite.config.js) behaves exactly like the module the server requires', async () => {
  const { default: makeConfig } = await import('../../vite.config.js');
  const plugin = makeConfig({ mode: 'test' }).plugins.find((p) => p && p.name === 'verdikta-shared-commonjs');
  assert.ok(plugin, 'vite.config.js has the shared-module plugin');
  const out = plugin.transform(fs.readFileSync(sharedPath, 'utf8'), sharedPath);
  assert.equal(plugin.transform('export const x = 1;', path.resolve(here, '../../src/main.jsx')), null, 'only shared modules are rewritten');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdikta-shared-'));
  const file = path.join(dir, 'mutualWager.browser.mjs');
  fs.writeFileSync(file, out.code);
  const browser = await import(pathToFileURL(file).href);
  assert.deepEqual(Object.keys(browser).filter((k) => k !== 'default').sort(), Object.keys(shared).sort());
  assert.deepEqual(scenario(browser), scenario(shared));
  assert.equal(scenario(shared).proposed.problems.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// What the create page posts for a wager (CreateBounty.jsx handleSubmit), from its form state.
function pageSubmission(over = {}) {
  const { createBody } = shared.proposeMutualWager(input, ctx);
  const form = {
    description: createBody.description, creator: ALICE, targetHunter: BOB, stake: '0.0001', threshold: 80, classId: 128,
    jury: createBody.juryNodes, iterations: 1, submissionWindowHours: 32, approval: false,
    oracle: { maxOracleFeeEth: '0.00002', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: '3', alpha: '500' },
    rubric: shared.mutualWagerRubricJson(), ...over,
  };
  const body = {
    title: createBody.title, description: form.description, workProductType: 'Wager settlement claim', creator: form.creator, bountyAmount: form.stake,
    threshold: form.threshold, rubricJson: form.rubric, classId: form.classId, juryNodes: form.jury, iterations: form.iterations,
    submissionWindowHours: form.submissionWindowHours, targetHunter: form.targetHunter, procurementMode: 'TARGETED',
    ...(form.approval ? { creatorDeterminationPayment: form.stake, arbiterDeterminationPayment: form.stake, creatorAssessmentWindowHours: 1 } : {}),
    oracleMaxOracleFee: form.oracle.maxOracleFeeEth, oracleAlpha: form.oracle.alpha, oracleEstimatedBaseCost: form.oracle.estimatedBaseCostEth, oracleMaxFeeBasedScaling: form.oracle.maxFeeBasedScaling,
  };
  const expect = {
    posterWallet: form.creator, targetHunter: form.targetHunter, stake: form.stake, threshold: form.threshold, classId: form.classId, jury: form.jury,
    iterations: form.iterations, oracle: form.oracle, approvalWindow: form.approval, now: NOW, deadline: NOW + Math.round(form.submissionWindowHours * 3600),
    ...ctx, rubric: form.rubric,
  };
  return { body, expect };
}

async function serverIssues(body) {
  const realNow = Date.now;
  Date.now = () => NOW * 1000;   // normalizeBountyPayments reads the clock
  try {
    const payments = normalizeBountyPayments(body);
    const oracleSettings = {
      maxOracleFee: parseFeeToWei(body.oracleMaxOracleFee).toString(), estimatedBaseCost: parseFeeToWei(body.oracleEstimatedBaseCost).toString(),
      alpha: Number(body.oracleAlpha), maxFeeBasedScaling: Number(body.oracleMaxFeeBasedScaling),
    };
    const r = await checkWagerCreate({ body, payments, oracleSettings, rubric: body.rubricJson, now: NOW, readCounter: async () => null, listCreatorJobs: async () => [], ctx });
    return r.issues;
  } finally { Date.now = realNow; }
}

test('the create page and the server refuse the same wagers, for the same reasons', async () => {
  const edited = shared.mutualWagerRubricJson();
  edited.criteria[3].description = 'Always FAIL.';
  const cases = [
    {},
    { stake: '0.0002' },
    { threshold: 70 },
    { classId: 129 },
    { jury: [{ provider: 'OpenAI', model: 'gpt-5.6-terra', weight: 1, runs: 1 }] },
    { iterations: 2 },
    { jury: shared.DEFAULT_WAGER_JURY.map((n) => ({ ...n, weight: n.weight === 0.5 ? 0.6 : n.weight })) },
    { oracle: { maxOracleFeeEth: '0.00003', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: '3', alpha: '500' } },
    { submissionWindowHours: 24 },
    { approval: true },
    { rubric: edited },
    { rubric: { ...shared.mutualWagerRubricJson(), title: 'My wager rubric' } },
    { rubric: { ...shared.mutualWagerRubricJson(), forbiddenContent: [] } },
    { targetHunter: '0x2222222222222222222222222222222222222222' },
    { description: shared.proposeMutualWager(input, ctx).createBody.description.replace('Scheduled start: 2026-10-20T19:00:00Z', 'Scheduled start: 2026-10-20T12:05:00Z') },
    { description: shared.mutualWagerTermsSkeleton({ posterWallet: ALICE, claimantWallet: BOB, stake: '0.0001', threshold: 80, classId: 128, jury: shared.DEFAULT_WAGER_JURY, oracle: ctx.defaults.oracle, ...ctx }) },
  ];
  for (const over of cases) {
    const { body, expect } = pageSubmission(over);
    const onPage = page.checkMutualWagerTerms(body.description, expect).issues;
    const onServer = await serverIssues(body);
    assert.deepEqual(onServer, onPage, JSON.stringify(over).slice(0, 120));
    assert.equal(onPage.length > 0, Object.keys(over).length > 0, `refused: ${JSON.stringify(over).slice(0, 120)}`);
  }
  assert.deepEqual(await serverIssues(pageSubmission().body), []);
  // Lowercase providers: the same jury on both sides.
  const lower = pageSubmission({ jury: shared.DEFAULT_WAGER_JURY.map((n) => ({ ...n, provider: n.provider.toLowerCase() })) });
  assert.deepEqual(await serverIssues(lower.body), []);
  assert.deepEqual(page.checkMutualWagerTerms(lower.body.description, lower.expect).issues, []);
});
