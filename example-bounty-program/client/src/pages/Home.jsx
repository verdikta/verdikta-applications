import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link, useSearchParams, useLocation, useNavigationType } from 'react-router-dom';
import {
  Plus,
  HelpCircle,
  AlertTriangle,
  Bot,
  Lock,
  Clock,
  RefreshCw,
  Trophy,
  Search,
  ExternalLink,
  User,
  Check,
  CheckCircle,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  FileLock2,
  Eye,
} from 'lucide-react';
import { apiService } from '../services/api';
import { classMapService } from '../services/classMapService';
import { config } from '../config';
import {
  BountyStatus,
  getBountyStatusLabel,
  getBountyBadgeProps,
  getBountyStatusIcon,
  isSubmissionPending,
  isSubmissionOnChain,
  hasAnyPendingSubmissions,
} from '../utils/statusDisplay';
import { StatusIcon } from '../components/StatusIcon';
import { formatUsd, fetchEthUsdPrice } from '../utils/usd';
import './Home.css';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // How often to refresh jobs list when there are pending submissions (15 seconds)
  AUTO_REFRESH_INTERVAL_MS: 15000,
};

// Values of the status dropdown other than '' (All Active)
const STATUS_FILTERS = ['OPEN', 'EXPIRED', 'UNCLAIMED', 'AWARDED', 'CLOSED'];
const PAGE_SIZES = [15, 50, 100];

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

// Sourcify's listing of the escrow's verified source for the current network
const getVerifiedSourceUrl = () => {
  const network = config.networks[config.network] || config.networks['base-sepolia'];
  return `https://repo.sourcify.dev/${network.chainId}/${config.bountyEscrowAddress}`;
};


