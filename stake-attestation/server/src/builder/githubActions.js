// The few calls of GitHub's Actions API the listing flow makes, on one repository (the caller, node P15). The token
// is read from the environment for each call and goes nowhere but the Authorization header of a request to the
// configured API: never into an error, a log, a redirect or the config. An artifact's download answers with a
// redirect to storage, which gets no token.
const API_VERSION = '2022-11-28';

export class GithubApiError extends Error {
  /** @param {number} status - the HTTP status; 0: no answer */
  constructor(status, code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'GithubApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** https anywhere; plain http to a loopback host only. */
function storageUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  return u.protocol === 'https:' || (u.protocol === 'http:' && loopback) ? u : null;
}

async function readCapped(res, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw new GithubApiError(res.status, 'ARTIFACT_TOO_LARGE', `the artifact is larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {object} o
 * @param {string} o.apiUrl
 * @param {string} o.repo - owner/name
 * @param {string} o.file - the workflow's file name
 * @param {string} o.ref - the branch a run starts from
 * @param {string} o.tokenEnv - the variable the token is in
 * @param {number} [o.requestTimeoutMs]
 * @param {Record<string,string|undefined>} [o.env]
 */
export function createGithubActions({ apiUrl, repo, file, ref, tokenEnv, requestTimeoutMs = 30000, env = process.env }) {
  const base = `${apiUrl}/repos/${repo}/actions`;
  const workflow = `${base}/workflows/${encodeURIComponent(file)}`;

  function headers() {
    const token = env[tokenEnv];
    if (typeof token !== 'string' || !token) throw new GithubApiError(0, 'TOKEN_MISSING', `${tokenEnv} holds no token`);
    return { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': API_VERSION, 'user-agent': 'verdikta-stake-attestation' };
  }

  async function call(method, url, { body, redirect = 'error', maxBytes } = {}) {
    const init = { method, headers: headers(), redirect, signal: AbortSignal.timeout(requestTimeoutMs) };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new GithubApiError(0, 'GITHUB_UNREACHABLE', err?.name ?? 'error');
    }
    if (redirect === 'manual' && res.status >= 300 && res.status < 400) return res;
    if (!res.ok) {
      await res.arrayBuffer().catch(() => null);
      throw new GithubApiError(res.status, 'GITHUB_REFUSED', `${method} answered ${res.status}`);
    }
    if (maxBytes) return readCapped(res, maxBytes);
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new GithubApiError(res.status, 'GITHUB_ANSWER_INVALID', 'the answer is not JSON');
    }
  }

  return {
    /** @returns {Promise<number|null>} the run's id when GitHub says it: an answer of 204 does not */
    async dispatch(inputs) {
      const answer = await call('POST', `${workflow}/dispatches`, { body: { ref, inputs } });
      return Number.isSafeInteger(answer?.workflow_run_id) ? answer.workflow_run_id : null;
    },
    /** The workflow's runs from the branch, by dispatch, newest first. */
    async listRuns({ page = 1, perPage = 100 } = {}) {
      const q = new URLSearchParams({ event: 'workflow_dispatch', branch: ref, per_page: String(perPage), page: String(page) });
      const answer = await call('GET', `${workflow}/runs?${q}`);
      return Array.isArray(answer?.workflow_runs) ? answer.workflow_runs : [];
    },
    getRun: (id) => call('GET', `${base}/runs/${id}`),
    cancel: (id) => call('POST', `${base}/runs/${id}/cancel`),
    forceCancel: (id) => call('POST', `${base}/runs/${id}/force-cancel`),
    async artifacts(id) {
      const answer = await call('GET', `${base}/runs/${id}/artifacts?per_page=100`);
      return Array.isArray(answer?.artifacts) ? answer.artifacts : [];
    },
    async approvals(id) {
      const answer = await call('GET', `${base}/runs/${id}/approvals`);
      return Array.isArray(answer) ? answer : [];
    },
    /** An artifact's bytes, at most `maxBytes`: the API redirects, and storage gets no token. */
    async download(artifactId, maxBytes) {
      const answer = await call('GET', `${base}/artifacts/${artifactId}/zip`, { redirect: 'manual' });
      const location = storageUrl(answer.headers?.get?.('location') ?? '');
      if (!location) throw new GithubApiError(answer.status ?? 0, 'ARTIFACT_LOCATION_REFUSED', 'the artifact does not redirect to a location the site reads');
      let res;
      try {
        res = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs * 4) });
      } catch (err) {
        throw new GithubApiError(0, 'GITHUB_UNREACHABLE', err?.name ?? 'error');
      }
      if (!res.ok) throw new GithubApiError(res.status, 'GITHUB_REFUSED', `the artifact's storage answered ${res.status}`);
      return readCapped(res, maxBytes);
    },
  };
}
