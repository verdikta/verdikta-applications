/**
 * Register Arbiter — progress modal for registering an (oracle, jobId) from
 * scratch (no deregister). Two wallet transactions:
 *   1. Approve  — let the keeper pull 100 wVDKA (skipped if already approved)
 *   2. Register — registerOracle(oracle, jobId, fee, classes), staking 100 wVDKA
 *
 * The params are fixed here (edited in RegisterArbiterSection's form); this just
 * confirms and runs. The register staticCall surfaces the on-chain reasons
 * ("Oracle is already registered", "Not authorized…", "Oracle not ArbiterOperator
 * type", "…does not support Reputation Keeper") before any gas is spent.
 */

import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { AlertTriangle, Check, Loader, Circle, X, ExternalLink, PlusCircle } from 'lucide-react';
import { getStakeContext, approveStake, registerArbiter } from '../services/arbiterContracts';
import { parseFee } from '../utils/arbiterRegistration';

const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const STEP_ORDER = ['approve', 'register'];

function RegisterArbiterModal({
  operator,
  jobId,
  fee, // LINK decimal string
  classes, // number[]
  keeperAddress,
  owner,
  chain,
  getSigner,
  toast,
  onClose,
  onComplete,
}) {
  const [ctx, setCtx] = useState(null);
  const [ctxError, setCtxError] = useState(null);
  const [status, setStatus] = useState(null);
  const [txHashes, setTxHashes] = useState({});
  const [running, setRunning] = useState(false);
  const [stepError, setStepError] = useState(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const signer = getSigner();
        if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
        const c = await getStakeContext({ signer, keeperAddress, owner });
        if (!alive) return;
        setCtx(c);
        setStatus({
          approve: c.allowance < c.stakeRequired ? 'pending' : 'skipped',
          register: 'pending',
        });
      } catch (err) {
        if (alive) setCtxError(err.message || 'Failed to read stake info');
      }
    })();
    return () => {
      alive = false;
    };
  }, [getSigner, keeperAddress, owner]);

  const run = useCallback(async () => {
    if (!ctx || !status) return;
    const feeP = parseFee(fee);
    if (feeP.error) {
      setStepError(feeP.error);
      return;
    }

    setRunning(true);
    setStepError(null);
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

      if (st.register === 'pending') {
        apply({ register: 'active' });
        const { txHash } = await registerArbiter({
          signer,
          keeperAddress,
          oracle: operator,
          jobId,
          fee: feeP.wei,
          classes,
        });
        setTxHashes((h) => ({ ...h, register: txHash }));
        apply({ register: 'done' });
      }

      setFinished(true);
      toast.success('Arbiter registered');
    } catch (err) {
      const errored = {};
      for (const k of STEP_ORDER) if (st[k] === 'active') errored[k] = 'error';
      apply(errored);
      setStepError(err.message || 'Registration failed');
    } finally {
      setRunning(false);
    }
  }, [ctx, status, fee, classes, getSigner, keeperAddress, operator, jobId, toast]);

  const handleClose = () => {
    if (running) return;
    if (finished) onComplete?.();
    onClose?.();
  };

  const balanceShort = ctx && ctx.balance < ctx.stakeRequired;

  const stepMeta = {
    approve: { label: 'Approve 100 wVDKA stake', note: 'Lets the keeper pull your stake' },
    register: { label: 'Register arbiter', note: 'Stakes 100 wVDKA on (oracle, jobId)' },
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
          <PlusCircle size={18} className="inline-icon" /> Register this arbiter?
        </h3>

        <p className="modal-body">
          This stakes <strong>100 wVDKA</strong> and registers the arbiter on-chain with the fee
          and classes below. The connected wallet must own the operator contract. You will confirm
          each transaction in your wallet.
        </p>

        <div className="modal-detail">
          <div><span>Operator</span><code title={operator}>{shortAddr(operator)}</code></div>
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
            Your wVDKA balance is below the 100 stake required to register.
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

        {finished && (
          <div className="reset-success">
            <Check size={16} /> Registered — the arbiter is now live.
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={handleClose} disabled={running}>
            {finished ? 'Close' : 'Cancel'}
          </button>
          {!finished && (
            <button
              className="btn btn-primary btn-with-icon"
              onClick={run}
              disabled={running || !ctx || !!ctxError || balanceShort}
            >
              {stepError ? <AlertTriangle size={14} /> : <PlusCircle size={14} />}
              {running ? 'Working…' : stepError ? 'Retry' : 'Register arbiter'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default RegisterArbiterModal;
