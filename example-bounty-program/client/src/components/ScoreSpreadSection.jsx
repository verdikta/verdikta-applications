/**
 * Arbiter Score Spread section of /analytics.
 *
 * For every evaluation round (re-runs included), the standard deviation of the
 * arbiters' FUND scores across the round's N counted reveals (getOutcomeScores;
 * a late reveal stores no scores and is not in it). The cluster is the reveals
 * paid a bonus (unknown when no bonus was paid). Data:
 * GET /api/analytics/score-spread (server/utils/scoreSpread.js).
 *
 *   - stat tiles: pooled sd (the per-response noise), median and 90th
 *     percentile round sd, share of rounds that agree / have an outlier,
 *     and the earlier-half vs recent-half change;
 *   - daily chart: pooled, median round, and cluster pooled sd per day, like the Response
 *     Timing chart on arbiters.verdikta.org/analytics;
 *   - round chart: every round as a dot at its sd; click one to open it below;
 *   - drill-down: rounds worst first (filter by bounty #, sort, expand a row
 *     for each arbiter's score and cluster membership), bounties ranked by spread,
 *     or arbiters ranked by how far they sit from their peers.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight, Sigma, X } from 'lucide-react';
import { apiService } from '../services/api';
import './ScoreSpreadSection.css';

const WINDOWS = [7, 14, 30];
const PAGE = 20;
// Legend mouseovers. x = an arbiter's FUND score (0–100), x̄ = the round's mean,
// n = the round's counted reveals (its jury's N), s = the round's SD.
const SERIES = {
  pooled: {
    label: 'Pooled SD',
    cssVar: 'var(--spread-series-1)',
    help: () => pooledHelp('the day\'s rounds')
  },
  median: {
    label: 'Median round SD',
    cssVar: 'var(--spread-series-2)',
    help: [
      'Median round SD: the spread of a typical round that day.',
      '',
      'Each round: s = √( Σ (x − x̄)² / (n − 1) )',
      'Line value: the median of the day\'s s values',
      '',
      'Half of the day\'s rounds are tighter than this. One outlier round barely moves it.'
    ].join('\n')
  },
  cluster: {
    label: 'Pooled SD, cluster only',
    cssVar: 'var(--spread-series-3)',
    help: () => clusterHelp('the day\'s rounds')
  }
};

// Shared by the legend items and the stat tiles; `over` names the rounds pooled.
function pooledHelp(over) {
  return [
    `Pooled SD: the typical distance of one arbiter's score from its round's mean, over ${over}.`,
    '',
    'Pooled: SD = √( sum of every score\'s squared distance from its round\'s mean ÷ (total reveals − number of rounds) )',
    '',
    'Every reveal counts equally, so a single round with one far-off arbiter pulls it up.'
  ].join('\n');
}

function clusterHelp(over) {
  return [
    `Pooled SD, cluster only: the pooled SD over the P reveals that set the score (the cluster), over ${over}.`,
    '',
    'The cluster is read from the round\'s bonus payments (BonusPayment). A round that paid no bonus (zero fees)',
    'has no known cluster and is left out.',
    '',
    'Pooled: SD = √( sum of every cluster score\'s squared distance from its cluster mean ÷ (cluster reveals − number of rounds) )'
  ].join('\n');
}

const fmtSd = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));
const fmtPct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const fmtScore = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toString());
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const shortJob = (j) => (j ? (j.startsWith('0x') ? `${j.slice(0, 10)}…` : j.slice(0, 8)) : '');
const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateTime = (ts) => new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Tick step giving ~4–6 ticks up to `max` points.
const niceStep = (max) => [1, 2, 5, 10, 20].find((s) => max / s <= 6) || 25;

// A round's outcome under the escrow's Q-of-N rule (BountyRules.judge).
const OUTCOME_LABEL = { pass: 'Pass', soft_fail: 'Soft fail (re-run)', hard_fail: 'Hard fail' };
const outcomeLabel = (r) => {
  const o = r.outcome ? OUTCOME_LABEL[r.outcome] : null;
  const st = r.status === 'PassedPaid' ? 'paid' : r.status === 'PassedUnpaid' ? 'unpaid' : null;
  if (o) return st ? `${o} · ${st}` : o;
  return r.status ? r.status.replace(/([a-z])([A-Z])/g, '$1 $2') : '—';
};

// ---------------------------------------------------------------------------
// Agree / outlier threshold lines, shared by both charts. Equal thresholds
// (the usual case) draw one dashed line; otherwise agree is dashed, outlier solid.
// ---------------------------------------------------------------------------
function ThresholdLines({ x1, x2, yAt, agreeSd, outlierSd }) {
  if (agreeSd == null || outlierSd == null) return null;
  const line = (v, cls, label) => (
    <g key={cls}>
      <line x1={x1} x2={x2} y1={yAt(v)} y2={yAt(v)} className={cls} />
      <text x={x2} y={yAt(v) - 5} className="spread-axis" textAnchor="end">{label}</text>
    </g>
  );
  if (agreeSd === outlierSd) return line(agreeSd, 'spread-ref spread-ref-agree', `SD = ${agreeSd}`);
  return (
    <>
      {line(outlierSd, 'spread-ref', `outlier (SD > ${outlierSd})`)}
      {line(agreeSd, 'spread-ref spread-ref-agree', `agree (SD ≤ ${agreeSd})`)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Daily chart: pooled and median round sd per day (one axis, both in points)
// ---------------------------------------------------------------------------
function SpreadDailyChart({ daily, generatedAt, agreeSd, outlierSd }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);
  if (!daily || daily.length < 2 || !daily.some((d) => d.rounds > 0)) return null;

  const margin = { top: 12, right: 20, bottom: 30, left: 44 };
  const width = 720;
  const plotH = 130;
  const height = margin.top + plotH + margin.bottom;
  const plotW = width - margin.left - margin.right;
  const n = daily.length;
  const xAt = (i) => margin.left + (i / (n - 1)) * plotW;
  const vals = daily.flatMap((d) => [d.pooledSd, d.medianRoundSd, d.clusterPooledSd]).filter((v) => v != null)
    .concat([agreeSd, outlierSd].filter((v) => v != null));
  const step = niceStep(Math.max(5, ...vals));
  const yMax = Math.max(step, Math.ceil(Math.max(5, ...vals) / step) * step);
  const yAt = (v) => margin.top + plotH - (v / yMax) * plotH;
  const yTicks = [];
  for (let v = 0; v <= yMax; v += step) yTicks.push(v);

  const anchor = generatedAt ? new Date(generatedAt) : new Date();
  const labelFor = (d) => new Date(anchor.getTime() - d.daysAgo * 86400000)
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const showLabel = (i) => n <= 14 || i % Math.ceil(n / 14) === (n - 1) % Math.ceil(n / 14);

  const series = [
    { key: 'pooledSd', ...SERIES.pooled },
    { key: 'medianRoundSd', ...SERIES.median },
    { key: 'clusterPooledSd', ...SERIES.cluster }
  ];
  const linePath = (key) => {
    let path = '';
    let pen = false;
    daily.forEach((d, i) => {
      if (d[key] == null) { pen = false; return; }
      path += `${pen ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(d[key]).toFixed(1)} `;
      pen = true;
    });
    return path;
  };

  const onPointerMove = (e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const px = (e.clientX - rect.left) * (width / rect.width);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(xAt(i) - px); if (d < bestD) { bestD = d; best = i; } }
    if (hoverIdx !== best) setHoverIdx(best);
  };
  const h = hoverIdx != null ? daily[hoverIdx] : null;

  return (
    <div className="spread-chart">
      <div className="spread-legend">
        {series.map((s) => (
          <span key={s.key} className="spread-legend-item" title={typeof s.help === 'function' ? s.help() : s.help}><span className="spread-linekey" style={{ background: s.cssVar }} /><span className="tooltip-header">{s.label}</span></span>
        ))}
        <span className="spread-legend-note">per day · FUND score, points out of 100</span>
      </div>
      <div className="spread-chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" ref={svgRef}
          aria-label="Pooled, median, and cluster-only pooled arbiter score standard deviation per day"
          onPointerMove={onPointerMove} onPointerLeave={() => setHoverIdx(null)}>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={margin.left} x2={margin.left + plotW} y1={yAt(v)} y2={yAt(v)} className="spread-grid" />
              <text x={margin.left - 8} y={yAt(v)} className="spread-axis" dominantBaseline="middle" textAnchor="end">{v}</text>
            </g>
          ))}
          {daily.map((d, i) => showLabel(i) && (
            <text key={i} x={xAt(i)} y={margin.top + plotH + 16} className="spread-axis" textAnchor="middle">{labelFor(d)}</text>
          ))}
          <ThresholdLines x1={margin.left} x2={margin.left + plotW} yAt={yAt} agreeSd={agreeSd} outlierSd={outlierSd} />
          {h && <line x1={xAt(hoverIdx)} x2={xAt(hoverIdx)} y1={margin.top} y2={margin.top + plotH} className="spread-crosshair" />}
          {series.map((s) => (
            <g key={s.key}>
              <path d={linePath(s.key)} fill="none" stroke={s.cssVar} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {daily.map((d, i) => d[s.key] != null && (
                <circle key={i} cx={xAt(i)} cy={yAt(d[s.key])} r={hoverIdx === i ? 5 : 4} fill={s.cssVar} stroke="var(--bg)" strokeWidth={2} />
              ))}
            </g>
          ))}
        </svg>
        {h && (
          <div className="spread-tooltip below" style={{ left: `${(xAt(hoverIdx) / width) * 100}%`, top: `${(margin.top / height) * 100}%` }}>
            <div className="spread-tooltip-value">{labelFor(h)}</div>
            {h.rounds ? (
              <>
                {series.map((s) => (
                  <div key={s.key} className="spread-tooltip-row">
                    <span className="spread-linekey" style={{ background: s.cssVar }} />
                    <strong>{fmtSd(h[s.key])}</strong>&nbsp;{s.label}
                  </div>
                ))}
                <div className="spread-tooltip-row">90th pct {fmtSd(h.p90RoundSd)} · {h.rounds} round{h.rounds === 1 ? '' : 's'}</div>
              </>
            ) : <div className="spread-tooltip-row">no evaluations</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Round chart: every round as a dot at (time, round sd). Click to drill in.
// ---------------------------------------------------------------------------
function RoundScatter({ samples, from, to, agreeSd, outlierSd, selectedKey, onSelect }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  if (!samples.length) return null;

  const margin = { top: 12, right: 20, bottom: 30, left: 44 };
  const width = 720;
  const plotH = 170;
  const height = margin.top + plotH + margin.bottom;
  const plotW = width - margin.left - margin.right;
  const maxSd = Math.max(outlierSd, agreeSd, ...samples.map((s) => s.sd));
  const step = niceStep(maxSd);
  const yMax = Math.ceil(maxSd / step) * step;
  const xAt = (ts) => margin.left + ((ts - from) / Math.max(1, to - from)) * plotW;
  const yAt = (v) => margin.top + plotH - (v / yMax) * plotH;
  const yTicks = [];
  for (let v = 0; v <= yMax; v += step) yTicks.push(v);
  const days = Math.round((to - from) / 86400);
  const dayStep = days <= 14 ? 2 : 5;
  const xTicks = [];
  for (let d = days; d >= 0; d -= dayStep) xTicks.push(to - d * 86400);

  const pts = samples.map((s) => ({ s, cx: xAt(s.ts), cy: yAt(s.sd), key: sampleKey(s) }));
  const nearest = (e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width) return null;
    const px = (e.clientX - rect.left) * (width / rect.width);
    const py = (e.clientY - rect.top) * (height / rect.height);
    let best = null;
    let bestD = Infinity;
    for (const p of pts) { const d = Math.hypot(p.cx - px, p.cy - py); if (d < bestD) { bestD = d; best = p; } }
    return bestD <= 14 ? best : null;
  };

  return (
    <div className="spread-chart">
      <div className="spread-legend">
        <span className="spread-legend-item"><span className="spread-dotkey" />One evaluation round (its jury&apos;s N counted reveals)</span>
        <span className="spread-legend-note">click a dot to open it below · {samples.length} rounds</span>
      </div>
      <div className="spread-chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" ref={svgRef}
          aria-label="Standard deviation of arbiter scores for each evaluation round over time"
          className={hover ? 'is-pointing' : ''}
          onPointerMove={(e) => { const p = nearest(e); if ((p?.key || null) !== (hover?.key || null)) setHover(p); }}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => { const p = nearest(e); if (p) onSelect(p.s); }}>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={margin.left} x2={margin.left + plotW} y1={yAt(v)} y2={yAt(v)} className="spread-grid" />
              <text x={margin.left - 8} y={yAt(v)} className="spread-axis" dominantBaseline="middle" textAnchor="end">{v}</text>
            </g>
          ))}
          <ThresholdLines x1={margin.left} x2={margin.left + plotW} yAt={yAt} agreeSd={agreeSd} outlierSd={outlierSd} />
          {xTicks.map((t) => (
            <text key={t} x={xAt(t)} y={margin.top + plotH + 16} className="spread-axis" textAnchor="middle">{fmtDate(t)}</text>
          ))}
          <text x={14} y={margin.top + plotH / 2} className="spread-axis" textAnchor="middle" transform={`rotate(-90 14 ${margin.top + plotH / 2})`}>round SD</text>
          {pts.map((p) => (
            <circle key={p.key} cx={p.cx} cy={p.cy} r={p.key === selectedKey || p.key === hover?.key ? 6 : 4}
              className={`spread-dot${p.key === selectedKey ? ' selected' : ''}`} />
          ))}
        </svg>
        {hover && (
          <div className={`spread-tooltip${hover.cy < height / 2 ? ' below' : ''}`}
            style={{ left: `${(hover.cx / width) * 100}%`, top: `${(hover.cy / height) * 100}%` }}>
            <div className="spread-tooltip-value">SD {fmtSd(hover.s.sd)}</div>
            <div className="spread-tooltip-row">Bounty #{hover.s.jobId} · submission {hover.s.submissionId}{hover.s.rounds > 1 ? ` · round ${hover.s.round}/${hover.s.rounds}` : ''}</div>
            <div className="spread-tooltip-row">scores {hover.s.reveals.map((r) => fmtScore(r.accept)).join(', ')}</div>
            <div className="spread-tooltip-row">{fmtDateTime(hover.s.ts)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline strip: each arbiter's FUND score on 0–100, with the bounty threshold
// ---------------------------------------------------------------------------
function ScoreStrip({ reveals, threshold }) {
  const w = 150;
  const hgt = 22;
  const pad = 6;
  const x = (v) => pad + (Math.max(0, Math.min(100, v)) / 100) * (w - 2 * pad);
  return (
    <svg className="spread-strip" width={w} height={hgt} viewBox={`0 0 ${w} ${hgt}`} role="img"
      aria-label={`Arbiter scores ${reveals.map((r) => fmtScore(r.accept)).join(', ')}${threshold != null ? `; threshold ${threshold}` : ''}`}>
      <line x1={pad} x2={w - pad} y1={hgt / 2} y2={hgt / 2} className="spread-strip-track" />
      {threshold != null && <line x1={x(threshold)} x2={x(threshold)} y1={3} y2={hgt - 3} className="spread-strip-threshold" />}
      {reveals.map((r) => (
        <circle key={`${r.slot}-${r.key}`} cx={x(r.accept)} cy={hgt / 2} r={4}
          className={r.inCluster === false ? 'spread-strip-dot late' : 'spread-strip-dot'} />
      ))}
    </svg>
  );
}

function RoundDetail({ sample }) {
  return (
    <div className="spread-detail">
      <table>
        <thead>
          <tr>
            <th>Arbiter</th>
            <th className="num">FUND score</th>
            <th className="num" title="Distance from the round's median score">From median</th>
            <th title={`At or above the bounty's threshold (${sample.threshold ?? '—'}): counts toward the pass quota`}>At threshold</th>
            <th title="Paid a bonus (BonusPayment): one of the P reveals that set the score. Unknown when no bonus was paid (zero fees).">Cluster</th>
          </tr>
        </thead>
        <tbody>
          {sample.reveals.map((r, i) => {
            const dev = r.accept - sample.median;
            return (
              <tr key={`${r.slot}-${i}`}>
                <td><code title={`${r.operator || ''} · key ${r.key || ''} · job ${r.jobId || ''} · slot ${r.slot ?? '?'}`}>{shortAddr(r.operator)}</code> <span className="spread-muted">{shortJob(r.jobId)}</span></td>
                <td className="num">{fmtScore(r.accept)}</td>
                <td className={`num${Math.abs(dev) > 10 ? ' spread-far' : ''}`}>{dev >= 0 ? '+' : ''}{fmtScore(dev)}</td>
                <td>{sample.threshold != null ? (r.accept >= sample.threshold ? 'Yes' : 'No') : '—'}</td>
                <td>{r.inCluster == null ? <span className="spread-muted">unknown</span> : r.inCluster ? 'Yes' : 'No'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="spread-detail-links">
        {sample.jury && <span>Jury K/M/N/P {sample.jury.K}/{sample.jury.M}/{sample.jury.N}/{sample.jury.P} · pass {sample.passCount ?? '—'} of Q {sample.quota ?? '?'} (of N {sample.jury.N})</span>}
        <span>SD all counted <strong>{fmtSd(sample.sd)}</strong> · cluster {sample.clusterKnown ? <strong>{fmtSd(sample.clusterSd)}</strong> : 'unknown'} · range {fmtScore(sample.range)}{sample.lateReveals ? ` · ${sample.lateReveals} late reveal${sample.lateReveals === 1 ? '' : 's'} (scored, not counted)` : ''}</span>
        <Link to={`/bounty/${sample.jobId}`}>Bounty #{sample.jobId}</Link>
        <Link to={`/agg-history/${sample.aggId}`}>Round history</Link>
      </div>
    </div>
  );
}

const sampleKey = (s) => `${s.jobId}:${s.submissionId}:${s.round ?? 1}`;
const passLabel = (r) => (r.passCount == null ? '—' : `${r.passCount} / ${r.quota ?? '?'}`);
// The round's own jury (getJury; the bounty's when unread): "Q of N, K drawn".
const juryLabel = (r) => (r.jury ? `Q ${r.quota ?? '?'} of N ${r.jury.N} · K ${r.jury.K} drawn` : null);

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------
export default function ScoreSpreadSection({ refreshKey }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('rounds');
  const [sortBy, setSortBy] = useState('sd');
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState(null);
  const [bountyInput, setBountyInput] = useState(searchParams.get('spreadBounty') || '');
  const tableRef = useRef(null);
  const bountyFilter = searchParams.get('spreadBounty') || '';

  useEffect(() => {
    let live = true;
    setLoading(true);
    apiService.getScoreSpread(days)
      .then((res) => { if (live) { setData(res.data); setError(null); } })
      .catch((err) => { if (live) setError(err.response?.data?.error || err.message || 'Failed to load score spread'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [days, refreshKey]);

  const applyBounty = useCallback((value) => {
    const v = String(value ?? '').replace(/^#/, '').trim();
    setBountyInput(v);
    setLimit(PAGE);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v) next.set('spreadBounty', v); else next.delete('spreadBounty');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const rows = useMemo(() => {
    let list = data?.samples || [];
    if (bountyFilter) list = list.filter((s) => String(s.jobId) === bountyFilter);
    const sorted = [...list];
    if (sortBy === 'cluster') sorted.sort((a, b) => (b.clusterSd ?? -1) - (a.clusterSd ?? -1) || b.ts - a.ts);
    else if (sortBy === 'newest') sorted.sort((a, b) => b.ts - a.ts);
    else sorted.sort((a, b) => b.sd - a.sd || b.ts - a.ts);
    return sorted;
  }, [data, bountyFilter, sortBy]);

  const keyOf = sampleKey;
  const openSample = (s) => {
    applyBounty(s.jobId);
    setView('rounds');
    setExpanded(keyOf(s));
    requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const header = (
    <h2 title="For each evaluation round, re-runs included: the standard deviation of the arbiters' FUND scores across the round's N counted reveals (its own jury's N: 4 for Small and Medium, 13 Large, 27 Jumbo). A late reveal arrives after the round finalized; it is scored by quality but stores no scores, so it is not in the spread.">
      <Sigma size={20} className="inline-icon" /> Arbiter Score Spread · Last {days} days
    </h2>
  );

  if (loading && !data) {
    return (
      <section className="analytics-section spread-root">{header}
        <div className="loading"><div className="spinner"></div><p>Loading score spread…</p></div>
      </section>
    );
  }
  if (error && !data) {
    return (
      <section className="analytics-section spread-root">{header}
        <div className="info-banner"><AlertTriangle size={16} /><span>{error}</span></div>
      </section>
    );
  }

  const s = data?.summary || {};
  const cov = data?.coverage || {};
  const { earlier, recent, halfDays } = data?.halves || {};
  const change = earlier?.pooledSd && recent?.pooledSd != null ? (recent.pooledSd - earlier.pooledSd) / earlier.pooledSd : null;
  const filteredBounty = bountyFilter ? (data?.bounties || []).find((b) => String(b.jobId) === bountyFilter) : null;
  const noData = !data?.samples?.length;

  return (
    <section className="analytics-section spread-root">
      <div className="spread-head">
        {header}
        <div className="spread-window" role="group" aria-label="Time window">
          {WINDOWS.map((d) => (
            <button key={d} type="button" className={d === days ? 'active' : ''} aria-pressed={d === days}
              onClick={() => { setDays(d); setLimit(PAGE); }}>{d} days</button>
          ))}
        </div>
      </div>
      <div className="section-content">
        {data?.lastError && <div className="info-banner"><AlertTriangle size={16} /><span>{data.lastError}</span></div>}
        {noData ? (
          <div className="empty-state">
            <Sigma size={32} />
            <p>{data?.lastRunAt ? 'No finalized rounds with two or more counted reveals in this window.' : 'Score data is still being collected from the chain. Check back in a few minutes.'}</p>
          </div>
        ) : (
          <>
            <div className="stat-grid">
              <div className="stat-card" title={pooledHelp('every round in the window')}>
                <div className="stat-value">{fmtSd(s.pooledSd)}</div>
                <div className="stat-label">Pooled SD</div>
              </div>
              {data.summaryCluster && (
                <div className="stat-card" title={`${clusterHelp('every round in the window')}\n\n${data.summaryCluster.unknownRounds} round(s) paid no bonus: cluster unknown.`}>
                  <div className="stat-value">{fmtSd(data.summaryCluster.pooledSd)}</div>
                  <div className="stat-label">Pooled SD, cluster only</div>
                </div>
              )}
              <div className="stat-card" title="The typical round: half of the rounds have a smaller standard deviation than this">
                <div className="stat-value">{fmtSd(s.medianRoundSd)}</div>
                <div className="stat-label">Median round SD</div>
              </div>
              <div className="stat-card" title="One round in ten has a standard deviation above this">
                <div className="stat-value">{fmtSd(s.p90RoundSd)}</div>
                <div className="stat-label">90th pct round SD</div>
              </div>
              <div className="stat-card" title={`Rounds whose standard deviation is at most ${data.thresholds.agreeSd} points`}>
                <div className="stat-value">{fmtPct(s.agreeFrac)}</div>
                <div className="stat-label">Rounds in agreement</div>
              </div>
              <div className="stat-card" title={`Rounds whose standard deviation is above ${data.thresholds.outlierSd} points, often one arbiter far from the rest`}>
                <div className="stat-value">{fmtPct(s.outlierFrac)}</div>
                <div className="stat-label">Rounds with an outlier</div>
              </div>
              <div className="stat-card" title={Object.entries(data.revealCounts || {}).map(([n, c]) => `${c} round${c === 1 ? '' : 's'} with N = ${n}`).join(', ')}>
                <div className="stat-value">{s.rounds}</div>
                <div className="stat-label">Rounds · {s.reveals} reveals</div>
              </div>
            </div>
            <div className="metrics-row">
              {change != null && (
                <div className="metric-badge" title={`Pooled SD, first ${halfDays} days of the window (${earlier.rounds} rounds) vs last ${halfDays} days (${recent.rounds} rounds)`}>
                  <span>Pooled SD {fmtSd(earlier.pooledSd)} → {fmtSd(recent.pooledSd)} ({change <= 0 ? '' : '+'}{Math.round(change * 100)}%) · last {halfDays} days vs the {halfDays} before</span>
                </div>
              )}
              {data.outcomes && (
                <div className="metric-badge" title="Each round judged by the escrow's rule: the scores at or above the threshold against the bounty's quota Q (pass) and forfeit line R (soft fail: re-run). Unknown: the bounty's quota is not on record.">
                  <span>Rounds: {data.outcomes.pass} pass · {data.outcomes.soft_fail} soft fail · {data.outcomes.hard_fail} hard fail{data.outcomes.unknown ? ` · ${data.outcomes.unknown} unknown quota` : ''}</span>
                </div>
              )}
            </div>

            <SpreadDailyChart daily={data.daily} generatedAt={data.generatedAt}
              agreeSd={data.thresholds.agreeSd} outlierSd={data.thresholds.outlierSd} />
            <RoundScatter samples={data.samples} from={data.from} to={data.to}
              agreeSd={data.thresholds.agreeSd} outlierSd={data.thresholds.outlierSd}
              selectedKey={expanded} onSelect={openSample} />

            <div className="spread-drill" ref={tableRef}>
              <div className="spread-controls">
                <div className="spread-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={view === 'rounds'} className={view === 'rounds' ? 'active' : ''} onClick={() => setView('rounds')}>Rounds, worst first</button>
                  <button type="button" role="tab" aria-selected={view === 'bounties'} className={view === 'bounties' ? 'active' : ''} onClick={() => setView('bounties')}>By bounty</button>
                  <button type="button" role="tab" aria-selected={view === 'arbiters'} className={view === 'arbiters' ? 'active' : ''} onClick={() => setView('arbiters')}>By arbiter</button>
                </div>
                <form className="spread-filter" onSubmit={(e) => { e.preventDefault(); applyBounty(bountyInput); setView('rounds'); }}>
                  <label htmlFor="spread-bounty">Bounty #</label>
                  <input id="spread-bounty" inputMode="numeric" placeholder="all" value={bountyInput}
                    onChange={(e) => setBountyInput(e.target.value)} />
                  <button type="submit" className="btn btn-secondary btn-sm">Filter</button>
                  {bountyFilter && (
                    <button type="button" className="spread-clear" onClick={() => applyBounty('')} aria-label="Clear bounty filter"><X size={14} /> Clear</button>
                  )}
                </form>
                {view === 'rounds' && (
                  <label className="spread-sort">Sort
                    <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                      <option value="sd">SD, all counted</option>
                      <option value="cluster">SD, cluster</option>
                      <option value="newest">Newest</option>
                    </select>
                  </label>
                )}
              </div>

              {view === 'rounds' ? (
                <>
                  {bountyFilter && (
                    <p className="spread-filter-summary">
                      {filteredBounty ? (
                        <>Bounty #{filteredBounty.jobId}{filteredBounty.title ? ` · ${filteredBounty.title}` : ''}: {filteredBounty.rounds} round{filteredBounty.rounds === 1 ? '' : 's'}, pooled SD <strong>{fmtSd(filteredBounty.pooledSd)}</strong>, median {fmtSd(filteredBounty.medianRoundSd)}, worst {fmtSd(filteredBounty.maxRoundSd)}. <Link to={`/bounty/${filteredBounty.jobId}`}>Open bounty</Link></>
                      ) : <>No evaluated rounds for bounty #{bountyFilter} in the last {days} days.</>}
                    </p>
                  )}
                  {rows.length > 0 && (
                    <div className="stats-table spread-table">
                      <table>
                        <thead>
                          <tr>
                            <th aria-label="Expand" />
                            <th className="num tooltip-header" title="Standard deviation of the FUND score over the round's N counted reveals">SD</th>
                            <th className="num tooltip-header" title="Standard deviation over the cluster (the bonus-paid reveals); blank when no bonus was paid">SD cluster</th>
                            <th>Bounty</th>
                            <th className="num" title="Submission, and the round when it re-ran">Sub</th>
                            <th>When</th>
                            <th className="tooltip-header" title="Each counted arbiter's FUND score on 0–100. Hollow: outside the cluster. Tick: the bounty's threshold.">Arbiter scores</th>
                            <th className="num tooltip-header" title="Scores at or above the threshold / the bounty's pass quota Q">Pass / Q</th>
                            <th>Outcome</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.slice(0, limit).map((r) => {
                            const k = keyOf(r);
                            const open = expanded === k;
                            return (
                              <Fragment key={k}>
                                <tr className={`spread-row${open ? ' open' : ''}`} onClick={() => setExpanded(open ? null : k)}>
                                  <td>
                                    <button type="button" className="spread-expand" aria-expanded={open}
                                      aria-label={`${open ? 'Hide' : 'Show'} arbiter scores for bounty ${r.jobId} submission ${r.submissionId}`}
                                      onClick={(e) => { e.stopPropagation(); setExpanded(open ? null : k); }}>
                                      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                    </button>
                                  </td>
                                  <td className="num"><strong>{fmtSd(r.sd)}</strong></td>
                                  <td className="num">{r.clusterKnown ? fmtSd(r.clusterSd) : <span className="spread-muted" title="No bonus paid: cluster unknown">?</span>}</td>
                                  <td className="spread-bounty-cell">
                                    <button type="button" className="spread-linkish" title="Show only this bounty"
                                      onClick={(e) => { e.stopPropagation(); applyBounty(r.jobId); }}>#{r.jobId}</button>
                                    {r.title && <span className="spread-title" title={r.title}>{r.title}</span>}
                                  </td>
                                  <td className="num">{r.submissionId}{r.rounds > 1 ? <span className="spread-muted"> r{r.round}</span> : null}</td>
                                  <td title={fmtDateTime(r.ts)}>{fmtDate(r.ts)}</td>
                                  <td><ScoreStrip reveals={r.reveals} threshold={r.threshold} /></td>
                                  <td className="num" title={juryLabel(r) || undefined}>{passLabel(r)}</td>
                                  <td className={r.outcome === 'pass' ? 'text-success' : ''}>{outcomeLabel(r)}</td>
                                </tr>
                                {open && (
                                  <tr className="spread-detail-row"><td colSpan={9}><RoundDetail sample={r} /></td></tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {rows.length > limit && (
                    <button type="button" className="btn btn-secondary btn-sm spread-more" onClick={() => setLimit(limit + PAGE)}>
                      Show {Math.min(PAGE, rows.length - limit)} more of {rows.length - limit}
                    </button>
                  )}
                </>
              ) : view === 'arbiters' ? (
                <>
                  <p className="spread-filter-summary">
                    Gap = an arbiter's score minus the average of the other arbiters in the same round. An average gap far from 0 means the arbiter leans high or low every time; a large average |gap| with an average near 0 means it disagrees in both directions.
                  </p>
                  <div className="stats-table spread-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Arbiter</th>
                          <th className="num">Reveals</th>
                          <th className="num tooltip-header" title="Average signed gap: positive scores above its peers, negative below">Avg gap</th>
                          <th className="num tooltip-header" title="Average size of the gap, either direction">Avg |gap|</th>
                          <th className="num tooltip-header" title={`Share of its reveals more than ${data.thresholds.farGap} points from the other arbiters' average`}>Far off</th>
                          <th className="num tooltip-header" title="Share of its counted reveals in the bonus-paid cluster (rounds with a known cluster)">In cluster</th>
                          <th>Worst round</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data.arbiters || []).map((a) => (
                          <tr key={a.key || `${a.operator}:${a.jobId}`}>
                            <td><code title={`${a.operator || ''} · key ${a.key || ''} · job ${a.jobId || ''}`}>{shortAddr(a.operator)}</code> <span className="spread-muted">{shortJob(a.jobId)}</span></td>
                            <td className="num">{a.reveals}</td>
                            <td className="num">{a.meanGap > 0 ? '+' : ''}{fmtSd(a.meanGap)}</td>
                            <td className="num"><strong>{fmtSd(a.meanAbsGap)}</strong></td>
                            <td className="num">{fmtPct(a.farFrac)}</td>
                            <td className="num">{fmtPct(a.clusterFrac)}</td>
                            <td>
                              <button type="button" className="spread-linkish" title="Open this round"
                                onClick={() => {
                                  const hit = (data.samples || []).find((x) => x.jobId === a.worst.jobId && x.submissionId === a.worst.submissionId && (x.round ?? 1) === (a.worst.round ?? 1));
                                  if (hit) openSample(hit);
                                }}>#{a.worst.jobId} / {a.worst.submissionId}</button>
                              <span className="spread-muted"> gap {a.worst.gap > 0 ? '+' : ''}{fmtScore(a.worst.gap)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="stats-table spread-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Bounty</th>
                        <th className="num">Rounds</th>
                        <th className="num">Pooled SD</th>
                        <th className="num">Median SD</th>
                        <th className="num">Worst SD</th>
                        <th className="num tooltip-header" title={`Share of this bounty's rounds with SD above ${data.thresholds.outlierSd}`}>Outliers</th>
                        <th className="num" title="Pass threshold · quota Q">Bar · Q</th>
                        <th>Last round</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.bounties.map((b) => (
                        <tr key={b.jobId} className="spread-row" onClick={() => { applyBounty(b.jobId); setView('rounds'); }}>
                          <td className="spread-bounty-cell">
                            <button type="button" className="spread-linkish" title="Show this bounty's rounds"
                              onClick={(e) => { e.stopPropagation(); applyBounty(b.jobId); setView('rounds'); }}>#{b.jobId}</button>
                            {b.title && <span className="spread-title" title={b.title}>{b.title}</span>}
                          </td>
                          <td className="num">{b.rounds}</td>
                          <td className="num"><strong>{fmtSd(b.pooledSd)}</strong></td>
                          <td className="num">{fmtSd(b.medianRoundSd)}</td>
                          <td className="num">{fmtSd(b.maxRoundSd)}</td>
                          <td className="num">{fmtPct(b.outlierFrac)}</td>
                          <td className="num">{b.threshold ?? '—'} · {b.quota ?? '?'}</td>
                          <td>{fmtDate(b.lastTs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
        <p className="spread-footnote">
          Scores are each counted arbiter&apos;s FUND score (the one the escrow judges: the second of a two-outcome [DONT_FUND, FUND] result; any other shape, a one-number result included, is no result to the escrow), ÷ 10,000, on 0–100. A round&apos;s SD is the sample standard deviation over its N counted reveals, in reveal order (getOutcomeScores). Late reveals are scored by quality but store no scores, so they are not in it. Pass / Q counts the scores at or above the threshold against the bounty&apos;s quota.
          {' '}{cov.submissions != null && <>In this window: {cov.submissions} evaluated submissions, {cov.rounds} rounds{cov.pending ? `, ${cov.pending} not read yet` : ''}{cov.noResult ? `, ${cov.noResult} with no result` : ''}{cov.badShape ? `, ${cov.badShape} with a result the escrow cannot judge` : ''}{cov.tooFewReveals ? `, ${cov.tooFewReveals} with fewer than 2 reveals` : ''}{cov.lateReveals ? `, ${cov.lateReveals} late reveals` : ''}.</>}
          {data?.lastRunAt && <> Chain data read {new Date(data.lastRunAt).toLocaleString()}.</>}
        </p>
      </div>
    </section>
  );
}
