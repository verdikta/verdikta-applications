// One submission's v2 evaluation round (item 12): the phase timeline, the Q-of-N outcome, the
// hunter bond and the step that moves it on now. Everything shown comes from the escrow's lens
// (contractService.getRoundState: getOracleResult + nextAction) with the job's decision settings
// for Q / R / N; a button appears only when nextAction names its step.
import { useEffect, useState } from 'react';
import { Check, Loader2, RefreshCw, Shuffle, FastForward, XCircle, TimerOff } from 'lucide-react';
import { ROUND_TIMELINE, ROUND_PHASE_LABELS, ROUND_OUTCOME_LABELS, isAwaitingRerun } from '../utils/statusDisplay';
import { MAX_ROUNDS, RERUN_WINDOW_SECONDS, jobDecision, fmtEth } from '../utils/roundDisplay';

function useNow(enabled) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!enabled) return undefined;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [enabled]);
  return now;
}

function fmtCountdown(sec) {
  if (sec <= 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const box = { marginTop: '0.75rem', padding: '0.6rem 0.75rem', border: '1px solid #e0e0e0', borderRadius: '6px', background: '#fafafa', fontSize: '0.85rem' };
const btnStyle = { fontSize: '0.95rem', padding: '0.6rem 1rem', width: '100%', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' };

/** The round phase timeline (Draw → [Beacons] → Commit → Close → Reveal → Result). */
function RoundTimeline({ phase, withBeacons, outcome }) {
  const steps = ROUND_TIMELINE.filter((s) => !s.beaconsOnly || withBeacons || phase === 2);
  const ended = phase >= 6;
  const failed = phase === 8 || phase === 9;
  return (
    <div className="round-timeline" style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', alignItems: 'center', margin: '0.4rem 0' }}>
      {steps.map((s, i) => {
        const done = ended && !failed ? true : phase > s.phase;
        const current = !ended && phase === s.phase;
        const bg = current ? '#1976d2' : done ? '#c8e6c9' : '#eeeeee';
        const fg = current ? '#fff' : done ? '#2e7d32' : '#777';
        return (
          <span key={s.phase} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <span style={{ padding: '0.15rem 0.5rem', borderRadius: '10px', background: bg, color: fg, fontSize: '0.75rem', fontWeight: current ? 'bold' : 'normal' }}>
              {done && <Check size={11} style={{ verticalAlign: '-1px' }} />} {s.label}
            </span>
            {i < steps.length - 1 && <span style={{ color: '#bbb' }}>›</span>}
          </span>
        );
      })}
      {failed && (
        <span style={{ padding: '0.15rem 0.5rem', borderRadius: '10px', background: '#ffcdd2', color: '#c62828', fontSize: '0.75rem' }}>
          {ROUND_PHASE_LABELS[phase]}
        </span>
      )}
      {outcome && outcome !== 'not_ready' && (
        <span style={{ marginLeft: '0.25rem', fontSize: '0.75rem', color: '#555' }}>
          — {ROUND_OUTCOME_LABELS[outcome] || outcome}
        </span>
      )}
    </div>
  );
}

/**
 * The round panel of one submission. Shown for submissions in evaluation (PendingVerdikta) or
 * awaiting a re-run. `onRoundAction(submissionId, action)` sends DRAW / CLOSE_COMMITS / PROMOTE /
 * CLOSE_FAILED / RERUN / EXPIRE_RERUN.
 */
export default function RoundPanel({ submission, roundState, job, walletState, onRoundAction, busy, disableActions, threshold }) {
  const awaiting = isAwaitingRerun(submission) || roundState?.statusCode === 6;
  const now = useNow(true);
  const dec = jobDecision(job);
  if (!roundState && !awaiting) return null;

  const st = roundState || {};
  const action = st.nextAction || null;
  const rounds = st.rounds || submission.rounds || 0;
  const phase = Number(st.phase || 0);
  const withBeacons = Boolean(job?.oracleSettings?.withBeacons ?? job?.decisionSettings?.withBeacons);
  const passCount = st.hasResult || awaiting ? (st.passCount ?? submission.passCount) : null;
  const outcome = awaiting ? (submission.roundOutcome || 'soft_fail') : st.outcome;
  const rerunDeadline = Number(st.rerunDeadline || submission.rerunDeadline || 0);
  const rerunLeft = rerunDeadline ? rerunDeadline - now : null;
  const bondHeld = st.bondHeld ?? submission.bondHeldWei ?? '0';
  const me = walletState?.address?.toLowerCase();
  const hunter = (st.hunter || submission.hunter || '').toLowerCase();
  const bondFunder = (st.bondFunder || submission.bondFunder || '').toLowerCase();
  const mayRerun = me && (me === hunter || (bondFunder && me === bondFunder));
  const roundDeadlineLeft = st.deadline ? st.deadline - now : null;
  const connected = walletState?.isConnected;

  const btn = (act, cls, icon, label) => (
    <button
      key={act}
      onClick={() => onRoundAction(submission.submissionId, act)}
      disabled={busy || disableActions || !connected}
      className={`btn ${cls}`}
      style={btnStyle}
      title={!connected ? 'Connect a wallet to send this transaction' : undefined}
    >
      {busy ? <><Loader2 size={14} className="spin" /> Sending…</> : <>{icon} {label}</>}
    </button>
  );

  return (
    <div className="round-panel" style={box}>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
        <strong>
          {awaiting ? 'Awaiting re-run' : `Round ${Math.max(rounds, 1)}: ${ROUND_PHASE_LABELS[phase] || 'starting'}`}
        </strong>
        <span style={{ color: '#666' }}>Rounds used: {rounds} of {MAX_ROUNDS}</span>
      </div>

      {!awaiting && <RoundTimeline phase={phase} withBeacons={withBeacons} outcome={st.hasResult || outcome === 'no_result' ? outcome : null} />}

      {passCount != null && dec.quota != null && (
        <div style={{ marginTop: '0.25rem' }}>
          <strong>{passCount}</strong> of {dec.N ?? 'N'} arbiters scored it at the threshold{threshold != null ? ` (${threshold}%)` : ''};{' '}
          <strong>{dec.quota}</strong> needed to pass
          {dec.forfeitLine ? <>, below <strong>{dec.forfeitLine}</strong> the bond is forfeited</> : null}.
          {outcome === 'soft_fail' && ' Soft fail: it may re-run.'}
          {outcome === 'hard_fail' && ' Hard fail.'}
          {outcome === 'no_result' && ' The round ended with no result (not the hunter’s fault): it may re-run.'}
        </div>
      )}
      {passCount == null && outcome === 'no_result' && (
        <div style={{ marginTop: '0.25rem' }}>The round ended with no result (too few commits or reveals, or it was never drawn). Closing it lets the submission re-run, keeping its place and bond.</div>
      )}

      <div style={{ marginTop: '0.25rem', color: '#555' }}>
        Hunter bond: {BigInt(bondHeld || 0) > 0n ? <>{fmtEth(bondHeld)} ETH held</> : 'none held'}
        {submission.bondReturnedWei && <> · {fmtEth(submission.bondReturnedWei)} ETH returned</>}
        {submission.bondForfeitedWei && <> · {fmtEth(submission.bondForfeitedWei)} ETH forfeited to the creator</>}
      </div>

      {awaiting && rerunDeadline > 0 && (
        <div style={{ marginTop: '0.4rem', padding: '0.4rem 0.5rem', background: rerunLeft > 0 ? '#e3f2fd' : '#fff3e0', borderRadius: '4px' }}>
          {rerunLeft > 0
            ? <>Re-run window: <strong>{fmtCountdown(rerunLeft)}</strong> left (of {RERUN_WINDOW_SECONDS / 3600} h). The hunter or the bond funder may re-run it with a fresh jury, keeping its place and bond.</>
            : <>The re-run window has closed. Anyone may expire it; the bond goes back to its funder.</>}
        </div>
      )}

      {!awaiting && action === 'AWAIT_ORACLE' && (
        <div style={{ marginTop: '0.4rem', color: '#777' }}>
          The jury is working{roundDeadlineLeft != null && roundDeadlineLeft > 0 ? <> — round deadline in {fmtCountdown(roundDeadlineLeft)}</> : null}. Nothing to send now.
        </div>
      )}

      <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {action === 'DRAW' && btn('DRAW', 'btn-primary', <Shuffle size={14} />, phase === 2 ? 'Draw jury (beacons are in)' : 'Draw jury')}
        {(action === 'CLOSE_COMMITS' || action === 'PROMOTE') && btn(action, 'btn-primary', <FastForward size={14} />, action === 'PROMOTE' ? 'Advance round (promote)' : 'Advance round (close commits)')}
        {action === 'CLOSE_FAILED' && btn('CLOSE_FAILED', 'btn-warning', <XCircle size={14} />, 'Close failed round')}
        {action === 'RERUN' && (mayRerun
          ? btn('RERUN', 'btn-success', <RefreshCw size={14} />, `Re-run (round ${rounds + 1} of ${MAX_ROUNDS})`)
          : <div style={{ color: '#777' }}>Only the hunter or the bond funder may re-run this submission.</div>)}
        {action === 'AWAIT_EXPIRY' && <div style={{ color: '#777' }}>An earlier submission already passes, so a re-run would revert; once the window closes it can be expired.</div>}
        {action === 'AWAIT_SLOT' && awaiting && <div style={{ color: '#777' }}>All evaluation slots of this bounty are in use; retry the re-run in a few minutes.</div>}
        {action === 'EXPIRE_RERUN' && btn('EXPIRE_RERUN', 'btn-secondary', <TimerOff size={14} />, 'Expire re-run (returns the bond)')}
        {['DRAW', 'CLOSE_COMMITS', 'PROMOTE', 'CLOSE_FAILED', 'EXPIRE_RERUN'].includes(action) && (
          <small style={{ color: '#888' }}>Anyone may send this step; the site’s keeper usually sends it within a minute.</small>
        )}
      </div>
    </div>
  );
}
