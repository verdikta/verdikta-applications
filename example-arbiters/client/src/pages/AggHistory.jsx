/**
 * Aggregation History Page
 * Full arbiter evaluation lifecycle for a given Verdikta aggregation ID — the
 * drill-down reached from a blameworthy aggId on the Analytics page. v2 rounds:
 * getRoundInfo + getSlot for state, the round events for the timeline. Network is
 * the header-selected one (via useNetwork); the same id is passed to the
 * /api/analytics/agg-history endpoint and used to pick the block explorer.
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
  Copy,
  ArrowLeft,
  Loader2,
} from 'lucide-react';
import { apiService } from '../services/api';
import { useNetwork } from '../context/NetworkContext';
import { chainForNetwork } from '../config/chains';
import './AggHistory.css';

// example-arbiters has no configured IPFS gateway — use a public one for the
// request CIDs / justification CID links.
const IPFS_GATEWAY = 'https://ipfs.io/ipfs';

function AggHistory() {
  const { aggId } = useParams();
  const { selectedNetwork: network } = useNetwork();
  const explorer = chainForNetwork(network).explorer;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchHistory() {
      setLoading(true);
      setError(null);
      try {
        const result = await apiService.getAggHistory(aggId, network);
        if (!cancelled) setData(result.data);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchHistory();
    return () => { cancelled = true; };
  }, [aggId, network]);

  const handleCopy = async (text, key = 'aggId') => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  if (loading) {
    return (
      <div className="agg-history">
        <div className="loading">
          <Loader2 size={32} className="spinning" />
          <p>Querying blockchain events…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="agg-history">
        <Link to="/analytics" className="back-link"><ArrowLeft size={16} /> Back to Analytics</Link>
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
        <Link to="/analytics" className="back-link"><ArrowLeft size={16} /> Back to Analytics</Link>
        <div className="not-found">
          <AlertTriangle size={40} />
          <h2>Aggregation Not Found</h2>
          <p>{data?.message || 'No matching events found for this aggregation ID within the scan window.'}</p>
          <div className="agg-id-display" style={{ marginTop: '1rem', display: 'inline-block' }}>
            {aggId}
          </div>
        </div>
      </div>
    );
  }

  const { contractParams, roundInfo, requestEvent, slots = [], fulfillment, outcome, outcomeKind, analysis, timeline = [], blame = [] } = data;

  const kindClass = {
    completed: 'completed', running: 'running', malformed: 'malformed',
    failed: 'failed', notDrawn: 'failed', cancelled: 'failed',
  }[outcomeKind] || 'failed';
  const OutcomeIcon = kindClass === 'completed' ? CheckCircle : kindClass === 'running' ? Clock : kindClass === 'malformed' ? AlertTriangle : XCircle;
  const blamed = new Map(blame.map((b) => [b.slot, b.stage]));
  const fmtTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : '—');

  // A list of arbiter chips for the slots matching `pred`.
  const chips = (prefix, pred) => {
    const list = slots.filter(pred);
    return list.length > 0 && (
      <div className="req-actual-oracles">
        {list.map((s) => (
          <a
            key={`${prefix}-${s.slot}`}
            href={`${explorer}/address/${s.oracle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="oracle-chip"
          >
            slot {s.slot}: {s.oracle.slice(0, 6)}…{s.oracle.slice(-4)} <ExternalLink size={10} />
          </a>
        ))}
      </div>
    );
  };
  const valClass = (n, need) => (n >= need ? 'val-ok' : n > 0 ? 'val-warn' : 'val-fail');

  return (
    <div className="agg-history">
      <Link to="/analytics" className="back-link"><ArrowLeft size={16} /> Back to Analytics</Link>

      {/* Header */}
      <div className="page-header">
        <div className="header-content">
          <h1><Activity size={28} /> Aggregation History</h1>
          <div className="agg-id-display">
            <span className="agg-id-label">Agg ID:</span>
            {aggId}
            {/^0x0{40}/i.test(aggId) && <span className="agg-id-label"> (round #{parseInt(aggId, 16)})</span>}
            <button className="copy-btn" onClick={() => handleCopy(aggId)}>
              {copied === 'aggId' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>

      {/* Outcome Banner */}
      <div className={`outcome-banner ${kindClass}`}>
        <OutcomeIcon size={22} />
        {outcome}
      </div>

      {/* Requirements & Actual */}
      <div className="req-actual-container">
        <div className="analytics-section req-actual-half">
          <h2><Activity size={20} /> Requirements</h2>
          <div className="req-actual-list">
            <div className="req-actual-row">
              <span className="req-actual-label">Jury drawn (K)</span>
              <span className="req-actual-value">{contractParams.K}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Commits needed (M)</span>
              <span className="req-actual-value">{contractParams.M}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Early close at (M+)</span>
              <span className="req-actual-value">{contractParams.mPlus}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Promoted to reveal</span>
              <span className="req-actual-value">{contractParams.M}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Reveals to finalize (N)</span>
              <span className="req-actual-value">{contractParams.N}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Cluster (P)</span>
              <span className="req-actual-value">{contractParams.P}</span>
            </div>
            <div className="req-actual-detail">The aggregator&rsquo;s current settings; a round keeps the ones it was requested with.</div>
          </div>
        </div>

        <div className="analytics-section req-actual-half">
          <h2><Users size={20} /> Actual</h2>
          <div className="req-actual-list">
            <div className="req-actual-row">
              <span className="req-actual-label">Drawn</span>
              <span className="req-actual-value">{analysis.dispatched} / {contractParams.K}</span>
            </div>
            {chips('d', (s) => s.dispatched)}

            <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
              <span className="req-actual-label">Commits</span>
              <span className={`req-actual-value ${valClass(analysis.committed, contractParams.M)}`}>
                {analysis.committed} / {contractParams.M} needed
              </span>
            </div>
            {chips('c', (s) => s.committed)}

            <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
              <span className="req-actual-label">Promoted</span>
              <span className="req-actual-value">{analysis.promoted} / {contractParams.M}</span>
            </div>
            {chips('p', (s) => s.promoted)}

            <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
              <span className="req-actual-label">Reveals counted</span>
              <span className={`req-actual-value ${valClass(analysis.counted, contractParams.N)}`}>
                {analysis.counted} / {contractParams.N}
              </span>
            </div>
            {chips('r', (s) => s.counted)}
            {analysis.lateReveals > 0 && (
              <div className="req-actual-detail">
                {analysis.lateReveals} late reveal{analysis.lateReveals === 1 ? '' : 's'} (after finalization: scored, not counted)
              </div>
            )}

            {analysis.nonResponding > 0 && (
              <>
                <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
                  <span className="req-actual-label">Never committed</span>
                  <span className="req-actual-value val-warn">{analysis.nonResponding}</span>
                </div>
                <div className="req-actual-detail">Slots: {analysis.nonRespondingSlotIds.join(', ')}</div>
              </>
            )}
            {analysis.promotedNotRevealed?.length > 0 && (
              <>
                <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
                  <span className="req-actual-label">Promoted, never revealed</span>
                  <span className="req-actual-value val-warn">{analysis.promotedNotRevealed.length}</span>
                </div>
                <div className="req-actual-detail">Slots: {analysis.promotedNotRevealed.join(', ')}</div>
              </>
            )}
            {(analysis.quality.close + analysis.quality.off + analysis.quality.far) > 0 && (
              <div className="req-actual-failures" style={{ marginTop: '0.75rem' }}>
                <span className="req-actual-label" style={{ marginBottom: '0.25rem', display: 'block' }}>Reveal quality</span>
                <div className="failure-line"><CheckCircle size={12} className="icon-ok" /> {analysis.quality.close} close</div>
                {analysis.quality.off > 0 && <div className="failure-line"><AlertTriangle size={12} className="icon-fail" /> {analysis.quality.off} off</div>}
                {analysis.quality.far > 0 && <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.quality.far} far</div>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Round state */}
      {roundInfo && (
        <div className="analytics-section">
          <h2><Clock size={20} /> Round</h2>
          <div className="fulfillment-details">
            <div className="detail-row"><span className="detail-label">Phase:</span><span className="detail-value">{roundInfo.phaseName} ({roundInfo.phase})</span></div>
            <div className="detail-row"><span className="detail-label">Requested:</span><span className="detail-value">{fmtTime(roundInfo.requestTime)} · block {roundInfo.requestBlock}</span></div>
            <div className="detail-row"><span className="detail-label">Commit window ends:</span><span className="detail-value">{fmtTime(roundInfo.windowEnd)}</span></div>
            <div className="detail-row"><span className="detail-label">Deadline:</span><span className="detail-value">{fmtTime(roundInfo.deadline)}</span></div>
            <div className="detail-row"><span className="detail-label">Escrow:</span><span className="detail-value">{roundInfo.received} ETH received · {roundInfo.baseFees} base fees · {roundInfo.bonuses} bonuses · {roundInfo.rewards} rewards</span></div>
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
                  href={`${explorer}/tx/${requestEvent.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--primary)', textDecoration: 'none' }}
                >
                  {requestEvent.txHash.slice(0, 20)}… <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
                </a>
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">CIDs:</span>
              <span className="detail-value">
                {requestEvent.cids?.length > 0
                  ? requestEvent.cids.map((cid, i) => (
                      <span key={cid}>
                        {i > 0 && ', '}
                        <a
                          href={`${IPFS_GATEWAY}/${cid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'var(--primary)', textDecoration: 'none' }}
                        >
                          {cid} <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
                        </a>
                      </span>
                    ))
                  : 'N/A'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Arbiter Slots Table */}
      {slots.length > 0 && (
        <div className="analytics-section">
          <h2><Users size={20} /> Arbiter Slots ({slots.length})</h2>
          <div className="slots-table">
            <table>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Arbiter Addr</th>
                  <th>Job ID</th>
                  <th>Fee</th>
                  <th>Commit</th>
                  <th>Promoted</th>
                  <th>Revealed</th>
                  <th>Counted</th>
                  <th>Quality</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {slots.map((slot) => (
                  <tr key={slot.slot}>
                    <td>{slot.slot}</td>
                    <td className="oracle-cell">
                      <a
                        href={`${explorer}/address/${slot.oracle}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="oracle-link"
                      >
                        {slot.oracle.slice(0, 8)}…{slot.oracle.slice(-4)}
                        <ExternalLink size={10} />
                      </a>
                    </td>
                    <td className="oracle-cell" title={slot.jobId || ''}>
                      {slot.jobId ? (
                        <span className="jobid-cell">
                          {slot.jobId.slice(0, 8)}…{slot.jobId.slice(-4)}
                          <button className="copy-icon-btn" onClick={() => handleCopy(slot.jobId, `job-${slot.slot}`)}>
                            {copied === `job-${slot.slot}` ? <CheckCircle size={11} className="icon-ok" /> : <Copy size={11} />}
                          </button>
                        </span>
                      ) : '-'}
                    </td>
                    <td>{slot.fee}{slot.bonus ? ` + ${slot.bonus}` : ''}</td>
                    <BoolCell value={slot.committed} />
                    <BoolCell value={slot.promoted} />
                    <BoolCell value={slot.revealed} />
                    <BoolCell value={slot.counted} />
                    <td>{slot.quality || '-'}</td>
                    <td>
                      {[
                        slot.late && 'late reveal',
                        slot.skipped && `skipped: ${slot.skipped}`,
                        blamed.has(slot.slot) && `blamed (${blamed.get(slot.slot)})`,
                      ].filter(Boolean).join(' · ') || '-'}
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
              <span className="detail-label">Aggregated:</span>
              <span className="detail-value">[{fulfillment.aggregated.join(', ')}]</span>
            </div>
            {fulfillment.justificationCIDs?.length > 0 && (
              <div className="detail-row">
                <span className="detail-label">Justification CIDs:</span>
                <span className="detail-value">
                  {fulfillment.justificationCIDs.map((cid, i) => (
                    <span key={cid}>
                      {i > 0 && ', '}
                      <a
                        href={`${IPFS_GATEWAY}/${cid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--primary)', textDecoration: 'none' }}
                      >
                        {cid} <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
                      </a>
                    </span>
                  ))}
                </span>
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
                  href={`${explorer}/tx/${fulfillment.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--primary)', textDecoration: 'none' }}
                >
                  {fulfillment.txHash.slice(0, 20)}… <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
                </a>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Event timeline */}
      {timeline.length > 0 && (
        <div className="analytics-section">
          <h2><Activity size={20} /> Event Timeline ({timeline.length})</h2>
          <div className="slots-table">
            <table>
              <thead>
                <tr><th>Block</th><th>Event</th><th>Detail</th><th>Tx</th></tr>
              </thead>
              <tbody>
                {timeline.map((e, i) => (
                  <tr key={`${e.txHash}-${i}`}>
                    <td>{e.block}</td>
                    <td>{e.event}</td>
                    <td>{e.detail || '-'}</td>
                    <td>
                      <a href={`${explorer}/tx/${e.txHash}`} target="_blank" rel="noopener noreferrer" className="oracle-link">
                        {e.txHash.slice(0, 10)}… <ExternalLink size={10} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.scan?.truncated && (
            <p className="req-actual-detail">The event scan was capped; later events of this round are not shown.</p>
          )}
        </div>
      )}

    </div>
  );
}

/**
 * Boolean cell for the slots table: green check = true, gray dash = false.
 */
function BoolCell({ value }) {
  if (!value) {
    return <td><span className="icon-na">-</span></td>;
  }
  return <td><CheckCircle size={14} className="icon-ok" /></td>;
}

export default AggHistory;
