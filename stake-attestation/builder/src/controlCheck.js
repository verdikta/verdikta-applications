// What git says about a listing's repository, for the site's fact "staker controls the repository"
// (node P8, design §4.1, OWNER_QUEUE Q33): whether the listed commit is on the repository's own
// branches or tags, and, only if it is, the proof file at that commit. The site decides the fact;
// this reads and answers.
//
// Why reachability is checked apart from the fetch: a git host serves a commit by its id without
// asking what holds it, and on GitHub a fork shares the parent's object store, so
// `git fetch https://github.com/<parent> <id>` returns a stranger's commit from their fork (an
// imposter commit), and it may also be advertised under refs/pull/<n>/head. Only the repository's
// refs/heads/* and refs/tags/* say what the repository's writers put there, so those are the only
// refs fetched, and a commit counts only if one of them contains it.
//
// What it costs: a partial fetch of the commit graph (--filter=tree:0: commit objects only, no tree
// or blob), then, for a reachable commit, the commit's trees at depth 1 (--filter=blob:none) and
// the one blob, by its id. A host that ignores the filters sends more; the byte cap holds either way.
//
// Every step is bounded: one deadline over the whole check, a byte cap on what the fetches write,
// a much smaller one on the proof's blob, and each is enforced on git's whole process group, since
// its transport and pack processes write on after git itself is killed. git runs as builder/src/git.js runs it (no system or
// global config, no hooks, no credential helper or prompt, https only), and here also with no
// redirects, no background maintenance and no lazy fetch of a missing object: a partial repository
// would otherwise fetch by id the very commit whose absence the check looks for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BuilderError } from './errors.js';
import { gitEnv, hardening } from './git.js';
import { run, tail } from './proc.js';

export const CONTROL_FILE = '.verdikta/stake-control.json';
export const CONTROL_FILE_MAX_BYTES = 4096;
// A pack holding one small blob is far below this; a larger download means a larger blob.
const BLOB_FETCH_CAP_BYTES = 256 * 1024;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REPO = /^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s@?#]+)+$/;
const REF = /^refs\/(?:heads|tags)\/[\x21-\x7e]{1,240}$/;
const WATCH_MS = 100;
const FILE_MODES = new Set(['100644', '100755']);

const NO_LAZY_FETCH = Object.freeze({ GIT_NO_LAZY_FETCH: '1' });

function dirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirBytes(p);
      else total += fs.lstatSync(p).size;
    } catch { /* a temporary file git just renamed */ }
  }
  return total;
}

/**
 * Where a repository is read from: its mirror, or its URL in the .git form, which the hosts serve
 * directly (gitlab.com redirects the other form, and redirects are off).
 */
export const fetchSource = (repo, mirror = null) => mirror || (repo.endsWith('.git') ? repo : `${repo}.git`);

/**
 * @param {object} o
 * @param {string} o.repo - the listing's https repository URL
 * @param {string} o.baseCommit - a full lowercase commit id
 * @param {string|null} [o.mirror] - a path or https URL serving the same repository
 * @param {number} o.timeoutMs - over the whole check
 * @param {number} o.maxBytes - what the fetches may write
 * @param {string} [o.file] - the proof's path in the commit
 * @returns {Promise<{ reachable: boolean, ref: string|null, file: null|{ path: string, mode: string, blob: string, size: number|null, text: string|null, problem: null|'NOT_A_REGULAR_FILE'|'TOO_LARGE'|'NOT_UTF8' } }>}
 * @throws {BuilderError} REPO_FETCH_FAILED, REPO_TOO_LARGE, REPO_CHECK_TIMEOUT: no answer
 */
