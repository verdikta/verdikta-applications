// Signing attestation.json (design §8.2 step 5; build plan A6 and D4).
//
// The key is named in config (`signing.key`), one of:
//   "dev"                          a fresh Ed25519 key for this run, in memory only. Its attestations
//                                  say trust "dev" and verify only under validateAttestation's
//                                  explicit dev trust, with the public key from dev-trust.json.
//   { "env": "NAME" }              a dev or test key: a PKCS#8 PEM Ed25519 key in the environment variable
//                                  NAME. It signs with dev trust, so whatever its key, production
//                                  verification refuses what it signs (owner, Q47). It is read once and
//                                  removed from the environment, so no child process inherits it.
//   { "command": [argv...],        an external signer, the KMS interface and the only production route: the
//     "publicKey": "<base64>",       builder writes the bytes to sign on its stdin and reads the 64-byte
//     "env": ["NAME", ...] }         Ed25519 signature, base64, from its stdout. The private key never enters
//                                  the builder; the signer gets PATH, HOME and only the variables listed.
//                                  Every signature is checked against publicKey before it is used.
// A signer signs with trust "production" and only what production verification accepts: its key must be in
// @verdikta/common's trusted-builder set, which is checked before the signer is asked for anything, and the
// listing must have been validated under gVisor on linux/amd64. Nothing here writes a file: the caller
// writes the attestation, which holds a signature and a key id, never key material.
import crypto from 'node:crypto';

import { codeReview } from './common.js';
import { BuilderError } from './errors.js';
import { run, tail } from './proc.js';
import { assertStatementFits } from './requestSize.js';

const CLASS_PLATFORM = codeReview.CLASS_HARD_LIMITS.platform;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** The base64 of a public KeyObject's 32 raw bytes (only ever called on a public key). */
function rawPublicKey(publicKey) {
  if (publicKey.type !== 'public') throw new TypeError('only a public key is exported');
  return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
}

function publicKeyObject(base64) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(base64, 'base64').toString('base64url') }, format: 'jwk' });
}

function makeKey({ trust, publicKey, source, sign }) {
  const keyId = codeReview.builderKeyId(publicKey);
  return Object.freeze({
    trust,
    keyId,
    publicKey,
    source,
    sign,
    /** validateAttestation's trust option for this key: dev trust over it, or null (production). */
    devTrust: () => (trust === 'dev' ? { dev: true, keys: [{ publicKey }] } : null),
  });
}

/** The trust a config's `signing.key` signs with: production only through an external signer. */
export function signingTrust(spec) {
  return spec && typeof spec === 'object' && spec.command !== undefined ? 'production' : 'dev';
}

/**
 * Why @verdikta/common's production set wouldn't accept this key for a new signature, or null. An id is
 * derived from its key, so an id that isn't is refused too. `trusted` is a parameter for the callers that
 * must say this before common's verification runs; that verification reads only common's own set.
 * @param {{ keyId: string, publicKey: string }} key
 * @param {ReadonlyArray<{ keyId: string, publicKey: string, retiredAt?: string }>} [trusted]
 * @returns {string|null}
 */
export function productionKeyProblem({ keyId, publicKey }, trusted = codeReview.PRODUCTION_BUILDER_KEYS) {
  if (codeReview.builderKeyId(publicKey) !== keyId) return `the key id ${keyId} is not the SHA-256 of its public key`;
  const entry = trusted.find((k) => k.keyId === keyId && k.publicKey === publicKey);
  if (!entry) return `the key ${keyId} is not in @verdikta/common's production trusted-builder set, so arbiters would refuse what it signs`;
  if (entry.retiredAt && Date.parse(entry.retiredAt) <= Date.now()) return `the key ${keyId} was retired from @verdikta/common's production trusted-builder set at ${entry.retiredAt}`;
  return null;
}

/**
 * @param {'dev'|{ env: string }|{ command: string[], publicKey: string, env?: string[] }} spec - config `signing.key`
 * @param {{ env?: Record<string,string|undefined> }} [o] - where an `env` key is read from (and removed)
 */
