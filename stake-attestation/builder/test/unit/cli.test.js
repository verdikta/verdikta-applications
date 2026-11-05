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
import { writeAcceptedBuild } from '../helpers/build.js';
import { MAKER, provenAnswer } from '../helpers/proof.js';
import { draftSpec } from '../helpers/specs.js';

const BIN = fileURLToPath(new URL('../../bin/verdikta-build-env.js', import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vab-cli-'));
}

function io() {
  let out = '';
  let err = '';
  return { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, get out() { return out; }, get err() { return err; } };
}

/** A builder config file, beside the test's folder: sign takes a folder of the listing's files only. */
function configFile(dir, key = 'dev') {
  const cdir = `${dir}-config`;
  fs.mkdirSync(cdir, { recursive: true });
  const file = path.join(cdir, 'builder.json');
  fs.writeFileSync(file, JSON.stringify({ registry: { repository: 'ghcr.io/verdikta/stake-env' }, runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' }, signing: { key } }));
  return file;
}

function cleanup(dir) {
  for (const d of [dir, `${dir}-config`]) fs.rmSync(d, { recursive: true, force: true });
}

/** An out directory as `build` leaves it after an accepted validation (the real pipeline, doubled tools). */
async function acceptedDir(dir) {
  const { cr, bl } = await writeAcceptedBuild(dir);
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
  const { cr, bl } = await acceptedDir(dir);
  const t = io();
  const code = await main(['sign', '--config', configFile(dir), '--dir', dir, '--maker', MAKER], { env: {}, ...t, deps: { checkRepositoryControl: provenAnswer() } });
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
  cleanup(dir);
});

test('sign with a PEM key from the environment: dev trust, the key read once and removed, and never shown', async () => {
  const dir = tmp();
  const { cr, bl } = await acceptedDir(dir);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const body = pem.split('\n').slice(1, -2).join('');
  const env = { VERDIKTA_BUILDER_KEY: pem };
  const t = io();
  const code = await main(['sign', '--config', configFile(dir, { env: 'VERDIKTA_BUILDER_KEY' }), '--dir', dir, '--maker', MAKER], { env, ...t, deps: { checkRepositoryControl: provenAnswer() } });
  assert.equal(code, 0, t.err);
  assert.equal(env.VERDIKTA_BUILDER_KEY, undefined, 'read once and removed');
  const attestation = JSON.parse(fs.readFileSync(path.join(dir, 'attestation.json')));
  assert.equal(attestation.trust, 'dev');
  assert.equal(codeReview.validateAttestation(attestation, { files: { codeReview: cr, baseline: bl } }).ok, false, 'production verification refuses it');
  const everything = `${allText(dir)}\n${t.out}\n${t.err}`;
  assert.ok(!everything.includes(body) && !everything.includes('PRIVATE KEY'));
  cleanup(dir);
});

test('sign with a production signer whose key is not in common\'s set: nothing is written, and the signer is never started', async () => {
  const dir = tmp();
  await acceptedDir(dir);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const asked = `${dir}-asked`;
  const t = io();
  const code = await main(['sign', '--config', configFile(dir, { command: ['/bin/sh', '-c', `touch "${asked}"`], publicKey: raw }), '--dir', dir, '--maker', MAKER], { env: {}, ...t, deps: { checkRepositoryControl: provenAnswer() } });
  assert.equal(code, 1);
  assert.match(t.err, /SIGNING_KEY_NOT_TRUSTED/);
  assert.equal(fs.existsSync(path.join(dir, 'attestation.json')), false);
  assert.equal(fs.existsSync(asked), false);
  cleanup(dir);
});

test('build refuses to start while the signing key is in its environment: the build job holds no secret', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(draftSpec()));
  const t = io();
  const code = await main(['build', '--config', configFile(dir, { env: 'VERDIKTA_BUILDER_KEY' }), '--spec', path.join(dir, 'draft.json'), '--out', path.join(dir, 'out')], { env: { VERDIKTA_BUILDER_KEY: 'x' }, ...t });
  assert.equal(code, 1);
  assert.match(t.err, /BUILD_ENV_HOLDS_SIGNING_KEY/);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  cleanup(dir);
});

test('run (build and sign in one process) takes a dev key only: a production key signs in its own step', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(draftSpec()));
  const t = io();
  const code = await main(['run', '--config', configFile(dir, { env: 'VERDIKTA_BUILDER_KEY' }), '--spec', path.join(dir, 'draft.json'), '--out', path.join(dir, 'out')], { env: {}, ...t });
  assert.equal(code, 1);
  assert.match(t.err, /RUN_NEEDS_DEV_KEY/);
  cleanup(dir);
});

test('sign never writes the attestation over another file of the listing', async () => {
  const dir = tmp();
  const { bl } = await acceptedDir(dir);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'code_review.json')));
  spec.attestation = 'baseline.json';
  fs.writeFileSync(path.join(dir, 'code_review.json'), `${JSON.stringify(spec, null, 2)}\n`);
  const t = io();
  assert.equal(await main(['sign', '--config', configFile(dir), '--dir', dir], { env: {}, ...t }), 1);
  assert.match(t.err, /OUTPUT_INVALID/);
  assert.ok(fs.readFileSync(path.join(dir, 'baseline.json')).equals(bl), 'the baseline is untouched');
  cleanup(dir);
});

test('sign refuses an out directory whose report did not accept the listing', async () => {
  const dir = tmp();
  await acceptedDir(dir);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'validation-report.json')));
  report.status = 'refused';
  fs.writeFileSync(path.join(dir, 'validation-report.json'), JSON.stringify(report));
  const t = io();
  assert.equal(await main(['sign', '--config', configFile(dir), '--dir', dir], { env: {}, ...t }), 1);
  assert.match(t.err, /SIGNING_NOT_ACCEPTED/);
  assert.equal(fs.existsSync(path.join(dir, 'attestation.json')), false);
  cleanup(dir);
});
