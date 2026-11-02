// Opt-in (npm run test:builder; needs `npm ci` in ../builder): the listing API with the real
// environment builder's command line, ../builder/bin/verdikta-build-env.js, instead of a
// stand-in. The draft is one the builder refuses at its first step (this release hosts Foundry
// only), so no Docker daemon, registry, explorer or code-runner is needed: what this proves is
// the contract between the two packages (arguments, exit status, the output folder and
// validation-report.json), with the builder's own report coming back through the API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCliBuilder } from '../../src/builder/cli.js';
import { draftSpec, listingRequest } from '../helpers/fixtures.js';
import { startApi } from '../helpers/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILDER = path.resolve(here, '..', '..', '..', 'builder');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-server-real-builder-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the real builder\'s refusal reaches the maker as its validation report, and nothing is pinned', async () => {
  assert.ok(fs.existsSync(path.join(BUILDER, 'node_modules', '@verdikta', 'common')), 'run npm ci in stake-attestation/builder first');
  const config = path.join(tmp, 'builder.json');
  fs.writeFileSync(config, JSON.stringify({
    registry: { repository: 'localhost:5000/stake-env' },
    runner: { url: 'http://127.0.0.1:9', tokenEnv: 'SA_TEST_RUNNER_TOKEN' },
    signing: { key: 'dev' },
  }));
  const builder = createCliBuilder({
    bin: path.join(BUILDER, 'bin', 'verdikta-build-env.js'),
    config,
    workDir: tmp,
    buildEnv: [],
    signEnv: [],
    timeoutMs: 60000,
  }, { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const s = await startApi({ builder });
  try {
    const spec = draftSpec();
    spec.commands = { ...spec.commands, framework: 'vitest' };
    const res = await s.post('/api/listings', listingRequest({ spec }));
    assert.equal(res.status, 202);
    const view = await s.settle((await res.json()).id, 60000);
    assert.equal(view.status, 'refused', JSON.stringify(view.error));
    const report = view.validationReport;
    assert.equal(report.kind, 'verdikta-listing-validation');
    assert.equal(report.status, 'refused');
    assert.deepEqual(report.steps.map((x) => [x.name, x.status]), [['spec', 'failed']]);
    assert.equal(report.refusals[0].code, 'SPEC_INVALID');
    assert.ok(report.refusals[0].issues.some((i) => i.code === 'FRAMEWORK_UNSUPPORTED'));
    assert.equal(view.archives, null);
    assert.equal(s.pinner.pins.length, 0);
  } finally {
    await s.close();
  }
});

// The baseline scan's contract between the packages (node P4b2): `verdikta-build-env scan` run by
// the server's adapter on a spec whose repository the builder cannot fetch (a mirror that does
// not exist), so no Docker or network is needed. The builder writes its error into
// scan-findings.json in the folder the server chose and exits 1; the server returns that document,
// which only the maker is served.
test('the real builder\'s scan writes the maker\'s document where the server reads it', async () => {
  assert.ok(fs.existsSync(path.join(BUILDER, 'node_modules', '@verdikta', 'common')), 'run npm ci in stake-attestation/builder first');
  const builderExports = await import(path.join(BUILDER, 'src', 'index.js'));
  const { SCAN_FILE } = await import('../../src/builder/cli.js');
  assert.equal(SCAN_FILE, builderExports.SCAN_FILE, 'the server reads the file the builder writes');

  const spec = draftSpec();
  const config = path.join(tmp, 'builder-scan.json');
  fs.writeFileSync(config, JSON.stringify({
    registry: { repository: 'localhost:5000/stake-env' },
    runner: { url: 'http://127.0.0.1:9', tokenEnv: 'SA_TEST_RUNNER_TOKEN' },
    signing: { key: 'dev' },
    repoMirrors: { [spec.repo]: path.join(tmp, 'no-such-mirror.git') },
  }));
  const builder = createCliBuilder({
    bin: path.join(BUILDER, 'bin', 'verdikta-build-env.js'),
    config,
    workDir: tmp,
    buildEnv: [],
    signEnv: [],
    scanEnv: [],
    scanAgent: false,
    timeoutMs: 60000,
  }, { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const r = await builder.scan({ spec });
  assert.equal(r.status, 'error');
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.equal(r.doc.kind, 'verdikta-baseline-scan');
  assert.equal(r.doc.audience, 'maker');
  assert.equal(r.doc.status, 'error');
  assert.equal(r.doc.error.code, 'REPO_FETCH_FAILED');
  assert.deepEqual(r.doc.findings, []);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('sa-scan-')), [], 'the scan folder is removed');
});
