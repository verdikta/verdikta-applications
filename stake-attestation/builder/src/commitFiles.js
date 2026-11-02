// The listed commit's files, for the verified-source check, from objects the builder fetched
// itself: the commit by its id (git's index-pack computed every object id from its bytes, so a
// fetched object is what its id says), and each submodule the same way, by the commit its gitlink
// records. Never the env image's checkout or objects: a maker's setup ran as root there and could
// have rewritten either.
//
// A path the commit does not track (a dependency the setup installed) is read from the image's
// /repo, which is what the code-runner keeps of it for every claim, in a sandbox in which nothing
// of the listing's runs: only the base image's sh, test and base64.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runSandboxed } from './docker.js';
import { BuilderError, Refusal } from './errors.js';
import { fetchListedCommit, gitEnv } from './git.js';
import { run, tail } from './proc.js';

const MAX_DEPTH = 8;

function hardening() {
  return ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never'];
}

async function git(gitDir, args, timeoutMs, maxBytes) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-git-home-'));
  try {
    return await run('git', [...hardening(), '--git-dir', gitDir, ...args], { env: gitEnv({ home }), timeoutMs, maxBytes });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Every entry of a commit's tree: path -> { mode, type, id }. */
async function treeOf(gitDir, commit, timeoutMs) {
  const r = await git(gitDir, ['ls-tree', '-r', '-t', '-z', '--full-tree', commit], timeoutMs, 256 * 1024 * 1024);
  if (r.exitCode !== 0 || r.stdoutTruncated) throw new BuilderError('SOURCE_READ_FAILED', `git ls-tree ${commit}: ${tail(r.stderr, 500).trim()}`);
  const entries = new Map();
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, id] = rec.slice(0, tab).split(' ');
    entries.set(rec.slice(tab + 1), { mode, type, id });
  }
  return entries;
}

/** A submodule's https URL from the commit's .gitmodules, relative URLs against the superproject's. */
async function submoduleUrl(gitDir, commit, subPath, superUrl, timeoutMs) {
  const list = await git(gitDir, ['config', '--blob', `${commit}:.gitmodules`, '--no-includes', '-z', '--get-regexp', '^submodule\\..*\\.path$'], timeoutMs);
  if (list.exitCode !== 0) return null;
  let name = null;
  for (const rec of list.stdout.toString('utf8').split('\0')) {
    const nl = rec.indexOf('\n');
    if (nl === -1) continue;
    if (rec.slice(nl + 1) === subPath) name = rec.slice('submodule.'.length, nl - '.path'.length);
  }
  if (name === null) return null;
  const u = await git(gitDir, ['config', '--blob', `${commit}:.gitmodules`, '--no-includes', '--get', `submodule.${name}.url`], timeoutMs);
  if (u.exitCode !== 0) return null;
  const raw = u.stdout.toString('utf8').trim();
  let url;
  try {
    url = /^\.\.?\//.test(raw) ? new URL(raw, `${superUrl.replace(/\/+$/, '')}/`).href : new URL(raw).href;
  } catch {
    return null;
  }
  return /^https:\/\/\S+$/.test(url) ? url.replace(/\/$/, '') : null;
}

/**
 * @param {object} o
 * @param {string} o.gitDir - the bare repository fetchListedCommit made
 * @param {string} o.repo - code_review.json's repo (relative submodule URLs resolve against it)
 * @param {string} o.baseCommit
 * @param {string[]} o.paths - repository-relative paths (sourceCheck.isSourcePath)
 * @param {(url: string) => string|null} [o.mirrorFor]
 * @param {string} o.workDir - where submodules are fetched
 * @param {number} [o.timeoutMs]
 * @returns {Promise<Map<string, { origin: 'commit'|'submodule'|'untracked'|'symlink'|'missing', bytes: Buffer|null, detail?: string }>>}
 */
