import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiService } from '../services/api';
import { getContractService } from '../services/contractService';
import './BountyDetails.css';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // How often to check for status updates (15 seconds)
  AUTO_REFRESH_INTERVAL_MS: 15000,
  
  // Polling after blockchain actions (for backend sync)
  ACTION_POLL_INTERVAL_MS: 3000,
  ACTION_POLL_MAX_ATTEMPTS: 20, // 20 * 3s = 60 seconds max
  
  // Polling for submission status changes after finalization
  // Reduced: 40 attempts * 3s = 2 minutes (if not done by then, auto-refresh takes over)
  SUBMISSION_POLL_INTERVAL_MS: 3000,
  SUBMISSION_POLL_MAX_ATTEMPTS: 40,
  
  // Initial load retries
  INITIAL_LOAD_MAX_RETRIES: 10,
  INITIAL_LOAD_RETRY_DELAY_MS: 3000,
  
  // Timeout threshold for submissions (in minutes) - for force-fail
  SUBMISSION_TIMEOUT_MINUTES: 6,
  
  // How often to update the live timer display (1 second)
  TIMER_UPDATE_INTERVAL_MS: 1000,
};

const PENDING_STATUSES = ['PENDING_EVALUATION', 'PendingVerdikta', 'Prepared'];

// ============================================================================
// MAIN COMPONENT
// ============================================================================

