import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiService } from '../services/api';
import './Home.css';

function Home({ walletState }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({
    status: '',
    search: '',
    minPayout: ''
  });

  useEffect(() => {
    loadJobs();
  }, [filters]);

  const loadJobs = async () => {
    try {
      setLoading(true);
      setError(null);

      // Build filter params (only include non-empty values)
      const filterParams = {};
      if (filters.status) filterParams.status = filters.status;
      if (filters.search) filterParams.search = filters.search;
      if (filters.minPayout) filterParams.minPayout = filters.minPayout;

      const response = await apiService.listJobs(filterParams);
      setJobs(response.jobs || []);
    } catch (err) {
      console.error('Error loading jobs:', err);
      setError('Failed to load jobs. ' + err.message);
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };

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
          <Link to="/create" className="btn btn-primary btn-lg">
            Create Bounty
          </Link>
          <a href="#how-it-works" className="btn btn-secondary btn-lg">
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
              <option value="">All Status</option>
              <option value="OPEN">Open</option>
              <option value="COMPLETED">Completed</option>
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
            <p>⚠️ {error}</p>
          </div>
        )}

        {!loading && !error && jobs.length === 0 && (
          <div className="empty-state">
            <h3>No jobs found</h3>
            <p>
              {filters.status || filters.search || filters.minPayout
                ? 'Try adjusting your filters'
                : 'Be the first to create a job!'}
            </p>
            <Link to="/create" className="btn btn-primary">
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
            <h3>🤖 AI-Powered</h3>
            <p>Multiple AI models evaluate submissions for fairness and accuracy</p>
          </div>
          <div className="feature">
            <h3>⚡ Automatic</h3>
            <p>No manual review needed - payments happen automatically</p>
          </div>
          <div className="feature">
            <h3>🔒 Trustless</h3>
            <p>ETH locked in smart contract escrow until winner is determined</p>
          </div>
          <div className="feature">
            <h3>📊 Transparent</h3>
            <p>All evaluations and scores are publicly verifiable</p>
          </div>
        </div>
      </section>
    </div>
  );
}

// Job Card Component
function JobCard({ job }) {
  // Calculate time remaining
  const now = Math.floor(Date.now() / 1000);
  const timeRemaining = job.submissionCloseTime - now;
  const hoursRemaining = Math.max(0, Math.floor(timeRemaining / 3600));
  
  const isClosingSoon = hoursRemaining > 0 && hoursRemaining < 24;
  const isClosed = timeRemaining <= 0;

  return (
    <Link to={`/bounty/${job.jobId}`} className="bounty-card">
      <div className="bounty-header">
        <h3>{job.title || `Job #${job.jobId}`}</h3>
        <span className={`status-badge status-${job.status.toLowerCase()}`}>
          {job.status}
        </span>
      </div>
      {job.workProductType && (
        <div className="work-type-badge">{job.workProductType}</div>
      )}
      <p className="bounty-description">
        {job.description.length > 150
          ? job.description.substring(0, 150) + '...'
          : job.description}
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
        </div>
      </div>
      <div className="bounty-meta">
        <div className="threshold">
          <span className="label">Threshold:</span>
          <span className="value">{job.threshold}%</span>
        </div>
        <div className={`time-remaining ${isClosingSoon ? 'warning' : ''} ${isClosed ? 'closed' : ''}`}>
          {isClosed ? (
            <span>Submissions closed</span>
          ) : isClosingSoon ? (
            <span>⏰ {hoursRemaining}h remaining</span>
          ) : (
            <span>{Math.floor(hoursRemaining / 24)}d {hoursRemaining % 24}h remaining</span>
          )}
        </div>
      </div>
    </Link>
  );
}

export default Home;



