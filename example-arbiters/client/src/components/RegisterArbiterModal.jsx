/**
 * Register Arbiter — progress modal for registering an (oracle, jobId) with the
 * v2 ReputationKeeper. Two wallet transactions:
 *   1. Approve  — let the keeper pull stakeRequirement wVDKA (skipped if already approved)
 *   2. Register — registerArbiter(oracle, jobId, fee, classes, chainHead = 0)
 *
 * The browser cannot hold the arbiter's hash chain (it lives on the node), so the
 * site registers with an empty head. The arbiter then starts frozen in re-sync
 * and is not selectable until its node's health job re-syncs onto a fresh chain
 * and answers a health call — automatic, within a minute or so of the job
 * running. The modal says so before and after the transaction.
 *
 * The params are fixed here (edited in RegisterArbiterSection's form); this just
 * confirms and runs. The register staticCall surfaces the keeper's reasons
 * (AlreadyRegistered, NotArbiterOwner, BadParams…) before any gas is spent.
 */

import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { AlertTriangle, Check, Loader, Circle, X, ExternalLink, PlusCircle, Snowflake } from 'lucide-react';
import { getStakeContext, approveStake, registerArbiter } from '../services/arbiterContracts';
import { clearPendingReset } from '../services/resetRegistry';
import { parseFee } from '../utils/arbiterRegistration';

const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmtWvdka = (wei) => {
  const n = Number(ethers.formatEther(wei));
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};
const STEP_ORDER = ['approve', 'register'];

/** The frozen-until-re-sync notice shown before and after registering from the site. */
export function ResyncNotice({ done = false }) {
  return (
    <div className="reset-warn-note resync-note">
      <Snowflake size={14} />
      <span>
        {done ? 'Registered, but the arbiter is ' : 'After registering, the arbiter is '}
        <strong>frozen and will not be selected</strong> until its node is running and has
        re-synced its health hash chain. A browser can&rsquo;t hold that chain, so the site
        registers without one; the node&rsquo;s health job sets up a fresh chain and answers a
        health call on its own, usually within a minute or so of the job running. My Arbiters shows
        it as &ldquo;Frozen (re-syncing)&rdquo; until then. Alternatively, register from the node
        with <code>register-oracle.sh</code> (verdikta-arbiter installer), which creates the chain
        and the health job.
      </span>
    </div>
  );
}

function RegisterArbiterModal({
  operator,
  jobId,
  fee, // ETH decimal string
  classes, // number[]
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
        const c = await getStakeContext({ signer, keeperAddress, owner, oracle: operator, jobId });
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
  }, [getSigner, keeperAddress, owner, operator, jobId]);

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
        if (network) clearPendingReset({ network, oracle: operator, jobId });
      }

      setFinished(true);
      toast.success('Arbiter registered · frozen until its node re-syncs');
    } catch (err) {
      const errored = {};
      for (const k of STEP_ORDER) if (st[k] === 'active') errored[k] = 'error';
      apply(errored);
      setStepError(err.message || 'Registration failed');
    } finally {
      setRunning(false);
    }
  }, [ctx, status, fee, classes, getSigner, keeperAddress, operator, jobId, network, toast]);

  const handleClose = () => {
    if (running) return;
    if (finished) onComplete?.();
    onClose?.();
  };

  const stake = ctx ? fmtWvdka(ctx.stakeRequired) : null;
  const balanceShort = ctx && ctx.balance < ctx.stakeRequired && status?.register !== 'done';
  // A key with checkpoints has registered before: v2 keeps its scores and offenses.
  const returning = ctx?.arbiter && ctx.arbiter.checkpoints > 0;
  const stillRegistered = ctx?.arbiter && (ctx.arbiter.flags & 1) !== 0 && status?.register !== 'done';

  const stepMeta = {
    approve: { label: `Approve ${stake ?? '…'} wVDKA stake`, note: 'Lets the keeper pull your stake' },
    register: { label: 'Register arbiter', note: `Stakes ${stake ?? '…'} wVDKA on (oracle, jobId)` },
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
          This stakes <strong>{stake ?? '…'} wVDKA</strong> (the keeper&rsquo;s current stake
          requirement) and registers the arbiter on-chain with the fee and classes below. The
          connected wallet must own the operator contract. You will confirm each transaction in your
          wallet. The stake comes back when you exit (request the exit, wait out the unbonding
          period, then complete it).
        </p>

        {!finished && <ResyncNotice />}

        {returning && (
          <div className="reset-current-score">
            This operator + Job ID has been registered before. v2 keeps its record, so it comes back
            with quality <strong>{ctx.arbiter.quality}</strong>, timeliness{' '}
            <strong>{ctx.arbiter.timeliness}</strong> and <strong>{ctx.arbiter.offenses}</strong>{' '}
            offense{ctx.arbiter.offenses === 1 ? '' : 's'}.
          </div>
        )}

        <div className="modal-detail">
          <div><span>Operator</span><code title={operator}>{shortAddr(operator)}</code></div>
          <div><span>Job ID</span><code title={jobId}>{shortHash(jobId)}</code></div>
          <div><span>Fee</span><code>{fee} ETH</code></div>
          <div><span>Classes</span><code>{classes?.join(', ') || '—'}</code></div>
          {ctx && (
            <div>
              <span>Your wVDKA</span>
              <code>{Number(ethers.formatEther(ctx.balance)).toFixed(2)}</code>
            </div>
          )}
        </div>

        {ctxError && <div className="reset-error">{ctxError}</div>}

        {stillRegistered && (
          <div className="reset-error">
            This arbiter is still registered
            {(ctx.arbiter.flags & 8) !== 0 ? ' (its exit has not been completed yet)' : ''}. Complete
            its exit from My Arbiters before registering it again.
          </div>
        )}

        {balanceShort && (
          <div className="reset-error">
            Your wVDKA balance is below the {stake} stake required to register.
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
          <>
            <div className="reset-success">
              <Check size={16} /> Registered on-chain.
            </div>
            <ResyncNotice done />
          </>
        )}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={handleClose} disabled={running}>
            {finished ? 'Close' : 'Cancel'}
          </button>
          {!finished && (
            <button
              className="btn btn-primary btn-with-icon"
              onClick={run}
              disabled={running || !ctx || !!ctxError || balanceShort || stillRegistered}
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
