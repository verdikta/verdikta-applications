/**
 * Small single-purpose modals for the v2 keeper's in-place arbiter actions on
 * My Arbiters (owner of the operator contract only):
 *  - kind 'fee':   setFee(key, fee) — no exit needed, takes effect for the next draw
 *  - kind 'topup': approve (if needed) + topUpStake(key, amount) — clears the
 *                  under-staked flag once the stake meets stakeRequirement
 *  - kind 'exit':  requestExit(key) — stops selection now; completeExit (which
 *                  refunds the stake) is allowed after the unbonding period
 */

import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { AlertTriangle, Check, Loader, Coins, LogOut, Pencil } from 'lucide-react';
import { getStakeContext, approveStake, topUpStake, setFee, requestExit } from '../services/arbiterContracts';
import { parseFee, formatDuration } from '../utils/arbiterRegistration';

const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function ArbiterActionModal({
  kind,
  operator,
  job,
  keeperAddress,
  owner,
  maxOracleFee, // formatted ETH string or null
  unbondingPeriodSeconds,
  getSigner,
  toast,
  onClose,
  onDone,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [feeInput, setFeeInput] = useState(job.fee != null ? String(job.fee) : '');
  const [amountInput, setAmountInput] = useState(job.understakedBy || '');
  const [ctx, setCtx] = useState(null);

  useEffect(() => {
    if (kind !== 'topup') return undefined;
    let alive = true;
    (async () => {
      try {
        const signer = getSigner();
        if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
        const c = await getStakeContext({ signer, keeperAddress, owner });
        if (alive) setCtx(c);
      } catch (err) {
        if (alive) setError(err.message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [kind, getSigner, keeperAddress, owner]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const feeP = parseFee(feeInput);
  const feeAboveMax = !feeP.error && maxOracleFee != null && feeP.wei > ethers.parseEther(String(maxOracleFee));
  let amountWei = null;
  let amountError = null;
  if (kind === 'topup') {
    try {
      amountWei = ethers.parseEther(String(amountInput || '').trim() || '0');
      if (amountWei <= 0n) amountError = 'Enter an amount above 0';
    } catch {
      amountError = 'Invalid amount';
    }
  }

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
      let res;
      if (kind === 'fee') {
        res = await setFee({ signer, keeperAddress, key: job.key, fee: feeP.wei });
        toast.success(`Fee set to ${feeInput.trim()} ETH · tx ${shortHash(res.txHash)}`);
      } else if (kind === 'topup') {
        const live = await getStakeContext({ signer, keeperAddress, owner });
        if (live.balance < amountWei) throw new Error('Your wVDKA balance is below that amount.');
        if (live.allowance < amountWei) {
          await approveStake({ signer, tokenAddress: live.tokenAddress, keeperAddress, amount: amountWei });
        }
        res = await topUpStake({ signer, keeperAddress, key: job.key, amount: amountWei });
        toast.success(`Stake topped up by ${amountInput} wVDKA · tx ${shortHash(res.txHash)}`);
      } else if (kind === 'exit') {
        res = await requestExit({ signer, keeperAddress, key: job.key });
        toast.success(`Exit requested · tx ${shortHash(res.txHash)}`);
      }
      onDone?.();
    } catch (err) {
      setError(err.message || 'Transaction failed');
    } finally {
      setBusy(false);
    }
  };

  const unbonding = unbondingPeriodSeconds != null ? formatDuration(unbondingPeriodSeconds) : 'the unbonding period';
  const titles = {
    fee: <><Pencil size={18} className="inline-icon" /> Change the fee</>,
    topup: <><Coins size={18} className="inline-icon" /> Top up the stake</>,
    exit: <><LogOut size={18} className="warn-icon" /> Exit this arbiter?</>,
  };
  const disabled = busy
    || (kind === 'fee' && !!feeP.error)
    || (kind === 'topup' && (!!amountError || !ctx));

  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{titles[kind]}</h3>

        {kind === 'fee' && (
          <>
            <p className="modal-body">
              The fee is what a request pays this arbiter when it is drawn. It changes in place
              (setFee); no exit is needed. Requests never select an arbiter whose fee is above their
              ceiling{maxOracleFee != null ? <> or the aggregator&rsquo;s maximum of <strong>{maxOracleFee} ETH</strong></> : ''}.
            </p>
            <label className="reset-field">
              <span>New fee (ETH)</span>
              <input type="number" min="0" step="0.00001" value={feeInput} onChange={(e) => setFeeInput(e.target.value)} disabled={busy} />
            </label>
            {feeInput !== '' && feeP.error && <div className="reset-edit-error">{feeP.error}</div>}
            {feeAboveMax && (
              <div className="reset-warn-note"><AlertTriangle size={14} /> Above the aggregator&rsquo;s maximum fee: the arbiter would not be selected.</div>
            )}
          </>
        )}

        {kind === 'topup' && (
          <>
            <p className="modal-body">
              Adds wVDKA to this arbiter&rsquo;s stake (topUpStake). An arbiter whose stake is below
              the keeper&rsquo;s requirement{ctx ? <> ({Number(ethers.formatEther(ctx.stakeRequired))} wVDKA)</> : ''} is
              not selected; the current stake is <strong>{job.stake} wVDKA</strong>. If the keeper
              needs an allowance first, you will confirm an approval too.
            </p>
            <label className="reset-field">
              <span>Amount (wVDKA)</span>
              <input type="number" min="0" step="1" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} disabled={busy} />
            </label>
            {amountInput !== '' && amountError && <div className="reset-edit-error">{amountError}</div>}
            {ctx && <div className="muted">Your wVDKA: {Number(ethers.formatEther(ctx.balance)).toFixed(2)}</div>}
          </>
        )}

        {kind === 'exit' && (
          <p className="modal-body">
            Requesting the exit takes the arbiter out of selection now. Its{' '}
            <strong>{job.stake} wVDKA</strong> stake stays bonded for {unbonding}: blocks and bans
            can still apply for rounds it was drawn into. After that, come back and{' '}
            <strong>complete the exit</strong> to get the stake back. You cannot cancel an exit; to
            return, complete it and register again (the arbiter keeps its scores and offenses).
          </p>
        )}

        <div className="modal-detail">
          <div><span>Operator</span><code>{shortAddr(operator.operator)}</code></div>
          <div><span>Job ID</span><code title={job.jobId}>{shortHash(job.jobId)}</code></div>
        </div>

        {error && <div className="reset-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={`btn ${kind === 'exit' ? 'btn-danger' : 'btn-primary'} btn-with-icon`}
            onClick={run}
            disabled={disabled}
          >
            {busy ? <Loader size={14} className="spinning" /> : <Check size={14} />}
            {busy ? 'Working…' : kind === 'fee' ? 'Set fee' : kind === 'topup' ? 'Top up' : 'Request exit'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ArbiterActionModal;
