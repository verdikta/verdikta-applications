// A repository made with git's plumbing from a map of paths, with no work tree: a path git keeps but no file system
// here could hold (thousands of characters) is as easy as any. A value is the file's text or bytes, or
// { exec: text } (mode 100755), { link: target } (120000) or { gitlink: commit } (160000, a submodule, whose commit
// need not exist). Each commit goes on refs/heads/main, the one before it as its parent.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchListedCommit } from '../../src/git.js';

const ENV = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'maker',
  GIT_AUTHOR_EMAIL: 'maker@example.invalid',
  GIT_COMMITTER_NAME: 'maker',
  GIT_COMMITTER_EMAIL: 'maker@example.invalid',
  GIT_AUTHOR_DATE: '2026-11-11T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-11-11T00:00:00Z',
};

function git(dir, args, { input, index } = {}) {
  return execFileSync('git', ['--git-dir', dir, ...args], {
    env: { ...ENV, ...(index ? { GIT_INDEX_FILE: index } : {}) }, input, maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8').trim();
}

/**
 * @param {Record<string, string|Buffer|{exec: string}|{link: string}|{gitlink: string}>} files
 * @returns {{ dir: string, commit: string, commitOn: (files: object) => string, cleanup: () => void }}
 */
export function repositoryOf(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-gittree-'));
  const dir = path.join(root, 'repo.git');
  execFileSync('git', ['init', '-q', '--bare', dir], { env: ENV });
  let parent = null;
  const commitOn = (set) => {
    const index = path.join(root, `index-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const lines = [];
    for (const [p, v] of Object.entries(set)) {
      let mode = '100644';
      let id;
      if (v && typeof v === 'object' && !Buffer.isBuffer(v) && 'gitlink' in v) {
        mode = '160000';
        id = v.gitlink;
      } else {
        let bytes = v;
        if (v && typeof v === 'object' && !Buffer.isBuffer(v) && 'exec' in v) { mode = '100755'; bytes = v.exec; }
        if (v && typeof v === 'object' && !Buffer.isBuffer(v) && 'link' in v) { mode = '120000'; bytes = v.link; }
        id = git(dir, ['hash-object', '-w', '--stdin'], { input: Buffer.from(bytes) });
      }
      lines.push(`${mode} ${id}\t${p}\0`);
    }
    git(dir, ['update-index', '-z', '--index-info'], { input: lines.join(''), index });
    const tree = git(dir, ['write-tree', '--missing-ok'], { index });
    const commit = git(dir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'a version'], { index });
    git(dir, ['update-ref', 'refs/heads/main', commit]);
    git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    fs.rmSync(index, { force: true });
    parent = commit;
    return commit;
  };
  const commit = commitOn(files);
  return { dir, commit, commitOn, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** The repository's paths at a commit, as `git ls-tree -r --name-only` lists them. */
export function treePaths(repo, commit) {
  return git(repo.dir, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit]).split('\0').filter(Boolean);
}

/** A fetchListedCommit double that fetches, for real, from this repository as the listing's mirror. */
export function fetchingFrom(repo, calls = []) {
  return async (req) => {
    calls.push(req);
    return fetchListedCommit({ ...req, mirror: repo.dir });
  };
}
