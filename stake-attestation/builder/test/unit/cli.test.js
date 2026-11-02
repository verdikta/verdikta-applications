// The verdikta-build-env command: `build` (no secret in its environment), `sign` (the separate
// signing step), `run` (both, with a dev key only). Acceptance 4 (key handling) and 5 (the
// report is written for the maker).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { codeReview } from '../../src/common.js';
import { main } from '../../src/cli.js';
import { sha256 } from '../helpers/fakes.js';
import { acceptedListing, draftSpec } from '../helpers/specs.js';

const BIN = fileURLToPath(new URL('../../bin/verdikta-build-env.js', import.meta.url));
const IMAGE = `ghcr.io/verdikta/stake-env@sha256:${'c'.repeat(64)}`;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vab-cli-'));
}

function io() {
  let out = '';
  let err = '';
  return { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, get out() { return out; }, get err() { return err; } };
}

/** A builder config file. */
function configFile(dir, key = 'dev') {
  const file = path.join(dir, 'builder.json');
  fs.writeFileSync(file, JSON.stringify({ registry: { repository: 'ghcr.io/verdikta/stake-env' }, runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' }, signing: { key } }));
  return file;
}

/** An out directory as `build` leaves it after an accepted validation. */
function acceptedDir(dir) {
  const listing = acceptedListing();
  const spec = { ...draftSpec(), env: { image: IMAGE, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 812000000 }, limits: listing.limits };
  const cr = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
  const bl = Buffer.from(`${JSON.stringify(listing.baseline, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'code_review.json'), cr);
  fs.writeFileSync(path.join(dir, 'baseline.json'), bl);
  const report = {
    version: 1, kind: 'verdikta-listing-validation', status: 'accepted',
    image: { ref: IMAGE, base: codeReview.BASE_IMAGE_PINS.foundry.reference, platform: 'linux/amd64' },
    listingCheck: { runner: { version: '0.1.0', runtime: 'runsc', platform: 'linux/amd64' } },
    files: { 'code_review.json': sha256(cr), 'baseline.json': sha256(bl), 'known_issues.json': null },
    devOnly: [], attestation: null, refusals: [], warnings: [], steps: [],
  };
  fs.writeFileSync(path.join(dir, 'validation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { cr, bl };
}

/** Every file under `dir`, as text. */
function allText(dir) {
  return fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'latin1')).join('\n');
}

test('the package exposes verdikta-build-env; --help and --version', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.bin, { 'verdikta-build-env': 'bin/verdikta-build-env.js' });
  const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  for (const cmd of ['build', 'sign', 'run']) assert.match(help.stdout, new RegExp(`^  ${cmd}\\s`, 'm'));
  const version = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(version.stdout.trim(), manifest.version);
  assert.equal(spawnSync(process.execPath, [BIN, 'nope'], { encoding: 'utf8' }).status, 64);
});

test('sign with a dev key: attestation.json and the dev trust set; the report records the signature', async () => {
  const dir = tmp();
  const { cr, bl } = acceptedDir(dir);
  const t = io();
  const code = await main(['sign', '--config', configFile(dir), '--dir', dir], { env: {}, ...t });
  assert.equal(code, 0, t.err);
  const attestation = JSON.parse(fs.readFileSync(path.join(dir, 'attestation.json')));
  const trust = JSON.parse(fs.readFileSync(path.join(dir, 'dev-trust.json')));
  assert.equal(codeReview.validateAttestation(attestation, { files: { codeReview: cr, baseline: bl }, trust }).ok, true);
  assert.equal(codeReview.validateAttestation(attestation, { files: { codeReview: cr, baseline: bl } }).ok, false);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'validation-report.json')));
  assert.deepEqual(report.attestation, { trust: 'dev', keyId: attestation.signature.keyId, issuedAt: attestation.issuedAt, file: 'attestation.json', sha256: sha256(fs.readFileSync(path.join(dir, 'attestation.json'))) });
  // No private key reached the disk or the log.
  const everything = `${allText(dir)}\n${t.out}\n${t.err}`;
  assert.ok(!/PRIVATE KEY|"d":/.test(everything));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sign with a production key from the environment: nothing is written while the key is not in common\'s set, and the key is never shown', async () => {
  const dir = tmp();
  acceptedDir(dir);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const body = pem.split('\n').slice(1, -2).join('');
  const env = { VERDIKTA_BUILDER_KEY: pem };
  const t = io();
  const code = await main(['sign', '--config', configFile(dir, { env: 'VERDIKTA_BUILDER_KEY' }), '--dir', dir], { env, ...t });
  assert.equal(code, 1);
  assert.match(t.err, /SIGNING_KEY_NOT_TRUSTED/);
  assert.equal(fs.existsSync(path.join(dir, 'attestation.json')), false);
  assert.equal(env.VERDIKTA_BUILDER_KEY, undefined, 'read once and removed');
  const everything = `${allText(dir)}\n${t.out}\n${t.err}`;
  assert.ok(!everything.includes(body) && !everything.includes('PRIVATE KEY'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build refuses to start while the signing key is in its environment: the build job holds no secret', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(draftSpec()));
  const t = io();
  const code = await main(['build', '--config', configFile(dir, { env: 'VERDIKTA_BUILDER_KEY' }), '--spec', path.join(dir, 'draft.json'), '--out', path.join(dir, 'out')], { env: { VERDIKTA_BUILDER_KEY: 'x' }, ...t });
  assert.equal(code, 1);
  assert.match(t.err, /BUILD_ENV_HOLDS_SIGNING_KEY/);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run (build and sign in one process) takes a dev key only: a production key signs in its own step', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(draftSpec()));
  const t = io();
  const code = await main(['run', '--config', configFile(dir, { env: 'VERDIKTA_BUILDER_KEY' }), '--spec', path.join(dir, 'draft.json'), '--out', path.join(dir, 'out')], { env: {}, ...t });
  assert.equal(code, 1);
  assert.match(t.err, /RUN_NEEDS_DEV_KEY/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sign refuses an out directory whose report did not accept the listing', async () => {
  const dir = tmp();
  acceptedDir(dir);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'validation-report.json')));
  report.status = 'refused';
  fs.writeFileSync(path.join(dir, 'validation-report.json'), JSON.stringify(report));
  const t = io();
  assert.equal(await main(['sign', '--config', configFile(dir), '--dir', dir], { env: {}, ...t }), 1);
  assert.match(t.err, /SIGNING_NOT_ACCEPTED/);
  assert.equal(fs.existsSync(path.join(dir, 'attestation.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
