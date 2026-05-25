/**
 * Contracts Page
 * Read-only reference for the core Verdikta contracts: the ReputationAggregator,
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
    'Orchestrates each evaluation: it selects a panel of registered arbiter oracles, ' +
    'collects their commit-and-reveal responses, and aggregates them into a single ' +
    'verdict. The parameters below control how many oracles are polled and how many ' +
    'must respond.',
  keeper:
    'The on-chain registry of arbiter oracles. It records each oracle’s stake, ' +
    'supported classes, and running quality/timeliness scores, and blocks oracles whose ' +
    'scores fall below the thresholds below.',
  wvdka:
    'The staking token oracles bond to register with the Reputation Keeper. Stakes are ' +
    'locked or slashed based on performance, aligning oracle incentives with honest, ' +
    'timely responses.'
};

// A bytes32 of all zeros means "unset" — don't surface it as a real value.
const isZeroHash = (v) => !v || /^0x0+$/i.test(v);

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
function ConfigItem({ label, value }) {
  return (
    <div className="config-item">
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
              <ConfigItem label="Commit Polls (K)" value={agg.config.commitOraclesToPoll} />
              <ConfigItem label="Reveals (M)" value={agg.config.oraclesToPoll} />
              <ConfigItem label="Required (N)" value={agg.config.requiredResponses} />
              <ConfigItem label="Cluster (P)" value={agg.config.clusterSize} />
              <ConfigItem label="Bonus Multiplier" value={agg.config.bonusMultiplier != null ? `${agg.config.bonusMultiplier}x` : null} />
              <ConfigItem label="Timeout" value={agg.config.responseTimeoutSeconds != null ? `${agg.config.responseTimeoutSeconds}s` : null} />
              <ConfigItem label="Max Oracle Fee" value={agg.config.maxOracleFee != null ? `${agg.config.maxOracleFee} LINK` : null} />
              {agg.payment?.fee != null && Number(agg.payment.fee) > 0 && (
                <ConfigItem label="Fee / Oracle" value={`${agg.payment.fee} LINK`} />
              )}
            </div>
          )}

          {agg?.payment && (
            <div className="contract-addresses">
              <AddressRow label="LINK Token (payment)" address={agg.payment.linkTokenAddress} explorer={explorer} />
              {!isZeroHash(agg.payment.jobId) && (
                <div className="contract-row">
                  <span className="contract-label">Chainlink Job ID</span>
                  <code className="address">{agg.payment.jobId}</code>
                </div>
              )}
            </div>
          )}
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
            <ConfigItem label="Registered Oracles" value={keeper?.registeredOracles} />
            <ConfigItem label="Mild Threshold" value={keeper?.mildThreshold} />
            <ConfigItem label="Severe Threshold" value={keeper?.severeThreshold} />
          </div>

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
