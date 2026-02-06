import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus,
  HelpCircle,
  AlertTriangle,
  Bot,
  Zap,
  Lock,
  BarChart3,
  Clock,
  RefreshCw,
  Trophy,
  Search,
  ExternalLink,
  User,
  CheckCircle,
  ShieldCheck,
} from 'lucide-react';
import { apiService } from '../services/api';
import { config } from '../config';
import {
  BountyStatus,
  getBountyStatusLabel,
  getBountyBadgeProps,
  getBountyStatusIcon,
  isSubmissionPending,
  hasAnyPendingSubmissions,
  getSubmissionStatusDescription,
} from '../utils/statusDisplay';
import { StatusIcon } from '../components/StatusIcon';
import './Home.css';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // How often to refresh jobs list when there are pending submissions (15 seconds)
  AUTO_REFRESH_INTERVAL_MS: 15000,
};

// Helper to truncate Ethereum addresses for display
const truncateAddress = (address) => {
  if (!address || address.length < 10) return address || '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

// Get explorer URL for the current network
const getExplorerUrl = () => {
  const network = config.networks[config.network] || config.networks['base-sepolia'];
  return network.explorer;
};

function Home({ walletState }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({
    status: '',
    search: '',
    minPayout: ''
  });

  // Refs for auto-refresh
  const autoRefreshIntervalRef = useRef(null);
  const isMountedRef = useRef(true);

  const loadJobs = useCallback(async (silent = false) => {
    if (!isMountedRef.current) return;
    
    try {
      if (!silent) setLoading(true);
      setError(null);

      const filterParams = {};
      if (filters.search) filterParams.search = filters.search;
      if (filters.minPayout) filterParams.minPayout = filters.minPayout;

      const statusUpper = String(filters.status || '').toUpperCase();

      if (['OPEN', 'EXPIRED', 'AWARDED', 'CLOSED'].includes(statusUpper)) {
        filterParams.status = statusUpper;
      } else {
        // "All Active" excludes completed bounties (both CLOSED and AWARDED)
        filterParams.excludeStatuses = 'CLOSED,AWARDED';
      }

      const response = await apiService.listJobs(filterParams);
      
      if (isMountedRef.current) {
        setJobs(response.jobs || []);
      }
    } catch (err) {
      if (isMountedRef.current) {
        console.error('Error loading jobs:', err);
        setError('Failed to load jobs. ' + err.message);
        setJobs([]);
      }
    } finally {
      if (isMountedRef.current && !silent) setLoading(false);
    }
  }, [filters]);

  // Initial load and filter changes
  useEffect(() => {
    isMountedRef.current = true;
    loadJobs();
    
    return () => {
      isMountedRef.current = false;
    };
  }, [loadJobs]);

  // ============================================================================
  // AUTO-REFRESH - Poll for updates when there are pending evaluations
  // ============================================================================

  useEffect(() => {
    // Clear any existing interval
    if (autoRefreshIntervalRef.current) {
      clearInterval(autoRefreshIntervalRef.current);
      autoRefreshIntervalRef.current = null;
    }

    // Only auto-refresh if we have jobs loaded
    if (jobs.length === 0) return;

    // Check if any jobs have pending submissions or are in states that might change
    const shouldAutoRefresh = jobs.some(job =>
      job.status === BountyStatus.OPEN ||
      job.status === BountyStatus.EXPIRED ||
      hasAnyPendingSubmissions(job.submissions)
    );

    if (!shouldAutoRefresh) {
      console.log('📊 Home: No jobs needing auto-refresh');
      return;
    }

    console.log(`📊 Home: Starting auto-refresh every ${CONFIG.AUTO_REFRESH_INTERVAL_MS / 1000}s`);

    autoRefreshIntervalRef.current = setInterval(() => {
      if (isMountedRef.current) {
        console.log('🔄 Home: Auto-refreshing jobs list...');
        loadJobs(true); // silent refresh
      }
    }, CONFIG.AUTO_REFRESH_INTERVAL_MS);

    return () => {
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
        autoRefreshIntervalRef.current = null;
      }
    };
  }, [jobs, loadJobs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
      }
    };
  }, []);

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters({ status: '', search: '', minPayout: '' });
  };

  return (
    <div className="home">
      <div className="hero">
        <h1>AI-Powered Bounty Program</h1>
        <p className="hero-subtitle">
          Create bounties, submit work, get evaluated by AI, earn ETH automatically
        </p>
        <div className="hero-actions">
          <Link to="/create" className="btn btn-primary btn-lg btn-with-icon">
            <Plus size={20} />
            Create Bounty
          </Link>
          <a href="#how-it-works" className="btn btn-secondary btn-lg btn-with-icon">
            <HelpCircle size={20} />
            How It Works
          </a>
        </div>
      </div>

      <section className="bounties-section">
        <div className="section-header">
          <h2>Available Jobs</h2>
          <div className="filters">
            <input
              type="text"
              placeholder="Search jobs..."
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
              className="filter-search"
            />
            <select
              value={filters.status}
              onChange={(e) => handleFilterChange('status', e.target.value)}
              className="filter-status"
            >
              <option value="">All Active</option>
              <option value="OPEN">Open</option>
              <option value="EXPIRED">Expired</option>
              <option value="AWARDED">Awarded</option>
              <option value="CLOSED">Closed</option>
            </select>
            <input
              type="number"
              placeholder="Min ETH"
              value={filters.minPayout}
              onChange={(e) => handleFilterChange('minPayout', e.target.value)}
              className="filter-payout"
              step="0.01"
              min="0"
            />
            {(filters.status || filters.search || filters.minPayout) && (
              <button onClick={clearFilters} className="btn-clear-filters">
                Clear Filters
              </button>
            )}
          </div>
        </div>

        {loading && (
          <div className="loading">
            <div className="spinner"></div>
            <p>Loading jobs...</p>
          </div>
        )}

        {error && (
          <div className="error-message">
            <p><AlertTriangle size={16} className="inline-icon" /> {error}</p>
          </div>
        )}

        {!loading && !error && jobs.length === 0 && (
          <div className="empty-state">
            <Search size={48} className="empty-icon" />
            <h3>No jobs found</h3>
            <p>
              {filters.status || filters.search || filters.minPayout
                ? 'Try adjusting your filters'
                : 'Be the first to create a job!'}
            </p>
            <Link to="/create" className="btn btn-primary btn-with-icon">
              <Plus size={18} />
              Create Job
            </Link>
          </div>
        )}

        {!loading && jobs.length > 0 && (
          <div className="bounty-grid">
            {jobs.map(job => (
              <JobCard key={job.jobId} job={job} />
            ))}
          </div>
        )}
      </section>

      <section id="how-it-works" className="how-it-works">
        <h2>How It Works</h2>
        <div className="steps">
          <div className="step">
            <div className="step-number">1</div>
            <h3>Create Bounty</h3>
            <p>Lock ETH in escrow and define evaluation criteria (rubric)</p>
          </div>
          <div className="step">
            <div className="step-number">2</div>
            <h3>Hunters Submit</h3>
            <p>Submit deliverables (essays, designs, code) to be evaluated</p>
          </div>
          <div className="step">
            <div className="step-number">3</div>
            <h3>AI Evaluates</h3>
            <p>Verdikta's AI jury grades submissions against the rubric</p>
          </div>
          <div className="step">
            <div className="step-number">4</div>
            <h3>Auto Payment</h3>
            <p>First passing submission wins ETH automatically</p>
          </div>
        </div>
      </section>

      <section className="features">
        <h2>Why Use Verdikta Bounties?</h2>
        <div className="feature-grid">
          <div className="feature">
            <div className="feature-icon"><Bot size={32} /></div>
            <h3>AI-Powered</h3>
            <p>Multiple AI models evaluate submissions for fairness and accuracy</p>
          </div>
          <div className="feature">
            <div className="feature-icon"><Zap size={32} /></div>
            <h3>Automatic</h3>
            <p>No manual review needed - payments happen automatically</p>
          </div>
          <div className="feature">
            <div className="feature-icon"><Lock size={32} /></div>
            <h3>Trustless</h3>
            <p>ETH locked in smart contract escrow until winner is determined</p>
          </div>
          <div className="feature">
            <div className="feature-icon"><BarChart3 size={32} /></div>
            <h3>Transparent</h3>
            <p>All evaluations and scores are publicly verifiable</p>
          </div>
        </div>
      </section>
    </div>
  );
}

