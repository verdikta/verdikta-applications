/**
 * Restart Arbiter — guided multi-step modal.
 *
 * "Restart" re-registers the SAME (oracle, jobId), optionally with a new fee
 * and/or set of classes. Because re-registration is the only way to change
 * those on-chain, and deregister deletes the reputation record, a restart also
 * resets the arbiter's reputation (quality/timeliness/history/locks) to zero —
 * whether or not the params change. The jobId is unchanged, so the node's
 * Chainlink job keeps running as-is.
 *
 * Three wallet transactions, in this order so the only step AFTER the arbiter
 * goes offline (deregister) is the single re-register tx:
 *   1. Approve  — let the keeper pull 100 wVDKA (skipped if already approved)
 *   2. Close out — deregisterOracle: refunds 100 wVDKA, deletes the record
 *   3. Re-register — registerOracle(fee, classes): re-stakes, fresh reputation
 *
 * On failure the completed steps stay done and the user can retry from where it
 * stopped. If they close after step 2, resetRegistry keeps a resume entry (with
 * the chosen fee/classes) so My Arbiters can offer to finish step 3 later.
 */

import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import {
  AlertTriangle,
  Check,
  Loader,
  Circle,
  X,
  ExternalLink,
  RotateCcw,
} from 'lucide-react';
import {
  getStakeContext,
  approveStake,
  deregisterArbiter,
  registerArbiter,
} from '../services/arbiterContracts';
import { markDeregistered, clearPendingReset } from '../services/resetRegistry';
import { parseClasses, sameSet } from '../utils/arbiterRegistration';

const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmtWvdka = (wei) => Number(ethers.formatEther(wei)).toFixed(2);
// ETH amounts here are tiny (Base gas); show 3 significant figures, no trailing zeros.
const fmtEth = (wei) => {
  const n = Number(ethers.formatEther(wei));
  return n === 0 ? '0' : `${parseFloat(n.toPrecision(3))}`;
};
const STEP_ORDER = ['approve', 'deregister', 'register'];
// Generous per-tx gas-unit upper bounds, only for the "enough ETH for gas?"
// warning (deregister loops over the global oracle list; register does the
// interface checks + transferFrom + several storage writes). Erring high makes
// the warning fire a little early rather than too late.
const GAS_UNITS = { approve: 80000n, deregister: 300000n, register: 450000n };

