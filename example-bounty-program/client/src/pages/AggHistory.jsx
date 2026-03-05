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
            <span className="agg-id-label">Agg ID:</span>
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

      {/* Requirements & Actual */}
      <div className="req-actual-container">
        <div className="analytics-section req-actual-half">
          <h2><Activity size={20} /> Requirements</h2>
          <div className="req-actual-list">
            <div className="req-actual-row">
              <span className="req-actual-label">Oracles polled</span>
              <span className="req-actual-value">{contractParams.K}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Commits needed</span>
              <span className="req-actual-value">{contractParams.M}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Reveals needed</span>
              <span className="req-actual-value">{contractParams.N}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Max scores per reveal</span>
              <span className="req-actual-value">{contractParams.maxLikelihoodLength}</span>
            </div>
          </div>
        </div>

        <div className="analytics-section req-actual-half">
          <h2><Users size={20} /> Actual</h2>
          <div className="req-actual-list">
            {/* Polled */}
            <div className="req-actual-row">
              <span className="req-actual-label">Polled</span>
              <span className="req-actual-value">{slots ? slots.length : 0} / {contractParams.K}</span>
            </div>
            {slots && slots.length > 0 && (
              <div className="req-actual-oracles">
                {slots.map(s => (
                  <a
                    key={`p-${s.slot}`}
                    href={`${networkConfig.explorer}/address/${s.oracle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="oracle-chip"
                  >
                    slot {s.slot}: {s.oracle.slice(0, 6)}...{s.oracle.slice(-4)} <ExternalLink size={10} />
                  </a>
                ))}
              </div>
            )}

            {/* Commits */}
            <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
              <span className="req-actual-label">Commits</span>
              <span className={`req-actual-value ${analysis.committed >= contractParams.M ? 'val-ok' : analysis.committed > 0 ? 'val-warn' : 'val-fail'}`}>
                {analysis.committed} / {contractParams.K}
              </span>
            </div>
            {slots && (() => {
              const committers = slots.filter(s => s.committed);
              return committers.length > 0 && (
                <div className="req-actual-oracles">
                  {committers.map(s => (
                    <a
                      key={`c-${s.slot}`}
                      href={`${networkConfig.explorer}/address/${s.oracle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="oracle-chip"
                    >
                      slot {s.slot}: {s.oracle.slice(0, 6)}...{s.oracle.slice(-4)} <ExternalLink size={10} />
                    </a>
                  ))}
                </div>
              );
            })()}

            {/* Selected for reveal */}
            <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
              <span className="req-actual-label">Reveal Requested</span>
              <span className="req-actual-value">
                {slots ? slots.filter(s => s.revealRequested).length : 0} / {contractParams.M}
              </span>
            </div>
            {slots && (() => {
              const selected = slots.filter(s => s.revealRequested);
              return selected.length > 0 && (
                <div className="req-actual-oracles">
                  {selected.map(s => (
                    <a
                      key={`s-${s.slot}`}
                      href={`${networkConfig.explorer}/address/${s.oracle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="oracle-chip"
                    >
                      slot {s.slot}: {s.oracle.slice(0, 6)}...{s.oracle.slice(-4)} <ExternalLink size={10} />
                    </a>
                  ))}
                </div>
              );
            })()}

            {/* Reveals */}
            <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
              <span className="req-actual-label">Reveals</span>
              <span className={`req-actual-value ${analysis.revealed >= contractParams.N ? 'val-ok' : analysis.revealed > 0 ? 'val-warn' : 'val-fail'}`}>
                {analysis.revealed} / {contractParams.N}
              </span>
            </div>
            {slots && (() => {
              const revealers = slots.filter(s => s.revealOK);
              return revealers.length > 0 && (
                <div className="req-actual-oracles">
                  {revealers.map(s => (
                    <a
                      key={`r-${s.slot}`}
                      href={`${networkConfig.explorer}/address/${s.oracle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="oracle-chip"
                    >
                      slot {s.slot}: {s.oracle.slice(0, 6)}...{s.oracle.slice(-4)} <ExternalLink size={10} />
                    </a>
                  ))}
                </div>
              );
            })()}

            {/* Non-responding */}
            {analysis.nonResponding > 0 && (
              <>
                <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
                  <span className="req-actual-label">Non-responding</span>
                  <span className="req-actual-value val-warn">{analysis.nonResponding}</span>
                </div>
                <div className="req-actual-detail">
                  Slots: {analysis.nonRespondingSlotIds.join(', ')}
                </div>
              </>
            )}

            {/* Failures */}
            {Object.values(analysis.failures).some(v => v > 0) && (
              <div className="req-actual-failures" style={{ marginTop: '0.75rem' }}>
                <span className="req-actual-label" style={{ marginBottom: '0.25rem', display: 'block' }}>Failures</span>
                {analysis.failures.hashMismatch > 0 && (
                  <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.failures.hashMismatch} hash mismatch</div>
                )}
                {analysis.failures.invalidFormat > 0 && (
                  <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.failures.invalidFormat} invalid format</div>
                )}
                {analysis.failures.tooManyScores > 0 && (
                  <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.failures.tooManyScores} too many scores</div>
                )}
                {analysis.failures.wrongScoreCount > 0 && (
                  <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.failures.wrongScoreCount} wrong score count</div>
                )}
                {analysis.failures.tooFewScores > 0 && (
                  <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.failures.tooFewScores} too few scores</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

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
