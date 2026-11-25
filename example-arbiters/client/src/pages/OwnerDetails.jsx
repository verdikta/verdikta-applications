/**
 * OwnerDetails Page
 * Per-owner drill-down reached by clicking an owner in the analytics
 * "Arbiters by Owner" table. Lists every arbiter the owner controls, grouped by
 * operator address, with a clickable ADDRESS and the same JOB ID mouseover
 * detail the page formerly showed per class. Data comes from /api/arbiters/owned
 * for the header-selected network (read-only; no wallet needed).
 *
 * Each arbiter row shows its two scores, offenses, health-call (freeze) state and
 * exit time; the header shows the owner's claimable ETH on the aggregator.
 *
 * Also shows a read-only Node Funding section (#funding) — each operator's
 * sending-key ETH balances + estimated query runway — reached from the Node ETH
 * cell in the analytics table. Mirrors the My Arbiters funding panel minus the
 * fund controls (this page has no wallet).
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { ArrowLeft, Users, ExternalLink, Fuel } from 'lucide-react';
import { useNetwork } from '../context/NetworkContext';
import { chainForNetwork } from '../config/chains';
import { apiService } from '../services/api';
import { estQueriesFor, fmtQueries } from '../utils/funding';
import { STATUS_LABELS, REASON_TEXT, reasonLines } from '../utils/arbiterRegistration';
import '../styles/funding.css';
import './OwnerDetails.css';

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmtTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : null);

// Health-call state of one arbiter: frozen (call unanswered past the deadline,
// or re-syncing its chain), a call waiting for an answer, or none.
function healthState(j) {
  if (j.frozen || (j.statusReasons || []).includes('resyncing')) {
    return { label: 'Frozen', title: `Health call sent ${fmtTime(j.callSentAt) || '—'}, not answered in time` };
  }
  if ((j.statusReasons || []).includes('callPending')) {
    return { label: 'Call pending', title: `Health call sent ${fmtTime(j.callSentAt) || '—'}` };
  }
  return { label: 'OK', title: j.callAnsweredAt ? `Last answered ${fmtTime(j.callAnsweredAt)}` : undefined };
}

function OwnerDetails() {
  const { address } = useParams();
  const location = useLocation();
  const { selectedNetwork: network } = useNetwork();
  const chain = chainForNetwork(network);
  const explorer = chain.explorer;

  const [operators, setOperators] = useState([]);
  const [claimableEth, setClaimableEth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fundingRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiService.getOwnedArbiters(address, network);
        if (cancelled) return;
        if (!res.success) throw new Error(res.error || 'Failed to load owner details');
        setOperators(res.data.operators || []);
        setClaimableEth(res.data.claimableEth ?? null);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load owner details');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [address, network]);

  // Scroll to the funding section when arrived via the Node ETH link (#funding).
  useEffect(() => {
    if (!loading && !error && location.hash === '#funding' && fundingRef.current) {
      fundingRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [loading, error, location.hash]);

  if (loading) {
    return (
      <div className="owner-details">
        <div className="loading-state">Loading arbiters for {shortAddr(address)}...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="owner-details">
        <Link to="/analytics" className="back-link"><ArrowLeft size={16} /> Back to Analytics</Link>
        <div className="error-state">{error}</div>
      </div>
    );
  }

  // Sorted operators so multiple job IDs / funding panels group consistently.
  const sortedOps = [...operators].sort((a, b) =>
    a.operator.toLowerCase().localeCompare(b.operator.toLowerCase())
  );

  // Flatten operators -> jobs into per-arbiter rows (address + jobId).
  const arbiters = sortedOps.flatMap((op) =>
    (op.jobs || []).map((j) => ({
      address: op.operator,
      jobId: j.jobId,
      classes: j.classes,
      status: j.status,
      statusReasons: j.statusReasons,
      offenses: j.offenses,
      stake: j.stake,
      qualityScore: j.qualityScore,
      timelinessScore: j.timelinessScore,
      fee: j.fee,
      frozen: j.frozen,
      callSentAt: j.callSentAt,
      callAnsweredAt: j.callAnsweredAt,
      exitAt: j.exitAt,
      exit: j.exit,
      understakedBy: j.understakedBy,
      understakedUnflagged: j.understakedUnflagged,
    }))
  );
  const distinctAddresses = sortedOps.length;

  const fundedOps = sortedOps.filter((op) => op.funding && op.funding.senders);

  return (
    <div className="owner-details">
      <Link to="/analytics" className="back-link">
        <ArrowLeft size={16} /> Back to Analytics
      </Link>

      <h1>Owner Details</h1>
      <p className="owner-address-line">
        <a href={`${explorer}/address/${address}`} target="_blank" rel="noopener noreferrer">
          <code>{address}</code> <ExternalLink size={12} />
        </a>
      </p>
      <p className="network-note">Network: {chain.name}</p>
      <p className="network-note" title="ETH this owner can withdraw from the aggregator's ethOwed ledger: arbiter base fees, bonuses, committer shares and arbiter pool payouts across its operators, plus any draw / promote rewards and refunds it earned">
        Claimable: <strong>{claimableEth ?? '—'}</strong> ETH
      </p>

      <section className="owner-section">
        <h2><Users size={18} className="inline-icon" /> Registered Arbiters</h2>
        <p className="section-summary">
          {arbiters.length} arbiter{arbiters.length !== 1 ? 's' : ''} from {distinctAddresses} operator{distinctAddresses !== 1 ? 's' : ''}
        </p>
        {arbiters.length > 0 ? (
          <table className="owner-table">
            <thead>
              <tr>
                <th>Address</th>
                <th>Job ID</th>
                <th>Status</th>
                <th>Quality</th>
                <th>Timeliness</th>
                <th>Offenses</th>
                <th title="Health-call state: an unanswered call past the keeper's deadline freezes the arbiter">Health call</th>
                <th title="When completeExit is allowed (exitAt), for an arbiter that requested its exit">Exit</th>
              </tr>
            </thead>
            <tbody>
              {arbiters.map((arb, i) => {
                const prevAddr = i > 0 ? arbiters[i - 1].address.toLowerCase() : null;
                const isGroupStart = arb.address.toLowerCase() !== prevAddr;
                return (
                  <tr key={`${arb.address}-${arb.jobId}-${i}`} className={isGroupStart && i > 0 ? 'group-start' : ''}>
                    <td>
                      <a
                        href={`${explorer}/address/${arb.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <code>{arb.address}</code>
                      </a>
                    </td>
                    <td>
                      <code title={[
                        arb.classes?.length ? `Capability Classes: ${arb.classes.join(', ')}` : '',
                        `Status: ${STATUS_LABELS[arb.status] || arb.status || 'N/A'}`,
                        `Quality Score: ${arb.qualityScore ?? 'N/A'}`,
                        `Timeliness Score: ${arb.timelinessScore ?? 'N/A'}`,
                        `Offenses: ${arb.offenses ?? 'N/A'}`,
                        `Stake: ${arb.stake != null ? `${arb.stake} wVDKA` : 'N/A'}`,
                        `Fee: ${arb.fee != null ? `${arb.fee} ETH` : 'N/A'}`
                      ].filter(Boolean).join('\n')}>
                        {arb.jobId}
                      </code>
                    </td>
                    <td title={[
                      ...reasonLines(arb.statusReasons),
                      arb.understakedUnflagged ? REASON_TEXT.understakedUnflagged : null,
                    ].filter(Boolean).join('\n')}>
                      {STATUS_LABELS[arb.status] || arb.status || '—'}
                    </td>
                    <td>{arb.qualityScore ?? '—'}</td>
                    <td>{arb.timelinessScore ?? '—'}</td>
                    <td>{arb.offenses ?? '—'}</td>
                    <td title={healthState(arb).title}>{healthState(arb).label}</td>
                    <td>
                      {!arb.exit || arb.exit.state === 'none' ? '—'
                        : arb.exit.state === 'unbonding' ? `unbonding until ${fmtTime(arb.exitAt) || '—'}`
                          : arb.exit.state === 'ready' ? `ready since ${fmtTime(arb.exitAt) || '—'}`
                            : 'unbonded; waiting out a block'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="empty-state">No arbiters registered to this owner.</p>
        )}
      </section>

      <section className="owner-section" id="funding" ref={fundingRef}>
        <h2><Fuel size={18} className="inline-icon" /> Node Funding</h2>
        <p className="section-summary">
          Sending-key ETH balances per operator — the gas these nodes spend answering queries.
        </p>
        {fundedOps.length > 0 ? (
          fundedOps.map((op) => {
            const f = op.funding;
            return (
              <div className="owner-funding-op" key={op.operator}>
                <div className="owner-funding-op-head">
                  <a href={`${explorer}/address/${op.operator}`} target="_blank" rel="noopener noreferrer" title={op.operator}>
                    <code>{shortAddr(op.operator)}</code> <ExternalLink size={12} />
                  </a>
                </div>
                <div className={`funding-panel${f.low ? ' low' : ''}`}>
                  <div className="funding-summary">
                    <span className="funding-summary-main">
                      <Fuel size={15} className="inline-icon" />
                      <strong>{Number(f.totalEth).toFixed(4)}</strong> ETH across {f.senders.length} node key{f.senders.length !== 1 ? 's' : ''}
                      <span className="funding-sep">·</span>
                      <span
                        className="funding-est"
                        title={`Estimate: balance ÷ (${f.gasPerQuery.toLocaleString()} gas/query × ${f.gasPriceGwei} gwei). Changes with gas price.`}
                      >
                        ~{fmtQueries(f.estQueries)} queries of gas
                      </span>
                      {f.low && <span className="funding-low-badge">Low</span>}
                    </span>
                  </div>

                  <div className="fund-keys">
                    <div className="fund-key fund-key-ro fund-key-head">
                      <span>Sending key</span><span>Balance</span><span>~Queries</span>
                    </div>
                    {f.senders.map((s) => (
                      <div className="fund-key fund-key-ro" key={s.address}>
                        <a href={`${explorer}/address/${s.address}`} target="_blank" rel="noopener noreferrer" title={s.address}>
                          <code>{shortAddr(s.address)}</code>
                        </a>
                        <span>{Number(s.balanceEth).toFixed(4)} ETH</span>
                        <span>{fmtQueries(estQueriesFor(s.balanceEth, f))}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <p className="empty-state">No funding data available for this owner's operators.</p>
        )}
      </section>
    </div>
  );
}

export default OwnerDetails;
