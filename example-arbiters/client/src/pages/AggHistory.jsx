/**
 * Aggregation History Page
 * Full arbiter evaluation lifecycle for a given Verdikta aggregation ID — the
 * drill-down reached from a blameworthy round on the Analytics page. v2 rounds:
 * getRoundInfo + getSlot for state, the round events for the timeline, and the
 * settle transaction's keeper events for each arbiter's new scores. The route
 * takes the round number or the bytes32 aggId. Network is the header-selected
 * one (via useNetwork); the same id is passed to the /api/analytics/agg-history
 * endpoint and used to pick the block explorer.
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
            {/^[0-9]+$/.test(aggId) ? `round #${aggId}` : aggId}
          </div>
        </div>
      </div>
    );
  }

  const {
    contractParams = {}, roundInfo, requestEvent, slots = [], fulfillment, outcome, outcomeKind, analysis,
    timeline = [], blame = [], money, beaconArbiters, settlement, points,
  } = data;

  const kindClass = {
    completed: 'completed', running: 'running', malformed: 'malformed', notProgressed: 'malformed',
    failed: 'failed', notDrawn: 'failed', cancelled: 'failed',
  }[outcomeKind] || 'failed';
  const OutcomeIcon = kindClass === 'completed' ? CheckCircle : kindClass === 'running' ? Clock : kindClass === 'malformed' ? AlertTriangle : XCircle;
  const blamed = new Map(blame.map((b) => [b.slot, b]));
  const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
  // Expected keeper outcome for a slot (what _settle reports), as score changes.
  const expectedText = (e) => {
    if (!e) return '-';
    if (!e.scored) return e.note || 'not scored';
    const parts = [];
    if (e.tDelta) parts.push(`T ${signed(e.tDelta)}`);
    if (e.qDelta) parts.push(`Q ${signed(e.qDelta)}`);
    return `${e.codeName}${parts.length ? `: ${parts.join(', ')}` : ''}`;
  };
  // What the keeper did at settlement (ScoresUpdated / OutcomeSkippedFrozen / ArbiterBlocked).
  const actualText = (a) => {
    if (!a) return '-';
    if (a.skippedFrozen) return 'skipped: frozen at the round end';
    if (!a.scored) return 'no change';
    return `Q ${a.quality} · T ${a.timeliness}${a.blockedUntil ? ` · blocked until ${fmtTime(a.blockedUntil)} (offense ${a.offenses})` : ''}`;
  };
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
            <span className="agg-id-label">Round:</span>
            #{data.round}
            <span className="agg-id-label" title={data.aggId}> (aggId {data.aggId.slice(0, 6)}…{data.aggId.slice(-6)})</span>
            <button className="copy-btn" onClick={() => handleCopy(data.aggId)} title="Copy the bytes32 aggId">
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
            <div className="req-actual-row">
              <span className="req-actual-label">Round timeout (from the draw)</span>
              <span className="req-actual-value">{contractParams.timeout != null ? `${contractParams.timeout}s` : '—'}</span>
            </div>
            <div className="req-actual-detail">This round&rsquo;s own jury, sent with its request (getJury). With fewer than K eligible arbiters, the jury repeats arbiters.</div>
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
                <div className="req-actual-detail">
                  Slots: {analysis.nonRespondingSlotIds.join(', ')}
                  {analysis.skipped > 0 && ` (${analysis.skipped} skipped at the draw)`}
                </div>
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
            {money && (
              <>
                <div className="detail-row">
                  <span className="detail-label">Draw reward:</span>
                  <span className="detail-value">{money.draw ? `${money.draw.eth} ETH to ${money.draw.to}` : '—'}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Promote reward:</span>
                  <span className="detail-value" title="No event carries it: derived as rewards − draw reward − beacon payments. Paid to the sender of the promote() transaction (CommitPhaseComplete).">
                    {money.promote ? `${money.promote.eth} ETH to ${money.promote.to || 'the promote() caller'} (derived: ${money.promote.derived})` : '—'}
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Beacon payments:</span>
                  <span className="detail-value">
                    {money.beacons
                      ? `${money.beacons.eth} ETH: ${money.beacons.payments.map((b) => `${b.eth} to ${b.payee.slice(0, 8)}…${b.payee.slice(-4)}`).join(', ')}`
                      : '—'}
                  </span>
                </div>
                {(money.refunded || money.toTreasury) && (
                  <div className="detail-row">
                    <span className="detail-label">Unspent prepay:</span>
                    <span className="detail-value">
                      {[money.refunded && `${money.refunded} ETH refunded to the requester`,
                        money.toTreasury && `${money.toTreasury} ETH to the treasury (no refund)`].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                )}
              </>
            )}
            {beaconArbiters?.length > 0 && (
              <div className="detail-row">
                <span className="detail-label">Beacon arbiters:</span>
                <span className="detail-value">
                  {beaconArbiters.map((b, i) => (
                    <span key={b.key} title={`key ${b.key}`}>
                      {i > 0 && ', '}
                      {b.oracle ? `${b.oracle.slice(0, 8)}…${b.oracle.slice(-4)}` : b.key.slice(0, 10)}
                      {b.jobId ? ` / ${b.jobId.slice(0, 8)}…` : ''}
                    </span>
                  ))}
                </span>
              </div>
            )}
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
                  <th title={points ? `What settlement reports to the keeper for the slot, as score changes (T = timeliness, Q = quality; points: gain +${points.gain}, minor −${points.minor}, major −${points.major}, fail −${points.fail}, nocommit −${points.nocommit}). A score that reaches 0 restarts at ${points.start} and blocks the arbiter.` : undefined}>Expected outcome</th>
                  <th title="The keeper's new scores, from its events in the settle transaction">After settlement</th>
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
                    <td title={slot.paid ? undefined : `Skipped at the draw: the fee (${slot.fee} ETH) was not paid`}>
                      {slot.paid ? `${slot.fee}${slot.bonus ? ` + ${slot.bonus}` : ''}` : 'not paid'}
                    </td>
                    <BoolCell value={slot.committed} />
                    <BoolCell value={slot.promoted} />
                    <BoolCell value={slot.revealed} />
                    <BoolCell value={slot.counted} />
                    <td>{slot.quality || '-'}</td>
                    <td title={slot.expected?.frozenSkip ? 'Skipped by the keeper if the arbiter was frozen at the round end (it did not commit)' : undefined}>
                      {expectedText(slot.expected)}{slot.expected?.frozenSkip ? ' *' : ''}
                    </td>
                    <td>{actualText(slot.actual)}</td>
                    <td>
                      {[
                        slot.late && 'late reveal',
                        slot.skipped && `skipped: ${slot.skipped}`,
                        blamed.has(slot.slot) && `blamed (${blamed.get(slot.slot).stage})`,
                      ].filter(Boolean).join(' · ') || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="req-actual-detail">
            Expected outcome mirrors the aggregator&rsquo;s settlement rule; * marks a slot without a commit, which the
            keeper skips if the arbiter was frozen at the round end.
            {settlement?.settled
              ? ' After settlement shows the keeper’s events in the settle transaction.'
              : ' The round is not settled yet, so no scores have changed.'}
            {settlement?.note ? ` ${settlement.note}` : ''}
          </p>
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
