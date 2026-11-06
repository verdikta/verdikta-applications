// Acceptance 2 and the review's "a listing signed under the builder's check that a claim's runner would
// refuse". The builder holds no copy of Q31's grammar: it asks the runner, in a request that cannot start
// a run, before anything of the repository is fetched or the maker's setup runs. These tests use a double
// that answers in the runner's shape; e2e/test/grammar.test.js runs the same code against the real
// verdikta-arbiter at the pin, and test/docker/listing.docker.test.js through a whole build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseConfig } from '../../src/config.js';
import { buildListing } from '../../src/pipeline.js';
import { checkCommands, commandCanary, commandCheckBody, createRunnerClient, interpretListingCheck } from '../../src/runner.js';
import { fakeDocker } from '../helpers/fakes.js';
import { MAKER, provenAnswer } from '../helpers/proof.js';
import { doubledBuild } from '../helpers/build.js';
import { BASE_COMMIT, acceptedListing, definitive, draftSpec, refusedListing, requesterError, runnerWithGrammar } from '../helpers/specs.js';

const DIGEST = `sha256:${'2'.repeat(64)}`;
const IMAGE = `ghcr.io/verdikta/stake-env@${DIGEST}`;
const TOKEN = 'runner-token-0123456789abcdef0123456789';

function config() {
  return parseConfig({
    registry: { repository: 'ghcr.io/verdikta/stake-env' },
    runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' },
    signing: { key: 'dev' },
  }, { baseDir: '/tmp', env: { CODE_RUNNER_TOKEN: TOKEN } });
}

/** A build whose every outside step is recorded, so a test can say none of them ran. */
async function build(draft, runner) {
  const calls = { fetch: 0, docker: 0, control: 0 };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-commands-'));
  try {
    const out = await buildListing({
      draft,
      maker: MAKER,
      config: config(),
      workDir,
      deps: {
        runner,
        checkRepositoryControl: async (...args) => { calls.control += 1; return provenAnswer()(...args); },
        docker: fakeDocker(() => { calls.docker += 1; return {}; }),
        fetchListedCommit: async (req) => { calls.fetch += 1; return { gitDir: req.dir }; },
        writeBuildContext: () => ({ dockerfile: 'FROM x' }),
        registry: { imageInfo: async () => { throw new Error('nothing reaches the registry'); } },
      },
    });
    return { ...out, calls };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const SHELL_PREFIXED = Object.freeze([
  ['build', '[ "$(tail -n +2 /proc/net/route | grep -c .)" = 0 ] && forge build'],
  ['build', 'sleep 40; forge build'],
  ['build', 'FOUNDRY_PROFILE=x forge build'],
  ['test', 'true && forge test'],
  ['test', 'env -u FOUNDRY_CONFIG forge test'],
]);

test('the request cannot start a run: its spec names another image than the one sent, and it holds the draft\'s commands', () => {
  const draft = draftSpec();
  const body = commandCheckBody(draft);
  assert.notEqual(body.spec.env.image, body.image);
  assert.match(body.image, /^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/);
  assert.equal(body.spec.env.unpackedBytes, undefined, 'no size: a draft\'s is not attested');
  assert.deepEqual(body.spec.commands, draft.commands);
  assert.deepEqual(body.spec.paths, draft.paths);
  assert.deepEqual(body.spec.stake, draft.stake);
  assert.deepEqual(Object.keys(body).sort(), ['deadline', 'image', 'spec'], 'the fields a listing check takes');
});

for (const [key, text] of SHELL_PREFIXED) {
  test(`commands.${key} = ${JSON.stringify(text)} is refused by the runner's own code, before the control check, the fetch and the maker's setup`, async () => {
    const draft = draftSpec();
    draft.commands[key] = text;
    const { status, report, files, calls } = await build(draft, runnerWithGrammar());
    assert.equal(status, 'refused');
    assert.deepEqual(report.refusals.map((r) => [r.code, r.step]), [['COMMAND_NOT_ALLOWED', 'spec']]);
    assert.match(report.refusals[0].detail, new RegExp(`commands\\.${key}`));
    assert.deepEqual(calls, { fetch: 0, docker: 0, control: 0 }, 'nothing of the repository was read, nothing was built');
    assert.equal(files.size, 0);
    assert.equal(report.steps.at(-1).name, 'spec');
    assert.equal(report.steps.at(-1).status, 'failed');
  });
}

test('every issue the runner names is kept, in its order and by its code', async () => {
  const draft = draftSpec();
  draft.commands.build = 'true; forge build';
  draft.commands.testIds = 'forge test';
  const { report } = await build(draft, runnerWithGrammar());
  assert.deepEqual(report.refusals.map((r) => r.code), ['COMMAND_NOT_ALLOWED', 'COMMAND_PLACEHOLDER']);
});

test('a plain listing passes, and the report records what was asked: the runner refused the canary with the grammar\'s code', async () => {
  const seen = [];
  const r = await checkCommands({ runner: runnerWithGrammar({ onBody: (b) => seen.push(b) }), draft: draftSpec() });
  assert.deepEqual(r.issues, []);
  assert.equal(r.canary, 'COMMAND_NOT_ALLOWED');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].spec.commands, commandCanary(draftSpec()).commands, 'the canary first: a runner without the grammar says nothing of the draft');
  assert.deepEqual(seen[1].spec.commands, draftSpec().commands);
  for (const key of ['build', 'test', 'testFiles', 'testIds']) assert.notEqual(seen[0].spec.commands[key], draftSpec().commands[key], `the canary covers ${key}`);
  assert.equal(seen[0].spec.commands.setup, draftSpec().commands.setup);

  const { report, status } = await doubledBuild();
  assert.equal(status, 'accepted');
  assert.deepEqual(report.commands, { checkedBy: 'runner', canary: 'COMMAND_NOT_ALLOWED', issues: [] });
});

