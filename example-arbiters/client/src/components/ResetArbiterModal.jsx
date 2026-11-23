/**
 * Re-register Arbiter — exit now, register again later (the v2 replacement for
 * v1's "restart" / reset).
 *
 * v1 could deregister and re-register in one sitting, wiping the reputation.
 * The v2 keeper works differently (see its registerArbiter / completeExit notes):
 *  - an arbiter's classes are set at registration, so changing them means
 *    leaving and joining again (the fee alone can be changed in place: setFee);
 *  - leaving takes two steps days apart: requestExit, then completeExit once the
 *    unbonding period (2 days by default) has passed, which refunds the stake;
 *  - the keeper keeps the key's scores and offenses, so registering the same
 *    (oracle, jobId) again brings its reputation back — nothing is reset.
 *
 * So the flow is four wallet transactions across two sittings:
 *   now:    1. Request exit  — the arbiter stops being selected at once
 *   later:  2. Complete exit — refunds the stake (after exitAt, and not while blocked)
 *           3. Approve       — let the keeper pull the stake again (skipped if approved)
 *           4. Register      — registerArbiter(fee, classes, chain head 0)
 * Step 1 records the planned fee/classes in resetRegistry so My Arbiters can offer
 * steps 2–4 when the unbonding ends, even after the arbiter has left the listing.
 * The modal reads the arbiter's live state and starts at whichever step is next.
 */

import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { AlertTriangle, Check, Loader, X, ExternalLink, RotateCcw, Clock } from 'lucide-react';
import {
  getStakeContext,
  approveStake,
  requestExit,
  completeExit,
  registerArbiter,
  arbiterKey,
} from '../services/arbiterContracts';
import { markExitRequested, markExitCompleted, updatePlannedParams, clearPendingReset } from '../services/resetRegistry';
import { parseClasses, parseFee, sameSet, exitView, formatDuration } from '../utils/arbiterRegistration';
import { ResyncNotice } from './RegisterArbiterModal';

const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmtWvdka = (wei) => {
  const n = Number(ethers.formatEther(wei));
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};
// ETH amounts here are tiny (Base gas); show 3 significant figures, no trailing zeros.
const fmtEth = (wei) => {
  const n = Number(ethers.formatEther(wei));
  return n === 0 ? '0' : `${parseFloat(n.toPrecision(3))}`;
};
const fmtDate = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : '—');
const STEP_ORDER = ['exit', 'complete', 'approve', 'register'];
// Generous per-tx gas-unit upper bounds, only for the "enough ETH for gas?" warning.
const GAS_UNITS = { exit: 80000n, complete: 200000n, approve: 80000n, register: 450000n };
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Props:
 *  - oracle, jobId, fee (ETH decimal string), classes (number[]): the arbiter;
 *    fee/classes seed the editable fields of the re-registration.
 *  - keeperAddress, network, owner, chain: context for the writes/links
 *  - getSigner, toast, onClose, onComplete
 */
