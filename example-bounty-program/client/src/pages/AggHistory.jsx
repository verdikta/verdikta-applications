/**
 * Aggregation History Page
 * Shows full oracle evaluation lifecycle for a given Verdikta aggregation ID
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Activity,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Users,
  ExternalLink,
  ArrowLeft,
  Loader2
} from 'lucide-react';
import { apiService } from '../services/api';
import { config } from '../config';
import './AggHistory.css';

const networkConfig = config.networks[config.network] || config.networks['base-sepolia'];

function AggHistory() {
  const { aggId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function fetchHistory() {
      setLoading(true);
      setError(null);
      try {
        const result = await apiService.getAggHistory(aggId);
        setData(result.data);
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchHistory();
  }, [aggId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(aggId);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = aggId;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (loading) {
    return (
      <div className="agg-history">
        <div className="loading">
          <Loader2 size={32} className="spinning" />
          <p>Querying blockchain events...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="agg-history">
        <Link to="/" className="back-link"><ArrowLeft size={16} /> Back</Link>
        <div className="error-container">
          <AlertTriangle size={40} />
          <h2>Failed to load aggregation history</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!data || !data.found) {
    return (
      <div className="agg-history">
        <Link to="/" className="back-link"><ArrowLeft size={16} /> Back</Link>
        <div className="not-found">
          <AlertTriangle size={40} />
          <h2>Aggregation Not Found</h2>
          <p>{data?.message || 'No matching events found for this aggregation ID in the last 50,000 blocks.'}</p>
          <div className="agg-id-display" style={{ marginTop: '1rem', display: 'inline-block' }}>
            {aggId}
          </div>
        </div>
      </div>
    );
  }

  const { contractParams, aggregationStatus, requestEvent, slots, fulfillment, outcome, analysis } = data;

  const outcomeClass = outcome === 'COMPLETED' ? 'completed' : outcome === 'RUNNING' ? 'running' : 'failed';
  const OutcomeIcon = outcome === 'COMPLETED' ? CheckCircle : outcome === 'RUNNING' ? Clock : XCircle;

  return (
    <div className="agg-history">
      <Link to="/" className="back-link"><ArrowLeft size={16} /> Back</Link>

      {/* Header */}
      <div className="page-header">
        <div className="header-content">
          <h1><Activity size={28} /> Aggregation History</h1>
          <div className="agg-id-display">
            {aggId}
            <button className="copy-btn" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>

      {/* Outcome Banner */}
      <div className={`outcome-banner ${outcomeClass}`}>
        <OutcomeIcon size={22} />
        {outcome}
      </div>

      {/* Contract Parameters */}
      <div className="analytics-section">
        <h2><Users size={20} /> Contract Parameters</h2>
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-value">{contractParams.K}</div>
            <div className="stat-label">K (commit oracles)</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{contractParams.M}</div>
            <div className="stat-label">M (required responses)</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{contractParams.maxLikelihoodLength}</div>
            <div className="stat-label">Max Likelihood Length</div>
          </div>
        </div>
      </div>

      {/* Aggregation Status */}
      {aggregationStatus && (
        <div className="analytics-section">
          <h2><Activity size={20} /> Aggregation Status</h2>
          <div className="stat-grid">
            <div className={`stat-card ${aggregationStatus.isComplete ? 'success' : ''}`}>
              <div className="stat-icon">{aggregationStatus.isComplete ? <CheckCircle size={20} /> : <Clock size={20} />}</div>
              <div className="stat-value">{aggregationStatus.isComplete ? 'Yes' : 'No'}</div>
              <div className="stat-label">Complete</div>
            </div>
            <div className={`stat-card ${aggregationStatus.failed ? 'danger' : ''}`}>
              <div className="stat-icon">{aggregationStatus.failed ? <XCircle size={20} /> : <CheckCircle size={20} />}</div>
              <div className="stat-value">{aggregationStatus.failed ? 'Yes' : 'No'}</div>
              <div className="stat-label">Failed</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{aggregationStatus.commitPhaseComplete ? 'Yes' : 'No'}</div>
              <div className="stat-label">Commit Phase Done</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{aggregationStatus.commitCount}</div>
              <div className="stat-label">Commits</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{aggregationStatus.responseCount}</div>
              <div className="stat-label">Responses</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{aggregationStatus.requestBlock}</div>
              <div className="stat-label">Request Block</div>
            </div>
          </div>
        </div>
      )}

      {/* Request Event */}
      {requestEvent && (
        <div className="analytics-section">
          <h2><Activity size={20} /> Request Details</h2>
          <div className="fulfillment-details">
            <div className="detail-row">
              <span className="detail-label">Block:</span>
              <span className="detail-value">{requestEvent.block}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Tx Hash:</span>
              <span className="detail-value">
                <a
                  href={`${networkConfig.explorer}/tx/${requestEvent.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--primary)', textDecoration: 'none' }}
                >
                  {requestEvent.txHash.slice(0, 20)}... <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
                </a>
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">CIDs:</span>
              <span className="detail-value">{requestEvent.cids?.join(', ') || 'N/A'}</span>
            </div>
          </div>
        </div>
      )}

      {/* Oracle Slots Table */}
      {slots && slots.length > 0 && (
        <div className="analytics-section">
          <h2><Users size={20} /> Oracle Slots ({slots.length})</h2>
          <div className="slots-table">
            <table>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Oracle</th>
                  <th>Commit</th>
                  <th>Reveal Req</th>
                  <th>Reveal OK</th>
                  <th>Hash Mis</th>
                  <th>Bad Fmt</th>
                  <th>Too Many</th>
                  <th>Wrong Cnt</th>
                  <th>Too Few</th>
                  <th>Scores</th>
                </tr>
              </thead>
              <tbody>
                {slots.map(slot => (
                  <tr key={slot.slot}>
                    <td>{slot.slot}</td>
                    <td className="oracle-cell">
                      <a
                        href={`${networkConfig.explorer}/address/${slot.oracle}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="oracle-link"
                      >
                        {slot.oracle.slice(0, 8)}...{slot.oracle.slice(-4)}
                        <ExternalLink size={10} />
                      </a>
                    </td>
                    <BoolCell value={slot.committed} />
                    <BoolCell value={slot.revealRequested} />
                    <BoolCell value={slot.revealOK} />
                    <BoolCell value={slot.hashMismatch} invert />
                    <BoolCell value={slot.invalidFormat} invert />
                    <BoolCell value={slot.tooManyScores} invert />
                    <BoolCell value={slot.wrongScoreCount} invert />
                    <BoolCell value={slot.tooFewScores} invert />
                    <td className="scores-cell" title={slot.scores ? slot.scores.join(', ') : ''}>
                      {slot.scores ? `[${slot.scores.join(', ')}]` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Fulfillment */}
      {fulfillment && (
        <div className="analytics-section">
          <h2><CheckCircle size={20} /> Fulfillment</h2>
          <div className="fulfillment-details">
            <div className="detail-row">
              <span className="detail-label">Likelihoods:</span>
              <span className="detail-value">[{fulfillment.likelihoods.join(', ')}]</span>
            </div>
            {fulfillment.justificationCID && (
              <div className="detail-row">
                <span className="detail-label">Justification CID:</span>
                <span className="detail-value">{fulfillment.justificationCID}</span>
              </div>
            )}
            <div className="detail-row">
              <span className="detail-label">Block:</span>
              <span className="detail-value">{fulfillment.block}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Tx Hash:</span>
              <span className="detail-value">
                <a
                  href={`${networkConfig.explorer}/tx/${fulfillment.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--primary)', textDecoration: 'none' }}
                >
                  {fulfillment.txHash.slice(0, 20)}... <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
                </a>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Analysis */}
      <div className="analytics-section">
        <h2><Activity size={20} /> Analysis</h2>
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-value">{analysis.totalSlots}</div>
            <div className="stat-label">Total Slots</div>
          </div>
          <div className="stat-card success">
            <div className="stat-icon"><CheckCircle size={16} /></div>
            <div className="stat-value">{analysis.committed}</div>
            <div className="stat-label">Committed</div>
          </div>
          <div className="stat-card success">
            <div className="stat-icon"><CheckCircle size={16} /></div>
            <div className="stat-value">{analysis.revealed}</div>
            <div className="stat-label">Revealed</div>
          </div>
          <div className={`stat-card ${analysis.nonResponding > 0 ? 'warning' : ''}`}>
            <div className="stat-icon">{analysis.nonResponding > 0 ? <AlertTriangle size={16} /> : <CheckCircle size={16} />}</div>
            <div className="stat-value">{analysis.nonResponding}</div>
            <div className="stat-label">Non-Responding</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{analysis.uniqueOracles}</div>
            <div className="stat-label">Unique Oracles</div>
          </div>
        </div>

        {/* Non-responding slot IDs */}
        {analysis.nonRespondingSlotIds && analysis.nonRespondingSlotIds.length > 0 && (
          <p style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Non-responding slots: {analysis.nonRespondingSlotIds.join(', ')}
          </p>
        )}

        {/* Failure breakdown */}
        {Object.values(analysis.failures).some(v => v > 0) && (
          <div style={{ marginTop: '1rem' }}>
            <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Failure Breakdown</h3>
            <div className="stat-grid">
              {analysis.failures.hashMismatch > 0 && (
                <div className="stat-card danger">
                  <div className="stat-icon"><XCircle size={16} /></div>
                  <div className="stat-value">{analysis.failures.hashMismatch}</div>
                  <div className="stat-label">Hash Mismatch</div>
                </div>
              )}
              {analysis.failures.invalidFormat > 0 && (
                <div className="stat-card danger">
                  <div className="stat-icon"><XCircle size={16} /></div>
                  <div className="stat-value">{analysis.failures.invalidFormat}</div>
                  <div className="stat-label">Invalid Format</div>
                </div>
              )}
              {analysis.failures.tooManyScores > 0 && (
                <div className="stat-card danger">
                  <div className="stat-icon"><XCircle size={16} /></div>
                  <div className="stat-value">{analysis.failures.tooManyScores}</div>
                  <div className="stat-label">Too Many Scores</div>
                </div>
              )}
              {analysis.failures.wrongScoreCount > 0 && (
                <div className="stat-card danger">
                  <div className="stat-icon"><XCircle size={16} /></div>
                  <div className="stat-value">{analysis.failures.wrongScoreCount}</div>
                  <div className="stat-label">Wrong Score Count</div>
                </div>
              )}
              {analysis.failures.tooFewScores > 0 && (
                <div className="stat-card danger">
                  <div className="stat-icon"><XCircle size={16} /></div>
                  <div className="stat-value">{analysis.failures.tooFewScores}</div>
                  <div className="stat-label">Too Few Scores</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Boolean cell for the slots table
 * For positive events (commit, reveal): green check = true, gray dash = false
 * For failure events (invert=true): red X = true, gray dash = false
 */
function BoolCell({ value, invert }) {
  if (!value) {
    return <td><span className="icon-na">-</span></td>;
  }
  if (invert) {
    return <td><XCircle size={14} className="icon-fail" /></td>;
  }
  return <td><CheckCircle size={14} className="icon-ok" /></td>;
}

export default AggHistory;
