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

// The chain side of the server (node P4b1), every answer of its indexed block:
//
//   GET  /api/feed                       the listings that take claims (design §15)
//   GET  /api/records/:hash              the record mirror: recordByHash, labels, badge, history
//   GET  /api/records/:hash/badge.svg    the badge
//
// and the dispute statement's pin (node P6b), for the listing's maker only, signed in with the
// wallet (EIP-191 personal_sign of the server's challenge, as the baseline scan's results are):
//
//   POST /api/claims/:id/dispute-statement/challenge  {} -> the challenge
//   POST /api/claims/:id/dispute-statement            { nonce, signature, statement } -> { cid, ... }

/** The site's feed; throws ApiError (503 when the server has no deployment). */
export async function getFeed() {
  const res = await fetch('/api/feed', { credentials: 'same-origin', cache: 'no-store' });
  const out = await json(res);
  if (!res.ok) throw new ApiError(res.status, out);
  return out;
}

/** The record of an artifact hash, or null when no listing of it has opened. */
export async function getRecord(hash) {
  const res = await fetch(`/api/records/${encodeURIComponent(hash)}`, { credentials: 'same-origin', cache: 'no-store' });
  const out = await json(res);
  if (res.status === 404 && out?.error === 'RECORD_NOT_FOUND') return null;
  if (!res.ok) throw new ApiError(res.status, out);
  return out;
}

/** The badge's path on this site (same origin). */
export const badgePath = (hash) => `/api/records/${hash.toLowerCase()}/badge.svg`;

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const out = await json(res);
  if (!res.ok) throw new ApiError(res.status, out);
  return out;
}

/** A sign-in challenge for pinning a statement on the claim, naming its listing's maker. */
export const disputeStatementChallenge = (claimId) => post(`/api/claims/${encodeURIComponent(claimId)}/dispute-statement/challenge`, {});

/** Pins the statement once the maker's signature of the challenge checks; resolves { cid, ... }. */
export const pinDisputeStatement = (claimId, { nonce, signature, statement }) => post(`/api/claims/${encodeURIComponent(claimId)}/dispute-statement`, { nonce, signature, statement });

// The baseline scan's findings, for the wallet the listing request named (node P4b2):
//
//   POST /api/listings/:id/scan/challenge  {} -> the challenge
//   POST /api/listings/:id/scan            { nonce, signature } -> { id, maker, status, scan, error }

/** A sign-in challenge for reading the listing's scan. */
export const scanChallenge = (id) => post(`/api/listings/${encodeURIComponent(id)}/scan/challenge`, {});

/** The scan's document, once the named wallet's signature of the challenge checks. */
export const readScan = (id, { nonce, signature }) => post(`/api/listings/${encodeURIComponent(id)}/scan`, { nonce, signature });
