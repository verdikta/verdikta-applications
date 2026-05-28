/**
 * Reset Arbiter Reputation — guided multi-step modal.
 *
 * Resetting wipes an arbiter's on-chain reputation by closing it out and
 * re-registering the SAME (oracle, jobId). Because the jobId is unchanged, the
 * node's Chainlink job keeps running as-is — only the reputation record is
 * rewritten to zero. This is a rehabilitation tool for penalized/blocked
 * arbiters; a healthy arbiter would lose its accumulated score.
 *
 * The flow is three wallet transactions, run in this order so the only step
 * AFTER the arbiter goes offline (deregister) is the single re-register tx:
 *   1. Approve  — let the keeper pull 100 wVDKA (skipped if already approved)
 *   2. Close out — deregisterOracle: refunds 100 wVDKA, deletes the record
 *   3. Re-register — registerOracle: re-stakes 100 wVDKA, fresh reputation
 *
 * On failure the completed steps stay done and the user can retry from where it
 * stopped. If they close after step 2, resetRegistry keeps a resume entry so My
 * Arbiters can offer to finish step 3 later.
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

const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const STEP_ORDER = ['approve', 'deregister', 'register'];

/**
 * Props:
 *  - oracle, jobId, fee (formatEther string), classes (number[]): the arbiter
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

  // Load stake context, then derive which steps are needed.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const signer = getSigner();
        if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
        const c = await getStakeContext({ signer, keeperAddress, owner });
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
  }, [getSigner, keeperAddress, owner, resume]);

  const run = useCallback(async () => {
    if (!ctx || !status) return;
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

      if (st.approve === 'pending') {
        apply({ approve: 'active' });
        const { txHash } = await approveStake({
          signer,
          tokenAddress: ctx.tokenAddress,
          keeperAddress,
          amount: ctx.stakeRequired,
        });
        setTxHashes((h) => ({ ...h, approve: txHash }));
        apply({ approve: 'done' });
      }

      if (st.deregister === 'pending') {
        apply({ deregister: 'active' });
        const { txHash } = await deregisterArbiter({ signer, keeperAddress, oracle, jobId });
        setTxHashes((h) => ({ ...h, deregister: txHash }));
        apply({ deregister: 'done' });
        // Arbiter is now delisted — persist so step 3 can be resumed if needed.
        markDeregistered({ network, owner, keeperAddress, oracle, jobId, fee, classes });
      }

      if (st.register === 'pending') {
        apply({ register: 'active' });
        const { txHash } = await registerArbiter({
          signer,
          keeperAddress,
          oracle,
          jobId,
          fee: ethers.parseEther(String(fee)),
          classes,
        });
        setTxHashes((h) => ({ ...h, register: txHash }));
        apply({ register: 'done' });
        clearPendingReset({ network, oracle, jobId });
      }

      setFinished(true);
      toast.success('Arbiter reputation reset · re-registered fresh');
    } catch (err) {
      const errored = {};
      for (const k of STEP_ORDER) if (st[k] === 'active') errored[k] = 'error';
      apply(errored);
      setStepError(err.message || 'Reset failed');
    } finally {
      setRunning(false);
    }
  }, [ctx, status, getSigner, keeperAddress, oracle, jobId, fee, classes, network, owner, toast]);

  const handleClose = () => {
    if (running) return;
    if (finished) onComplete?.();
    onClose?.();
  };

  const started = status && STEP_ORDER.some((k) => txHashes[k]);
  const deregistered = status?.deregister === 'done';
  const balanceShort =
    ctx && ctx.balance < ctx.stakeRequired && status?.deregister !== 'done';

  const stepMeta = {
    approve: { label: 'Approve 100 wVDKA stake', note: 'Lets the keeper pull your stake' },
    deregister: { label: 'Close out (deregister & refund)', note: 'Deletes the reputation record' },
    register: { label: 'Re-register with fresh reputation', note: 'Re-stakes 100 wVDKA, score = 0' },
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
          <AlertTriangle size={18} className="warn-icon" />
          {resume ? 'Finish re-registering this arbiter' : 'Reset this arbiter’s reputation?'}
        </h3>

        <p className="modal-body">
          {resume ? (
            <>
              This arbiter was <strong>closed out but not re-registered</strong>, so it is currently
              offline and delisted. Finish the re-registration below to restore it with a fresh
              reputation (score reset to zero).
            </>
          ) : (
            <>
              This permanently <strong>wipes the arbiter’s reputation</strong> — quality and
              timeliness scores, history, and any penalty/block — by closing it out and
              re-registering the same Job&nbsp;ID. The node keeps running the same Chainlink job;
              only the on-chain score resets to zero. The 100&nbsp;wVDKA stake is refunded on
              close-out and re-staked on re-register (net zero, minus gas). There is a brief window
              between close-out and re-register where the arbiter is offline.
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

        <div className="modal-detail">
          <div><span>Operator</span><code>{shortAddr(oracle)}</code></div>
          <div><span>Job ID</span><code title={jobId}>{shortHash(jobId)}</code></div>
          <div><span>Fee</span><code>{fee} LINK</code></div>
          <div><span>Classes</span><code>{classes?.join(', ') || '—'}</code></div>
          {ctx && (
            <div>
              <span>Your wVDKA</span>
              <code>{Number(ethers.formatEther(ctx.balance)).toFixed(2)}</code>
            </div>
          )}
        </div>

        {ctxError && <div className="reset-error">{ctxError}</div>}

        {balanceShort && (
          <div className="reset-error">
            Your wVDKA balance is below the 100 stake. The close-out refund should cover it, but if
            the stake was slashed you may need additional wVDKA before re-registering.
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
              disabled={running || !ctx || !!ctxError}
            >
              {stepError ? <RotateCcw size={14} /> : <AlertTriangle size={14} />}
              {running
                ? 'Working…'
                : stepError
                  ? 'Retry'
                  : resume
                    ? 'Re-register arbiter'
                    : 'Reset reputation'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ResetArbiterModal;
