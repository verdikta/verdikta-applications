// wallet_init.js must not replace an existing keystore (it may be the only copy of a funded key) without --overwrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../wallet_init.js', import.meta.url));
const run = (home, args) => spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, HOME: home, VERDIKTA_WALLET_PASSWORD: 'test-password' }, input: '', encoding: 'utf8' });

test('wallet_init.js refuses to overwrite an existing keystore', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-wallet-'));
  const out = path.join(home, 'wallet.json');
  fs.writeFileSync(out, '{"funded":"keystore"}');
  const r = run(home, ['--out', out]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already exists/);
  assert.equal(fs.readFileSync(out, 'utf8'), '{"funded":"keystore"}');
});

test('wallet_init.js creates a new keystore, and replaces one only with --overwrite', { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-wallet-'));
  const out = path.join(home, 'wallet.json');
  const created = run(home, ['--out', out]);
  assert.equal(created.status, 0, created.stderr);
  const first = fs.readFileSync(out, 'utf8');
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const replaced = run(home, ['--out', out, '--overwrite']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.notEqual(fs.readFileSync(out, 'utf8'), first);
});
