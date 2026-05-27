/**
 * OwnerDetails Page
 * Per-owner drill-down reached by clicking an owner in the analytics
 * "Arbiters by Owner" table. Lists every arbiter the owner controls, grouped by
 * operator address, with a clickable ADDRESS and the same JOB ID mouseover
 * detail the page formerly showed per class. Data comes from /api/arbiters/owned
 * for the header-selected network (read-only; no wallet needed).
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
import '../styles/funding.css';
import './OwnerDetails.css';

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function OwnerDetails() {
  const { address } = useParams();
  const location = useLocation();
  const { selectedNetwork: network } = useNetwork();
  const chain = chainForNetwork(network);
  const explorer = chain.explorer;

  const [operators, setOperators] = useState([]);
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
      callCount: j.callCount,
      qualityScore: j.qualityScore,
      timelinessScore: j.timelinessScore,
      fee: j.fee,
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
                        `Status: ${arb.status ?? 'N/A'}`,
                        `Call Count: ${arb.callCount ?? 'N/A'}`,
                        `Quality Score: ${arb.qualityScore ?? 'N/A'}`,
                        `Timeliness Score: ${arb.timelinessScore ?? 'N/A'}`,
                        `Fee: ${arb.fee != null ? `${arb.fee} LINK` : 'N/A'}`
                      ].filter(Boolean).join('\n')}>
                        {arb.jobId}
                      </code>
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
