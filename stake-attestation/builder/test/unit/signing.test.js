// Acceptance 4: attestation.json is signed with an Ed25519 key from config. A dev key is generated
// per run and never leaves memory, a PEM in an environment variable is a dev or test key, and the
// production key is held by an external signer such as a KMS command, so it never enters the builder
// (node P14; test/unit/kmsSigning.test.js). The output passes validateAttestation in dev trust and
// fails it in production trust.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeReview } from '../../src/common.js';
import { attest, loadSigningKey } from '../../src/signing.js';
import { sha256 } from '../helpers/fakes.js';
import { acceptedListing, draftSpec } from '../helpers/specs.js';

const SIGNER = fileURLToPath(new URL('../helpers/signer.js', import.meta.url));
const IMAGE = `ghcr.io/verdikta/stake-env@sha256:${'c'.repeat(64)}`;

/** The outputs of an accepted build: the exact file bytes and the report the signer reads. */
function accepted({ devOnly = [], runner = { version: '0.1.0', runtime: 'runsc', platform: 'linux/amd64' } } = {}) {
  const listing = acceptedListing();
  const spec = { ...draftSpec(), env: { image: IMAGE, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 812000000 }, limits: listing.limits };
  const files = {
    codeReview: Buffer.from(`${JSON.stringify(spec, null, 2)}\n`),
    baseline: Buffer.from(`${JSON.stringify(listing.baseline, null, 2)}\n`),
    knownIssues: null,
  };
  const report = {
    status: 'accepted',
    image: { ref: IMAGE, base: codeReview.BASE_IMAGE_PINS.foundry.reference, platform: 'linux/amd64' },
    listingCheck: { runner },
    files: { 'code_review.json': sha256(files.codeReview), 'baseline.json': sha256(files.baseline), 'known_issues.json': null },
    devOnly,
  };
  return { files, report };
}

function pemPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
  };
}

test('a dev key is generated per run; the key object exposes no private material', () => {
  const a = loadSigningKey('dev');
  const b = loadSigningKey('dev');
  assert.equal(a.trust, 'dev');
  assert.notEqual(a.keyId, b.keyId, 'a fresh key every run');
  assert.equal(a.keyId, codeReview.builderKeyId(a.publicKey));
  const shown = JSON.stringify(a) + String(Object.keys(a));
  assert.ok(!/PRIVATE|privateKey|"d"/.test(shown), shown);
  assert.deepEqual(a.devTrust(), { dev: true, keys: [{ publicKey: a.publicKey }] });
});

test('the dev attestation passes validateAttestation in dev trust and fails it in production trust', async () => {
  const { files, report } = accepted();
  const key = loadSigningKey('dev');
  const { attestation, bytes } = await attest({ files, report, key });
  assert.deepEqual(JSON.parse(bytes), attestation);
  assert.equal(attestation.trust, 'dev');
  const dev = codeReview.validateAttestation(attestation, { files, trust: key.devTrust() });
  assert.equal(dev.ok, true, JSON.stringify(dev.issues));
  const prod = codeReview.validateAttestation(attestation, { files });
  assert.equal(prod.ok, false);
  assert.ok(prod.issues.some((i) => i.code === 'ATTESTATION_TRUST_MODE_MISMATCH'));
  assert.ok(prod.issues.some((i) => i.code === 'ATTESTATION_UNTRUSTED_KEY'));
});

test('the statement binds the image, platform, size, listing, file hashes, runner version and base', async () => {
  const { files, report } = accepted();
  const { attestation } = await attest({ files, report, key: loadSigningKey('dev') });
  const spec = JSON.parse(files.codeReview);
  assert.deepEqual(attestation.env, { image: IMAGE, from: 'foundry', base: codeReview.BASE_IMAGE_PINS.foundry.reference, platform: 'linux/amd64', unpackedBytes: 812000000 });
  assert.equal(attestation.repo, spec.repo);
  assert.equal(attestation.baseCommit, spec.baseCommit);
  assert.deepEqual(attestation.sha256, { codeReview: sha256(files.codeReview), baseline: sha256(files.baseline), knownIssues: null });
  assert.equal(attestation.tools.runner, '0.1.0');
  assert.equal(attestation.tools.gvisor, codeReview.GVISOR_RELEASE);
  assert.equal(attestation.tools.semgrepRules, codeReview.SEMGREP_RULES_VERSION);
});

