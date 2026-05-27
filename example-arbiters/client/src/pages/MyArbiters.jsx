/**
 * My Arbiters Page (wallet-gated)
 *
 * Lets an arbiter owner manage the arbiters their connected wallet controls on
 * the header-selected network:
 *  - Claim earned LINK (per operator contract → ArbiterOperator.withdraw)
 *  - Close out an arbiter and reclaim the 100 wVDKA stake (per oracle+jobId →
 *    ReputationKeeper.deregisterOracle)
 *
 * Reads come from the backend (/api/arbiters/owned); writes go through the
 * user's wallet signer (services/arbiterContracts). The header network selector
 * is the source of truth for the chain — if the wallet is on a different chain
 * we prompt a switch rather than following the wallet.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Wallet,
  RefreshCw,
  AlertTriangle,
  Coins,
  Lock,
  ExternalLink,
  Server,
  Inbox,
  Fuel,
} from 'lucide-react';
import { useToast } from '../components/Toast';
import { useNetwork } from '../context/NetworkContext';
import { useWallet } from '../context/WalletContext';
import { chainForNetwork } from '../config/chains';
import { apiService } from '../services/api';
import { claimLink, deregisterArbiter, sendEth } from '../services/arbiterContracts';
import { estQueriesFor, fmtQueries } from '../utils/funding';
import '../styles/funding.css';
import './MyArbiters.css';

const STATUS_LABELS = {
  active: 'Active',
  new: 'New',
  unresponsive: 'Unresponsive',
  blocked: 'Blocked',
  inactive: 'Inactive',
};

const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function MyArbiters() {
  const toast = useToast();
  const { selectedNetwork } = useNetwork();
  const chain = chainForNetwork(selectedNetwork);
  const {
    isConnected,
    address,
    chainId,
    connecting,
    isMetaMaskInstalled,
    connect,
    switchChain,
    getSigner,
  } = useWallet();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(() => new Set());
  const [switching, setSwitching] = useState(false);
  // The arbiter awaiting close-out confirmation ({ operator, job }), or null.
  const [confirmTarget, setConfirmTarget] = useState(null);
  // Fund inputs: per-key amount (keyed by sender address) and per-operator
  // "top up all to" target (keyed by operator address).
  const [keyAmounts, setKeyAmounts] = useState({});
  const [topUpTargets, setTopUpTargets] = useState({});
  const isMountedRef = useRef(true);

  const onCorrectChain = isConnected && chainId === chain.chainId;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiService.getOwnedArbiters(address, selectedNetwork);
      if (!isMountedRef.current) return;
      if (!res.success) throw new Error(res.error || 'Failed to load your arbiters');
      setData(res.data);
    } catch (err) {
      if (isMountedRef.current) setError(err.message || 'Failed to load your arbiters');
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [address, selectedNetwork]);

  // Load owned arbiters only when connected and on the selected chain.
  useEffect(() => {
    if (onCorrectChain && address) {
      load();
    } else {
      setData(null);
      setError(null);
    }
    // chainId/selectedNetwork participate via onCorrectChain + load identity.
  }, [onCorrectChain, address, selectedNetwork, load]);

  // Dismiss the close-out confirmation on Escape (unless a tx is in flight).
  useEffect(() => {
    if (!confirmTarget) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !pending.has(`close:${confirmTarget.job.jobId}`)) {
        setConfirmTarget(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmTarget, pending]);

  const setKeyPending = (key, on) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleConnect = async () => {
    try {
      await connect();
    } catch (err) {
      toast.error(err.message || 'Failed to connect wallet');
    }
  };

  const handleSwitch = async () => {
    setSwitching(true);
    try {
      await switchChain(chain);
    } catch (err) {
      toast.error(err.message || 'Failed to switch network');
    } finally {
      setSwitching(false);
    }
  };

  const handleClaim = async (operator) => {
    const key = `claim:${operator.operator}`;
    setKeyPending(key, true);
    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
      const { txHash } = await claimLink({
        signer,
        operatorAddress: operator.operator,
        recipient: address,
      });
      toast.success(`LINK claimed · tx ${shortHash(txHash)}`);
      await load();
    } catch (err) {
      toast.error(err.message || 'Failed to claim LINK');
    } finally {
      setKeyPending(key, false);
    }
  };

  const handleClose = async (operator, job) => {
    const key = `close:${job.jobId}`;
    setKeyPending(key, true);
    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
      const { txHash } = await deregisterArbiter({
        signer,
        keeperAddress: data.keeperAddress,
        oracle: operator.operator,
        jobId: job.jobId,
      });
      toast.success(`Arbiter closed · 100 wVDKA refunded · tx ${shortHash(txHash)}`);
      await load();
    } catch (err) {
      toast.error(err.message || 'Failed to close out arbiter');
    } finally {
      setKeyPending(key, false);
    }
  };

  // Run the close-out for the arbiter awaiting confirmation, then dismiss the
  // modal (handleClose surfaces success/failure via toast).
  const confirmClose = async () => {
    if (!confirmTarget) return;
    const { operator, job } = confirmTarget;
    await handleClose(operator, job);
    if (isMountedRef.current) setConfirmTarget(null);
  };

  // Send a per-key ETH amount to one sending key, then refresh balances.
  const fundKey = async (address) => {
    const amount = keyAmounts[address];
    const key = `fund:${address}`;
    setKeyPending(key, true);
    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
      const { txHash } = await sendEth({ signer, to: address, amountEth: amount });
      toast.success(`Sent ${amount} ETH to ${shortAddr(address)} · tx ${shortHash(txHash)}`);
      setKeyAmounts((p) => ({ ...p, [address]: '' }));
      await load();
    } catch (err) {
      toast.error(err.message || 'Failed to fund key');
    } finally {
      setKeyPending(key, false);
    }
  };

  // Top every under-funded key up to the operator's target ETH (sequential).
  const topUpAll = async (operator) => {
    const target = Number(topUpTargets[operator.operator]);
    const key = `topup:${operator.operator}`;
    setKeyPending(key, true);
    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
      let funded = 0;
      for (const s of operator.funding.senders) {
        const diff = target - Number(s.balanceEth);
        if (diff > 1e-9) {
          await sendEth({ signer, to: s.address, amountEth: diff.toFixed(18) });
          funded += 1;
        }
      }
      toast.success(funded
        ? `Topped up ${funded} key${funded !== 1 ? 's' : ''} to ${target} ETH`
        : 'All keys already at or above target');
      await load();
    } catch (err) {
      toast.error(err.message || 'Failed to top up keys');
    } finally {
      setKeyPending(key, false);
    }
  };

  const header = (
    <div className="page-header">
      <div className="header-content">
        <h1><Wallet size={28} className="inline-icon" /> My Arbiters</h1>
        <p>Claim earned LINK and close out arbiters on {chain.name}</p>
      </div>
      {onCorrectChain && (
        <div className="header-actions">
          <button onClick={load} className="btn btn-secondary btn-with-icon" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spinning' : ''} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      )}
    </div>
  );

  // --- Gating states -------------------------------------------------------

  if (!isMetaMaskInstalled) {
    return (
      <div className="analytics my-arbiters">
        {header}
        <section className="analytics-section">
          <div className="gate-state">
            <Wallet size={40} />
            <h2>MetaMask required</h2>
            <p>Managing arbiters needs a browser wallet. Install MetaMask to continue.</p>
            <a className="btn btn-primary" href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">
              Install MetaMask <ExternalLink size={14} />
            </a>
          </div>
        </section>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="analytics my-arbiters">
        {header}
        <section className="analytics-section">
          <div className="gate-state">
            <Wallet size={40} />
            <h2>Connect your wallet</h2>
            <p>Connect the wallet that owns your arbiters to claim LINK and reclaim stake.</p>
            <button className="btn btn-primary btn-with-icon" onClick={handleConnect} disabled={connecting}>
              <Wallet size={16} />
              {connecting ? 'Connecting…' : 'Connect Wallet'}
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (!onCorrectChain) {
    return (
      <div className="analytics my-arbiters">
        {header}
        <section className="analytics-section">
          <div className="gate-state">
            <AlertTriangle size={40} className="warn-icon" />
            <h2>Wrong network</h2>
            <p>
              Your wallet is on a different network than the one selected
              ({chain.name}). Switch your wallet to manage arbiters here, or change
              the network selector in the header.
            </p>
            <button className="btn btn-primary btn-with-icon" onClick={handleSwitch} disabled={switching}>
              <Server size={16} />
              {switching ? 'Switching…' : `Switch to ${chain.name}`}
            </button>
          </div>
        </section>
      </div>
    );
  }

  // --- Connected + correct chain ------------------------------------------

  if (loading && !data) {
    return (
      <div className="analytics my-arbiters">
        {header}
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading your arbiters…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="analytics my-arbiters">
        {header}
        <div className="error-container">
          <AlertTriangle size={48} />
          <h2>Failed to Load</h2>
          <p>{error}</p>
          <button onClick={load} className="btn btn-primary"><RefreshCw size={16} /> Try Again</button>
        </div>
      </div>
    );
  }

  const operators = data?.operators || [];

  if (operators.length === 0) {
    return (
      <div className="analytics my-arbiters">
        {header}
        <section className="analytics-section">
          <div className="gate-state">
            <Inbox size={40} />
            <h2>No arbiters found</h2>
            <p>
              The connected wallet (<code>{shortAddr(address)}</code>) doesn&rsquo;t own any
              registered arbiters on {chain.name}.
            </p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="analytics my-arbiters">
      {header}

      {operators.map((operator) => {
        const claimKey = `claim:${operator.operator}`;
        const claiming = pending.has(claimKey);
        const withdrawable = parseFloat(operator.withdrawableLink || '0');
        const canClaim = withdrawable > 0 && !claiming;

        return (
          <section className="analytics-section operator-card" key={operator.operator}>
            <div className="operator-head">
              <div className="operator-title">
                <h2><Server size={20} className="inline-icon" /> Operator</h2>
                <a
                  className="explorer-link"
                  href={`${chain.explorer}/address/${operator.operator}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <code>{shortAddr(operator.operator)}</code> <ExternalLink size={12} />
                </a>
              </div>
              <div className="operator-claim">
                <div className="claim-balance">
                  <Coins size={16} className="inline-icon" />
                  <strong>{operator.withdrawableLink ?? '—'}</strong> LINK claimable
                </div>
                <button
                  className="btn btn-primary btn-with-icon"
                  onClick={() => handleClaim(operator)}
                  disabled={!canClaim}
                  title={withdrawable > 0 ? 'Withdraw earned LINK to your wallet' : 'No LINK available to claim'}
                >
                  <Coins size={14} />
                  {claiming ? 'Claiming…' : 'Claim LINK'}
                </button>
              </div>
            </div>

            {operator.funding && (() => {
              const f = operator.funding;
              const busy = pending.has(`topup:${operator.operator}`)
                || f.senders.some((s) => pending.has(`fund:${s.address}`));
              return (
                <div className={`funding-panel${f.low ? ' low' : ''}`}>
                  <div className="funding-summary">
                    <span className="funding-summary-main">
                      <Fuel size={15} className="inline-icon" />
                      <strong>{Number(f.totalEth).toFixed(4)}</strong> ETH across {f.senders.length} node keys
                      <span className="funding-sep">·</span>
                      <span
                        className="funding-est"
                        title={`Estimate: balance ÷ (${f.gasPerQuery.toLocaleString()} gas/query × ${f.gasPriceGwei} gwei). Changes with gas price.`}
                      >
                        ~{fmtQueries(f.estQueries)} queries of gas
                      </span>
                      {f.low && <span className="funding-low-badge">Low</span>}
                    </span>
                  </div>

                  <div className="fund-topup">
                    <label htmlFor={`topup-${operator.operator}`}>Top up all keys to (ETH each):</label>
                    <input
                      id={`topup-${operator.operator}`}
                      type="number" min="0" step="0.001" placeholder="0.01"
                      value={topUpTargets[operator.operator] || ''}
                      onChange={(e) => setTopUpTargets((p) => ({ ...p, [operator.operator]: e.target.value }))}
                      disabled={busy}
                    />
                    <button
                      className="btn btn-secondary"
                      onClick={() => topUpAll(operator)}
                      disabled={busy || !(Number(topUpTargets[operator.operator]) > 0)}
                    >
                      {pending.has(`topup:${operator.operator}`) ? 'Funding…' : 'Top up all'}
                    </button>
                  </div>

                  <div className="fund-keys">
                    <div className="fund-key fund-key-rw fund-key-head">
                      <span>Sending key</span><span>Balance</span><span>~Queries</span><span></span><span></span>
                    </div>
                    {f.senders.map((s) => {
                      const keyBusy = pending.has(`fund:${s.address}`);
                      return (
                        <div className="fund-key fund-key-rw" key={s.address}>
                          <a className="explorer-link" href={`${chain.explorer}/address/${s.address}`} target="_blank" rel="noopener noreferrer" title={s.address}>
                            <code>{shortAddr(s.address)}</code>
                          </a>
                          <span>{Number(s.balanceEth).toFixed(4)} ETH</span>
                          <span>{fmtQueries(estQueriesFor(s.balanceEth, f))}</span>
                          <input
                            type="number" min="0" step="0.001" placeholder="ETH"
                            value={keyAmounts[s.address] || ''}
                            onChange={(e) => setKeyAmounts((p) => ({ ...p, [s.address]: e.target.value }))}
                            disabled={busy}
                          />
                          <button
                            className="btn btn-secondary"
                            onClick={() => fundKey(s.address)}
                            disabled={busy || !(Number(keyAmounts[s.address]) > 0)}
                          >
                            {keyBusy ? '…' : 'Send'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            <div className="stats-table">
              <table>
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Classes</th>
                    <th>Status</th>
                    <th>Stake</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {operator.jobs.map((job) => {
                    const closeKey = `close:${job.jobId}`;
                    const closing = pending.has(closeKey);
                    const lockedDate = job.lockedUntil
                      ? new Date(job.lockedUntil * 1000).toLocaleString()
                      : null;
                    return (
                      <tr key={job.jobId}>
                        <td><code title={job.jobId}>{shortHash(job.jobId)}</code></td>
                        <td>{job.classes?.join(', ') || '—'}</td>
                        <td>
                          <span className={`status-badge status-${job.status}`}>
                            {STATUS_LABELS[job.status] || job.status}
                          </span>
                        </td>
                        <td>{job.stakeAmount} wVDKA</td>
                        <td className="job-action">
                          {job.locked ? (
                            <span className="locked-note" title={`Locked until ${lockedDate}`}>
                              <Lock size={13} /> Locked until {lockedDate}
                            </span>
                          ) : (
                            <button
                              className="btn btn-danger btn-with-icon"
                              onClick={() => setConfirmTarget({ operator, job })}
                              disabled={closing}
                              title="Deregister this arbiter and reclaim its 100 wVDKA stake"
                            >
                              {closing ? 'Closing…' : 'Close out & reclaim 100 wVDKA'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {confirmTarget && (() => {
        const busy = pending.has(`close:${confirmTarget.job.jobId}`);
        return (
          <div
            className="modal-overlay"
            onClick={() => { if (!busy) setConfirmTarget(null); }}
          >
            <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
              <h3 className="modal-title">
                <AlertTriangle size={18} className="warn-icon" /> Close out this arbiter?
              </h3>
              <p className="modal-body">
                This deregisters the arbiter on-chain and refunds its{' '}
                <strong>{confirmTarget.job.stakeAmount} wVDKA</strong> stake to your wallet. To list
                it again you would have to re-register and re-stake. You will still confirm the
                transaction in your wallet.
              </p>
              <div className="modal-detail">
                <div><span>Operator</span><code>{shortAddr(confirmTarget.operator.operator)}</code></div>
                <div><span>Job ID</span><code>{shortHash(confirmTarget.job.jobId)}</code></div>
              </div>
              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={() => setConfirmTarget(null)} disabled={busy}>
                  Cancel
                </button>
                <button className="btn btn-danger btn-with-icon" onClick={confirmClose} disabled={busy}>
                  {busy ? 'Closing…' : 'Close out & reclaim wVDKA'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
}

export default MyArbiters;