// Job Card Component
function JobCard({ job }) {
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);

  // Handler for running validation
  const handleValidate = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (validating) return;

    setValidating(true);
    setValidationResult(null);

    try {
      const result = await apiService.validateJob(job.jobId);
      // API returns issues array with severity: 'error' | 'warning' | 'info'
      const issues = result.issues || [];
      const errorCount = issues.filter(i => i.severity === 'error').length;
      const warningCount = issues.filter(i => i.severity === 'warning').length;

      // Build message from issues
      let message = 'Package is valid';
      if (!result.valid) {
        const errorMessages = issues
          .filter(i => i.severity === 'error')
          .map(i => i.message)
          .join('; ');
        message = errorMessages || `${errorCount} error(s) found`;
      }

      setValidationResult({
        valid: result.valid,
        errorCount,
        warningCount,
        message
      });
    } catch (err) {
      console.error('Validation failed:', err);
      setValidationResult({
        valid: false,
        errorCount: 1,
        message: err.response?.data?.error || 'Validation failed'
      });
    } finally {
      setValidating(false);
    }
  };

  // Calculate time remaining with better granularity
  const now = Math.floor(Date.now() / 1000);
  const timeRemaining = (job.submissionCloseTime ?? 0) - now;
  const totalMinutesRemaining = Math.max(0, Math.floor(timeRemaining / 60));
  const hoursRemaining = Math.floor(totalMinutesRemaining / 60);
  const minutesRemaining = totalMinutesRemaining % 60;
  const daysRemaining = Math.floor(hoursRemaining / 24);
  const hoursInDay = hoursRemaining % 24;

  const status = job.status || 'UNKNOWN';
  const isOpen = status === BountyStatus.OPEN;
  const isExpired = status === BountyStatus.EXPIRED;
  const isAwarded = status === BountyStatus.AWARDED;
  const isClosed = status === BountyStatus.CLOSED;

  // Less than 24 hours = closing soon (show warning style)
  const isClosingSoon = isOpen && timeRemaining > 0 && hoursRemaining < 24;
  // Less than 1 hour = critical (show minutes)
  const isCritical = isOpen && timeRemaining > 0 && hoursRemaining < 1;

  // Check if any submissions are pending evaluation
  const hasPendingEvaluation = hasAnyPendingSubmissions(job.submissions);

  // Format the time remaining string
  const getTimeRemainingString = () => {
    if (!isOpen) return null;

    if (timeRemaining <= 0) {
      return <span><Clock size={14} className="inline-icon" /> Closing soon</span>;
    }

    if (isCritical) {
      // Less than 1 hour - show minutes only
      if (minutesRemaining <= 1) {
        return <span><Clock size={14} className="inline-icon" /> &lt;1m remaining</span>;
      }
      return <span><Clock size={14} className="inline-icon" /> {minutesRemaining}m remaining</span>;
    }

    if (isClosingSoon) {
      // Less than 24 hours - show hours and minutes
      if (minutesRemaining > 0) {
        return <span><Clock size={14} className="inline-icon" /> {hoursRemaining}h {minutesRemaining}m remaining</span>;
      }
      return <span><Clock size={14} className="inline-icon" /> {hoursRemaining}h remaining</span>;
    }

    // More than 24 hours - show days and hours
    if (hoursInDay > 0) {
      return <span>{daysRemaining}d {hoursInDay}h remaining</span>;
    }
    return <span>{daysRemaining}d remaining</span>;
  };

  // Check for validation issues - use live result if available, otherwise use cached
  const hasValidationIssues = validationResult
    ? !validationResult.valid
    : job.validationStatus?.hasIssues;
  const validationErrorCount = validationResult
    ? validationResult.errorCount
    : (job.validationStatus?.errorCount || 0);

  // Determine card border class: errors = red, warnings only = yellow
  const validationClass = hasValidationIssues
    ? (validationErrorCount > 0 ? 'has-errors' : 'has-warnings')
    : '';

  return (
    <Link to={`/bounty/${job.jobId}`} className={`bounty-card ${validationClass}`}>
      <div className="bounty-header">
        <h3>{job.title || `Job #${job.jobId}`}</h3>
        <div className="bounty-badges">
          {/* Status badge and validate button stacked vertically */}
          <div className="badge-stack">
            <span {...getBountyBadgeProps(status)}>
              {getBountyStatusLabel(status)}
            </span>
            <div className="validate-row">
              {/* Validation status indicator - next to validate button */}
              {validationResult ? (
                validationResult.valid ? (
                  <span
                    className="validation-success"
                    title="Evaluation package is valid"
                  >
                    <CheckCircle size={14} />
                  </span>
                ) : validationResult.errorCount > 0 ? (
                  <span
                    className="validation-error"
                    title={validationResult.message}
                  >
                    <AlertTriangle size={14} />
                  </span>
                ) : (
                  <span
                    className="validation-warning"
                    title={validationResult.message}
                  >
                    <AlertTriangle size={14} />
                  </span>
                )
              ) : hasValidationIssues ? (
                <span
                  className={validationErrorCount > 0 ? "validation-error" : "validation-warning"}
                  title={`This bounty has ${validationErrorCount} format issue(s) that may prevent submissions from being evaluated`}
                >
                  <AlertTriangle size={14} />
                </span>
              ) : null}
              <button
                className={`btn-validate ${validating ? 'validating' : ''} ${validationResult?.valid ? 'valid' : ''}`}
                onClick={handleValidate}
                disabled={validating}
                title={validating ? 'Validating...' : 'Check if evaluation package is properly formatted'}
              >
                {validating ? (
                  <RefreshCw size={12} className="spin" />
                ) : (
                  <ShieldCheck size={12} />
                )}
                <span className="btn-validate-text">
                  {validating ? 'Checking...' : 'Validate'}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
      {job.workProductType && (
        <div className="work-type-badge">{job.workProductType}</div>
      )}
      <p className="bounty-description">
        {(job.description || '').length > 150
          ? (job.description || '').substring(0, 150) + '...'
          : (job.description || '')}
      </p>
      <div className="bounty-footer">
        <div className="payout">
          <span className="label">Payout:</span>
          <span className="amount">
            {job.bountyAmount} ETH
            {job.bountyAmountUSD > 0 && (
              <small className="usd-amount"> (${job.bountyAmountUSD})</small>
            )}
          </span>
        </div>
        <div className="submissions">
          <span className="label">Submissions:</span>
          <span className="count">{job.submissionCount || 0}</span>
          {hasPendingEvaluation && (
            <span
              className="pending-indicator"
              title={getSubmissionStatusDescription('PendingVerdikta')}
              aria-label="Evaluation in progress"
            >
              <RefreshCw size={14} className="spin" />
            </span>
          )}
        </div>
      </div>
      <div className="bounty-meta">
        <div className="bounty-id">
          <span className="label">Bounty #</span>
          <span className="value">{job.onChainId ?? job.bountyId ?? '...'}</span>
        </div>
        <div className="threshold">
          <span className="label">Threshold:</span>
          <span className="value">{job.threshold}%</span>
        </div>
        <div className={`time-remaining ${isClosingSoon ? 'warning' : ''} ${isCritical ? 'critical' : ''} ${(isExpired || isClosed) ? 'closed' : ''}`}>
          {isAwarded ? (
            <span><Trophy size={14} className="inline-icon" /> Winner paid</span>
          ) : isClosed ? (
            <span><Lock size={14} className="inline-icon" /> Closed</span>
          ) : isExpired ? (
            <span><Clock size={14} className="inline-icon" /> Expired - needs closing</span>
          ) : (
            getTimeRemainingString()
          )}
        </div>
      </div>
      {job.creator && (
        <div className="bounty-creator">
          <User size={14} className="inline-icon" />
          <span className="label">Creator:</span>
          <span
            className="creator-link"
            role="link"
            tabIndex={0}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.open(`${getExplorerUrl()}/address/${job.creator}`, '_blank', 'noopener,noreferrer');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                window.open(`${getExplorerUrl()}/address/${job.creator}`, '_blank', 'noopener,noreferrer');
              }
            }}
          >
            {truncateAddress(job.creator)}
            <ExternalLink size={10} />
          </span>
        </div>
      )}
    </Link>
  );
}

export default Home;

