/**
 * Reporting keys section for My Arbiters.
 *
 * Arbiter nodes push watchdog health events to POST /api/alerts, and the
 * server authenticates each one by recovering its signature and requiring the
 * signer to be the operator contract's on-chain owner(). Operators who run
 * their nodes under a separate ops wallet therefore have every heartbeat
 * dropped, and their arbiters show as "not reporting" on /analytics — with no
 * indication why.
 *
 * Copying the owner key onto the node is the wrong fix: that key controls the
 * wVDKA stake, the keeper's exit and fee controls, and ETH earnings. Instead, the owner signs a
 * delegation here — an EIP-191 personal message, no transaction and no gas —
 * naming an address allowed to report on its behalf until an expiry it picks.
 * The site stores the attestation and ingest then accepts owner *or* delegate.
 * Nothing on the arbiter node changes; the watchdog keeps sending exactly what
 * it sends today.
 *
 * The section leads with the discovery path: any key that recently tried to
 * report for one of this owner's operators and was turned away is listed as a
 * pending candidate with a one-click Authorize, so the owner never has to go
 * find the address themselves. A candidate proves only that someone holds that
 * key — authorizing it still takes the owner's signature.
 *
 * Signing is chain-agnostic (personal_sign carries no chain), so this works
 * even when the wallet is on a different network than the one selected.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  KeyRound,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  ShieldCheck,
  Trash2,
  Server,
} from 'lucide-react';
import { isValidAddress } from '../utils/arbiterRegistration';
import { apiService } from '../services/api';

const DAY_MS = 86400000;
const EXPIRY_CHOICES = [30, 90, 180, 365];
const DEFAULT_EXPIRY_DAYS = 90;

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const nowSec = () => Math.floor(Date.now() / 1000);

/** Canonical network key — must match the server's normalizeNetwork(). */
const canonicalNetwork = (n) => String(n || '').replace(/_/g, '-').toLowerCase();

/**
 * The exact text the owner signs. Must match delegationMessage() in
 * server/routes/alertsRoutes.js byte for byte, or the recovered signer won't
 * match and the server will reject it. Timestamps are unix seconds.
 */
function delegationMessage({ action, owner, network, delegate, expiresAtSec, issuedAtSec }) {
  const base = `verdikta-arbiter-reporter:v1:${action}:${String(owner).toLowerCase()}`
    + `:${canonicalNetwork(network)}:${String(delegate).toLowerCase()}`;
  return action === 'add'
    ? `${base}:${expiresAtSec}:${issuedAtSec}`
    : `${base}:${issuedAtSec}`;
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, {
  year: 'numeric', month: 'short', day: 'numeric',
});

