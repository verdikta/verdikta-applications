/**
 * Contracts Page
 * Read-only reference for the core Verdikta v2 contracts: the ReputationAggregator,
 * the ReputationKeeper, and the wVDKA staking token. Shows what each contract
 * does, a block-explorer link, its address, and live on-chain configuration.
 *
 * The network (Base mainnet / Base Sepolia) is selected globally in the Header
 * and read here via useNetwork(); changing it re-runs the data load.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FileText,
  RefreshCw,
  AlertTriangle,
  Clock,
  ExternalLink,
  Layers,
  Database,
  Coins
} from 'lucide-react';
import { useToast } from '../components/Toast';
import { useNetwork } from '../context/NetworkContext';
import { apiService } from '../services/api';
import './Contracts.css';

// Concise plain-language descriptions of each contract's role.
const DESCRIPTIONS = {
  aggregator:
    'Runs each evaluation in two phases. One aggregator serves every jury size: each request ' +
    'carries its own jury (K, M, N, P and the round timeout), within the owner’s limits below. ' +
    'A request escrows the fees; from two blocks later anyone can draw the jury (K arbiters, ' +
    'chosen by reputation from the keeper’s state at the request block; with fewer eligible, ' +
    'the jury repeats arbiters). The commit phase closes at M+ commits, or after T+ with at least M; ' +
    'M commits are promoted to reveal, and the N-th reveal finalizes the verdict. The P ' +
    'closest reveals earn the bonus. Late reveals are still scored, and settlement after the ' +
    'deadline reports every slot’s outcome to the keeper.',
  keeper:
    'The on-chain registry of arbiters, keyed by (operator, Job ID). It holds each ' +
    'arbiter’s stake, classes, fee, and two scores (quality and timeliness). A score that ' +
    'reaches 0 blocks the arbiter, the maximum number of offenses bans it, and an unanswered ' +
    'health call freezes it until it answers. Exits take two steps: a request, then ' +
    'completion after the unbonding period, which refunds the stake.',
  wvdka:
    'The staking token arbiters bond to register with the Reputation Keeper. The stake is ' +
    'held while the arbiter is registered and through the unbonding period after it asks to ' +
    'exit, so penalties for its last rounds can still apply.'
};

// Format a duration in seconds as a compact human string (e.g. 86400 -> "24h").
const formatDuration = (s) => {
  if (s == null) return null;
  if (s >= 86400 && s % 3600 === 0) return `${+(s / 86400).toFixed(s % 86400 ? 1 : 0)}d`;
  if (s >= 3600) return `${+(s / 3600).toFixed(s % 3600 ? 1 : 0)}h`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${s}s`;
};

// Format a token amount string ("100.0") as "100 wVDKA".
const fmtToken = (v) => (v == null ? null : `${Number(v)} wVDKA`);
const fmtSigned = (n) => (n == null ? '—' : n > 0 ? `+${n}` : `${n}`);
const deltaColor = (n) => (n == null ? 'var(--text-secondary)' : n > 0 ? '#16a34a' : n < 0 ? '#dc2626' : 'var(--text-secondary)');

// Table 1 of the keeper: how each slot outcome moves the two scores. `t` and `q`
// pick the timeliness / quality change from the keeper's points() (null = no change).
const POINT_ROWS = [
  { label: 'Promoted, revealed', desc: 'Revealed after promotion (even late).', t: (p) => p.gain, q: null },
  { label: '… and close', desc: 'Within 1.5 × the spread of the median of the counted reveals (the spread is 1.4826 × the median distance from that median, at least the aggregator\'s spread floor; for a vector, the largest coordinate distance).', t: null, q: (p) => p.gain },
  { label: '… and off', desc: 'More than 1.5 × and at most 3 × the spread from the median of the counted reveals.', t: null, q: (p) => -p.minor },
  { label: '… and far', desc: 'More than 3 × the spread from the median of the counted reveals.', t: null, q: (p) => -p.major },
  { label: 'Promoted, no reveal (round finished)', desc: 'Asked to reveal and never did; the round finished anyway.', t: (p) => -p.major, q: null },
  { label: 'Promoted, no reveal (round failed)', desc: 'Asked to reveal and never did; the round failed for lack of reveals.', t: (p) => -p.fail, q: null },
  { label: 'No commit (round failed)', desc: 'Drawn but never committed, and the round failed for lack of commits.', t: (p) => -p.nocommit, q: null },
];
// Render an address with a copyable code block and a block-explorer link.
function AddressRow({ label, address, explorer }) {
  if (!address) return null;
  return (
    <div className="contract-row">
      {label && <span className="contract-label">{label}</span>}
      <div className="address-line">
        <code className="address">{address}</code>
        {explorer && (
          <a
            className="explorer-link"
            href={`${explorer}/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            BaseScan <ExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  );
}

// A single labelled config metric (reuses Analytics' .config-item styles).
// An optional title shows an explanatory tooltip on hover.
function ConfigItem({ label, value, title }) {
  return (
    <div className="config-item" title={title} style={title ? { cursor: 'help' } : undefined}>
      <span className="config-label">{label}</span>
      <span className="config-value">{value ?? '—'}</span>
    </div>
  );
}

function Contracts() {
  const toast = useToast();
  const { selectedNetwork } = useNetwork();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const isMountedRef = useRef(true);
  // Tracks the most recently requested network so a slow response for a network
  // the user has since switched away from is ignored.
  const requestedNetworkRef = useRef(selectedNetwork);

  const loadContracts = useCallback(async (network, silent = false) => {
    if (!isMountedRef.current) return;
    requestedNetworkRef.current = network;

    try {
      if (!silent) setLoading(true);
      setError(null);

      const result = await apiService.getContractsOverview(network);

      if (!isMountedRef.current || network !== requestedNetworkRef.current) return;
      if (result.success) {
        setData(result.data);
        setLastUpdated(new Date());
      } else {
        throw new Error(result.error || 'Failed to load contracts');
      }
    } catch (err) {
      if (isMountedRef.current && network === requestedNetworkRef.current) {
        console.error('Error loading contracts:', err);
        setError(err.message || 'Failed to load contracts');
        if (!silent) toast.error('Failed to load contract data');
      }
    } finally {
      if (isMountedRef.current && network === requestedNetworkRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [toast]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await apiService.refreshContracts(selectedNetwork);
      await loadContracts(selectedNetwork, true);
      toast.success('Contracts refreshed');
    } catch {
      toast.error('Failed to refresh contracts');
      setRefreshing(false);
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // (Re)load whenever the globally-selected network changes.
  useEffect(() => {
    setData(null);
    loadContracts(selectedNetwork);
  }, [selectedNetwork, loadContracts]);

  const formatTimeAgo = (date) => {
    if (!date) return 'Never';
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  const header = (
    <div className="page-header">
      <div className="header-content">
        <h1><FileText size={28} className="inline-icon" /> Contracts</h1>
        <p>Core Verdikta contracts &mdash; what they do and how they&rsquo;re configured</p>
      </div>
      <div className="header-actions">
        {!loading && !error && (
          <span className="last-updated">
            <Clock size={14} /> Updated {formatTimeAgo(lastUpdated)}
          </span>
        )}
        {!loading && !error && (
          <button
            onClick={handleRefresh}
            className="btn btn-secondary btn-with-icon"
            disabled={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? 'spinning' : ''} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        )}
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="analytics contracts">
        {header}
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading contracts...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="analytics contracts">
        {header}
        <div className="error-container">
          <AlertTriangle size={48} />
          <h2>Failed to Load Contracts</h2>
          <p>{error}</p>
          <button onClick={() => loadContracts(selectedNetwork)} className="btn btn-primary">
            <RefreshCw size={16} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  const explorer = data?.explorer;
  const c = data?.contracts;

  if (!data?.healthy || !c) {
    return (
      <div className="analytics contracts">
        {header}
        <section className="analytics-section">
          <div className="info-banner">
            <AlertTriangle size={16} />
            <span>{data?.error || `Could not reach the contracts on ${data?.networkName || selectedNetwork}`}</span>
          </div>
        </section>
      </div>
    );
  }

  const agg = c.aggregator;
  const keeper = c.keeper;
  const wvdka = c.wvdka;

  return (
    <div className="analytics contracts">
      {header}

      {/* ReputationAggregator */}
      <section className="analytics-section">
        <div className="contract-title">
          <h2><Layers size={20} className="inline-icon" /> Reputation Aggregator</h2>
          {agg?.address && explorer && (
            <a
              className="explorer-link"
              href={`${explorer}/address/${agg.address}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on BaseScan <ExternalLink size={14} />
            </a>
          )}
        </div>
        <p className="contract-description">{DESCRIPTIONS.aggregator}</p>
        <div className="section-content">
          <div className="contract-addresses">
            <AddressRow label="Address" address={agg?.address} explorer={explorer} />
          </div>

          {agg?.config && (
            <div className="config-grid">
              <ConfigItem label="Jury" value="Per request" title="Each request sets its own jury: K drawn, M commits needed (and promoted), N reveals to finalize, P in the cluster, and the round timeout from the draw. The commit phase closes at once at M+ = M + ceil((K − M) / 2) commits. A request is refused (BadJury) unless K ≥ M ≥ N ≥ P ≥ 1, N ≤ 40, P ≥ 2 unless N = 1, K ≤ Max Jury and the keeper's shortlist, and T+ < timeout ≤ Max Timeout" />
              <ConfigItem label="Max Jury (K)" value={agg.config.maxJury} title="maxJury(): the largest K a request may ask for (also capped by the keeper's shortlist size)" />
              <ConfigItem label="Max Timeout" value={formatDuration(agg.config.maxTimeout)} title="maxTimeout(): the longest round timeout a request may ask for (from the draw to the round deadline; settlement is due after it)" />
              <ConfigItem label="Bonus Multiplier" value={agg.config.bonusMultiplier != null ? `${agg.config.bonusMultiplier}x` : null} />
              <ConfigItem label="Commit Window (T+)" value={formatDuration(agg.config.tPlus)} title="After this, M commits are enough to close the commit phase. A request's timeout must exceed it" />
              <ConfigItem label="Reveal Window" value={formatDuration(agg.config.revealWindow)} title="Reveal time guaranteed to promoted arbiters after promotion" />
              <ConfigItem label="Max Oracle Fee" value={agg.config.maxOracleFee != null ? `${agg.config.maxOracleFee} ETH` : null} title="Fee ceiling: arbiters posting more are never drawn" />
              <ConfigItem label="Draw Reward" value={agg.config.drawRewardFees != null ? `${agg.config.drawRewardFees} × fee ceiling` : null} title="× the request's fee ceiling (min(maxFee, maxOracleFee)), not an arbiter's fee. Paid into ethOwed to whoever draws the jury (only the requester during the priority window)" />
              <ConfigItem label="Promote Reward" value={agg.config.promoteRewardFees != null ? `${agg.config.promoteRewardFees} × fee ceiling` : null} title="× the request's fee ceiling (min(maxFee, maxOracleFee)), not an arbiter's fee. Paid into ethOwed to whoever calls promote" />
              <ConfigItem label="Requester Draw Priority" value={formatDuration(agg.config.requesterDrawPriority)} />
              <ConfigItem label="Spread Floor" value={agg.config.spreadFloor != null ? agg.config.spreadFloor.toLocaleString() : null} title="Minimum quality spread on the arbiters' 0..1,000,000 scale: a reveal is close within 1.5 × the spread of the median, off within 3 ×, far beyond" />
              <ConfigItem label="Rounds So Far" value={agg.config.roundCount != null ? agg.config.roundCount.toLocaleString() : null} title="roundCount(): rounds requested on this aggregator; aggIds are sequential" />
              <ConfigItem label="Beacons" value={agg.config.beacons ? 'On' : 'Off'} title="JuryBeacons contract for beacon-seeded draws (per-request flag)" />
              {agg.config.paused && <ConfigItem label="Status" value="Paused" />}
            </div>
          )}

          <div className="contract-addresses">
            <AddressRow label="Treasury" address={agg?.config?.treasury} explorer={explorer} />
            <AddressRow label="Jury Beacons" address={agg?.config?.beacons} explorer={explorer} />
            <AddressRow label="Transport Token (0-juel rail)" address={agg?.transportTokenAddress} explorer={explorer} />
          </div>
        </div>
      </section>

      {/* ReputationKeeper */}
      <section className="analytics-section">
        <div className="contract-title">
          <h2><Database size={20} className="inline-icon" /> Reputation Keeper</h2>
          {keeper?.address && explorer && (
            <a
              className="explorer-link"
              href={`${explorer}/address/${keeper.address}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on BaseScan <ExternalLink size={14} />
            </a>
          )}
        </div>
        <p className="contract-description">{DESCRIPTIONS.keeper}</p>
        <div className="section-content">
          <div className="contract-addresses">
            <AddressRow label="Address" address={keeper?.address} explorer={explorer} />
          </div>

          <div className="config-grid">
            <ConfigItem label="Registered Arbiters" value={keeper?.registeredArbiters} title="Live keys, rebuilt from the keeper's registration and removal events" />
            <ConfigItem
              label="Required Stake"
              value={fmtToken(keeper?.config?.stakeRequirement)}
              title="wVDKA an arbiter must stake to register (stakeRequirement)"
            />
            <ConfigItem
              label="Unbonding Period"
              value={formatDuration(keeper?.config?.unbondingPeriodSeconds)}
              title="Time between requestExit and completeExit, when the stake is refunded"
            />
            <ConfigItem
              label="Health Call Deadline"
              value={formatDuration(keeper?.config?.callDeadlineSeconds)}
              title="An arbiter that has not answered a health call within this is frozen until it answers"
            />
            <ConfigItem
              label="Block Duration"
              value={formatDuration(keeper?.config?.lockDurationSeconds)}
              title="How long an arbiter is blocked when a score reaches 0, doubled per earlier offense"
            />
            <ConfigItem
              label="Offense Decay"
              value={formatDuration(keeper?.config?.decayPeriodSeconds)}
              title="One offense is forgiven per this many clean days"
            />
            <ConfigItem
              label="Max Offenses"
              value={keeper?.config?.maxOffenses}
              title="The block that reaches this many offenses is a permanent ban"
            />
            <ConfigItem
              label="Burn per Block"
              value={fmtToken(keeper?.config?.burnPerBlock)}
              title="wVDKA burned from the stake on a block, doubled per earlier offense"
            />
            <ConfigItem label="Burn on Ban" value={keeper?.config?.burnOnBan == null ? null : keeper.config.burnOnBan ? 'Whole stake' : 'No'} />
            <ConfigItem
              label="Shortlist Size"
              value={keeper?.config?.shortlistSize}
              title="Eligible arbiters collected per draw before the weighted pick"
            />
            <ConfigItem label="Max Scan" value={keeper?.config?.maxScan} title="Bound on class-list entries walked per draw" />
            <ConfigItem label="Random Health Calls" value={keeper?.config?.liveRandom} title="Extra shortlisted arbiters sent a health call per draw" />
            <ConfigItem label="Starting Score" value={keeper?.config?.points?.start} title="Both scores start here (0..cap)" />
            <ConfigItem label="Score Cap" value={keeper?.config?.points?.cap} />
          </div>

          {keeper?.config?.points && (
            <div className="stats-table">
              <h3 className="table-title">Reputation Points per Round</h3>
              <table>
                <thead>
                  <tr>
                    <th>Slot outcome (settlement)</th>
                    <th className="tooltip-header" title="Change applied to the arbiter's timeliness score">&Delta; Timeliness</th>
                    <th className="tooltip-header" title="Change applied to the arbiter's quality score">&Delta; Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {POINT_ROWS.map((r) => {
                    const t = r.t ? r.t(keeper.config.points) : null;
                    const q = r.q ? r.q(keeper.config.points) : null;
                    return (
                      <tr key={r.label}>
                        <td className="tooltip-header" title={r.desc}>{r.label}</td>
                        <td style={{ color: deltaColor(t), fontWeight: 600 }}>{fmtSigned(t)}</td>
                        <td style={{ color: deltaColor(q), fontWeight: 600 }}>{fmtSigned(q)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="table-note">
                Close, off and far are measured from the median of the counted reveals: close at most 1.5 × the
                spread, off at most 3 ×, far beyond, where the spread is 1.4826 × the median distance from the
                median, floored at the aggregator&rsquo;s spread floor. A late reveal is classified against the same
                median and spread.
                A score that reaches 0 blocks the arbiter and restarts at {keeper.config.points.start}.
                An arbiter frozen at the round deadline is not scored unless it committed in that round.
              </p>
            </div>
          )}

          <div className="contract-addresses">
            <AddressRow label="Staking Token (wVDKA)" address={keeper?.verdiktaTokenAddress} explorer={explorer} />
          </div>
        </div>
      </section>

      {/* wVDKA Token */}
      {wvdka && (
        <section className="analytics-section">
          <div className="contract-title">
            <h2><Coins size={20} className="inline-icon" /> wVDKA Token{wvdka.symbol ? ` (${wvdka.symbol})` : ''}</h2>
            {wvdka.address && explorer && (
              <a
                className="explorer-link"
                href={`${explorer}/token/${wvdka.address}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on BaseScan <ExternalLink size={14} />
              </a>
            )}
          </div>
          <p className="contract-description">{DESCRIPTIONS.wvdka}</p>
          <div className="section-content">
            <div className="contract-addresses">
              <AddressRow label="Address" address={wvdka.address} explorer={explorer} />
            </div>
            <div className="config-grid">
              {wvdka.name && <ConfigItem label="Name" value={wvdka.name} />}
              <ConfigItem label="Symbol" value={wvdka.symbol} />
              <ConfigItem label="Decimals" value={wvdka.decimals} />
              {wvdka.totalSupply != null && (
                <ConfigItem
                  label="Total Supply"
                  value={Number(wvdka.totalSupply).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                />
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export default Contracts;
