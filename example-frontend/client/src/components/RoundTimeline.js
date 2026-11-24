// src/components/RoundTimeline.js
import React from 'react';
import { formatEther } from 'ethers';
import { PHASE } from '../utils/timeoutUtils';

/**
 * The phases of a v2 aggregator round, the one it is in, and the wallet transactions this
 * page sent for it. `info` is the Run Query round state: { aggId, withBeacons, round,
 * deadlineMs, steps, explorerUrl }. `round` is getRoundInfo() as parseRoundInfo() returns it,
 * plus `jury` from getJury(aggId) (see driveRound).
 */

const ROWS = [
  {
    phase: PHASE.DRAW,
    label: 'Draw the jury',
    note: 'your wallet: drawJury from block B+2 (earns you 2 × the per-arbiter fee within 30 s)',
  },
  {
    phase: PHASE.BEACONS,
    label: 'Beacons',
    note: 'your wallet: a second drawJury once the beacon values are in',
    beaconsOnly: true,
  },
  {
    phase: PHASE.COMMIT,
    label: 'Commit',
    note: 'the arbiters commit; your wallet calls closeCommits only if the window needs closing',
  },
  { phase: PHASE.CLOSING, label: 'Promote', note: 'your wallet: promote (earns 1 × the per-arbiter fee)' },
  { phase: PHASE.REVEAL, label: 'Reveal', note: 'the arbiters reveal; the last needed reveal finalizes' },
  { phase: PHASE.FINAL, label: 'Result', note: '' },
];

const STEP_LABELS = {
  draw: 'drawJury',
  'beacon-draw': 'drawJury (after the beacons)',
  close: 'closeCommits',
  promote: 'promote',
  settle: 'settle',
};

function RoundTimeline({ info, nowMs = Date.now() }) {
  const round = info?.round;
  if (!round) return null;
  const phase = round.phase;
  const terminalFail = phase === PHASE.FAILED || phase === PHASE.CANCELLED;
  // phases 6 and 7 both mean "result"
  const current = phase === PHASE.SETTLED ? PHASE.FINAL : phase;
  const rows = ROWS.filter((r) => !r.beaconsOnly || info.withBeacons);
  const secondsLeft =
    info.deadlineMs && current >= PHASE.COMMIT && current <= PHASE.REVEAL
      ? Math.max(0, Math.ceil((info.deadlineMs - nowMs) / 1000))
      : null;

  return (
    <div
      data-testid="round-timeline"
      style={{
        border: '1px solid #ccd',
        borderRadius: '8px',
        padding: '10px 16px',
        margin: '12px 0',
        textAlign: 'left',
        fontSize: '14px',
        background: '#fafbff',
      }}
    >
      <div style={{ marginBottom: '6px' }}>
        <strong>Round</strong> <code style={{ fontSize: '12px', wordBreak: 'break-all' }}>{info.aggId}</code>
      </div>
      {round.jury ? (
        // the round's own jury, from getJury(aggId): it is the request's, not the aggregator's
        <div data-testid="round-jury" style={{ marginBottom: '6px', color: '#444' }}>
          Jury: {round.jury.K} drawn, {round.jury.M} promoted to reveal, {round.jury.N} counted,
          {' '}{round.jury.P} clustered; round timeout {round.jury.timeout} s from the draw
        </div>
      ) : null}
      <ol style={{ margin: '0 0 6px 18px', padding: 0 }}>
        {rows.map((row) => {
          const done = !terminalFail && current > row.phase;
          const active = !terminalFail && current === row.phase;
          return (
            <li
              key={row.phase}
              data-phase={row.phase}
              data-state={done ? 'done' : active ? 'active' : 'pending'}
              style={{ color: done ? '#2a7a2a' : active ? '#123' : '#999', fontWeight: active ? 'bold' : 'normal' }}
            >
              {done ? '✓ ' : active ? '▶ ' : ''}
              {row.label}
              {row.note ? <span style={{ fontWeight: 'normal', color: '#777' }}> — {row.note}</span> : null}
              {active && row.phase === PHASE.COMMIT ? (
                <span style={{ fontWeight: 'normal' }}>
                  {' '}({round.commits} committed{round.jury ? `, ${round.jury.M} needed` : ''})
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {terminalFail ? (
        <div style={{ color: '#b33' }}>{phase === PHASE.FAILED ? 'The round failed.' : 'The round was cancelled.'}</div>
      ) : null}
      {secondsLeft !== null ? (
        <div data-testid="round-deadline">Round deadline in {secondsLeft} s (after it, an unfinished round fails and is settled).</div>
      ) : null}
      {info.steps?.length ? (
        <div style={{ marginTop: '6px' }}>
          Sent by your wallet:{' '}
          {info.steps.map((s, i) => (
            <span key={`${s.step}-${i}`}>
              {i > 0 ? ', ' : ''}
              {info.explorerUrl ? (
                <a href={`${info.explorerUrl}/tx/${s.txHash}`} target="_blank" rel="noopener noreferrer">
                  {STEP_LABELS[s.step] || s.step}
                </a>
              ) : (
                STEP_LABELS[s.step] || s.step
              )}
              {s.rewardWei != null && s.rewardWei > 0n ? ` (+${formatEther(s.rewardWei)} ETH credit)` : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default RoundTimeline;