export async function readCommitFiles({ gitDir, repo, baseCommit, paths, mirrorFor = () => null, workDir, timeoutMs = 600000 }) {
  const trees = new Map();
  const subs = new Map();
  const tree = async (dir, commit) => {
    const key = `${dir}\0${commit}`;
    if (!trees.has(key)) trees.set(key, await treeOf(dir, commit, timeoutMs));
    return trees.get(key);
  };
  const submodule = async (dir, commit, subPath, id, superUrl) => {
    const url = await submoduleUrl(dir, commit, subPath, superUrl, timeoutMs);
    if (!url) return { error: `the submodule at ${subPath} has no https URL in .gitmodules` };
    const key = `${url}\0${id}`;
    if (!subs.has(key)) {
      const target = path.join(workDir, `submodule-${id}-${subs.size}.git`);
      try {
        await fetchListedCommit({ repo: url, baseCommit: id, mirror: mirrorFor(url), dir: target, timeoutMs });
        subs.set(key, { gitDir: target, url });
      } catch (err) {
        if (!(err instanceof Refusal)) throw err;
        subs.set(key, { error: `the submodule at ${subPath} (${url}) has no commit ${id}` });
      }
    }
    return subs.get(key);
  };

  async function resolve(dir, commit, p, superUrl, depth, prefixShown) {
    const entries = await tree(dir, commit);
    const e = entries.get(p);
    if (e) {
      if (e.type === 'blob' && e.mode === '120000') return { origin: 'symlink', bytes: null, detail: `${prefixShown}${p} is a symbolic link in the listed commit` };
      if (e.type !== 'blob') return { origin: 'missing', bytes: null, detail: `${prefixShown}${p} is not a file in the listed commit` };
      const r = await git(dir, ['cat-file', 'blob', e.id], timeoutMs, 64 * 1024 * 1024);
      if (r.exitCode !== 0 || r.stdoutTruncated) throw new BuilderError('SOURCE_READ_FAILED', `git cat-file ${e.id}: ${tail(r.stderr, 500).trim()}`);
      return { origin: depth === 0 ? 'commit' : 'submodule', bytes: r.stdout };
    }
    const parts = p.split('/');
    for (let i = parts.length - 1; i >= 1; i -= 1) {
      const prefix = parts.slice(0, i).join('/');
      const pe = entries.get(prefix);
      if (!pe) continue;
      if (pe.type === 'commit') {
        if (depth >= MAX_DEPTH) return { origin: 'missing', bytes: null, detail: `submodules nest deeper than ${MAX_DEPTH} at ${prefixShown}${prefix}` };
        const sub = await submodule(dir, commit, prefix, pe.id, superUrl);
        if (sub.error) return { origin: 'missing', bytes: null, detail: sub.error };
        return resolve(sub.gitDir, pe.id, parts.slice(i).join('/'), sub.url, depth + 1, `${prefixShown}${prefix}/`);
      }
      if (pe.type === 'tree') break;
      return { origin: 'missing', bytes: null, detail: `${prefixShown}${prefix} is a file in the listed commit, not a directory` };
    }
    return { origin: 'untracked', bytes: null };
  }

  const out = new Map();
  for (const p of paths) out.set(p, await resolve(gitDir, baseCommit, p, repo, 0, ''));
  return out;
}

/**
 * Untracked files as the image's /repo holds them: path -> bytes, or null when absent.
 * @returns {Promise<Map<string, Buffer|null>>}
 */
export async function readUntrackedFromImage({ docker, image, platform, paths, timeoutMs = 300000 }) {
  const out = new Map(paths.map((p) => [p, null]));
  if (paths.length === 0) return out;
  const script = [
    'for p in "$@"; do',
    "  if [ -f \"/repo/$p\" ]; then printf 'F %s ' \"$(printf '%s' \"$p\" | base64 -w0)\"; base64 -w0 < \"/repo/$p\"; printf '\\n'; fi",
    'done',
  ].join('\n');
  const r = await runSandboxed({ docker, image, platform, argv: ['/bin/sh', '-c', script, 'vab-read', ...paths], timeoutMs, maxBytes: 128 * 1024 * 1024 });
  if (r.spawnError) throw new BuilderError('DOCKER_UNAVAILABLE', r.spawnError);
  if (r.exitCode !== 0 || r.timedOut || r.stdoutTruncated) throw new BuilderError('SOURCE_READ_FAILED', `the image's untracked files could not be read: ${tail(r.stderr, 1000).trim()}`);
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const [kind, name, body = ''] = line.split(' ');
    if (kind !== 'F') continue;
    const p = Buffer.from(name, 'base64').toString('utf8');
    if (out.has(p)) out.set(p, Buffer.from(body, 'base64'));
  }
  return out;
}