test('an environment key is a dev or test key: read once, removed from the environment, and never shown', async () => {
  const { pem, publicKey } = pemPair();
  const env = { VERDIKTA_BUILDER_KEY: pem, OTHER: 'x' };
  const key = loadSigningKey({ env: 'VERDIKTA_BUILDER_KEY' }, { env });
  assert.equal(env.VERDIKTA_BUILDER_KEY, undefined, 'child processes cannot inherit it');
  assert.equal(env.OTHER, 'x');
  assert.equal(key.trust, 'dev');
  assert.equal(key.publicKey, publicKey);
  assert.deepEqual(key.devTrust(), { dev: true, keys: [{ publicKey }] });
  assert.ok(!JSON.stringify(key).includes('PRIVATE'));
  assert.throws(() => loadSigningKey({ env: 'MISSING_KEY' }, { env: {} }), /MISSING_KEY/);
  const bad = { BAD: '-----BEGIN PRIVATE KEY-----\nnot-a-key-at-all\n-----END PRIVATE KEY-----\n' };
  assert.throws(() => loadSigningKey({ env: 'BAD' }, { env: bad }), (err) => !err.message.includes('not-a-key-at-all'));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  assert.throws(() => loadSigningKey({ env: 'RSA' }, { env: { RSA: rsa } }), /Ed25519/);
});

test('a production key whose id is not in @verdikta/common\'s trusted-builder set signs nothing (production verification would refuse it)', async () => {
  const { publicKey } = pemPair();
  const key = loadSigningKey({ command: [process.execPath, SIGNER], publicKey });
  const { files, report } = accepted();
  await assert.rejects(attest({ files, report, key }), (err) => {
    assert.equal(err.code, 'SIGNING_KEY_NOT_TRUSTED');
    assert.ok(err.issues.some((i) => i.code === 'ATTESTATION_UNTRUSTED_KEY'));
    assert.ok(!err.message.includes('PRIVATE'));
    return true;
  });
});

test('an external signer (the KMS interface) signs the bytes on stdin; the builder holds only the public key', async () => {
  const { pem, publicKey } = pemPair();
  process.env.TEST_SIGNER_KEY = pem;
  try {
    const key = loadSigningKey({ command: [process.execPath, SIGNER], publicKey, env: ['TEST_SIGNER_KEY'] });
    assert.equal(key.trust, 'production');
    const statement = Buffer.from('verdikta-attestation/v1\n{"a":1}');
    const sig = await key.sign(statement);
    assert.equal(sig.length, 64);
    assert.ok(crypto.verify(null, statement, crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') }, format: 'jwk' }), sig));
    // A signer holding another key is caught before anything is written.
    const other = loadSigningKey({ command: [process.execPath, SIGNER], publicKey: pemPair().publicKey, env: ['TEST_SIGNER_KEY'] });
    await assert.rejects(other.sign(statement), { code: 'SIGNER_BAD_SIGNATURE' });
    // The signer gets only the variables it is configured with.
    const none = loadSigningKey({ command: [process.execPath, SIGNER], publicKey });
    await assert.rejects(none.sign(statement), { code: 'SIGNER_FAILED' });
  } finally {
    delete process.env.TEST_SIGNER_KEY;
  }
});

test('a production key never signs a validation that ran in dev-only conditions', async () => {
  const { publicKey } = pemPair();
  const key = loadSigningKey({ command: [process.execPath, SIGNER], publicKey });
  const { files, report } = accepted({ devOnly: [{ code: 'VALIDATED_ON_OTHER_PLATFORM', detail: 'linux/arm64' }] });
  await assert.rejects(attest({ files, report, key }), { code: 'SIGNING_DEV_ONLY_VALIDATION' });
  const runc = accepted({ runner: { version: '0.1.0', runtime: 'runc', platform: 'linux/amd64' } });
  await assert.rejects(attest({ ...runc, key }), { code: 'SIGNING_DEV_ONLY_VALIDATION' });
  // A dev key may: that is what dev trust is for.
  const dev = await attest({ files, report, key: loadSigningKey('dev') });
  assert.equal(dev.attestation.trust, 'dev');
});

test('nothing is signed unless the report accepted these exact files', async () => {
  const key = loadSigningKey('dev');
  const refused = accepted();
  refused.report.status = 'refused';
  await assert.rejects(attest({ ...refused, key }), { code: 'SIGNING_NOT_ACCEPTED' });
  const edited = accepted();
  edited.files.codeReview = Buffer.concat([edited.files.codeReview, Buffer.from(' ')]);
  await assert.rejects(attest({ ...edited, key }), { code: 'SIGNING_REPORT_MISMATCH' });
});

test('the signing key is configured as dev, an environment secret or a signer command, nothing else', () => {
  assert.throws(() => loadSigningKey({ file: '/etc/key.pem' }), /dev|env|command/);
  assert.throws(() => loadSigningKey({ command: 'kms-sign --key x', publicKey: pemPair().publicKey }), /argv/);
  assert.throws(() => loadSigningKey({ command: [path.join('/', 'bin', 'true')], publicKey: 'short' }), /public key/);
});
