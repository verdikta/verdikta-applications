import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiService } from '../services/api';
import { getContractService } from '../services/contractService';
import './BountyDetails.css';

function BountyDetails({ walletState }) {
  // URL param = backend jobId, NOT the on-chain id
  const { bountyId } = useParams();

  const [job, setJob] = useState(null);
  const [rubric, setRubric] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [closingBounty, setClosingBounty] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [finalizingSubmissions, setFinalizingSubmissions] = useState(new Set());
  const [failingSubmissions, setFailingSubmissions] = useState(new Set());

  // Resolution state for on-chain bountyId
  const [resolvedBountyId, setResolvedBountyId] = useState(null);
  const [resolvingId, setResolvingId] = useState(false);
  const [resolveNote, setResolveNote] = useState('');

  useEffect(() => {
    loadJobDetails();
    setResolvedBountyId(null);
    setResolvingId(false);
    setResolveNote('');
  }, [bountyId, retryCount]);

  const loadJobDetails = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await apiService.getJob(bountyId, true);
      setJob(response.job);

      if (response.job?.rubricContent) {
        setRubric(response.job.rubricContent);
      }
      if (response.job) {
        setSubmissions(response.job.submissions || []);
      }
    } catch (err) {
      console.error('Error loading job:', err);
      const errorMessage = err.response?.data?.details || err.message;

      if (errorMessage.includes('not found') && retryCount < 10) {
        console.log(`Job not found, retrying... (attempt ${retryCount + 1}/10)`);
        setTimeout(() => setRetryCount(prev => prev + 1), 3000);
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

  const isJobDataComplete = (jobData) =>
    jobData &&
    jobData.bountyAmount !== undefined &&
    jobData.threshold !== undefined &&
    jobData.submissionCloseTime !== undefined;

  useEffect(() => {
    if (job && !isJobDataComplete(job) && retryCount < 10) {
      console.log('Job data incomplete, retrying...', {
        hasAmount: job.bountyAmount !== undefined,
        hasThreshold: job.threshold !== undefined,
        hasDeadline: job.submissionCloseTime !== undefined
      });
      const timer = setTimeout(() => setRetryCount(prev => prev + 1), 3000);
      return () => clearTimeout(timer);
    }
  }, [job, retryCount]);

  // -------- Resolve on-chain bountyId (backend does it: tx -> state) --------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!job || resolvingId) return;

      // 1) Backend already has it (check BOTH bountyId and onChainId)
      if (job?.bountyId != null || job?.onChainId != null) {
        if (!cancelled) {
          setResolvedBountyId(Number(job?.onChainId ?? job?.bountyId));
          setResolveNote('');
        }
        return;
      }

      try {
        setResolvingId(true);

        // Required inputs
        const creator = job?.creator;
        const submissionCloseTime = job?.submissionCloseTime;
        const txHash =
          job?.txHash || job?.creationTxHash || job?.chainTxHash || job?.createTxHash || null;

        // Hard-fail early if we don't have what the backend needs
        if (!creator || !submissionCloseTime) {
          console.warn('[Resolver] missing inputs', { creator, submissionCloseTime });
          if (!cancelled) {
            setResolveNote('Missing data to resolve on-chain id (creator/deadline).');
          }
          return;
        }

        const payload = {
          creator,
          rubricCid: job?.rubricCid || undefined,
          submissionCloseTime,
          txHash: txHash || undefined
        };

        setResolveNote('Resolving from backend…');
        console.log('[DEBUG] Calling resolveJobBountyId', job.jobId, payload);

        const res = await apiService.resolveJobBountyId(job.jobId, payload);
        console.log('[DEBUG] resolveJobBountyId response', res);

        if (!cancelled) {
          if (res?.success && res?.bountyId != null) {
            setResolvedBountyId(Number(res.bountyId));
            setResolveNote('');
          } else {
            setResolveNote('Could not resolve automatically. Please refresh once the backend syncs.');
          }
        }
      } catch (e) {
        console.warn('[Resolver] backend resolve failed:', e?.message || e);
        if (e?.response?.data) console.warn('[Resolver] server says:', e.response.data);
        if (!cancelled) {
          setResolveNote('On-chain id resolution failed. Try refresh later.');
        }
      } finally {
        if (!cancelled) setResolvingId(false);
      }
    })();

    return () => { cancelled = true; };
  }, [job]);

  const getOnChainBountyId = () => {
    // First check onChainId (new standard)
    if (job?.onChainId != null && !Number.isNaN(Number(job.onChainId))) {
      return Number(job.onChainId);
    }
    // Then check bountyId (legacy field)
    if (job?.bountyId != null && !Number.isNaN(Number(job.bountyId))) {
      return Number(job.bountyId);
    }
    // Finally check resolved ID
    if (resolvedBountyId != null && !Number.isNaN(Number(resolvedBountyId))) {
      return Number(resolvedBountyId);
    }
    return null;
  };

  // Helper function to calculate submission age in minutes
  const getSubmissionAge = (submittedAt) => {
    const now = Math.floor(Date.now() / 1000);
    const ageMinutes = (now - submittedAt) / 60;
    return ageMinutes;
  };

  // -------- Actions --------
  const handleFinalizeSubmission = async (submissionId) => {
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
      `Finalize submission #${submissionId}?\n\n` +
      'This will read the Verdikta evaluation results and update the submission status.\n\n' +
      'This action requires a blockchain transaction that you must sign.'
    );
    if (!confirmed) return;

    try {
      setFinalizingSubmissions(prev => new Set(prev).add(submissionId));
      setError(null);

      const contractService = getContractService();
      if (!contractService.isConnected()) await contractService.connect();

      console.log('📤 Finalizing submission:', { bountyId: onChainId, submissionId });
      const result = await contractService.finalizeSubmission(onChainId, submissionId);

      alert(
        `✅ Submission #${submissionId} finalized!\n\n` +
        `Transaction: ${result.txHash}\n` +
        `Block: ${result.blockNumber}\n\n` +
        'The submission status has been updated. Refresh to see the changes.'
      );

      setRetryCount(0);
      await loadJobDetails();
    } catch (err) {
      console.error('❌ Error finalizing submission:', err);
      setError(err.message || 'Failed to finalize submission');
      alert(`❌ Failed to finalize submission #${submissionId}:\n\n${err.message}`);
    } finally {
      setFinalizingSubmissions(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
    }
  };

  const handleFailTimedOutSubmission = async (submissionId) => {
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
      `Force-fail submission #${submissionId}?\n\n` +
      'This submission has been stuck in evaluation for over 20 minutes.\n' +
      'This action will:\n' +
      '• Mark the submission as Failed (timeout)\n' +
      '• Refund LINK tokens to the submitter\n' +
      '• Allow the bounty to be closed\n\n' +
      'This requires a blockchain transaction that you must sign.'
    );
    if (!confirmed) return;

    try {
      setFailingSubmissions(prev => new Set(prev).add(submissionId));
      setError(null);

      const contractService = getContractService();
      if (!contractService.isConnected()) await contractService.connect();

      console.log('⏱️ Failing timed-out submission:', { bountyId: onChainId, submissionId });
      const result = await contractService.failTimedOutSubmission(onChainId, submissionId);

      alert(
        `✅ Submission #${submissionId} marked as Failed (timeout)!\n\n` +
        `Transaction: ${result.txHash}\n` +
        `Block: ${result.blockNumber}\n\n` +
        'LINK tokens have been refunded. Refresh to see the changes.'
      );

      setRetryCount(0);
      await loadJobDetails();
    } catch (err) {
      console.error('❌ Error failing timed-out submission:', err);
      setError(err.message || 'Failed to mark submission as timed-out');
      alert(`❌ Failed to timeout submission #${submissionId}:\n\n${err.message}`);
    } finally {
      setFailingSubmissions(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
    }
  };

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
      'Close this expired bounty and return funds to the creator?\n\nThis will trigger a blockchain transaction that you must sign.'
    );
    if (!confirmed) return;

    try {
      setClosingBounty(true);
      setError(null);

      const contractService = getContractService();
      if (!contractService.isConnected()) await contractService.connect();

      console.log('📤 closeExpiredBounty using on-chain id:', onChainId);
      const result = await contractService.closeExpiredBounty(onChainId);

      alert(
        '✅ Expired bounty closed successfully!\n\n' +
        `Transaction: ${result.txHash}\n` +
        `Block: ${result.blockNumber}\n\n` +
        `${job?.bountyAmount ?? '...'} ETH has been returned to the creator.\n\n` +
        'It may take a minute for the status to update.'
      );

      setRetryCount(0);
      await loadJobDetails();
    } catch (err) {
      console.error('❌ Error closing bounty:', err);
      setError(err.message || 'Failed to close bounty');
      alert(`❌ Failed to close bounty:\n\n${err.message}`);
    } finally {
      setClosingBounty(false);
    }
  };

  // -------- Derived UI state --------
  if (loading) {
    return (
      <div className="bounty-details">
        <div className="loading">
          <div className="spinner"></div>
          <p>{retryCount > 0 ? `Waiting for blockchain sync... (attempt ${retryCount}/10)` : 'Loading bounty details...'}</p>
        </div>
      </div>
    );
  }

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
            <button onClick={() => setRetryCount(0)} className="btn btn-secondary">🔄 Try Again</button>
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

  // Status-based UI logic (using four statuses: OPEN, EXPIRED, AWARDED, CLOSED)
  const status = job?.status || 'UNKNOWN';
  const now = Math.floor(Date.now() / 1000);
  const timeRemaining = job?.submissionCloseTime ? job.submissionCloseTime - now : -1;
  const hoursRemaining = Math.max(0, Math.floor(timeRemaining / 3600));

  // Determine what actions are available
  const isOpen = status === 'OPEN';
  const isExpired = status === 'EXPIRED';
  const isAwarded = status === 'AWARDED';
  const isClosed = status === 'CLOSED';

  // Check for active evaluations
  const hasActiveSubmissions = submissions.some(s =>
    s.status === 'PendingVerdikta' || s.status === 'PENDING_EVALUATION'
  );

  // Get list of pending submissions
  const pendingSubmissions = submissions.filter(s =>
    s.status === 'PendingVerdikta' || s.status === 'PENDING_EVALUATION'
  );

  const onChainIdForButtons = getOnChainBountyId();
  const disableActionsForMissingId = onChainIdForButtons == null;

  console.log('🔍 Bounty Status Check:', {
    urlParam_jobId: bountyId,
    backend_onChain_bountyId: job?.bountyId,
    backend_onChainId: job?.onChainId,
    resolvedBountyId,
    status,
    isOpen,
    isExpired,
    isAwarded,
    isClosed,
    hasActiveSubmissions,
    timeRemaining,
  });

  return (
    <div className="bounty-details">
      {/* EXPIRED Status Banner */}
      {isExpired && (
        <div style={{ backgroundColor: '#fff3cd', border: '3px solid #ffc107', padding: '1.5rem', borderRadius: '8px', marginBottom: '2rem', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
          <h2 style={{ margin: '0 0 1rem 0', color: '#856404' }}>⏰ Expired Bounty - Action Required</h2>
          <p style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>
            This bounty expired on {new Date((job.submissionCloseTime || 0) * 1000).toLocaleString()}.
            {!hasActiveSubmissions && (
              <strong> The escrow of {job.bountyAmount ?? '...'} ETH can now be returned to the creator.</strong>
            )}
          </p>

          {resolveNote && (
            <div className="alert alert-info" style={{ marginBottom: '0.75rem' }}>
              {resolveNote}
            </div>
          )}

          {/* Show pending submissions with finalize/timeout buttons */}
          {hasActiveSubmissions && walletState.isConnected && (
            <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
              <h4 style={{ margin: '0 0 0.75rem 0' }}>⚠️ Stuck Evaluations</h4>
              <p style={{ marginBottom: '0.75rem' }}>
                The following submissions are stuck in evaluation:
              </p>
              {pendingSubmissions.map(s => {
                const ageMinutes = getSubmissionAge(s.submittedAt);
                const canTimeout = ageMinutes > 20;
                const isFailing = failingSubmissions.has(s.submissionId);
                
                return (
                  <div key={s.submissionId} style={{ marginBottom: '1rem', padding: '0.75rem', backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: '0.9rem', color: '#666' }}>
                        Submission #{s.submissionId} by {s.hunter?.substring(0, 10)}...
                      </span>
                      <span style={{ fontSize: '0.85rem', color: '#888', marginLeft: 'auto' }}>
                        {Math.floor(ageMinutes)} min elapsed
                      </span>
                    </div>
                    
                    {canTimeout ? (
                      <button
                        onClick={() => handleFailTimedOutSubmission(s.submissionId)}
                        disabled={isFailing || disableActionsForMissingId}
                        className="btn btn-warning"
                        style={{ fontSize: '0.9rem', padding: '0.5rem 1rem', width: '100%' }}
                      >
                        {isFailing ? '⏳ Marking as Failed...' : `⏱️ Fail Timed-Out Submission (${Math.floor(ageMinutes)} min)`}
                      </button>
                    ) : (
                      <div style={{ fontSize: '0.85rem', color: '#666' }}>
                        ⏳ Evaluating... (timeout in {Math.ceil(20 - ageMinutes)} min)
                      </div>
                    )}
                  </div>
                );
              })}
              <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#666' }}>
                💡 Submissions stuck &gt;20 minutes can be marked as failed, allowing you to close the bounty.
              </p>
            </div>
          )}

          {!walletState.isConnected ? (
            <div className="alert alert-info">
              <strong>Connect your wallet</strong> to finalize submissions and close this bounty.
            </div>
          ) : hasActiveSubmissions ? (
            <div className="alert alert-info" style={{ marginTop: '0.75rem' }}>
              Finalize all pending submissions above before closing the bounty.
            </div>
          ) : (
            <>
              <button
                onClick={handleCloseExpiredBounty}
                disabled={closingBounty || disableActionsForMissingId}
                className="btn btn-warning btn-lg"
                style={{ width: '100%', fontSize: '1.2rem', padding: '1.25rem', fontWeight: 'bold' }}
                title={disableActionsForMissingId ? 'Resolving on-chain bountyId…' : undefined}
              >
                {closingBounty ? '⏳ Processing Transaction... (Check MetaMask)' : '🔒 Close Expired Bounty & Return Funds'}
              </button>
              {closingBounty && (
                <p style={{ marginTop: '0.5rem', textAlign: 'center', fontSize: '0.9rem', color: '#666' }}>
                  Waiting for blockchain confirmation...
                </p>
              )}
              {disableActionsForMissingId && !closingBounty && (
                <p style={{ marginTop: 8, color: '#666', fontSize: '0.9rem' }}>
                  Resolving on-chain bounty ID...
                </p>
              )}
            </>
          )}
        </div>
      )}

      <div className="bounty-header">
        <div className="header-content">
          <h1>{job?.title || `Job #${bountyId}`}</h1>
          <span className={`status-badge status-${status.toLowerCase()}`}>{status}</span>
          {job?.workProductType && <span className="work-type-badge">{job.workProductType}</span>}
        </div>
        <div className="bounty-stats">
          <div className="stat">
            <span className="label">Payout</span>
            <span className="value">
              {job?.bountyAmount ?? '...'} ETH
              {job?.bountyAmountUSD > 0 && (<small> (${job.bountyAmountUSD})</small>)}
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
              {!job?.submissionCloseTime ? '...' :
                isExpired || isClosed || isAwarded ? 'Ended' :
                hoursRemaining < 24 ? `${hoursRemaining}h` :
                `${Math.floor(hoursRemaining / 24)}d ${hoursRemaining % 24}h`}
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
              <ul>{rubric.forbidden_content.map((item, index) => (<li key={index}>{item}</li>))}</ul>
            </div>
          )}
        </section>
      )}

      <section className="actions-section">
        <h2>Actions</h2>
        <div className="action-buttons">
          {/* OPEN: Show submit button */}
          {isOpen && walletState.isConnected && (
            <Link to={`/bounty/${bountyId}/submit`} className="btn btn-primary btn-lg">
              Submit Work
            </Link>
          )}

          {isOpen && !walletState.isConnected && (
            <div className="alert alert-info">Connect your wallet to submit work</div>
          )}

          {/* AWARDED: Show completion message */}
          {isAwarded && (
            <div className="alert alert-success">
              🎉 This bounty has been completed and the winner has been paid {job?.bountyAmount ?? '...'} ETH!
            </div>
          )}

          {/* CLOSED: Show closed message */}
          {isClosed && (
            <div className="alert alert-info">
              This bounty has been closed and {job?.bountyAmount ?? '...'} ETH has been returned to the creator.
            </div>
          )}

          {/* EXPIRED: Show close action with finalize/timeout buttons */}
          {isExpired && (
            <div className="expired-bounty-section" style={{ backgroundColor: '#fff3cd', border: '2px solid #ffc107', padding: '1.5rem', borderRadius: '8px', marginTop: '1rem' }}>
              <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
                ⏰ <strong>This bounty has expired</strong> (deadline: {new Date((job.submissionCloseTime || 0) * 1000).toLocaleDateString()}).
                {hasActiveSubmissions ? (
                  <div style={{ marginTop: '0.5rem' }}>Active evaluations must be finalized before closing.</div>
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
              ) : hasActiveSubmissions ? (
                <>
                  <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
                    <h4 style={{ margin: '0 0 0.75rem 0' }}>⚠️ Stuck Evaluations</h4>
                    <p style={{ marginBottom: '0.75rem' }}>
                      Handle these submissions to close the bounty:
                    </p>
                    {pendingSubmissions.map(s => {
                      const ageMinutes = getSubmissionAge(s.submittedAt);
                      const canTimeout = ageMinutes > 20;
                      const isFailing = failingSubmissions.has(s.submissionId);
                      
                      return (
                        <div key={s.submissionId} style={{ marginBottom: '1rem', padding: '0.75rem', backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: '4px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                            <span style={{ fontSize: '0.9rem', color: '#666' }}>
                              Submission #{s.submissionId} by {s.hunter?.substring(0, 10)}...
                            </span>
                            <span style={{ fontSize: '0.85rem', color: '#888', marginLeft: 'auto' }}>
                              {Math.floor(ageMinutes)} min elapsed
                            </span>
                          </div>
                          
                          {canTimeout ? (
                            <button
                              onClick={() => handleFailTimedOutSubmission(s.submissionId)}
                              disabled={isFailing || disableActionsForMissingId}
                              className="btn btn-warning"
                              style={{ fontSize: '0.9rem', padding: '0.5rem 1rem', width: '100%' }}
                            >
                              {isFailing ? '⏳ Marking as Failed...' : `⏱️ Fail Timed-Out Submission`}
                            </button>
                          ) : (
                            <div style={{ fontSize: '0.85rem', color: '#666' }}>
                              ⏳ Evaluating... (timeout available in {Math.ceil(20 - ageMinutes)} min)
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <button
                    onClick={handleCloseExpiredBounty}
                    disabled={closingBounty || disableActionsForMissingId}
                    className="btn btn-warning btn-lg"
                    style={{ width: '100%', fontSize: '1.1rem', padding: '1rem' }}
                    title={disableActionsForMissingId ? 'Resolving on-chain bountyId…' : undefined}
                  >
                    {closingBounty ? '⏳ Processing Transaction... (Check MetaMask)' : '🔒 Close Expired Bounty & Return Funds to Creator'}
                  </button>
                  {disableActionsForMissingId && (
                    <small style={{ display: 'block', marginTop: 8, color: '#666' }}>
                      Resolving on-chain bounty ID. If this job was just created, wait a moment or refresh.
                    </small>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="submissions-section">
        <h2>Submissions ({submissions.length})</h2>
        {submissions.length > 0 ? (
          <div className="submissions-list">
            {submissions.map((submission) => (
              <SubmissionCard 
                key={submission.submissionId} 
                submission={submission}
                walletState={walletState}
                onChainBountyId={onChainIdForButtons}
                onFailTimeout={handleFailTimedOutSubmission}
                isFailing={failingSubmissions.has(submission.submissionId)}
                disableActions={disableActionsForMissingId}
                getSubmissionAge={getSubmissionAge}
              />
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

function SubmissionCard({ submission, walletState, onChainBountyId, onFailTimeout, isFailing, disableActions, getSubmissionAge }) {
  const isPending = submission.status === 'PENDING_EVALUATION' || submission.status === 'PendingVerdikta';
  const ageMinutes = isPending ? getSubmissionAge(submission.submittedAt) : 0;
  const canTimeout = ageMinutes > 20;

  return (
    <div className="submission-card">
      <div className="submission-header">
        <span className="hunter">{submission.hunter?.substring(0, 10)}...</span>
        <span className={`status-badge status-${submission.status?.toLowerCase()}`}>{submission.status}</span>
      </div>
      {submission.score && <div className="score">Score: {submission.score}/100</div>}
      <div className="submission-meta">
        <span>Submitted: {new Date(submission.submittedAt * 1000).toLocaleString()}</span>
      </div>
      
      {/* Show timeout button for stuck submissions */}
      {isPending && walletState.isConnected && (
        <div style={{ marginTop: '0.75rem' }}>
          {canTimeout ? (
            <button
              onClick={() => onFailTimeout(submission.submissionId)}
              disabled={isFailing || disableActions}
              className="btn btn-warning btn-sm"
              style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem', width: '100%' }}
            >
              {isFailing ? '⏳ Marking as Failed...' : `⏱️ Fail Timed-Out (${Math.floor(ageMinutes)} min)`}
            </button>
          ) : (
            <div style={{ fontSize: '0.8rem', color: '#888', textAlign: 'center' }}>
              ⏳ Evaluating... ({Math.floor(ageMinutes)} min, timeout in {Math.ceil(20 - ageMinutes)} min)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default BountyDetails;

