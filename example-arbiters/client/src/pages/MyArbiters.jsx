/**
 * My Arbiters Page (wallet-gated)
 *
 * Lets an arbiter owner manage the arbiters their connected wallet controls on
 * the header-selected network:
 *  - Claim ETH (per wallet → ReputationAggregator.withdrawEth, from the ethOwed
 *    pull-payment ledger): arbiter earnings, draw / promote rewards and requester
 *    fee refunds. Shown even when the wallet owns no arbiters. A secondary
 *    per-operator "legacy LINK" claim (ArbiterOperator.withdraw) appears only when
 *    LINK lingers from the old aggregator.
 *  - Manage each arbiter (v2 ReputationKeeper, keyed by keyOf(oracle, jobId)):
 *    pause / resume, change the fee, top up the stake, ask for a health call, and
 *    exit in two steps (requestExit, then completeExit after the unbonding period,
 *    which refunds the stake) — optionally registering again later with new
 *    classes (components/ResetArbiterModal)
 *  - Authorize a reporting key so nodes running under a separate ops wallet can
 *    post watchdog health events (signature only, no transaction — see
 *    components/ReportingKeysSection)
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
  RotateCcw,
  Download,
  Pause,
  Play,
  Pencil,
  LogOut,
  Activity,
  Clock,
} from 'lucide-react';
import { useToast } from '../components/Toast';
import { useNetwork } from '../context/NetworkContext';
import { useWallet } from '../context/WalletContext';
import { chainForNetwork } from '../config/chains';
import { apiService } from '../services/api';
import {
  withdrawEth, claimLink, sendEth, completeExit, setPaused, requestHealthCall,
} from '../services/arbiterContracts';
import { getPendingResets, clearPendingReset, markExitCompleted } from '../services/resetRegistry';
import ResetArbiterModal from '../components/ResetArbiterModal';
import ArbiterActionModal from '../components/ArbiterActionModal';
import RegisterArbiterSection from '../components/RegisterArbiterSection';
import ReportingKeysSection from '../components/ReportingKeysSection';
import {
  buildDescriptor, downloadJson, exitView, formatDuration, reasonLines, STATUS_LABELS, FLAG_PAUSED,
} from '../utils/arbiterRegistration';
import { estQueriesFor, fmtQueries } from '../utils/funding';
import '../styles/funding.css';
import './MyArbiters.css';

// A more specific label for the badge, from the first status reason.
const DETAIL_LABELS = {
  banned: 'Banned',
  exiting: 'Exiting',
  paused: 'Paused',
  understaked: 'Under-staked',
  feeAboveMax: 'Fee above max',
  resyncing: 'Frozen (re-syncing)',
};
const badgeLabel = (job) => {
  const first = (job.statusReasons || []).find((r) => DETAIL_LABELS[r]);
  return first ? DETAIL_LABELS[first] : (STATUS_LABELS[job.status] || job.status);
};
const fmtDate = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : '—');
const nowSec = () => Math.floor(Date.now() / 1000);

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
  // In-place action modal: { kind: 'fee'|'topup'|'exit', operator, job }, or null.
  const [actionTarget, setActionTarget] = useState(null);
  // The arbiter in the exit-and-register-again flow ({ oracle, job, keeperAddress? }), or null.
  const [resetTarget, setResetTarget] = useState(null);
  // Planned re-registrations (from localStorage): exit requested or completed, not yet registered again.
  const [pendingResets, setPendingResets] = useState([]);
  // Clock for the unbonding countdowns.
  const [now, setNow] = useState(nowSec);
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

  // Load owned arbiters whenever a wallet is connected. The listing is a
  // server-side read keyed by owner + the header-selected network, so it does
  // NOT depend on which chain the wallet itself is on — only the write actions
  // (claim/close/fund) require the wallet to be on the selected chain.
  useEffect(() => {
    if (address) {
      load();
    } else {
      setData(null);
      setError(null);
    }
  }, [address, selectedNetwork, load]);

  // Refresh the list of interrupted resets (closed out but not yet re-registered)
  // whenever the wallet, network, or listing changes.
  const refreshPendingResets = useCallback(() => {
    setPendingResets(getPendingResets(selectedNetwork, address));
  }, [selectedNetwork, address]);

  useEffect(() => {
    refreshPendingResets();
  }, [refreshPendingResets, data]);

  useEffect(() => {
    const t = setInterval(() => setNow(nowSec()), 30000);
    return () => clearInterval(t);
  }, []);

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

  // Primary claim: withdraw the owner's earned ETH from the aggregator's ethOwed ledger.
  // Per-owner (aggregated across all their operators), not per operator.
  const handleWithdrawEth = async () => {
    const key = 'withdrawEth';
    setKeyPending(key, true);
    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
      const { txHash } = await withdrawEth({
        signer,
        aggregatorAddress: data?.aggregatorAddress,
      });
      toast.success(`ETH claimed · tx ${shortHash(txHash)}`);
      await load();
    } catch (err) {
      toast.error(err.message || 'Failed to claim ETH');
    } finally {
      setKeyPending(key, false);
    }
  };

  // Legacy claim: drain LINK left in an operator contract from the old LINK aggregator.
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
      toast.success(`Legacy LINK claimed · tx ${shortHash(txHash)}`);
      await load();
    } catch (err) {
      toast.error(err.message || 'Failed to claim legacy LINK');
    } finally {
      setKeyPending(key, false);
    }
  };

  // A keeper write for one arbiter, with pending state + toast + reload.
  const arbiterTx = async (pendingKey, fn, okText, failText) => {
    setKeyPending(pendingKey, true);
    try {
      const signer = getSigner();
      if (!signer) throw new Error('Wallet signer unavailable. Reconnect your wallet.');
      const { txHash } = await fn(signer);
      toast.success(`${okText} · tx ${shortHash(txHash)}`);
      await load();
    } catch (err) {
      toast.error(err.message || failText);
    } finally {
      setKeyPending(pendingKey, false);
    }
  };

  const handlePause = (operator, job, paused) => arbiterTx(
    `pause:${job.key}`,
    (signer) => setPaused({ signer, keeperAddress: data.keeperAddress, key: job.key, paused }),
    paused ? 'Arbiter paused' : 'Arbiter resumed',
    paused ? 'Failed to pause' : 'Failed to resume',
  );

  const handleHealthCall = (operator, job) => arbiterTx(
    `health:${job.key}`,
    (signer) => requestHealthCall({ signer, keeperAddress: data.keeperAddress, key: job.key }),
    'Health call sent · the node answers it within a minute if it is running',
    'Failed to request a health call',
  );

  // Second exit step: refund the stake. Keeps any planned re-registration entry
  // (marked as exited) so the banner can offer to register again.
  const handleCompleteExit = (operator, job) => arbiterTx(
    `complete:${job.key}`,
    async (signer) => {
      const r = await completeExit({ signer, keeperAddress: data.keeperAddress, key: job.key });
      const planned = pendingResets.find((e) => e.oracle.toLowerCase() === operator.operator.toLowerCase()
        && e.jobId.toLowerCase() === job.jobId.toLowerCase());
      if (planned) markExitCompleted({ ...planned });
      return r;
    },
    `Exit completed · ${job.stake} wVDKA refunded`,
    'Failed to complete the exit',
  );

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

  // Download a JSON descriptor with everything needed to re-register this
  // arbiter (a backup, and the input to the "Register an arbiter" section).
  const downloadArbiterJson = (operator, job) => {
    const descriptor = buildDescriptor({
      network: selectedNetwork,
      keeperAddress: data?.keeperAddress,
      operator: operator.operator,
      owner: operator.owner,
      jobId: job.jobId,
      fee: job.fee,
      classes: job.classes,
    });
    const shortJob = job.jobId ? job.jobId.slice(2, 10) : 'arbiter';
    downloadJson(`arbiter-${shortJob}.json`, descriptor);
    toast.success('Arbiter backup downloaded');
  };

  const header = (
    <div className="page-header">
      <div className="header-content">
        <h1><Wallet size={28} className="inline-icon" /> My Arbiters</h1>
        <p>Claim ETH, manage, and exit your arbiters on {chain.name}</p>
      </div>
      {isConnected && (
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
            <p>
              Connect the wallet that owns your arbiters to claim earned ETH and manage them, or
              the wallet you requested evaluations from (or drew juries / promoted rounds with) to
              withdraw refunds and rewards.
            </p>
            <button className="btn btn-primary btn-with-icon" onClick={handleConnect} disabled={connecting}>
              <Wallet size={16} />
              {connecting ? 'Connecting…' : 'Connect Wallet'}
            </button>
          </div>
        </section>
      </div>
    );
  }

  // --- Connected (any chain): the listing is a server read ----------------

  // Shown above the listing when the wallet is on a different chain than the
  // selected network: the data still displays, but write actions are disabled
  // until the user switches.
  const wrongChainBanner = !onCorrectChain ? (
    <div className="wrong-chain-banner">
      <AlertTriangle size={16} className="warn-icon" />
      <span>
        Your wallet is on a different network. Switch to <strong>{chain.name}</strong> to claim
        ETH, fund keys, or manage arbiters — you can still view them below.
      </span>
      <button className="btn btn-primary btn-with-icon" onClick={handleSwitch} disabled={switching}>
        <Server size={16} />
        {switching ? 'Switching…' : `Switch to ${chain.name}`}
      </button>
    </div>
  ) : null;

  // Primary, per-wallet ETH claim from the aggregator's ethOwed ledger. Three things credit
  // it: arbiter earnings (base fees + bonuses, aggregated across ALL the owner's operators),
  // draw / promote rewards (paid to whoever calls drawJury or promote on a round), and
  // requester refunds (the unspent part of a request's up-front worst-case fee). All drain
  // through the same withdrawEth(), so this is a single claim — not per operator — and
  // works for wallets that own no arbiters.
  const claimableEth = parseFloat(data?.claimableEth || '0');
  const withdrawingEth = pending.has('withdrawEth');
  const canWithdrawEth = claimableEth > 0 && !withdrawingEth && onCorrectChain;
  const ethClaimPanel = (hasArbiters) => (
    <section className="analytics-section eth-claim-panel">
      <div className="operator-claim">
        <div className="claim-balance">
          <Coins size={16} className="inline-icon" />
          <strong>{data?.claimableEth ?? '—'}</strong> ETH claimable
        </div>
        <button
          className="btn btn-primary btn-with-icon"
          onClick={handleWithdrawEth}
          disabled={!canWithdrawEth}
          title={!onCorrectChain
            ? `Switch to ${chain.name} to claim`
            : claimableEth > 0 ? 'Withdraw your claimable ETH to your wallet' : 'No ETH available to claim'}
        >
          <Coins size={14} />
          {withdrawingEth ? 'Withdrawing…' : 'Withdraw ETH'}
        </button>
      </div>
      {hasArbiters ? (
        <p className="claim-note muted">
          Includes your arbiter earnings (base fees and bonuses, which accrue per owner across all
          your operators), any draw or promote rewards this wallet earned by calling drawJury or
          promote on a round, and refunds of unused fees from evaluations it requested. Unwithdrawn
          ETH stays credited on the aggregator and can be claimed any time.
        </p>
      ) : (
        <div className="claim-note muted">
          <p>
            You don&rsquo;t need to run an arbiter to have ETH here. When this wallet requests an
            evaluation (for example from the Verdikta Playground), it prepays the most the request
            could cost: every polled arbiter&rsquo;s maximum fee plus the largest possible bonus.
            Arbiters usually charge less, and bonuses only go to the arbiters whose answers agree,
            so once the request finishes the unspent ETH is credited back to this wallet on the
            Verdikta aggregator. Calling drawJury or promote on a round (anyone may, after a short
            priority window for the requester) also earns a reward that is credited here.
          </p>
          <p>
            That credit is not sent back automatically. Withdraw it here to move it to your wallet,
            or leave it and it will pay toward your next request.
            {claimableEth === 0 && data?.claimableEth != null && (
              <> This wallet has nothing to withdraw on {chain.name} right now.</>
            )}
          </p>
        </div>
      )}
      {data?.claimableEth == null && (
        <p className="claim-note muted">
          Couldn&rsquo;t read your balance from the aggregator. Use Refresh to try again.
        </p>
      )}
    </section>
  );

  // Planned re-registrations (exit requested, or completed, but not registered
  // again). An arbiter whose exit completed has left the listing, so this banner is
  // the only on-page trace of it. Entries whose arbiter is still listed (still
  // unbonding) are handled on its row instead.
  const dismissReset = (entry) => {
    clearPendingReset({ network: selectedNetwork, oracle: entry.oracle, jobId: entry.jobId });
    refreshPendingResets();
  };
  const listedIds = new Set((data?.operators || []).flatMap((op) =>
    op.jobs.map((j) => `${op.operator.toLowerCase()}|${j.jobId.toLowerCase()}`)));
  const exitedResets = pendingResets.filter((e) => !listedIds.has(`${e.oracle.toLowerCase()}|${e.jobId.toLowerCase()}`));

  const resumeBanner = exitedResets.length > 0 ? (
    <div className="resume-resets">
      {exitedResets.map((entry) => (
        <div className="resume-reset-banner" key={`${entry.oracle}:${entry.jobId}`}>
          <AlertTriangle size={16} className="warn-icon" />
          <span>
            Arbiter <code>{shortHash(entry.jobId)}</code> on operator{' '}
            <code>{shortAddr(entry.oracle)}</code> has exited but is{' '}
            <strong>not registered again</strong> (planned classes{' '}
            {(entry.classes || []).join(', ') || '—'}). Register it to bring it back with its
            previous scores.
          </span>
          <button
            className="btn btn-warning btn-with-icon"
            onClick={() => setResetTarget({
              oracle: entry.oracle,
              keeperAddress: entry.keeperAddress,
              job: { jobId: entry.jobId, fee: entry.fee, classes: entry.classes },
            })}
            disabled={!onCorrectChain}
            title={!onCorrectChain ? `Switch to ${chain.name} to register` : undefined}
          >
            <RefreshCw size={14} /> Register again
          </button>
          <button className="btn btn-secondary" onClick={() => dismissReset(entry)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  ) : null;

  const registerSection = data?.keeperAddress ? (
    <RegisterArbiterSection
      keeperAddress={data.keeperAddress}
      stakeRequirement={data.stakeRequirement}
      network={selectedNetwork}
      owner={address}
      chain={chain}
      onCorrectChain={onCorrectChain}
      getSigner={getSigner}
      toast={toast}
      onComplete={() => { load(); refreshPendingResets(); }}
    />
  ) : null;

  // Reporting-key delegations. Only meaningful once the wallet owns something
  // (the server requires a registered operator before accepting a delegation),
  // so it renders alongside the operator cards, not in the empty state.
  const reportingKeysSection = (
    <ReportingKeysSection
      network={selectedNetwork}
      owner={address}
      chain={chain}
      getSigner={getSigner}
      toast={toast}
    />
  );

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
        {wrongChainBanner}
        {resumeBanner}
        {ethClaimPanel(false)}
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
        {registerSection}
      </div>
    );
  }

  return (
    <div className="analytics my-arbiters">
      {header}
      {wrongChainBanner}
      {resumeBanner}
      {ethClaimPanel(true)}

      {operators.map((operator) => {
        const claimKey = `claim:${operator.operator}`;
        const claiming = pending.has(claimKey);
        // Legacy LINK left over from the old aggregator; normally 0 under 0-juel dispatch.
        const withdrawable = parseFloat(operator.withdrawableLink || '0');
        const canClaim = withdrawable > 0 && !claiming && onCorrectChain;

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
              {withdrawable > 0 && (
                <div className="operator-claim legacy-link-claim">
                  <div className="claim-balance">
                    <Coins size={16} className="inline-icon" />
                    <strong>{operator.withdrawableLink}</strong> legacy LINK
                  </div>
                  <button
                    className="btn btn-secondary btn-with-icon"
                    onClick={() => handleClaim(operator)}
                    disabled={!canClaim}
                    title={!onCorrectChain
                      ? `Switch to ${chain.name} to claim`
                      : 'Drain leftover LINK from the old aggregator to your wallet'}
                  >
                    <Coins size={14} />
                    {claiming ? 'Claiming…' : 'Claim legacy LINK'}
                  </button>
                </div>
              )}
            </div>

            {operator.funding && (() => {
              const f = operator.funding;
              const busy = pending.has(`topup:${operator.operator}`)
                || f.senders.some((s) => pending.has(`fund:${s.address}`));
              return (
                <div className={`funding-panel${f.low ? ' low' : ''}`}>
                  <h3 className="subtable-title">Node Key Funding</h3>
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
                      disabled={busy || !(Number(topUpTargets[operator.operator]) > 0) || !onCorrectChain}
                      title={!onCorrectChain ? `Switch to ${chain.name} to fund` : undefined}
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
                            disabled={busy || !(Number(keyAmounts[s.address]) > 0) || !onCorrectChain}
                            title={!onCorrectChain ? `Switch to ${chain.name} to fund` : undefined}
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
              <h3 className="subtable-title">Registered Arbiters</h3>
              <table>
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Classes</th>
                    <th>Fee</th>
                    <th>Status</th>
                    <th>Sending key</th>
                    <th>Stake</th>
                    <th>Reputation</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {operator.jobs.map((job) => {
                    const ex = exitView(job, now);
                    const exiting = ex.state !== 'none';
                    const banned = (job.statusReasons || []).includes('banned');
                    const paused = (job.flags & FLAG_PAUSED) !== 0;
                    const frozen = (job.statusReasons || []).some((r) => r === 'frozen' || r === 'resyncing');
                    const busy = ['pause', 'health', 'complete'].some((k) => pending.has(`${k}:${job.key}`));
                    const planned = pendingResets.find((e) => e.oracle.toLowerCase() === operator.operator.toLowerCase()
                      && e.jobId.toLowerCase() === job.jobId.toLowerCase());
                    const noChain = !onCorrectChain ? `Switch to ${chain.name} first` : undefined;
                    const why = reasonLines(job.statusReasons);
                    // The per-arbiter sending key isn't on-chain (it lives in
                    // the node's job spec). The server derives it by scanning
                    // OracleResponse fulfillment txs for this jobId via the
                    // archive RPC; null when the arbiter has never been used.
                    return (
                      <tr key={job.jobId}>
                        <td><code title={job.jobId}>{shortHash(job.jobId)}</code></td>
                        <td>
                          {job.classes?.length ? (
                            <div className="job-classes">
                              {job.classes.map((c) => (
                                <span key={c}>{c}</span>
                              ))}
                            </div>
                          ) : '—'}
                        </td>
                        <td className="nowrap">{job.fee != null ? job.fee : '—'}</td>
                        <td>
                          <span className={`status-badge status-${job.status}`} title={why.join('\n')}>
                            {badgeLabel(job)}
                          </span>
                          {(job.statusReasons || []).includes('resyncing') && (
                            <div className="status-note">Not selectable until its node&rsquo;s health job re-syncs (automatic once the node runs).</div>
                          )}
                          {(job.statusReasons || []).includes('blocked') && job.blockedUntil > now && (
                            <div className="status-note">Blocked until {fmtDate(job.blockedUntil)}</div>
                          )}
                        </td>
                        <td>
                          {job.sender ? (
                            <a
                              className="explorer-link"
                              href={`${chain.explorer}/address/${job.sender}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={job.sender}
                            >
                              <code>{shortAddr(job.sender)}</code>
                            </a>
                          ) : (
                            <span
                              className="muted"
                              title="No fulfillment history found in the recent archive window — never used, or last used outside the scan range."
                            >—</span>
                          )}
                        </td>
                        <td className="nowrap">
                          {job.stake} wVDKA
                          {job.understakedBy && (
                            <div
                              className="status-note"
                              title={job.understakedUnflagged
                                ? 'The keeper only updates its under-staked flag when the stake changes, so this arbiter is still selected against the raised requirement until its next top-up or burn.'
                                : undefined}
                            >
                              {job.understakedBy} short{job.understakedUnflagged ? ' (still selected until the stake changes)' : ''}
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="job-stats">
                            <span><span className="job-stat-label">Quality</span> {job.qualityScore ?? '—'}</span>
                            <span><span className="job-stat-label">Timeliness</span> {job.timelinessScore ?? '—'}</span>
                            <span><span className="job-stat-label">Offenses</span> {job.offenses ?? '—'}</span>
                          </div>
                        </td>
                        <td className="job-action">
                          <div className="job-action-buttons">
                            {exiting ? (
                              <>
                                {ex.state === 'unbonding' && (
                                  <span className="locked-note" title={`Complete the exit after ${fmtDate(job.exitAt)}`}>
                                    <Clock size={13} /> Unbonding · {formatDuration(ex.waitSeconds)} left
                                  </span>
                                )}
                                {ex.state === 'blocked' && (
                                  <span className="locked-note" title={`Blocked until ${fmtDate(job.blockedUntil)}`}>
                                    <Lock size={13} /> Blocked · exit in {formatDuration(ex.waitSeconds)}
                                  </span>
                                )}
                                {ex.state === 'ready' && (planned ? (
                                  <button
                                    className="btn btn-warning btn-with-icon"
                                    onClick={() => setResetTarget({ oracle: operator.operator, job: { ...job, fee: planned.fee, classes: planned.classes } })}
                                    disabled={!onCorrectChain}
                                    title={noChain || 'Complete the exit (refunds the stake), then register again with the planned fee and classes'}
                                  >
                                    <RotateCcw size={14} /> Complete exit &amp; register again
                                  </button>
                                ) : (
                                  <button
                                    className="btn btn-danger btn-with-icon"
                                    onClick={() => handleCompleteExit(operator, job)}
                                    disabled={busy || !onCorrectChain}
                                    title={noChain || 'Finish the exit and refund the stake to your wallet'}
                                  >
                                    <LogOut size={14} />
                                    {pending.has(`complete:${job.key}`) ? 'Completing…' : `Complete exit & reclaim ${job.stake} wVDKA`}
                                  </button>
                                ))}
                                {planned && ex.state !== 'ready' && (
                                  <span className="muted" title="Planned in this browser when the exit was requested">
                                    Then register again with classes {(planned.classes || []).join(', ')}
                                  </span>
                                )}
                              </>
                            ) : !banned && (
                              <>
                                <button
                                  className="btn btn-secondary btn-with-icon"
                                  onClick={() => handlePause(operator, job, !paused)}
                                  disabled={busy || !onCorrectChain}
                                  title={noChain || (paused ? 'Make the arbiter selectable again' : 'Stop the arbiter being selected (keeps it registered)')}
                                >
                                  {paused ? <Play size={13} /> : <Pause size={13} />}
                                  {pending.has(`pause:${job.key}`) ? '…' : paused ? 'Resume' : 'Pause'}
                                </button>
                                <button
                                  className="btn btn-secondary btn-with-icon"
                                  onClick={() => setActionTarget({ kind: 'fee', operator, job })}
                                  disabled={busy || !onCorrectChain}
                                  title={noChain || 'Change the posted fee (no exit needed)'}
                                >
                                  <Pencil size={13} /> Change fee
                                </button>
                                {job.understakedBy && (
                                  <button
                                    className="btn btn-primary btn-with-icon"
                                    onClick={() => setActionTarget({ kind: 'topup', operator, job })}
                                    disabled={busy || !onCorrectChain}
                                    title={noChain || 'Bring the stake back up to the requirement'}
                                  >
                                    <Coins size={13} /> Top up stake
                                  </button>
                                )}
                                {frozen && (
                                  <button
                                    className="btn btn-secondary btn-with-icon"
                                    onClick={() => handleHealthCall(operator, job)}
                                    disabled={busy || !onCorrectChain}
                                    title={noChain || 'Ask the keeper for a health call; a running node answers it and is unfrozen'}
                                  >
                                    <Activity size={13} /> {pending.has(`health:${job.key}`) ? '…' : 'Send health call'}
                                  </button>
                                )}
                                <button
                                  className="btn btn-warning btn-with-icon"
                                  onClick={() => setResetTarget({ oracle: operator.operator, job })}
                                  disabled={busy || !onCorrectChain}
                                  title={noChain || 'Exit now and register again after the unbonding period, e.g. with new classes; scores carry over'}
                                >
                                  <RotateCcw size={14} /> Exit &amp; register again
                                </button>
                                <button
                                  className="btn btn-danger btn-with-icon"
                                  onClick={() => setActionTarget({ kind: 'exit', operator, job })}
                                  disabled={busy || !onCorrectChain}
                                  title={noChain || `Request the exit; the ${job.stake} wVDKA stake is refunded when you complete it after the unbonding period`}
                                >
                                  <LogOut size={14} /> Exit
                                </button>
                              </>
                            )}
                            {banned && !exiting && (
                              <button
                                className="btn btn-danger btn-with-icon"
                                onClick={() => setActionTarget({ kind: 'exit', operator, job })}
                                disabled={busy || !onCorrectChain}
                                title={noChain || 'A banned arbiter can only exit (recovering what is left of its stake)'}
                              >
                                <LogOut size={14} /> Exit
                              </button>
                            )}
                            <button
                              className="btn btn-secondary btn-with-icon"
                              onClick={() => downloadArbiterJson(operator, job)}
                              title="Download a JSON backup with everything needed to register this arbiter again"
                            >
                              <Download size={13} /> Backup JSON
                            </button>
                          </div>
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

      {reportingKeysSection}
      {registerSection}

      {actionTarget && (
        <ArbiterActionModal
          kind={actionTarget.kind}
          operator={actionTarget.operator}
          job={actionTarget.job}
          keeperAddress={data?.keeperAddress}
          owner={address}
          maxOracleFee={data?.maxOracleFee}
          unbondingPeriodSeconds={data?.unbondingPeriodSeconds}
          getSigner={getSigner}
          toast={toast}
          onClose={() => setActionTarget(null)}
          onDone={() => { setActionTarget(null); load(); }}
        />
      )}

      {resetTarget && (
        <ResetArbiterModal
          oracle={resetTarget.oracle}
          jobId={resetTarget.job.jobId}
          fee={resetTarget.job.fee}
          classes={resetTarget.job.classes}
          keeperAddress={resetTarget.keeperAddress || data?.keeperAddress}
          network={selectedNetwork}
          owner={address}
          chain={chain}
          getSigner={getSigner}
          toast={toast}
          onClose={() => { setResetTarget(null); refreshPendingResets(); }}
          onComplete={() => { setResetTarget(null); load(); refreshPendingResets(); }}
        />
      )}

    </div>
  );
}

export default MyArbiters;
