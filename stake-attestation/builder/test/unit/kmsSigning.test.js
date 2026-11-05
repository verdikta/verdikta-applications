// Node P14: the production builder key stays in a cloud KMS (owner, Q5 and Q47) and the workflow signs with
// it through the builder's { command, publicKey, env } route. Nothing here reaches a cloud: `aws` is a stub
// on PATH, the runner's token endpoint is a stub on loopback, and each test's key is made for it. What
// these tests can't show is the one thing only a real KMS can: docs/builder-kms-signing.md has the opt-in
// check for that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { attest, loadSigningKey, productionKeyProblem, signingTrust } from '../../src/signing.js';
import { ACTION_PINS, KMS_SIGNER_ENV, signConfig, signingMode } from '../../action/services.js';
import { KMS_RAW_MESSAGE_BYTES, kmsSignArgs } from '../../action/kms-sign.js';
import { liveCheck } from '../../action/kms-live-check.js';
import { ACCOUNT, KEY_ARN, ROLE_ARN, SIGNER, ed25519Pair, installAwsStub, oidcEndpoint, runSigner } from '../helpers/awsStub.js';
import { REPOSITORY, writeAcceptedBuild } from '../helpers/build.js';
import { MAKER } from '../helpers/proof.js';

const PIN = ACTION_PINS.builderKey;
const PUBLISH_AS = 'ghcr.io/verdikta/stake-env';
const CLI_IN_PROCESS = fileURLToPath(new URL('../helpers/signInProcess.js', import.meta.url));
const VERIFY_IN_PROCESS = fileURLToPath(new URL('../helpers/verifyInProcess.js', import.meta.url));
const TRUST_STUB = fileURLToPath(new URL('../helpers/trustStub.cjs', import.meta.url));
const SERVICES = fileURLToPath(new URL('../../action/services.js', import.meta.url));
const LIVE_CHECK = fileURLToPath(new URL('../../action/kms-live-check.js', import.meta.url));
// What this checkout's pinned @verdikta/common holds. A release holding the key isn't published yet, so
// today this is false; the tests below say what must be true on each side of moving the pin.
const COMMON_HOLDS_THE_KEY = productionKeyProblem(PIN) === null;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vab-kms-'));
const bytesOf = (hex) => Buffer.from(hex, 'hex');

/** The signer's whole environment in the job: what signConfig lists, and PATH and HOME, as the route gives it. */
function jobEnv(stub, oidc, over = {}) {
  return { PATH: stub.path, HOME: os.homedir(), VERDIKTA_KMS_KEY_ARN: KEY_ARN, VERDIKTA_KMS_ROLE_ARN: ROLE_ARN, GITHUB_RUN_ID: '4242', ...oidc.env, ...over };
}

async function withSigner(opts, fn) {
  const stub = installAwsStub(opts);
  const oidc = await oidcEndpoint(opts?.oidc);
  try {
    return await fn({ stub, oidc, env: jobEnv(stub, oidc) });
  } finally {
    stub.cleanup();
    await oidc.close();
  }
}

test('the pin is the owner\'s key: its id is the SHA-256 of its public key, and no cloud detail sits beside it', () => {
  assert.equal(PIN.publicKey, 'uz7rKoXvOR8ut8NOUO5qoZHwsunMCq5yKtNRgskqAHU=');
  assert.equal(PIN.keyId, 'c400af59dc75cf7cb0bc2430833d29047955ae99c18a1d007700588a84b45b13');
  assert.equal(codeReview.builderKeyId(PIN.publicKey), PIN.keyId);
  assert.deepEqual(Object.keys(PIN).sort(), ['keyId', 'publicKey']);
});

// Acceptance 1: plain Ed25519 over the message, through the command route.

