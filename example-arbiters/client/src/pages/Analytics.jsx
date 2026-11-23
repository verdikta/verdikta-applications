/**
 * Analytics Page
 * Arbiter/oracle diagnostics for the Verdikta network: availability by class
 * and system health. Read directly from the aggregator + ReputationKeeper
 * contracts; no bounty or submission data is involved.
 *
 * The network (Base mainnet / Base Sepolia) is selected globally in the Header
 * and read here via useNetwork(); changing it re-runs the data load.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3,
  RefreshCw,
  AlertTriangle,
  Users,
  Server,
  Clock,
  CheckCircle,
  XCircle,
  Zap,
  Coins,
  UserCircle,
  Fuel,
  Activity,
  BellRing,
  HeartPulse
} from 'lucide-react';
import { useToast } from '../components/Toast';
import { useNetwork } from '../context/NetworkContext';
import { apiService } from '../services/api';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import './Analytics.css';

// Register Chart.js components
ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

// Chart color palette (arbiter statuses)
const COLORS = {
  active: '#22c55e',
  new: '#8b5cf6',
  atRisk: '#f59e0b',
  frozen: '#0ea5e9',
  blocked: '#ef4444',
  inactive: '#6b7280'
};

// v2 arbiter statuses (derived server-side from the keeper's flags, blocks,
// liveness freeze and scores — see server/utils/arbiterStatus.js), in display order.
const STATUS_ORDER = [
  { key: 'active', label: 'Active' },
  { key: 'new', label: 'New' },
  { key: 'atRisk', label: 'At risk' },
  { key: 'frozen', label: 'Frozen' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'inactive', label: 'Inactive' },
];

// Arbiter status descriptions for tooltips (keyed by label)
const ARBITER_STATUS_DESCRIPTIONS = {
  Active: 'Registered, staked, answering health calls, and selectable; both scores have moved from their start',
  New: 'Selectable but never scored: quality and timeliness are still at their starting value',
  'At risk': 'Selectable, but a quality or timeliness score is at or below the keeper\'s major penalty: one more major miss reaches 0 and blocks it',
  Frozen: 'Not selectable until it answers a health call: a call went unanswered past the keeper\'s deadline, or it was registered without a hash-chain head (from this site) and its node has not re-synced yet',
  Blocked: 'Not selectable: a score reached 0 (blocked for the lock duration, doubling per offense), or banned after the maximum number of offenses',
  Inactive: 'Registered but not selectable: paused by its owner, exiting (unbonding), under-staked, or posting a fee above the aggregator\'s maximum'
};

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

// Green / amber / red for a reliability percentage (null → muted grey).
const rateColor = (pct) => {
  if (pct == null) return COLORS.inactive;
  if (pct >= 80) return COLORS.active;
  if (pct >= 40) return COLORS.atRisk;
  return COLORS.blocked;
};

// One operator row in the reliability table. The Blameworthy count, when
// nonzero, is a toggle that expands the list of failed aggIds this operator is
// responsible for — each a link to that evaluation's full agg-history page.
const blameAggLabel = (id) => `${id.slice(0, 18)}…${id.slice(-6)}`;
// Which blame rows are expanded, remembered across route unmounts (keyed by
// window + operator) so returning from an agg-history page via Back re-shows the
// same list instead of collapsing it.
const expandedBlame = new Set();

// Oracle-health results cached across route unmounts (keyed by network) so
// returning to Analytics (e.g. Back from an agg-history page) shows the tables
// immediately — no spinner flash, stable page height for scroll restoration —
// while a background refresh still runs.
const healthCache = {};   // network → 14-day oracle-health data
const health24Cache = {}; // network → 24-hour oracle-health data

// Watchdog reporting-state palette + labels (see the Arbiter Alerts section).
// 'ok' / 'alerting' / 'stale' come from the server; null = never reported.
const ALERT_STATE = {
  ok:       { color: COLORS.active,       label: 'Healthy',        desc: 'Watchdog heartbeating; all node health checks passing' },
  alerting: { color: COLORS.blocked,      label: 'Alerting',       desc: 'The node\'s watchdog is reporting an active problem' },
  stale:    { color: COLORS.atRisk, label: 'Not reporting',  desc: 'Watchdog heartbeats stopped — the node or its machine may be down' },
};

// Seconds → compact human uptime ("12d 4h", "3h 20m", "45m").
const fmtUptime = (sec) => {
  if (sec == null) return null;
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

// Small colored dot conveying an operator's watchdog reporting state. Renders
// nothing when the operator has never reported (webhook not configured) so the
// reliability tables stay uncluttered for non-participating operators.
function AlertDot({ alert }) {
  if (!alert) return null;
  const meta = ALERT_STATE[alert.state] || ALERT_STATE.ok;
  const bits = [`Node watchdog: ${meta.label}`];
  if (alert.state === 'alerting' && alert.activeAlert) bits.push(alert.activeAlert.subject);
  if (alert.hostname) bits.push(`host ${alert.hostname}`);
  const up = fmtUptime(alert.chainlinkUptimeSec);
  if (up) bits.push(`chainlink up ${up}`);
  return (
    <span
      className="alert-dot"
      style={{ backgroundColor: meta.color }}
      title={bits.join(' — ')}
    />
  );
}

const fmtAgoMs = (ms) => {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

function OperatorRow({ o, windowLabel, alert }) {
  const rowKey = `${windowLabel}|${o.operator}`;
  const [open, setOpen] = useState(() => expandedBlame.has(rowKey));
  const toggle = () => setOpen((v) => {
    const next = !v;
    if (next) expandedBlame.add(rowKey); else expandedBlame.delete(rowKey);
    return next;
  });
  const blame = o.blameworthy || 0;
  const aggIds = o.blameAggIds || [];
  return (
    <>
      <tr>
        <td><AlertDot alert={alert} /><code>{shortAddr(o.operator)}</code></td>
        <td>{o.arbiters == null ? '—' : o.arbiters}</td>
        <td><strong>{o.timesSelected}</strong></td>
        <td style={{ color: rateColor(o.commitRatePct), fontWeight: 600 }}>
          {o.commits}{o.commitRatePct == null ? '' : ` (${o.commitRatePct}%)`}
        </td>
        <td>{o.promoted ?? '—'}</td>
        <td style={{ color: rateColor(o.revealRatePct), fontWeight: 600 }}>
          {o.reveals}{o.revealRatePct == null ? '' : ` (${o.revealRatePct}%)`}
          {o.lateReveals ? <span className="gas-muted" title="Reveals that arrived after the round finalized: classified, but not counted in the result"> · {o.lateReveals} late</span> : ''}
        </td>
        <td>
          {blame > 0 ? (
            <button
              type="button"
              className="blame-toggle"
              onClick={toggle}
              aria-expanded={open}
              title="Show the failed evaluations this operator is responsible for"
            >
              {blame} <span className="blame-caret">{open ? '▾' : '▸'}</span>
            </button>
          ) : 0}
        </td>
      </tr>
      {open && blame > 0 && (
        <tr className="blame-detail-row">
          <td colSpan={7}>
            <div className="blame-detail">
              <span className="blame-detail-label">
                Responsible for {aggIds.length} failed evaluation{aggIds.length === 1 ? '' : 's'}:
              </span>
              <ul className="blame-agg-list">
                {aggIds.map((b) => (
                  <li key={b.aggId}>
                    <Link to={`/agg-history/${b.aggId}`} className="blame-agg-link" title={b.aggId}>
                      <code>{blameAggLabel(b.aggId)}</code>
                    </Link>
                    <span className="blame-agg-meta"> — {b.stage} stage{b.slots > 1 ? ` · ${b.slots} arbiters` : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// Operator Reliability section, rendered once per look-back window (the 14-day
// and 24-hour tables share identical columns — only the data differs).
// `alertsByOp` (operatorLower → watchdog record) decorates rows with a live
// node-health dot for operators that report to /api/alerts.
// A scan that completed zero chunks reports zeros for everything — but that's the
// RPC refusing every log query, not a quiet network. Rendering the zeros would
// claim, confidently and wrongly, that nothing happened; say what actually broke.
const ScanFailedBanner = ({ hData }) => (
  <div className="info-banner">
    <AlertTriangle size={16} />
    <span>
      Couldn't read chain history: {hData.chunkErrors} of {hData.totalChunks} log queries to the RPC
      failed and none succeeded{hData.aborted ? ' (scan stopped early)' : ''}, so no activity can be
      shown for this window. This is a data-source problem — it does <strong>not</strong> mean the
      network was idle.
      {hData.scanError ? ` Last RPC error: ${String(hData.scanError).slice(0, 140)}` : ''}
    </span>
  </div>
);

const renderReliabilitySection = (windowLabel, hData, hLoading, hError, alertsByOp = {}) => (
  <section className="analytics-section">
    <h2 title="Per-operator commit and reveal reliability across recent evaluations. Commit rate = commits ÷ times drawn; reveal rate = reveals ÷ times promoted (only promoted commits are asked to reveal). A healthy commit rate but a low reveal rate means the node commits then fails to reveal — starving evaluations of the reveals they need to finalize."><Server size={20} className="inline-icon" /> Operator Reliability · {windowLabel}</h2>
    <div className="section-content">
      {hLoading && !hData ? (
        <div className="loading"><div className="spinner"></div><p>Scanning aggregator events…</p></div>
      ) : hError ? (
        <div className="info-banner"><AlertTriangle size={16} /><span>{hError}</span></div>
      ) : hData?.scanFailed ? (
        <ScanFailedBanner hData={hData} />
      ) : hData && hData.operators.length > 0 ? (
        <div className="stats-table">
          <table>
            <thead>
              <tr>
                <th>Operator</th>
                <th className="tooltip-header" title="Number of arbiters (registered jobIds) currently backed by this operator contract">Arbiters</th>
                <th className="tooltip-header" title="Times one of this operator's arbiters was drawn into a jury and sent the commit request">Drawn</th>
                <th className="tooltip-header" title="Commits received, and commits ÷ times drawn">Commits</th>
                <th className="tooltip-header" title="Times one of its commits was promoted (asked to reveal). Each round promotes M of the commits at random.">Promoted</th>
                <th className="tooltip-header" title="Reveals received, and reveals ÷ times promoted. Low here despite commits = the node commits but doesn't reveal.">Reveals</th>
                <th className="tooltip-header" title={`Times this operator's arbiters were to blame for a failed round. A round needs ${hData?.requirements?.M ?? 'M'} commits, then ${hData?.requirements?.N ?? 'N'} reveals from the promoted commits; when it fails, each (operator, jobId) slot that didn't commit — or that was promoted but didn't reveal — is charged here. Rounds where no arbiter committed are treated as likely malformed requests and not charged, nor are rounds that failed before or outside the arbiters' part (no jury drawable, beacon quorum missed, commit window never closed).`}>Blameworthy</th>
              </tr>
            </thead>
            <tbody>
              {hData.operators.map((o) => (
                <OperatorRow
                  key={o.operator}
                  o={o}
                  windowLabel={windowLabel}
                  alert={alertsByOp[o.operator?.toLowerCase()]}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state"><Server size={32} /><p>No oracle activity in the window</p></div>
      )}
    </div>
  </section>
);

// ---- Response Timing section (per-window). Commit time = seconds from the
// request landing on-chain to the operator's commit; reveal time = seconds from
// the reveal request dispatched to the slot to the operator's reveal. Both come
// from block deltas (Base: fixed 2s blocks), so they are exact to the block.
const TIMING_COLORS = { commit: '#2a78d6', reveal: '#eb6834' };

const fmtSec = (v) => {
  if (v == null) return '—';
  const s = Math.round(v);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
};

// avg · min · max seconds with the average emphasized.
const secTriple = (t) => {
  if (!t || !t.count) return <span className="gas-muted">—</span>;
  return (
    <span className="gas-triple">
      <strong className="med">{fmtSec(t.avgSec)}</strong> · {fmtSec(t.minSec)} · {fmtSec(t.maxSec)}
    </span>
  );
};

// Cumulative commit / reveal stats across every operator, from the raw
// samples (so the average is sample-weighted, not an average of averages).
const overallTiming = (timing) => {
  const acc = { commit: [], reveal: [] };
  for (const [, kind, sec] of timing?.points || []) acc[kind === 'c' ? 'commit' : 'reveal'].push(sec);
  const summarize = (arr) => {
    if (!arr.length) return { count: 0, avgSec: null, minSec: null, maxSec: null };
    let sum = 0, min = Infinity, max = -Infinity;
    for (const v of arr) { sum += v; if (v < min) min = v; if (v > max) max = v; }
    return { count: arr.length, avgSec: Math.round((sum / arr.length) * 10) / 10, minSec: min, maxSec: max };
  };
  return { commit: summarize(acc.commit), reveal: summarize(acc.reveal) };
};

// Tick step (seconds) giving roughly 4–8 ticks across the axis.
const niceTickStep = (maxSeconds) => {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const st of steps) if (maxSeconds / st <= 8) return st;
  return 3600 * Math.ceil(maxSeconds / 3600 / 8);
};

// Deterministic pseudo-random in [0,1) from an index, so the vertical jitter
// of a dot is stable across renders.
const jitter = (i) => ((i * 9301 + 49297) % 233280) / 233280;

// Cluster (strip) chart: one row per operator, every commit and reveal as a
// translucent dot at its response time. Dense by design — no hover layer; the
// table above carries the numbers. Extreme outliers would flatten the cluster,
// so the axis stops at the 98th percentile when the max is far beyond it and
// the overflow dots are pinned to the right edge as small arrows.
function TimingCluster({ timing }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const ops = timing?.operators || [];
  const pts = timing?.points || [];
  if (!ops.length || !pts.length) return null;

  const secs = pts.map((p) => p[2]).sort((a, b) => a - b);
  const max = secs[secs.length - 1];
  const p98 = secs[Math.floor(0.98 * (secs.length - 1))];
  const clamp = max > 2.5 * Math.max(p98, 10);
  const axisMaxRaw = Math.max(10, clamp ? p98 : max);
  const tick = niceTickStep(axisMaxRaw);
  const axisMax = Math.ceil(axisMaxRaw / tick) * tick;
  const overflow = pts.filter((p) => p[2] > axisMax).length;

  const margin = { top: 10, right: 22, bottom: 36, left: 112 };
  const rowH = 30;
  const width = 720;
  const plotW = width - margin.left - margin.right;
  const plotH = ops.length * rowH;
  const height = margin.top + plotH + margin.bottom;
  const xScale = (v) => margin.left + (Math.min(v, axisMax) / axisMax) * plotW;
  const yRow = (i) => margin.top + i * rowH + rowH / 2;
  const ticks = [];
  for (let v = 0; v <= axisMax; v += tick) ticks.push(v);

  // Average markers: one per operator per kind (commit / reveal) with a value.
  const markers = [];
  ops.forEach((o, i) => {
    for (const kind of ['commit', 'reveal']) {
      const st = o[kind];
      if (st && st.count > 0 && st.avgSec != null) {
        markers.push({ operator: o.operator, kind, avg: st.avgSec, sd: st.stdDevSec, n: st.count, cx: xScale(st.avgSec), cy: yRow(i), clipped: st.avgSec > axisMax });
      }
    }
  });

  // Hover resolves to the nearest marker (viewBox units) from the svg root, so
  // two markers close together can't shadow each other.
  const MARKER_HOVER_RADIUS = 12;
  const onPointerMove = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = (e.clientX - rect.left) * (width / rect.width);
    const py = (e.clientY - rect.top) * (height / rect.height);
    let best = null, bestD = Infinity;
    markers.forEach((m, mi) => { const d = Math.hypot(m.cx - px, m.cy - py); if (d < bestD) { bestD = d; best = mi; } });
    if (best !== null && bestD <= MARKER_HOVER_RADIUS) {
      if (!hover || hover.mi !== best) setHover({ mi: best, m: markers[best] });
    } else if (hover) {
      setHover(null);
    }
  };

  return (
    <div className="timing-cluster">
      <div className="timing-legend">
        <span className="timing-legend-item"><span className="timing-swatch" style={{ background: TIMING_COLORS.commit }} />Commit (after request)</span>
        <span className="timing-legend-item"><span className="timing-swatch" style={{ background: TIMING_COLORS.reveal }} />Reveal (after reveal request)</span>
        <span className="timing-legend-item">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M4.2,4.2 L9.8,9.8 M9.8,4.2 L4.2,9.8" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Average (hover for std dev)
        </span>
        <span className="timing-legend-note">{pts.length.toLocaleString()} samples</span>
      </div>
      <div className="timing-cluster-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label="Commit and reveal response times per operator"
        ref={svgRef}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      >
        {ops.map((o, i) => (
          <g key={o.operator}>
            <line x1={margin.left} x2={margin.left + plotW} y1={yRow(i)} y2={yRow(i)} className="timing-rowline" />
            <text x={margin.left - 8} y={yRow(i)} className="timing-ylabel" dominantBaseline="middle" textAnchor="end">{shortAddr(o.operator)}</text>
          </g>
        ))}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={xScale(v)} x2={xScale(v)} y1={margin.top} y2={margin.top + plotH} className="timing-grid" />
            <text x={xScale(v)} y={margin.top + plotH + 16} className="timing-xlabel" textAnchor="middle">{fmtSec(v)}</text>
          </g>
        ))}
        <text x={margin.left + plotW / 2} y={height - 4} className="timing-xtitle" textAnchor="middle">
          response time{clamp ? ` (axis capped at 98th percentile; ${overflow} slower response${overflow === 1 ? '' : 's'} pinned at right)` : ''}
        </text>
        {pts.map((p, i) => {
          const [oi, kind, sec] = p;
          const color = kind === 'c' ? TIMING_COLORS.commit : TIMING_COLORS.reveal;
          const cy = yRow(oi) + (jitter(i) - 0.5) * (rowH - 10);
          if (sec > axisMax) {
            const x = margin.left + plotW + 4;
            return <path key={i} d={`M${x},${cy - 4} L${x + 7},${cy} L${x},${cy + 4} Z`} fill={color} fillOpacity={0.8} />;
          }
          return <circle key={i} cx={xScale(sec)} cy={cy} r={3} fill={color} fillOpacity={0.5} />;
        })}
        {/* Average markers: circle with an X, drawn over the dots */}
        {markers.map((m, mi) => {
          const color = TIMING_COLORS[m.kind];
          const r = hover && hover.mi === mi ? 7 : 6;
          const k = r * 0.55;
          return (
            <g key={`${m.operator}-${m.kind}`} className="timing-avg" tabIndex={0}
              onFocus={() => setHover({ mi, m })} onBlur={() => setHover(null)}>
              <circle cx={m.cx} cy={m.cy} r={r + 2} fill="var(--bg)" />
              <circle cx={m.cx} cy={m.cy} r={r} fill="var(--bg)" stroke={color} strokeWidth={2} />
              <path d={`M${m.cx - k},${m.cy - k} L${m.cx + k},${m.cy + k} M${m.cx + k},${m.cy - k} L${m.cx - k},${m.cy + k}`} stroke={color} strokeWidth={2} />
            </g>
          );
        })}
      </svg>
      {hover && (
        <div
          className={`timing-tooltip${hover.m.cy < height / 2 ? ' below' : ''}`}
          style={{ left: `${(hover.m.cx / width) * 100}%`, top: `${(hover.m.cy / height) * 100}%` }}
        >
          <div className="timing-tooltip-value">avg {fmtSec(hover.m.avg)}</div>
          <div className="timing-tooltip-row">
            <span className="timing-swatch" style={{ background: TIMING_COLORS[hover.m.kind] }} />
            {hover.m.kind === 'commit' ? 'Commit' : 'Reveal'} · σ {hover.m.sd != null ? fmtSec(hover.m.sd) : '—'} · n={hover.m.n}
          </div>
          <div className="timing-tooltip-row">{shortAddr(hover.m.operator)}{hover.m.clipped ? ' · beyond axis' : ''}</div>
        </div>
      )}
      </div>
    </div>
  );
}

