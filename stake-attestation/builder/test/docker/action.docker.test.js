// The reusable workflow's build job, as far as a machine with no GitHub can run it: builder/action/services.js
// starts registry:2 and the code-runner at the pin as the workflow does, on a host where the Semgrep image a claim needs
// may be absent (this file runs first on CI's fresh runner), and the real builder CLI builds against them. A
// shell-prefixed command is refused by the pinned runner before the maker's setup; a plain listing is accepted.
//
// services.js puts the registry on the host network, and only on Linux is that this machine's: Docker Desktop's
// is the VM's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeReview } from '../../src/common.js';
import { REPORT_FILE } from '../../src/report.js';
import { MAKER } from '../helpers/proof.js';
import { PIN, fixtureDraft, fixtureRepo, newId } from './helpers.js';

const BUILDER = fileURLToPath(new URL('../../', import.meta.url));
const skip = process.platform === 'linux' ? false : 'the workflow\'s registry is on the host network, which only on Linux is this machine\'s';
const id = newId();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
const work = path.join(dir, 'vab');
const recipient = codeReview.generateDisclosureKeyPair().recipient;
const PUBLISH_AS = 'ghcr.io/verdikta/stake-env-action-test';
const started = () => fs.existsSync(path.join(work, 'services.json'));
let repo;

function node(args, { input } = {}) {
  return spawnSync(process.execPath, args, { cwd: BUILDER, encoding: 'utf8', timeout: 1200000, input, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
}

function writeDraft(name, over = {}) {
  const draft = fixtureDraft(repo.baseCommit, recipient, over);
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(draft));
  return file;
}

/** The generated config, with this test's repository as a mirror, since nothing here is on github.com. */
function configWithMirror() {
  const file = path.join(work, 'builder.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.repoMirrors = { 'https://github.com/verdikta-test/vault-fixture': repo.mirror };
  fs.writeFileSync(file, JSON.stringify(raw));
  return file;
}

test.after(() => {
  if (started()) node(['action/services.js', 'stop', '--dir', work]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('services.js starts the runner at the pin, whether or not this host has the Semgrep image a claim needs', { skip, timeout: 1500000 }, () => {
  repo = fixtureRepo(dir, { '.verdikta/stake-control.json': `${JSON.stringify({ version: 1, maker: MAKER })}\n` });
  const r = node(['action/services.js', 'start', '--dir', work, '--publish-as', PUBLISH_AS, '--spec', writeDraft('plain'), '--runtime', 'runc', '--signing', 'dev']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(PIN.commit.slice(0, 12)));
  const head = spawnSync('git', ['-C', path.join(work, 'verdikta-arbiter'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(head, PIN.commit, 'the commit the pins name');
});

test('a shell-prefixed command is refused by the pinned runner, by its code, before the maker\'s setup runs', { skip, timeout: 600000 }, () => {
  const out = path.join(dir, 'out-refused');
  const spec = writeDraft('shell', { commands: { ...fixtureDraft(repo.baseCommit, recipient).commands, build: 'true; forge build', setup: 'touch /tmp/the-setup-ran; forge build' } });
  const r = node(['bin/verdikta-build-env.js', 'build', '--config', configWithMirror(), '--spec', spec, '--maker', MAKER, '--out', out]);
  assert.notEqual(r.status, 0, r.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(out, REPORT_FILE), 'utf8'));
  assert.equal(report.status, 'refused');
  assert.deepEqual(report.refusals.map((x) => [x.code, x.step]), [['COMMAND_NOT_ALLOWED', 'spec']]);
  assert.deepEqual(report.steps.map((s) => s.name), ['spec'], 'nothing else ran: no fetch, no build');
  assert.equal(report.image, null);
});

test('a plain listing is accepted on the same stack, and names the repository the publish job copies it to', { skip, timeout: 1500000 }, () => {
  const out = path.join(dir, 'out-accepted');
  const r = node(['bin/verdikta-build-env.js', 'build', '--config', configWithMirror(), '--spec', writeDraft('plain'), '--maker', MAKER, '--out', out]);
  const report = JSON.parse(fs.readFileSync(path.join(out, REPORT_FILE), 'utf8'));
  assert.equal(r.status, 0, JSON.stringify({ refusals: report.refusals, error: report.error, stderr: r.stderr.slice(-800) }));
  assert.equal(report.status, 'accepted');
  assert.deepEqual(report.commands, { checkedBy: 'runner', canary: 'COMMAND_NOT_ALLOWED', issues: [] });
  const spec = JSON.parse(fs.readFileSync(path.join(out, 'code_review.json'), 'utf8'));
  assert.ok(spec.env.image.startsWith(`${PUBLISH_AS}@sha256:`), spec.env.image);
  assert.deepEqual(report.listingCheck.runner.runtime, 'runc');
  assert.ok(Array.isArray(report.listingCheck.compilers?.checked), 'the runner read the compilers');
});
