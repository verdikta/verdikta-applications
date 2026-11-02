// Node P8, the repository half of "staker controls the repository": what git says about a listing's
// repository, against real git and local bare repositories, no network. A local bare repository
// serves any object it holds by id (protocol v2 checks no reachability), exactly as GitHub serves a
// fork's commit through the parent's URL, so the imposter commit here is the real attack: the
// commit fetches, its file names the attacker, and only reachability from the repository's own
// branches and tags tells it apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTROL_FILE, CONTROL_FILE_MAX_BYTES, checkRepositoryControl, fetchSource } from '../../src/controlCheck.js';
import { fetchListedCommit } from '../../src/git.js';

const BIN = fileURLToPath(new URL('../../bin/verdikta-control-check.js', import.meta.url));
const REPO = 'https://github.com/acme/vault';
const OWNER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const STRANGER = '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2';
const proof = (maker) => `${JSON.stringify({ version: 1, maker })}\n`;

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000', GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.invalid', GIT_COMMITTER_NAME: 'm', GIT_COMMITTER_EMAIL: 'm@example.invalid' },
  }).trim();
}

function write(work, name, content) {
  fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
  fs.writeFileSync(path.join(work, name), content);
}

function commit(work, message) {
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '--allow-empty', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
}

/**
 * A maker's repository, with a proof file on main, served by a bare repository the way a host
 * serves one. `filter` says the host honours partial clones, as github.com does.
 */
