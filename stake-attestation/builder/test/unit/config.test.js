// The builder's configuration: the registry, the code-runner, the explorers, the signing key and
// the platforms. Secrets (the runner's token, an explorer's API key, the signing key) are named
// by where they live, read only when used, and never part of the parsed config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseConfig, loadConfig } from '../../src/config.js';

const MIN = { registry: { repository: 'ghcr.io/verdikta/stake-env' }, runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' } };
const parse = (raw, env = { CODE_RUNNER_TOKEN: 'tok-0123456789abcdef0123456789abcdef' }) => parseConfig(raw, { baseDir: '/srv/builder', env });

test('a minimal config: defaults are the class platform, the class limits and a dev key', () => {
  const c = parse(MIN);
  assert.equal(c.registry.repository, 'ghcr.io/verdikta/stake-env');
  assert.deepEqual(c.platforms, { setup: 'linux/amd64', run: 'linux/amd64', extra: [] });
  assert.deepEqual(c.limits, { imageCompressedBytes: 2000000000, imageUnpackedBytes: 6000000000 });
  assert.equal(c.signing.key, 'dev');
  assert.equal(c.runner.deadlineMs, 900000);
});

test('secrets are read when used, never stored in the config', () => {
  const env = { CODE_RUNNER_TOKEN: 'tok-0123456789abcdef0123456789abcdef', ETHERSCAN_API_KEY: 'EKEY-123' };
  const c = parse({ ...MIN, explorers: { 8453: { apiUrl: 'https://api.etherscan.io/v2/api', apiKeyEnv: 'ETHERSCAN_API_KEY' } } }, env);
  assert.equal(c.runner.token(), env.CODE_RUNNER_TOKEN);
  assert.equal(c.explorers.get(8453).apiKey(), 'EKEY-123');
  const text = JSON.stringify(c);
  assert.ok(!text.includes('tok-0123') && !text.includes('EKEY-123'), text);
  // A token file instead (a mounted secret); a missing one is named, not shown.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-cfg-'));
  fs.writeFileSync(path.join(dir, 'token'), 'file-token-0123456789abcdef0123456789\n', { mode: 0o600 });
  const f = parseConfig({ ...MIN, runner: { url: 'http://127.0.0.1:8090', tokenFile: 'token' } }, { baseDir: dir, env: {} });
  assert.equal(f.runner.token(), 'file-token-0123456789abcdef0123456789');
  const missing = parse({ ...MIN, runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'NOPE' } }, {});
  assert.throws(() => missing.runner.token(), /NOPE/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('limits may only lower the class\'s 2 GB compressed / 6 GB unpacked', () => {
  assert.equal(parse({ ...MIN, limits: { imageUnpackedBytes: 1000 } }).limits.imageUnpackedBytes, 1000);
  assert.throws(() => parse({ ...MIN, limits: { imageUnpackedBytes: 6000000001 } }), /class/);
  assert.throws(() => parse({ ...MIN, limits: { pids: 1 } }), /limits/);
});

test('the registry repository is a lowercase name without tag or digest', () => {
  for (const repository of ['ghcr.io/verdikta/stake-env', '127.0.0.1:5000/env', 'localhost:5000/a/b']) {
    assert.equal(parse({ ...MIN, registry: { repository } }).registry.repository, repository);
  }
  for (const repository of ['ghcr.io/Verdikta/env', 'ghcr.io/verdikta/env:latest', `ghcr.io/x@sha256:${'a'.repeat(64)}`, 'env', '']) {
    assert.throws(() => parse({ ...MIN, registry: { repository } }), /repository/, repository);
  }
});

test('platforms: linux/amd64 is the class\'s; linux/arm64 only as a dev extra', () => {
  assert.deepEqual(parse({ ...MIN, platforms: { setup: 'linux/arm64', run: 'linux/arm64', extra: ['linux/arm64'] } }).platforms, { setup: 'linux/arm64', run: 'linux/arm64', extra: ['linux/arm64'] });
  assert.throws(() => parse({ ...MIN, platforms: { setup: 'linux/s390x' } }), /platform/);
  assert.throws(() => parse({ ...MIN, platforms: { extra: ['linux/amd64'] } }), /extra/);
});

test('the signing key: dev, an environment secret, or a signer command with its public key', () => {
  assert.deepEqual(parse({ ...MIN, signing: { key: { env: 'VERDIKTA_BUILDER_KEY' } } }).signing.key, { env: 'VERDIKTA_BUILDER_KEY' });
  assert.throws(() => parse({ ...MIN, signing: { key: { file: '/etc/key.pem' } } }), /signing/);
  assert.throws(() => parse({ ...MIN, signing: { key: { env: 'lower-case' } } }), /signing/);
});

test('explorers by chain id, https unless loopback; mirrors only for https repositories', () => {
  const c = parse({ ...MIN, explorers: { 8453: { apiUrl: 'https://api.etherscan.io/v2/api' }, 31337: { apiUrl: 'http://127.0.0.1:4000/api' } }, repoMirrors: { 'https://github.com/acme/vault': '/srv/mirrors/vault.git' } });
  assert.equal(c.explorers.get(8453).apiKey(), null);
  assert.equal(c.explorers.get(31337).apiUrl, 'http://127.0.0.1:4000/api');
  assert.equal(c.mirrorFor('https://github.com/acme/vault'), '/srv/mirrors/vault.git');
  assert.equal(c.mirrorFor('https://github.com/acme/other'), null);
  assert.throws(() => parse({ ...MIN, explorers: { 8453: { apiUrl: 'http://api.etherscan.io/v2/api' } } }), /https/);
  assert.throws(() => parse({ ...MIN, explorers: { base: { apiUrl: 'https://x/api' } } }), /chain id/);
  assert.throws(() => parse({ ...MIN, explorers: { 8453: { apiUrl: 'https://api.etherscan.io/v2/api?apikey=K' } } }), /apiKeyEnv/);
  assert.throws(() => parse({ ...MIN, repoMirrors: { 'git@github.com:acme/vault': '/x' } }), /https/);
});

test('unknown keys are refused, so a typo cannot silently drop a setting', () => {
  assert.throws(() => parse({ ...MIN, registy: {} }), /registy/);
  assert.throws(() => parse({ ...MIN, runner: { ...MIN.runner, tokn: 'x' } }), /tokn/);
});

test('loadConfig reads a JSON file and resolves its paths against the file\'s folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-cfg-'));
  const file = path.join(dir, 'builder.json');
  fs.writeFileSync(file, JSON.stringify({ ...MIN, workDir: 'work', repoMirrors: { 'https://github.com/acme/vault': 'mirrors/vault.git' } }));
  const c = loadConfig(file, { env: { CODE_RUNNER_TOKEN: 'tok-0123456789abcdef0123456789abcdef' } });
  assert.equal(c.workDir, path.join(dir, 'work'));
  assert.equal(c.mirrorFor('https://github.com/acme/vault'), path.join(dir, 'mirrors', 'vault.git'));
  fs.rmSync(dir, { recursive: true, force: true });
});
