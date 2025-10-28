import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiService } from '../services/api';
import { getContractService, deriveBountyIdFromTx } from '../services/contractService';
import { config } from '../config';
import './BountyDetails.css';

function BountyDetails({ walletState }) {
  const { bountyId } = useParams(); // <-- backend jobId from the URL, NOT on-chain id
  const [job, setJob] = useState(null);
  const [rubric, setRubric] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [closingBounty, setClosingBounty] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // Fallback on-chain bountyId resolved from tx logs when backend hasn't saved it yet
  const [resolvedBountyId, setResolvedBountyId] = useState(null);
  const [resolvingId, setResolvingId] = useState(false);

  useEffect(() => {
    loadJobDetails();
    // reset resolver state when URL job changes
    setResolvedBountyId(null);
    setResolvingId(false);
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

  // --- Resolve on-chain bountyId from tx logs when backend didn't store it ---
  useEffect(() => {
    (async () => {
      if (!job) return;

      // If backend already has on-chain id, use it
      if (job?.bountyId != null) {
        setResolvedBountyId(Number(job.bountyId));
        return;
      }

      // Try to get a tx hash from common fields
      const txHash = job?.txHash || job?.creationTxHash || job?.chainTxHash || job?.createTxHash;
      if (!txHash || resolvingId) return;

      try {
        setResolvingId(true);
        const id = await deriveBountyIdFromTx(txHash, config.bountyEscrowAddress);
        setResolvedBountyId(Number(id));
        console.log('✅ Resolved on-chain bountyId from tx:', { txHash, id });
      } catch (e) {
        console.warn('Could not resolve on-chain bountyId:', e?.message || e);
      } finally {
        setResolvingId(false);
      }
    })();
  }, [job, resolvingId]);

  // Pick the correct on-chain id to use for contract calls; return null if unknown
  const getOnChainBountyId = () => {
    if (job?.bountyId != null && !Number.isNaN(Number(job.bountyId))) {
      return Number(job.bountyId);
    }
    if (resolvedBountyId != null && !Number.isNaN(Number(resolvedBountyId))) {
      return Number(resolvedBountyId);
    }
    return null;
  };

  /**
   * Close expired bounty - can be called by anyone after deadline
   */
  const handleCloseExpiredBounty = async () => {
    if (!walletState.isConnected) {
      alert('Please connect your wallet first');
      return;
    }

    const onChainId = getOnChainBountyId();
    if (onChainId == null) {
      alert('Unable to determine the on-chain bounty ID yet. Please wait for sync or refresh.');
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

      console.log('🔄 Starting close bounty transaction...');

      const contractService = getContractService();

      // Ensure connected
      if (!contractService.isConnected()) {
        console.log('🔌 Connecting to contract...');
        await contractService.connect();
      }

      console.log('📤 Calling closeExpiredBounty on contract...', {
        urlJobId: bountyId,
        backendOnChainBountyId: job?.bountyId,
        resolvedBountyId,
        usingId: onChainId
      });

      // Call contract with the true on-chain id
      const result = await contractService.closeExpiredBounty(onChainId);

      console.log('✅ Transaction confirmed!', result);

      alert(
        '✅ Expired bounty closed successfully!\n\n' +
        `Transaction: ${result.txHash}\n` +
        `Block: ${result.blockNumber}\n\n` +
        `${job?.bountyAmount ?? '...'} ETH has been returned to the creator.\n\n` +
        'Note: It may take 1-2 minutes for the blockchain sync to update the status. ' +
        'The page will now reload.'
      );

      // Reset retry counter to force fresh data load
      setRetryCount(0);

      // Reload job details (may take a few attempts while backend syncs)
      await loadJobDetails();

    } catch (err) {
      console.error('❌ Error closing bounty:', err);
      console.error('Error details:', {
        message: err.message,
        code: err.code,
        data: err.data,
        stack: err.stack
      });

      setError(err.message || 'Failed to close bounty');
      alert(`❌ Failed to close bounty:\n\n${err.message}`);
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

    const onChainId = getOnChainBountyId();
    if (onChainId == null) {
      alert('Unable to determine the on-chain bounty ID yet. Please wait for sync or refresh.');
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

      console.log('Cancelling bounty with ID (on-chain):', onChainId);

      const result = await contractService.cancelBounty(onChainId);

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

  // Bounty is expired/closed if: status is CLOSED OR (status is OPEN but deadline passed)
  const isExpired = job?.status === 'CLOSED' || (job?.status === 'OPEN' && timeRemaining <= 0);

  const isCreator = walletState.isConnected &&
                    job?.creator?.toLowerCase() === walletState.address?.toLowerCase();

  // Check if there are any active submissions (PendingVerdikta status)
  const hasActiveSubmissions = submissions.some(s => s.status === 'PendingVerdikta');

  // Debug logging
  console.log('🔍 Bounty Status Check:', {
    urlParam_jobId: bountyId,
    backend_onChain_bountyId: job?.bountyId,
    resolvedBountyId,
    status: job?.status,
    submissionCloseTime: job?.submissionCloseTime,
    timeRemaining,
    isOpen,
    isExpired,
    hasActiveSubmissions,
    showCloseButton: isExpired && job && !hasActiveSubmissions
  });

  const onChainIdForButtons = getOnChainBountyId();
  const disableActionsForMissingId = onChainIdForButtons == null;

  return (
    <div className="bounty-details">
      {/* Prominent Expired Bounty Alert */}
      {isExpired && job && (
        <div style={{
          backgroundColor: '#fff3cd',
          border: '3px solid #ffc107',
          padding: '1.5rem',
          borderRadius: '8px',
          marginBottom: '2rem',
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        }}>
          <h2 style={{ margin: '0 0 1rem 0', color: '#856404' }}>
            ⏰ Expired Bounty - Action Required
          </h2>
          <p style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>
            This bounty expired on {new Date((job.submissionCloseTime || 0) * 1000).toLocaleString()}.
            {!hasActiveSubmissions && (
              <strong> The escrow of {job.bountyAmount ?? '...'} ETH can now be returned to the creator.</strong>
            )}
          </p>

          {!walletState.isConnected ? (
            <div className="alert alert-info">
              <strong>Connect your wallet</strong> to close this bounty and return funds to the creator.
            </div>
          ) : hasActiveSubmissions ? (
            <div className="alert alert-warning">
              Active submissions are still being evaluated. They must be finalized before this bounty can be closed.
            </div>
          ) : (
            <>
              <button
                onClick={handleCloseExpiredBounty}
                disabled={closingBounty || disableActionsForMissingId}
                className="btn btn-warning btn-lg"
                style={{
                  width: '100%',
                  fontSize: '1.2rem',
                  padding: '1.25rem',
                  fontWeight: 'bold'
                }}
                title={disableActionsForMissingId ? 'Waiting for on-chain bountyId…' : undefined}
              >
                {closingBounty ? '⏳ Processing Transaction... (Check MetaMask)' : '🔒 Close Bounty & Return Funds'}
              </button>
              {disableActionsForMissingId && (
                <p style={{ marginTop: 8, color: '#666' }}>
                  Unable to determine on-chain bounty ID yet. If this job was just created, wait for sync or refresh.
                </p>
              )}
              {closingBounty && (
                <p style={{ marginTop: '0.5rem', textAlign: 'center', fontSize: '0.9rem', color: '#666' }}>
                  Waiting for blockchain confirmation...
                </p>
              )}
            </>
          )}
        </div>
      )}

      <div className="bounty-header">
        <div className="header-content">
          <h1>{job?.title || `Job #${bountyId}`}</h1>
          <span className={`status-badge status-${job?.status?.toLowerCase()}`}>
            {job?.status}
          </span>
          {isExpired && (
            <span className="status-badge" style={{
              backgroundColor: '#dc3545',
              color: 'white',
              fontWeight: 'bold',
              animation: 'pulse 2s infinite'
            }}>
              ⏰ EXPIRED
            </span>
          )}
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
          {isExpired && (
            <div className="expired-bounty-section" style={{
              backgroundColor: '#fff3cd',
              border: '2px solid #ffc107',
              padding: '1.5rem',
              borderRadius: '8px',
              marginTop: '1rem'
            }}>
              <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
                ⏰ <strong>This bounty has expired</strong> (deadline passed).
                {hasActiveSubmissions ? (
                  <div style={{ marginTop: '0.5rem' }}>
                    Active evaluations must be finalized before closing.
                  </div>
                ) : (
                  <div style={{ marginTop: '0.5rem' }}>
                    Anyone can close it to return <strong>{job?.bountyAmount ?? '...'} ETH</strong> to the creator.
                  </div>
                )}
              </div>

              {!walletState.isConnected ? (
                <div className="alert alert-info">
                  Connect your wallet to close this expired bounty and return funds to the creator.
                </div>
              ) : !hasActiveSubmissions ? (
                <>
                  <button
                    onClick={handleCloseExpiredBounty}
                    disabled={closingBounty || disableActionsForMissingId}
                    className="btn btn-warning btn-lg"
                    style={{ width: '100%', fontSize: '1.1rem', padding: '1rem' }}
                    title={disableActionsForMissingId ? 'Waiting for on-chain bountyId…' : undefined}
                  >
                    {closingBounty ? '⏳ Processing Transaction... (Check MetaMask)' : '🔒 Close Expired Bounty & Return Funds to Creator'}
                  </button>
                  {disableActionsForMissingId && (
                    <small style={{ display: 'block', marginTop: 8, color: '#666' }}>
                      Unable to determine on-chain bounty ID yet. If you created this job recently, wait for sync or refresh.
                    </small>
                  )}
                </>
              ) : (
                <div className="alert alert-info">
                  Waiting for active submissions to be finalized...
                </div>
              )}
            </div>
          )}

          {/* Show creator cancel button (before deadline, no submissions) */}
          {isCreator && isOpen && job?.submissionCount === 0 && (
            <div className="creator-cancel-section">
              <button
                onClick={handleCancelBounty}
                disabled={closingBounty || disableActionsForMissingId}
                className="btn btn-secondary"
                title={disableActionsForMissingId ? 'Waiting for on-chain bountyId…' : undefined}
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

