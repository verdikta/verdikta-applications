// Real git repositories for the control-proof tests (node P8): a bare repository in a mirror folder
// (SA_CONTROL_GIT_MIRROR_DIR/<host>/<path>.git) stands for the host, so the server's check runs the
// real command line against real git with no network. A bare repository serves any object it holds
// by id, as GitHub serves a fork's commit through the parent's URL.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CONTROL_FILE = '.verdikta/stake-control.json';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.invalid', GIT_COMMITTER_NAME: 'm', GIT_COMMITTER_EMAIL: 'm@example.invalid' },
  }).trim();
}

export const proofFile = (maker) => `${JSON.stringify({ version: 1, maker })}\n`;

function write(work, name, content) {
  fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
  fs.writeFileSync(path.join(work, name), content);
}

/**
 * The repository `url` (https://<host>/<path>) with one commit on main.
 * @param {string} mirrorDir - SA_CONTROL_GIT_MIRROR_DIR
 * @param {string} url
 * @param {{ file?: string|null }} [o] - the proof file's content at that commit (null: none)
 * @returns {{ url: string, mirror: string, commit: (o: { file?: string|null, branch?: string|null }) => string, removeBranch: (name: string) => void }}
 */
export function makeRepo(mirrorDir, url, { file = null } = {}) {
  const { host, pathname } = new URL(url);
  const mirror = path.join(mirrorDir, host, `${pathname.slice(1).replace(/\.git$/, '')}.git`);
  const work = `${mirror}.work`;
  // a repository made earlier in the folder is the same repository: it gets another commit
  if (!fs.existsSync(mirror)) {
    fs.mkdirSync(work, { recursive: true });
    git(work, 'init', '-q', '-b', 'main');
    write(work, 'src/Vault.sol', 'contract Vault {}\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'first');
    git(path.dirname(mirror), 'clone', '-q', '--bare', work, mirror);
    git(mirror, 'config', 'uploadpack.allowFilter', 'true');
  }
  let n = 0;
  const repo = {
    url,
    mirror,
    /** A new commit; on main by default, on another branch, or (branch: null) on no ref at all. */
    commit({ file: content = file, branch = 'main' } = {}) {
      n += 1;
      git(work, 'checkout', '-q', '--detach', 'main');
      write(work, 'src/Vault.sol', `contract Vault { /* ${n} ${crypto.randomBytes(4).toString('hex')} */ }\n`);
      if (content === null) fs.rmSync(path.join(work, CONTROL_FILE), { force: true });
      else write(work, CONTROL_FILE, content);
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '-m', `commit ${n}`);
      const id = git(work, 'rev-parse', 'HEAD');
      if (branch === 'main') git(work, 'branch', '-qf', 'main', id);
      git(work, 'push', '-q', mirror, `${id}:refs/${branch ? `heads/${branch}` : 'forks/1'}`);
      if (!branch) git(mirror, 'update-ref', '-d', 'refs/forks/1');
      git(work, 'checkout', '-q', 'main');
      return id;
    },
    /** The fork's commit also under refs/pull/<n>/head, as GitHub advertises one. */
    pullRef(id, number = 7) {
      git(mirror, 'update-ref', `refs/pull/${number}/head`, id);
    },
    removeBranch(name) {
      git(mirror, 'update-ref', '-d', `refs/heads/${name}`);
    },
  };
  return repo;
}
