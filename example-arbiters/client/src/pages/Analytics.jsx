/**
 * Analytics Page
 * Arbiter/oracle diagnostics for the Verdikta network: availability by class
 * and system health. Read directly from the aggregator + ReputationKeeper
 * contracts; no bounty or submission data is involved.
 *
 * A network toggle (Base mainnet / Base Sepolia) is persisted to localStorage
 * and passed to the API, mirroring the example-frontend pattern.
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
  Zap
} from 'lucide-react';
import { useToast } from '../components/Toast';
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

// Network options mirror example-frontend (underscored keys). The server
// normalizes 'base_sepolia' -> 'base-sepolia'.
const NETWORKS = [
  { value: 'base', label: 'Base Mainnet' },
  { value: 'base_sepolia', label: 'Base Sepolia Testnet' }
];
const DEFAULT_NETWORK = 'base_sepolia';

function Analytics() {
  const toast = useToast();
  const [selectedNetwork, setSelectedNetwork] = useState(() => {
    return localStorage.getItem('selectedNetwork') || DEFAULT_NETWORK;
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const isMountedRef = useRef(true);

  const loadAnalytics = useCallback(async (network, silent = false) => {
    if (!isMountedRef.current) return;

    try {
      if (!silent) setLoading(true);
      setError(null);

      const result = await apiService.getAnalyticsOverview(network);

      if (isMountedRef.current) {
        if (result.success) {
          setData(result.data);
          setLastUpdated(new Date());
        } else {
          throw new Error(result.error || 'Failed to load analytics');
        }
      }
    } catch (err) {
      if (isMountedRef.current) {
        console.error('Error loading analytics:', err);
        setError(err.message || 'Failed to load analytics');
        if (!silent) toast.error('Failed to load analytics data');
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [toast]);

  const handleNetworkChange = (network) => {
    setSelectedNetwork(network);
    localStorage.setItem('selectedNetwork', network);
    setData(null);
    loadAnalytics(network);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await apiService.refreshAnalytics(selectedNetwork);
      await loadAnalytics(selectedNetwork, true);
      toast.success('Analytics refreshed');
    } catch {
      toast.error('Failed to refresh analytics');
      setRefreshing(false);
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    loadAnalytics(selectedNetwork);

    return () => {
      isMountedRef.current = false;
    };
    // Only run on mount; network changes go through handleNetworkChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const networkSelector = (
    <select
      value={selectedNetwork}
      onChange={(e) => handleNetworkChange(e.target.value)}
      className="network-selector"
      disabled={loading || refreshing}
    >
      {NETWORKS.map((n) => (
        <option key={n.value} value={n.value}>{n.label}</option>
      ))}
    </select>
  );

  if (loading) {
    return (
      <div className="analytics">
        <div className="page-header">
          <div className="header-content">
            <h1><BarChart3 size={28} className="inline-icon" /> Analytics</h1>
            <p>Arbiter availability and system diagnostics</p>
          </div>
          <div className="header-actions">{networkSelector}</div>
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
          <div className="header-actions">{networkSelector}</div>
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

  // Format class label: "128 (Core)" if shortName available, otherwise just "128"
  const formatClassLabel = (cls) => {
    return cls.shortName ? `${cls.classId} (${cls.shortName})` : String(cls.classId);
  };

  // Prepare chart data for arbiter availability
  const arbiterChartData = data?.arbiters?.byClass ? {
    labels: Object.values(data.arbiters.byClass).map(formatClassLabel),
    datasets: [
      { label: 'Active', data: Object.values(data.arbiters.byClass).map(c => c.active ?? 0), backgroundColor: COLORS.active },
      { label: 'New', data: Object.values(data.arbiters.byClass).map(c => c.new ?? 0), backgroundColor: COLORS.new },
      { label: 'Unresponsive', data: Object.values(data.arbiters.byClass).map(c => c.unresponsive ?? 0), backgroundColor: COLORS.unresponsive },
      { label: 'Blocked', data: Object.values(data.arbiters.byClass).map(c => c.blocked ?? 0), backgroundColor: COLORS.blocked },
      { label: 'Inactive', data: Object.values(data.arbiters.byClass).map(c => c.inactive ?? 0), backgroundColor: COLORS.inactive }
    ]
  } : null;

  const arbiterChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { stacked: true, title: { display: true, text: 'Class' } },
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
          {networkSelector}
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
          {arbiterChartData && Object.keys(data.arbiters.byClass).length > 0 ? (
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
              <div className="stats-table">
                <h3 className="table-title">Availability by Class</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th title="Total number of Chainlink operator contracts used to serve the arbiters in this class" className="tooltip-header">Operators</th>
                      <th title={ARBITER_STATUS_DESCRIPTIONS.Active} className="tooltip-header">Active</th>
                      <th title={ARBITER_STATUS_DESCRIPTIONS.New} className="tooltip-header">New</th>
                      <th title={ARBITER_STATUS_DESCRIPTIONS.Unresponsive} className="tooltip-header">Unresponsive</th>
                      <th title={ARBITER_STATUS_DESCRIPTIONS.Blocked} className="tooltip-header">Blocked</th>
                      <th>Total</th>
                      <th>Avg Quality</th>
                      <th>Avg Timeliness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.values(data.arbiters.byClass).map((cls) => (
                      <tr key={cls.classId}>
                        <td
                          title={cls.operatorList?.length > 0 ? cls.operatorList.join('\n') : undefined}
                        >
                          <Link to={`/class/${cls.classId}`} className="class-link">
                            <strong>{formatClassLabel(cls)}</strong>
                          </Link>
                        </td>
                        <td
                          title={cls.operatorList?.length > 0 ? cls.operatorList.join('\n') : 'No operators'}
                          style={{ cursor: cls.operatorList?.length > 0 ? 'help' : 'default' }}
                        >{cls.operators ?? '-'}</td>
                        <td style={{ color: COLORS.active, fontWeight: 600 }}>{cls.active ?? '-'}</td>
                        <td style={{ color: COLORS.new, fontWeight: 600 }}>{cls.new ?? '-'}</td>
                        <td style={{ color: COLORS.unresponsive, fontWeight: 600 }}>{cls.unresponsive ?? '-'}</td>
                        <td style={{ color: COLORS.blocked, fontWeight: 600 }}>{cls.blocked ?? '-'}</td>
                        <td>{cls.total ?? '-'}</td>
                        <td>{cls.avgQualityScore ?? '-'}</td>
                        <td>{cls.avgTimelinessScore ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
