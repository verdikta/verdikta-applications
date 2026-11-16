// Node P12, acceptance 1 and 2, with no Docker: the builder holds no copy of Q31's grammar, so what it
// refuses is what the real verdikta-arbiter at the pin refuses. The real server and its validator answer the
// builder's real client and command check, for a table of commands, and the answers are held to the real
// parseCommand. This also says the pinned commit has what the node needs (A2c, A2d, A3c), by calling it.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { arbiterCheckout, APP_DIR, installSiblings } from '../src/setup.js';
import { draftSpec, FORGE_COMMANDS } from '../src/fixtures.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const KEYS = ['build', 'test', 'testFiles', 'testIds'];

/** Commands an arbiter's runner must refuse, and those it must take, per command. */
const REFUSED = Object.freeze([
  // shell-prefixed, as P3a's fixture was
  ['build', '[ "$(tail -n +2 /proc/net/route | grep -c .)" = 0 ] && forge build'],
  ['build', 'sleep 40; forge build'],
  ['build', 'true && forge build'],
  ['test', 'true && forge test'],
  ['test', 'sh -c "forge test"'],
  ['testFiles', 'true; forge test --match-path $FILES'],
  ['testIds', 'true; forge test --match-test $TEST_IDS'],
  // what the shell would have reached (Q31's routes)
  ['build', 'FOUNDRY_PROFILE=x forge build'],
  ['test', 'env -u FOUNDRY_CONFIG forge test'],
  ['build', '/usr/local/bin/forge build'],
  ['build', 'forge build --compiler-version 0.8.0'],
  ['test', 'forge test --root /tmp'],
  ['test', 'forge test > /tmp/out'],
  ['build', 'forge test'],
]);
const ACCEPTED = Object.freeze([
  ['build', 'forge build'],
  ['build', 'forge build --skip test'],
  ['test', 'forge test'],
  ['test', 'forge test -vvv --fuzz-runs 1000'],
  ['test', "forge test --match-path 'test/unit/*'"],
  ['testFiles', 'forge test --match-path $FILES'],
  ['testIds', 'forge test --match-test $TEST_IDS'],
  ['testIds', 'forge test --match-test $TEST_IDS --match-path $FILES'],
]);

const REPO = 'https://github.com/acme/vault';
const COMMIT = 'a'.repeat(40);
const draftWith = (key, text) => {
  const draft = draftSpec({ repo: REPO, baseCommit: COMMIT, disclosureKey: 'age1placeholder' });
  draft.commands = { ...draft.commands, [key]: text };
  return draft;
};

