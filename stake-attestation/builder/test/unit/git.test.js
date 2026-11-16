// Acceptance 1 (clone repo@baseCommit): the builder fetches exactly the listed commit's objects
// into a bare repository on the host, never checks the maker's files out there, and runs git with
// no system or global config, no hooks and no credential prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchListedCommit, gitEnv } from '../../src/git.js';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' },
  }).trim();
}

/** A maker's repository with two commits, served from a bare mirror. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-git-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'src', 'Vault.sol'), 'contract Vault {}\n');
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=maker', '-c', 'user.email=m@example.invalid', 'commit', '-q', '-m', 'listed');
  const listed = git(work, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(work, 'src', 'Vault.sol'), 'contract Vault { uint x; }\n');
  git(work, '-c', 'user.name=maker', '-c', 'user.email=m@example.invalid', 'commit', '-qam', 'later');
  const mirror = path.join(root, 'mirror.git');
  git(root, 'clone', '-q', '--bare', work, mirror);
  return { root, listed, later: git(work, 'rev-parse', 'HEAD'), mirror };
}

test('the listed commit (here not a branch tip) is fetched into a bare repository: objects only, no work tree on the host', async () => {
  const r = makeRepo();
  const dir = path.join(r.root, 'fetched.git');
  const out = await fetchListedCommit({ repo: 'https://github.com/acme/vault', baseCommit: r.listed, mirror: r.mirror, dir, timeoutMs: 60000 });
  assert.equal(out.gitDir, dir);
  assert.equal(git(dir, 'cat-file', '-t', r.listed), 'commit');
  assert.equal(git(dir, 'rev-parse', `${r.listed}^{tree}`).length, 40);
  assert.ok(!fs.existsSync(path.join(dir, 'src')), 'nothing of the maker\'s tree is written as files');
  assert.ok(!fs.existsSync(path.join(dir, 'FETCH_HEAD')), 'no FETCH_HEAD naming the local source');
  // Relative submodule URLs resolve against the listed repository, as on the maker's machine.
  assert.equal(git(dir, 'config', '--get', 'remote.origin.url'), 'https://github.com/acme/vault');
  assert.equal(git(dir, 'config', '--get', 'core.bare'), 'false', 'ready to be /repo/.git');
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('a branch tip is fetched the same way, by its id', async () => {
  const r = makeRepo();
  const dir = path.join(r.root, 'fetched.git');
  await fetchListedCommit({ repo: 'https://github.com/acme/vault', baseCommit: r.later, mirror: r.mirror, dir, timeoutMs: 60000 });
  assert.equal(git(dir, 'cat-file', '-t', r.later), 'commit');
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('a baseCommit the repository does not hold stops the listing', async () => {
  const r = makeRepo();
  await assert.rejects(
    fetchListedCommit({ repo: 'https://github.com/acme/vault', baseCommit: 'd'.repeat(40), mirror: r.mirror, dir: path.join(r.root, 'x.git'), timeoutMs: 60000 }),
    (err) => err.code === 'BASE_COMMIT_NOT_FOUND' && err.refusal === true,
  );
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('git runs without system or global config, hooks, prompts, or protocols other than https (and file for a mirror)', () => {
  const env = gitEnv({ home: '/tmp/x' });
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.HOME, '/tmp/x');
  assert.deepEqual(Object.keys(env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k)), []);
  const leaky = { ...process.env, VERDIKTA_BUILDER_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'x' };
  assert.equal(gitEnv({ home: '/tmp/x', base: leaky }).VERDIKTA_BUILDER_KEY, undefined);
});

test('the listed repository must be https; a mirror is used only for its exact URL', async () => {
  await assert.rejects(fetchListedCommit({ repo: 'file:///etc', baseCommit: 'a'.repeat(40), dir: '/nonexistent/x', timeoutMs: 1000 }), /https/);
  await assert.rejects(fetchListedCommit({ repo: 'https://github.com/acme/vault', baseCommit: 'nope', dir: '/nonexistent/x', timeoutMs: 1000 }), /baseCommit/);
});