export async function checkRepositoryControl({ repo, baseCommit, mirror = null, timeoutMs, maxBytes, file = CONTROL_FILE }) {
  if (typeof repo !== 'string' || !REPO.test(repo)) throw new TypeError('the listing\'s repo must be a plain https URL');
  if (typeof baseCommit !== 'string' || !COMMIT.test(baseCommit)) throw new TypeError('baseCommit must be a full lowercase commit id');
  const source = fetchSource(repo, mirror);
  const local = Boolean(mirror) && !/^https:\/\//.test(mirror);
  const deadline = Date.now() + timeoutMs;
  const expired = () => new BuilderError('REPO_CHECK_TIMEOUT', `the check did not finish in ${timeoutMs} ms`);
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw expired();
    return ms;
  };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-control-'));
  const env = { ...gitEnv({ home: work }), ...NO_LAZY_FETCH };
  const remoteOptions = [
    ...hardening(local),
    '-c', 'http.followRedirects=false',
    '-c', 'http.lowSpeedLimit=1024',
    '-c', 'http.lowSpeedTime=30',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'fetch.recurseSubmodules=false',
  ];
  // reads never reach a remote: with no transport allowed, a missing object stays missing
  const localOptions = ['--literal-pathspecs', '-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

  /** The result of a git call that must succeed. */
  const must = (r, what) => {
    if (r.timedOut) throw expired();
    if (r.exitCode !== 0) throw new BuilderError('REPO_FETCH_FAILED', `${what}: ${tail(r.stderr, 500).trim() || `git exited ${r.exitCode}`}`);
    return r;
  };
  /** A read of what was fetched; a timeout is never read as an answer. */
  const read = async (dir, args, opts = {}) => {
    const r = await run('git', [...localOptions, '--git-dir', dir, ...args], { env, timeoutMs: left(), group: true, ...opts });
    if (r.timedOut) throw expired();
    return r;
  };

  async function init(dir) {
    must(await run('git', [...remoteOptions, 'init', '--quiet', '--bare', '--template=', ...(baseCommit.length === 64 ? ['--object-format=sha256'] : []), dir], { env, timeoutMs: left(), group: true }), 'git init');
    // a named remote: git keeps a partial fetch's promise only for one (a bare path is refused)
    must(await run('git', [...remoteOptions, '-C', dir, 'config', 'remote.origin.url', source], { env, timeoutMs: left(), group: true }), 'git config');
  }

  /** A fetch stopped by the deadline or the byte cap. @returns the result, or 'too-large' */
  async function fetchBounded(dir, args, cap, options = []) {
    const stop = new AbortController();
    let over = false;
    const watch = setInterval(() => {
      if (dirBytes(dir) > cap) {
        over = true;
        stop.abort();
      }
    }, WATCH_MS);
    let r;
    try {
      r = await run('git', [...remoteOptions, ...options, '-C', dir, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', ...args], { env, timeoutMs: left(), signal: stop.signal, group: true });
    } finally {
      clearInterval(watch);
    }
    if (over || dirBytes(dir) > cap) return 'too-large';
    return must(r, 'the repository could not be read');
  }

  const tooLarge = () => new BuilderError('REPO_TOO_LARGE', `reading the repository took more than ${maxBytes} bytes`);

  try {
    // the repository's own branches and tags, never refs/pull/* or any other ref the host advertises
    const graph = path.join(work, 'graph.git');
    await init(graph);
    const fetched = await fetchBounded(graph, ['--filter=tree:0', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'], maxBytes);
    if (fetched === 'too-large') throw tooLarge();

    if ((await read(graph, ['cat-file', '-e', `${baseCommit}^{commit}`])).exitCode !== 0) return { reachable: false, ref: null, file: null };
    const contains = must(await read(graph, ['for-each-ref', '--contains', baseCommit, '--count=1', '--format=%(refname)', 'refs/remotes/origin', 'refs/tags']), 'git for-each-ref');
    const refName = contains.stdout.toString('utf8').trim().replace(/^refs\/remotes\/origin\//, 'refs/heads/');
    if (!refName) return { reachable: false, ref: null, file: null };
    const ref = REF.test(refName) ? refName : null;

    // the proof, from the commit's own trees
    const snapshot = path.join(work, 'snapshot.git');
    await init(snapshot);
    const trees = await fetchBounded(snapshot, ['--depth', '1', '--filter=blob:none', 'origin', baseCommit], maxBytes);
    if (trees === 'too-large') throw tooLarge();
    const entry = must(await read(snapshot, ['ls-tree', '-z', baseCommit, file]), 'git ls-tree');
    const line = entry.stdout.toString('utf8').split('\0')[0];
    if (!line) return { reachable: true, ref, file: null };
    const [meta] = line.split('\t');
    const [mode, type, blob] = meta.split(' ');
    const found = { path: file, mode, blob, size: null, text: null, problem: null };
    if (type !== 'blob' || !FILE_MODES.has(mode)) return { reachable: true, ref, file: { ...found, problem: 'NOT_A_REGULAR_FILE' } };

    if ((await read(snapshot, ['cat-file', '-e', blob])).exitCode !== 0) {
      // no haves, as git's own fetch of a missing blob: the commit it holds must not rule the blob out
      const one = await fetchBounded(snapshot, ['--filter=blob:none', 'origin', blob], dirBytes(snapshot) + BLOB_FETCH_CAP_BYTES, ['-c', 'fetch.negotiationAlgorithm=noop']);
      if (one === 'too-large') return { reachable: true, ref, file: { ...found, problem: 'TOO_LARGE' } };
    }
    const sized = must(await read(snapshot, ['cat-file', '-s', blob]), 'the proof\'s blob could not be read');
    const size = Number(sized.stdout.toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size > CONTROL_FILE_MAX_BYTES) return { reachable: true, ref, file: { ...found, size: Number.isSafeInteger(size) ? size : null, problem: 'TOO_LARGE' } };
    const bytes = must(await read(snapshot, ['cat-file', 'blob', blob], { maxBytes: CONTROL_FILE_MAX_BYTES + 1 }), 'the proof\'s blob could not be read');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.stdout);
    } catch {
      return { reachable: true, ref, file: { ...found, size, problem: 'NOT_UTF8' } };
    }
    return { reachable: true, ref, file: { ...found, size, text } };
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
