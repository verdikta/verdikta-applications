/**
 * Analytics Page
 * Displays system diagnostics including arbiter availability, bounty statistics,
 * submission metrics, and system health
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart3,
  RefreshCw,
  AlertTriangle,
  Activity,
  Users,
  TrendingUp,
  Server,
  Clock,
  CheckCircle,
  XCircle,
  Hourglass,
  Coins,
  FileText,
  Zap
} from 'lucide-react';
import { useToast } from '../components/Toast';
import { apiService } from '../services/api';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';
import './Analytics.css';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
);

// Chart color palette
const COLORS = {
  active: '#22c55e',
  unresponsive: '#f59e0b',
  blocked: '#ef4444',
  inactive: '#6b7280',
  open: '#22c55e',
  expired: '#f59e0b',
  awarded: '#3b82f6',
  closed: '#6b7280',
  orphaned: '#a855f7',
  passed: '#22c55e',
  failed: '#ef4444',
  pending: '#f59e0b',
  prepared: '#3b82f6'
};

// Arbiter status descriptions for tooltips
const ARBITER_STATUS_DESCRIPTIONS = {
  Active: 'Registered, responding normally, and available for selection',
  Unresponsive: 'Registered but showing signs of poor availability: timeliness score <= -60, or 60%+ declining trend in recent scores, or rapid score decline (40+ points in last 3 updates)',
  Blocked: 'Temporarily locked due to severe performance issues (timeliness or quality score below threshold)',
  Inactive: 'Not currently registered or has been deactivated in the contract'
};

function Analytics() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const isMountedRef = useRef(true);

  const loadAnalytics = useCallback(async (silent = false) => {
    if (!isMountedRef.current) return;

    try {
      if (!silent) setLoading(true);
      setError(null);

      const result = await apiService.getAnalyticsOverview();

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

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await apiService.refreshAnalytics();
      await loadAnalytics(true);
      toast.success('Analytics refreshed');
    } catch (err) {
      toast.error('Failed to refresh analytics');
      setRefreshing(false);
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    loadAnalytics();

    return () => {
      isMountedRef.current = false;
    };
  }, [loadAnalytics]);

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
        <div className="error-container">
          <AlertTriangle size={48} />
          <h2>Failed to Load Analytics</h2>
          <p>{error}</p>
          <button onClick={() => loadAnalytics()} className="btn btn-primary">
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
      {
        label: 'Active',
        data: Object.values(data.arbiters.byClass).map(c => c.active ?? 0),
        backgroundColor: COLORS.active
      },
      {
        label: 'Unresponsive',
        data: Object.values(data.arbiters.byClass).map(c => c.unresponsive ?? 0),
        backgroundColor: COLORS.unresponsive
      },
      {
        label: 'Blocked',
        data: Object.values(data.arbiters.byClass).map(c => c.blocked ?? 0),
        backgroundColor: COLORS.blocked
      },
      {
        label: 'Inactive',
        data: Object.values(data.arbiters.byClass).map(c => c.inactive ?? 0),
        backgroundColor: COLORS.inactive
      }
    ]
  } : null;

  // Prepare chart data for bounty status
  const bountyChartData = data?.bounties?.byStatus ? {
    labels: ['Open', 'Expired', 'Awarded', 'Closed', 'Orphaned'],
    datasets: [{
      data: [
        data.bounties.byStatus.OPEN || 0,
        data.bounties.byStatus.EXPIRED || 0,
        data.bounties.byStatus.AWARDED || 0,
        data.bounties.byStatus.CLOSED || 0,
        data.bounties.byStatus.ORPHANED || 0
      ],
      backgroundColor: [
        COLORS.open,
        COLORS.expired,
        COLORS.awarded,
        COLORS.closed,
        COLORS.orphaned
      ]
    }]
  } : null;

  // Prepare chart data for submission outcomes
  const submissionChartData = data?.submissions?.byOutcome ? {
    labels: ['Passed', 'Failed', 'Pending', 'Prepared'],
    datasets: [{
      data: [
        data.submissions.byOutcome.passed || 0,
        data.submissions.byOutcome.failed || 0,
        data.submissions.byOutcome.pending || 0,
        data.submissions.byOutcome.prepared || 0
      ],
      backgroundColor: [
        COLORS.passed,
        COLORS.failed,
        COLORS.pending,
        COLORS.prepared
      ]
    }]
  } : null;

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom'
      }
    }
  };

  const arbiterChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { stacked: true },
      y: { stacked: true, beginAtZero: true }
    },
    plugins: {
      legend: {
        display: false // Using custom legend for tooltip support
      },
      tooltip: {
        callbacks: {
          afterLabel: (context) => {
            const status = context.dataset.label;
            return ARBITER_STATUS_DESCRIPTIONS[status]
              ? `\n${ARBITER_STATUS_DESCRIPTIONS[status]}`
              : '';
          }
        }
      }
    }
  };

  const barChartOptions = {
    ...chartOptions,
    scales: {
      x: { stacked: true },
      y: { stacked: true, beginAtZero: true }
    }
  };

  return (
    <div className="analytics">
      {/* Header */}
      <div className="page-header">
        <div className="header-content">
          <h1><BarChart3 size={28} className="inline-icon" /> Analytics</h1>
          <p>System diagnostics and performance metrics</p>
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
        <h2><Users size={20} className="inline-icon" /> Arbiter Availability</h2>
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
                      <th title={ARBITER_STATUS_DESCRIPTIONS.Active} className="tooltip-header">Active</th>
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
                        <td>
                          <strong>{formatClassLabel(cls)}</strong>
                        </td>
                        <td className="text-success">{cls.active ?? '-'}</td>
                        <td className="text-warning">{cls.unresponsive ?? '-'}</td>
                        <td className="text-danger">{cls.blocked ?? '-'}</td>
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

      {/* Bounty Statistics Section */}
      <section className="analytics-section">
        <h2><Coins size={20} className="inline-icon" /> Bounty Statistics</h2>
        <div className="section-content">
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-icon"><FileText size={24} /></div>
              <div className="stat-value">{data?.bounties?.totalBounties ?? 0}</div>
              <div className="stat-label">Total Bounties</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon"><Coins size={24} /></div>
              <div className="stat-value">{data?.bounties?.totalETH ?? 0} ETH</div>
              <div className="stat-label">Total Value</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon"><TrendingUp size={24} /></div>
              <div className="stat-value">{data?.bounties?.avgBountyAmount ?? 0} ETH</div>
              <div className="stat-label">Avg Bounty</div>
            </div>
            <div className="stat-card warning">
              <div className="stat-icon"><AlertTriangle size={24} /></div>
              <div className="stat-value">{data?.bounties?.orphanedCount ?? 0}</div>
              <div className="stat-label">Orphaned</div>
            </div>
          </div>
          {bountyChartData && (
            <div className="chart-container chart-doughnut">
              <Doughnut data={bountyChartData} options={chartOptions} />
            </div>
          )}
        </div>
      </section>

      {/* Submission Metrics Section */}
      <section className="analytics-section">
        <h2><Activity size={20} className="inline-icon" /> Submission Metrics</h2>
        <div className="section-content">
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-icon"><FileText size={24} /></div>
              <div className="stat-value">{data?.submissions?.total ?? 0}</div>
              <div className="stat-label">Total Submissions</div>
            </div>
            <div className="stat-card success">
              <div className="stat-icon"><CheckCircle size={24} /></div>
              <div className="stat-value">{data?.submissions?.byOutcome?.passed ?? 0}</div>
              <div className="stat-label">Passed</div>
            </div>
            <div className="stat-card danger">
              <div className="stat-icon"><XCircle size={24} /></div>
              <div className="stat-value">{data?.submissions?.byOutcome?.failed ?? 0}</div>
              <div className="stat-label">Failed</div>
            </div>
            <div className="stat-card warning">
              <div className="stat-icon"><Hourglass size={24} /></div>
              <div className="stat-value">{data?.submissions?.byOutcome?.pending ?? 0}</div>
              <div className="stat-label">Pending</div>
            </div>
          </div>
          <div className="metrics-row">
            {data?.submissions?.passRate != null && (
              <div className="metric-badge success">
                <TrendingUp size={16} />
                <span>{data.submissions.passRate}% Pass Rate</span>
              </div>
            )}
            {data?.submissions?.avgScore != null && (
              <div className="metric-badge">
                <Zap size={16} />
                <span>Avg Score: {data.submissions.avgScore}</span>
              </div>
            )}
          </div>
          {submissionChartData && (
            <div className="chart-container chart-doughnut">
              <Doughnut data={submissionChartData} options={chartOptions} />
            </div>
          )}
        </div>
      </section>

      {/* System Health Section */}
      <section className="analytics-section">
        <h2><Server size={20} className="inline-icon" /> System Health</h2>
        <div className="section-content">
          <div className="health-grid">
            {/* Verdikta Connection */}
            <div className="health-card">
              <div className="health-header">
                <span className={`health-status ${data?.system?.verdikta?.healthy ? 'healthy' : 'unhealthy'}`}>
                  {data?.system?.verdikta?.healthy ? <CheckCircle size={16} /> : <XCircle size={16} />}
                </span>
                <span className="health-title">Verdikta Aggregator</span>
              </div>
              <div className="health-details">
                {data?.system?.verdikta?.configured ? (
                  <>
                    <p>Connected: {data.system.verdikta.healthy ? 'Yes' : 'No'}</p>
                    {data.system.verdikta.aggregatorAddress && (
                      <code className="address">{data.system.verdikta.aggregatorAddress}</code>
                    )}
                  </>
                ) : (
                  <p className="text-muted">Not configured</p>
                )}
              </div>
            </div>

            {/* Sync Status */}
            <div className="health-card">
              <div className="health-header">
                <span className={`health-status ${data?.system?.sync?.enabled ? 'healthy' : 'neutral'}`}>
                  {data?.system?.sync?.enabled ? <CheckCircle size={16} /> : <Clock size={16} />}
                </span>
                <span className="health-title">Blockchain Sync</span>
              </div>
              <div className="health-details">
                {data?.system?.sync ? (
                  <>
                    <p>Status: {data.system.sync.isSyncing ? 'Syncing...' : 'Idle'}</p>
                    <p>Interval: {data.system.sync.intervalMinutes}m</p>
                    {data.system.sync.lastSync && (
                      <p>Last: {new Date(data.system.sync.lastSync).toLocaleTimeString()}</p>
                    )}
                  </>
                ) : (
                  <p className="text-muted">Sync not enabled</p>
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
