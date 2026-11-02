// The verified-source check builds the listed commit from objects the builder fetched by id, the
// superproject's and each submodule's (by the commit its gitlink records), never from the env
// image's checkout or objects. Real git, local mirrors standing in for the https remotes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commitTree, isTreePath } from '../../src/commitFiles.js';
import { fetchListedCommit } from '../../src/git.js';

const ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=maker', '-c', 'user.email=m@example.invalid', ...args], { cwd, encoding: 'utf8', env: { ...ENV, HOME: cwd } }).trim();
}

function repos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-files-'));
  const sub = path.join(root, 'dep');
  fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
  git(sub, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(sub, 'src', 'Lib.sol'), 'library Lib {}\n');
  git(sub, 'add', '-A');
  git(sub, 'commit', '-q', '-m', 'dep');
  const subCommit = git(sub, 'rev-parse', 'HEAD');
  git(root, 'clone', '-q', '--bare', sub, path.join(root, 'dep.git'));

  const work = path.join(root, 'vault');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'src', 'Vault.sol'), 'contract Vault {}\n');
  fs.writeFileSync(path.join(work, 'run.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(work, 'run.sh'), 0o755);
  fs.symlinkSync('Vault.sol', path.join(work, 'src', 'link.sol'));
  fs.writeFileSync(path.join(work, '.gitmodules'), [
    '[submodule "dep"]', '\tpath = lib/dep', '\turl = ../dep.git',
    '[submodule "gone"]', '\tpath = lib/gone', '\turl = https://github.com/acme/gone.git',
    '[submodule "ssh"]', '\tpath = lib/ssh', '\turl = git@github.com:acme/ssh.git', '',
  ].join('\n'));
  git(work, 'add', '-A');
  git(work, 'update-index', '--add', '--cacheinfo', `160000,${subCommit},lib/dep`);
  git(work, 'update-index', '--add', '--cacheinfo', `160000,${'e'.repeat(40)},lib/gone`);
  git(work, 'update-index', '--add', '--cacheinfo', `160000,${subCommit},lib/ssh`);
  git(work, 'commit', '-q', '-m', 'listed');
  const baseCommit = git(work, 'rev-parse', 'HEAD');
  git(root, 'clone', '-q', '--bare', work, path.join(root, 'vault.git'));
  const mirrors = {
    'https://github.com/acme/vault': path.join(root, 'vault.git'),
    'https://github.com/acme/dep.git': path.join(root, 'dep.git'),
    'https://github.com/acme/gone.git': path.join(root, 'dep.git'),
  };
  return { root, work, baseCommit, mirrors };
}

async function fetched(r) {
  const gitDir = path.join(r.root, 'fetched.git');
  await fetchListedCommit({ repo: 'https://github.com/acme/vault', baseCommit: r.baseCommit, mirror: r.mirrors['https://github.com/acme/vault'], dir: gitDir, timeoutMs: 60000 });
  return gitDir;
}

test('every file of the commit with its mode, submodules fetched by their gitlinks and laid out under them', async () => {
  const r = repos();
  const { entries, skipped } = await commitTree({ gitDir: await fetched(r), repo: 'https://github.com/acme/vault', baseCommit: r.baseCommit, mirrorFor: (u) => r.mirrors[u] ?? null, workDir: r.root, timeoutMs: 60000 });
  const byPath = Object.fromEntries(entries.map((e) => [e.path, { mode: e.mode, text: e.bytes.toString() }]));
  assert.deepEqual(byPath['src/Vault.sol'], { mode: '100644', text: 'contract Vault {}\n' });
  assert.deepEqual(byPath['run.sh'], { mode: '100755', text: '#!/bin/sh\n' });
  assert.deepEqual(byPath['src/link.sol'], { mode: '120000', text: 'Vault.sol' }, 'a symbolic link is its target');
  assert.deepEqual(byPath['lib/dep/src/Lib.sol'], { mode: '100644', text: 'library Lib {}\n' }, 'relative URL ../dep.git resolved against the listed repository');
  assert.deepEqual(skipped.map((s) => s.path).sort(), ['lib/gone', 'lib/ssh'], 'a missing submodule commit, and a submodule without an https URL, stay empty');
  assert.match(skipped.find((s) => s.path === 'lib/gone').detail, /has no commit e{40}/);
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('the maker\'s work tree plays no part: only the fetched objects are read', async () => {
  const r = repos();
  const gitDir = await fetched(r);
  fs.writeFileSync(path.join(r.work, 'src', 'Vault.sol'), 'contract Forged {}\n');
  const { entries } = await commitTree({ gitDir, repo: 'https://github.com/acme/vault', baseCommit: r.baseCommit, mirrorFor: (u) => r.mirrors[u] ?? null, workDir: r.root, timeoutMs: 60000 });
  assert.equal(entries.find((e) => e.path === 'src/Vault.sol').bytes.toString(), 'contract Vault {}\n');
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('paths git could not check out are refused', () => {
  for (const p of ['src/Vault.sol', 'a b/c.sol', 'lib/dep/x']) assert.equal(isTreePath(p), true, p);
  for (const p of ['', '../x', 'a/../b', './a', 'a//b', '.git/config', 'a/.GIT/hooks', 'a\nb', 'a\0b']) assert.equal(isTreePath(p), false, JSON.stringify(p));
});
