// Is this repository a fork? The record labels it from the host's own API (node P9, acceptance 5):
// GitHub's `fork` and `parent`, GitLab's `forked_from_project`, Gitea's (Codeberg's) `fork` and
// `parent`, Bitbucket's `parent`. A plain copy, pushed to a new repository, is no fork to any host and
// cannot be detected, and the record says so. Whatever is not a clear answer is "unknown": a host
// with no API here, a URL the site does not read, a rate limit, an error, a hang, an answer too large
// or in another shape. Each request is bounded in time and bytes, and runs beside the indexer
// (src/control/index.js), never inside it.
//
// The token (SA_GITHUB_TOKEN, optional) is read from the environment when used and goes only to
// api.github.com. It only raises GitHub's rate limit: everything works without it.
import { assertWording } from '../wording.js';
import { repoUrlCheck } from './facts.js';

export const FORK_NOTE = assertWording('The host\'s API knows forks made with its fork button. A plain copy pushed to a new repository cannot be detected.');
export const FORK_TIMEOUT_MS = 10000;
const MAX_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT_WAIT_MS = 3600_000;

const ownerAndName = (repo, host) => {
  const m = new RegExp(`^https://${host.replace(/\./g, '\\.')}/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+?)(?:\\.git)?$`).exec(repo);
  return m ? { owner: m[1], name: m[2] } : null;
};

const HOSTS = Object.freeze({
  'github.com': {
    url: (repo) => {
      const p = ownerAndName(repo, 'github.com');
      return p && `https://api.github.com/repos/${p.owner}/${p.name}`;
    },
    answer: (j) => (typeof j.fork === 'boolean' ? { fork: j.fork, parent: j.parent?.html_url } : null),
    token: 'SA_GITHUB_TOKEN',
  },
  'gitlab.com': {
    url: (repo) => {
      const m = /^https:\/\/gitlab\.com\/([A-Za-z0-9._/-]+?)(?:\.git)?$/.exec(repo);
      return m && `https://gitlab.com/api/v4/projects/${encodeURIComponent(m[1])}`;
    },
    answer: (j) => (j.forked_from_project ? { fork: true, parent: j.forked_from_project.web_url } : (typeof j.id === 'number' ? { fork: false, parent: null } : null)),
  },
  'codeberg.org': {
    url: (repo) => {
      const p = ownerAndName(repo, 'codeberg.org');
      return p && `https://codeberg.org/api/v1/repos/${p.owner}/${p.name}`;
    },
    answer: (j) => (typeof j.fork === 'boolean' ? { fork: j.fork, parent: j.parent?.html_url } : null),
  },
  'bitbucket.org': {
    url: (repo) => {
      const p = ownerAndName(repo, 'bitbucket.org');
      return p && `https://api.bitbucket.org/2.0/repositories/${p.owner}/${p.name}`;
    },
    answer: (j) => (j.parent ? { fork: true, parent: j.parent.links?.html?.href } : (typeof j.name === 'string' ? { fork: false, parent: null } : null)),
  },
});

const unknown = (host, reason, extra = {}) => ({ status: 'unknown', parent: null, host, reason, ...extra });

async function readCapped(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** How long a rate-limited answer asks to wait, in ms. */
function rateLimitWait(res, now) {
  const retry = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retry) && retry > 0) return retry * 1000;
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset * 1000 > now) return reset * 1000 - now;
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

/**
 * @param {object} o
 * @param {number} o.timeoutMs - per request
 * @param {Record<string, string|undefined>} o.env - where the token is read, when used
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.maxBytes]
 * @param {() => number} [o.now]
 * @returns {(o: { repo: string }) => Promise<{ status: 'fork'|'not-fork'|'unknown', parent: string|null, host: string|null, reason?: string, retryAfterMs?: number }>}
 */
export function createForkChecker({ timeoutMs, env, fetch: fetchImpl = globalThis.fetch, maxBytes = MAX_BYTES, now = Date.now }) {
  return async ({ repo }) => {
    const known = Object.keys(HOSTS);
    const check = repoUrlCheck(repo, known);
    if (!check.ok) return unknown(null, 'HOST_HAS_NO_API');
    const { host } = check;
    const api = HOSTS[host];
    const url = api.url(repo);
    if (!url) return unknown(host, 'NOT_READ');
    const token = api.token ? env[api.token] : null;
    const headers = { accept: 'application/json', 'user-agent': 'verdikta-stake-attestation' };
    if (typeof token === 'string' && token.trim()) headers.authorization = `Bearer ${token.trim()}`;
    try {
      const res = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after')))) {
        return unknown(host, 'RATE_LIMITED', { retryAfterMs: rateLimitWait(res, now()) });
      }
      if (!res.ok) return unknown(host, `HTTP_${res.status}`);
      const text = await readCapped(res, maxBytes);
      if (text === null) return unknown(host, 'TOO_LARGE');
      const a = api.answer(JSON.parse(text));
      if (!a) return unknown(host, 'SHAPE');
      const parent = a.fork && repoUrlCheck(String(a.parent ?? '').replace(/\/+$/, ''), [host]).ok ? String(a.parent).replace(/\/+$/, '') : null;
      return { status: a.fork ? 'fork' : 'not-fork', parent, host };
    } catch {
      // the error's own text can quote the URL, and no reader needs it
      return unknown(host, 'UNAVAILABLE');
    }
  };
}

/** The record's fork label from a stored answer. */
export function forkView(entry) {
  const status = entry?.status ?? 'unknown';
  return { status, parent: entry?.parent ?? null, host: entry?.host ?? null, checkedAt: entry?.checkedAt ? Math.floor(entry.checkedAt / 1000) : null, note: FORK_NOTE };
}