export function loadSigningKey(spec, { env = process.env } = {}) {
  if (spec === 'dev') {
    const dev = codeReview.createDevBuilderKey();
    const { privateKey } = dev;
    return makeKey({ trust: 'dev', publicKey: dev.publicKey, source: 'dev (generated for this run)', sign: async (bytes) => crypto.sign(null, bytes, privateKey) });
  }
  if (spec && typeof spec === 'object' && typeof spec.env === 'string' && spec.command === undefined) {
    const name = spec.env;
    const pem = env[name];
    delete env[name];
    if (typeof pem !== 'string' || !pem.trim()) throw new BuilderError('SIGNING_KEY_UNAVAILABLE', `the environment variable ${name} holds no signing key`);
    let key;
    try {
      key = crypto.createPrivateKey({ key: pem, format: 'pem' });
    } catch {
      throw new BuilderError('SIGNING_KEY_INVALID', `the environment variable ${name} does not hold a PEM private key`);
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new BuilderError('SIGNING_KEY_INVALID', `the key in ${name} is not an Ed25519 key`);
    const publicKey = rawPublicKey(crypto.createPublicKey(key));
    return makeKey({ trust: 'dev', publicKey, source: `environment variable ${name}`, sign: async (bytes) => crypto.sign(null, bytes, key) });
  }
  if (spec && typeof spec === 'object' && spec.command !== undefined) {
    const argv = spec.command;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string' && a)) {
      throw new TypeError('signing.key.command must be the signer\'s argv, an array of strings');
    }
    let verifyKey;
    try {
      codeReview.builderKeyId(spec.publicKey);
      verifyKey = publicKeyObject(spec.publicKey);
    } catch {
      throw new TypeError('signing.key.publicKey must be the signer\'s Ed25519 public key, the base64 of its 32 raw bytes');
    }
    const passEnv = Array.isArray(spec.env) ? spec.env : [];
    const sign = async (bytes) => {
      const childEnv = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/' };
      for (const n of passEnv) if (typeof process.env[n] === 'string') childEnv[n] = process.env[n];
      const r = await run(argv[0], argv.slice(1), { env: childEnv, stdin: bytes, timeoutMs: 60000, maxBytes: 8192 });
      if (r.spawnError || r.timedOut || r.exitCode !== 0) {
        throw new BuilderError('SIGNER_FAILED', `the signer ${argv[0]} ${r.spawnError ? `could not start: ${r.spawnError}` : r.timedOut ? 'did not answer in 60 s' : `exited ${r.exitCode}: ${tail(r.stderr, 500).trim()}`}`);
      }
      const text = r.stdout.toString('utf8').trim();
      const sig = /^[A-Za-z0-9+/]{86}==$/.test(text) ? Buffer.from(text, 'base64') : null;
      if (!sig || sig.length !== 64 || !crypto.verify(null, bytes, verifyKey, sig)) {
        throw new BuilderError('SIGNER_BAD_SIGNATURE', `the signer ${argv[0]} did not return an Ed25519 signature that verifies under the configured public key`);
      }
      return sig;
    };
    return makeKey({ trust: 'production', publicKey: spec.publicKey, source: `signer ${argv[0]}`, sign });
  }
  throw new TypeError('signing.key must be "dev", { env } or { command, publicKey, env? }');
}

/** Why a validation is fit only for dev trust. */
function devOnlyReasons(report) {
  const reasons = Array.isArray(report.devOnly) ? [...report.devOnly] : [];
  const r = report.listingCheck?.runner;
  if (!reasons.some((x) => x.code === 'VALIDATED_WITHOUT_GVISOR') && r?.runtime !== 'runsc') {
    reasons.push({ code: 'VALIDATED_WITHOUT_GVISOR', detail: `the listing check ran under ${r?.runtime ?? 'an unknown runtime'}, not gVisor` });
  }
  if (!reasons.some((x) => x.code === 'VALIDATED_ON_OTHER_PLATFORM') && r?.platform !== CLASS_PLATFORM) {
    reasons.push({ code: 'VALIDATED_ON_OTHER_PLATFORM', detail: `the listing check ran ${r?.platform ?? 'an unknown platform'}, not ${CLASS_PLATFORM}` });
  }
  return reasons;
}

