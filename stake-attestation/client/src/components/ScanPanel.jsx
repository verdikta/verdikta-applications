import { useEffect, useId, useRef, useState } from 'react';

import { ApiError, readScan, scanChallenge } from '../lib/api.js';
import { STRINGS, fill } from '../strings.js';
import { useWalletContext, walletMessage } from './wallet.js';

const S = STRINGS.scan;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const READABLE = new Set(['done', 'error']);

function Finding({ f }) {
  if (f.tool === 'agent') {
    return <li>{fill(S.agentFinding, { class: f.class, title: f.title, paths: (f.paths ?? []).join(', '), demonstration: f.demonstration ?? '' })}</li>;
  }
  return <li>{fill(S.toolFinding, { tool: f.tool, rule: f.rule, severity: f.severity, path: f.path, line: f.line, message: f.message })}</li>;
}

/** The scan's document as the builder wrote it: its notice, status, tools, files and findings. */
function ScanDoc({ result }) {
  const doc = result.scan;
  if (!doc) return <p className="error">{fill(S.stopped, { code: result.error?.code ?? 'SCAN_FAILED', detail: result.error?.detail ?? '' })}</p>;
  const tools = Object.entries(doc.tools ?? {});
  return (
    <div data-testid="scan-doc">
      {doc.notice && <p className="warning">{doc.notice}</p>}
      <p>{fill(S.docStatus, { status: doc.status })}</p>
      {doc.error && <p className="error">{fill(S.stopped, { code: doc.error.code, detail: doc.error.detail })}</p>}
      <h4>{S.tools}</h4>
      <ul className="inline">{tools.map(([name, t]) => <li key={name}>{fill(S.tool, { name, status: t.status })}</li>)}</ul>
      <p>{fill(S.files, { inScope: doc.files?.inScope?.length ?? 0, skipped: doc.files?.skipped?.length ?? 0 })}</p>
      <h4>{fill(S.findings, { count: doc.findings?.length ?? 0 })}</h4>
      {doc.findings?.length ? <ul data-testid="scan-findings">{doc.findings.map((f, i) => <Finding key={i} f={f} />)}</ul> : <p>{S.none}</p>}
    </div>
  );
}

/**
 * The baseline scan of a listing in the listing flow (design §8.3): its public status from the
 * listing view and, once it finished, its findings for the wallet the request named, read with a
 * signed sign-in challenge (EIP-191 personal_sign). The findings live in this component's state
 * only: never stored, never sent anywhere. They are shown only while that wallet is the connected
 * one: a wallet that switches account, chain or disconnects (the app then forgets it) clears them,
 * and an answer that arrives after such a switch is dropped.
 */
export function ScanPanel({ view }) {
  const w = useWalletContext();
  const id = useId();
  const [busy, setBusy] = useState(null); // signing | reading
  const [result, setResult] = useState(null); // { reader, answer }
  const [error, setError] = useState(null);
  const connected = useRef(null);
  connected.current = w.wallet?.account ?? null;
  const reader = result?.reader ?? null;
  useEffect(() => {
    if (reader && !same(connected.current, reader)) setResult(null);
  }, [w.wallet, reader]);
  const scan = view.scan;
  if (!scan) return null;
  const shown = result && same(connected.current, result.reader) ? result.answer : null;

  const read = async () => {
    setError(null);
    setBusy('signing');
    try {
      const { signer, account } = await w.ensure();
      if (!same(account, view.maker)) return setError(fill(S.notMaker, { maker: view.maker, account }));
      const ch = await scanChallenge(view.id);
      // sign only a challenge to read this listing's scan, for this wallet
      if (ch.action !== 'read-scan' || ch.resource !== `listing:${view.id}` || !same(ch.address, account)) return setError(fill(S.failed, { reason: 'CHALLENGE_MISMATCH' }));
      const signature = await signer.signMessage(ch.message);
      setBusy('reading');
      const answer = await readScan(view.id, { nonce: ch.nonce, signature });
      // the wallet may have switched while the scan was read: then it is not shown
      if (same(connected.current, account)) setResult({ reader: account, answer });
    } catch (err) {
      setError(fill(S.failed, { reason: err instanceof ApiError ? (err.body?.error ?? err.message) : walletMessage(err) }));
    } finally {
      setBusy(null);
    }
    return undefined;
  };

  return (
    <section className="report" aria-labelledby={id} data-testid="scan-panel">
      <h3 id={id}>{S.title}</h3>
      <p className="hint">{S.intro}</p>
      <p data-testid="scan-status">{fill(S.status, { status: S.statuses[scan.status] ?? scan.status })}</p>
      {scan.status === 'skipped' && <p className="hint">{S.noWallet}</p>}
      {READABLE.has(scan.status) && view.maker && !shown && (
        <button type="button" onClick={read} disabled={busy !== null}>{busy === 'signing' ? S.signing : busy === 'reading' ? S.reading : S.read}</button>
      )}
      {shown && <ScanDoc result={shown} />}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
