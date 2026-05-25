/**
 * ClassDetails Page
 * Lists every registered arbiter (address + job ID) for a class, with the same
 * hover detail shown on the Analytics availability table. Arbiter data comes
 * from the analytics overview's byClass[classId].arbiterList for the network
 * currently selected on the Analytics page (persisted in localStorage).
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Users } from 'lucide-react';
import { apiService } from '../services/api';
import './ClassDetails.css';

// Network toggle value -> block explorer base URL (mirrors server config.js).
const EXPLORERS = {
  base: 'https://basescan.org',
  base_sepolia: 'https://sepolia.basescan.org'
};
const NETWORK_LABELS = {
  base: 'Base Mainnet',
  base_sepolia: 'Base Sepolia Testnet'
};
const DEFAULT_NETWORK = 'base_sepolia';

function ClassDetails() {
  const { classId } = useParams();
  const network = localStorage.getItem('selectedNetwork') || DEFAULT_NETWORK;
  const explorer = EXPLORERS[network] || EXPLORERS[DEFAULT_NETWORK];

  const [classData, setClassData] = useState(null);
  const [arbiters, setArbiters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiService.getAnalyticsOverview(network);
        if (cancelled) return;
        if (!res.success) throw new Error(res.error || 'Failed to load class details');

        const cls = res.data?.arbiters?.byClass?.[classId];
        setClassData(cls || null);
        setArbiters(cls?.arbiterList || []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load class details');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [classId, network]);

  const distinctAddresses = new Set(arbiters.map(a => a.address.toLowerCase())).size;

  if (loading) {
    return (
      <div className="class-details">
        <div className="loading-state">Loading class {classId} details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="class-details">
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
    <div className="class-details">
      <Link to="/analytics" className="back-link">
        <ArrowLeft size={16} /> Back to Analytics
      </Link>

      <h1>Class {classId}{classData?.className ? ` — ${classData.className}` : ''}</h1>
      {classData?.classDescription && <p className="class-description">{classData.classDescription}</p>}
      <p className="network-note">Network: {NETWORK_LABELS[network] || network}</p>

      <section className="class-section">
        <h2><Users size={18} className="inline-icon" /> Registered Arbiters</h2>
        <p className="section-summary">
          {arbiters.length} arbiter{arbiters.length !== 1 ? 's' : ''} from {distinctAddresses} distinct address{distinctAddresses !== 1 ? 'es' : ''}
        </p>
        {arbiters.length > 0 ? (
          <table className="class-table">
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
          <p className="empty-state">No arbiters registered for this class.</p>
        )}
      </section>
    </div>
  );
}

export default ClassDetails;