function Home({ walletState }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Filters and pagination live in the query string (e.g. /?status=AWARDED&page=2)
  // so the browser's Back button from a bounty returns to the same listing.
  const [searchParams, setSearchParams] = useSearchParams();
  const statusParam = String(searchParams.get('status') || '').toUpperCase();
  const searchParam = searchParams.get('q') || '';
  const minPayoutParam = searchParams.get('min') || '';
  const filters = useMemo(() => ({
    status: STATUS_FILTERS.includes(statusParam) ? statusParam : '',
    search: searchParam,
    minPayout: minPayoutParam,
  }), [statusParam, searchParam, minPayoutParam]);
  const currentPage = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  const pageSize = PAGE_SIZES.includes(Number(searchParams.get('per')))
    ? Number(searchParams.get('per'))
    : PAGE_SIZES[0];

  // Merge query-string updates, dropping empty/default values. replace keeps
  // filter edits (including each keystroke in search) out of browser history.
  const updateParams = useCallback((updates) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(updates)) {
        if (value === '' || value == null) next.delete(key);
        else next.set(key, String(value));
      }
      if (next.get('page') === '1') next.delete('page');
      if (next.get('per') === String(PAGE_SIZES[0])) next.delete('per');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  // The text inputs keep their own state: React Router applies URL updates in a
  // transition, and binding a text box straight to it can drop keystrokes. Pick
  // up URL changes made elsewhere (e.g. the header logo link to "/"); our own
  // updates are REPLACE navigations.
  const location = useLocation();
  const navigationType = useNavigationType();
  const [searchInput, setSearchInput] = useState(filters.search);
  const [minPayoutInput, setMinPayoutInput] = useState(filters.minPayout);
  useEffect(() => {
    if (navigationType === 'REPLACE') return;
    setSearchInput(filters.search);
    setMinPayoutInput(filters.minPayout);
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore the scroll position on Back/Forward. The list loads asynchronously,
  // so the browser's own restoration finds a short page; remember each history
  // entry's position here and reapply it once the jobs have rendered.
  const scrollKey = `home-scroll:${location.key}`;
  const restoreScrollKeyRef = useRef(navigationType === 'POP' ? location.key : null);
  useEffect(() => {
    let frame = 0;
    const save = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Skip scroll events caused by leaving the page (removed or shortened
        // DOM), and the browser's clamped restore while a restore is pending
        if (!bountyGridRef.current?.isConnected || restoreScrollKeyRef.current) return;
        try { sessionStorage.setItem(scrollKey, String(window.scrollY)); } catch { /* storage unavailable */ }
      });
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', save);
    };
  }, [scrollKey]);

  useEffect(() => {
    if (loading || restoreScrollKeyRef.current !== location.key) return;
    restoreScrollKeyRef.current = null;
    let y = 0;
    try { y = Number(sessionStorage.getItem(scrollKey)) || 0; } catch { /* storage unavailable */ }
    if (y > 0) window.scrollTo(0, y);
  }, [loading, location.key, scrollKey]);

  const setCurrentPage = (update) => {
    const page = typeof update === 'function' ? update(currentPage) : update;
    updateParams({ page });
  };
  // Recent ETH/USD price (server proxy: Coinbase, CoinGecko fallback; 1-min cache) for approximate payout values
  const [ethPrice, setEthPrice] = useState(0);
  // Class IDs in the Verdikta class registry; bounties on any other class get a
  // "Custom class" badge (classes are permissionless). null until loaded.
  const [registryClassIds, setRegistryClassIds] = useState(null);

  // Refs for auto-refresh and scroll
  const autoRefreshIntervalRef = useRef(null);
  const isMountedRef = useRef(true);
  const bountyGridRef = useRef(null);

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
      } else if (statusUpper === 'UNCLAIMED') {
        filterParams.submissionStatus = 'ACCEPTED_PENDING_CLAIM';
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

  // Fetch a recent ETH/USD price once on mount so cards can show approximate
  // USD payout values. One rate applies to all cards; degrades gracefully to
  // ETH-only if the price feed is unavailable (price stays 0).
  useEffect(() => {
    let cancelled = false;
    fetchEthUsdPrice().then((usd) => { if (!cancelled && usd > 0) setEthPrice(usd); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    classMapService.getClasses()
      .then((classes) => {
        if (!cancelled) setRegistryClassIds(new Set((classes || []).map((c) => Number(c.id))));
      })
      .catch(() => { /* no badge without the registry list */ });
    return () => { cancelled = true; };
  }, []);

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

  const FILTER_PARAM = { status: 'status', search: 'q', minPayout: 'min' };

  const handleFilterChange = (key, value) => {
    if (key === 'search') setSearchInput(value);
    if (key === 'minPayout') setMinPayoutInput(value);
    updateParams({ [FILTER_PARAM[key]]: value, page: null });
  };

  const clearFilters = () => {
    setSearchInput('');
    setMinPayoutInput('');
    updateParams({ status: null, q: null, min: null, page: null });
  };

  // Scroll to top of grid when page changes (but not on initial load).
  // Compare against previous value so the guard survives StrictMode's
  // intentional double-invocation of effects in dev.
  const prevPageRef = useRef(currentPage);
  useEffect(() => {
    if (prevPageRef.current === currentPage) return;
    prevPageRef.current = currentPage;
    if (bountyGridRef.current) {
      bountyGridRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [currentPage]);

  // Pagination
  const totalPages = Math.ceil(jobs.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedJobs = jobs.slice(startIndex, startIndex + pageSize);

  return (
    <div className="home">
      <div className="hero">
        <h1>AI-Powered Bounty Program</h1>
        <p className="hero-subtitle">
          Bounties held in escrow and judged by AI. Submit work, pass the rubric, earn ETH automatically.
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
        <ul className="hero-guarantees">
          <li><Lock size={14} /> Funds held by a smart contract</li>
          <li><FileLock2 size={14} /> No cancel or edit function</li>
          <li><Bot size={14} /> Judged by an AI jury, not the creator</li>
          <li>
            <a href="https://verdikta.org/how-it-works" target="_blank" rel="noopener noreferrer">
              How Verdikta judges <ExternalLink size={12} />
            </a>
          </li>
        </ul>
      </div>

      <section className="bounties-section" ref={bountyGridRef}>
        <div className="section-header">
          <h2>
            Available Jobs
            {!loading && !error && (
              <span className="bounty-count" aria-label={`${jobs.length} jobs`}>
                {jobs.length}
              </span>
            )}
            {ethPrice > 0 && (
              <span
                className="eth-rate-note"
                title="Approximate USD values use a recent ETH/USD spot price"
              >
                ETH ≈ {formatUsd(ethPrice)}
              </span>
            )}
          </h2>
          <div className="filters">
            <input
              type="text"
              placeholder="Search jobs..."
              value={searchInput}
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
              <option value="UNCLAIMED">Unclaimed</option>
              <option value="AWARDED">Awarded</option>
              <option value="CLOSED">Closed</option>
            </select>
            <input
              type="number"
              placeholder="Min ETH"
              value={minPayoutInput}
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
          <>
            <div className="bounty-grid">
              {paginatedJobs.map(job => (
                <JobCard key={job.jobId} job={job} ethPrice={ethPrice} registryClassIds={registryClassIds} />
              ))}
            </div>
            <div className="pagination">
              <div className="pagination-info">
                Showing {startIndex + 1}–{Math.min(startIndex + pageSize, jobs.length)} of {jobs.length}
              </div>
              <div className="pagination-controls">
                <button
                  className="btn-page"
                  onClick={() => setCurrentPage(p => p - 1)}
                  disabled={currentPage <= 1}
                >
                  <ChevronLeft size={16} /> Previous
                </button>
                <span className="page-indicator">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  className="btn-page"
                  onClick={() => setCurrentPage(p => p + 1)}
                  disabled={currentPage >= totalPages}
                >
                  Next <ChevronRight size={16} />
                </button>
              </div>
              <div className="page-size-selector">
                <label>Per page:</label>
                <select
                  value={pageSize}
                  onChange={(e) => updateParams({ per: e.target.value, page: null })}
                >
                  {PAGE_SIZES.map(size => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </div>
            </div>
          </>
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
            <h3>AI Jury Evaluates</h3>
            <p>An AI jury grades each submission against the rubric. Where a bounty has an approval window, the creator can approve early</p>
          </div>
          <div className="step">
            <div className="step-number">4</div>
            <h3>Auto Payment</h3>
            <p>Passing work is paid in ETH automatically from escrow</p>
          </div>
        </div>
      </section>

      <section id="guarantees" className="features">
        <h2>Trustless by Design</h2>
        <div className="feature-grid">
          <div className="feature">
            <div className="feature-icon"><Lock size={32} /></div>
            <h3>Funds Locked</h3>
            <p>
              The payout is held by a smart contract from the moment a bounty is created. It is
              released only to a winning hunter, or back to the creator after the deadline if
              nobody wins.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon"><FileLock2 size={32} /></div>
            <h3>Terms Fixed</h3>
            <p>
              The escrow contract has no function to cancel or edit a bounty. Payout, criteria,
              jury, pass threshold and deadline are set once, at creation.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon"><Bot size={32} /></div>
            <h3>Judged by AI</h3>
            <p>
              Work is graded against the published rubric by a jury of AI models on the Verdikta
              arbiter network. The creator cannot reject work; where a bounty has an approval
              window, they can only approve early.
            </p>
          </div>
          <div className="feature">
            <div className="feature-icon"><Eye size={32} /></div>
            <h3>Verifiable</h3>
            <p>
              The contract source is public and verified, and every score and payout is recorded
              on-chain.
            </p>
          </div>
        </div>
        <p className="guarantees-links">
          {config.bountyEscrowAddress && (
            <>
              <a href={`${getExplorerUrl()}/address/${config.bountyEscrowAddress}`} target="_blank" rel="noopener noreferrer">
                Escrow contract <ExternalLink size={12} />
              </a>
              <a href={getVerifiedSourceUrl()} target="_blank" rel="noopener noreferrer">
                Verified source <ExternalLink size={12} />
              </a>
            </>
          )}
          <a href="https://verdikta.org/how-it-works" target="_blank" rel="noopener noreferrer">
            How Verdikta works <ExternalLink size={12} />
          </a>
        </p>
        <p className="guarantees-caveat">
          These guarantees are how the system is designed, and are enforced by open-source contract
          code that anyone can read and verify. Like all software, smart contracts can contain bugs,
          and AI judgment can be wrong. Use at your own risk.
        </p>
      </section>
    </div>
  );
}

// Job Card Component
function JobCard({ job, ethPrice, registryClassIds }) {
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  // Oracle-pool check (arbiters eligible under the bounty's oracle settings) — runs
  // alongside validation; degrades silently when the keeper is unreadable.
  const [oracleCheck, setOracleCheck] = useState(null);

  // Handler for running validation
  const handleValidate = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (validating) return;

    setValidating(true);
    setValidationResult(null);
    setOracleCheck(null);

    // Fire the oracle-pool check in parallel; it never blocks the package validation.
    apiService.getOracleCheck(job.jobId)
      .then((oc) => setOracleCheck(oc && oc.available ? oc : null))
      .catch(() => setOracleCheck(null));

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
        message = `${errorCount} error(s): ${errorMessages || 'Unknown'}`;
      } else if (warningCount > 0) {
        const warningMessages = issues
          .filter(i => i.severity === 'warning')
          .map(i => i.message)
          .join('; ');
        message = `${warningCount} warning(s): ${warningMessages}`;
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
  // EXPIRED/AWARDED/CLOSED are terminal — the bounty can no longer accept
  // submissions or pay out, so the Validate button is replaced with a neutral
  // "Completed" badge. Mirrors TERMINAL_BOUNTY_STATUSES on the server side.
  const isTerminal = isAwarded || isClosed || isExpired;

  // Pending-on-chain: API-created but not yet confirmed by the sync service
  // and not marked ORPHANED. Shown briefly (< 1h) while the creation tx is
  // still confirming; after 1h the server-side ghost filter hides it. Submits
  // against a pending bounty would revert on-chain, so warn before the click.
  const isPendingOnChain = isOpen && !job.syncedFromBlockchain && !job.onChain;

  // Less than 24 hours = closing soon (show warning style)
  const isClosingSoon = isOpen && timeRemaining > 0 && hoursRemaining < 24;
  // Less than 1 hour = critical (show minutes)
  const isCritical = isOpen && timeRemaining > 0 && hoursRemaining < 1;

  // Check if any submissions are pending evaluation or pending claim
  const hasAcceptedPendingClaim = (job.submissions || []).some(
    s => s.status === 'ACCEPTED_PENDING_CLAIM'
  );
  const hasRejectedPendingFinalization = (job.submissions || []).some(
    s => s.status === 'REJECTED_PENDING_FINALIZATION'
  );
  const pendingEvaluationCount = (job.submissions || []).filter(
    s => isSubmissionOnChain(s.status) && isSubmissionPending(s.status)
  ).length;
  const hasIncompleteEvaluation = pendingEvaluationCount > 0;
  const hasPendingEvaluation = hasIncompleteEvaluation ||
    hasAcceptedPendingClaim || hasRejectedPendingFinalization;

  // How long ago the bounty expired (negative timeRemaining means expired)
  const minutesSinceExpiry = timeRemaining < 0 ? Math.abs(timeRemaining) / 60 : 0;
  const expiredOverTenMin = isExpired && minutesSinceExpiry > 10;

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
            <span {...getBountyBadgeProps(hasAcceptedPendingClaim ? 'AWARDED' : status)}>
              {hasAcceptedPendingClaim ? 'Accepted' : getBountyStatusLabel(status)}
            </span>
            {job.targetHunter && (
              <span className="badge badge-targeted" title={`Targeted to ${job.targetHunter}`}>
                Targeted
              </span>
            )}
            {registryClassIds && job.classId != null && !registryClassIds.has(Number(job.classId)) && (
              <span
                className="badge badge-custom-class"
                title={`Class ${job.classId} isn't in the Verdikta class registry, so its jury wasn't checked against a model list. Open the bounty to see who can evaluate it.`}
              >
                Custom class
              </span>
            )}
            {job.creatorAssessmentWindowSize > 0 && (
              <span
                className="badge badge-windowed"
                title={`Creator approval window: ${
                  job.creatorAssessmentWindowSize >= 3600
                    ? (job.creatorAssessmentWindowSize / 3600).toFixed(1) + 'h'
                    : Math.round(job.creatorAssessmentWindowSize / 60) + 'm'
                } (creator: ${job.creatorDeterminationPayment ?? '?'} ETH / arbiters: ${job.arbiterDeterminationPayment ?? '?'} ETH)`}
              >
                <Clock size={12} style={{ verticalAlign: 'middle', marginRight: '2px' }} />
                Windowed
              </span>
            )}
            {isPendingOnChain && (
              <span
                className="badge badge-pending"
                title="This bounty's on-chain transaction has not yet been confirmed. Submissions will fail until confirmation. If this persists beyond ~1 hour the bounty will be removed automatically."
              >
                <RefreshCw size={12} style={{ verticalAlign: 'middle', marginRight: '2px' }} />
                Pending on-chain
              </span>
            )}
            {isTerminal ? (
              <span
                className="badge badge-completed"
                title={isAwarded
                  ? 'Awarded — this bounty has been paid out and is no longer actionable.'
                  : isClosed
                    ? 'Closed — this bounty expired without a winner; funds returned to the creator.'
                    : 'Expired — submission window has passed.'}
              >
                <Check size={12} style={{ verticalAlign: 'middle', marginRight: '2px' }} />
                Completed
              </span>
            ) : (
            <div className="validate-row">
              {/* Validation status indicator - next to validate button */}
              {validationResult ? (
                validationResult.valid && !validationResult.warningCount ? (
                  <span
                    className="validation-success"
                    title="Evaluation package is valid"
                  >
                    <CheckCircle size={14} />
                  </span>
                ) : validationResult.valid && validationResult.warningCount > 0 ? (
                  <span
                    className="validation-warning"
                    title={validationResult.message || `Valid with ${validationResult.warningCount} warning(s)`}
                  >
                    <AlertTriangle size={14} />
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
                  title={
                    validationErrorCount > 0
                      ? `${validationErrorCount} error(s): ${(job.validationStatus?.errorMessages || []).join('; ') || 'Unknown'}`
                      : `${job.validationStatus?.warningMessages?.length || 0} warning(s): ${(job.validationStatus?.warningMessages || []).join('; ') || 'Unknown'}`
                  }
                >
                  <AlertTriangle size={14} />
                </span>
              ) : null}
              <button
                className={`btn-validate ${validating ? 'validating' : ''} ${validationResult?.valid && !validationResult?.warningCount ? 'valid' : ''} ${validationResult?.valid && validationResult?.warningCount > 0 ? 'warning' : ''} ${validationResult && !validationResult.valid ? 'invalid' : ''}`}
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
            )}
          </div>
        </div>
      </div>
      {oracleCheck && (
        <div
          className={`oracle-check-block ${oracleCheck.warnings?.length ? 'has-warnings' : 'ok'}`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          title="Arbiter pool for this bounty's class under its oracle settings (fee ceiling, alpha, price boost)"
        >
          <div className="oracle-check-summary">
            {oracleCheck.warnings?.length ? <AlertTriangle size={12} /> : <CheckCircle size={12} />}
            <span>
              Oracle pool: {oracleCheck.eligibleCount}/{oracleCheck.totalInClass} arbiters eligible in class {oracleCheck.classId}
              {' '}({oracleCheck.distinctOwnersEligible} owner{oracleCheck.distinctOwnersEligible === 1 ? '' : 's'})
            </span>
          </div>
          {oracleCheck.warnings?.length > 0 && (
            <ul className="oracle-check-warnings">
              {oracleCheck.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}
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
          <span className="label">Payout</span>
          <span className="amount">
            {job.bountyAmount} ETH
            {formatUsd(Number(job.bountyAmount) * ethPrice) && (
              <small className="usd-amount">
                {' '}({formatUsd(Number(job.bountyAmount) * ethPrice, { approx: true })})
              </small>
            )}
          </span>
        </div>
        <div className="submissions">
          <span className="label">Submissions</span>
          <span className="count">{job.submissionCount || 0}</span>
          {hasPendingEvaluation && (!isExpired || hasIncompleteEvaluation || hasAcceptedPendingClaim) && (
            <span
              className={`pending-indicator${hasAcceptedPendingClaim ? ' accepted' : isExpired ? ' expired' : ''}`}
              title={hasAcceptedPendingClaim ? 'Accepted — Ready to Claim' : isExpired ? 'Evaluation pending — bounty expired' : pendingEvaluationCount === 1 ? 'A submission is being evaluated by the AI jury. This typically takes 2-4 minutes.' : 'Submissions are being evaluated by the AI jury. This typically takes 2-4 minutes.'}
              aria-label={hasAcceptedPendingClaim ? 'Accepted, pending claim' : isExpired ? 'Expired, evaluation pending' : 'Evaluation in progress'}
            >
              {hasAcceptedPendingClaim
                ? <CheckCircle size={14} />
                : expiredOverTenMin
                  ? <AlertTriangle size={14} />
                  : <RefreshCw size={14} className="spin" />
              }
            </span>
          )}
        </div>
      </div>
      <div className="bounty-meta">
        <div className="bounty-id">
          <span className="label">Bounty #</span>
          <span className="value">{job.jobId}</span>
        </div>
        <div className="threshold">
          <span className="label">Threshold</span>
          <span className="value">{job.threshold}%</span>
        </div>
        <div className={`time-remaining ${isClosingSoon ? 'warning' : ''} ${isCritical ? 'critical' : ''} ${(isExpired || isClosed) ? 'closed' : ''}`}>
          <span className="label">{(isAwarded || isClosed || isExpired) ? 'Status' : 'Time left'}</span>
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
      {job.createdAt && (
        <div className="bounty-created">
          <Clock size={14} className="inline-icon" />
          <span className="label">Created:</span>
          <span className="value">{new Date(job.createdAt * 1000).toLocaleString(undefined, { timeZoneName: 'short' })}</span>
        </div>
      )}
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

