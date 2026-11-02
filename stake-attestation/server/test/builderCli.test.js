// The server's adapter for the environment builder's command line (stake-attestation/builder,
// verdikta-build-env): build, then sign in a separate process, each given only the environment
// variables named for it. Run here against test/fixtures/fake-builder-cli.js, which keeps the
// builder's documented contract (exit status, output folder, validation-report.json); the real
// builder runs in the opt-in suite (npm run test:builder).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCliBuilder } from '../src/builder/cli.js';
import { codeReview } from '../src/common.js';
import { draftSpec, knownIssues, serialize } from './helpers/fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, 'fixtures', 'fake-builder-cli.js');
const SECRET = 'sk_live_this-must-never-reach-the-builder';
let tmp;

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-server-cli-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setup(mode, over = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, `${mode}-`));
  const configPath = path.join(dir, 'builder.json');
  const recordPath = path.join(dir, 'record.json');
  fs.writeFileSync(configPath, JSON.stringify({ mode, record: recordPath }));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    ETHERSCAN_API_KEY: 'explorer-key-for-build',
    VERDIKTA_BUILDER_KEY: 'signing-key-for-sign',
    SA_PINATA_JWT: SECRET,
    SA_FILEBASE_TOKEN: SECRET,
  };
  const builder = createCliBuilder({
    bin: BIN,
    config: configPath,
    workDir: dir,
    buildEnv: ['DOCKER_HOST', 'ETHERSCAN_API_KEY'],
    signEnv: ['VERDIKTA_BUILDER_KEY'],
    timeoutMs: 20000,
    graceMs: 1000,
    ...over,
  }, { env });
  const calls = () => (fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : []);
  return { builder, calls, dir };
}

const kiBytes = () => serialize(knownIssues());

