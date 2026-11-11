import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { run, COMMANDS } from '../src/cli.js';

const bin = fileURLToPath(new URL('../bin/verdikta-attest.js', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

async function capture(argv) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } }, {});
  return { code, stdout, stderr };
}

test('the package exposes the verdikta-attest binary', () => {
  assert.deepEqual(manifest.bin, { 'verdikta-attest': 'bin/verdikta-attest.js' });
  assert.match(fs.readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

test('--help prints usage and the hunter commands, exit 0', async () => {
  const res = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^Usage: verdikta-attest <command> \[options\]/);
  for (const name of ['check', 'commit', 'reveal', 'status', 'claim', 'appeal']) {
    assert.match(res.stdout, new RegExp(`^  ${name}\\s`, 'm'), name);
  }
  // node P18 adds appeal, the hunter's appeal of an INVALID (erratum E7)
  assert.deepEqual(Object.keys(COMMANDS), ['check', 'commit', 'reveal', 'status', 'claim', 'appeal']);
  assert.equal((await capture(['-h'])).code, 0);
});

test('--version prints the package version', async () => {
  const res = await capture(['--version']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), manifest.version);
});

test('no command prints usage to stderr, exit 2', async () => {
  const res = await capture([]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /^Usage: verdikta-attest/);
});

test('an unknown command or option is a usage error, exit 2', async () => {
  const cmd = await capture(['frobnicate']);
  assert.equal(cmd.code, 2);
  assert.match(cmd.stderr, /unknown command 'frobnicate'/);
  const opt = await capture(['--bogus']);
  assert.equal(opt.code, 2);
  assert.match(opt.stderr, /unknown option/);
});

test('a verb without what it needs is a usage error that names it, exit 2', async () => {
  const res = await capture(['commit']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /commit/);
  assert.equal(res.stdout, '');
});
