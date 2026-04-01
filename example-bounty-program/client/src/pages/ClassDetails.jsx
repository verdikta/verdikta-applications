/**
 * ClassDetails Page
 * Shows available models for a class and all arbiter address/jobID pairs.
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Cpu, Users } from 'lucide-react';
import { apiService } from '../services/api';
import { config } from '../config';
import './ClassDetails.css';

const networkConfig = config.networks[config.network] || config.networks['base-sepolia'];

function ClassDetails() {
  const { classId } = useParams();
  const [classInfo, setClassInfo] = useState(null);
  const [arbiters, setArbiters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [classRes, analyticsRes] = await Promise.allSettled([
          apiService.getClass(classId),
          apiService.getAnalyticsOverview()
        ]);

        if (classRes.status === 'fulfilled' && classRes.value?.success) {
          setClassInfo(classRes.value.class);
        }

        // Extract arbiter list for this class from analytics data
        if (analyticsRes.status === 'fulfilled') {
          const byClass = analyticsRes.value?.data?.arbiters?.byClass;
          if (byClass?.[classId]?.arbiterList) {
            setArbiters(byClass[classId].arbiterList);
          }
        }

        // Only error if both failed
        if (classRes.status === 'rejected' && analyticsRes.status === 'rejected') {
          throw new Error('Failed to load class details');
        }
      } catch (err) {
        setError(err.message || 'Failed to load class details');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [classId]);

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
        <div className="error-state">{error}</div>
      </div>
    );
  }

  return (
    <div className="class-details">
      <Link to="/analytics" className="back-link">
        <ArrowLeft size={16} /> Back to Analytics
      </Link>

      <h1>Class {classId}{classInfo?.name ? ` — ${classInfo.name}` : ''}</h1>
      {classInfo?.description && <p className="class-description">{classInfo.description}</p>}
      {classInfo?.status && <span className={`class-status status-${classInfo.status.toLowerCase()}`}>{classInfo.status}</span>}

      <section className="class-section">
        <h2><Cpu size={18} className="inline-icon" /> Available Models</h2>
        {classInfo?.models?.length > 0 ? (
          <table className="class-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
              </tr>
            </thead>
            <tbody>
              {classInfo.models.map((m, i) => (
                <tr key={i}>
                  <td>{m.provider}</td>
                  <td><code>{m.model}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-state">No models configured for this class.</p>
        )}
      </section>

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
              {(() => {
                // Only sort if not already grouped by address
                const isGrouped = arbiters.every((arb, i) =>
                  i === 0 || arb.address.toLowerCase() === arbiters[i - 1].address.toLowerCase() ||
                  !arbiters.slice(0, i - 1).some(a => a.address.toLowerCase() === arb.address.toLowerCase())
                );
                return isGrouped ? arbiters : [...arbiters].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
              })().map((arb, i, sorted) => {
                const prevAddr = i > 0 ? sorted[i - 1].address.toLowerCase() : null;
                const isGroupStart = arb.address.toLowerCase() !== prevAddr;
                return (
                  <tr key={i} className={isGroupStart && i > 0 ? 'group-start' : ''}>
                    <td>
                      <a
                        href={`${networkConfig.explorer}/address/${arb.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <code>{arb.address}</code>
                      </a>
                    </td>
                    <td>
                      <code title={arb.classes?.length ? `Capability Classes: ${arb.classes.join(', ')}` : ''}>
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