describe('createCliBuilder', () => {
  test('an accepted build is signed in a second process and comes back with its files and report', async () => {
    const { builder, calls, dir } = setup('accepted');
    const draft = draftSpec();
    const ki = kiBytes();
    const r = await builder.build({ draft, knownIssues: ki });
    assert.equal(r.status, 'accepted');
    assert.equal(r.report.status, 'accepted');
    assert.equal(r.report.attestation.trust, 'dev');
    const spec = JSON.parse(r.files.codeReview);
    assert.equal(spec.env.platform, 'linux/amd64');
    assert.ok(r.files.knownIssues.equals(ki), 'the known-issues bytes the server sent');
    const att = codeReview.validateAttestation(JSON.parse(r.files.attestation), {
      files: { codeReview: r.files.codeReview, baseline: r.files.baseline, knownIssues: r.files.knownIssues },
      trust: r.devTrust,
    });
    assert.deepEqual(att.issues, []);
    const [build, sign] = calls();
    assert.equal(build.command, 'build');
    assert.equal(sign.command, 'sign');
    assert.deepEqual(build.argv.filter((a) => a.startsWith('--')), ['--config', '--spec', '--known-issues', '--out']);
    assert.deepEqual(build.spec, draft, 'the maker\'s draft, as given');
    assert.ok(Buffer.from(build.knownIssues, 'base64').equals(ki));
    // the work folder is removed afterwards
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('sa-build-')), []);
  });

  test('each step gets only PATH, HOME and the variables named for it: never a pinning credential', async () => {
    const { builder, calls } = setup('accepted');
    await builder.build({ draft: draftSpec(), knownIssues: kiBytes() });
    const [build, sign] = calls();
    const own = (env) => Object.keys(env).filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(k)).sort();
    assert.deepEqual(own(build.env), ['DOCKER_HOST', 'ETHERSCAN_API_KEY', 'HOME', 'PATH', 'TMPDIR']);
    assert.deepEqual(own(sign.env), ['HOME', 'PATH', 'TMPDIR', 'VERDIKTA_BUILDER_KEY']);
    for (const c of [build, sign]) {
      assert.equal(JSON.stringify(c).includes(SECRET), false);
    }
    assert.equal(build.env.VERDIKTA_BUILDER_KEY, undefined, 'build never holds the signing key');
  });

  test('a refused build (exit 2) returns the report and no files, and is not signed', async () => {
    const { builder, calls } = setup('refused-source');
    const r = await builder.build({ draft: draftSpec(), knownIssues: kiBytes() });
    assert.equal(r.status, 'refused');
    assert.equal(r.files, null);
    assert.equal(r.report.refusals[0].step, 'verifiedSource');
    assert.deepEqual(calls().map((c) => c.command), ['build']);
  });

  test('a build error (exit 1) returns the report\'s error', async () => {
    const { builder } = setup('error');
    const r = await builder.build({ draft: draftSpec(), knownIssues: kiBytes() });
    assert.equal(r.status, 'error');
    assert.equal(r.report.error.code, 'LISTING_CHECK_ABSTAINED');
    assert.equal(r.files, null);
  });

  test('a build that wrote no report is an error', async () => {
    const { builder } = setup('no-report');
    const r = await builder.build({ draft: draftSpec(), knownIssues: kiBytes() });
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'BUILDER_NO_REPORT');
  });

  test('a failed signing is an error that names the builder\'s reason', async () => {
    const { builder } = setup('sign-fails');
    const r = await builder.build({ draft: draftSpec(), knownIssues: kiBytes() });
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'SIGNING_FAILED');
    assert.match(r.error.detail, /SIGNING_KEY_NOT_TRUSTED/);
    assert.equal(r.files, null);
  });

  test('a builder that does not finish in time is stopped', async () => {
    const { builder } = setup('hang', { timeoutMs: 500 });
    const t0 = Date.now();
    const r = await builder.build({ draft: draftSpec(), knownIssues: kiBytes() });
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'BUILDER_TIMEOUT');
    assert.equal(r.holdSlot, undefined, 'it stopped on SIGTERM: the slot is free again');
    assert.ok(Date.now() - t0 < 10000);
  });

  test('a timeout stops everything the step started, and settles only once it has all gone (R1-F1)', async () => {
    const { builder, dir } = setup('hang-tree', { timeoutMs: 500, graceMs: 3000 });
    const r = await builder.build({ draft: draftSpec(), knownIssues: kiBytes() });
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'BUILDER_TIMEOUT');
    assert.equal(r.holdSlot, undefined, 'it stopped on SIGTERM: the slot is free again');
    // no waiting here: the result came only after the child (its own pipes, 400 ms to stop) exited
    const pid = Number(fs.readFileSync(path.join(dir, 'record.json.grandchild'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the child had exited before the step settled');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('sa-build-')), [], 'the build folder, with the builder\'s TMPDIR, is removed');
  });

  test('a step whose child ignores SIGTERM is killed and reported so its slot stays taken (R1-F1)', async () => {
    const { builder, dir } = setup('hang-stubborn', { timeoutMs: 300, graceMs: 500 });
    const r = await builder.build({ draft: draftSpec(), knownIssues: kiBytes() });
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'BUILDER_KILLED');
    assert.equal(r.holdSlot, true);
    const pid = Number(fs.readFileSync(path.join(dir, 'record.json.grandchild'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'SIGKILL reached the child that ignored SIGTERM');
  });

  test('a builder config that names its own workDir is refused: the server owns the temporary folder', async () => {
    const { builder, dir } = setup('accepted');
    const configPath = path.join(dir, 'builder.json');
    fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, 'utf8')), workDir: dir }));
    const r = await builder.build({ draft: draftSpec(), knownIssues: kiBytes() });
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'BUILDER_CONFIG_INVALID');
  });

  test('with no builder config the build is an error, not a crash', async () => {
    const builder = createCliBuilder({ bin: BIN, config: null, workDir: tmp, buildEnv: [], signEnv: [], timeoutMs: 1000 }, { env: {} });
    const r = await builder.build({ draft: draftSpec(), knownIssues: null });
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'BUILDER_NOT_CONFIGURED');
  });
});