test('the signer asks KMS for plain Ed25519 over the raw message, by the exact flags', () => {
  const args = kmsSignArgs({ keyArn: KEY_ARN, messageFile: '/tmp/m', region: 'us-east-1' });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.deepEqual(args.slice(0, 2), ['kms', 'sign']);
  assert.equal(flag('--message-type'), 'RAW');
  assert.equal(flag('--signing-algorithm'), 'ED25519_SHA_512');
  assert.equal(flag('--key-id'), KEY_ARN);
  assert.equal(flag('--message'), 'fileb:///tmp/m', 'fileb: the bytes as they are, never decoded as text or base64');
  assert.equal(flag('--output'), 'text');
  assert.equal(flag('--query'), 'Signature');
  assert.equal(flag('--region'), 'us-east-1');
});

test('the bytes KMS signs are the bytes on stdin, whatever they hold, and the answer verifies', async () => {
  const pair = ed25519Pair();
  await withSigner({ pem: pair.pem }, async ({ stub, env }) => {
    // the attestation's own shape, then what a text-mode path would lose: a trailing newline, CRLF, NUL, high bytes
    const message = Buffer.concat([Buffer.from('verdikta-attestation/v1\n{"a":1}\r\n'), Buffer.from([0, 0xff, 0xfe, 0x0a])]);
    const r = await runSigner(message, env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout.trim(), /^[A-Za-z0-9+/]{86}==$/);
    assert.ok(crypto.verify(null, message, pair.verifyKey, Buffer.from(r.stdout.trim(), 'base64')));
    const [call] = stub.calls();
    assert.deepEqual(bytesOf(call.message), message);
    assert.equal(stub.calls().length, 1);
  });
});