describe('the builder\'s command check against verdikta-arbiter at the pin', () => {
  let arbiter;
  let A;
  let parseCommand;
  let builder;
  let services;
  let server;
  let target;
  let http;
  let client;

  before(async () => {
    // The builder's own modules, from their own lock file: this package does not depend on them.
    installSiblings(() => {});
    arbiter = arbiterCheckout(() => {}, process.env, { packages: ['code-runner'] }).dir;
    const require = createRequire(path.join(arbiter, 'package.json'));
    A = (relative) => require(path.join(arbiter, relative));
    ({ parseCommand } = A('code-runner/src/commands'));
    builder = await import(path.join(APP_DIR, 'builder', 'src', 'runner.js'));
    services = await import(path.join(APP_DIR, 'builder', 'action', 'services.js'));
    http = A('code-runner/test/helpers/http');
    const { fakeDocker, healthyDaemon } = A('code-runner/test/helpers/fakeDocker');
    const { createServer } = A('code-runner/src/server');
    server = createServer({ config: http.testConfig(), docker: fakeDocker(healthyDaemon()), log: silent, statfs: async () => ({ bavail: 1e12, bsize: 1 }) });
    target = await server.listen();
    client = builder.createRunnerClient({ url: `http://127.0.0.1:${target.port}`, token: http.TOKEN, timeoutMs: 30000 });
  });
  after(async () => { await server?.close(); });

  test('the real runner has the grammar: the canary comes back as COMMAND_NOT_ALLOWED, for all four commands', async () => {
    const { canary, issues } = await builder.checkCommands({ runner: client, draft: draftWith('build', 'forge build') });
    assert.equal(canary, 'COMMAND_NOT_ALLOWED');
    assert.deepEqual(issues, []);
  });

  for (const [key, text] of REFUSED) {
    test(`refused, by the same code as the real parser: commands.${key} = ${JSON.stringify(text)}`, async () => {
      const real = parseCommand(key, text);
      assert.equal(real.ok, false, `the real grammar takes ${text}`);
      const { issues } = await builder.checkCommands({ runner: client, draft: draftWith(key, text) });
      assert.deepEqual(issues.map((i) => [i.code, i.path]), [[real.issue.code, real.issue.path]]);
      assert.equal(issues[0].detail, real.issue.detail, 'the runner\'s words reach the maker');
    });
  }

  for (const [key, text] of ACCEPTED) {
    test(`taken: commands.${key} = ${JSON.stringify(text)}`, async () => {
      assert.equal(parseCommand(key, text).ok, true);
      assert.deepEqual((await builder.checkCommands({ runner: client, draft: draftWith(key, text) })).issues, []);
    });
  }

  test('a command the draft leaves out, over the limit or without its placeholder is refused by the runner\'s code too', async () => {
    const without = draftWith('build', 'forge build');
    delete without.commands.test;
    assert.deepEqual((await builder.checkCommands({ runner: client, draft: without })).issues.map((i) => i.code), ['COMMAND_MISSING']);
    const long = `forge test --match-test '${'x'.repeat(2100)}'`;
    assert.deepEqual((await builder.checkCommands({ runner: client, draft: draftWith('test', long) })).issues.map((i) => i.code), ['COMMAND_INVALID']);
    assert.deepEqual((await builder.checkCommands({ runner: client, draft: draftWith('testFiles', 'forge test') })).issues.map((i) => i.code), ['COMMAND_PLACEHOLDER']);
  });

  test('P3a\'s Docker fixture and the round\'s fixture hold plain forge commands, by the real parser', async () => {
    const { fixtureDraft } = await import(path.join(APP_DIR, 'builder', 'test', 'docker', 'helpers.js'));
    const docker = fixtureDraft(COMMIT, 'age1placeholder').commands;
    for (const key of KEYS) {
      assert.equal(parseCommand(key, docker[key]).ok, true, `the Docker fixture's ${key}: ${docker[key]}`);
      assert.equal(parseCommand(key, FORGE_COMMANDS[key]).ok, true, `the round's ${key}: ${FORGE_COMMANDS[key]}`);
    }
  });

  test('the pinned commit has A2c, A2d and A3c, by calling them', async () => {
    const integrity = A('code-runner/src/integrity');
    assert.equal(typeof integrity.officialCompilers, 'function', 'A2c: the look at any solc in the image');
    assert.equal(typeof integrity.vyperProblems, 'function', 'A2d: the look at any vyper');
    const { officialList } = A('code-runner/src/solcReleases');
    assert.ok(officialList('linux/amd64').byHash ?? officialList('linux/amd64'), 'A2c: the official list');
    const scanner = A('code-runner/src/scanner');
    assert.equal(typeof scanner.requireScanner, 'function', 'A3c: a claim needs the scanner');
    const listing = fs.readFileSync(path.join(arbiter, 'code-runner', 'src', 'listing.js'), 'utf8');
    for (const code of ['SOLC_NOT_OFFICIAL', 'VYPER_NOT_SUPPORTED']) assert.ok(listing.includes(code), code);
  });

  test('the builder\'s scan and the runner\'s scanner are one image, so one pull, and one rule-set version', async () => {
    const { SCAN_TOOLS } = await import(path.join(APP_DIR, 'builder', 'src', 'scanTools.js'));
    const { SEMGREP } = A('code-runner/src/semgrepPin');
    assert.equal(SCAN_TOOLS.semgrep.image, SEMGREP.reference);
    assert.equal(SCAN_TOOLS.semgrep.version, SEMGREP.version);
    assert.equal(SCAN_TOOLS.rules.version, A('code-runner/src/scanner').RULES_VERSION);
    const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(hash(path.join(arbiter, 'code-runner', 'rules', SCAN_TOOLS.rules.file)), SCAN_TOOLS.rules.sha256, 'the same Solidity rules, byte for byte');
  });

  test('the workflow reads the arbiters\' default allowlist from the pinned runner\'s own rule', () => {
    const list = services.pinnedAllowlist(path.join(arbiter, 'code-runner'));
    assert.equal(list.defaults, A('code-runner/src/registry').DEFAULT_REGISTRY_ALLOWLIST);
    assert.equal(list.allowed('ghcr.io/verdikta/stake-env'), true);
    assert.equal(list.allowed('ghcr.io/acme/stake-env'), false);
    assert.equal(services.publishTargetNote({ publishAs: 'ghcr.io/acme/stake-env', signing: 'production', arbiter: list }).refuse, true);
    assert.equal(services.publishTargetNote({ publishAs: 'ghcr.io/verdikta/stake-env', signing: 'production', arbiter: list }), null);
  });

  test('the real /health of a runner with no Semgrep image is 503, and the workflow still takes it as able to check a listing', async () => {
    const { fakeDocker, healthyDaemon } = A('code-runner/test/helpers/fakeDocker');
    const { createServer } = A('code-runner/src/server');
    const { SEMGREP } = A('code-runner/src/semgrepPin');
    const healthy = healthyDaemon();
    const docker = fakeDocker({
      ...healthy,
      image: (args, opts, calls) => (args.includes(SEMGREP.reference) ? { exitCode: 1, stderr: `Error response from daemon: No such image: ${SEMGREP.reference}\n` } : healthy.image?.(args, opts, calls)),
    });
    const cold = createServer({ config: http.testConfig(), docker, log: silent, statfs: async () => ({ bavail: 1e12, bsize: 1 }) });
    const at = await cold.listen();
    try {
      const res = await http.request(at, { path: '/health' });
      assert.equal(res.status, 503);
      assert.deepEqual(res.body.reasons, [res.body.scanner.problem]);
      assert.equal(res.body.scanner.present, false);
      assert.equal(services.runnerAnswersListings({ status: res.status, json: res.body }), true);
    } finally {
      await cold.close();
    }
  });
});
