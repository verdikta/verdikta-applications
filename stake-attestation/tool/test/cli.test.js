import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { run, COMMANDS } from '../src/cli.js';

const bin = fileURLToPath(new URL('../bin/verdikta-attest.js', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function capture(argv) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } });
  return { code, stdout, stderr };
}

test('the package exposes the verdikta-attest binary', () => {
  assert.deepEqual(manifest.bin, { 'verdikta-attest': 'bin/verdikta-attest.js' });
  assert.match(fs.readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

test('--help prints usage and the hunter commands, exit 0', () => {
  const res = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^Usage: verdikta-attest <command> \[options\]/);
  for (const name of ['check', 'commit', 'reveal', 'status', 'claim']) {
    assert.match(res.stdout, new RegExp(`^  ${name}\\s`, 'm'), name);
  }
  assert.deepEqual(Object.keys(COMMANDS), ['check', 'commit', 'reveal', 'status', 'claim']);
  assert.equal(capture(['-h']).code, 0);
});

test('--version prints the package version', () => {
  const res = capture(['--version']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), manifest.version);
});

test('no command prints usage to stderr, exit 2', () => {
  const res = capture([]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /^Usage: verdikta-attest/);
});

test('an unknown command or option is a usage error, exit 2', () => {
  const cmd = capture(['frobnicate']);
  assert.equal(cmd.code, 2);
  assert.match(cmd.stderr, /unknown command 'frobnicate'/);
  const opt = capture(['--bogus']);
  assert.equal(opt.code, 2);
  assert.match(opt.stderr, /unknown option/);
});

test('a hunter command that is not built yet says so and exits 2, never pretending to succeed', () => {
  const res = capture(['commit']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /'commit' is not available in this release/);
  assert.equal(res.stdout, '');
});