/**
 * Signs attestation.json for an accepted build.
 * @param {object} o
 * @param {{ codeReview: Buffer, baseline: Buffer, knownIssues: Buffer|null }} o.files - the exact bytes the build wrote
 * @param {object} o.report - its validation report
 * @param {object} o.key - loadSigningKey()
 * @param {string} [o.issuedAt]
 * @returns {Promise<{ attestation: object, bytes: Buffer, validation: object }>}
 * @throws {BuilderError} SIGNING_NOT_ACCEPTED, SIGNING_REPORT_MISMATCH, SIGNING_DEV_ONLY_VALIDATION,
 *   SIGNING_KEY_NOT_TRUSTED, ATTESTATION_SELF_CHECK_FAILED, SIGNER_*
 * @throws {Refusal} LISTING_REQUEST_TOO_LARGE, before the key is asked for anything
 */
export async function attest({ files, report, key, issuedAt }) {
  if (!report || report.status !== 'accepted') {
    throw new BuilderError('SIGNING_NOT_ACCEPTED', `the validation report's status is ${report?.status ?? 'missing'}: only an accepted listing is attested`, { step: 'sign' });
  }
  let spec;
  try {
    spec = JSON.parse(Buffer.from(files.codeReview).toString('utf8'));
  } catch {
    throw new BuilderError('SIGNING_REPORT_MISMATCH', 'code_review.json is not JSON', { step: 'sign' });
  }
  const names = { codeReview: 'code_review.json', baseline: spec.baseline, knownIssues: spec.stake?.knownIssues ?? null };
  for (const [role, name] of Object.entries(names)) {
    const actual = files[role] ? sha256(files[role]) : null;
    const expected = name ? report.files?.[name] ?? null : null;
    if (expected !== actual || (actual !== null && !name)) {
      throw new BuilderError('SIGNING_REPORT_MISMATCH', `${name || role} is not the file the validation accepted`, { step: 'sign' });
    }
  }
  if (key.trust === 'production') {
    const reasons = devOnlyReasons(report);
    if (reasons.length) {
      throw new BuilderError('SIGNING_DEV_ONLY_VALIDATION', `a production key signs only a listing validated under gVisor on ${CLASS_PLATFORM}: ${reasons.map((x) => x.code).join(', ')}`, { step: 'sign', issues: reasons });
    }
  }
  const runnerVersion = report.listingCheck?.runner?.version;
  const statement = codeReview.createAttestationStatement({
    files: { codeReview: files.codeReview, baseline: files.baseline, knownIssues: files.knownIssues ?? undefined },
    trust: key.trust,
    ...(issuedAt ? { issuedAt } : {}),
    tools: { runner: runnerVersion },
    base: report.image?.base,
  });
  assertStatementFits(files, statement);
  if (key.trust === 'production') {
    const problem = productionKeyProblem(key);
    if (problem) {
      throw new BuilderError('SIGNING_KEY_NOT_TRUSTED', `${problem}; the signer was not asked and nothing was written`, { step: 'sign', issues: [{ code: 'ATTESTATION_UNTRUSTED_KEY', detail: problem }] });
    }
  }
  const signature = await key.sign(codeReview.attestationSigningBytes(statement));
  const attestation = { ...statement, signature: { algorithm: 'Ed25519', keyId: key.keyId, value: Buffer.from(signature).toString('base64') } };
  const validation = codeReview.validateAttestation(attestation, {
    files: { codeReview: files.codeReview, baseline: files.baseline, knownIssues: files.knownIssues ?? undefined },
    trust: key.trust === 'dev' ? key.devTrust() : undefined,
  });
  if (!validation.ok) {
    const untrusted = key.trust === 'production' && validation.issues.some((i) => i.code === 'ATTESTATION_UNTRUSTED_KEY');
    throw new BuilderError(
      untrusted ? 'SIGNING_KEY_NOT_TRUSTED' : 'ATTESTATION_SELF_CHECK_FAILED',
      untrusted
        ? `the configured key ${key.keyId} is not in @verdikta/common's production trusted-builder set, so arbiters would refuse what it signs; nothing was written`
        : `the signed attestation does not verify: ${validation.issues.map((i) => i.code).join(', ')}`,
      { step: 'sign', issues: validation.issues },
    );
  }
  return { attestation, bytes: Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, 'utf8'), validation };
}