test('the 4,096-byte RAW cap: exactly the cap is signed; above it is refused clearly, with no call to AWS', async () => {
  assert.equal(KMS_RAW_MESSAGE_BYTES, 4096);
  await withSigner({}, async ({ stub, oidc, env }) => {
    const ok = await runSigner(Buffer.alloc(4096, 0x61), env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(stub.calls().length, 1);
    const requests = oidc.requests.length;
    const over = await runSigner(Buffer.alloc(4097, 0x61), env);
    assert.equal(over.code, 65);
    assert.match(over.stderr, /4097 bytes/);
    assert.match(over.stderr, /4096/);
    assert.equal(stub.calls().length, 1, 'aws was not asked');
    assert.equal(oidc.requests.length, requests, 'no token was minted either');
    const empty = await runSigner(Buffer.alloc(0), env);
    assert.equal(empty.code, 65, 'KMS takes at least one byte');
  });
});

// Acceptance 1 and 4: no key material, no long-lived credential.

test('the job authenticates by OIDC: a token for sts.amazonaws.com, in a private file AWS reads, gone afterwards', async () => {
  await withSigner({ oidc: { value: 'a.b.c' } }, async ({ stub, oidc, env }) => {
    const r = await runSigner(Buffer.from('m'), env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(oidc.requests.length, 1);
    const url = new URL(oidc.requests[0].url, 'http://x');
    assert.equal(url.searchParams.get('audience'), 'sts.amazonaws.com');
    assert.equal(url.searchParams.get('api-version'), '2.0', 'the runner\'s own query is kept');
    assert.equal(oidc.requests[0].authorization, `Bearer ${oidc.requestToken}`);
    const [call] = stub.calls();
    assert.equal(call.token, 'a.b.c');
    assert.equal(call.tokenMode, 0o600);
    assert.equal(call.env.AWS_ROLE_ARN, ROLE_ARN);
    assert.equal(call.env.AWS_REGION, 'us-east-1', 'read from the key\'s ARN');
    assert.match(call.env.AWS_ROLE_SESSION_NAME, /^verdikta-builder-sign-4242\b/);
    // Nothing stays: the token, the message and the CLI's credential cache all lived under one folder.
    assert.equal(fs.existsSync(call.env.AWS_WEB_IDENTITY_TOKEN_FILE), false);
    assert.equal(fs.existsSync(call.messageFile), false);
    assert.equal(fs.existsSync(call.env.HOME), false, 'the CLI\'s HOME, where it caches the session');
    assert.notEqual(call.env.HOME, os.homedir());
  });
});

test('aws gets a role to assume and nothing else: no ambient credential, no cloud reference, no runner token', async () => {
  const leaky = { AWS_ACCESS_KEY_ID: 'AKIASTUB', AWS_SECRET_ACCESS_KEY: 'stub-secret', AWS_SESSION_TOKEN: 'stub-session', AWS_PROFILE: 'admin', GITHUB_TOKEN: 'stub-gh', VERDIKTA_BUILDER_KEY: 'stub-pem' };
  await withSigner({}, async ({ stub, env }) => {
    const r = await runSigner(Buffer.from('m'), { ...env, ...leaky });
    assert.equal(r.code, 0, r.stderr);
    const seen = stub.calls()[0].env;
    for (const name of [...Object.keys(leaky), 'VERDIKTA_KMS_KEY_ARN', 'VERDIKTA_KMS_ROLE_ARN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL']) {
      assert.equal(seen[name], undefined, name);
    }
    assert.equal(seen.AWS_EC2_METADATA_DISABLED, 'true');
  });
});

test('no OIDC token (a fork\'s pull request, or a caller without id-token: write): the signer says so and never calls aws', async () => {
  await withSigner({}, async ({ stub, env }) => {
    const { ACTIONS_ID_TOKEN_REQUEST_URL: _u, ACTIONS_ID_TOKEN_REQUEST_TOKEN: _t, ...noToken } = env;
    const r = await runSigner(Buffer.from('m'), noToken);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /id-token: write/);
    assert.equal(stub.calls().length, 0);
  });
  await withSigner({ oidc: { status: 403 } }, async ({ stub, env }) => {
    const r = await runSigner(Buffer.from('m'), env);
    assert.notEqual(r.code, 0);
    assert.equal(stub.calls().length, 0);
  });
});

test('missing or malformed cloud references are refused without being repeated: an option cannot be smuggled in as a key', async () => {
  await withSigner({}, async ({ stub, env }) => {
    for (const [name, value] of [
      ['VERDIKTA_KMS_KEY_ARN', ''],
      ['VERDIKTA_KMS_KEY_ARN', `--debug-${ACCOUNT}`],
      ['VERDIKTA_KMS_KEY_ARN', `arn:aws:s3:::bucket-${ACCOUNT}`],
      ['VERDIKTA_KMS_ROLE_ARN', ''],
      ['VERDIKTA_KMS_ROLE_ARN', `arn:aws:iam::${ACCOUNT}:user/someone`],
    ]) {
      const r = await runSigner(Buffer.from('m'), { ...env, [name]: value });
      assert.equal(r.code, 78, `${name}=${value}`);
      assert.match(r.stderr, new RegExp(name));
      assert.ok(!r.stderr.includes(ACCOUNT), r.stderr);
    }
    assert.equal(stub.calls().length, 0);
  });
});

// Review focus: a key reference or account detail in the logs.

test('what AWS says is never passed on: its messages name the account and the key, so the log gets their class only', async () => {
  await withSigner({ mode: 'denied' }, async ({ env }) => {
    const r = await runSigner(Buffer.from('m'), env);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /AccessDenied/);
    assert.ok(!r.stderr.includes(ACCOUNT) && !r.stderr.includes('arn:'), r.stderr);
    assert.equal(r.stdout, '');
  });
  await withSigner({ mode: 'unknown-failure' }, async ({ env }) => {
    const r = await runSigner(Buffer.from('m'), env);
    assert.notEqual(r.code, 0);
    assert.ok(!r.stderr.includes(ACCOUNT) && !r.stderr.includes('arn:'), r.stderr);
  });
  await withSigner({ mode: 'not-a-signature' }, async ({ env }) => {
    const r = await runSigner(Buffer.from('m'), env);
    assert.notEqual(r.code, 0);
    assert.equal(r.stdout, '', 'an answer that is not a signature is not repeated');
    assert.ok(!r.stderr.includes(ACCOUNT), r.stderr);
  });
});

