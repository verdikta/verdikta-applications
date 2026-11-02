// The compiler the verified-source check trusts: the solc release the explorer says the contract
// was verified with, from the Solidity project's own binaries (binaries.soliditylang.org, or a
// mirror of it in config), checked against the SHA-256 its list.json publishes and kept in a
// cache by that hash. Never the listing's compiler: a maker's setup can install any program as
// "solc" in the env image, so nothing the listing chose compiles what the check compares.
//
// The binary runs in a fresh sandbox of the pinned foundry base image (src/docker.js: no
// network, read-only root, uid 10001), fed on stdin: the binary's bytes, then the standard-JSON
// input. Nothing is mounted and nothing of the listing's image is involved.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { codeReview } from './common.js';
import { runSandboxed } from './docker.js';
import { BuilderError, Refusal } from './errors.js';
import { tail } from './proc.js';

const DIRS = Object.freeze({ 'linux/amd64': 'linux-amd64', 'linux/arm64': 'linux-arm64' });
const LONG_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-nightly\.[0-9.]+)?\+commit\.[0-9a-f]{8}$/;
const MAX_SOLC_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** The pinned base image to run solc in, for a platform this daemon runs. */
export function sandboxImage(platform) {
  const pin = codeReview.BASE_IMAGE_PINS.foundry;
  return platform === pin.platform ? `${pin.repository}@${pin.digest}` : `${pin.repository}@${pin.indexDigest}`;
}

async function get(fetchImpl, url, what, maxBytes, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new BuilderError('SOLC_UNAVAILABLE', `${what}: ${err.message}`);
  }
  if (res.status !== 200) throw new BuilderError('SOLC_UNAVAILABLE', `${what}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new BuilderError('SOLC_UNAVAILABLE', `${what} is larger than ${maxBytes} bytes`);
  return bytes;
}

/**
 * The solc binary for `version` (a long version, e.g. 0.8.31+commit.fd3a2265) on `platform`.
 * @param {object} o
 * @param {string} o.version
 * @param {string} o.platform - linux/amd64 or linux/arm64
 * @param {string} o.baseUrl - https://binaries.soliditylang.org, or a mirror
 * @param {string} o.cacheDir
 * @param {typeof fetch} [o.fetch]
 * @returns {Promise<{ bytes: Buffer, sha256: string, longVersion: string, path: string }>}
 * @throws {Refusal} SOURCE_COMPILER_UNAVAILABLE (no such release for the platform)
 * @throws {BuilderError} SOLC_UNAVAILABLE (the download), SOLC_CHECKSUM_MISMATCH
 */
export async function fetchSolc({ version, platform, baseUrl, cacheDir, fetch: fetchImpl = globalThis.fetch, timeoutMs = 120000 }) {
  const dir = DIRS[platform];
  if (!dir) throw new BuilderError('SOLC_UNAVAILABLE', `no solc builds are listed for ${platform}`);
  if (typeof version !== 'string' || !LONG_VERSION.test(version)) {
    throw new Refusal('SOURCE_COMPILER_UNAVAILABLE', `the explorer names the compiler ${JSON.stringify(version)}, which is not a solc release version`);
  }
  const base = baseUrl.replace(/\/+$/, '');
  const listBytes = await get(fetchImpl, `${base}/${dir}/list.json`, `the solc list for ${dir}`, 16 * 1024 * 1024, timeoutMs);
  let list;
  try {
    list = JSON.parse(listBytes.toString('utf8'));
  } catch {
    throw new BuilderError('SOLC_UNAVAILABLE', `the solc list for ${dir} is not JSON`);
  }
  const build = Array.isArray(list.builds) ? list.builds.find((b) => b && b.longVersion === version) : null;
  if (!build) throw new Refusal('SOURCE_COMPILER_UNAVAILABLE', `solc ${version} has no ${dir} release in ${base}`);
  const expected = String(build.sha256 || '').replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(expected) || typeof build.path !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(build.path)) {
    throw new BuilderError('SOLC_UNAVAILABLE', `the solc list's entry for ${version} has no usable path or SHA-256`);
  }
  const cached = path.join(cacheDir, `solc-${expected}`);
  if (fs.existsSync(cached)) {
    const bytes = fs.readFileSync(cached);
    if (sha256(bytes) === expected) return { bytes, sha256: expected, longVersion: version, path: build.path };
    fs.rmSync(cached, { force: true });
  }
  const bytes = await get(fetchImpl, `${base}/${dir}/${build.path}`, `solc ${version} for ${dir}`, MAX_SOLC_BYTES, timeoutMs);
  if (sha256(bytes) !== expected) {
    throw new BuilderError('SOLC_CHECKSUM_MISMATCH', `the downloaded solc ${version} hashes to ${sha256(bytes)}, not the listed ${expected}`);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = `${cached}.${crypto.randomBytes(4).toString('hex')}.part`;
  fs.writeFileSync(tmp, bytes, { mode: 0o644 });
  fs.renameSync(tmp, cached);
  return { bytes, sha256: expected, longVersion: version, path: build.path };
}

/** The argv that runs the solc read from stdin on the standard-JSON input that follows it. */
export function compileArgv(solcBytes) {
  return ['/bin/sh', '-c', 'head -c "$1" > /work/solc && chmod 0700 /work/solc && exec /work/solc --standard-json', 'vab-solc', String(solcBytes)];
}

/**
 * Compiles `input` (solc standard JSON) with `solc` in a sandbox of the pinned base image.
 * @returns {Promise<object>} solc's standard-JSON output
 * @throws {BuilderError} SOLC_FAILED, DOCKER_UNAVAILABLE
 */
export async function compileStandardJson({ docker, platform, solc, input, timeoutMs = 300000 }) {
  const image = sandboxImage(platform);
  const have = await docker.run(['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 60000 });
  if (have.exitCode !== 0) {
    const pull = await docker.run(['pull', '--quiet', '--platform', platform, image], { timeoutMs: 900000 });
    if (pull.exitCode !== 0) throw new BuilderError('SOLC_FAILED', `the pinned base image ${image} could not be pulled: ${tail(pull.stderr, 1000).trim()}`);
  }
  const stdin = Buffer.concat([solc.bytes, Buffer.from(JSON.stringify(input), 'utf8')]);
  const r = await runSandboxed({ docker, image, platform, argv: compileArgv(solc.bytes.length), stdin, timeoutMs, maxBytes: MAX_OUTPUT_BYTES });
  if (r.spawnError) throw new BuilderError('DOCKER_UNAVAILABLE', r.spawnError, { step: 'verifiedSource' });
  if (r.timedOut) throw new BuilderError('SOLC_FAILED', `solc did not finish in ${Math.round(timeoutMs / 1000)} s`);
  if (r.exitCode !== 0 || r.stdoutTruncated) throw new BuilderError('SOLC_FAILED', `solc ${solc.longVersion} exited ${r.exitCode}: ${tail(r.stderr, 1000).trim()}`);
  try {
    return JSON.parse(r.stdout.toString('utf8'));
  } catch {
    throw new BuilderError('SOLC_FAILED', 'solc printed no standard-JSON output');
  }
}
