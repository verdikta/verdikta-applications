// The stake-attestation server's listing API, same-origin under /api (vite.config.js proxies it
// in development and preview; the site serves both from one origin):
//
//   POST /api/listings      { spec, knownIssues?, allowlist? } -> 202 the listing's view;
//                           400 { error, issues }, 429 every build slot taken, 413 too large
//   GET  /api/listings/:id  the view: status, validation report, and once ready both CIDs and
//                           the arguments of list()
//
// The body holds the draft code_review.json with the disclosure key's public half; nothing the
// maker keeps private is in it.
const TERMINAL = new Set(['ready', 'refused', 'error']);

export class ApiError extends Error {
  constructor(status, body) {
    super(`the server answered ${status}${body?.error ? `: ${body.error}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function submitListing(body) {
  const res = await fetch('/api/listings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const out = await json(res);
  if (res.status !== 202) throw new ApiError(res.status, out);
  return out;
}

export async function getListing(id) {
  const res = await fetch(`/api/listings/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
  const out = await json(res);
  if (!res.ok) throw new ApiError(res.status, out);
  return out;
}

/**
 * Polls the listing until it is ready, refused or in error, calling onView with each view. A
 * build can take many minutes, so the interval grows from `intervalMs` to `maxIntervalMs`.
 */
export async function followListing(id, onView, { intervalMs = 500, maxIntervalMs = 5000, signal } = {}) {
  let wait = intervalMs;
  for (;;) {
    if (signal?.aborted) return null;
    const view = await getListing(id);
    onView(view);
    if (TERMINAL.has(view.status)) return view;
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(maxIntervalMs, Math.round(wait * 1.5));
  }
}
