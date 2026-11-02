// The server's adapter for the builder's baseline scan (`verdikta-build-env scan`, node P3b; the
// adapter is node P4b2): one process with only the variables named for the scan, the listing's
// spec in, scan-findings.json out of a new folder inside the build's owner-only folder, read once
// and the folder removed. What the scan prints is never logged or returned: its output may name
// findings, and only the maker may read them. Run against test/fixtures/fake-builder-cli.js; the
// real builder runs in the opt-in suite (npm run test:builder).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCAN_FILE, createCliBuilder } from '../src/builder/cli.js';
import { builtSpec, draftSpec } from './helpers/fixtures.js';
import { quietLogger } from './helpers/http.js';
import { canary } from './helpers/scan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, 'fixtures', 'fake-builder-cli.js');
const SECRET = 'sk_live_this-must-never-reach-the-builder';
let tmp;

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-server-scan-cli-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setup(scanMode = 'ok', over = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, `${scanMode}-`));
  const configPath = path.join(dir, 'builder.json');
  const recordPath = path.join(dir, 'record.json');
  const mark = canary();
  fs.writeFileSync(configPath, JSON.stringify({ mode: 'accepted', scanMode, mark, record: recordPath }));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    ETHERSCAN_API_KEY: 'explorer-key-for-build',
    VERDIKTA_BUILDER_KEY: 'signing-key-for-sign',
    OPENROUTER_API_KEY: 'agent-key-for-scan',
    SA_PINATA_JWT: SECRET,
  };
  const logger = quietLogger();
  const builder = createCliBuilder({
    bin: BIN,
    config: configPath,
    workDir: dir,
    buildEnv: ['DOCKER_HOST', 'ETHERSCAN_API_KEY'],
    signEnv: ['VERDIKTA_BUILDER_KEY'],
    scanEnv: ['DOCKER_HOST', 'OPENROUTER_API_KEY'],
    scanAgent: false,
    timeoutMs: 20000,
    graceMs: 1000,
    ...over,
  }, { env, logger });
  const calls = () => (fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : []);
  return { builder, calls, dir, mark, logger };
}

const spec = () => builtSpec(draftSpec());
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('sa-scan-'));
const own = (env) => Object.keys(env).filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(k)).sort();

describe('createCliBuilder().scan', () => {
  test('runs `scan --config --spec --out` on the spec it is given and returns the builder\'s document', async () => {
    const { builder, calls, dir, mark } = setup('ok');
    const s = spec();
    const r = await builder.scan({ spec: s });
    assert.equal(r.status, 'ok');
    assert.equal(r.error, null);
    assert.equal(r.doc.kind, 'verdikta-baseline-scan');
    assert.ok(JSON.stringify(r.doc).includes(mark));
    const [call] = calls();
    assert.equal(call.command, 'scan');
    assert.deepEqual(call.argv.filter((a) => a.startsWith('--')), ['--config', '--spec', '--out']);
    assert.deepEqual(call.spec, s);
    assert.equal(call.outExisted, false, 'a new folder: the builder refuses one that holds anything');
    assert.equal(call.outParentMode, 0o700, 'inside a folder only the server\'s user can open');
    assert.equal(SCAN_FILE, 'scan-findings.json');
    assert.deepEqual(leftovers(dir), [], 'the findings are not left on disk');
  });

  test('gets PATH, HOME, TMPDIR and the scan\'s own variables only: never the signing key or a pinning credential', async () => {
    const { builder, calls } = setup('ok');
    await builder.scan({ spec: spec() });
    const [call] = calls();
    assert.deepEqual(own(call.env), ['DOCKER_HOST', 'HOME', 'OPENROUTER_API_KEY', 'PATH', 'TMPDIR']);
    assert.equal(JSON.stringify(call).includes(SECRET), false);
    assert.equal(call.env.VERDIKTA_BUILDER_KEY, undefined);
  });

  test('the agent pass is asked for only when configured', async () => {
    const off = setup('ok');
    await off.builder.scan({ spec: spec() });
    assert.equal(off.calls()[0].argv.includes('--agent'), false);
    const on = setup('ok', { scanAgent: true });
    await on.builder.scan({ spec: spec() });
    assert.equal(on.calls()[0].argv.at(-1), '--agent');
  });

  test('a scan that failed (exit 1) returns its document, which says why', async () => {
    const { builder, dir } = setup('error');
    const r = await builder.scan({ spec: spec() });
    assert.equal(r.status, 'error');
    assert.equal(r.doc.status, 'error');
    assert.equal(r.doc.error.code, 'SCAN_TOOL_FAILED');
    assert.equal(r.error, null);
    assert.deepEqual(leftovers(dir), []);
  });

  for (const [mode, code] of [['no-output', 'SCAN_STEP_FAILED'], ['garbage', 'SCAN_OUTPUT_INVALID'], ['not-a-scan', 'SCAN_OUTPUT_INVALID'], ['too-large', 'SCAN_OUTPUT_TOO_LARGE']]) {
    test(`${mode}: an error with no document, and nothing of what the step wrote or printed in the result or the log`, async () => {
      const { builder, dir, mark, logger } = setup(mode);
      const r = await builder.scan({ spec: spec() });
      assert.equal(r.status, 'error');
      assert.equal(r.doc, null);
      assert.equal(r.error.code, code);
      assert.equal(JSON.stringify(r).includes(mark), false, JSON.stringify(r.error));
      for (const line of logger.lines) assert.equal(line.includes(mark), false, line);
      assert.deepEqual(leftovers(dir), []);
    });
  }

  test('the builder\'s code, never its text, names a failed step', async () => {
    const { builder } = setup('no-output');
    const r = await builder.scan({ spec: spec() });
    assert.match(r.error.detail, /exited 1: SCAN_OUT_NOT_EMPTY$/);
  });

  test('what the scan prints is neither returned nor logged, even when it names a finding', async () => {
    const { builder, mark, logger } = setup('chatty');
    const r = await builder.scan({ spec: spec() });
    assert.equal(r.status, 'ok');
    const { doc, ...rest } = r;
    assert.ok(JSON.stringify(doc).includes(mark));
    assert.equal(JSON.stringify(rest).includes(mark), false);
    for (const line of logger.lines) assert.equal(line.includes(mark), false, line);
  });

  test('a scan that does not finish in time is stopped and keeps its slot', async () => {
    const { builder, dir } = setup('hang', { timeoutMs: 500 });
    const r = await builder.scan({ spec: spec() });
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'BUILDER_TIMEOUT');
    assert.equal(r.holdSlot, true);
    assert.equal(r.doc, null);
    assert.deepEqual(leftovers(dir), []);
  });

  test('with no builder config the scan is an error, not a crash', async () => {
    const builder = createCliBuilder({ bin: BIN, config: null, workDir: tmp, buildEnv: [], signEnv: [], scanEnv: [], timeoutMs: 1000 }, { env: {} });
    const r = await builder.scan({ spec: spec() });
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'BUILDER_NOT_CONFIGURED');
  });
});