// Daily average commit / reveal time over the window: one dot per day that has
// samples, dots joined by a line, with a crosshair tooltip on the nearest day.
function TimingDailyChart({ daily, generatedAt }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);
  if (!daily || daily.length < 2) return null;
  const anyData = daily.some((d) => d.avgCommitSec != null || d.avgRevealSec != null);
  if (!anyData) return null;

  const margin = { top: 12, right: 20, bottom: 30, left: 56 };
  const width = 720;
  const plotH = 118; // ~25% shorter than the original 170
  const height = margin.top + plotH + margin.bottom;
  const plotW = width - margin.left - margin.right;
  const n = daily.length;
  const xAt = (i) => margin.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  const vals = daily.flatMap((d) => [d.avgCommitSec, d.avgRevealSec]).filter((v) => v != null);
  const yMaxRaw = Math.max(10, ...vals);
  const yTick = niceTickStep(yMaxRaw * 1.6); // ~4–5 ticks: the plot is short
  const yMax = Math.ceil(yMaxRaw / yTick) * yTick;
  const yAt = (v) => margin.top + plotH - (v / yMax) * plotH;
  const yTicks = [];
  for (let v = 0; v <= yMax; v += yTick) yTicks.push(v);

  // Day labels: the newest bucket is today (relative to when the scan ran).
  const anchor = generatedAt ? new Date(generatedAt) : new Date();
  const labelFor = (d) => {
    const dt = new Date(anchor.getTime() - d.daysAgo * 86400000);
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const linePath = (key) => {
    let path = '';
    let pen = false;
    daily.forEach((d, i) => {
      const v = d[key];
      if (v == null) return;
      path += `${pen ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
      pen = true;
    });
    return path;
  };

  const onPointerMove = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const px = (e.clientX - rect.left) * (width / rect.width);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(xAt(i) - px); if (d < bestD) { bestD = d; best = i; } }
    if (hoverIdx !== best) setHoverIdx(best);
  };

  const h = hoverIdx != null ? daily[hoverIdx] : null;
  const series = [
    { key: 'avgCommitSec', countKey: 'commits', label: 'Commit', color: TIMING_COLORS.commit },
    { key: 'avgRevealSec', countKey: 'reveals', label: 'Reveal', color: TIMING_COLORS.reveal },
  ];

  return (
    <div className="timing-daily">
      <div className="timing-legend">
        <span className="timing-legend-item"><span className="timing-linekey" style={{ background: TIMING_COLORS.commit }} />Avg commit time</span>
        <span className="timing-legend-item"><span className="timing-linekey" style={{ background: TIMING_COLORS.reveal }} />Avg reveal time</span>
        <span className="timing-legend-note">per day · all operators</span>
      </div>
      <div className="timing-cluster-wrap">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          role="img"
          aria-label="Average commit and reveal time per day"
          ref={svgRef}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverIdx(null)}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={margin.left} x2={margin.left + plotW} y1={yAt(v)} y2={yAt(v)} className="timing-grid" />
              <text x={margin.left - 8} y={yAt(v)} className="timing-ylabel timing-ylabel-num" dominantBaseline="middle" textAnchor="end">{fmtSec(v)}</text>
            </g>
          ))}
          {daily.map((d, i) => (
            <text key={i} x={xAt(i)} y={margin.top + plotH + 16} className="timing-xlabel" textAnchor="middle">{labelFor(d)}</text>
          ))}
          {h && <line x1={xAt(hoverIdx)} x2={xAt(hoverIdx)} y1={margin.top} y2={margin.top + plotH} className="timing-crosshair" />}
          {series.map((sr) => (
            <g key={sr.key}>
              <path d={linePath(sr.key)} fill="none" stroke={sr.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {daily.map((d, i) => d[sr.key] != null && (
                <circle key={i} cx={xAt(i)} cy={yAt(d[sr.key])} r={hoverIdx === i ? 5 : 4} fill={sr.color} stroke="var(--bg)" strokeWidth={2} />
              ))}
            </g>
          ))}
        </svg>
        {h && (
          <div
            className="timing-tooltip below"
            style={{ left: `${(xAt(hoverIdx) / width) * 100}%`, top: `${(margin.top / height) * 100}%` }}
          >
            <div className="timing-tooltip-value">{labelFor(h)}</div>
            {series.map((sr) => (
              <div key={sr.key} className="timing-tooltip-row">
                <span className="timing-linekey" style={{ background: sr.color }} />
                {h[sr.key] != null ? <><strong>{fmtSec(h[sr.key])}</strong>&nbsp;{sr.label} · n={h[sr.countKey]}</> : <>{sr.label}: no samples</>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const renderTimingSection = (windowLabel, hData, hLoading, hError) => (
  <section className="analytics-section">
    <h2 title="How quickly each operator responds. Commit time = seconds from the evaluation request landing on-chain to this operator's commit. Reveal time = seconds from the reveal request being dispatched to the operator's reveal. Measured in whole blocks (2s each on Base)."><Clock size={20} className="inline-icon" /> Response Timing · {windowLabel}</h2>
    <div className="section-content">
      {hLoading && !hData ? (
        <div className="loading"><div className="spinner"></div><p>Scanning aggregator events…</p></div>
      ) : hError ? (
        <div className="info-banner"><AlertTriangle size={16} /><span>{hError}</span></div>
      ) : hData?.scanFailed ? (
        <ScanFailedBanner hData={hData} />
      ) : hData && !hData.timing ? (
        <div className="empty-state"><Clock size={32} /><p>Timing data is still being collected — refresh shortly.</p></div>
      ) : hData?.timing?.operators?.length > 0 ? (
        <>
          <div className="stats-table timing-table">
            <table>
              <thead>
                <tr>
                  <th>Operator</th>
                  <th className="tooltip-header" title="Commits with a measurable time (the request was inside the window)">Commits</th>
                  <th className="tooltip-header" title="Seconds from the request landing on-chain to this operator's commit: average · min · max">Commit time (avg · min · max)</th>
                  <th className="tooltip-header" title="Reveals with a measurable time (the reveal request was inside the window)">Reveals</th>
                  <th className="tooltip-header" title="Seconds from the reveal request dispatched to the slot to this operator's reveal: average · min · max">Reveal time (avg · min · max)</th>
                </tr>
              </thead>
              <tbody>
                {hData.timing.operators.map((o) => (
                  <tr key={o.operator}>
                    <td><code>{shortAddr(o.operator)}</code></td>
                    <td>{o.commit.count}</td>
                    <td>{secTriple(o.commit)}</td>
                    <td>{o.reveal.count}</td>
                    <td>{secTriple(o.reveal)}</td>
                  </tr>
                ))}
                {(() => {
                  const all = overallTiming(hData.timing);
                  return (
                    <tr className="timing-total-row" title="All operators combined. The average is over every sample, not an average of the per-operator averages.">
                      <td><strong>All operators</strong></td>
                      <td><strong>{all.commit.count}</strong></td>
                      <td>{secTriple(all.commit)}</td>
                      <td><strong>{all.reveal.count}</strong></td>
                      <td>{secTriple(all.reveal)}</td>
                    </tr>
                  );
                })()}
              </tbody>
            </table>
          </div>
          <TimingCluster timing={hData.timing} />
          <p className="health-footnote">
            Every commit and reveal in the window is one dot; its position is the operator's response time. Times are whole blocks (2s each on Base). Commit time is measured from the evaluation request; reveal time from the reveal request dispatched to that arbiter.
          </p>
          {hData.windowDays > 1 && <TimingDailyChart daily={hData.timing.daily} generatedAt={hData.generatedAt} />}
        </>
      ) : (
        <div className="empty-state"><Clock size={32} /><p>No oracle activity in the window</p></div>
      )}
    </div>
  </section>
);

// Gas-tracking display helpers (commit vs reveal gas per arbiter response).
const GAS_COLORS = { commit: '#3b82f6', reveal: '#8b5cf6' };
const fmtGas = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
// Costs are tiny on Base (sub-gwei) — show compact ETH, scientific below 0.1 mETH.
const fmtEth = (v) => (v == null ? '—' : `${v < 1e-4 ? v.toExponential(2) : v.toFixed(5)} ETH`);
// min · median · max of gas units. `emph` bolds the relevant value: 'median'
// (the robust central value) for typical-cost columns, or 'max' for the
// finalizing column, where the worst case drives the Chainlink job gasLimit.
const gasTriple = (s, emph = 'median') => {
  if (!s) return <span className="gas-muted">—</span>;
  const cell = (v, on) => (on ? <strong className="med">{fmtGas(v)}</strong> : fmtGas(v));
  return (
    <span className="gas-triple">
      {cell(s.gasUsed.min, false)} · {cell(s.gasUsed.median, emph === 'median')} · {cell(s.gasUsed.max, emph === 'max')}
    </span>
  );
};

function Analytics() {
  const toast = useToast();
  const { selectedNetwork } = useNetwork();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const isMountedRef = useRef(true);
  // Tracks the most recently requested network so a slow response for a network
  // the user has since switched away from is ignored.
  const requestedNetworkRef = useRef(selectedNetwork);

  // "Arbiters by Owner" section — loaded independently so the heavier
  // owner/withdrawable work doesn't block the sections above.
  const [ownersData, setOwnersData] = useState(null);
  const [ownersLoading, setOwnersLoading] = useState(true);
  const [ownersError, setOwnersError] = useState(null);
  const ownersReqNetRef = useRef(selectedNetwork);

  // "Oracle Health" sections (eval success rate + per-operator reliability) —
  // a heavy archive-log scan, loaded independently like the owner tables.
  const [healthData, setHealthData] = useState(() => healthCache[selectedNetwork] || null);
  const [healthLoading, setHealthLoading] = useState(() => !healthCache[selectedNetwork]);
  const [healthError, setHealthError] = useState(null);
  const healthReqNetRef = useRef(selectedNetwork);

  // Second oracle-health dataset over a 24-hour window, for the short-term
  // Operator Reliability table alongside the 14-day one.
  const [health24Data, setHealth24Data] = useState(() => health24Cache[selectedNetwork] || null);
  const [health24Loading, setHealth24Loading] = useState(() => !health24Cache[selectedNetwork]);
  const [health24Error, setHealth24Error] = useState(null);
  const health24ReqNetRef = useRef(selectedNetwork);

  // Live watchdog reports pushed by arbiter nodes (POST /api/alerts). Cheap
  // read — no on-chain work — loaded independently of the heavy sections.
  const [alertsData, setAlertsData] = useState(null);
  const alertsReqNetRef = useRef(selectedNetwork);

  const loadAnalytics = useCallback(async (network, silent = false) => {
    if (!isMountedRef.current) return;
    requestedNetworkRef.current = network;

    try {
      if (!silent) setLoading(true);
      setError(null);

      const result = await apiService.getAnalyticsOverview(network);

      if (!isMountedRef.current || network !== requestedNetworkRef.current) return;
      if (result.success) {
        setData(result.data);
        setLastUpdated(new Date());
      } else {
        throw new Error(result.error || 'Failed to load analytics');
      }
    } catch (err) {
      if (isMountedRef.current && network === requestedNetworkRef.current) {
        console.error('Error loading analytics:', err);
        setError(err.message || 'Failed to load analytics');
        if (!silent) toast.error('Failed to load analytics data');
      }
    } finally {
      if (isMountedRef.current && network === requestedNetworkRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [toast]);

  // Load the by-owner table.
  const loadOwners = useCallback(async (network) => {
    ownersReqNetRef.current = network;
    try {
      const res = await apiService.getOwnersAnalytics(network);
      if (!isMountedRef.current || network !== ownersReqNetRef.current) return;
      if (!res.success) throw new Error(res.error || 'Failed to load owners');
      setOwnersData(res.data);
      setOwnersError(null);
      setOwnersLoading(false);
    } catch (err) {
      if (isMountedRef.current && network === ownersReqNetRef.current) {
        setOwnersError(err.message || 'Failed to load owners');
        setOwnersLoading(false);
      }
    }
  }, []);

  // Load the oracle-health sections (network success rate + operator reliability).
  const loadHealth = useCallback(async (network) => {
    healthReqNetRef.current = network;
    try {
      const res = await apiService.getOracleHealth(network);
      if (!isMountedRef.current || network !== healthReqNetRef.current) return;
      if (!res.success) throw new Error(res.error || 'Failed to load oracle health');
      healthCache[network] = res.data;
      setHealthData(res.data);
      setHealthError(null);
      setHealthLoading(false);
    } catch (err) {
      if (isMountedRef.current && network === healthReqNetRef.current) {
        setHealthError(err.message || 'Failed to load oracle health');
        setHealthLoading(false);
      }
    }
  }, []);

  // Load the 24-hour oracle-health dataset (days=1) for the short-term table.
  const loadHealth24 = useCallback(async (network) => {
    health24ReqNetRef.current = network;
    try {
      const res = await apiService.getOracleHealth(network, 1);
      if (!isMountedRef.current || network !== health24ReqNetRef.current) return;
      if (!res.success) throw new Error(res.error || 'Failed to load oracle health');
      health24Cache[network] = res.data;
      setHealth24Data(res.data);
      setHealth24Error(null);
      setHealth24Loading(false);
    } catch (err) {
      if (isMountedRef.current && network === health24ReqNetRef.current) {
        setHealth24Error(err.message || 'Failed to load oracle health');
        setHealth24Loading(false);
      }
    }
  }, []);

  // Load the watchdog alerts snapshot. Best-effort: the section renders an
  // empty state if the read fails (never blocks the rest of the page).
  const loadAlerts = useCallback(async (network) => {
    alertsReqNetRef.current = network;
    try {
      const res = await apiService.getAlerts(network);
      if (!isMountedRef.current || network !== alertsReqNetRef.current) return;
      setAlertsData(res.success ? res.data : null);
    } catch {
      if (isMountedRef.current && network === alertsReqNetRef.current) setAlertsData(null);
    }
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await apiService.refreshAnalytics(selectedNetwork);
      await loadAnalytics(selectedNetwork, true);
      loadOwners(selectedNetwork);
      loadHealth(selectedNetwork);
      loadHealth24(selectedNetwork);
      loadAlerts(selectedNetwork);
      toast.success('Analytics refreshed');
    } catch {
      toast.error('Failed to refresh analytics');
      setRefreshing(false);
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // (Re)load whenever the globally-selected network changes.
  useEffect(() => {
    setData(null);
    loadAnalytics(selectedNetwork);
  }, [selectedNetwork, loadAnalytics]);

  // Load the by-owner table on network change.
  useEffect(() => {
    setOwnersData(null);
    setOwnersLoading(true);
    setOwnersError(null);
    loadOwners(selectedNetwork);
  }, [selectedNetwork, loadOwners]);

  // Load the oracle-health sections on network change. Seed from the cross-mount
  // cache (if present) so the table shows immediately while a refresh runs.
  useEffect(() => {
    const cached = healthCache[selectedNetwork];
    setHealthData(cached || null);
    setHealthLoading(!cached);
    setHealthError(null);
    loadHealth(selectedNetwork);
  }, [selectedNetwork, loadHealth]);

  // Load the 24-hour oracle-health dataset on network change (cache-seeded too).
  useEffect(() => {
    const cached = health24Cache[selectedNetwork];
    setHealth24Data(cached || null);
    setHealth24Loading(!cached);
    setHealth24Error(null);
    loadHealth24(selectedNetwork);
  }, [selectedNetwork, loadHealth24]);

  // Load watchdog alerts on network change, and keep them fresh with a light
  // poll — heartbeats land every ~2 minutes, so 60s keeps the card current
  // without meaningful load (the read is file-backed, no RPC).
  useEffect(() => {
    setAlertsData(null);
    loadAlerts(selectedNetwork);
    const timer = setInterval(() => loadAlerts(selectedNetwork), 60000);
    return () => clearInterval(timer);
  }, [selectedNetwork, loadAlerts]);

  // Format time ago
  const formatTimeAgo = (date) => {
    if (!date) return 'Never';
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  if (loading) {
    return (
      <div className="analytics">
        <div className="page-header">
          <div className="header-content">
            <h1><BarChart3 size={28} className="inline-icon" /> Analytics</h1>
            <p>Arbiter availability and system diagnostics</p>
          </div>
        </div>
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading analytics...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="analytics">
        <div className="page-header">
          <div className="header-content">
            <h1><BarChart3 size={28} className="inline-icon" /> Analytics</h1>
            <p>Arbiter availability and system diagnostics</p>
          </div>
        </div>
        <div className="error-container">
          <AlertTriangle size={48} />
          <h2>Failed to Load Analytics</h2>
          <p>{error}</p>
          <button onClick={() => loadAnalytics(selectedNetwork)} className="btn btn-primary">
            <RefreshCw size={16} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  // Daily fulfilled/failed trend over the full scan window (small stacked bars
  // in the success block).
  const trend = healthData?.dailyTrend || [];
  const dailyChartData = trend.length ? {
    labels: trend.map(d => (d.daysAgo === 0 ? 'now' : `${d.daysAgo}d`)),
    datasets: [
      { label: 'Fulfilled', data: trend.map(d => d.fulfilled), backgroundColor: COLORS.active, stack: 's' },
      { label: 'Failed', data: trend.map(d => d.failed), backgroundColor: COLORS.blocked, stack: 's' },
      { label: 'Likely malformed', data: trend.map(d => d.malformed || 0), backgroundColor: COLORS.inactive, stack: 's' },
      { label: 'Not drawn', data: trend.map(d => d.notDrawn || 0), backgroundColor: COLORS.frozen, stack: 's' }
    ]
  } : null;
  const dailyChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      // autoSkip thins the labels so a ~14-day window stays legible.
      x: { stacked: true, grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      y: { stacked: true, beginAtZero: true, display: false, ticks: { precision: 0 } }
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => {
            const d = trend[items[0].dataIndex];
            return d.daysAgo === 0 ? 'Today' : `${d.daysAgo} day${d.daysAgo === 1 ? '' : 's'} ago`;
          }
        }
      }
    }
  };

  // Gas-per-response: daily avg gas (commit vs reveal) over the window, and the
  // per-operator min/median/max table data. Built from the same health scan.
  const gasTrend = healthData?.gas?.daily || [];
  const gasHasData = gasTrend.some(d => d.avgGasCommit != null || d.avgGasReveal != null);
  const gasChartData = gasHasData ? {
    labels: gasTrend.map(d => (d.daysAgo === 0 ? 'now' : `${d.daysAgo}d`)),
    datasets: [
      { label: 'Commit', data: gasTrend.map(d => d.avgGasCommit), backgroundColor: GAS_COLORS.commit },
      { label: 'Reveal (all: normal + finalizing)', data: gasTrend.map(d => d.avgGasReveal), backgroundColor: GAS_COLORS.reveal }
    ]
  } : null;
  const gasChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      // Gas units abbreviated (e.g. 100k) to keep the axis narrow.
      y: { beginAtZero: true, ticks: { font: { size: 9 }, callback: (v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v) } }
    },
    plugins: {
      legend: { display: true, position: 'bottom', labels: { font: { size: 10 }, boxWidth: 10 } },
      tooltip: {
        callbacks: {
          title: (items) => {
            const d = gasTrend[items[0].dataIndex];
            return d.daysAgo === 0 ? 'Today' : `${d.daysAgo} day${d.daysAgo === 1 ? '' : 's'} ago`;
          },
          label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? '—' : ctx.parsed.y.toLocaleString()} gas`
        }
      }
    }
  };
  const gasFinal = healthData?.gas?.finalization || null;
  const gasScan = healthData?.gas?.scan || null;
  const operatorsWithGas = (healthData?.operators || []).filter(o => o.gas && (o.gas.commit || o.gas.reveal || o.gas.finalizing));

  // Watchdog alerts: index by operator for the reliability-table dots, and
  // bucket by reporting state for the Arbiter Alerts card.
  const alertOps = alertsData?.operators || [];
  const alertsByOp = Object.fromEntries(alertOps.map((r) => [r.operator.toLowerCase(), r]));
  const activeAlerts = alertOps.filter((r) => r.state === 'alerting');
  const staleReporters = alertOps.filter((r) => r.state === 'stale');
  const okReporters = alertOps.filter((r) => r.state === 'ok');
  // One node/operator backs many arbiters (registered jobIds); the server
  // enriches each reporter with its count plus network-wide coverage.
  const alertCoverage = alertsData?.coverage || null;
  const okArbiters = okReporters.reduce((n, r) => n + (r.arbiters || 0), 0);

  // Prepare chart data for arbiter availability, grouped by owner so the chart
  // matches the table below. One stacked bar per owner; segments are statuses.
  const chartOwners = ownersData?.owners || [];
  const arbiterChartData = chartOwners.length ? {
    labels: chartOwners.map(o => (o.owner ? shortAddr(o.owner) : 'Unknown')),
    datasets: STATUS_ORDER.map(({ key, label }) => ({
      label, data: chartOwners.map(o => o[key] ?? 0), backgroundColor: COLORS[key]
    }))
  } : null;

  const arbiterChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { stacked: true, title: { display: true, text: 'Owner' } },
      y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Arbiter Count' } }
    },
    plugins: {
      legend: { display: false }, // Using custom legend for tooltip support
      tooltip: {
        callbacks: {
          afterLabel: (context) => {
            const status = context.dataset.label;
            return ARBITER_STATUS_DESCRIPTIONS[status] ? `\n${ARBITER_STATUS_DESCRIPTIONS[status]}` : '';
          }
        }
      }
    }
  };

  return (
    <div className="analytics">
      {/* Header */}
      <div className="page-header">
        <div className="header-content">
          <h1><BarChart3 size={28} className="inline-icon" /> Analytics</h1>
          <p>Arbiter availability and system diagnostics</p>
        </div>
        <div className="header-actions">
          <span className="last-updated">
            <Clock size={14} /> Updated {formatTimeAgo(lastUpdated)}
          </span>
          <button
            onClick={handleRefresh}
            className="btn btn-secondary btn-with-icon"
            disabled={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? 'spinning' : ''} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Arbiter Alerts Section — live node-health reports pushed by each
          operator node's watchdog (cron, ~2 min). Every reporting node is
          listed (alerting first, then stale, then healthy) with its arbiter
          count and chainlink uptime. */}
      <section className="analytics-section">
        <h2 title="Live health reports pushed by each operator node's watchdog (every ~2 minutes). Alerting = the node reported a problem (e.g. 0 live RPC nodes — it cannot submit commit/reveal transactions). Not reporting = heartbeats stopped, so the node or its machine may be down. Operators that haven't configured watchdog reporting don't appear.">
          <BellRing size={20} className="inline-icon" /> Arbiter Alerts
        </h2>
        <div className="section-content">
          {alertOps.length === 0 ? (
            <div className="empty-state">
              <HeartPulse size={32} />
              <p>No arbiters are reporting watchdog health yet</p>
              <p className="empty-state-hint">
                Node operators opt in by pointing <code>WATCHDOG_ALERT_WEBHOOK</code> at this
                site's <code>/api/alerts</code> endpoint (see the arbiter installer docs).
              </p>
            </div>
          ) : (
            <>
              {activeAlerts.length === 0 && staleReporters.length === 0 && (
                <div className="alert-allclear">
                  <CheckCircle size={16} style={{ color: COLORS.active }} />
                  <span>
                    All {okReporters.length} operator node{okReporters.length === 1 ? '' : 's'} healthy
                    {okArbiters > 0 ? ` — backing ${okArbiters} arbiter${okArbiters === 1 ? '' : 's'}` : ''}
                  </span>
                </div>
              )}
              <div className="stats-table">
                <table>
                  <thead>
                    <tr>
                      <th>State</th>
                      <th>Operator</th>
                      <th>Host</th>
                      <th className="tooltip-header" title="How long this node's chainlink container has been running (host uptime and image in the cell tooltip)">Uptime</th>
                      <th className="tooltip-header" title="When this node's watchdog last reported (heartbeats arrive every ~2 minutes)">Last report</th>
                      <th>Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alertOps.map((r) => (
                      <tr key={r.operator}>
                        <td>
                          <span className="alert-state-badge" style={{ backgroundColor: ALERT_STATE[r.state].color }}
                                title={ALERT_STATE[r.state].desc}>
                            {ALERT_STATE[r.state].label}
                          </span>
                        </td>
                        <td>
                          <code>{shortAddr(r.operator)}</code>
                          {r.arbiters != null && <span className="alert-arbiter-count"> · {r.arbiters} arbiter{r.arbiters === 1 ? '' : 's'}</span>}
                        </td>
                        <td>{r.hostname || '—'}</td>
                        <td title={[
                          r.hostUptimeSec != null ? `host up ${fmtUptime(r.hostUptimeSec)}` : null,
                          r.chainlinkImage || null,
                        ].filter(Boolean).join(' — ') || undefined}>
                          {fmtUptime(r.chainlinkUptimeSec) || '—'}
                        </td>
                        <td>{fmtAgoMs(r.lastSeen)}</td>
                        <td className="alert-problem-cell">
                          {r.state === 'alerting' && r.activeAlert ? (
                            <>
                              <strong>{r.activeAlert.subject}</strong>
                              {r.activeAlert.problems?.length > 0 && (
                                <ul className="alert-problem-list">
                                  {r.activeAlert.problems.slice(0, 4).map((p, i) => <li key={i}>{p}</li>)}
                                </ul>
                              )}
                              <span className="alert-since">since {fmtAgoMs(r.activeAlert.since)}</span>
                            </>
                          ) : r.state === 'stale' ? (
                            <span className="alert-since">heartbeats stopped — node or machine may be down</span>
                          ) : (
                            <span className="alert-since">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {alertCoverage && alertCoverage.totalArbiters > 0 && (
                <p className="health-footnote" title="Arbiters whose operator's node reports watchdog health here, vs. all arbiters registered in the ReputationKeeper. Operators enable reporting by setting WATCHDOG_ALERT_WEBHOOK on their node.">
                  Watchdog reporting covers {alertCoverage.coveredArbiters} of {alertCoverage.totalArbiters} registered arbiters.
                </p>
              )}
            </>
          )}
        </div>
      </section>

      {/* Arbiter Availability Section */}
      <section className="analytics-section">
        <h2 title={data?.system?.aggregatorConfig
          ? `Each request draws a jury of ${data?.system?.aggregatorConfig.K} distinct selectable arbiters (no duplicates: the draw fails if fewer are eligible). ${data?.system?.aggregatorConfig.M} must commit, ${data?.system?.aggregatorConfig.M} commits are promoted to reveal, and ${data?.system?.aggregatorConfig.N} reveals finalize the result.`
          : 'Arbiters per owner, by status'}><Users size={20} className="inline-icon" /> Arbiter Availability</h2>
        {!data?.arbiters?.verdiktaConnected && (
          <div className="info-banner">
            <AlertTriangle size={16} />
            <span>{data?.arbiters?.message || 'Verdikta aggregator not connected'}</span>
          </div>
        )}
        <div className="section-content">
          {ownersLoading && !ownersData ? (
            <div className="loading"><div className="spinner"></div><p>Loading arbiters...</p></div>
          ) : ownersError ? (
            <div className="info-banner"><AlertTriangle size={16} /><span>{ownersError}</span></div>
          ) : arbiterChartData ? (
            <>
              <div className="chart-container chart-bar">
                <Bar data={arbiterChartData} options={arbiterChartOptions} />
                <div className="custom-legend">
                  {STATUS_ORDER.map(({ key, label }) => (
                    <span key={key} className="legend-item" title={ARBITER_STATUS_DESCRIPTIONS[label]}>
                      <span className="legend-color" style={{ backgroundColor: COLORS[key] }}></span>
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <Users size={32} />
              <p>No arbiter data available</p>
            </div>
          )}
          {data?.arbiters?.totalOracles != null && (
            <div className="stat-highlight">
              <strong>{data.arbiters.totalOracles}</strong> registered arbiters
            </div>
          )}
        </div>
      </section>

      {/* Oracle Eval Success Rate Section */}
      <section className="analytics-section">
        <h2 title="Share of decided oracle evaluation rounds that completed successfully (a FulfillAIEvaluation event) over the look-back window; the rest failed at settlement without enough commits or reveals. Rounds where no arbiter committed are counted separately as likely malformed, rounds that never reached the arbiters as not drawn, and rounds still running are not yet counted."><Activity size={20} className="inline-icon" /> Oracle Eval Success Rate</h2>
        <div className="section-content">
          {healthLoading && !healthData ? (
            <div className="loading"><div className="spinner"></div><p>Scanning aggregator events…</p></div>
          ) : healthError ? (
            <div className="info-banner"><AlertTriangle size={16} /><span>{healthError}</span></div>
          ) : healthData?.scanFailed ? (
            <ScanFailedBanner hData={healthData} />
          ) : healthData ? (
            <>
              <div className="health-stats">
                <div className="health-stat">
                  <span className="health-stat-value" style={{ color: rateColor(healthData.success.successRatePct) }}>
                    {healthData.success.successRatePct == null ? '—' : `${healthData.success.successRatePct}%`}
                  </span>
                  <span className="health-stat-label">Success rate</span>
                </div>
                <div className="health-stat">
                  <span className="health-stat-value">{healthData.success.requests}</span>
                  <span className="health-stat-label">Requests</span>
                </div>
                <div className="health-stat">
                  <span className="health-stat-value" style={{ color: COLORS.active }}>{healthData.success.fulfilled}</span>
                  <span className="health-stat-label">Fulfilled</span>
                </div>
                <div className="health-stat">
                  <span className="health-stat-value" style={{ color: COLORS.blocked }}>{healthData.success.unfulfilled}</span>
                  <span className="health-stat-label">Failed</span>
                </div>
                <div
                  className="health-stat"
                  title="Requests where not a single selected arbiter committed. Every arbiter rejecting the same request usually means the request itself is unusable (e.g. a CID that isn't a valid archive or a manifest that fails validation), so these count as neither successes nor failures and no arbiter is blamed."
                >
                  <span className="health-stat-value" style={{ color: COLORS.inactive }}>{healthData.success.likelyMalformed ?? 0}</span>
                  <span className="health-stat-label">Likely malformed</span>
                </div>
                <div
                  className="health-stat"
                  title="Rounds that never reached the arbiters: no jury could be drawn (fewer eligible arbiters than the jury size), the beacon quorum was missed, or the round was cancelled undrawn. Not counted in the success rate."
                >
                  <span className="health-stat-value" style={{ color: COLORS.frozen }}>{healthData.success.notDrawn ?? 0}</span>
                  <span className="health-stat-label">Not drawn</span>
                </div>
                {dailyChartData && (
                  <div className="health-chart" title={`Fulfilled (green) vs failed (red) vs likely malformed (grey) vs not drawn (blue) evaluations per day — last ${healthData.windowDays} days`}>
                    <div className="health-chart-canvas"><Bar data={dailyChartData} options={dailyChartOptions} /></div>
                    <span className="health-stat-label">{healthData.windowDays}-day trend</span>
                  </div>
                )}
              </div>
              <p className="health-footnote">
                Last {healthData.windowDays} days (blocks {healthData.fromBlock.toLocaleString()}–{healthData.toBlock.toLocaleString()}).
                {healthData.partial ? ` Partial scan — ${healthData.chunkErrors} of ${healthData.totalChunks} log queries failed, so some activity is missing.` : ''} {healthData.success.inProgress ? ` ${healthData.success.inProgress} round${healthData.success.inProgress === 1 ? ' is' : 's are'} still in progress and not yet counted.` : ''}
              </p>
            </>
          ) : (
            <div className="empty-state"><Activity size={32} /><p>No oracle health data</p></div>
          )}
        </div>
      </section>

      {/* Operator Reliability — 14-day and 24-hour windows */}
      {renderReliabilitySection('Last 14 days', healthData, healthLoading, healthError, alertsByOp)}
      {renderReliabilitySection('Last 24 hours', health24Data, health24Loading, health24Error, alertsByOp)}

      {/* Response Timing — same two windows, table + cluster chart */}
      {renderTimingSection('Last 14 days', healthData, healthLoading, healthError)}
      {renderTimingSection('Last 24 hours', health24Data, health24Loading, health24Error)}

      {/* Gas per Commit / Reveal Section */}
      <section className="analytics-section">
        <h2 title="Gas each arbiter spends per response. A commit and a reveal are two separate transactions; their gas varies, so min · median · max is shown. The transaction that completes a round also runs the aggregation, so its (much higher) gas is reported separately as finalization and excluded from the per-operator reveal stats."><Fuel size={20} className="inline-icon" /> Gas per Commit / Reveal</h2>
        <div className="section-content">
          {healthLoading && !healthData ? (
            <div className="loading"><div className="spinner"></div><p>Scanning aggregator events…</p></div>
          ) : healthError ? (
            <div className="info-banner"><AlertTriangle size={16} /><span>{healthError}</span></div>
          ) : healthData?.scanFailed ? (
            <ScanFailedBanner hData={healthData} />
          ) : healthData && operatorsWithGas.length > 0 ? (
            <>
              {gasChartData && (
                <div className="gas-chart">
                  <div className="gas-chart-title">Average gas per response · last {healthData.windowDays} days</div>
                  <div className="gas-chart-canvas"><Bar data={gasChartData} options={gasChartOptions} /></div>
                </div>
              )}
              <div className="stats-table">
                <table>
                  <thead>
                    <tr>
                      <th>Operator</th>
                      <th className="tooltip-header" title="Gas used by commit transactions: minimum · median · max over the window. Median is the robust typical value.">Commit gas (min · med · max)</th>
                      <th className="tooltip-header" title="Gas used by normal reveal transactions — the response did not complete the round. min · median · max.">Reveal gas (min · med · max)</th>
                      <th className="tooltip-header" title="Gas for the reveal that also runs the aggregation (one per completed round) — far higher than a normal reveal. Its MAX (bold) is the worst case a node's Chainlink job-spec gasLimit must exceed, or finalization runs out of gas.">Finalizing reveal (min · med · max)</th>
                      <th className="tooltip-header" title="Average ETH cost per commit / per reveal (gas × effective gas price actually paid). The reveal figure blends normal AND finalizing reveals — the true average an operator pays, since ~1 in 4 reveals is an expensive finalizing one.">Avg cost (commit / reveal)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operatorsWithGas.map((o) => (
                      <tr key={o.operator}>
                        <td><code>{shortAddr(o.operator)}</code></td>
                        <td>{gasTriple(o.gas?.commit)}</td>
                        <td>{gasTriple(o.gas?.reveal)}</td>
                        <td>{gasTriple(o.gas?.finalizing, 'max')}</td>
                        <td>{fmtEth(o.gas?.commit?.costEth?.avg)} <span className="gas-muted">/</span> {fmtEth(o.gas?.revealAll?.costEth?.avg)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="health-footnote">
                Gas units (price-independent across runs). A <em>finalizing reveal</em> is the response that also runs the aggregation (one per completed round), costing far more than a normal one. The <strong>Reveal</strong> and <strong>Finalizing</strong> columns show them separately. The bar chart&rsquo;s <strong>Reveal (all)</strong> series and the <strong>Avg cost</strong> column <strong>blend both</strong> — normal and finalizing reveals together (≈¼ of reveals are finalizing) — for the true per-reveal figure, so the chart&rsquo;s reveal bar sits above the Reveal column&rsquo;s median. The chart is also a network-wide daily <em>average</em> across all operators, not a per-operator median.
                {gasFinal ? <> <strong>Highest finalizing reveal seen: {fmtGas(gasFinal.gasUsed.max)} gas</strong> — a node's Chainlink job-spec <code>gasLimit</code> must exceed this to avoid an out-of-gas failure during finalization.</> : ''}
                {gasScan?.partial ? ' Receipt backfill incomplete — some gas data is still being collected; refresh shortly.' : ''}
              </p>
            </>
          ) : healthData && healthData.operators.length > 0 ? (
            // Reliability data exists but receipts not yet backfilled (or none in window).
            <div className="empty-state"><Fuel size={32} /><p>{gasScan?.partial ? 'Collecting gas receipts — refresh shortly.' : 'No gas data for this window yet.'}</p></div>
          ) : (
            <div className="empty-state"><Fuel size={32} /><p>No oracle activity in the window</p></div>
          )}
        </div>
      </section>

      {/* Arbiters by Owner Section */}
      <section className="analytics-section">
        <h2 title="Arbiters grouped by the wallet that owns their operator contract"><UserCircle size={20} className="inline-icon" /> Arbiters by Owner</h2>
        <div className="section-content">
          {ownersLoading && !ownersData ? (
            <div className="loading"><div className="spinner"></div><p>Loading owners...</p></div>
          ) : ownersError ? (
            <div className="info-banner"><AlertTriangle size={16} /><span>{ownersError}</span></div>
          ) : ownersData && ownersData.owners.length > 0 ? (
            <div className="stats-table">
              <table>
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th>Arbiters</th>
                    {STATUS_ORDER.map(({ key, label }) => (
                      <th key={key} className="tooltip-header" title={ARBITER_STATUS_DESCRIPTIONS[label]}>{label}</th>
                    ))}
                    <th className="tooltip-header" title="Average quality score across this owner's arbiters">Avg Quality</th>
                    <th className="tooltip-header" title="Average timeliness score across this owner's arbiters">Avg Timeliness</th>
                    <th className="tooltip-header" title="ETH currently claimable by this owner (ethOwed on the aggregator, aggregated across their operators)"><Coins size={13} className="inline-icon" /> Claimable ETH</th>
                  </tr>
                </thead>
                <tbody>
                  {ownersData.owners.map((o) => (
                    <tr key={o.owner || 'unknown'}>
                      <td>
                        {o.owner ? (
                          <Link className="class-link" to={`/owner/${o.owner}`} title={`View arbiters owned by ${o.owner}`}>
                            <code>{shortAddr(o.owner)}</code>
                          </Link>
                        ) : (
                          <span className="text-muted">Unknown</span>
                        )}
                      </td>
                      <td><strong>{o.arbiters}</strong>{o.operators > 1 ? ` (${o.operators} operators)` : ''}</td>
                      {STATUS_ORDER.map(({ key }) => (
                        <td key={key} style={{ color: COLORS[key], fontWeight: 600 }}>{o[key] ?? '-'}</td>
                      ))}
                      <td>{o.avgQualityScore}</td>
                      <td>{o.avgTimelinessScore}</td>
                      <td>{o.claimableEth ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state"><UserCircle size={32} /><p>No arbiter owners found</p></div>
          )}
        </div>
      </section>

      {/* Funding by Owner Section */}
      <section className="analytics-section">
        <h2 title="ETH held in each owner's arbiter-node sending keys, which pay gas for commit/reveal responses"><Fuel size={20} className="inline-icon" /> Funding by Owner</h2>
        <div className="section-content">
          {ownersLoading && !ownersData ? (
            <div className="loading"><div className="spinner"></div><p>Loading funding...</p></div>
          ) : ownersError ? (
            <div className="info-banner"><AlertTriangle size={16} /><span>{ownersError}</span></div>
          ) : ownersData && ownersData.owners.length > 0 ? (
            <div className="stats-table">
              <table>
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th className="tooltip-header" title="Total ETH across this owner's node sending keys">Node ETH</th>
                    <th className="tooltip-header" title="Estimated queries that ETH covers at the current gas price">Est. Queries</th>
                    <th>Funding</th>
                  </tr>
                </thead>
                <tbody>
                  {ownersData.owners.map((o) => (
                    <tr key={o.owner || 'unknown'}>
                      <td>
                        {o.owner ? (
                          <Link className="class-link" to={`/owner/${o.owner}`} title={o.owner}>
                            <code>{shortAddr(o.owner)}</code>
                          </Link>
                        ) : (
                          <span className="text-muted">Unknown</span>
                        )}
                      </td>
                      <td>
                        {o.owner && o.nodeEth != null ? (
                          <Link className="class-link" to={`/owner/${o.owner}#funding`} title="View per-key funding breakdown">
                            {Number(o.nodeEth).toFixed(4)}
                          </Link>
                        ) : (
                          o.nodeEth != null ? Number(o.nodeEth).toFixed(4) : '—'
                        )}
                      </td>
                      <td>{o.estQueries != null ? o.estQueries.toLocaleString() : '—'}</td>
                      <td style={{ color: o.fundingLow ? COLORS.blocked : COLORS.active, fontWeight: 600 }}>
                        {o.fundingLow ? 'Low' : 'OK'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ownersData.funding && (
                <p className="table-note">
                  Estimates assume ~{ownersData.funding.gasPerQuery.toLocaleString()} gas per query at{' '}
                  {ownersData.funding.gasPriceGwei} gwei; &ldquo;Low&rdquo; means under{' '}
                  {ownersData.funding.lowQueriesThreshold.toLocaleString()} queries or{' '}
                  {ownersData.funding.lowEthThreshold} ETH. Changes with gas price.
                </p>
              )}
            </div>
          ) : (
            <div className="empty-state"><Fuel size={32} /><p>No funding data</p></div>
          )}
        </div>
      </section>

      {/* System Health Section */}
      <section className="analytics-section">
        <h2><Server size={20} className="inline-icon" /> System Health</h2>
        <div className="section-content">
          <div className="health-grid">
            {/* Contract Addresses */}
            <div className="health-card wide">
              <div className="health-header">
                <span className={`health-status ${data?.system?.verdikta?.healthy ? 'healthy' : 'unhealthy'}`}>
                  {data?.system?.verdikta?.healthy ? <CheckCircle size={16} /> : <XCircle size={16} />}
                </span>
                <span className="health-title">Contract Addresses</span>
              </div>
              <div className="health-details">
                {data?.system?.verdikta?.configured ? (
                  <div className="contract-addresses">
                    {data.system.verdikta.aggregatorAddress && (
                      <div className="contract-row">
                        <span className="contract-label">Verdikta Aggregator:</span>
                        <code className="address">{data.system.verdikta.aggregatorAddress}</code>
                      </div>
                    )}
                    {data.system.verdikta.keeperAddress && (
                      <div className="contract-row">
                        <span className="contract-label">Reputation Keeper:</span>
                        <code className="address">{data.system.verdikta.keeperAddress}</code>
                      </div>
                    )}
                    {data.system.verdikta.linkTokenAddress && (
                      <div className="contract-row">
                        <span className="contract-label">Transport Token (0-juel):</span>
                        <code className="address">{data.system.verdikta.linkTokenAddress}</code>
                      </div>
                    )}
                    {data.system.verdikta.wvdkaAddress && (
                      <div className="contract-row">
                        <span className="contract-label">wVDKA Token:</span>
                        <code className="address">{data.system.verdikta.wvdkaAddress}</code>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-muted">Not configured</p>
                )}
              </div>
            </div>

            {/* Aggregator Config */}
            {data?.system?.aggregatorConfig && (
              <div className="health-card wide">
                <div className="health-header">
                  <span className="health-status healthy"><Zap size={16} /></span>
                  <span className="health-title">Aggregator Configuration</span>
                </div>
                <div className="health-details config-grid">
                  <div className="config-item">
                    <span className="config-label">Jury (K)</span>
                    <span className="config-value">{data.system.aggregatorConfig.K}</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Commits needed / promoted (M)</span>
                    <span className="config-value">{data.system.aggregatorConfig.M}</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Early close (M+)</span>
                    <span className="config-value">{data.system.aggregatorConfig.mPlus}</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Reveals to finalize (N)</span>
                    <span className="config-value">{data.system.aggregatorConfig.N}</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Cluster (P)</span>
                    <span className="config-value">{data.system.aggregatorConfig.P}</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Bonus Multiplier</span>
                    <span className="config-value">{data.system.aggregatorConfig.bonusMultiplier}x</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Round timeout</span>
                    <span className="config-value">{data.system.aggregatorConfig.responseTimeoutSeconds}s</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Commit window (T+)</span>
                    <span className="config-value">{data.system.aggregatorConfig.tPlus ?? '—'}s</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Max Oracle Fee</span>
                    <span className="config-value">{data.system.aggregatorConfig.maxOracleFee} ETH</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export default Analytics;
