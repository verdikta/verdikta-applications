// Doubles for the baseline scan (design §8.3; node P4b2): a scan document shaped as the
// builder's scan-findings.json (builder/src/scan.js), a scanner stand-in behind the interface the
// listing flow uses (scan({ spec }) resolves to { status, doc, error, holdSlot? }), wallets for
// the maker and for someone else, and the sign-in round trip a client makes. Every finding and
// error text carries a canary, a string made per run, so a test can look for it anywhere the
// findings must never reach. No Docker, no Semgrep, no secret scanner, no provider.
import crypto from 'node:crypto';
import { Wallet } from 'ethers';

/** A string no fixture contains: the mark of the scan's findings. */
export function canary() {
  return `scan-canary-${crypto.randomBytes(12).toString('hex')}`;
}

/** A fresh wallet (its key lives only in this test process). */
export function wallet() {
  return Wallet.createRandom();
}

/**
 * The builder's scan document for `spec`: status 'ok' with three findings, or 'error' with the
 * builder's error, each carrying `mark`.
 */
export function scanDoc(spec, { status = 'ok', mark = canary() } = {}) {
  const stake = spec.stake ?? {};
  const ok = status === 'ok';
  return {
    version: 1,
    kind: 'verdikta-baseline-scan',
    audience: 'maker',
    notice: 'For the maker only. Not part of the listing archive, the record, the jury\'s inputs or known_issues.json.',
    builder: { version: '0.1.0' },
    createdAt: '2026-11-02T00:00:00Z',
    status,
    listing: { repo: spec.repo, baseCommit: spec.baseCommit, artifact: spec.artifact ?? { kind: 'repo' }, lowestClassCounted: stake.lowestClassCounted ?? null, scope: stake.scope ?? null },
    files: { inScope: ['src/Vault.sol', `src/${mark}.sol`], skipped: [] },
    tools: {
      semgrep: { version: '1.181.0', status: ok ? 'ok' : 'failed', analysed: ok ? 2 : 0, notScanned: [], errors: [] },
      secrets: { tool: 'gitleaks', version: '8.30.1', status: ok ? 'ok' : 'not_run', notScanned: [] },
      agent: ok ? { status: 'ok', provider: 'openrouter', model: 'a-model', files: 2, truncated: [], dropped: 0 } : { status: 'off' },
    },
    findings: ok ? [
      { tool: 'semgrep', rule: 'verdikta.solidity.tx-origin-auth', severity: 'error', path: 'src/Vault.sol', line: 12, endLine: 12, message: `tx.origin decides who may withdraw (${mark})` },
      { tool: 'gitleaks', rule: 'generic-api-key', severity: 'error', path: `src/${mark}.sol`, line: 4, endLine: 4, message: `Detected a Generic API Key ${mark}` },
      { tool: 'agent', class: 'HIGH', title: `Withdraw re-enters before the balance is cleared ${mark}`, paths: ['src/Vault.sol'], rootCause: mark, demonstration: `call withdraw from a contract whose receive() calls it again (${mark})` },
    ] : [],
    error: ok ? null : { code: 'SCAN_TOOL_FAILED', detail: `semgrep exited 2 near ${mark}` },
  };
}

/**
 * The scanner stand-in. `outcome`:
 *   'ok'          the scan ran: findings for the maker
 *   'error'       the scan ran and failed: the builder's document says why
 *   'step-error'  the scan step itself failed: no document, the server's error
 *   'throws'      scan() rejects, with the canary in the message
 * `delayMs` holds each scan open (Infinity: until release()). `onScan(input)` runs at the start
 * of each scan, before the delay (to see what has happened by then).
 */
export function fakeScanner({ outcome = 'ok', mark = canary(), delayMs = 0, onScan = null, holdSlot = false } = {}) {
  const calls = [];
  let release = null;
  const gate = delayMs === Infinity ? new Promise((r) => { release = r; }) : null;
  return {
    calls,
    mark,
    release: () => release?.(),
    async scan({ spec }) {
      calls.push({ spec: structuredClone(spec) });
      onScan?.({ spec });
      if (gate) await gate;
      else if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const extra = holdSlot ? { holdSlot: true } : {};
      if (outcome === 'throws') throw new Error(`the scanner fell over reading ${mark}`);
      if (outcome === 'step-error') return { status: 'error', doc: null, error: { code: 'SCAN_STEP_FAILED', detail: 'the builder\'s scan step exited 1' }, ...extra };
      const doc = scanDoc(spec, { status: outcome === 'error' ? 'error' : 'ok', mark });
      return { status: doc.status, doc, error: null, ...extra };
    },
  };
}

/** Asks the server for a challenge for `id` and signs its message with `signer`. */
export async function signedChallenge(s, id, signer) {
  const res = await s.post(`/api/listings/${id}/scan/challenge`, {});
  const challenge = await res.json();
  if (res.status !== 200) return { res, challenge, body: null };
  const signature = await signer.signMessage(challenge.message);
  return { res, challenge, body: { nonce: challenge.nonce, signature } };
}

/** The whole round trip: a challenge, the signature, then POST /api/listings/:id/scan. */
export async function readScan(s, id, signer) {
  const c = await signedChallenge(s, id, signer);
  if (!c.body) return { res: c.res, json: c.challenge, challenge: c.challenge };
  const res = await s.post(`/api/listings/${id}/scan`, c.body);
  return { res, json: await res.json(), challenge: c.challenge, body: c.body };
}

/** Waits until the listing's scan has finished (done, error or skipped) or the listing gave up on it. */
export async function settleScan(s, id, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const view = await (await s.get(`/api/listings/${id}`)).json();
    if (['done', 'error', 'skipped', 'not_run'].includes(view.scan?.status) && ['ready', 'refused', 'error'].includes(view.status)) return view;
    if (Date.now() > until) throw new Error(`listing ${id}: scan still ${view.scan?.status} (${view.status}) after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
