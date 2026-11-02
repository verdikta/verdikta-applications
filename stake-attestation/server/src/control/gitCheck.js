// The site's git check: builder/bin/verdikta-control-check.js in a process of its own, with PATH,
// HOME and a temporary folder only, and its own deadline, which the server backs with a stop. No
// answer is an error with a code the fact can state; what the process printed goes nowhere else.
import fs from 'node:fs';
import path from 'node:path';

import { childEnv, runStep } from '../builder/cli.js';
import { mirrorPath } from './facts.js';

export class RepositoryCheckError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'RepositoryCheckError';
    this.code = code;
  }
}

const DEFAULT_GRACE_MS = 2000;
const REF = /^refs\/(?:heads|tags)\/[\x21-\x7e]{1,240}$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const unavailable = (detail) => new RepositoryCheckError('REPO_UNAVAILABLE', detail);

/** The process's answer, held to its format: about this repository and commit, or no answer. */
export function readCheckAnswer(stdout, { repo, commit }) {
  let a;
  try {
    a = JSON.parse(stdout);
  } catch {
    throw unavailable('the check printed no JSON');
  }
  if (!a || a.version !== 1 || a.repo !== repo || a.commit !== commit || typeof a.reachable !== 'boolean') throw unavailable('the check\'s answer is about something else');
  if (a.ref !== null && !(typeof a.ref === 'string' && REF.test(a.ref))) throw unavailable('the check named no branch or tag');
  if (!a.reachable) {
    if (a.file !== null || a.ref !== null) throw unavailable('the check read a commit that is not reachable');
    return { reachable: false, ref: null, file: null };
  }
  if (a.file === null) return { reachable: true, ref: a.ref, file: null };
  const f = a.file;
  if (!f || !OBJECT_ID.test(f.blob) || !(f.text === null || typeof f.text === 'string') || !(f.problem === null || typeof f.problem === 'string')) throw unavailable('the check\'s file entry is malformed');
  return { reachable: true, ref: a.ref, file: { blob: f.blob, text: f.text, problem: f.problem } };
}

/**
 * @param {{ bin: string, workDir: string, mirrorDir: string|null, timeoutMs: number, maxBytes: number, graceMs?: number }} cfg
 * @param {{ env?: Record<string, string|undefined>, nodePath?: string, mirrorFor?: (url: string) => string|null }} [o]
 * @returns {(o: { repo: string, commit: string }) => Promise<{ reachable: boolean, ref: string|null, file: object|null }>}
 * @throws {RepositoryCheckError} REPO_UNAVAILABLE, REPO_TOO_LARGE
 */
export function createRepositoryChecker(cfg, { env = process.env, nodePath = process.execPath, mirrorFor } = {}) {
  const mirrorOf = mirrorFor ?? ((url) => (cfg.mirrorDir ? mirrorPath(cfg.mirrorDir, url) : null));
  const graceMs = cfg.graceMs ?? DEFAULT_GRACE_MS;
  return async ({ repo, commit }) => {
    const dir = fs.mkdtempSync(path.join(cfg.workDir, 'sa-control-'));
    try {
      const tmp = path.join(dir, 'tmp');
      fs.mkdirSync(tmp);
      const mirror = mirrorOf(repo);
      const args = ['--repo', repo, '--commit', commit, '--timeout-ms', String(cfg.timeoutMs), '--max-bytes', String(cfg.maxBytes), ...(mirror ? ['--mirror', mirror] : [])];
      const r = await runStep({ nodePath, bin: cfg.bin, args, env: childEnv(env, [], tmp), timeoutMs: cfg.timeoutMs + graceMs, graceMs, cwd: dir });
      if (r.interrupted) throw unavailable('the check was stopped at its time limit');
      if (r.spawnError) throw unavailable('the check could not be started');
      if (r.code !== 0) {
        const code = /verdikta-control-check: ([A-Z][A-Z0-9_]{0,63})\b/.exec(r.stderr.toString('utf8'))?.[1];
        if (code === 'REPO_TOO_LARGE') throw new RepositoryCheckError('REPO_TOO_LARGE', 'the repository is over the size the site reads');
        throw unavailable(`the check exited ${r.code}${code ? `: ${code}` : ''}`);
      }
      return readCheckAnswer(r.stdout.toString('utf8'), { repo, commit });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
}
