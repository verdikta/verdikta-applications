// The verified-source check reads the listed commit's files from objects the builder fetched by
// id, the superproject's and each submodule's (by the commit its gitlink records), never from the
// env image's checkout or objects. Real git, local mirrors standing in for the https remotes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCommitFiles } from '../../src/commitFiles.js';
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
  return { root, baseCommit, mirrors };
}

test('tracked files come from the fetched commit, submodule files from the submodule\'s commit fetched by its gitlink', async () => {
  const r = repos();
  const gitDir = path.join(r.root, 'fetched.git');
  await fetchListedCommit({ repo: 'https://github.com/acme/vault', baseCommit: r.baseCommit, mirror: r.mirrors['https://github.com/acme/vault'], dir: gitDir, timeoutMs: 60000 });
  const files = await readCommitFiles({
    gitDir,
    repo: 'https://github.com/acme/vault',
    baseCommit: r.baseCommit,
    paths: ['src/Vault.sol', 'lib/dep/src/Lib.sol', 'src/link.sol', 'node_modules/x/y.sol', 'src/Nope.sol', 'lib/gone/src/Lib.sol', 'lib/ssh/src/Lib.sol', 'src', 'src/Vault.sol/x'],
    mirrorFor: (u) => r.mirrors[u] ?? null,
    workDir: r.root,
    timeoutMs: 60000,
  });
  const show = (p) => ({ origin: files.get(p).origin, text: files.get(p).bytes?.toString() ?? null });
  assert.deepEqual(show('src/Vault.sol'), { origin: 'commit', text: 'contract Vault {}\n' });
  assert.deepEqual(show('lib/dep/src/Lib.sol'), { origin: 'submodule', text: 'library Lib {}\n' }, 'relative URL ../dep.git resolved against the listed repository');
  assert.equal(show('src/link.sol').origin, 'symlink');
  assert.equal(show('node_modules/x/y.sol').origin, 'untracked', 'an installed dependency is read from the image');
  assert.equal(show('src/Nope.sol').origin, 'untracked');
  assert.equal(show('lib/gone/src/Lib.sol').origin, 'missing', 'a submodule commit its repository lacks');
  assert.match(files.get('lib/gone/src/Lib.sol').detail, /has no commit e{40}/);
  assert.equal(show('lib/ssh/src/Lib.sol').origin, 'missing', 'only https submodules are fetched');
  assert.equal(show('src').origin, 'missing', 'a directory is not a file');
  assert.equal(show('src/Vault.sol/x').origin, 'missing');
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('the work tree and objects of the image play no part: only the fetched objects are read', async () => {
  const r = repos();
  const gitDir = path.join(r.root, 'fetched.git');
  await fetchListedCommit({ repo: 'https://github.com/acme/vault', baseCommit: r.baseCommit, mirror: r.mirrors['https://github.com/acme/vault'], dir: gitDir, timeoutMs: 60000 });
  // Rewriting the maker's work tree after the fetch changes nothing the check reads.
  fs.writeFileSync(path.join(r.root, 'vault', 'src', 'Vault.sol'), 'contract Forged {}\n');
  const files = await readCommitFiles({ gitDir, repo: 'https://github.com/acme/vault', baseCommit: r.baseCommit, paths: ['src/Vault.sol'], mirrorFor: () => null, workDir: r.root, timeoutMs: 60000 });
  assert.equal(files.get('src/Vault.sol').bytes.toString(), 'contract Vault {}\n');
  fs.rmSync(r.root, { recursive: true, force: true });
});