test('no aws on PATH is a plain refusal', async () => {
  const dir = tmp();
  const oidc = await oidcEndpoint();
  try {
    const r = await runSigner(Buffer.from('m'), { PATH: dir, HOME: dir, VERDIKTA_KMS_KEY_ARN: KEY_ARN, VERDIKTA_KMS_ROLE_ARN: ROLE_ARN, ...oidc.env });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /aws/);
  } finally {
    await oidc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Acceptance 2: production no longer takes the PEM.

test('signConfig: production names the KMS signer through the command route, and never VERDIKTA_BUILDER_KEY', () => {
  const raw = signConfig({ signing: 'production', publishAs: PUBLISH_AS, trustedKeys: [{ keyId: PIN.keyId, publicKey: PIN.publicKey }] });
  assert.deepEqual(raw.signing.key.command, [process.execPath, SIGNER]);
  assert.equal(raw.signing.key.publicKey, PIN.publicKey);
  assert.deepEqual(raw.signing.key.env, [...KMS_SIGNER_ENV]);
  assert.deepEqual([...KMS_SIGNER_ENV].sort(), ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'GITHUB_RUN_ID', 'VERDIKTA_KMS_KEY_ARN', 'VERDIKTA_KMS_ROLE_ARN']);
  assert.ok(!JSON.stringify(raw).includes('VERDIKTA_BUILDER_KEY'));
  const parsed = parseConfig(raw, { baseDir: '/', env: {} });
  assert.deepEqual(parsed.signing.key.command, [process.execPath, SIGNER]);
  assert.equal(loadSigningKey(parsed.signing.key, { env: {} }).trust, 'production');
  assert.deepEqual(signConfig({ signing: 'dev', publishAs: PUBLISH_AS }).signing, { key: 'dev' });
});

test('the signing mode is exact: GitHub\'s conditions ignore case, so Production would look like production to them and not to the build\'s checks', () => {
  assert.equal(signingMode('dev'), 'dev');
  assert.equal(signingMode('production'), 'production');
  for (const mode of ['Production', 'PRODUCTION', 'DEV', 'prod', '', undefined]) assert.throws(() => signingMode(mode), /exactly/, String(mode));
  // start refuses it first, before Docker, a checkout or anything else: no digest is ever handed on.
  const dir = tmp();
  try {
    const r = spawnSync(process.execPath, [SERVICES, 'start', '--dir', dir, '--publish-as', PUBLISH_AS, '--spec', path.join(dir, 'none.json'), '--signing', 'Production'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exactly dev or production/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a config holds names only: no key reference, account or token in sign.json', () => {
  const raw = JSON.stringify(signConfig({ signing: 'production', publishAs: PUBLISH_AS, trustedKeys: [{ keyId: PIN.keyId, publicKey: PIN.publicKey }] }));
  assert.ok(!/arn:aws|[0-9]{12}/.test(raw), raw);
});

test('the PEM route is for dev and test: it signs with dev trust, and production verification refuses that', async () => {
  const pair = ed25519Pair();
  const env = { K: pair.pem };
  const key = loadSigningKey({ env: 'K' }, { env });
  assert.equal(key.trust, 'dev');
  assert.equal(env.K, undefined, 'read once and removed');
  assert.deepEqual(key.devTrust(), { dev: true, keys: [{ publicKey: pair.publicKey }] });
  const dir = tmp();
  try {
    const { cr, bl, report } = await writeAcceptedBuild(dir);
    const { attestation } = await attest({ files: { codeReview: cr, baseline: bl, knownIssues: null }, report, key });
    assert.equal(attestation.trust, 'dev');
    const prod = codeReview.validateAttestation(attestation, { files: { codeReview: cr, baseline: bl } });
    assert.equal(prod.ok, false);
    assert.ok(prod.issues.some((i) => i.code === 'ATTESTATION_TRUST_MODE_MISMATCH'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Acceptance 3: the trusted set, then each signature.

test('productionKeyProblem: the id must be the key\'s, and the set must hold that key and not have retired it', () => {
  const pair = ed25519Pair();
  const keyId = codeReview.builderKeyId(pair.publicKey);
  const key = { keyId, publicKey: pair.publicKey };
  assert.equal(productionKeyProblem(key, [key]), null);
  assert.match(productionKeyProblem(key, []), /not in/);
  assert.match(productionKeyProblem({ keyId: 'f'.repeat(64), publicKey: pair.publicKey }, [key]), /SHA-256/);
  assert.match(productionKeyProblem(key, [{ keyId, publicKey: ed25519Pair().publicKey }]), /not in/);
  assert.match(productionKeyProblem(key, [{ ...key, retiredAt: '2020-01-01T00:00:00Z' }]), /retired/);
  assert.equal(productionKeyProblem(key, [{ ...key, retiredAt: '2999-01-01T00:00:00Z' }]), null);
});

test('this checkout\'s common: until it holds the key, production signing stops at sign-config, naming the cause', { skip: COMMON_HOLDS_THE_KEY }, () => {
  assert.throws(() => signConfig({ signing: 'production', publishAs: PUBLISH_AS }), /SIGNING_KEY_NOT_TRUSTED/);
});

test('this checkout\'s common: once it holds the key, sign-config writes the signer', { skip: !COMMON_HOLDS_THE_KEY }, () => {
  assert.equal(signConfig({ signing: 'production', publishAs: PUBLISH_AS }).signing.key.publicKey, PIN.publicKey);
});

test('a production key outside common\'s set is refused before the signer is asked for anything', async () => {
  const pair = ed25519Pair();
  const dir = tmp();
  try {
    const { cr, bl, report } = await writeAcceptedBuild(dir);
    const signerLog = path.join(dir, 'asked');
    const key = loadSigningKey({ command: ['/bin/sh', '-c', `touch "${signerLog}"`], publicKey: pair.publicKey });
    await assert.rejects(attest({ files: { codeReview: cr, baseline: bl, knownIssues: null }, report, key }), (err) => {
      assert.equal(err.code, 'SIGNING_KEY_NOT_TRUSTED');
      assert.ok(err.issues.some((i) => i.code === 'ATTESTATION_UNTRUSTED_KEY'));
      return true;
    });
    assert.equal(fs.existsSync(signerLog), false, 'the signer was never started');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The real `sign` command, in a process of its own, over the real signer and a stub `aws`. common's real
 * verification runs, with its set holding `trusted` (test/helpers/trustStub.cjs).
 */
async function signAll({ signerPublicKey, stubPem, mode, trusted }) {
  const stub = installAwsStub({ pem: stubPem, mode });
  const oidc = await oidcEndpoint();
  const dir = tmp();
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  await writeAcceptedBuild(out);
  const config = path.join(dir, 'sign.json');
  const base = signConfig({ signing: 'production', publishAs: REPOSITORY, trustedKeys: [{ keyId: PIN.keyId, publicKey: PIN.publicKey }] });
  fs.writeFileSync(config, JSON.stringify({ ...base, signing: { key: { ...base.signing.key, publicKey: signerPublicKey } } }));
  const env = { ...jobEnv(stub, oidc), STUB_TRUSTED_KEY: JSON.stringify({ keyId: codeReview.builderKeyId(trusted), publicKey: trusted }) };
  const r = await spawnAsync(process.execPath, ['--require', TRUST_STUB, CLI_IN_PROCESS, 'sign', '--config', config, '--dir', out, '--maker', MAKER], { env });
  const verify = spawnSync(process.execPath, ['--require', TRUST_STUB, VERIFY_IN_PROCESS, out], { env, encoding: 'utf8' });
  const text = fs.readdirSync(out).map((f) => fs.readFileSync(path.join(out, f), 'latin1')).join('\n');
  const result = { ...r, out, attested: fs.existsSync(path.join(out, 'attestation.json')), verify, everything: `${r.stdout}\n${r.stderr}\n${text}\n${fs.readFileSync(config, 'utf8')}`, calls: stub.calls() };
  stub.cleanup();
  await oidc.close();
  return { ...result, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function spawnAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...opts, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

test('end to end, with common\'s set stubbed: the bytes KMS signed are the attestation\'s, and common\'s production verification accepts the result', async () => {
  const pair = ed25519Pair();
  const r = await signAll({ signerPublicKey: pair.publicKey, stubPem: pair.pem, trusted: pair.publicKey });
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.attested, true);
    assert.match(r.stdout, /production trust/);
    assert.equal(r.calls.length, 1, 'one signature, one call');
    const attestation = JSON.parse(fs.readFileSync(path.join(r.out, 'attestation.json'), 'utf8'));
    assert.equal(attestation.trust, 'production');
    assert.equal(attestation.signature.keyId, codeReview.builderKeyId(pair.publicKey));
    assert.deepEqual(bytesOf(r.calls[0].message), codeReview.attestationSigningBytes(attestation), 'KMS was given exactly the bytes verification reads');
    assert.deepEqual(JSON.parse(r.verify.stdout), { ok: true, codes: [], trust: 'production', keyId: attestation.signature.keyId });
    assert.equal(fs.existsSync(path.join(r.out, 'dev-trust.json')), false);
    // The whole of what the job prints and uploads, and its config, holds no reference to the cloud.
    assert.ok(!r.everything.includes(ACCOUNT) && !r.everything.includes('arn:aws') && !r.everything.includes('stub-request-token'));
  } finally {
    r.cleanup();
  }
});

for (const [mode, why] of [
  ['trailing-newline-signed', 'a signature over other bytes'],
  ['prehash', 'a pre-hashed signature (ED25519_PH_SHA_512)'],
  ['other-key', 'a signature by another KMS key'],
]) {
  test(`end to end: ${why} stops at the check, and nothing is written`, async () => {
    const pair = ed25519Pair();
    const r = await signAll({ signerPublicKey: pair.publicKey, stubPem: pair.pem, mode, trusted: pair.publicKey });
    try {
      assert.equal(r.code, 1);
      assert.match(r.stderr, /SIGNER_BAD_SIGNATURE/);
      assert.equal(r.attested, false);
      assert.ok(!JSON.parse(fs.readFileSync(path.join(r.out, 'validation-report.json'), 'utf8')).attestation);
    } finally {
      r.cleanup();
    }
  });
}

test('end to end: the Verdikta key pinned, a KMS holding any other key (a maker\'s own, say): refused, nothing written', async () => {
  const r = await signAll({ signerPublicKey: PIN.publicKey, stubPem: ed25519Pair().pem, trusted: PIN.publicKey });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SIGNER_BAD_SIGNATURE/);
    assert.equal(r.attested, false);
  } finally {
    r.cleanup();
  }
});

test('end to end: a key its signer holds but common does not trust: the signer is never asked', async () => {
  const pair = ed25519Pair();
  const r = await signAll({ signerPublicKey: pair.publicKey, stubPem: pair.pem, trusted: ed25519Pair().publicKey });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SIGNING_KEY_NOT_TRUSTED/);
    assert.equal(r.calls.length, 0);
    assert.equal(r.attested, false);
  } finally {
    r.cleanup();
  }
});

test('end to end: AWS\'s refusal reaches the log as its class only', async () => {
  const pair = ed25519Pair();
  const r = await signAll({ signerPublicKey: pair.publicKey, stubPem: pair.pem, mode: 'denied', trusted: pair.publicKey });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SIGNER_FAILED/);
    assert.match(r.stderr, /AccessDenied/);
    assert.ok(!r.everything.includes(ACCOUNT) && !r.everything.includes('arn:aws'), r.everything);
    assert.equal(r.attested, false);
  } finally {
    r.cleanup();
  }
});

test('end to end: the PEM route can\'t reach production even with its key in the set: it says dev, and production verification refuses', async () => {
  const pair = ed25519Pair();
  const dir = tmp();
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  try {
    await writeAcceptedBuild(out);
    const config = path.join(dir, 'sign.json');
    fs.writeFileSync(config, JSON.stringify({ registry: { repository: REPOSITORY }, runner: { url: 'http://127.0.0.1:9', tokenEnv: 'UNUSED_RUNNER_TOKEN' }, signing: { key: { env: 'VERDIKTA_BUILDER_KEY' } } }));
    const env = { PATH: process.env.PATH, HOME: os.homedir(), VERDIKTA_BUILDER_KEY: pair.pem, STUB_TRUSTED_KEY: JSON.stringify({ keyId: codeReview.builderKeyId(pair.publicKey), publicKey: pair.publicKey }) };
    const r = await spawnAsync(process.execPath, ['--require', TRUST_STUB, CLI_IN_PROCESS, 'sign', '--config', config, '--dir', out, '--maker', MAKER], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /dev trust/);
    const verify = JSON.parse(spawnSync(process.execPath, ['--require', TRUST_STUB, VERIFY_IN_PROCESS, out], { env, encoding: 'utf8' }).stdout);
    assert.equal(verify.ok, false);
    assert.equal(verify.trust, 'dev');
    assert.ok(verify.codes.includes('ATTESTATION_TRUST_MODE_MISMATCH'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a listing\'s build measures the statement with the trust its key will sign with: the PEM route counts as dev', () => {
  assert.equal(signingTrust('dev'), 'dev');
  assert.equal(signingTrust({ env: 'K' }), 'dev');
  assert.equal(signingTrust({ command: ['x'], publicKey: 'y', env: [] }), 'production');
});

// Acceptance 5: the live check is opt-in, and CI never opts in.

test('the live check does nothing without its explicit opt-in', () => {
  const stub = installAwsStub();
  try {
    const r = spawnSync(process.execPath, [LIVE_CHECK], { env: { PATH: stub.path, HOME: os.homedir(), VERDIKTA_KMS_KEY_ARN: KEY_ARN }, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /VERDIKTA_KMS_LIVE_CHECK=1/);
    assert.equal(stub.calls().length, 0);
  } finally {
    stub.cleanup();
  }
});

test('the live check, against the stub: a signature by the pinned key passes; any other key fails; no cloud detail is printed; it signs no attestation', async () => {
  const pair = ed25519Pair();
  const pin = { publicKey: pair.publicKey, keyId: codeReview.builderKeyId(pair.publicKey) };
  const stub = installAwsStub({ pem: pair.pem });
  const lines = [];
  const save = process.env.PATH;
  process.env.PATH = stub.path;
  try {
    const ok = await liveCheck({ keyArn: KEY_ARN, pin, trusted: [pin], out: (l) => lines.push(l) });
    assert.equal(ok, true, lines.join('\n'));
    const signed = bytesOf(stub.calls()[0].message).toString('utf8');
    assert.match(signed, /^verdikta-kms-live-check\/v1\n/);
    assert.ok(!signed.startsWith(codeReview.ATTESTATION_SIGNING_CONTEXT), 'its signature can never pass for an attestation\'s');
    assert.ok(!lines.join('\n').includes(ACCOUNT) && !lines.join('\n').includes('arn:'), lines.join('\n'));
    const notice = [];
    assert.equal(await liveCheck({ keyArn: KEY_ARN, pin, trusted: [], out: (l) => notice.push(l) }), true, 'the signature is what it checks');
    assert.match(notice.join('\n'), /not in/, 'and it says the set doesn\'t hold the key yet');
    const other = { publicKey: ed25519Pair().publicKey };
    other.keyId = codeReview.builderKeyId(other.publicKey);
    const bad = [];
    assert.equal(await liveCheck({ keyArn: KEY_ARN, pin: other, trusted: [other], out: (l) => bad.push(l) }), false);
    assert.match(bad.join('\n'), /does not verify/);
  } finally {
    process.env.PATH = save;
    stub.cleanup();
  }
});