function makeRepo({ filter = true, objectFormat = null, file = proof(OWNER) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-control-test-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main', ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  write(work, 'src/Vault.sol', 'contract Vault {}\n');
  if (file !== null) write(work, CONTROL_FILE, file);
  const listed = commit(work, 'listed');
  write(work, 'src/Vault.sol', 'contract Vault { uint x; }\n');
  const later = commit(work, 'later');
  const mirror = path.join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', work, mirror);
  if (filter) git(mirror, 'config', 'uploadpack.allowFilter', 'true');
  return { root, work, mirror, listed, later };
}

/**
 * The imposter commit: a commit a stranger made on a fork, whose objects the host holds in the
 * shared object store and serves by id through the parent's URL, while no branch or tag of the
 * parent contains it. `pull` also exposes it the way GitHub does, under refs/pull/<n>/head.
 */
function plantForkCommit(r, { pull = false, file = proof(STRANGER) } = {}) {
  git(r.work, 'checkout', '-q', '--detach', r.listed);
  write(r.work, CONTROL_FILE, file);
  write(r.work, 'src/Vault.sol', 'contract Vault { /* the stranger\'s */ }\n');
  const forked = commit(r.work, 'fork-only');
  git(r.work, 'push', '-q', r.mirror, `${forked}:refs/${pull ? 'pull/7/head' : 'forks/1/heads/x'}`);
  if (!pull) git(r.mirror, 'update-ref', '-d', 'refs/forks/1/heads/x');
  git(r.work, 'checkout', '-q', 'main');
  return forked;
}

const check = (r, baseCommit, over = {}) => checkRepositoryControl({ repo: REPO, baseCommit, mirror: r.mirror, timeoutMs: 60000, maxBytes: 64 * 1024 * 1024, ...over });
const done = (r) => fs.rmSync(r.root, { recursive: true, force: true });

test('a commit on a branch, older than its tip: reachable, and the file at that commit is read', async () => {
  const r = makeRepo();
  const out = await check(r, r.listed);
  assert.equal(out.reachable, true);
  assert.equal(out.ref, 'refs/heads/main');
  assert.equal(out.file.path, CONTROL_FILE);
  assert.equal(out.file.problem, null);
  assert.equal(out.file.text, proof(OWNER));
  assert.equal(out.file.blob, git(r.mirror, 'rev-parse', `${r.listed}:${CONTROL_FILE}`));
  done(r);
});

test('a branch tip, and a commit on a tag only, are the repository\'s own', async () => {
  const r = makeRepo();
  assert.equal((await check(r, r.later)).reachable, true);
  git(r.work, 'checkout', '-q', '--detach', r.listed);
  const tagged = commit(r.work, 'released from a side line');
  git(r.work, 'push', '-q', r.mirror, `${tagged}:refs/tags/v1`);
  const out = await check(r, tagged);
  assert.equal(out.reachable, true);
  assert.equal(out.ref, 'refs/tags/v1');
  done(r);
});

test('imposter commit: the fetch by id returns it, yet no branch or tag holds it, so it is not reachable and its file is never read', async () => {
  const r = makeRepo();
  const forked = plantForkCommit(r);
  // what the listing flow's fetch does today: the commit comes through the parent's URL
  const dir = path.join(r.root, 'by-id.git');
  await fetchListedCommit({ repo: REPO, baseCommit: forked, mirror: r.mirror, dir, timeoutMs: 60000 });
  assert.equal(git(dir, 'cat-file', '-t', forked), 'commit', 'the host serves the fork\'s commit by id');
  assert.match(git(dir, 'show', `${forked}:${CONTROL_FILE}`), new RegExp(STRANGER), 'and its file names the stranger');

  const out = await check(r, forked);
  assert.equal(out.reachable, false);
  assert.equal(out.ref, null);
  assert.equal(out.file, null);
  done(r);
});

test('imposter commit under refs/pull/<n>/head, advertised by the host as GitHub does: a pull request head is not the repository\'s own', async () => {
  const r = makeRepo();
  const forked = plantForkCommit(r, { pull: true });
  assert.match(git(r.root, 'ls-remote', r.mirror), new RegExp(`${forked}\\s+refs/pull/7/head`));
  const out = await check(r, forked);
  assert.equal(out.reachable, false);
  assert.equal(out.file, null);
  done(r);
});

test('the same imposter commit counts once a branch of the repository holds it: a maintainer merged it', async () => {
  const r = makeRepo();
  const forked = plantForkCommit(r);
  assert.equal((await check(r, forked)).reachable, false);
  git(r.mirror, 'update-ref', 'refs/heads/merged', forked);
  const out = await check(r, forked);
  assert.equal(out.reachable, true);
  assert.equal(out.ref, 'refs/heads/merged');
  assert.equal(out.file.text, proof(STRANGER));
  done(r);
});

test('a commit the host does not hold at all is not reachable', async () => {
  const r = makeRepo();
  const out = await check(r, 'd'.repeat(40));
  assert.deepEqual([out.reachable, out.file], [false, null]);
  done(r);
});

test('the check walks commits only: a partial fetch of the graph, no blob of the repository beyond the proof', async () => {
  const r = makeRepo();
  write(r.work, 'big.bin', crypto.randomBytes(8 * 1024 * 1024));
  const tip = commit(r.work, 'a large file');
  git(r.work, 'push', '-q', r.mirror, 'main');
  // far below the large file's size: the host honours the filter, so it never comes
  const out = await check(r, tip, { maxBytes: 1024 * 1024 });
  assert.equal(out.reachable, true);
  assert.equal(out.file.text, proof(OWNER));
  done(r);
});

test('no proof file at the commit', async () => {
  const r = makeRepo({ file: null });
  const out = await check(r, r.listed);
  assert.deepEqual([out.reachable, out.file], [true, null]);
  done(r);
});

test('the proof must be a regular file: a symlink or a directory at its path is no proof', async () => {
  for (const make of [
    (w) => fs.symlinkSync('../src/Vault.sol', path.join(w, CONTROL_FILE)),
    (w) => write(w, `${CONTROL_FILE}/inside`, proof(OWNER)),
  ]) {
    const r = makeRepo({ file: null });
    git(r.work, 'checkout', '-q', 'main');
    fs.mkdirSync(path.join(r.work, path.dirname(CONTROL_FILE)), { recursive: true });
    make(r.work);
    const tip = commit(r.work, 'not a regular file');
    git(r.work, 'push', '-q', r.mirror, 'main');
    const out = await check(r, tip);
    assert.equal(out.reachable, true);
    assert.equal(out.file.problem, 'NOT_A_REGULAR_FILE');
    assert.equal(out.file.text, null);
    done(r);
  }
});

test('a submodule at the proof\'s path is no proof', async () => {
  const r = makeRepo({ file: null });
  git(r.work, 'update-index', '--add', '--cacheinfo', `160000,${r.listed},${CONTROL_FILE}`);
  git(r.work, 'commit', '-q', '-m', 'a gitlink');
  const tip = git(r.work, 'rev-parse', 'HEAD');
  git(r.work, 'push', '-q', r.mirror, 'main');
  const out = await check(r, tip);
  assert.equal(out.reachable, true);
  assert.equal(out.file.problem, 'NOT_A_REGULAR_FILE');
  done(r);
});

test('a symlinked folder does not lead to the proof', async () => {
  const r = makeRepo({ file: null });
  write(r.work, 'elsewhere/stake-control.json', proof(OWNER));
  fs.symlinkSync('elsewhere', path.join(r.work, path.dirname(CONTROL_FILE)));
  const tip = commit(r.work, 'a symlinked folder');
  git(r.work, 'push', '-q', r.mirror, 'main');
  const out = await check(r, tip);
  assert.equal(out.reachable, true);
  assert.equal(out.file, null);
  done(r);
});

test('bounded in size: a proof over the limit is not read, and neither is one that is not UTF-8', async () => {
  const large = makeRepo({ file: `${' '.repeat(CONTROL_FILE_MAX_BYTES)}${proof(OWNER)}` });
  const tooLarge = await check(large, large.listed);
  assert.equal(tooLarge.file.problem, 'TOO_LARGE');
  assert.equal(tooLarge.file.text, null);
  done(large);

  const huge = makeRepo({ file: crypto.randomBytes(4 * 1024 * 1024) });
  const veryLarge = await check(huge, huge.listed, { maxBytes: 16 * 1024 * 1024 });
  assert.equal(veryLarge.file.problem, 'TOO_LARGE', 'a blob by id over its own small cap stops the download');
  done(huge);

  const binary = makeRepo({ file: Buffer.from([0xff, 0xfe, 0x00, 0x41]) });
  const notText = await check(binary, binary.listed);
  assert.equal(notText.file.problem, 'NOT_UTF8');
  assert.equal(notText.file.text, null);
  done(binary);
});

test('bounded in size: a repository over the byte cap stops the fetch and leaves nothing behind', async () => {
  const r = makeRepo({ filter: false });
  write(r.work, 'big.bin', crypto.randomBytes(4 * 1024 * 1024));
  const tip = commit(r.work, 'a large file');
  git(r.work, 'push', '-q', r.mirror, 'main');
  const before = new Set(fs.readdirSync(os.tmpdir()));
  await assert.rejects(check(r, tip, { maxBytes: 64 * 1024 }), (err) => err.code === 'REPO_TOO_LARGE');
  const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('vab-control-') && !before.has(n));
  assert.deepEqual(left, []);
  done(r);
});

