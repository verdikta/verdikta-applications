// The compiler the verified-source check trusts: the release the explorer names, from the
// Solidity project's list.json and binaries (a local double here), checked by the SHA-256 the
// list publishes and cached by it; run in a sandbox of the pinned base image with the binary and
// the input on stdin, no network and nothing mounted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { compileArgv, compileStandardJson, fetchSolc, sandboxImage } from '../../src/solc.js';
import { fakeDocker, startServer } from '../helpers/fakes.js';

const BINARY = Buffer.from('\x7fELF fake solc for the test');
const VERSION = '0.8.31+commit.fd3a2265';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function soliditylang({ body = BINARY, listed = sha(BINARY) } = {}) {
  return startServer((req) => {
    if (req.url === '/linux-amd64/list.json') {
      return { status: 200, body: { builds: [{ path: `solc-linux-amd64-v${VERSION}`, longVersion: VERSION, sha256: `0x${listed}` }], releases: {} } };
    }
    if (req.url === `/linux-amd64/solc-linux-amd64-v${VERSION}`) return { status: 200, body };
    return { status: 404 };
  });
}

test('the listed release is downloaded, checked against the list\'s SHA-256, and cached by it', async () => {
  const srv = await soliditylang();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-solc-'));
  try {
    const a = await fetchSolc({ version: VERSION, platform: 'linux/amd64', baseUrl: srv.url, cacheDir });
    assert.ok(a.bytes.equals(BINARY));
    assert.equal(a.sha256, sha(BINARY));
    const downloads = () => srv.requests.filter((r) => r.url.endsWith(VERSION)).length;
    assert.equal(downloads(), 1);
    const b = await fetchSolc({ version: VERSION, platform: 'linux/amd64', baseUrl: srv.url, cacheDir });
    assert.ok(b.bytes.equals(BINARY));
    assert.equal(downloads(), 1, 'the second time from the cache');
    // A cache entry that no longer hashes to its name is fetched again.
    fs.writeFileSync(path.join(cacheDir, `solc-${sha(BINARY)}`), 'tampered');
    assert.ok((await fetchSolc({ version: VERSION, platform: 'linux/amd64', baseUrl: srv.url, cacheDir })).bytes.equals(BINARY));
    assert.equal(downloads(), 2);
  } finally {
    await srv.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a binary that does not hash to the listed SHA-256 is never used', async () => {
  const srv = await soliditylang({ listed: 'a'.repeat(64) });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-solc-'));
  try {
    await assert.rejects(fetchSolc({ version: VERSION, platform: 'linux/amd64', baseUrl: srv.url, cacheDir }), { code: 'SOLC_CHECKSUM_MISMATCH' });
    assert.deepEqual(fs.readdirSync(cacheDir), []);
  } finally {
    await srv.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a compiler the Solidity project never released for the platform is the listing\'s refusal', async () => {
  const srv = await soliditylang();
  try {
    await assert.rejects(fetchSolc({ version: '0.8.99+commit.00000000', platform: 'linux/amd64', baseUrl: srv.url, cacheDir: os.tmpdir() }), (e) => e.code === 'SOURCE_COMPILER_UNAVAILABLE' && e.refusal);
    await assert.rejects(fetchSolc({ version: 'v0.8.31; rm -rf /', platform: 'linux/amd64', baseUrl: srv.url, cacheDir: os.tmpdir() }), { code: 'SOURCE_COMPILER_UNAVAILABLE' });
  } finally {
    await srv.close();
  }
});

test('solc runs in a sandbox of the pinned base image, fed the binary then the input on stdin', async () => {
  const docker = fakeDocker((args) => (args[0] === 'run' ? { stdout: '{"contracts":{}}' } : {}));
  const out = await compileStandardJson({ docker, platform: 'linux/amd64', solc: { bytes: BINARY, longVersion: VERSION }, input: { language: 'Solidity', sources: {} } });
  assert.deepEqual(out, { contracts: {} });
  const pin = codeReview.BASE_IMAGE_PINS.foundry;
  assert.equal(sandboxImage('linux/amd64'), `${pin.repository}@${pin.digest}`);
  const run = docker.calls.find((c) => c.args[0] === 'run');
  const args = run.args;
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--interactive') && args.includes('--read-only'));
  assert.equal(args[args.indexOf('--user') + 1], '10001:10001');
  assert.ok(args.includes(`${pin.repository}@${pin.digest}`), 'the pinned base, not the listing\'s image');
  assert.deepEqual(args.slice(-compileArgv(BINARY.length).length), compileArgv(BINARY.length));
  assert.ok(run.opts.stdin.equals(Buffer.concat([BINARY, Buffer.from('{"language":"Solidity","sources":{}}')])));
  const failing = fakeDocker((a) => (a[0] === 'run' ? { exitCode: 1, stderr: 'boom' } : {}));
  await assert.rejects(compileStandardJson({ docker: failing, platform: 'linux/amd64', solc: { bytes: BINARY, longVersion: VERSION }, input: {} }), { code: 'SOLC_FAILED' });
});
