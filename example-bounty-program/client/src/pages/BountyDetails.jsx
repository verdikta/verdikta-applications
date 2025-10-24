import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiService } from '../services/api';
import { getContractService } from '../services/contractService';
import './BountyDetails.css';

function BountyDetails({ walletState }) {
  const { bountyId } = useParams();
  const [job, setJob] = useState(null);
  const [rubric, setRubric] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [closingBounty, setClosingBounty] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    loadJobDetails();
  }, [bountyId, retryCount]);

  const loadJobDetails = async () => {
    try {
      setLoading(true);
      setError(null);

      // Load job from API (includes rubric)
      const response = await apiService.getJob(bountyId, true);
      setJob(response.job);

      // Rubric content is already included if available
      if (response.job?.rubricContent) {
        setRubric(response.job.rubricContent);
      }

      // Load submissions
      if (response.job) {
        setSubmissions(response.job.submissions || []);
      }
    } catch (err) {
      console.error('Error loading job:', err);
      const errorMessage = err.response?.data?.details || err.message;
      
      // If job not found and we haven't retried too many times, retry after delay
      if (errorMessage.includes('not found') && retryCount < 10) {
        console.log(`Job not found, retrying... (attempt ${retryCount + 1}/10)`);
        setTimeout(() => {
          setRetryCount(prev => prev + 1);
        }, 3000); // Retry every 3 seconds
        setError('Waiting for blockchain sync... This may take a moment for newly created bounties.');
      } else if (retryCount >= 10) {
        setError('Job not found. The blockchain may still be syncing. Please try refreshing in a moment.');
      } else {
        setError(errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  // Check if job data is complete (has all required blockchain fields)
  const isJobDataComplete = (jobData) => {
    return jobData && 
           jobData.bountyAmount !== undefined && 
           jobData.threshold !== undefined && 
           jobData.submissionCloseTime !== undefined;
  };

  // Retry if data is incomplete
  useEffect(() => {
    if (job && !isJobDataComplete(job) && retryCount < 10) {
      console.log('Job data incomplete, retrying...', { 
        hasAmount: job.bountyAmount !== undefined,
        hasThreshold: job.threshold !== undefined, 
        hasDeadline: job.submissionCloseTime !== undefined 
      });
      
      const timer = setTimeout(() => {
        setRetryCount(prev => prev + 1);
      }, 3000);
      
      return () => clearTimeout(timer);
    }
  }, [job, retryCount]);

  /**
   * Close expired bounty - can be called by anyone after deadline
   */
  const handleCloseExpiredBounty = async () => {
    if (!walletState.isConnected) {
      alert('Please connect your wallet first');
      return;
    }

    const confirmed = window.confirm(
      'Close this expired bounty and return funds to the creator?\n\n' +
      'This will trigger a blockchain transaction that you must sign.'
    );

    if (!confirmed) return;

    try {
      setClosingBounty(true);
      setError(null);

      const contractService = getContractService();
      
      // Ensure connected
      if (!contractService.isConnected()) {
        await contractService.connect();
      }

      // Call contract
      const result = await contractService.closeExpiredBounty(parseInt(bountyId));
      
      console.log('✅ Bounty closed:', result);

      alert(
        '✅ Bounty closed successfully!\n\n' +
        `Transaction: ${result.txHash}\n\n` +
        'Funds have been returned to the creator. The page will refresh.'
      );

      // Reload job details
      await loadJobDetails();

    } catch (err) {
      console.error('Error closing bounty:', err);
      setError(err.message || 'Failed to close bounty');
      alert(`❌ Failed to close bounty: ${err.message}`);
    } finally {
      setClosingBounty(false);
    }
  };

  /**
   * Cancel bounty early (creator only)
   */
  const handleCancelBounty = async () => {
    if (!walletState.isConnected) {
      alert('Please connect your wallet first');
      return;
    }

    const confirmed = window.confirm(
      'Cancel this bounty and get your funds back?\n\n' +
      'This only works if:\n' +
      '• You are the creator\n' +
      '• Cancel lock period has passed\n' +
      '• No submissions exist'
    );

    if (!confirmed) return;

    try {
      setClosingBounty(true);
      setError(null);

      const contractService = getContractService();
      
      if (!contractService.isConnected()) {
        await contractService.connect();
      }

      const result = await contractService.cancelBounty(parseInt(bountyId));
      
      console.log('✅ Bounty cancelled:', result);

      alert(
        '✅ Bounty cancelled successfully!\n\n' +
        `Transaction: ${result.txHash}\n\n` +
        'Your funds have been returned. The page will refresh.'
      );

      await loadJobDetails();

    } catch (err) {
      console.error('Error cancelling bounty:', err);
      setError(err.message || 'Failed to cancel bounty');
      alert(`❌ Failed to cancel bounty: ${err.message}`);
    } finally {
      setClosingBounty(false);
    }
  };

  if (loading) {
    return (
      <div className="bounty-details">
        <div className="loading">
          <div className="spinner"></div>
          <p>
            {retryCount > 0 
              ? `Waiting for blockchain sync... (attempt ${retryCount}/10)` 
              : 'Loading bounty details...'}
          </p>
        </div>
      </div>
    );
  }

  // Show loading if data is incomplete
  if (job && !isJobDataComplete(job) && retryCount < 10) {
    return (
      <div className="bounty-details">
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading complete job data from blockchain... (attempt {retryCount}/10)</p>
        </div>
      </div>
    );
  }

  if (error && retryCount >= 10) {
    return (
      <div className="bounty-details">
        <div className="alert alert-error">
          <h2>⚠️ Job Not Found</h2>
          <p>{error}</p>
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <Link to="/" className="btn btn-primary">Back to Home</Link>
            <button 
              onClick={() => setRetryCount(0)} 
              className="btn btn-secondary"
            >
              🔄 Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (error && retryCount > 0) {
    return (
      <div className="bounty-details">
        <div className="loading">
          <div className="spinner"></div>
          <p style={{ marginTop: '1rem' }}>{error}</p>
          <small>Retrying automatically... ({retryCount}/10)</small>
        </div>
      </div>
    );
  }

  // Calculate time remaining
  const now = Math.floor(Date.now() / 1000);
  const timeRemaining = job?.submissionCloseTime ? job.submissionCloseTime - now : -1;
  const hoursRemaining = Math.max(0, Math.floor(timeRemaining / 3600));
  const isOpen = job?.status === 'OPEN' && timeRemaining > 0;
  const isExpired = job?.status === 'OPEN' && timeRemaining <= 0;
  const isCreator = walletState.isConnected && 
                    job?.creator?.toLowerCase() === walletState.address?.toLowerCase();

  // Check if there are any active submissions (PendingVerdikta status)
  const hasActiveSubmissions = submissions.some(s => s.status === 'PendingVerdikta');

  return (
    <div className="bounty-details">
      <div className="bounty-header">
        <div className="header-content">
          <h1>{job?.title || `Job #${bountyId}`}</h1>
          <span className={`status-badge status-${job?.status?.toLowerCase()}`}>
            {job?.status}
          </span>
          {job?.workProductType && (
            <span className="work-type-badge">{job.workProductType}</span>
          )}
        </div>
        <div className="bounty-stats">
          <div className="stat">
            <span className="label">Payout</span>
            <span className="value">
              {job?.bountyAmount ?? '...'} ETH
              {job?.bountyAmountUSD > 0 && (
                <small> (${job.bountyAmountUSD})</small>
              )}
            </span>
          </div>
          <div className="stat">
            <span className="label">Submissions</span>
            <span className="value">{job?.submissionCount ?? 0}</span>
          </div>
          <div className="stat">
            <span className="label">Threshold</span>
            <span className="value">{job?.threshold ?? '...'}%</span>
          </div>
          <div className="stat">
            <span className="label">Time Remaining</span>
            <span className="value">
              {!job?.submissionCloseTime ? (
                '...'
              ) : timeRemaining <= 0 ? (
                'Closed'
              ) : hoursRemaining < 24 ? (
                `${hoursRemaining}h`
              ) : (
                `${Math.floor(hoursRemaining / 24)}d ${hoursRemaining % 24}h`
              )}
            </span>
          </div>
        </div>
      </div>

      {job?.description && (
        <section className="description-section">
          <h2>Job Description</h2>
          <p>{job.description}</p>
        </section>
      )}

      {rubric && (
        <section className="rubric-section">
          <h2>Evaluation Criteria</h2>
          <p className="rubric-description">{rubric.description}</p>

          <div className="criteria-grid">
            {rubric.criteria?.map((criterion, index) => (
              <div key={index} className="criterion-card">
                <div className="criterion-header">
                  <h3>{criterion.id.replace(/_/g, ' ')}</h3>
                  {criterion.must && <span className="badge badge-must">MUST PASS</span>}
                  {!criterion.must && <span className="weight-badge">Weight: {criterion.weight}</span>}
                </div>
                <p>{criterion.description}</p>
              </div>
            ))}
          </div>

          {rubric.forbidden_content && rubric.forbidden_content.length > 0 && (
            <div className="forbidden-content">
              <h3>⚠️ Forbidden Content</h3>
              <ul>
                {rubric.forbidden_content.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="actions-section">
        <h2>Actions</h2>
        <div className="action-buttons">
          {/* Show submit button if bounty is open */}
          {isOpen && walletState.isConnected && (
            <Link to={`/bounty/${bountyId}/submit`} className="btn btn-primary btn-lg">
              Submit Work
            </Link>
          )}

          {isOpen && !walletState.isConnected && (
            <div className="alert alert-info">
              Connect your wallet to submit work
            </div>
          )}

          {/* Show completed message */}
          {job?.status === 'COMPLETED' && (
            <div className="alert alert-success">
              🎉 This job has been completed and a winner has been paid!
            </div>
          )}

          {/* Show cancelled message */}
          {job?.status === 'CANCELLED' && (
            <div className="alert alert-warning">
              This bounty has been cancelled and funds have been returned to the creator.
            </div>
          )}

          {/* Show close expired bounty button (anyone can call after deadline) */}
          {isExpired && walletState.isConnected && (
            <div className="expired-bounty-section">
              <div className="alert alert-warning">
                ⏰ This bounty has expired. 
                {hasActiveSubmissions ? (
                  <span> Active evaluations must be finalized before closing.</span>
                ) : (
                  <span> Anyone can close it to return funds to the creator.</span>
                )}
              </div>
              
              {!hasActiveSubmissions && (
                <button
                  onClick={handleCloseExpiredBounty}
                  disabled={closingBounty}
                  className="btn btn-warning"
                >
                  {closingBounty ? 'Closing...' : '🔒 Close Expired Bounty & Return Funds'}
                </button>
              )}
            </div>
          )}

          {/* Show creator cancel button (before deadline, no submissions) */}
          {isCreator && isOpen && job?.submissionCount === 0 && (
            <div className="creator-cancel-section">
              <button
                onClick={handleCancelBounty}
                disabled={closingBounty}
                className="btn btn-secondary"
              >
                {closingBounty ? 'Cancelling...' : 'Cancel Bounty (Creator Only)'}
              </button>
              <small className="help-text">
                Only available if cancel lock period has passed and no submissions exist
              </small>
            </div>
          )}
        </div>
      </section>

      <section className="submissions-section">
        <h2>Submissions ({submissions.length})</h2>
        {submissions.length > 0 ? (
          <div className="submissions-list">
            {submissions.map((submission) => (
              <SubmissionCard key={submission.submissionId} submission={submission} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <p>No submissions yet. Be the first!</p>
          </div>
        )}
      </section>
    </div>
  );
}

function SubmissionCard({ submission }) {
  return (
    <div className="submission-card">
      <div className="submission-header">
        <span className="hunter">{submission.hunter?.substring(0, 10)}...</span>
        <span className={`status-badge status-${submission.status?.toLowerCase()}`}>
          {submission.status}
        </span>
      </div>
      {submission.score && (
        <div className="score">
          Score: {submission.score}/100
        </div>
      )}
      <div className="submission-meta">
        <span>Submitted: {new Date(submission.submittedAt * 1000).toLocaleString()}</span>
      </div>
    </div>
  );
}

export default BountyDetails;