test('bounded in time: a check past its deadline stops with an error, never an answer', async () => {
  const r = makeRepo();
  await assert.rejects(check(r, r.listed, { timeoutMs: 1 }), (err) => err.code === 'REPO_CHECK_TIMEOUT');
  done(r);
});

test('a host that cannot be read is an error, never an answer', async () => {
  const r = makeRepo();
  await assert.rejects(check(r, r.listed, { mirror: path.join(r.root, 'nothing.git') }), (err) => err.code === 'REPO_FETCH_FAILED');
  done(r);
});

test('a SHA-256 repository', async () => {
  const r = makeRepo({ objectFormat: 'sha256' });
  const out = await check(r, r.listed);
  assert.equal(r.listed.length, 64);
  assert.equal(out.reachable, true);
  assert.equal(out.file.text, proof(OWNER));
  done(r);
});

test('a repository is read through its .git form, which hosts serve with no redirect (redirects are off), or its mirror', () => {
  assert.equal(fetchSource('https://gitlab.com/acme/vault'), 'https://gitlab.com/acme/vault.git');
  assert.equal(fetchSource('https://gitlab.com/acme/vault.git'), 'https://gitlab.com/acme/vault.git');
  assert.equal(fetchSource('https://gitlab.com/acme/vault', '/m/vault.git'), '/m/vault.git');
});

test('it takes only an https repository and a full commit id', async () => {
  const base = { baseCommit: 'a'.repeat(40), timeoutMs: 1000, maxBytes: 1024 };
  await assert.rejects(checkRepositoryControl({ ...base, repo: 'file:///etc' }), /https/);
  await assert.rejects(checkRepositoryControl({ ...base, repo: 'https://u:p@github.com/a/b' }), /https/);
  await assert.rejects(checkRepositoryControl({ ...base, repo: REPO, baseCommit: 'nope' }), /full lowercase/);
});

test('the command line: JSON on stdout and exit 0 for an answer, the error code on stderr and exit 1, 64 for bad usage', () => {
  const r = makeRepo();
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: r.root } });

  const ok = run('--repo', REPO, '--commit', r.listed, '--mirror', r.mirror, '--timeout-ms', '60000', '--max-bytes', String(64 * 1024 * 1024));
  assert.equal(ok.status, 0, ok.stderr);
  const body = JSON.parse(ok.stdout);
  assert.equal(body.version, 1);
  assert.equal(body.repo, REPO);
  assert.equal(body.commit, r.listed);
  assert.equal(body.reachable, true);
  assert.equal(body.file.text, proof(OWNER));

  const bad = run('--repo', REPO, '--commit', r.listed, '--mirror', path.join(r.root, 'nothing.git'), '--timeout-ms', '60000', '--max-bytes', '1048576');
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /^verdikta-control-check: REPO_FETCH_FAILED\b/);

  assert.equal(run('--repo', REPO).status, 64);
  assert.equal(run('--repo', REPO, '--commit', r.listed, '--nope', 'x').status, 64);
  done(r);
});

test('the command line loads nothing but node\'s modules and the builder\'s own dependency-free files, so the server can run it without the builder\'s packages', () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)) {
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('.'), `${path.basename(file)} imports ${spec}`);
      walk(path.resolve(path.dirname(file), spec));
    }
  };
  walk(BIN);
  assert.ok(seen.size >= 4);
});