function BountyDetails({ walletState }) {
  // URL param = backend jobId, NOT the on-chain id
  const { bountyId } = useParams();

  // Core state
  const [job, setJob] = useState(null);
  const [rubric, setRubric] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  // Action states
  const [closingBounty, setClosingBounty] = useState(false);
  const [closingMessage, setClosingMessage] = useState('');
  const [finalizingSubmissions, setFinalizingSubmissions] = useState(new Set());
  const [failingSubmissions, setFailingSubmissions] = useState(new Set());
  
  // Polling state for submissions waiting for status update
  // Stores: { attempts, maxAttempts }
  const [pollingSubmissions, setPollingSubmissions] = useState(new Map());
  
  // Resolution state for on-chain bountyId
  const [resolvedBountyId, setResolvedBountyId] = useState(null);
  const [resolvingId, setResolvingId] = useState(false);
  const [resolveNote, setResolveNote] = useState('');

  // Live timer state - updates every second to show real-time elapsed time
  const [currentTime, setCurrentTime] = useState(() => Math.floor(Date.now() / 1000));

  // Refs to avoid stale closures
  const jobRef = useRef(null);
  const submissionsRef = useRef([]);
  const pollingSubmissionsRef = useRef(new Map());
  const autoRefreshIntervalRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const isMountedRef = useRef(true);

  // Keep refs in sync with state
  useEffect(() => {
    jobRef.current = job;
  }, [job]);

  useEffect(() => {
    submissionsRef.current = submissions;
  }, [submissions]);

  useEffect(() => {
    pollingSubmissionsRef.current = pollingSubmissions;
  }, [pollingSubmissions]);

  // ============================================================================
  // LIVE TIMER - Updates every second for real-time display
  // ============================================================================

  useEffect(() => {
    // Check if there are any pending submissions that need the timer
    const hasPendingSubmissions = submissions.some(s => PENDING_STATUSES.includes(s.status));
    
    // Clear any existing timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    // Only run timer if there are pending submissions
    if (hasPendingSubmissions) {
      timerIntervalRef.current = setInterval(() => {
        if (isMountedRef.current) {
          setCurrentTime(Math.floor(Date.now() / 1000));
        }
      }, CONFIG.TIMER_UPDATE_INTERVAL_MS);
    }

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    };
  }, [submissions]);

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  const loadJobDetails = useCallback(async (silent = false) => {
    if (!isMountedRef.current) return null;
    
    try {
      if (!silent) setLoading(true);
      setError(null);

      const response = await apiService.getJob(bountyId, true);
      
      if (!isMountedRef.current) return null;
      
      setJob(response.job);
      jobRef.current = response.job;

      if (response.job?.rubricContent) {
        setRubric(response.job.rubricContent);
      }
      if (response.job) {
        setSubmissions(response.job.submissions || []);
        submissionsRef.current = response.job.submissions || [];
      }
      
      return response.job;
    } catch (err) {
      if (!isMountedRef.current) return null;
      
      console.error('Error loading job:', err);
      const errorMessage = err.response?.data?.details || err.message;

      if (errorMessage.includes('not found') && retryCount < CONFIG.INITIAL_LOAD_MAX_RETRIES) {
        console.log(`Job not found, retrying... (attempt ${retryCount + 1}/${CONFIG.INITIAL_LOAD_MAX_RETRIES})`);
        setTimeout(() => {
          if (isMountedRef.current) setRetryCount(prev => prev + 1);
        }, CONFIG.INITIAL_LOAD_RETRY_DELAY_MS);
        setError('Waiting for blockchain sync... This may take a moment for newly created bounties.');
      } else if (retryCount >= CONFIG.INITIAL_LOAD_MAX_RETRIES) {
        setError('Job not found. The blockchain may still be syncing. Please try refreshing in a moment.');
      } else {
        setError(errorMessage);
      }
      return null;
    } finally {
      if (isMountedRef.current && !silent) setLoading(false);
    }
  }, [bountyId, retryCount]);

  // Initial load
  useEffect(() => {
    isMountedRef.current = true;
    loadJobDetails();
    setResolvedBountyId(null);
    setResolvingId(false);
    setResolveNote('');

    return () => {
      isMountedRef.current = false;
    };
  }, [bountyId, retryCount, loadJobDetails]);

  // Check if job data is complete
  const isJobDataComplete = (jobData) =>
    jobData &&
    jobData.bountyAmount !== undefined &&
    jobData.threshold !== undefined &&
    jobData.submissionCloseTime !== undefined;

  // Retry if job data incomplete
  useEffect(() => {
    if (job && !isJobDataComplete(job) && retryCount < CONFIG.INITIAL_LOAD_MAX_RETRIES) {
      console.log('Job data incomplete, retrying...', {
        hasAmount: job.bountyAmount !== undefined,
        hasThreshold: job.threshold !== undefined,
        hasDeadline: job.submissionCloseTime !== undefined
      });
      const timer = setTimeout(() => {
        if (isMountedRef.current) setRetryCount(prev => prev + 1);
      }, CONFIG.INITIAL_LOAD_RETRY_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [job, retryCount]);

  // ============================================================================
  // AUTO-REFRESH FOR PENDING SUBMISSIONS
  // ============================================================================

  useEffect(() => {
    // Clear any existing interval
    if (autoRefreshIntervalRef.current) {
      clearInterval(autoRefreshIntervalRef.current);
      autoRefreshIntervalRef.current = null;
    }

    const currentJobId = job?.jobId;
    if (!currentJobId) return;

    // Check if there are pending submissions that need monitoring
    const hasPendingSubmissions = submissions.some(s => PENDING_STATUSES.includes(s.status));
    
    if (!hasPendingSubmissions) {
      console.log('📊 No pending submissions to monitor');
      return;
    }

    console.log(`📊 Starting auto-refresh every ${CONFIG.AUTO_REFRESH_INTERVAL_MS / 1000}s for job ${currentJobId}`);

    autoRefreshIntervalRef.current = setInterval(async () => {
      if (!isMountedRef.current) return;
      
      // Get current pending submissions (use ref to avoid stale closure)
      const currentSubs = submissionsRef.current;
      
      // Only skip submissions that are ACTIVELY being polled (in pollingSubmissions map)
      // If polling timed out, we remove from the map, so auto-refresh will check them
      const pendingSubs = currentSubs.filter(s => {
        if (!PENDING_STATUSES.includes(s.status)) return false;
        // Skip if actively polling
        if (pollingSubmissionsRef.current.has(s.submissionId)) return false;
        return true;
      });

      if (pendingSubs.length === 0) {
        console.log('📊 Auto-refresh: No pending submissions to check (some may be actively polling)');
        return;
      }

      console.log(`🔄 Auto-refresh: Checking ${pendingSubs.length} pending submissions...`);

      let hasUpdates = false;

      for (const sub of pendingSubs) {
        if (!isMountedRef.current) break;
        
        try {
          const result = await apiService.refreshSubmission(currentJobId, sub.submissionId);
          const newStatus = result.submission?.status;

          if (newStatus && !PENDING_STATUSES.includes(newStatus)) {
            console.log(`🎉 Auto-refresh: Submission #${sub.submissionId} status changed to ${newStatus}!`);
            hasUpdates = true;
          }
        } catch (err) {
          console.log(`⚠️ Auto-refresh error for submission #${sub.submissionId}:`, err.message);
        }
      }

      // Reload if any status changed
      if (hasUpdates && isMountedRef.current) {
        console.log('✅ Auto-refresh: Status changes detected, reloading...');
        loadJobDetails(true);
      }
    }, CONFIG.AUTO_REFRESH_INTERVAL_MS);

    return () => {
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
        autoRefreshIntervalRef.current = null;
      }
    };
  }, [job?.jobId, submissions, loadJobDetails]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
      }
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, []);

  // ============================================================================
  // BOUNTY ID RESOLUTION
  // ============================================================================

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!job || resolvingId) return;

      // Backend already has it (check BOTH bountyId and onChainId)
      if (job?.bountyId != null || job?.onChainId != null) {
        if (!cancelled) {
          setResolvedBountyId(Number(job?.onChainId ?? job?.bountyId));
          setResolveNote('');
        }
        return;
      }

      try {
        setResolvingId(true);

        const creator = job?.creator;
        const submissionCloseTime = job?.submissionCloseTime;
        const txHash = job?.txHash || job?.creationTxHash || job?.chainTxHash || job?.createTxHash || null;

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
  }, [job, resolvingId]);

  // ============================================================================
  // HELPERS
  // ============================================================================

  const getOnChainBountyId = () => {
    if (job?.onChainId != null && !Number.isNaN(Number(job.onChainId))) {
      return Number(job.onChainId);
    }
    if (job?.bountyId != null && !Number.isNaN(Number(job.bountyId))) {
      return Number(job.bountyId);
    }
    if (resolvedBountyId != null && !Number.isNaN(Number(resolvedBountyId))) {
      return Number(resolvedBountyId);
    }
    return null;
  };

  // Use currentTime state for live updates instead of Date.now()
  const getSubmissionAge = useCallback((submittedAt) => {
    return (currentTime - submittedAt) / 60;
  }, [currentTime]);

  // ============================================================================
  // POLLING HELPERS
  // ============================================================================

  /**
   * Poll for a specific condition after a blockchain action
   * Returns true if condition met, false if timed out
   */
  const pollForCondition = async (checkFn, options = {}) => {
    const {
      intervalMs = CONFIG.ACTION_POLL_INTERVAL_MS,
      maxAttempts = CONFIG.ACTION_POLL_MAX_ATTEMPTS,
      onProgress = null,
    } = options;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!isMountedRef.current) return false;
      
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      
      if (onProgress) onProgress(attempt, maxAttempts);
      
      try {
        const result = await checkFn(attempt);
        if (result) return true;
      } catch (err) {
        console.log(`Poll attempt ${attempt}/${maxAttempts} error:`, err.message);
      }
    }
    
    return false;
  };

  /**
   * Poll for submission status change after finalization
   * Returns: { success: boolean, submission?: object, reason?: string }
   * 
   * FIX: On timeout, we REMOVE from pollingSubmissions so auto-refresh can take over
   */
  const pollSubmissionStatus = useCallback(async (jobId, submissionId, onStatusChange) => {
    if (!jobId) {
      console.error('❌ pollSubmissionStatus called without jobId!');
      return { success: false, reason: 'no_job_id' };
    }

    // Guard against duplicate polling
    if (pollingSubmissionsRef.current.has(submissionId)) {
      console.log(`⚠️ Already polling submission #${submissionId}`);
      return { success: false, reason: 'already_polling' };
    }

    console.log(`🔄 Starting to poll submission #${submissionId} for job ${jobId}...`);

    // Set initial polling state
    setPollingSubmissions(prev => {
      const next = new Map(prev);
      next.set(submissionId, { attempts: 0, maxAttempts: CONFIG.SUBMISSION_POLL_MAX_ATTEMPTS });
      return next;
    });

    let foundResult = null;

    const success = await pollForCondition(
      async (attempt) => {
        // Update polling state with current attempt
        setPollingSubmissions(prev => {
          const next = new Map(prev);
          next.set(submissionId, { attempts: attempt, maxAttempts: CONFIG.SUBMISSION_POLL_MAX_ATTEMPTS });
          return next;
        });

        try {
          const result = await apiService.refreshSubmission(jobId, submissionId);
          const newStatus = result.submission?.status;

          console.log(`📊 Poll attempt ${attempt}: status = ${newStatus}`);

          if (newStatus && !PENDING_STATUSES.includes(newStatus)) {
            console.log(`🎉 Submission #${submissionId} status changed to: ${newStatus}`);
            foundResult = result.submission;
            
            // Update submission in local state immediately
            setSubmissions(prevSubs =>
              prevSubs.map(s =>
                s.submissionId === submissionId ? { ...s, ...result.submission } : s
              )
            );

            // Clear polling state on success
            setPollingSubmissions(prev => {
              const next = new Map(prev);
              next.delete(submissionId);
              return next;
            });

            return true;
          }
        } catch (err) {
          console.log(`⚠️ Poll attempt ${attempt} error:`, err.message);
        }

        return false;
      },
      {
        intervalMs: CONFIG.SUBMISSION_POLL_INTERVAL_MS,
        maxAttempts: CONFIG.SUBMISSION_POLL_MAX_ATTEMPTS,
      }
    );

    if (success && foundResult) {
      // Call the success callback
      if (onStatusChange) {
        onStatusChange(foundResult);
      }
      return { success: true, submission: foundResult };
    }

    // Timed out - FIX: REMOVE from pollingSubmissions so auto-refresh can take over
    if (isMountedRef.current) {
      console.log(`⏰ Polling timed out for submission #${submissionId} - auto-refresh will continue monitoring`);
      
      // Clear the polling state - this allows auto-refresh to pick it up
      setPollingSubmissions(prev => {
        const next = new Map(prev);
        next.delete(submissionId);
        return next;
      });
    }

    return { success: false, reason: 'timeout' };
  }, []);

  // ============================================================================
  // ACTIONS
  // ============================================================================

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

    let txHash = null;

    try {
      setFinalizingSubmissions(prev => new Set(prev).add(submissionId));
      setError(null);

      const contractService = getContractService();
      if (!contractService.isConnected()) await contractService.connect();

      console.log('📤 Finalizing submission:', { bountyId: onChainId, submissionId });
      const result = await contractService.finalizeSubmission(onChainId, submissionId);
      txHash = result.txHash;

      console.log('✅ Finalization transaction confirmed:', txHash);

      // Clear finalizing state
      setFinalizingSubmissions(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });

      // Start polling for status update
      const currentJobId = jobRef.current?.jobId || job?.jobId;
      console.log(`🔄 Starting to poll for status update (jobId: ${currentJobId}, submissionId: ${submissionId})...`);

      const pollResult = await pollSubmissionStatus(currentJobId, submissionId, (updatedSubmission) => {
        const statusDisplay = updatedSubmission.status === 'APPROVED' ? '✅ APPROVED' :
                             updatedSubmission.status === 'REJECTED' ? '❌ REJECTED' :
                             updatedSubmission.status === 'PassedPaid' ? '✅ PASSED & PAID' :
                             updatedSubmission.status === 'Failed' ? '❌ FAILED' :
                             updatedSubmission.status;

        alert(
          `🎉 Submission #${submissionId} Finalized!\n\n` +
          `Status: ${statusDisplay}\n` +
          `Score: ${updatedSubmission.acceptance?.toFixed(1) || 'N/A'}%\n` +
          `Transaction: ${txHash}\n\n` +
          'The page has been updated with the results.'
        );

        // Reload the full job details
        loadJobDetails(true);
      });

      // If polling timed out, show a different message
      if (!pollResult.success && pollResult.reason === 'timeout') {
        alert(
          `✅ Transaction confirmed!\n\n` +
          `Transaction: ${txHash}\n\n` +
          'The status is still syncing. The page will auto-refresh every 15 seconds.\n' +
          'You can also manually refresh if needed.'
        );
        
        // Still reload to make sure we have latest data
        loadJobDetails(true);
      }

    } catch (err) {
      console.error('❌ Error finalizing submission:', err);
      setError(err.message || 'Failed to finalize submission');

      setFinalizingSubmissions(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
      
      // Clear any polling state on error
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
      `This submission has been stuck in evaluation for over ${CONFIG.SUBMISSION_TIMEOUT_MINUTES} minutes.\n` +
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

      console.log('✅ Submission failed, waiting for backend sync...');

      // Poll for backend to sync
      const currentJobId = jobRef.current?.jobId || job?.jobId;
      await pollForCondition(
        async () => {
          const response = await apiService.getJob(currentJobId, false);
          const sub = response.job?.submissions?.find(s => s.submissionId === submissionId);
          return sub && !PENDING_STATUSES.includes(sub.status);
        },
        { maxAttempts: 10 }
      );

      alert(
        `✅ Submission #${submissionId} marked as Failed (timeout)!\n\n` +
        `Transaction: ${result.txHash}\n` +
        `Block: ${result.blockNumber}\n\n` +
        'LINK tokens have been refunded.'
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
      'Close this expired bounty and return funds to the creator?\n\n' +
      'This will trigger a blockchain transaction that you must sign.'
    );
    if (!confirmed) return;

    try {
      setClosingBounty(true);
      setClosingMessage('Sending transaction...');
      setError(null);

      const contractService = getContractService();
      if (!contractService.isConnected()) await contractService.connect();

      console.log('📤 closeExpiredBounty using on-chain id:', onChainId);
      const result = await contractService.closeExpiredBounty(onChainId);

      console.log('✅ Transaction confirmed:', result.txHash);
      setClosingMessage('Transaction confirmed! Waiting for backend to sync...');

      // Poll for backend to sync (up to 60 seconds with 3s intervals)
      const currentJobId = jobRef.current?.jobId || job?.jobId;
      let synced = false;

      await pollForCondition(
        async (attempt) => {
          setClosingMessage(`Syncing... (${attempt * 3}s)`);
          
          const response = await apiService.getJob(currentJobId, false);
          if (response.job?.status === 'CLOSED') {
            synced = true;
            return true;
          }
          return false;
        },
        {
          intervalMs: CONFIG.ACTION_POLL_INTERVAL_MS,
          maxAttempts: CONFIG.ACTION_POLL_MAX_ATTEMPTS,
        }
      );

      if (synced) {
        alert(
          '✅ Expired bounty closed successfully!\n\n' +
          `Transaction: ${result.txHash}\n` +
          `Block: ${result.blockNumber}\n\n` +
          `${job?.bountyAmount ?? '...'} ETH has been returned to the creator.`
        );
      } else {
        alert(
          '✅ Transaction confirmed!\n\n' +
          `Transaction: ${result.txHash}\n` +
          `Block: ${result.blockNumber}\n\n` +
          'The backend is still syncing. The status will update shortly.\n' +
          'Please refresh the page in a moment.'
        );
      }

      setRetryCount(0);
      await loadJobDetails();
    } catch (err) {
      console.error('❌ Error closing bounty:', err);
      setError(err.message || 'Failed to close bounty');
      alert(`❌ Failed to close bounty:\n\n${err.message}`);
    } finally {
      setClosingBounty(false);
      setClosingMessage('');
    }
  };

  // ============================================================================
  // RENDER HELPERS
  // ============================================================================

  // Loading state while checking job status
  if (loading) {
    return (
      <div className="bounty-details">
        <div className="loading">
          <div className="spinner"></div>
          <p>
            {retryCount > 0 
              ? `Waiting for blockchain sync... (attempt ${retryCount}/${CONFIG.INITIAL_LOAD_MAX_RETRIES})` 
              : 'Loading bounty details...'}
          </p>
        </div>
      </div>
    );
  }

  if (job && !isJobDataComplete(job) && retryCount < CONFIG.INITIAL_LOAD_MAX_RETRIES) {
    return (
      <div className="bounty-details">
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading complete job data from blockchain... (attempt {retryCount}/{CONFIG.INITIAL_LOAD_MAX_RETRIES})</p>
        </div>
      </div>
    );
  }

  if (error && retryCount >= CONFIG.INITIAL_LOAD_MAX_RETRIES) {
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
          <small>Retrying automatically... ({retryCount}/{CONFIG.INITIAL_LOAD_MAX_RETRIES})</small>
        </div>
      </div>
    );
  }

  // ============================================================================
  // DERIVED STATE
  // ============================================================================

  const status = job?.status || 'UNKNOWN';
  const now = Math.floor(Date.now() / 1000);
  const timeRemaining = job?.submissionCloseTime ? job.submissionCloseTime - now : -1;
  const hoursRemaining = Math.max(0, Math.floor(timeRemaining / 3600));

  const isOpen = status === 'OPEN';
  const isExpired = status === 'EXPIRED';
  const isAwarded = status === 'AWARDED';
  const isClosed = status === 'CLOSED';

  const hasActiveSubmissions = submissions.some(s =>
    s.status === 'PendingVerdikta' || s.status === 'PENDING_EVALUATION'
  );

  const pendingSubmissions = submissions.filter(s =>
    s.status === 'PendingVerdikta' || s.status === 'PENDING_EVALUATION'
  );

  const onChainIdForButtons = getOnChainBountyId();
  const disableActionsForMissingId = onChainIdForButtons == null;

  console.log('🔍 Bounty Status Check:', {
    urlParam_jobId: bountyId,
    backend_bountyId: job?.bountyId,
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

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="bounty-details">
      {/* EXPIRED Status Banner */}
      {isExpired && (
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

          {resolveNote && (
            <div className="alert alert-info" style={{ marginBottom: '0.75rem' }}>
              {resolveNote}
            </div>
          )}

          {/* Pending submissions section */}
          {hasActiveSubmissions && walletState.isConnected && (
            <PendingSubmissionsPanel
              pendingSubmissions={pendingSubmissions}
              getSubmissionAge={getSubmissionAge}
              onFinalize={handleFinalizeSubmission}
              onFailTimeout={handleFailTimedOutSubmission}
              finalizingSubmissions={finalizingSubmissions}
              failingSubmissions={failingSubmissions}
              pollingSubmissions={pollingSubmissions}
              disableActions={disableActionsForMissingId}
              timeoutMinutes={CONFIG.SUBMISSION_TIMEOUT_MINUTES}
            />
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
                {closingBounty 
                  ? `⏳ ${closingMessage || 'Processing...'}` 
                  : '🔒 Close Expired Bounty & Return Funds'}
              </button>
              {disableActionsForMissingId && !closingBounty && (
                <p style={{ marginTop: 8, color: '#666', fontSize: '0.9rem' }}>
                  Resolving on-chain bounty ID...
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Bounty Header */}
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

      {/* Description Section */}
      {job?.description && (
        <section className="description-section">
          <h2>Job Description</h2>
          <p>{job.description}</p>
        </section>
      )}

      {/* Rubric Section */}
      {rubric && (
        <section className="rubric-section">
          <h2>Evaluation Criteria</h2>
          <p className="rubric-description">{rubric.description}</p>
          <div className="criteria-grid">
            {rubric.criteria?.map((criterion, index) => (
              <div key={index} className="criterion-card">
                <div className="criterion-header">
                  <h3>{criterion.label || criterion.id.replace(/_/g, ' ')}</h3>
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

      {/* Actions Section */}
      <section className="actions-section">
        <h2>Actions</h2>
        <div className="action-buttons">
          {isOpen && walletState.isConnected && (
            <Link to={`/bounty/${bountyId}/submit`} className="btn btn-primary btn-lg">
              Submit Work
            </Link>
          )}

          {isOpen && !walletState.isConnected && (
            <div className="alert alert-info">Connect your wallet to submit work</div>
          )}

          {isAwarded && (
            <div className="alert alert-success">
              🎉 This bounty has been completed and the winner has been paid {job?.bountyAmount ?? '...'} ETH!
            </div>
          )}

          {isClosed && (
            <div className="alert alert-info">
              This bounty has been closed and {job?.bountyAmount ?? '...'} ETH has been returned to the creator.
            </div>
          )}

          {isExpired && (
            <ExpiredBountyActions
              job={job}
              walletState={walletState}
              hasActiveSubmissions={hasActiveSubmissions}
              pendingSubmissions={pendingSubmissions}
              closingBounty={closingBounty}
              closingMessage={closingMessage}
              disableActions={disableActionsForMissingId}
              getSubmissionAge={getSubmissionAge}
              onClose={handleCloseExpiredBounty}
              onFinalize={handleFinalizeSubmission}
              onFailTimeout={handleFailTimedOutSubmission}
              finalizingSubmissions={finalizingSubmissions}
              failingSubmissions={failingSubmissions}
              pollingSubmissions={pollingSubmissions}
              timeoutMinutes={CONFIG.SUBMISSION_TIMEOUT_MINUTES}
            />
          )}
        </div>
      </section>

      {/* Submissions Section */}
      <section className="submissions-section">
        <h2>Submissions ({submissions.length})</h2>
        {submissions.length > 0 ? (
          <div className="submissions-list">
            {submissions.map((submission) => (
              <SubmissionCard
                key={submission.submissionId}
                submission={submission}
                walletState={walletState}
                onFailTimeout={handleFailTimedOutSubmission}
                onFinalize={handleFinalizeSubmission}
                isFailing={failingSubmissions.has(submission.submissionId)}
                isFinalizing={finalizingSubmissions.has(submission.submissionId)}
                isPolling={pollingSubmissions.has(submission.submissionId)}
                pollingState={pollingSubmissions.get(submission.submissionId)}
                disableActions={disableActionsForMissingId}
                getSubmissionAge={getSubmissionAge}
                timeoutMinutes={CONFIG.SUBMISSION_TIMEOUT_MINUTES}
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

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

function PendingSubmissionsPanel({
  pendingSubmissions,
  getSubmissionAge,
  onFinalize,
  onFailTimeout,
  finalizingSubmissions,
  failingSubmissions,
  pollingSubmissions,
  disableActions,
  timeoutMinutes
}) {
  return (
    <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
      <h4 style={{ margin: '0 0 0.75rem 0' }}>⚠️ Pending Evaluations</h4>
      <p style={{ marginBottom: '0.75rem' }}>
        The following submissions are being evaluated:
      </p>
      {pendingSubmissions.map(s => {
        const ageMinutes = getSubmissionAge(s.submittedAt);
        const canTimeout = ageMinutes > timeoutMinutes;
        const isFailing = failingSubmissions.has(s.submissionId);
        const isFinalizing = finalizingSubmissions.has(s.submissionId);
        const isPolling = pollingSubmissions.has(s.submissionId);
        const pollState = pollingSubmissions.get(s.submissionId);

        return (
          <div key={s.submissionId} style={{ 
            marginBottom: '1rem', 
            padding: '0.75rem', 
            backgroundColor: '#fff', 
            border: '1px solid #ddd', 
            borderRadius: '4px' 
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.9rem', color: '#666' }}>
                Submission #{s.submissionId} by {s.hunter?.substring(0, 10)}...
              </span>
              <span style={{ fontSize: '0.85rem', color: '#888', marginLeft: 'auto' }}>
                {ageMinutes.toFixed(1)} min elapsed
              </span>
            </div>

            {isPolling && pollState && (
              <div style={{ 
                marginBottom: '0.5rem', 
                padding: '0.5rem', 
                backgroundColor: '#e3f2fd', 
                borderRadius: '4px',
                fontSize: '0.85rem',
                color: '#1565c0'
              }}>
                🔄 Checking results... ({pollState.attempts}/{pollState.maxAttempts})
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                onClick={() => onFinalize(s.submissionId)}
                disabled={isFinalizing || isPolling || disableActions}
                className="btn btn-primary btn-sm"
                style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
              >
                {isFinalizing ? '⏳ Finalizing...' : '✅ Finalize'}
              </button>

              {canTimeout && (
                <button
                  onClick={() => onFailTimeout(s.submissionId)}
                  disabled={isFailing || disableActions}
                  className="btn btn-warning btn-sm"
                  style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
                >
                  {isFailing ? '⏳ Failing...' : '⏱️ Force Fail'}
                </button>
              )}
            </div>

            {!canTimeout && (
              <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.5rem' }}>
                ⏳ Force-fail available in {(timeoutMinutes - ageMinutes).toFixed(1)} min
              </div>
            )}
          </div>
        );
      })}
      <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#666' }}>
        💡 Auto-refreshing every 15 seconds. Submissions stuck &gt;{timeoutMinutes} minutes can be force-failed.
      </p>
    </div>
  );
}

function ExpiredBountyActions({
  job,
  walletState,
  hasActiveSubmissions,
  pendingSubmissions,
  closingBounty,
  closingMessage,
  disableActions,
  getSubmissionAge,
  onClose,
  onFinalize,
  onFailTimeout,
  finalizingSubmissions,
  failingSubmissions,
  pollingSubmissions,
  timeoutMinutes
}) {
  return (
    <div className="expired-bounty-section" style={{ 
      backgroundColor: '#fff3cd', 
      border: '2px solid #ffc107', 
      padding: '1.5rem', 
      borderRadius: '8px', 
      marginTop: '1rem' 
    }}>
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
        <PendingSubmissionsPanel
          pendingSubmissions={pendingSubmissions}
          getSubmissionAge={getSubmissionAge}
          onFinalize={onFinalize}
          onFailTimeout={onFailTimeout}
          finalizingSubmissions={finalizingSubmissions}
          failingSubmissions={failingSubmissions}
          pollingSubmissions={pollingSubmissions}
          disableActions={disableActions}
          timeoutMinutes={timeoutMinutes}
        />
      ) : (
        <>
          <button
            onClick={onClose}
            disabled={closingBounty || disableActions}
            className="btn btn-warning btn-lg"
            style={{ width: '100%', fontSize: '1.1rem', padding: '1rem' }}
            title={disableActions ? 'Resolving on-chain bountyId…' : undefined}
          >
            {closingBounty 
              ? `⏳ ${closingMessage || 'Processing...'}` 
              : '🔒 Close Expired Bounty & Return Funds to Creator'}
          </button>
          {disableActions && (
            <small style={{ display: 'block', marginTop: 8, color: '#666' }}>
              Resolving on-chain bounty ID. If this job was just created, wait a moment or refresh.
            </small>
          )}
        </>
      )}
    </div>
  );
}

function SubmissionCard({ 
  submission, 
  walletState, 
  onFailTimeout, 
  onFinalize, 
  isFailing, 
  isFinalizing, 
  isPolling, 
  pollingState, 
  disableActions, 
  getSubmissionAge,
  timeoutMinutes
}) {
  const isPending = submission.status === 'PENDING_EVALUATION' || submission.status === 'PendingVerdikta';
  const isApproved = submission.status === 'APPROVED' || submission.status === 'ACCEPTED' || submission.status === 'PassedPaid';
  const isRejected = submission.status === 'REJECTED' || submission.status === 'Failed';
  const ageMinutes = isPending ? getSubmissionAge(submission.submittedAt) : 0;
  const canTimeout = ageMinutes > timeoutMinutes;
  const canFinalize = isPending && !isPolling;

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

      {/* Polling indicator */}
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
        </div>
      )}

      {/* Action buttons for pending submissions */}
      {isPending && walletState.isConnected && !isPolling && (
        <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {canFinalize && (
            <button
              onClick={() => onFinalize(submission.submissionId)}
              disabled={isFinalizing || disableActions}
              className="btn btn-primary btn-sm"
              style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem', width: '100%' }}
            >
              {isFinalizing ? '⏳ Processing transaction...' : '✅ Finalize Submission (check results)'}
            </button>
          )}

          {canTimeout ? (
            <button
              onClick={() => onFailTimeout(submission.submissionId)}
              disabled={isFailing || disableActions}
              className="btn btn-warning btn-sm"
              style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem', width: '100%' }}
            >
              {isFailing ? '⏳ Marking as Failed...' : `⏱️ Fail Timed-Out (${ageMinutes.toFixed(1)} min)`}
            </button>
          ) : (
            <div style={{ fontSize: '0.8rem', color: '#888', textAlign: 'center' }}>
              ⏳ Evaluating... ({ageMinutes.toFixed(1)} min, force-fail in {(timeoutMinutes - ageMinutes).toFixed(1)} min)
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

