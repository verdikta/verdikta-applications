// Static rules over src/ (review focus: signing-key handling, and the maker's setup getting
// network only at build time): every process is spawned with an argv array and no shell; the
// only `docker run` argv is the sandbox's, with no network; the docker CLI and git get an
// allow-listed environment; private key material is never exported or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dockerEnv, sandboxRunArgs } from '../../src/docker.js';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => ({ f, text: fs.readFileSync(path.join(SRC, f), 'utf8') }));

test('no shell: processes are spawned with argv arrays only', () => {
  for (const { f, text } of files) {
    assert.ok(!/shell:\s*true/.test(text), `${f}: shell: true`);
    assert.ok(!/\bexecSync\(|\bexec\(|\bexecFile\(/.test(text), `${f}: exec`);
    assert.ok(!/\beval\(|new Function\(/.test(text), `${f}: eval`);
  }
  const spawners = files.filter(({ text }) => /\bspawn\(/.test(text)).map(({ f }) => f);
  assert.deepEqual(spawners, ['proc.js'], 'one place spawns processes');
});

test('the only docker run argv is the sandbox\'s: no network, read-only root, no capabilities, uid 10001', () => {
  const runs = files.filter(({ text }) => /\[\s*'run'\s*,/.test(text)).map(({ f }) => f);
  assert.deepEqual(runs, ['docker.js']);
  const args = sandboxRunArgs({ image: `img@sha256:${'a'.repeat(64)}`, platform: 'linux/amd64', name: 'vab-x-1', label: 'io.verdikta.builder=x', argv: ['/bin/sh', '-c', 'true'] });
  const pair = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], 'run');
  assert.equal(pair('--network'), 'none');
  assert.ok(args.includes('--read-only'));
  assert.equal(pair('--cap-drop'), 'ALL');
  assert.equal(pair('--security-opt'), 'no-new-privileges');
  assert.equal(pair('--user'), '10001:10001');
  assert.equal(pair('--pull'), 'never');
  assert.equal(pair('--platform'), 'linux/amd64');
  assert.equal(pair('--ipc'), 'none');
  assert.ok(!args.some((a) => /^(-v|--volume|--mount|--privileged|--network=host)$/.test(a) || a.includes('docker.sock')));
  assert.deepEqual(args.slice(-3), ['/bin/sh', '-c', 'true']);
});

test('the docker CLI gets an allow-listed environment: never the signing key, the runner token or an API key', () => {
  const env = dockerEnv({ PATH: '/usr/bin', HOME: '/home/b', DOCKER_HOST: 'unix:///x.sock', DOCKER_CONFIG: '/home/b/.docker', VERDIKTA_BUILDER_KEY: 'k', CODE_RUNNER_TOKEN: 't', ETHERSCAN_API_KEY: 'e', AWS_SECRET_ACCESS_KEY: 's' });
  assert.deepEqual(Object.keys(env).sort(), ['DOCKER_BUILDKIT', 'DOCKER_CONFIG', 'DOCKER_HOST', 'HOME', 'PATH']);
  assert.equal(env.DOCKER_BUILDKIT, '1');
});

test('no private key is exported or written: only public keys leave a KeyObject', () => {
  for (const { f, text } of files) {
    for (const m of text.matchAll(/\.export\(([^)]*)\)/g)) {
      assert.match(m[1], /format: 'jwk'/, `${f}: ${m[0]}`);
      assert.ok(/publicKey|public/.test(text.slice(Math.max(0, m.index - 120), m.index)), `${f}: only a public key is exported (${m[0]})`);
    }
    assert.ok(!/pkcs8|BEGIN PRIVATE KEY/.test(text) || f === 'signing.js', `${f}: private key encoding outside signing.js`);
  }
  const signing = files.find(({ f }) => f === 'signing.js').text;
  assert.ok(!/writeFile|createWriteStream|appendFile/.test(signing), 'signing.js writes no file');
});
