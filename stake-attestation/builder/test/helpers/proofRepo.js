// Real git repositories for the listing-proof tests (node P9): a bare repository stands for the
// host, as in the control check's tests. A bare repository serves any object it holds by id, as
// GitHub serves a fork's commit through the parent's URL, so a fork-only commit here is the attack.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CONTROL_FILE = '.verdikta/stake-control.json';
export const proofFile = (maker) => `${JSON.stringify({ version: 1, maker })}\n`;

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.invalid', GIT_COMMITTER_NAME: 'm', GIT_COMMITTER_EMAIL: 'm@example.invalid' },
  }).trim();
}

function write(work, name, content) {
  fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
  fs.writeFileSync(path.join(work, name), content);
}

/** A bare repository under `dir` with one commit on main; `commit` adds more. */
export function makeRepo(dir) {
  const mirror = path.join(dir, 'host.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  write(work, 'src/Vault.sol', 'contract Vault {}\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  git(dir, 'clone', '-q', '--bare', work, mirror);
  git(mirror, 'config', 'uploadpack.allowFilter', 'true');
  let n = 0;
  return {
    mirror,
    /** A new commit: on main by default, on another branch, as a tag (`tag`), or on no ref (branch: null). */
    commit({ file = null, branch = 'main', tag = null, symlinkTo = null } = {}) {
      n += 1;
      git(work, 'checkout', '-q', '--detach', 'main');
      write(work, 'src/Vault.sol', `contract Vault { /* ${n} */ }\n`);
      fs.rmSync(path.join(work, CONTROL_FILE), { force: true });
      if (file !== null) write(work, CONTROL_FILE, file);
      if (symlinkTo !== null) {
        fs.mkdirSync(path.dirname(path.join(work, CONTROL_FILE)), { recursive: true });
        fs.symlinkSync(symlinkTo, path.join(work, CONTROL_FILE));
      }
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '--allow-empty', '-m', `commit ${n}`);
      const id = git(work, 'rev-parse', 'HEAD');
      if (branch === 'main') git(work, 'branch', '-qf', 'main', id);
      const target = tag ? `refs/tags/${tag}` : `refs/${branch ? `heads/${branch}` : 'forks/1'}`;
      git(work, 'push', '-qf', mirror, `${id}:${target}`);
      if (!branch && !tag) git(mirror, 'update-ref', '-d', 'refs/forks/1');
      git(work, 'checkout', '-q', 'main');
      return id;
    },
    /** The fork's commit also under refs/pull/<n>/head, as GitHub advertises one. */
    pullRef(id, number = 7) {
      git(mirror, 'update-ref', `refs/pull/${number}/head`, id);
    },
  };
}