/**
 * Props:
 *  - oracle, jobId, fee (formatEther string), classes (number[]): the arbiter;
 *    fee/classes seed the editable fields (the defaults).
 *  - keeperAddress, network, owner, chain: context for the writes/links
 *  - qualityScore, timelinessScore, callCount: shown in the warning (optional)
 *  - resume: true when deregister already happened (start at re-register)
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
  qualityScore,
  timelinessScore,
  callCount,
  resume = false,
  getSigner,
  toast,
  onClose,
  onComplete,
}) {
  const [ctx, setCtx] = useState(null); // { tokenAddress, stakeRequired, allowance, balance }
  const [ctxError, setCtxError] = useState(null);
  const [status, setStatus] = useState(null); // { approve, deregister, register }
  const [txHashes, setTxHashes] = useState({});
  const [running, setRunning] = useState(false);
  const [stepError, setStepError] = useState(null);
  const [finished, setFinished] = useState(false);

  // Editable registration params, defaulting to the arbiter's current values.
  const [feeInput, setFeeInput] = useState(fee != null ? String(fee) : '');
  const [classesInput, setClassesInput] = useState((classes || []).join(', '));

  // --- Validation (recomputed each render) --------------------------------
  const classParse = parseClasses(classesInput);
  let feeWei = null;
  let feeError = null;
  if (feeInput.trim() === '') {
    feeError = 'Enter a fee';
  } else {
    try {
      feeWei = ethers.parseEther(feeInput.trim());
      if (feeWei <= 0n) feeError = 'Fee must be greater than 0';
    } catch {
      feeError = 'Invalid fee amount';
    }
  }
  const formValid = !feeError && !classParse.error;
  const feeChanged = !feeError && fee != null && feeWei !== ethers.parseEther(String(fee));
  const classesChanged = !classParse.error && !sameSet(classParse.classes, classes);

  // Load stake context, then derive which steps are needed.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const signer = getSigner();
        if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
        const c = await getStakeContext({ signer, keeperAddress, owner, oracle, jobId });
        if (!alive) return;
        setCtx(c);
        const approveNeeded = c.allowance < c.stakeRequired;
        setStatus({
          approve: approveNeeded ? 'pending' : 'skipped',
          deregister: resume ? 'done' : 'pending',
          register: 'pending',
        });
      } catch (err) {
        if (alive) setCtxError(err.message || 'Failed to read stake info');
      }
    })();
    return () => {
      alive = false;
    };
  }, [getSigner, keeperAddress, owner, oracle, jobId, resume]);

  const run = useCallback(async () => {
    if (!ctx || !status) return;
    // Re-parse the (possibly edited) params and bail before any tx if invalid.
    const cls = parseClasses(classesInput);
    if (cls.error) {
      setStepError(`Classes: ${cls.error}`);
      return;
    }
    let feeAmount;
    try {
      feeAmount = ethers.parseEther(feeInput.trim());
      if (feeAmount <= 0n) throw new Error('Fee must be greater than 0');
    } catch (err) {
      setStepError(err.message || 'Invalid fee amount');
      return;
    }

    setRunning(true);
    setStepError(null);

    // Working copy; normalize a prior error back to pending so retry resumes it.
    const st = { ...status };
    for (const k of STEP_ORDER) if (st[k] === 'error') st[k] = 'pending';
    const apply = (patch) => {
      Object.assign(st, patch);
      setStatus({ ...st });
    };
    apply({});

    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');

      // Re-read stake state live so this guard uses fresh numbers (and adding
      // wVDKA + retrying actually clears a prior shortfall). Re-register always
      // stakes a full STAKE_REQUIREMENT; deregister refunds only the current
      // stake (normally 100, but a future slash could be less). currentStake
      // reads 0 once the record is gone, so on a post-deregister retry the
      // refund is already counted in `balance`. We check BEFORE deregister so a
      // shortfall can never strand the arbiter offline mid-flow.
      const live = await getStakeContext({ signer, keeperAddress, owner, oracle, jobId });
      setCtx(live);
      const deficit = live.stakeRequired - live.balance - live.currentStake;
      if (deficit > 0n) {
        throw new Error(
          `Re-registering stakes ${fmtWvdka(live.stakeRequired)} wVDKA. After the ` +
            `${fmtWvdka(live.currentStake)} wVDKA refund your wallet would still be ` +
            `${fmtWvdka(deficit)} wVDKA short — add wVDKA to ${shortAddr(owner)} and retry.`
        );
      }

      if (st.approve === 'pending') {
        apply({ approve: 'active' });
        const { txHash } = await approveStake({
          signer,
          tokenAddress: live.tokenAddress,
          keeperAddress,
          amount: live.stakeRequired,
        });
        setTxHashes((h) => ({ ...h, approve: txHash }));
        apply({ approve: 'done' });
      }

      if (st.deregister === 'pending') {
        apply({ deregister: 'active' });
        const { txHash } = await deregisterArbiter({ signer, keeperAddress, oracle, jobId });
        setTxHashes((h) => ({ ...h, deregister: txHash }));
        apply({ deregister: 'done' });
        // Arbiter is now delisted — persist the chosen params so step 3 can be
        // resumed (defaults reflect the user's edits, not the originals).
        markDeregistered({
          network, owner, keeperAddress, oracle, jobId,
          fee: feeInput.trim(), classes: cls.classes,
        });
      }

      if (st.register === 'pending') {
        apply({ register: 'active' });
        const { txHash } = await registerArbiter({
          signer,
          keeperAddress,
          oracle,
          jobId,
          fee: feeAmount,
          classes: cls.classes,
        });
        setTxHashes((h) => ({ ...h, register: txHash }));
        apply({ register: 'done' });
        clearPendingReset({ network, oracle, jobId });
      }

      setFinished(true);
      toast.success('Arbiter restarted · re-registered with fresh reputation');
    } catch (err) {
      const errored = {};
      for (const k of STEP_ORDER) if (st[k] === 'active') errored[k] = 'error';
      apply(errored);
      setStepError(err.message || 'Restart failed');
    } finally {
      setRunning(false);
    }
  }, [ctx, status, classesInput, feeInput, getSigner, keeperAddress, oracle, jobId, network, owner, toast]);

  const handleClose = () => {
    if (running) return;
    if (finished) onComplete?.();
    onClose?.();
  };

  const started = status && STEP_ORDER.some((k) => txHashes[k]);
  const deregistered = status?.deregister === 'done';
  // Params are only consumed at re-register, so editing stays open until then.
  const inputsLocked = running || status?.register === 'done';
  // Funding preview (open-time read; run() re-checks live before any tx). The
  // wallet must cover whatever the deregister refund won't: re-register stakes a
  // full STAKE_REQUIREMENT, deregister refunds only currentStake. currentStake
  // reads 0 once the record is gone (resume / post-deregister), where the refund
  // is already in `balance`. A positive deficit means restarting would strand
  // the arbiter offline, so we surface it and block until it's covered.
  const refundPending = ctx ? ctx.currentStake : 0n;
  const stakeDeficitWei = ctx ? ctx.stakeRequired - ctx.balance - refundPending : 0n;
  const stakeShortfall = ctx != null && stakeDeficitWei > 0n && status?.register !== 'done';

  // Gas-sufficiency warning (best-effort, non-blocking — gas estimates are
  // approximate and registerOracle can't be estimateGas'd before deregister).
  // Sum the still-to-run steps (not done / not skipped) and price them at the
  // current gas price, with a 1.5x buffer for price movement across the flow.
  const remainingSteps = status
    ? STEP_ORDER.filter((k) => status[k] !== 'done' && status[k] !== 'skipped')
    : [];
  const remainingGasUnits = remainingSteps.reduce((sum, k) => sum + GAS_UNITS[k], 0n);
  const estGasWei = ctx?.gasPrice != null ? remainingGasUnits * ctx.gasPrice : null;
  const gasShort =
    estGasWei != null && estGasWei > 0n && ctx.ethBalance < (estGasWei * 3n) / 2n && !finished;

  const stepMeta = {
    approve: { label: 'Approve 100 wVDKA stake', note: 'Lets the keeper pull your stake' },
    deregister: { label: 'Close out (deregister & refund)', note: 'Deletes the reputation record' },
    register: { label: 'Re-register', note: 'Re-stakes 100 wVDKA · fresh reputation · new fee/classes' },
  };

  const StepIcon = ({ s }) => {
    if (s === 'done') return <Check size={16} className="reset-step-done" />;
    if (s === 'active') return <Loader size={16} className="spinning" />;
    if (s === 'error') return <X size={16} className="reset-step-error" />;
    if (s === 'skipped') return <Check size={16} className="reset-step-skip" />;
    return <Circle size={16} className="reset-step-pending" />;
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal reset-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">
          <RotateCcw size={18} className="warn-icon" />
          {resume ? 'Finish restarting this arbiter' : 'Restart this arbiter'}
        </h3>

        <p className="modal-body">
          {resume ? (
            <>
              This arbiter was <strong>closed out but not re-registered</strong>, so it is currently
              offline and delisted. Finish re-registering below — you can still adjust the fee and
              classes. Its reputation starts fresh at zero.
            </>
          ) : (
            <>
              Restart re-registers this arbiter, optionally with a <strong>new fee and/or
              classes</strong> (defaults below are the current values). Because changing those
              on-chain requires re-registration, restarting also <strong>resets the reputation</strong>{' '}
              — scores, history, and any penalty/block reset to zero. The node keeps running the same
              Chainlink job (Job&nbsp;ID unchanged). The 100&nbsp;wVDKA stake is refunded on
              close-out and re-staked on re-register (net zero, minus gas), with a brief offline
              window in between.
            </>
          )}
        </p>

        {(qualityScore != null || timelinessScore != null) && !resume && (
          <div className="reset-current-score">
            Current score being discarded — quality <strong>{qualityScore ?? '—'}</strong>,
            timeliness <strong>{timelinessScore ?? '—'}</strong>
            {callCount != null && <> · {callCount} calls</>}
          </div>
        )}

        <div className="reset-edit">
          <label className="reset-field">
            <span>Fee (LINK)</span>
            <input
              type="number" min="0" step="0.001"
              value={feeInput}
              onChange={(e) => setFeeInput(e.target.value)}
              disabled={inputsLocked}
              aria-invalid={!!feeError}
            />
          </label>
          <label className="reset-field">
            <span>Classes (1–5, comma-separated)</span>
            <input
              type="text"
              value={classesInput}
              onChange={(e) => setClassesInput(e.target.value)}
              disabled={inputsLocked}
              placeholder="e.g. 128, 129"
              aria-invalid={!!classParse.error}
            />
          </label>
          {(feeError || classParse.error) && (
            <div className="reset-edit-error">{feeError || classParse.error}</div>
          )}
          {formValid && (feeChanged || classesChanged) && (
            <div className="reset-edit-changed">
              <AlertTriangle size={13} /> Changing
              {feeChanged && <> fee → <strong>{feeInput.trim()} LINK</strong></>}
              {feeChanged && classesChanged && ' and'}
              {classesChanged && <> classes → <strong>{classParse.classes.join(', ')}</strong></>}
            </div>
          )}
          {formValid && !feeChanged && !classesChanged && (
            <div className="reset-edit-unchanged">Keeping current fee and classes (reputation still resets).</div>
          )}
        </div>

        <div className="modal-detail">
          <div><span>Operator</span><code>{shortAddr(oracle)}</code></div>
          <div><span>Job ID</span><code title={jobId}>{shortHash(jobId)}</code></div>
          {ctx && (
            <div>
              <span>Your wVDKA</span>
              <code>{Number(ethers.formatEther(ctx.balance)).toFixed(2)}</code>
            </div>
          )}
        </div>

        {ctxError && <div className="reset-error">{ctxError}</div>}

        {stakeShortfall && (
          <div className="reset-error">
            {refundPending > 0n ? (
              <>
                This arbiter's on-chain stake is <strong>{fmtWvdka(ctx.currentStake)}</strong> wVDKA
                and your wallet holds {fmtWvdka(ctx.balance)} — after the refund you'd still be{' '}
                <strong>{fmtWvdka(stakeDeficitWei)}</strong> wVDKA short of the{' '}
                {fmtWvdka(ctx.stakeRequired)} needed to re-register. Add the difference and reopen
                this dialog, or the arbiter would be left offline after close-out.
              </>
            ) : (
              <>
                Your wVDKA balance ({fmtWvdka(ctx.balance)}) is below the{' '}
                {fmtWvdka(ctx.stakeRequired)} needed to re-register. Add at least{' '}
                <strong>{fmtWvdka(stakeDeficitWei)}</strong> wVDKA and reopen this dialog to finish
                the restart.
              </>
            )}
          </div>
        )}

        {gasShort && (
          <div className="reset-warn-note">
            <span>
              Warning: your wallet holds only <strong>{fmtEth(ctx.ethBalance)}</strong> ETH, which
              may be too little to cover gas for the {remainingSteps.length} remaining
              transaction{remainingSteps.length === 1 ? '' : 's'} of this restart
              (~{fmtEth(estGasWei)} ETH total at the current gas price). Add ETH if a step fails for
              lack of gas.
            </span>
          </div>
        )}

        {status && (
          <ol className="reset-steps">
            {STEP_ORDER.map((k) => (
              <li key={k} className={`reset-step reset-step-${status[k]}`}>
                <StepIcon s={status[k]} />
                <span className="reset-step-label">
                  {stepMeta[k].label}
                  {status[k] === 'skipped' && <em> · already approved</em>}
                  {status[k] === 'done' && k === 'deregister' && resume && !txHashes.deregister && (
                    <em> · done previously</em>
                  )}
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
        )}

        {stepError && <div className="reset-error">{stepError}</div>}

        {finished ? (
          <div className="reset-success">
            <Check size={16} /> Done — the arbiter is re-registered with a fresh reputation.
          </div>
        ) : deregistered && !running && started ? (
          <div className="reset-warn-note">
            <AlertTriangle size={14} /> The arbiter is deregistered and offline. Complete
            re-registration to bring it back — you can reopen this from My Arbiters if you close now.
          </div>
        ) : null}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={handleClose} disabled={running}>
            {finished ? 'Close' : 'Cancel'}
          </button>
          {!finished && (
            <button
              className="btn btn-danger btn-with-icon"
              onClick={run}
              disabled={running || !ctx || !!ctxError || !formValid || stakeShortfall}
            >
              <RotateCcw size={14} />
              {running
                ? 'Working…'
                : stepError
                  ? 'Retry'
                  : resume
                    ? 'Finish restart'
                    : 'Restart arbiter'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ResetArbiterModal;