/** "3 hours ago" / "2 days ago", for last-attempt timestamps. */
function fmtAgo(ms) {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function ReportingKeysSection({ network, owner, chain, getSigner, toast }) {
  const [open, setOpen] = useState(false);
  const [delegations, setDelegations] = useState([]);
  const [pendingReporters, setPendingReporters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);      // address currently being signed for
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [expiryDays, setExpiryDays] = useState(DEFAULT_EXPIRY_DAYS);

  const load = useCallback(async () => {
    if (!owner) return;
    setLoading(true);
    try {
      // Both are best-effort: a failure here should never blank the page, and
      // the pending listing does an on-chain owner lookup that can be slow.
      const [dRes, pRes] = await Promise.allSettled([
        apiService.getReportingDelegations(owner, network),
        apiService.getPendingReporters(owner, network),
      ]);
      setDelegations(dRes.status === 'fulfilled' && dRes.value?.success
        ? dRes.value.data.delegations : []);
      setPendingReporters(pRes.status === 'fulfilled' && pRes.value?.success
        ? pRes.value.data.pending : []);
    } finally {
      setLoading(false);
    }
  }, [owner, network]);

  useEffect(() => { load(); }, [load]);

  // A candidate is worth surfacing before the section is even opened, so the
  // header carries the count and the section self-opens the first time one
  // appears (never fighting a user who has closed it since).
  const [autoOpened, setAutoOpened] = useState(false);
  useEffect(() => {
    if (pendingReporters.length > 0 && !autoOpened) {
      setOpen(true);
      setAutoOpened(true);
    }
  }, [pendingReporters.length, autoOpened]);

  const authorize = async (delegate, delegateLabel, days) => {
    if (!isValidAddress(delegate)) {
      toast.error('Enter a valid address to authorize.');
      return;
    }
    if (delegate.toLowerCase() === String(owner).toLowerCase()) {
      toast.error('That is the owner address — it can already report.');
      return;
    }
    setBusy(delegate.toLowerCase());
    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
      const issuedAtSec = nowSec();
      const expiresAtSec = issuedAtSec + days * 86400;
      const sig = await signer.signMessage(delegationMessage({
        action: 'add', owner, network, delegate, expiresAtSec, issuedAtSec,
      }));
      const res = await apiService.addReportingDelegation({
        network, owner, delegate, expiresAt: expiresAtSec, issuedAt: issuedAtSec, sig,
        label: delegateLabel || null,
      });
      if (!res.success) throw new Error(res.error || 'Failed to authorize reporting key');
      toast.success(`${shortAddr(delegate)} can now report for your arbiters`);
      setAddress('');
      setLabel('');
      await load();
    } catch (err) {
      // MetaMask surfaces a user rejection as code 4001 / ACTION_REJECTED.
      const msg = err?.code === 4001 || err?.code === 'ACTION_REJECTED'
        ? 'Signature rejected.'
        : err?.response?.data?.error || err.message || 'Failed to authorize reporting key';
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (delegate) => {
    setBusy(delegate.toLowerCase());
    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
      const issuedAtSec = nowSec();
      const sig = await signer.signMessage(delegationMessage({
        action: 'revoke', owner, network, delegate, issuedAtSec,
      }));
      const res = await apiService.revokeReportingDelegation({
        network, owner, delegate, issuedAt: issuedAtSec, sig,
      });
      if (!res.success) throw new Error(res.error || 'Failed to revoke reporting key');
      toast.success(`${shortAddr(delegate)} can no longer report`);
      await load();
    } catch (err) {
      const msg = err?.code === 4001 || err?.code === 'ACTION_REJECTED'
        ? 'Signature rejected.'
        : err?.response?.data?.error || err.message || 'Failed to revoke reporting key';
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const addressValid = isValidAddress(address);
  const pendingCount = pendingReporters.length;

  return (
    <section className="analytics-section reporting-keys-section">
      <button className="register-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        <KeyRound size={18} className="inline-icon" />
        <h2>Reporting keys</h2>
        <span className="register-toggle-hint">
          Let a node running under a different wallet report health for your arbiters
        </span>
        {pendingCount > 0 && (
          <span className="reporting-badge" title="Addresses waiting to be authorized">
            {pendingCount} waiting
          </span>
        )}
      </button>

      {open && (
        <div className="register-body">
          <p className="register-intro">
            Your arbiter nodes push health reports that are signed and checked against the operator
            contract&rsquo;s owner. If a node runs under a different wallet than the one that owns
            the operator, its reports are rejected and the arbiter shows as{' '}
            <strong>not reporting</strong> on Analytics. Authorize that wallet here instead of
            putting your owner key — which controls your stake and earnings — on the node.
            Authorizing is a signature only: <strong>no transaction and no gas</strong>, and nothing
            on the node needs to change.
          </p>

          {/* Discovery: keys that tried to report and were turned away. */}
          {pendingCount > 0 && (
            <div className="pending-reporters">
              <h3><AlertTriangle size={15} className="warn-icon" /> Waiting to be authorized</h3>
              {pendingReporters.map((p) => (
                <div className="pending-reporter" key={`${p.operator}:${p.signer}`}>
                  <div className="pending-reporter-info">
                    <div className="pending-reporter-main">
                      <Server size={14} className="inline-icon" />
                      {p.hostname ? <strong>{p.hostname}</strong> : <strong>A node</strong>}
                      {' is trying to report for operator '}
                      <code>{shortAddr(p.operator)}</code>
                    </div>
                    <div className="pending-reporter-meta muted">
                      key <code title={p.signer}>{shortAddr(p.signer)}</code>
                      {' · '}{p.attempts} rejected {p.attempts === 1 ? 'attempt' : 'attempts'}
                      {' · last '}{fmtAgo(p.lastSeenAt)}
                    </div>
                  </div>
                  <button
                    className="btn btn-primary btn-with-icon"
                    onClick={() => authorize(p.signer, p.hostname, expiryDays)}
                    disabled={busy != null}
                    title={`Authorize ${p.signer} to report for ${expiryDays} days`}
                  >
                    <ShieldCheck size={14} />
                    {busy === p.signer.toLowerCase() ? 'Signing…' : `Authorize for ${expiryDays}d`}
                  </button>
                </div>
              ))}
              <p className="pending-reporter-note muted">
                Each entry is backed by a valid signature from that key, so it proves someone holds
                it — not that they should be trusted. Authorize only keys you recognize as your own
                nodes.
              </p>
            </div>
          )}

          {/* Currently authorized. */}
          <div className="reporting-current">
            <h3>Authorized keys</h3>
            {loading && delegations.length === 0 && <p className="muted">Loading…</p>}
            {!loading && delegations.length === 0 && (
              <p className="muted">
                None. Only <code>{shortAddr(owner)}</code> can report for your arbiters right now.
              </p>
            )}
            {delegations.length > 0 && (
              <table className="reporting-table">
                <thead>
                  <tr><th>Key</th><th>Label</th><th>Expires</th><th></th></tr>
                </thead>
                <tbody>
                  {delegations.map((d) => (
                    <tr key={d.delegate}>
                      <td><code title={d.delegate}>{shortAddr(d.delegate)}</code></td>
                      <td>{d.label || <span className="muted">—</span>}</td>
                      <td>{fmtDate(d.expiresAt)}</td>
                      <td className="reporting-actions-cell">
                        <button
                          className="btn btn-secondary btn-with-icon"
                          onClick={() => revoke(d.delegate)}
                          disabled={busy != null}
                          title="Stop accepting reports signed by this key"
                        >
                          <Trash2 size={13} />
                          {busy === d.delegate.toLowerCase() ? 'Signing…' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Manual entry, for a node that hasn't attempted a report yet. */}
          <div className="reporting-add">
            <h3>Authorize an address</h3>
            <div className="register-fields">
              <label className="reset-field">
                <span>Reporting address</span>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="0x…"
                  aria-invalid={address !== '' && !addressValid}
                />
              </label>
              <label className="reset-field">
                <span>Label (optional)</span>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. mainnet node 1"
                  maxLength={80}
                />
              </label>
              <label className="reset-field">
                <span>Expires after</span>
                <select value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))}>
                  {EXPIRY_CHOICES.map((d) => (
                    <option key={d} value={d}>{d} days</option>
                  ))}
                </select>
              </label>
            </div>
            {address !== '' && !addressValid && (
              <div className="reset-edit-error">Invalid address.</div>
            )}
            <div className="register-actions">
              <button
                className="btn btn-primary btn-with-icon"
                onClick={() => authorize(address.trim(), label.trim(), expiryDays)}
                disabled={!addressValid || busy != null}
              >
                <ShieldCheck size={14} />
                {busy === address.trim().toLowerCase() ? 'Signing…' : 'Authorize reporting key'}
              </button>
              <span className="register-chain-hint">
                Signing only — no transaction, no gas. Works on {chain.name} regardless of which
                network your wallet is currently on.
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default ReportingKeysSection;
