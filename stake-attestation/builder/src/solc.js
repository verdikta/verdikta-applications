// The compiler the verified-source check trusts: the solc release the explorer says the contract
// was verified with, from the Solidity project's own binaries (binaries.soliditylang.org, or a
// mirror of it in config), checked against the SHA-256 its list.json publishes and kept in a
// cache by that hash. Never the listing's compiler: a maker's setup can install any program as
// "solc" in the env image, so nothing the listing chose compiles what the check compares
// (src/repoBuild.js passes this binary to forge with --use).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BuilderError, Refusal } from './errors.js';

const DIRS = Object.freeze({ 'linux/amd64': 'linux-amd64', 'linux/arm64': 'linux-arm64' });
const LONG_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-nightly\.[0-9.]+)?\+commit\.[0-9a-f]{8}$/;
const MAX_SOLC_BYTES = 128 * 1024 * 1024;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

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
