// Building, pushing and measuring the env image (design §8.2 steps 1 and 4).
//
// The build is `docker build` of the context src/dockerfile.js writes: no build argument, no
// secret, no SSH agent, the daemon's default network (the setup stage needs it; the final stage
// runs nothing). The image is pushed by tag and from then on named by the digest the registry
// stored. Its size is measured the way the code-runner measures it (the layer sizes the daemon
// lists, unpacked) and from the registry (the compressed bytes an arbiter pulls), and held to the
// class's limits: 2 GB compressed, 6 GB unpacked.
import path from 'node:path';

import { codeReview } from './common.js';
import { BuilderError, Refusal } from './errors.js';
import { tail } from './proc.js';

const CLASS = codeReview.CLASS_HARD_LIMITS;
const LIMIT_KEYS = Object.freeze(['imageCompressedBytes', 'imageUnpackedBytes']);
const UNREACHABLE = /Cannot connect to the Docker daemon|error during connect|docker daemon is not running|Is the docker daemon running/i;

/**
 * The image size limits: the class's, or lower ones from config (never higher).
 * @param {object} [override]
 */
export function imageLimits(override) {
  const out = { imageCompressedBytes: CLASS.imageCompressedBytes, imageUnpackedBytes: CLASS.imageUnpackedBytes };
  if (override === undefined || override === null) return Object.freeze(out);
  if (typeof override !== 'object' || Array.isArray(override)) throw new TypeError('limits must be an object');
  for (const [k, v] of Object.entries(override)) {
    if (!LIMIT_KEYS.includes(k)) throw new TypeError(`limits has an unknown key "${k}" (only ${LIMIT_KEYS.join(', ')})`);
    if (!Number.isSafeInteger(v) || v < 1) throw new TypeError(`limits.${k} must be a positive integer`);
    if (v > CLASS[k]) throw new TypeError(`limits.${k} may only lower the class's ${CLASS[k]}`);
    out[k] = v;
  }
  return Object.freeze(out);
}

/** The size refusals for what has been measured so far (compressed is known only after the push). */
export function imageSizeIssues({ compressedBytes, unpackedBytes }, limits = imageLimits()) {
  const issues = [];
  if (unpackedBytes !== undefined && unpackedBytes > limits.imageUnpackedBytes) {
    issues.push({ code: 'IMAGE_UNPACKED_TOO_LARGE', detail: `the env image is ${unpackedBytes} bytes unpacked; the limit is ${limits.imageUnpackedBytes} (arbiters must hold it on their runner's disk)` });
  }
  if (compressedBytes !== undefined && compressedBytes > limits.imageCompressedBytes) {
    issues.push({ code: 'IMAGE_COMPRESSED_TOO_LARGE', detail: `the env image is ${compressedBytes} bytes compressed; the limit is ${limits.imageCompressedBytes} (arbiters must pull it inside their time budget)` });
  }
  return issues;
}

function daemonDown(r) {
  return Boolean(r.spawnError) || UNREACHABLE.test(r.stderr.toString('utf8'));
}

/**
 * Builds the context into `tag`, for `platforms` (the class's linux/amd64 first).
 * @throws {Refusal} IMAGE_BUILD_FAILED, IMAGE_BUILD_TIMEOUT (the maker's setup), with the log's end
 * @throws {BuilderError} DOCKER_UNAVAILABLE
 */
export async function buildImage({ docker, contextDir, tag, platforms, timeoutMs }) {
  const args = (attest) => [
    'build',
    '--file', path.join(contextDir, 'Dockerfile'),
    '--platform', platforms.join(','),
    ...(attest ? ['--provenance=false', '--sbom=false'] : []),
    '--progress=plain',
    '--tag', tag,
    contextDir,
  ];
  let r = await docker.run(args(true), { timeoutMs });
  // The legacy builder has no attestation flags (and makes no attestation manifests anyway).
  if (r.exitCode !== 0 && /unknown flag: --(provenance|sbom)/.test(r.stderr.toString('utf8'))) r = await docker.run(args(false), { timeoutMs });
  if (daemonDown(r)) throw new BuilderError('DOCKER_UNAVAILABLE', r.spawnError || tail(r.stderr, 2000), { step: 'build' });
  const log = tail(Buffer.concat([r.stdout, r.stderr]));
  if (r.timedOut) throw new Refusal('IMAGE_BUILD_TIMEOUT', `the image build (the checkout and the maker's setup) did not finish in ${Math.round(timeoutMs / 1000)} s`, { step: 'build', log });
  if (r.exitCode !== 0) throw new Refusal('IMAGE_BUILD_FAILED', 'the image build failed: the listed commit could not be checked out, or the maker\'s setup failed (see the log)', { step: 'build', log });
  return { log };
}

/**
 * Pushes `tag`; returns the digest the registry stored.
 * @throws {BuilderError} IMAGE_PUSH_FAILED, DOCKER_UNAVAILABLE
 */
export async function pushImage({ docker, tag, timeoutMs }) {
  const r = await docker.run(['push', tag], { timeoutMs });
  if (daemonDown(r)) throw new BuilderError('DOCKER_UNAVAILABLE', r.spawnError || tail(r.stderr, 2000), { step: 'push' });
  const text = `${r.stdout.toString('utf8')}\n${r.stderr.toString('utf8')}`;
  const digests = [...text.matchAll(/digest: (sha256:[0-9a-f]{64})/g)].map((m) => m[1]);
  if (r.exitCode !== 0 || digests.length === 0) {
    throw new BuilderError('IMAGE_PUSH_FAILED', `docker push ${tag} ${r.exitCode !== 0 ? `failed: ${tail(r.stderr, 2000).trim()}` : 'printed no digest'}`, { step: 'push' });
  }
  return { digest: digests[digests.length - 1] };
}

/**
 * The unpacked size of `ref`'s `platform` variant: the sum of its layer sizes as the daemon lists
 * them (`docker history`), exactly as the code-runner's listing check measures it.
 * @throws {BuilderError} IMAGE_SIZE_UNKNOWN, DOCKER_UNAVAILABLE
 */
export async function unpackedBytes({ docker, ref, platform, timeoutMs = 120000 }) {
  const history = (withPlatform) => docker.run(['history', ...(withPlatform ? ['--platform', platform] : []), '--human=false', '--no-trunc', '--format', '{{.Size}}', ref], { timeoutMs });
  let r = await history(true);
  if (r.exitCode !== 0 && !daemonDown(r)) {
    // An older daemon or the classic image store, which may not take --platform: measure the
    // image's default variant, but only when that is the platform asked for.
    const os = await docker.run(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', ref], { timeoutMs });
    if (os.exitCode !== 0 || os.stdout.toString('utf8').trim() !== platform) {
      throw new BuilderError('IMAGE_SIZE_UNKNOWN', `the local image ${ref} is not ${platform}`, { step: 'size' });
    }
    r = await history(false);
  }
  if (daemonDown(r)) throw new BuilderError('DOCKER_UNAVAILABLE', r.spawnError || tail(r.stderr, 2000), { step: 'size' });
  const lines = r.stdout.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  if (r.exitCode !== 0 || lines.length === 0 || r.stdoutTruncated || !lines.every((l) => /^[0-9]{1,15}$/.test(l))) {
    throw new BuilderError('IMAGE_SIZE_UNKNOWN', `docker history did not list the layer sizes of ${ref} (${platform})${r.exitCode !== 0 ? `: ${tail(r.stderr, 1000).trim()}` : ''}`, { step: 'size' });
  }
  return lines.reduce((n, l) => n + Number(l), 0);
}