test('a runner without the grammar stops the build: an error to fix, not a refusal of the listing, and nothing is built or signed', async () => {
  const old = runnerWithGrammar({ refuses: () => false });
  const { status, report, calls, files } = await build(draftSpec(), old);
  assert.equal(status, 'error');
  assert.equal(report.error.code, 'RUNNER_WITHOUT_GRAMMAR');
  assert.equal(report.error.step, 'spec');
  assert.match(report.error.detail, /arbiter/);
  assert.deepEqual(calls, { fetch: 0, docker: 0, control: 0 });
  assert.equal(files.size, 0);
  // One command refused and another not is no grammar either: each of the four is asked.
  for (const key of ['build', 'test', 'testFiles', 'testIds']) {
    const partial = runnerWithGrammar({ refuses: (text, k) => k !== key && !text.startsWith('forge ') });
    await assert.rejects(checkCommands({ runner: partial, draft: draftSpec() }), { code: 'RUNNER_WITHOUT_GRAMMAR' }, key);
  }
});

test('an answer that is not what a request that cannot run gets is not read as a pass', async () => {
  const answers = {
    'a 200': { status: 200, json: { outcome: 'definitive', kind: 'listing-check', listing: acceptedListing() } },
    'a 503': { status: 503, json: { outcome: 'abstain', abstain: { cause: 'x' } } },
    'no JSON': { status: 502, json: null },
    'no image mismatch': { status: 400, json: { outcome: 'requester_error', issues: [{ code: 'COMMAND_NOT_ALLOWED', path: '/spec/commands/build', detail: 'x' }] } },
    'no issues': { status: 400, json: { outcome: 'requester_error', issues: [] } },
    'issues that are not a list': { status: 400, json: { outcome: 'requester_error', issues: 'none' } },
  };
  for (const [name, answer] of Object.entries(answers)) {
    await assert.rejects(checkCommands({ runner: { listingCheck: async () => answer }, draft: draftSpec() }), { code: 'RUNNER_ANSWER_INVALID' }, name);
  }
  await assert.rejects(checkCommands({ runner: { listingCheck: async () => ({ status: 401, json: {} }) }, draft: draftSpec() }), { code: 'RUNNER_UNAUTHORIZED' });
  const down = createRunnerClient({ url: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 2000 });
  await assert.rejects(checkCommands({ runner: down, draft: draftSpec() }), { code: 'RUNNER_UNAVAILABLE' });
});

test('the answer of the listing check itself must have read the compilers: a runner before A2c is not trusted', () => {
  const asAnswer = (d) => ({ status: d.status, json: d.body });
  const ok = asAnswer(definitive(IMAGE, acceptedListing()));
  assert.equal(interpretListingCheck(ok, { spec: draftSpec(), image: IMAGE }).outcome, 'accepted');
  const none = asAnswer(definitive(IMAGE, acceptedListing()));
  delete none.json.listing.compilers;
  assert.throws(() => interpretListingCheck(none, { spec: draftSpec(), image: IMAGE }), { code: 'RUNNER_ANSWER_INVALID' });
  const nothing = asAnswer(definitive(IMAGE, acceptedListing(BASE_COMMIT, { compilers: null })));
  assert.throws(() => interpretListingCheck(nothing, { spec: draftSpec(), image: IMAGE }), { code: 'RUNNER_ANSWER_INVALID' });
});

test('what the listing check refuses reaches the maker by the runner\'s code: the compilers, Vyper, and a 400 at the end', async () => {
  for (const code of ['SOLC_NOT_OFFICIAL', 'VYPER_NOT_SUPPORTED', 'LISTING_TOO_HEAVY']) {
    const r = interpretListingCheck((({ status, body }) => ({ status, json: body }))(definitive(IMAGE, refusedListing(code, 'why'))), { spec: draftSpec(), image: IMAGE });
    assert.equal(r.outcome, 'refused');
    assert.deepEqual(r.refusals.map((x) => x.code), [code]);
  }
  for (const code of ['COMMAND_NOT_ALLOWED', 'IMAGE_WATCH_ROOT_UNCOVERED']) {
    const { status, body } = requesterError(code);
    const r = interpretListingCheck({ status, json: body }, { spec: draftSpec(), image: IMAGE });
    assert.equal(r.outcome, 'rejected');
    assert.deepEqual(r.issues.map((x) => x.code), [code]);
  }
});
