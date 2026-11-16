// Fetching the listed commit (design §8.2 step 1: "clones repo at baseCommit").
//
// On the host the builder only fetches objects: into a fresh bare repository, by the commit's id
// (shallow when the server allows it), from the listing's https URL or a configured mirror of
// it. Nothing of the maker's tree is written as files here; the checkout happens inside the
// image's setup stage. git runs with no system or global config, no hooks, no credential helper
// or prompt, and no transport but https (and the local one for a mirror path).
//
// A fetch by id says the host holds the commit, not that the repository's writers put it there: on
// GitHub it can return a fork's commit through the parent's URL. controlCheck.js is what asks, and
// the build's control step (src/listingProof.js) refuses such a commit before this fetch runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BuilderError, Refusal } from './errors.js';
import { run, tail } from './proc.js';

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** git's whole environment: PATH, an empty HOME, no system or global config, no prompt. */
export function gitEnv({ home, base = process.env }) {
  return {
    PATH: base.PATH || '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

/** The options every git call that may touch a remote runs with. */
export function hardening(local) {
  return [
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    ...(local ? ['-c', 'protocol.file.allow=always'] : []),
    '-c', 'credential.helper=',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
  ];
}

/**
 * @param {object} o
 * @param {string} o.repo - code_review.json's https repository URL
 * @param {string} o.baseCommit
 * @param {string|null} [o.mirror] - a path or https URL serving the same repository
 * @param {string} o.dir - where the bare repository is made (must not exist)
 * @param {number} o.timeoutMs
 * @returns {Promise<{ gitDir: string, shallow: boolean, source: 'mirror'|'repo' }>}
 * @throws {Refusal} BASE_COMMIT_NOT_FOUND
 * @throws {BuilderError} REPO_FETCH_FAILED
 */
export async function fetchListedCommit({ repo, baseCommit, mirror = null, dir, timeoutMs }) {
  if (typeof repo !== 'string' || !/^https:\/\/\S+$/.test(repo)) throw new TypeError('the listing\'s repo must be an https URL');
  if (typeof baseCommit !== 'string' || !COMMIT.test(baseCommit)) throw new TypeError('baseCommit must be a full lowercase commit id');
  const source = mirror || repo;
  const local = Boolean(mirror) && !/^https:\/\//.test(mirror);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-git-home-'));
  const env = gitEnv({ home });
  const git = (args, cwd = dir) => run('git', [...hardening(local), '-C', cwd, ...args], { env, timeoutMs });
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const init = await run('git', [...hardening(local), 'init', '--quiet', '--bare', '--template=', ...(baseCommit.length === 64 ? ['--object-format=sha256'] : []), dir], { env, timeoutMs });
    if (init.exitCode !== 0) throw new BuilderError('REPO_FETCH_FAILED', `git init: ${tail(init.stderr, 1000).trim()}`, { step: 'fetch' });

    let shallow = true;
    const byId = await git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--depth', '1', source, baseCommit]);
    if (byId.exitCode !== 0) {
      // The server does not serve unadvertised commits: fetch its branches and tags instead.
      shallow = false;
      const all = await git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', source, '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']);
      if (all.exitCode !== 0) {
        throw new BuilderError('REPO_FETCH_FAILED', `the repository could not be fetched from ${mirror ? 'its mirror' : repo}: ${tail(all.stderr, 1000).trim() || `git exited ${all.exitCode}`}`, { step: 'fetch' });
      }
    }
    const type = await git(['cat-file', '-t', baseCommit]);
    if (type.exitCode !== 0 || type.stdout.toString('utf8').trim() !== 'commit') {
      throw new Refusal('BASE_COMMIT_NOT_FOUND', `${repo} has no commit ${baseCommit} reachable from its branches or tags`, { step: 'fetch' });
    }
    // Ready to be /repo/.git: relative submodule URLs resolve against the listed repository.
    for (const args of [['config', 'remote.origin.url', repo], ['config', 'core.bare', 'false']]) {
      const r = await git(args);
      if (r.exitCode !== 0) throw new BuilderError('REPO_FETCH_FAILED', `git ${args.join(' ')}: ${tail(r.stderr, 1000).trim()}`, { step: 'fetch' });
    }
    fs.rmSync(path.join(dir, 'FETCH_HEAD'), { force: true });
    return { gitDir: dir, shallow, source: mirror ? 'mirror' : 'repo' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
