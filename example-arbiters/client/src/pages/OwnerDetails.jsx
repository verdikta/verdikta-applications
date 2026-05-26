/**
 * OwnerDetails Page
 * Per-owner drill-down reached by clicking an owner in the analytics
 * "Arbiters by Owner" table. Lists every arbiter the owner controls, grouped by
 * operator address, with a clickable ADDRESS and the same JOB ID mouseover
 * detail the page formerly showed per class. Data comes from /api/arbiters/owned
 * for the header-selected network (read-only; no wallet needed).
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Users, ExternalLink } from 'lucide-react';
import { useNetwork } from '../context/NetworkContext';
import { chainForNetwork } from '../config/chains';
import { apiService } from '../services/api';
import './OwnerDetails.css';

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function OwnerDetails() {
  const { address } = useParams();
  const { selectedNetwork: network } = useNetwork();
  const chain = chainForNetwork(network);
  const explorer = chain.explorer;

  const [arbiters, setArbiters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiService.getOwnedArbiters(address, network);
        if (cancelled) return;
        if (!res.success) throw new Error(res.error || 'Failed to load owner details');
        // Flatten operators -> jobs into per-arbiter rows (address + jobId).
        const flat = [];
        for (const op of res.data.operators || []) {
          for (const j of op.jobs || []) {
            flat.push({
              address: op.operator,
              jobId: j.jobId,
              classes: j.classes,
              status: j.status,
              callCount: j.callCount,
              qualityScore: j.qualityScore,
              timelinessScore: j.timelinessScore,
              fee: j.fee
            });
          }
        }
        setArbiters(flat);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load owner details');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [address, network]);

  const distinctAddresses = new Set(arbiters.map((a) => a.address.toLowerCase())).size;

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

  // Sort by address so multiple job IDs from the same operator group together.
  const sorted = [...arbiters].sort((a, b) =>
    a.address.toLowerCase().localeCompare(b.address.toLowerCase())
  );

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
              {sorted.map((arb, i) => {
                const prevAddr = i > 0 ? sorted[i - 1].address.toLowerCase() : null;
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
    </div>
  );
}

export default OwnerDetails;
