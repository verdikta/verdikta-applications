import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiService } from '../services/api';
import { getContractService } from '../services/contractService';
import './BountyDetails.css';

// Polling configuration
const POLL_INTERVAL_MS = 3000; // Poll every 3 seconds
const POLL_MAX_ATTEMPTS = 120; // Max 120 attempts = 6 minutes (to accommodate Verdikta evaluation time)
const PENDING_STATUSES = ['PENDING_EVALUATION', 'PendingVerdikta', 'Prepared'];

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
  // Polling state for submissions waiting for status update
  const [pollingSubmissions, setPollingSubmissions] = useState(new Map()); // submissionId -> { attempts, status }
  const pollingIntervalRef = useRef(null);

  // Resolution state for on-chain bountyId
  const [resolvedBountyId, setResolvedBountyId] = useState(null);
  const [resolvingId, setResolvingId] = useState(false);
  const [resolveNote, setResolveNote] = useState('');

  const loadJobDetails = useCallback(async () => {
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
  }, [bountyId, retryCount]);

  useEffect(() => {
    loadJobDetails();
    setResolvedBountyId(null);
    setResolvingId(false);
    setResolveNote('');
  }, [bountyId, retryCount, loadJobDetails]);

  const isJobDataComplete = (jobData) =>
    jobData &&
    jobData.bountyAmount !== undefined &&
    jobData.threshold !== undefined &&
    jobData.submissionCloseTime !== undefined;

  /**
   * Poll for submission status changes after finalization
   * Continues polling until status changes from pending or max attempts reached
   * 
   * IMPORTANT: Pass jobId explicitly to avoid closure issues with stale state
   */
  const pollSubmissionStatus = useCallback(async (jobId, submissionId, onStatusChange) => {
    console.log(`🔄 Starting to poll submission #${submissionId} status for job ${jobId}...`);
    
    if (!jobId) {
      console.error('❌ pollSubmissionStatus called without jobId!');
      return;
    }
    
    let attempts = 0;
    let lastStatus = null;
    
    const poll = async () => {
      attempts++;
      console.log(`📊 Poll attempt ${attempts}/${POLL_MAX_ATTEMPTS} for job ${jobId}, submission #${submissionId}`);
      
      // Update polling state with current attempt count
      setPollingSubmissions(prev => {
        const next = new Map(prev);
        next.set(submissionId, { attempts, maxAttempts: POLL_MAX_ATTEMPTS, status: 'polling' });
        return next;
      });
      
      try {
        // Call the refresh endpoint to get latest status from blockchain
        console.log(`🔍 Calling refreshSubmission(${jobId}, ${submissionId})...`);
        const result = await apiService.refreshSubmission(jobId, submissionId);
        console.log(`✅ Poll result for submission #${submissionId}:`, result);
        
        const newStatus = result.submission?.status;
        console.log(`📋 Status: ${lastStatus} -> ${newStatus}`);
        lastStatus = newStatus;
        
        // Check if status has changed from pending
        // Note: Contract status enum: 0=Prepared, 1=PendingVerdikta, 2=Failed, 3=PassedPaid, 4=PassedUnpaid
        // Backend maps these to: PENDING_EVALUATION, REJECTED, ACCEPTED, ACCEPTED
        if (newStatus && !PENDING_STATUSES.includes(newStatus)) {
          console.log(`🎉 Submission #${submissionId} status changed to: ${newStatus}`);
          console.log(`📊 Score: ${result.submission?.acceptance}%, Rejection: ${result.submission?.rejection}%`);
          
          // Update the submission in local state immediately
          setSubmissions(prevSubs => 
            prevSubs.map(s => 
              s.submissionId === submissionId 
                ? { ...s, ...result.submission }
                : s
            )
          );
          
          // Clear polling state for this submission
          setPollingSubmissions(prev => {
            const next = new Map(prev);
            next.delete(submissionId);
            return next;
          });
          
          // Notify callback
          if (onStatusChange) {
            onStatusChange(result.submission);
          }
          
          return true; // Done polling
        }
        
        // Still pending - continue polling if we haven't exceeded max attempts
        if (attempts >= POLL_MAX_ATTEMPTS) {
          console.log(`⏰ Max polling attempts reached for submission #${submissionId}`);
          setPollingSubmissions(prev => {
            const next = new Map(prev);
            next.set(submissionId, { attempts, maxAttempts: POLL_MAX_ATTEMPTS, status: 'timeout' });
            return next;
          });
          return true; // Stop polling (timeout)
        }
        
        // Schedule next poll
        return new Promise(resolve => {
          setTimeout(async () => {
            const done = await poll();
            resolve(done);
          }, POLL_INTERVAL_MS);
        });
        
      } catch (err) {
        console.error(`❌ Poll error for submission #${submissionId}:`, err);
        console.error('Error details:', {
          message: err.message,
          response: err.response?.data,
          status: err.response?.status
        });
        
        // On error, continue polling (blockchain might be slow)
        if (attempts >= POLL_MAX_ATTEMPTS) {
          setPollingSubmissions(prev => {
            const next = new Map(prev);
            next.set(submissionId, { attempts, maxAttempts: POLL_MAX_ATTEMPTS, status: 'error', error: err.message });
            return next;
          });
          return true; // Stop polling
        }
        
        // Continue polling
        return new Promise(resolve => {
          setTimeout(async () => {
            const done = await poll();
            resolve(done);
          }, POLL_INTERVAL_MS);
        });
      }
    };
    
    // Start polling
    await poll();
  }, []); // No dependencies - jobId is passed explicitly

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  // Auto-refresh: periodically check for status updates when there are pending submissions
  // This handles the case where evaluations complete without user interaction
  useEffect(() => {
    // Capture jobId to avoid closure issues
    const currentJobId = job?.jobId;
    
    const pendingSubmissionIds = submissions
      .filter(s => PENDING_STATUSES.includes(s.status))
      .map(s => s.submissionId);
    
    // Only auto-poll if there are pending submissions AND we're not already actively polling them
    const unpolliedPendingSubs = pendingSubmissionIds.filter(id => !pollingSubmissions.has(id));
    
    if (unpolliedPendingSubs.length === 0 || !currentJobId) {
      return;
    }

    console.log(`📊 Auto-refresh: Found ${unpolliedPendingSubs.length} pending submissions to monitor for job ${currentJobId}`);

    // Set up a background refresh interval (less aggressive than active polling)
    const autoRefreshInterval = setInterval(async () => {
      console.log(`🔄 Auto-refresh: Checking for status updates (job ${currentJobId})...`);
      
      let hasUpdates = false;
      
      for (const subId of unpolliedPendingSubs) {
        // Skip if we're now actively polling this submission
        if (pollingSubmissions.has(subId)) continue;
        
        try {
          console.log(`🔍 Auto-refresh: Checking submission #${subId}...`);
          const result = await apiService.refreshSubmission(currentJobId, subId);
          const newStatus = result.submission?.status;
          
          console.log(`📋 Auto-refresh: Submission #${subId} status: ${newStatus}`);
          
          if (newStatus && !PENDING_STATUSES.includes(newStatus)) {
            console.log(`🎉 Auto-refresh: Submission #${subId} status changed to ${newStatus}!`);
            hasUpdates = true;
          }
        } catch (err) {
          console.log(`⚠️ Auto-refresh error for submission #${subId}:`, err.message);
        }
      }
      
      // If any status changed, reload the full job details
      if (hasUpdates) {
        console.log('✅ Auto-refresh: Status changes detected, reloading job details...');
        loadJobDetails();
      }
    }, 10000); // Check every 10 seconds for better responsiveness

    return () => {
      clearInterval(autoRefreshInterval);
    };
  }, [submissions, job?.jobId, pollingSubmissions, loadJobDetails]);

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
      
      console.log('✅ Finalization transaction confirmed:', result.txHash);
      console.log('📋 TX Receipt:', {
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        gasUsed: result.gasUsed
      });
      
      // Wait a moment for the blockchain state to propagate
      console.log('⏳ Waiting for blockchain state to propagate...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Clear finalizing state - we'll now switch to polling state
      setFinalizingSubmissions(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });

      // Start polling for status update
      // IMPORTANT: Capture jobId before polling to avoid closure issues
      const currentJobId = job.jobId;
      console.log(`🔄 Starting to poll for status update (jobId: ${currentJobId}, submissionId: ${submissionId})...`);
      setPollingSubmissions(prev => {
        const next = new Map(prev);
        next.set(submissionId, { attempts: 0, maxAttempts: POLL_MAX_ATTEMPTS, status: 'starting' });
        return next;
      });
      
      // Poll until status changes or timeout
      // Pass jobId explicitly to avoid stale closure issues
      await pollSubmissionStatus(currentJobId, submissionId, (updatedSubmission) => {
        // Status changed successfully!
        const statusDisplay = updatedSubmission.status === 'APPROVED' ? '✅ APPROVED' :
                             updatedSubmission.status === 'REJECTED' ? '❌ REJECTED' :
                             updatedSubmission.status;
        
        alert(
          `🎉 Submission #${submissionId} Finalized!\n\n` +
          `Status: ${statusDisplay}\n` +
          `Score: ${updatedSubmission.acceptance?.toFixed(1) || 'N/A'}%\n` +
          `Transaction: ${result.txHash}\n\n` +
          'The page has been updated with the results.'
        );
        
        // Refresh full job details to ensure everything is in sync
        loadJobDetails();
      });
      
      // Check if polling timed out
      const pollState = pollingSubmissions.get(submissionId);
      if (pollState?.status === 'timeout') {
        alert(
          `⏳ Submission #${submissionId} was finalized on-chain but status sync timed out.\n\n` +
          `Transaction: ${result.txHash}\n\n` +
          'The blockchain may be slow. Please refresh the page in a moment to see the updated status.'
        );
      }

    } catch (err) {
      console.error('❌ Error finalizing submission:', err);
      setError(err.message || 'Failed to finalize submission');
      
      // Clear all states on error
      setFinalizingSubmissions(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
      setPollingSubmissions(prev => {
        const next = new Map(prev);
        next.delete(submissionId);
        return next;
      });
      
      alert(`❌ Failed to finalize submission #${submissionId}:\n\n${err.message}`);
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
            <span className="label">Class</span>
            <span className="value">{job?.classId ?? '...'}</span>
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
                onFinalize={handleFinalizeSubmission}
                isFailing={failingSubmissions.has(submission.submissionId)}
                isFinalizing={finalizingSubmissions.has(submission.submissionId)}
                isPolling={pollingSubmissions.has(submission.submissionId)}
                pollingState={pollingSubmissions.get(submission.submissionId)}
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

function SubmissionCard({ submission, walletState, onChainBountyId, onFailTimeout, onFinalize, isFailing, isFinalizing, isPolling, pollingState, disableActions, getSubmissionAge }) {
  const isPending = submission.status === 'PENDING_EVALUATION' || submission.status === 'PendingVerdikta';
  const isApproved = submission.status === 'APPROVED' || submission.status === 'ACCEPTED' || submission.status === 'PassedPaid';
  const isRejected = submission.status === 'REJECTED' || submission.status === 'Failed';
  const ageMinutes = isPending ? getSubmissionAge(submission.submittedAt) : 0;
  const canTimeout = ageMinutes > 20;
  // Always allow finalization for pending submissions - the contract will reject if not ready
  const canFinalize = isPending && !isPolling;
  
  // Debug logging
  console.log('SubmissionCard debug:', {
    submissionId: submission.submissionId,
    status: submission.status,
    isPending,
    isPolling,
    pollingState,
    submittedAt: submission.submittedAt,
    ageMinutes,
    canFinalize,
    canTimeout,
    walletConnected: walletState?.isConnected
  });

  // Determine status display
  const getStatusBadgeClass = () => {
    if (isApproved) return 'status-approved';
    if (isRejected) return 'status-rejected';
    if (isPending) return 'status-pending';
    return `status-${submission.status?.toLowerCase()}`;
  };

  return (
    <div className="submission-card">
      <div className="submission-header">
        <span className="hunter">{submission.hunter?.substring(0, 10)}...</span>
        <span className={`status-badge ${getStatusBadgeClass()}`}>
          {isApproved ? '✅ APPROVED' : isRejected ? '❌ REJECTED' : submission.status}
        </span>
      </div>
      
      {/* Show score for finalized submissions */}
      {(submission.score != null || submission.acceptance != null) && (
        <div className="score" style={{ 
          color: isApproved ? '#28a745' : isRejected ? '#dc3545' : '#666',
          fontWeight: 'bold'
        }}>
          Score: {(submission.score ?? submission.acceptance)?.toFixed(1) ?? 'N/A'}%
        </div>
      )}
      
      <div className="submission-meta">
        <span>Submitted: {new Date(submission.submittedAt * 1000).toLocaleString()}</span>
      </div>

      {/* Polling indicator - show when waiting for status update */}
      {isPolling && pollingState && (
        <div style={{ 
          marginTop: '0.75rem', 
          padding: '0.75rem', 
          backgroundColor: '#e3f2fd', 
          border: '1px solid #90caf9',
          borderRadius: '4px',
          textAlign: 'center'
        }}>
          <div className="spinner" style={{ 
            margin: '0 auto 0.5rem', 
            width: '20px', 
            height: '20px',
            border: '2px solid #90caf9',
            borderTop: '2px solid #1976d2',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }} />
          <div style={{ fontSize: '0.9rem', color: '#1565c0', fontWeight: 'bold' }}>
            🔄 Checking for results...
          </div>
          <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.25rem' }}>
            Attempt {pollingState.attempts}/{pollingState.maxAttempts}
          </div>
          {pollingState.status === 'timeout' && (
            <div style={{ fontSize: '0.8rem', color: '#f57c00', marginTop: '0.25rem' }}>
              ⏰ Timed out - please refresh the page
            </div>
          )}
        </div>
      )}

      {/* Show finalize/timeout buttons for pending submissions (when not polling) */}
      {isPending && walletState.isConnected && !isPolling && (
        <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {/* Finalize button */}
          {canFinalize && (
            <button
              onClick={() => onFinalize(submission.submissionId)}
              disabled={isFinalizing || disableActions}
              className="btn btn-primary btn-sm"
              style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem', width: '100%' }}
            >
              {isFinalizing ? '⏳ Processing transaction...' : `✅ Finalize Submission (check results)`}
            </button>
          )}
          
          {/* Timeout button - available after 20 minutes */}
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

      {/* Success message for approved submissions */}
      {isApproved && (
        <div style={{ 
          marginTop: '0.75rem', 
          padding: '0.5rem', 
          backgroundColor: '#e8f5e9', 
          border: '1px solid #81c784',
          borderRadius: '4px',
          textAlign: 'center',
          fontSize: '0.85rem',
          color: '#2e7d32'
        }}>
          🎉 This submission passed the evaluation threshold!
        </div>
      )}
    </div>
  );
}

export default BountyDetails;