function ResetArbiterModal({
  oracle,
  jobId,
  fee,
  classes,
  keeperAddress,
  network,
  owner,
  chain,
  getSigner,
  toast,
  onClose,
  onComplete,
}) {
  const [ctx, setCtx] = useState(null);
  const [ctxError, setCtxError] = useState(null);
  const [status, setStatus] = useState(null); // { exit, complete, approve, register }
  const [txHashes, setTxHashes] = useState({});
  const [running, setRunning] = useState(false);
  const [stepError, setStepError] = useState(null);
  const [exitAt, setExitAt] = useState(null);
  const [finished, setFinished] = useState(false);
  const [now, setNow] = useState(nowSec);

  const [feeInput, setFeeInput] = useState(fee != null ? String(fee) : '');
  const [classesInput, setClassesInput] = useState((classes || []).join(', '));

  const key = arbiterKey(oracle, jobId);
  const classParse = parseClasses(classesInput);
  const feeP = parseFee(feeInput);
  const formValid = !feeP.error && !classParse.error;
  const feeChanged = !feeP.error && fee != null && !parseFee(String(fee)).error && feeP.wei !== parseFee(String(fee)).wei;
  const classesChanged = !classParse.error && !sameSet(classParse.classes, classes);

  // Tick once a minute so the unbonding countdown and "ready" state stay current.
  useEffect(() => {
    const t = setInterval(() => setNow(nowSec()), 30000);
    return () => clearInterval(t);
  }, []);

  // Read the arbiter's live state and derive which steps are left.
  const loadCtx = useCallback(async () => {
    const signer = getSigner();
    if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
    const c = await getStakeContext({ signer, keeperAddress, owner, oracle, jobId });
    setCtx(c);
    const a = c.arbiter;
    const registered = a && (a.flags & 1) !== 0;
    const exiting = registered && (a.flags & 8) !== 0;
    if (exiting) setExitAt(a.exitAt);
    return { c, registered, exiting };
  }, [getSigner, keeperAddress, owner, oracle, jobId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { c, registered, exiting } = await loadCtx();
        if (!alive) return;
        setStatus({
          exit: !registered || exiting ? 'done' : 'pending',
          complete: !registered ? 'done' : 'pending',
          approve: c.allowance >= c.stakeRequired ? 'skipped' : 'pending',
          register: 'pending',
        });
      } catch (err) {
        if (alive) setCtxError(err.message || 'Failed to read the arbiter');
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadCtx]);

  const exitStage = ctx?.arbiter && status?.complete !== 'done'
    ? exitView({ flags: status?.exit === 'done' ? 9 : ctx.arbiter.flags, exitAt: exitAt ?? ctx.arbiter.exitAt, blockedUntil: ctx.arbiter.blockedUntil }, now)
    : { state: 'none', waitSeconds: 0 };
  // Steps 2–4 can run once the exit is ready (or already completed).
  const canFinish = status && status.exit === 'done' && (status.complete === 'done' || exitStage.state === 'ready');
  const waiting = status && status.exit === 'done' && status.complete !== 'done' && !canFinish;

  const run = useCallback(async () => {
    if (!ctx || !status) return;
    if (classParse.error) { setStepError(`Classes: ${classParse.error}`); return; }
    if (feeP.error) { setStepError(feeP.error); return; }

    setRunning(true);
    setStepError(null);
    const st = { ...status };
    for (const k of STEP_ORDER) if (st[k] === 'error') st[k] = 'pending';
    const apply = (patch) => {
      Object.assign(st, patch);
      setStatus({ ...st });
    };
    apply({});
    const plan = { network, owner, keeperAddress, oracle, jobId, fee: feeInput.trim(), classes: classParse.classes };

    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');

      if (st.exit === 'pending') {
        // Sitting 1: request the exit and stop. The rest waits for the unbonding period.
        apply({ exit: 'active' });
        const { txHash } = await requestExit({ signer, keeperAddress, key });
        setTxHashes((h) => ({ ...h, exit: txHash }));
        apply({ exit: 'done' });
        const { c } = await loadCtx().catch(() => ({ c: null }));
        const at = c?.arbiter?.exitAt || (nowSec() + (ctx.unbondingPeriod || 172800));
        setExitAt(at);
        markExitRequested({ ...plan, exitAt: at });
        toast.success(`Exit requested · complete it after ${fmtDate(at)}`);
        return;
      }

      updatePlannedParams(plan);

      if (st.complete === 'pending') {
        apply({ complete: 'active' });
        const { txHash } = await completeExit({ signer, keeperAddress, key });
        setTxHashes((h) => ({ ...h, complete: txHash }));
        apply({ complete: 'done' });
        markExitCompleted(plan);
      }

      // Re-check the stake live: completeExit refunded it, so the balance now
      // normally covers the new stake.
      const live = await getStakeContext({ signer, keeperAddress, owner, oracle, jobId });
      setCtx(live);
      if (live.balance < live.stakeRequired) {
        throw new Error(
          `Registering stakes ${fmtWvdka(live.stakeRequired)} wVDKA and your wallet holds ` +
            `${fmtWvdka(live.balance)}. Add wVDKA to ${shortAddr(owner)} and retry — the exit is done, ` +
            'so the arbiter can be registered any time.'
        );
      }

      if (st.approve === 'pending' && live.allowance < live.stakeRequired) {
        apply({ approve: 'active' });
        const { txHash } = await approveStake({
          signer,
          tokenAddress: live.tokenAddress,
          keeperAddress,
          amount: live.stakeRequired,
        });
        setTxHashes((h) => ({ ...h, approve: txHash }));
        apply({ approve: 'done' });
      } else if (st.approve === 'pending') {
        apply({ approve: 'skipped' });
      }

      if (st.register === 'pending') {
        apply({ register: 'active' });
        const { txHash } = await registerArbiter({
          signer, keeperAddress, oracle, jobId, fee: feeP.wei, classes: classParse.classes,
          afterExit: st.complete === 'done',
        });
        setTxHashes((h) => ({ ...h, register: txHash }));
        apply({ register: 'done' });
        clearPendingReset({ network, oracle, jobId });
      }

      setFinished(true);
      toast.success('Arbiter registered again · frozen until its node re-syncs');
    } catch (err) {
      const errored = {};
      for (const k of STEP_ORDER) if (st[k] === 'active') errored[k] = 'error';
      apply(errored);
      setStepError(err.message || 'Failed');
    } finally {
      setRunning(false);
    }
  }, [ctx, status, classParse, feeP, feeInput, getSigner, keeperAddress, key, loadCtx, network, owner, oracle, jobId, toast]);

  const handleClose = () => {
    if (running) return;
    if (finished || txHashes.exit || txHashes.complete) onComplete?.();
    onClose?.();
  };

  const stake = ctx ? fmtWvdka(ctx.stakeRequired) : '…';
  const unbonding = ctx?.unbondingPeriod != null ? formatDuration(ctx.unbondingPeriod) : 'the unbonding period';
  const inputsLocked = running || status?.register === 'done';

  // Best-effort gas warning over the steps that can run in this sitting.
  const runnable = status
    ? STEP_ORDER.filter((k) => status[k] === 'pending' || status[k] === 'error')
      .filter((k) => (status.exit === 'done' ? true : k === 'exit'))
    : [];
  const estGasWei = ctx?.gasPrice != null ? runnable.reduce((s, k) => s + GAS_UNITS[k], 0n) * ctx.gasPrice : null;
  const gasShort = estGasWei != null && estGasWei > 0n && ctx.ethBalance < (estGasWei * 3n) / 2n && !finished;

  const stepMeta = {
    exit: { label: 'Request exit', note: `Stops selection now; unbonding takes ${unbonding}` },
    complete: { label: 'Complete exit', note: `Refunds the stake${exitAt ? ` · allowed from ${fmtDate(exitAt)}` : ''}` },
    approve: { label: `Approve ${stake} wVDKA stake`, note: 'Lets the keeper pull the stake again' },
    register: { label: 'Register again', note: 'With the fee and classes below; scores and offenses carry over' },
  };

  const StepIcon = ({ s, n }) => {
    if (s === 'done') return <Check size={16} className="reset-step-done" />;
    if (s === 'active') return <Loader size={16} className="spinning" />;
    if (s === 'error') return <X size={16} className="reset-step-error" />;
    if (s === 'skipped') return <Check size={16} className="reset-step-skip" />;
    return <span className="reset-step-num">{n}</span>;
  };

  let action = null;
  if (status && !finished) {
    if (status.exit !== 'done') action = 'Request exit';
    else if (canFinish) action = status.complete === 'done' ? 'Register again' : 'Complete exit & register again';
  }

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal reset-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">
          <RotateCcw size={18} className="warn-icon" /> Exit and register again
        </h3>

        <p className="modal-body">
          Use this to change the arbiter&rsquo;s <strong>classes</strong> (they are fixed at
          registration) or to take it offline and bring it back. It takes two sittings:{' '}
          <strong>request the exit now</strong>; after the unbonding period ({unbonding}) come back
          to <strong>complete the exit</strong> (refunding the {stake} wVDKA stake) and{' '}
          <strong>register again</strong> with the fee and classes below. The arbiter is not selected
          from the moment the exit is requested. The keeper keeps this arbiter&rsquo;s record, so its{' '}
          <strong>scores and offenses carry over</strong> — this is not a reset. To change only the
          fee, use &ldquo;Change fee&rdquo; instead: it needs no exit.
        </p>

        {ctx?.arbiter && (
          <div className="reset-current-score">
            Current record (kept) — quality <strong>{ctx.arbiter.quality}</strong>, timeliness{' '}
            <strong>{ctx.arbiter.timeliness}</strong>, {ctx.arbiter.offenses} offense
            {ctx.arbiter.offenses === 1 ? '' : 's'}
          </div>
        )}

        <div className="reset-edit">
          <label className="reset-field">
            <span>Fee when registering again (ETH)</span>
            <input
              type="number" min="0" step="0.00001"
              value={feeInput}
              onChange={(e) => setFeeInput(e.target.value)}
              disabled={inputsLocked}
              aria-invalid={!!feeP.error}
            />
          </label>
          <label className="reset-field">
            <span>Classes when registering again (1–5, comma-separated)</span>
            <input
              type="text"
              value={classesInput}
              onChange={(e) => setClassesInput(e.target.value)}
              disabled={inputsLocked}
              placeholder="e.g. 128, 129"
              aria-invalid={!!classParse.error}
            />
          </label>
          {(feeP.error || classParse.error) && (
            <div className="reset-edit-error">{feeP.error || classParse.error}</div>
          )}
          {formValid && (feeChanged || classesChanged) && (
            <div className="reset-edit-changed">
              <AlertTriangle size={13} /> Will register with
              {feeChanged && <> fee <strong>{feeInput.trim()} ETH</strong></>}
              {feeChanged && classesChanged && ' and'}
              {classesChanged && <> classes <strong>{classParse.classes.join(', ')}</strong></>}
            </div>
          )}
        </div>

        <div className="modal-detail">
          <div><span>Operator</span><code>{shortAddr(oracle)}</code></div>
          <div><span>Job ID</span><code title={jobId}>{shortHash(jobId)}</code></div>
          {ctx && (
            <div>
              <span>Your wallet&rsquo;s wVDKA</span>
              <code>{Number(ethers.formatEther(ctx.balance)).toFixed(2)}</code>
            </div>
          )}
        </div>

        {ctxError && <div className="reset-error">{ctxError}</div>}

        {gasShort && (
          <div className="reset-warn-note">
            <span>
              Warning: your wallet holds only <strong>{fmtEth(ctx.ethBalance)}</strong> ETH, which may
              be too little for the gas of the {runnable.length} transaction
              {runnable.length === 1 ? '' : 's'} in this step (~{fmtEth(estGasWei)} ETH at the current
              gas price).
            </span>
          </div>
        )}

        {status && (
          <div className="reset-steps-box">
            <div className="reset-steps-heading">Steps</div>
            <ol className="reset-steps">
              {STEP_ORDER.map((k, i) => (
                <li key={k} className={`reset-step reset-step-${status[k]}`}>
                  <StepIcon s={status[k]} n={i + 1} />
                  <span className="reset-step-label">
                    {stepMeta[k].label}
                    {status[k] === 'skipped' && <em> · already approved</em>}
                    {status[k] === 'done' && !txHashes[k] && <em> · done earlier</em>}
                    <small>{stepMeta[k].note}</small>
                  </span>
                  {txHashes[k] && (
                    <a
                      className="explorer-link"
                      href={`${chain.explorer}/tx/${txHashes[k]}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {shortHash(txHashes[k])} <ExternalLink size={11} />
                    </a>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {waiting && (
          <div className="reset-warn-note">
            <Clock size={14} />
            <span>
              {exitStage.state === 'blocked' ? (
                <>The unbonding period is over, but the arbiter is blocked: the exit can be completed in{' '}
                  <strong>{formatDuration(exitStage.waitSeconds)}</strong>.</>
              ) : (
                <>Unbonding: the exit can be completed in <strong>{formatDuration(exitStage.waitSeconds)}</strong>{' '}
                  (from {fmtDate(exitAt)}). Come back then — My Arbiters keeps this arbiter&rsquo;s
                  planned fee and classes and shows a button to finish.</>
              )}
            </span>
          </div>
        )}

        {canFinish && !finished && <ResyncNotice />}

        {stepError && <div className="reset-error">{stepError}</div>}

        {finished && (
          <>
            <div className="reset-success">
              <Check size={16} /> Registered again with its previous record.
            </div>
            <ResyncNotice done />
          </>
        )}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={handleClose} disabled={running}>
            {finished || waiting ? 'Close' : 'Cancel'}
          </button>
          {action && (
            <button
              className="btn btn-warning btn-with-icon"
              onClick={run}
              disabled={running || !ctx || !!ctxError || !formValid}
            >
              <RotateCcw size={14} />
              {running ? 'Working…' : stepError ? 'Retry' : action}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ResetArbiterModal;
