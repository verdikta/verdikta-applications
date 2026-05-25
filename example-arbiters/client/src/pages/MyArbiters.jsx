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
} from 'lucide-react';
import { useToast } from '../components/Toast';
import { useNetwork } from '../context/NetworkContext';
import { useWallet } from '../context/WalletContext';
import { chainForNetwork } from '../config/chains';
import { apiService } from '../services/api';
import { claimLink, deregisterArbiter } from '../services/arbiterContracts';
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
                              onClick={() => handleClose(operator, job)}
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
    </div>
  );
}

export default MyArbiters;
