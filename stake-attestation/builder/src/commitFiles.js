// The listed commit's tree, for the verified-source check, from objects the builder fetched
// itself: the commit by its id (git's index-pack computed every object id from its bytes, so a
// fetched object is what its id says), and each submodule the same way, by the commit its gitlink
// records. Never the env image's checkout or objects: a maker's setup ran as root there and could
// have rewritten either. A submodule that cannot be fetched is left out, as the code-runner leaves
// one whose objects the image lacks: an empty directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BuilderError, Refusal } from './errors.js';
import { fetchListedCommit, gitEnv } from './git.js';
import { run, tail } from './proc.js';

const MAX_DEPTH = 8;
// The code-runner's bounds on a checkout (code-runner/README.md, "The forced checkout").
const MAX_ENTRIES = 200000;
const MAX_BYTES = 512 * 1024 * 1024;
const MODES = new Set(['100644', '100755', '120000']);

async function git(gitDir, args, { timeoutMs, maxBytes, stdin = null }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-git-home-'));
  try {
    return await run('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '--git-dir', gitDir, ...args],
      { env: gitEnv({ home }), timeoutMs, maxBytes, stdin });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** A path git could check out on Linux: no empty, `.`, `..` or `.git` component, no NUL or newline. */
export function isTreePath(p) {
  if (!p || p.length > 4000 || /[\0\n\r]/.test(p)) return false;
  return p.split('/').every((c) => c !== '' && c !== '.' && c !== '..' && c.toLowerCase() !== '.git');
}

/** A submodule's https URL from the commit's .gitmodules; relative URLs resolve against the superproject's. */
async function submoduleUrl(gitDir, commit, subPath, superUrl, timeoutMs) {
  const list = await git(gitDir, ['config', '--blob', `${commit}:.gitmodules`, '--no-includes', '-z', '--get-regexp', '^submodule\\..*\\.path$'], { timeoutMs });
  if (list.exitCode !== 0) return null;
  let name = null;
  for (const rec of list.stdout.toString('utf8').split('\0')) {
    const nl = rec.indexOf('\n');
    if (nl !== -1 && rec.slice(nl + 1) === subPath) name = rec.slice('submodule.'.length, nl - '.path'.length);
  }
  if (name === null) return null;
  const u = await git(gitDir, ['config', '--blob', `${commit}:.gitmodules`, '--no-includes', '--get', `submodule.${name}.url`], { timeoutMs });
  if (u.exitCode !== 0) return null;
  return submoduleHttpsUrl(u.stdout.toString('utf8').trim(), superUrl);
}

/**
 * The https form of a submodule URL: relative URLs against the superproject's, and the ssh and
 * git:// forms of a host's repository as that host's https URL. The transport does not matter
 * for integrity: the submodule is fetched by the commit id its gitlink records.
 * @returns {string|null} null for anything else (file://, plain http, a local path)
 */
export function submoduleHttpsUrl(raw, superUrl) {
  let s = raw;
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(s);
  if (scp) s = `https://${scp[1]}/${scp[2]}`;
  else if (/^(?:ssh:\/\/(?:[A-Za-z0-9._-]+@)?|git:\/\/)/.test(s)) s = s.replace(/^(?:ssh:\/\/(?:[A-Za-z0-9._-]+@)?|git:\/\/)([^/:]+)(?::[0-9]+)?\//, 'https://$1/');
  let url;
  try {
    url = /^\.\.?\//.test(s) ? new URL(s, `${superUrl.replace(/\/+$/, '')}/`).href : new URL(s).href;
  } catch {
    return null;
  }
  return /^https:\/\/[^/\s]+\/\S+$/.test(url) && !/^https:\/\/[^/]*@/.test(url) ? url.replace(/\/$/, '') : null;
}

/** The blobs' bytes, by id, through one `git cat-file --batch`. */
async function readBlobs(gitDir, ids, timeoutMs) {
  const out = new Map();
  if (ids.length === 0) return out;
  const r = await git(gitDir, ['cat-file', '--batch'], { timeoutMs, maxBytes: MAX_BYTES + 64 * ids.length + 1024, stdin: `${ids.join('\n')}\n` });
  if (r.exitCode !== 0 || r.stdoutTruncated) throw new BuilderError('SOURCE_READ_FAILED', `git cat-file --batch: ${tail(r.stderr, 500).trim() || 'the output was cut'}`);
  const buf = r.stdout;
  let at = 0;
  for (const id of ids) {
    const nl = buf.indexOf(0x0a, at);
    const [got, type, size] = buf.subarray(at, nl).toString('utf8').split(' ');
    if (got !== id || type !== 'blob' || !/^[0-9]+$/.test(size)) throw new BuilderError('SOURCE_READ_FAILED', `git cat-file --batch did not return the blob ${id}`);
    const n = Number(size);
    out.set(id, buf.subarray(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return out;
}

/**
 * Every file of the listed commit, submodules included, with its mode and bytes.
 * @param {object} o
 * @param {string} o.gitDir - the bare repository fetchListedCommit made
 * @param {string} o.repo - code_review.json's repo (relative submodule URLs resolve against it)
 * @param {string} o.baseCommit
 * @param {(url: string) => string|null} [o.mirrorFor]
 * @param {string} o.workDir - where submodules are fetched
 * @returns {Promise<{ entries: { path: string, mode: string, bytes: Buffer }[], skipped: { path: string, detail: string }[] }>}
 * @throws {Refusal} SOURCE_TREE_INVALID (a path git could not check out, a tree over the runner's bounds)
 * @throws {BuilderError} SOURCE_READ_FAILED, REPO_FETCH_FAILED
 */
export async function commitTree({ gitDir, repo, baseCommit, mirrorFor = () => null, workDir, timeoutMs = 600000 }) {
  const entries = [];
  const skipped = [];
  let bytes = 0;
  let fetched = 0;

  async function walk(dir, commit, url, prefix, depth) {
    const r = await git(dir, ['ls-tree', '-r', '-z', '--full-tree', commit], { timeoutMs, maxBytes: 256 * 1024 * 1024 });
    if (r.exitCode !== 0 || r.stdoutTruncated) throw new BuilderError('SOURCE_READ_FAILED', `git ls-tree ${commit}: ${tail(r.stderr, 500).trim()}`);
    const blobs = [];
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const [mode, type, id] = rec.slice(0, tab).split(' ');
      const p = rec.slice(tab + 1);
      const full = `${prefix}${p}`;
      if (!isTreePath(full)) throw new Refusal('SOURCE_TREE_INVALID', `the listed commit has a path git cannot check out: ${JSON.stringify(full.slice(0, 200))}`);
      if (type === 'commit') {
        if (depth >= MAX_DEPTH) {
          skipped.push({ path: full, detail: `submodules nest deeper than ${MAX_DEPTH}` });
          continue;
        }
        const subUrl = await submoduleUrl(dir, commit, p, url, timeoutMs);
        if (!subUrl) {
          skipped.push({ path: full, detail: 'no https URL for it in .gitmodules' });
          continue;
        }
        const target = path.join(workDir, `submodule-${fetched}.git`);
        fetched += 1;
        try {
          await fetchListedCommit({ repo: subUrl, baseCommit: id, mirror: mirrorFor(subUrl), dir: target, timeoutMs });
        } catch (err) {
          if (!(err instanceof Refusal)) throw err;
          skipped.push({ path: full, detail: `${subUrl} has no commit ${id}` });
          continue;
        }
        await walk(target, id, subUrl, `${full}/`, depth + 1);
      } else if (type === 'blob' && MODES.has(mode)) {
        blobs.push({ path: full, mode, id });
      } else {
        throw new Refusal('SOURCE_TREE_INVALID', `the listed commit has an entry git cannot check out: ${JSON.stringify(full.slice(0, 200))} (${mode} ${type})`);
      }
    }
    if (entries.length + blobs.length > MAX_ENTRIES) throw new Refusal('SOURCE_TREE_INVALID', `the listed commit has more than ${MAX_ENTRIES} files`);
    const contents = await readBlobs(dir, [...new Set(blobs.map((b) => b.id))], timeoutMs);
    for (const b of blobs) {
      const content = contents.get(b.id);
      bytes += content.length;
      if (bytes > MAX_BYTES) throw new Refusal('SOURCE_TREE_INVALID', `the listed commit's files exceed ${MAX_BYTES} bytes`);
      entries.push({ path: b.path, mode: b.mode, bytes: content });
    }
  }

  await walk(gitDir, baseCommit, repo, '', 0);
  return { entries, skipped };
}
