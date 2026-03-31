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
        const [classRes, analyticsRes] = await Promise.all([
          apiService.getClass(classId),
          apiService.getAnalyticsOverview()
        ]);

        if (classRes?.success) {
          setClassInfo(classRes.class);
        }

        // Extract arbiter list for this class from analytics data
        const byClass = analyticsRes?.arbiters?.byClass;
        if (byClass?.[classId]?.arbiterList) {
          setArbiters(byClass[classId].arbiterList);
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
              {arbiters.map((arb, i) => (
                <tr key={i}>
                  <td>
                    <a
                      href={`${networkConfig.explorer}/address/${arb.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <code>{arb.address}</code>
                    </a>
                  </td>
                  <td><code>{arb.jobId}</code></td>
                </tr>
              ))}
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
