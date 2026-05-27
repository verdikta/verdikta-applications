/**
 * Analytics Page
 * Arbiter/oracle diagnostics for the Verdikta network: availability by class
 * and system health. Read directly from the aggregator + ReputationKeeper
 * contracts; no bounty or submission data is involved.
 *
 * The network (Base mainnet / Base Sepolia) is selected globally in the Header
 * and read here via useNetwork(); changing it re-runs the data load.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3,
  RefreshCw,
  AlertTriangle,
  Users,
  Server,
  Clock,
  CheckCircle,
  XCircle,
  Zap,
  Coins,
  UserCircle,
  Fuel
} from 'lucide-react';
import { useToast } from '../components/Toast';
import { useNetwork } from '../context/NetworkContext';
import { apiService } from '../services/api';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import './Analytics.css';

// Register Chart.js components
ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

// Chart color palette (arbiter statuses)
const COLORS = {
  active: '#22c55e',
  new: '#8b5cf6',
  unresponsive: '#f59e0b',
  blocked: '#ef4444',
  inactive: '#6b7280'
};

// Arbiter status descriptions for tooltips
const ARBITER_STATUS_DESCRIPTIONS = {
  Active: 'Registered, responding normally, available for selection, and called three or more times',
  New: 'Arbiters that have been called fewer than three times',
  Unresponsive: 'Registered but showing signs of poor availability: timeliness score <= -60, or 60%+ declining trend in recent scores, or sustained score decline (140+ points in last 8 updates)',
  Blocked: 'Temporarily locked due to severe performance issues (timeliness or quality score below threshold)',
  Inactive: 'Not currently registered or has been deactivated in the contract'
};

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function Analytics() {
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

  // "Arbiters by Owner" section — loaded independently so the heavier
  // owner/withdrawable work doesn't block the sections above.
  const [ownersData, setOwnersData] = useState(null);
  const [ownersLoading, setOwnersLoading] = useState(true);
  const [ownersError, setOwnersError] = useState(null);
  const ownersReqNetRef = useRef(selectedNetwork);

  const loadAnalytics = useCallback(async (network, silent = false) => {
    if (!isMountedRef.current) return;
    requestedNetworkRef.current = network;

    try {
      if (!silent) setLoading(true);
      setError(null);

      const result = await apiService.getAnalyticsOverview(network);

      if (!isMountedRef.current || network !== requestedNetworkRef.current) return;
      if (result.success) {
        setData(result.data);
        setLastUpdated(new Date());
      } else {
        throw new Error(result.error || 'Failed to load analytics');
      }
    } catch (err) {
      if (isMountedRef.current && network === requestedNetworkRef.current) {
        console.error('Error loading analytics:', err);
        setError(err.message || 'Failed to load analytics');
        if (!silent) toast.error('Failed to load analytics data');
      }
    } finally {
      if (isMountedRef.current && network === requestedNetworkRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [toast]);

  // Load the by-owner table.
  const loadOwners = useCallback(async (network) => {
    ownersReqNetRef.current = network;
    try {
      const res = await apiService.getOwnersAnalytics(network);
      if (!isMountedRef.current || network !== ownersReqNetRef.current) return;
      if (!res.success) throw new Error(res.error || 'Failed to load owners');
      setOwnersData(res.data);
      setOwnersError(null);
      setOwnersLoading(false);
    } catch (err) {
      if (isMountedRef.current && network === ownersReqNetRef.current) {
        setOwnersError(err.message || 'Failed to load owners');
        setOwnersLoading(false);
      }
    }
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await apiService.refreshAnalytics(selectedNetwork);
      await loadAnalytics(selectedNetwork, true);
      loadOwners(selectedNetwork);
      toast.success('Analytics refreshed');
    } catch {
      toast.error('Failed to refresh analytics');
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
    loadAnalytics(selectedNetwork);
  }, [selectedNetwork, loadAnalytics]);

  // Load the by-owner table on network change.
  useEffect(() => {
    setOwnersData(null);
    setOwnersLoading(true);
    setOwnersError(null);
    loadOwners(selectedNetwork);
  }, [selectedNetwork, loadOwners]);

  // Format time ago
  const formatTimeAgo = (date) => {
    if (!date) return 'Never';
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  if (loading) {
    return (
      <div className="analytics">
        <div className="page-header">
          <div className="header-content">
            <h1><BarChart3 size={28} className="inline-icon" /> Analytics</h1>
            <p>Arbiter availability and system diagnostics</p>
          </div>
        </div>
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading analytics...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="analytics">
        <div className="page-header">
          <div className="header-content">
            <h1><BarChart3 size={28} className="inline-icon" /> Analytics</h1>
            <p>Arbiter availability and system diagnostics</p>
          </div>
        </div>
        <div className="error-container">
          <AlertTriangle size={48} />
          <h2>Failed to Load Analytics</h2>
          <p>{error}</p>
          <button onClick={() => loadAnalytics(selectedNetwork)} className="btn btn-primary">
            <RefreshCw size={16} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  // Prepare chart data for arbiter availability, grouped by owner so the chart
  // matches the table below. One stacked bar per owner; segments are statuses.
  const chartOwners = ownersData?.owners || [];
  const arbiterChartData = chartOwners.length ? {
    labels: chartOwners.map(o => (o.owner ? shortAddr(o.owner) : 'Unknown')),
    datasets: [
      { label: 'Active', data: chartOwners.map(o => o.active ?? 0), backgroundColor: COLORS.active },
      { label: 'New', data: chartOwners.map(o => o.new ?? 0), backgroundColor: COLORS.new },
      { label: 'Unresponsive', data: chartOwners.map(o => o.unresponsive ?? 0), backgroundColor: COLORS.unresponsive },
      { label: 'Blocked', data: chartOwners.map(o => o.blocked ?? 0), backgroundColor: COLORS.blocked },
      { label: 'Inactive', data: chartOwners.map(o => o.inactive ?? 0), backgroundColor: COLORS.inactive }
    ]
  } : null;

  const arbiterChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { stacked: true, title: { display: true, text: 'Owner' } },
      y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Arbiter Count' } }
    },
    plugins: {
      legend: { display: false }, // Using custom legend for tooltip support
      tooltip: {
        callbacks: {
          afterLabel: (context) => {
            const status = context.dataset.label;
            return ARBITER_STATUS_DESCRIPTIONS[status] ? `\n${ARBITER_STATUS_DESCRIPTIONS[status]}` : '';
          }
        }
      }
    }
  };

  return (
    <div className="analytics">
      {/* Header */}
      <div className="page-header">
        <div className="header-content">
          <h1><BarChart3 size={28} className="inline-icon" /> Analytics</h1>
          <p>Arbiter availability and system diagnostics</p>
        </div>
        <div className="header-actions">
          <span className="last-updated">
            <Clock size={14} /> Updated {formatTimeAgo(lastUpdated)}
          </span>
          <button
            onClick={handleRefresh}
            className="btn btn-secondary btn-with-icon"
            disabled={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? 'spinning' : ''} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Arbiter Availability Section */}
      <section className="analytics-section">
        <h2 title="Six non-blocked arbiter queries will be made, with duplicate selection if necessary, and four must respond."><Users size={20} className="inline-icon" /> Arbiter Availability</h2>
        {!data?.arbiters?.verdiktaConnected && (
          <div className="info-banner">
            <AlertTriangle size={16} />
            <span>{data?.arbiters?.message || 'Verdikta aggregator not connected'}</span>
          </div>
        )}
        <div className="section-content">
          {ownersLoading && !ownersData ? (
            <div className="loading"><div className="spinner"></div><p>Loading arbiters...</p></div>
          ) : ownersError ? (
            <div className="info-banner"><AlertTriangle size={16} /><span>{ownersError}</span></div>
          ) : arbiterChartData ? (
            <>
              <div className="chart-container chart-bar">
                <Bar data={arbiterChartData} options={arbiterChartOptions} />
                <div className="custom-legend">
                  <span className="legend-item" title={ARBITER_STATUS_DESCRIPTIONS.Active}>
                    <span className="legend-color" style={{ backgroundColor: COLORS.active }}></span>
                    Active
                  </span>
                  <span className="legend-item" title={ARBITER_STATUS_DESCRIPTIONS.New}>
                    <span className="legend-color" style={{ backgroundColor: COLORS.new }}></span>
                    New
                  </span>
                  <span className="legend-item" title={ARBITER_STATUS_DESCRIPTIONS.Unresponsive}>
                    <span className="legend-color" style={{ backgroundColor: COLORS.unresponsive }}></span>
                    Unresponsive
                  </span>
                  <span className="legend-item" title={ARBITER_STATUS_DESCRIPTIONS.Blocked}>
                    <span className="legend-color" style={{ backgroundColor: COLORS.blocked }}></span>
                    Blocked
                  </span>
                  <span className="legend-item" title={ARBITER_STATUS_DESCRIPTIONS.Inactive}>
                    <span className="legend-color" style={{ backgroundColor: COLORS.inactive }}></span>
                    Inactive
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <Users size={32} />
              <p>No arbiter data available</p>
            </div>
          )}
          {data?.arbiters?.totalOracles != null && (
            <div className="stat-highlight">
              <strong>{data.arbiters.totalOracles}</strong> total registered oracles
            </div>
          )}
        </div>
      </section>

      {/* Arbiters by Owner Section */}
      <section className="analytics-section">
        <h2 title="Arbiters grouped by the wallet that owns their operator contract"><UserCircle size={20} className="inline-icon" /> Arbiters by Owner</h2>
        <div className="section-content">
          {ownersLoading && !ownersData ? (
            <div className="loading"><div className="spinner"></div><p>Loading owners...</p></div>
          ) : ownersError ? (
            <div className="info-banner"><AlertTriangle size={16} /><span>{ownersError}</span></div>
          ) : ownersData && ownersData.owners.length > 0 ? (
            <div className="stats-table">
              <table>
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th>Arbiters</th>
                    <th className="tooltip-header" title={ARBITER_STATUS_DESCRIPTIONS.Active}>Active</th>
                    <th className="tooltip-header" title={ARBITER_STATUS_DESCRIPTIONS.New}>New</th>
                    <th className="tooltip-header" title={ARBITER_STATUS_DESCRIPTIONS.Unresponsive}>Unresponsive</th>
                    <th className="tooltip-header" title={ARBITER_STATUS_DESCRIPTIONS.Blocked}>Blocked</th>
                    <th className="tooltip-header" title="Average quality score across this owner's arbiters">Avg Quality</th>
                    <th className="tooltip-header" title="Average timeliness score across this owner's arbiters">Avg Timeliness</th>
                    <th className="tooltip-header" title="LINK currently claimable across this owner's operator contracts"><Coins size={13} className="inline-icon" /> Claimable LINK</th>
                  </tr>
                </thead>
                <tbody>
                  {ownersData.owners.map((o) => (
                    <tr key={o.owner || 'unknown'}>
                      <td>
                        {o.owner ? (
                          <Link className="class-link" to={`/owner/${o.owner}`} title={`View arbiters owned by ${o.owner}`}>
                            <code>{shortAddr(o.owner)}</code>
                          </Link>
                        ) : (
                          <span className="text-muted">Unknown</span>
                        )}
                      </td>
                      <td><strong>{o.arbiters}</strong>{o.operators > 1 ? ` (${o.operators} operators)` : ''}</td>
                      <td style={{ color: COLORS.active, fontWeight: 600 }}>{o.active ?? '-'}</td>
                      <td style={{ color: COLORS.new, fontWeight: 600 }}>{o.new ?? '-'}</td>
                      <td style={{ color: COLORS.unresponsive, fontWeight: 600 }}>{o.unresponsive ?? '-'}</td>
                      <td style={{ color: COLORS.blocked, fontWeight: 600 }}>{o.blocked ?? '-'}</td>
                      <td>{o.avgQualityScore}</td>
                      <td>{o.avgTimelinessScore}</td>
                      <td>{o.claimableLink ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state"><UserCircle size={32} /><p>No arbiter owners found</p></div>
          )}
        </div>
      </section>

      {/* Funding by Owner Section */}
      <section className="analytics-section">
        <h2 title="ETH held in each owner's arbiter-node sending keys, which pay gas for commit/reveal responses"><Fuel size={20} className="inline-icon" /> Funding by Owner</h2>
        <div className="section-content">
          {ownersLoading && !ownersData ? (
            <div className="loading"><div className="spinner"></div><p>Loading funding...</p></div>
          ) : ownersError ? (
            <div className="info-banner"><AlertTriangle size={16} /><span>{ownersError}</span></div>
          ) : ownersData && ownersData.owners.length > 0 ? (
            <div className="stats-table">
              <table>
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th className="tooltip-header" title="Total ETH across this owner's node sending keys">Node ETH</th>
                    <th className="tooltip-header" title="Estimated queries that ETH covers at the current gas price">Est. Queries</th>
                    <th>Funding</th>
                  </tr>
                </thead>
                <tbody>
                  {ownersData.owners.map((o) => (
                    <tr key={o.owner || 'unknown'}>
                      <td>
                        {o.owner ? (
                          <Link className="class-link" to={`/owner/${o.owner}`} title={o.owner}>
                            <code>{shortAddr(o.owner)}</code>
                          </Link>
                        ) : (
                          <span className="text-muted">Unknown</span>
                        )}
                      </td>
                      <td>
                        {o.owner && o.nodeEth != null ? (
                          <Link className="class-link" to={`/owner/${o.owner}#funding`} title="View per-key funding breakdown">
                            {Number(o.nodeEth).toFixed(4)}
                          </Link>
                        ) : (
                          o.nodeEth != null ? Number(o.nodeEth).toFixed(4) : '—'
                        )}
                      </td>
                      <td>{o.estQueries != null ? o.estQueries.toLocaleString() : '—'}</td>
                      <td style={{ color: o.fundingLow ? COLORS.blocked : COLORS.active, fontWeight: 600 }}>
                        {o.fundingLow ? 'Low' : 'OK'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ownersData.funding && (
                <p className="table-note">
                  Estimates assume ~{ownersData.funding.gasPerQuery.toLocaleString()} gas per query at{' '}
                  {ownersData.funding.gasPriceGwei} gwei; &ldquo;Low&rdquo; means under{' '}
                  {ownersData.funding.lowQueriesThreshold.toLocaleString()} queries or{' '}
                  {ownersData.funding.lowEthThreshold} ETH. Changes with gas price.
                </p>
              )}
            </div>
          ) : (
            <div className="empty-state"><Fuel size={32} /><p>No funding data</p></div>
          )}
        </div>
      </section>

      {/* System Health Section */}
      <section className="analytics-section">
        <h2><Server size={20} className="inline-icon" /> System Health</h2>
        <div className="section-content">
          <div className="health-grid">
            {/* Contract Addresses */}
            <div className="health-card wide">
              <div className="health-header">
                <span className={`health-status ${data?.system?.verdikta?.healthy ? 'healthy' : 'unhealthy'}`}>
                  {data?.system?.verdikta?.healthy ? <CheckCircle size={16} /> : <XCircle size={16} />}
                </span>
                <span className="health-title">Contract Addresses</span>
              </div>
              <div className="health-details">
                {data?.system?.verdikta?.configured ? (
                  <div className="contract-addresses">
                    {data.system.verdikta.aggregatorAddress && (
                      <div className="contract-row">
                        <span className="contract-label">Verdikta Aggregator:</span>
                        <code className="address">{data.system.verdikta.aggregatorAddress}</code>
                      </div>
                    )}
                    {data.system.verdikta.keeperAddress && (
                      <div className="contract-row">
                        <span className="contract-label">Reputation Keeper:</span>
                        <code className="address">{data.system.verdikta.keeperAddress}</code>
                      </div>
                    )}
                    {data.system.verdikta.linkTokenAddress && (
                      <div className="contract-row">
                        <span className="contract-label">LINK Token:</span>
                        <code className="address">{data.system.verdikta.linkTokenAddress}</code>
                      </div>
                    )}
                    {data.system.verdikta.wvdkaAddress && (
                      <div className="contract-row">
                        <span className="contract-label">wVDKA Token:</span>
                        <code className="address">{data.system.verdikta.wvdkaAddress}</code>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-muted">Not configured</p>
                )}
              </div>
            </div>

            {/* Aggregator Config */}
            {data?.system?.aggregatorConfig && (
              <div className="health-card wide">
                <div className="health-header">
                  <span className="health-status healthy"><Zap size={16} /></span>
                  <span className="health-title">Aggregator Configuration</span>
                </div>
                <div className="health-details config-grid">
                  <div className="config-item">
                    <span className="config-label">Commit Polls (K)</span>
                    <span className="config-value">{data.system.aggregatorConfig.commitOraclesToPoll}</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Reveals (M)</span>
                    <span className="config-value">{data.system.aggregatorConfig.oraclesToPoll}</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Required (N)</span>
                    <span className="config-value">{data.system.aggregatorConfig.requiredResponses}</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Cluster (P)</span>
                    <span className="config-value">{data.system.aggregatorConfig.clusterSize}</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Bonus Multiplier</span>
                    <span className="config-value">{data.system.aggregatorConfig.bonusMultiplier}x</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Timeout</span>
                    <span className="config-value">{data.system.aggregatorConfig.responseTimeoutSeconds}s</span>
                  </div>
                  <div className="config-item">
                    <span className="config-label">Max Oracle Fee</span>
                    <span className="config-value">{data.system.aggregatorConfig.maxOracleFee} LINK</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export default Analytics;
