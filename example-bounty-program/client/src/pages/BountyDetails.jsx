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

  // How often to check if Verdikta evaluation is ready (15 seconds)
  EVALUATION_CHECK_INTERVAL_MS: 15000,
};

const PENDING_STATUSES = ['PENDING_EVALUATION', 'PendingVerdikta', 'Prepared', 'PREPARED'];

// Helper to check if a status is pending (case-insensitive)
const isPendingStatus = (status) => {
  if (!status) return false;
  const upperStatus = status.toUpperCase();
  return PENDING_STATUSES.some(s => s.toUpperCase() === upperStatus);
};

// Map on-chain status codes to readable strings
const ON_CHAIN_STATUS_MAP = {
  0: 'OPEN',
  1: 'EXPIRED',
  2: 'AWARDED',
  3: 'CLOSED'
};

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

  // NEW: Evaluation results ready state
  // Map of submissionId -> { ready: boolean, scores: { rejection, acceptance }, justificationCids: [] }
  const [evaluationResults, setEvaluationResults] = useState(new Map());

  // Resolution state for on-chain bountyId
  const [resolvedBountyId, setResolvedBountyId] = useState(null);
  const [resolvingId, setResolvingId] = useState(false);
  const [resolveNote, setResolveNote] = useState('');

  // Live timer state - updates every second to show real-time elapsed time
  const [currentTime, setCurrentTime] = useState(() => Math.floor(Date.now() / 1000));

  // NEW: Status override tracking (when on-chain differs from backend)
  const [statusOverride, setStatusOverride] = useState(null);
  // Format: { onChainStatus: string, backendStatus: string, reason: string }

  // NEW: Diagnostic panel toggle (Ctrl+Shift+D to toggle)
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // Refs to avoid stale closures
  const jobRef = useRef(null);
  const submissionsRef = useRef([]);
  const pollingSubmissionsRef = useRef(new Map());
  const autoRefreshIntervalRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const evaluationCheckIntervalRef = useRef(null);
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
  // DIAGNOSTIC PANEL TOGGLE (Ctrl+Shift+D)
  // ============================================================================

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setShowDiagnostics(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // ============================================================================
  // LIVE TIMER - Updates every second for real-time display
  // ============================================================================

  useEffect(() => {
    // Check if there are any pending submissions that need the timer
    const hasPendingSubmissions = submissions.some(s => isPendingStatus(s.status));

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
  // HELPER: Get on-chain ID from current state
  // ============================================================================

  const getOnChainBountyId = useCallback(() => {
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
  }, [job?.onChainId, job?.bountyId, resolvedBountyId]);

  // ============================================================================
  // EVALUATION READINESS POLLING (NEW)
  // Checks VerdiktaAggregator directly to see if results are ready
  // ============================================================================

  useEffect(() => {
    // Clear any existing interval
    if (evaluationCheckIntervalRef.current) {
      clearInterval(evaluationCheckIntervalRef.current);
      evaluationCheckIntervalRef.current = null;
    }

    const onChainId = getOnChainBountyId();
    if (onChainId == null) {
      return; // Can't check without on-chain ID
    }

    // Get pending submissions that aren't already being actively polled after finalization
    const pendingSubs = submissions.filter(s => 
      isPendingStatus(s.status) && 
      !pollingSubmissions.has(s.submissionId)
    );

    if (pendingSubs.length === 0) {
      return;
    }

    // Check if evaluations are ready for pending submissions
    const checkEvaluationReadiness = async (subsToCheck) => {
      if (!isMountedRef.current) return;

      try {
        const contractService = getContractService();
        
        // Note: checkEvaluationReady uses getReadOnlyProvider() which doesn't require wallet connection
        // It just needs window.ethereum to be present (MetaMask installed)
        
        for (const sub of subsToCheck) {
          if (!isMountedRef.current) break;

          try {
            // Use onChainSubmissionId if available, otherwise fall back to submissionId
            const chainSubmissionId = sub.onChainSubmissionId ?? sub.submissionId;
            const result = await contractService.checkEvaluationReady(onChainId, chainSubmissionId);
            
            if (result.ready) {
              setEvaluationResults(prev => {
                const next = new Map(prev);
                next.set(sub.submissionId, result);
                return next;
              });
            }
          } catch (err) {
            // Don't spam console for expected "not ready" errors
          }
        }
      } catch (err) {
        // Silently ignore
      }
    };

    // Check immediately on mount/change
    checkEvaluationReadiness(pendingSubs);

    // Then check periodically
    evaluationCheckIntervalRef.current = setInterval(() => {
      if (!isMountedRef.current) return;

      const currentSubs = submissionsRef.current.filter(s => 
        isPendingStatus(s.status) && 
        !pollingSubmissionsRef.current.has(s.submissionId)
      );

      if (currentSubs.length > 0) {
        checkEvaluationReadiness(currentSubs);
      }
    }, CONFIG.EVALUATION_CHECK_INTERVAL_MS);

    return () => {
      if (evaluationCheckIntervalRef.current) {
        clearInterval(evaluationCheckIntervalRef.current);
        evaluationCheckIntervalRef.current = null;
      }
    };
  }, [submissions, getOnChainBountyId, pollingSubmissions]);

  // ============================================================================
  // DATA LOADING (with on-chain status verification)
  // ============================================================================

  const loadJobDetails = useCallback(async (silent = false) => {
    if (!isMountedRef.current) return null;

    try {
      if (!silent) setLoading(true);
      setError(null);

      const response = await apiService.getJob(bountyId, true);

      if (!isMountedRef.current) return null;

      let finalJob = response.job;

      // Store backend status before any override
      const backendStatus = finalJob?.status;

      // ========================================================================
      // ON-CHAIN STATUS VERIFICATION
      // Check if on-chain status differs from backend and override if needed
      // ========================================================================
      if (finalJob) {
        const onChainId = finalJob.onChainId ?? finalJob.bountyId ?? resolvedBountyId;
        
        if (onChainId != null) {
          try {
            const contractService = getContractService();
            const onChainStatusCode = await contractService.getBountyStatus(Number(onChainId));
            const onChainStatus = ON_CHAIN_STATUS_MAP[onChainStatusCode] || `UNKNOWN(${onChainStatusCode})`;

            if (onChainStatus !== backendStatus) {
              // Status mismatch - override with on-chain truth
              finalJob = { ...finalJob, status: onChainStatus };
              setStatusOverride({
                onChainStatus,
                backendStatus,
                reason: 'On-chain status differs from backend'
              });
            } else {
              setStatusOverride(null);
            }
          } catch (err) {
            // Can't verify on-chain - proceed with backend status
            // This is expected if wallet not connected or RPC issues
          }
        }

        // ========================================================================
        // DEADLINE-PASSED DETECTION
        // Even if backend says OPEN, check if deadline has passed
        // ========================================================================
        if (finalJob.status === 'OPEN' && finalJob.submissionCloseTime) {
          const now = Math.floor(Date.now() / 1000);
          if (now > finalJob.submissionCloseTime) {
            // Deadline passed but backend still shows OPEN - treat as EXPIRED
            finalJob = { ...finalJob, status: 'EXPIRED' };
            setStatusOverride(prev => ({
              ...prev,
              onChainStatus: 'EXPIRED',
              backendStatus: backendStatus,
              reason: 'Deadline has passed (backend not synced)'
            }));
          }
        }
      }

      setJob(finalJob);
      jobRef.current = finalJob;

      if (response.job?.rubricContent) {
        setRubric(response.job.rubricContent);
      }
      if (response.job) {
        const subs = response.job.submissions || [];
        setSubmissions(subs);
        submissionsRef.current = subs;
      }

      return finalJob;
    } catch (err) {
      if (!isMountedRef.current) return null;

      console.error('Error loading job:', err);
      const errorMessage = err.response?.data?.details || err.message;

      if (errorMessage.includes('not found') && retryCount < CONFIG.INITIAL_LOAD_MAX_RETRIES) {
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
  }, [bountyId, retryCount, resolvedBountyId]);

  // Initial load
  useEffect(() => {
    isMountedRef.current = true;
    loadJobDetails();
    setResolvedBountyId(null);
    setResolvingId(false);
    setResolveNote('');
    setEvaluationResults(new Map()); // Clear evaluation results on bounty change
    setStatusOverride(null);

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
    const hasPendingSubmissions = submissions.some(s => isPendingStatus(s.status));

    if (!hasPendingSubmissions) {
      return;
    }

    autoRefreshIntervalRef.current = setInterval(async () => {
      if (!isMountedRef.current) return;

      // Get current pending submissions (use ref to avoid stale closure)
      const currentSubs = submissionsRef.current;

      // Only skip submissions that are ACTIVELY being polled (in pollingSubmissions map)
      // If polling timed out, we remove from the map, so auto-refresh will check them
      const pendingSubs = currentSubs.filter(s => {
        if (!isPendingStatus(s.status)) return false;
        // Skip if actively polling
        if (pollingSubmissionsRef.current.has(s.submissionId)) return false;
        return true;
      });

      if (pendingSubs.length === 0) {
        return;
      }

      let hasUpdates = false;

      for (const sub of pendingSubs) {
        if (!isMountedRef.current) break;

        try {
          const result = await apiService.refreshSubmission(currentJobId, sub.submissionId);
          const newStatus = result.submission?.status;

          if (newStatus && !isPendingStatus(newStatus)) {
            hasUpdates = true;
          }
        } catch (err) {
          // Silently ignore auto-refresh errors
        }
      }

      // Reload if any status changed
      if (hasUpdates && isMountedRef.current) {
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
      if (evaluationCheckIntervalRef.current) {
        clearInterval(evaluationCheckIntervalRef.current);
      }
    };
  }, []);

  // ============================================================================
  // BOUNTY ID RESOLUTION (with direct on-chain fallback)
  // ============================================================================

  // Use a ref to track if resolution has been attempted (prevents loops)
  const resolutionAttemptedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!job) return;

      // Backend already has it (check BOTH bountyId and onChainId)
      if (job?.bountyId != null || job?.onChainId != null) {
        if (!cancelled) {
          setResolvedBountyId(Number(job?.onChainId ?? job?.bountyId));
          setResolveNote('');
          setResolvingId(false);
        }
        return;
      }

      // Only attempt resolution once per job
      if (resolutionAttemptedRef.current) {
        return;
      }
      resolutionAttemptedRef.current = true;

      const creator = job?.creator;
      const submissionCloseTime = job?.submissionCloseTime;

      if (!creator || !submissionCloseTime) {
        if (!cancelled) {
          setResolveNote('Missing data to resolve on-chain id (creator/deadline).');
        }
        return;
      }

      try {
        setResolvingId(true);

        // =====================================================================
        // STEP 1: Try backend resolution first (with 5-second timeout)
        // =====================================================================
        const txHash = job?.txHash || job?.creationTxHash || job?.chainTxHash || job?.createTxHash || null;
        const payload = {
          creator,
          rubricCid: job?.rubricCid || undefined,
          submissionCloseTime,
          txHash: txHash || undefined
        };

        setResolveNote('Trying backend resolution…');
        console.log('[Resolver] Calling backend with:', { jobId: job.jobId, payload });
        
        try {
          // Use direct fetch instead of apiService (more reliable)
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          
          const response = await fetch(`/api/jobs/${job.jobId}/bountyId/resolve`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          const res = await response.json();
          console.log('[Resolver] Backend response:', res);
          
          if (res?.success && res?.bountyId != null) {
            if (!cancelled) {
              setResolvedBountyId(Number(res.bountyId));
              setResolveNote(`✅ Backend resolved: bountyId ${res.bountyId}`);
              setTimeout(() => { if (!cancelled) setResolveNote(''); }, 3000);
            }
            return;
          }
          
          // Backend returned but no bountyId - log why
          console.log('[Resolver] Backend returned no bountyId:', res?.error || 'unknown reason');
          if (!cancelled) {
            setResolveNote(`Backend: ${res?.error || 'No matching bounty found'}`);
          }
        } catch (backendErr) {
          // Backend failed or timed out, continue to on-chain fallback
          const errMsg = backendErr.name === 'AbortError' ? 'Timeout after 5s' : backendErr.message;
          console.log('[Resolver] Backend failed:', errMsg);
          if (!cancelled) {
            setResolveNote(`Backend failed: ${errMsg.slice(0, 40)}...`);
          }
          // Brief pause to show the error before moving on
          await new Promise(r => setTimeout(r, 1000));
        }

        // =====================================================================
        // STEP 2: Direct on-chain resolution (query contract directly)
        // =====================================================================
        if (!cancelled) {
          setResolveNote('Trying direct on-chain scan…');
        }

        try {
          const contractService = getContractService();
          console.log('[Resolver] ContractService:', contractService);
          console.log('[Resolver] Contract address:', contractService?.contractAddress || contractService?.contract?.target);
          
          // Get the contract - might be contractService.contract or contractService itself
          const contract = contractService?.contract || contractService;
          
          if (!contract) {
            throw new Error('No contract available - is wallet connected?');
          }

          // Try to get bounty count
          let bountyCount = 0;
          try {
            if (typeof contract.bountyCount === 'function') {
              bountyCount = Number(await contract.bountyCount());
            } else if (typeof contractService.getBountyCount === 'function') {
              bountyCount = await contractService.getBountyCount();
            }
            console.log('[Resolver] Total bounties on chain:', bountyCount);
          } catch (err) {
            console.log('[Resolver] Could not get bounty count:', err.message);
            // Try scanning anyway with default range
            bountyCount = 20;
          }

          if (bountyCount === 0) {
            if (!cancelled) {
              setResolveNote('No bounties found on-chain. Enter ID manually below.');
            }
            return;
          }

          // First, try the jobId as the bountyId (they often match)
          const jobIdAsNumber = parseInt(job.jobId, 10);
          if (!isNaN(jobIdAsNumber) && jobIdAsNumber < bountyCount) {
            try {
              if (!cancelled) {
                setResolveNote(`Checking if jobId ${jobIdAsNumber} = bountyId...`);
              }
              
              let bountyInfo;
              if (typeof contract.getBounty === 'function') {
                const raw = await contract.getBounty(jobIdAsNumber);
                // Parse tuple: (creator, evaluationCid, requestedClass, threshold, payoutWei, createdAt, submissionDeadline, status, winner, submissions)
                bountyInfo = {
                  creator: raw[0],
                  submissionCloseTime: Number(raw[6])
                };
              } else if (typeof contractService.getBounty === 'function') {
                bountyInfo = await contractService.getBounty(jobIdAsNumber);
              }
              
              console.log('[Resolver] Bounty info for ID', jobIdAsNumber, ':', bountyInfo);
              
              if (bountyInfo?.creator?.toLowerCase() === creator.toLowerCase()) {
                // Check deadline with some tolerance (5 minutes)
                const deadlineDiff = Math.abs(Number(bountyInfo.submissionCloseTime) - submissionCloseTime);
                console.log('[Resolver] Creator matches! Deadline diff:', deadlineDiff, 'seconds');
                
                if (deadlineDiff < 300) {
                  if (!cancelled) {
                    setResolvedBountyId(jobIdAsNumber);
                    setResolveNote(`✅ Found: bountyId = ${jobIdAsNumber}`);
                    setTimeout(() => { if (!cancelled) setResolveNote(''); }, 3000);
                  }
                  return;
                }
              }
            } catch (err) {
              console.log(`[Resolver] jobId ${jobIdAsNumber} check failed:`, err.message);
            }
          }

          // Scan from most recent backwards (more likely to find recent bounties faster)
          let foundId = null;
          const scanStart = Math.min(bountyCount - 1, 50); // Don't scan more than 50
          
          for (let testId = scanStart; testId >= 0 && !foundId && !cancelled; testId--) {
            try {
              if (!cancelled && testId % 3 === 0) { // Update every 3 IDs
                setResolveNote(`Scanning... ID ${testId}/${scanStart}`);
              }
              
              let bountyInfo;
              if (typeof contract.getBounty === 'function') {
                const raw = await contract.getBounty(testId);
                bountyInfo = {
                  creator: raw[0],
                  submissionCloseTime: Number(raw[6])
                };
              } else if (typeof contractService.getBounty === 'function') {
                bountyInfo = await contractService.getBounty(testId);
              } else {
                console.log('[Resolver] No getBounty method available');
                break;
              }
              
              if (bountyInfo?.creator?.toLowerCase() === creator.toLowerCase()) {
                const deadlineDiff = Math.abs(Number(bountyInfo.submissionCloseTime) - submissionCloseTime);
                if (deadlineDiff < 300) { // 5 minute tolerance
                  foundId = testId;
                  console.log('[Resolver] Found match at ID', testId);
                  break;
                }
              }
            } catch (err) {
              // This ID might not exist or other error
              if (err.message?.includes('revert') || err.message?.includes('out of bounds')) {
                console.log('[Resolver] Reached end of bounties at ID', testId);
                break;
              }
            }
          }

          if (foundId !== null && !cancelled) {
            setResolvedBountyId(foundId);
            setResolveNote(`✅ Found on-chain: bountyId ${foundId}`);
            setTimeout(() => {
              if (!cancelled) setResolveNote('');
            }, 3000);
            return;
          }

          // No matching bounty found
          if (!cancelled) {
            setResolveNote(
              `Scanned ${Math.min(bountyCount, 50)} bounties - no match. Enter ID manually below.`
            );
          }

        } catch (chainErr) {
          console.log('[Resolver] On-chain scan error:', chainErr);
          if (!cancelled) {
            setResolveNote(`Scan error: ${chainErr.message?.slice(0, 50)}. Enter ID manually.`);
          }
        }

      } catch (e) {
        console.log('Resolution failed:', e.message);
        if (!cancelled) {
          setResolveNote(`Resolution failed. Use Ctrl+Shift+D for manual override.`);
        }
      } finally {
        if (!cancelled) setResolvingId(false);
      }
    })();

    return () => { cancelled = true; };
  }, [job?.jobId, retryCount]); // Re-run when jobId or retryCount changes

  // Reset resolution state when job changes (but not on retry)
  useEffect(() => {
    resolutionAttemptedRef.current = false;
    setResolvedBountyId(null);
    setResolveNote('');
  }, [job?.jobId]);

  // ============================================================================
  // MANUAL BOUNTY ID OVERRIDE (for debugging stuck bounties)
  // ============================================================================

  const handleManualBountyIdSet = useCallback((manualId) => {
    const parsed = parseInt(manualId, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      setResolvedBountyId(parsed);
      setResolveNote(`Manually set to bountyId ${parsed}`);
      setTimeout(() => setResolveNote(''), 2000);
    }
  }, []);

  // Retry resolution manually
  const handleRetryResolution = useCallback(() => {
    resolutionAttemptedRef.current = false;
    setResolvedBountyId(null);
    setResolveNote('Retrying resolution...');
    setResolvingId(false);
    // Increment retryCount to trigger the effect
    setRetryCount(prev => prev + 1);
  }, []);

  // ============================================================================
  // HELPERS
  // ============================================================================

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
        // Continue polling
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
      return { success: false, reason: 'already_polling' };
    }

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

          if (newStatus && !isPendingStatus(newStatus)) {
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

            // Clear evaluation results since we now have final status
            setEvaluationResults(prev => {
              const next = new Map(prev);
              next.delete(submissionId);
              return next;
            });

            return true;
          }
        } catch (err) {
          // Silently ignore polling errors
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

    const evalResult = evaluationResults.get(submissionId);
    const scorePreview = evalResult?.ready 
      ? `\nScore Preview: ${evalResult.scores.acceptance.toFixed(1)}% acceptance`
      : '';

    const confirmed = window.confirm(
      `Finalize submission #${submissionId}?\n\n` +
      'This will read the Verdikta evaluation results and update the submission status.' +
      scorePreview + '\n\n' +
      'This action requires a blockchain transaction that you must sign.'
    );
    if (!confirmed) return;

    let txHash = null;

    try {
      setFinalizingSubmissions(prev => new Set(prev).add(submissionId));
      setError(null);

      const contractService = getContractService();
      if (!contractService.isConnected()) await contractService.connect();

      const result = await contractService.finalizeSubmission(onChainId, submissionId);
      txHash = result.txHash;

      // Clear finalizing state
      setFinalizingSubmissions(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });

      // Start polling for status update
      const currentJobId = jobRef.current?.jobId || job?.jobId;

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

      const result = await contractService.failTimedOutSubmission(onChainId, submissionId);

      // Poll for backend to sync
      const currentJobId = jobRef.current?.jobId || job?.jobId;
      await pollForCondition(
        async () => {
          const response = await apiService.getJob(currentJobId, false);
          const sub = response.job?.submissions?.find(s => s.submissionId === submissionId);
          return sub && !isPendingStatus(sub.status);
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

      const result = await contractService.closeExpiredBounty(onChainId);

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
  const deadlinePassed = job?.submissionCloseTime && now > job.submissionCloseTime;

  const isOpen = status === 'OPEN';
  const isExpired = status === 'EXPIRED';
  const isAwarded = status === 'AWARDED';
  const isClosed = status === 'CLOSED';

  // NEW: Treat as expired if deadline passed, even if backend says OPEN
  const effectivelyExpired = isExpired || (isOpen && deadlinePassed);

  const hasActiveSubmissions = submissions.some(s =>
    isPendingStatus(s.status)
  );

  const pendingSubmissions = submissions.filter(s =>
    isPendingStatus(s.status)
  );

  const onChainIdForButtons = getOnChainBountyId();
  const disableActionsForMissingId = onChainIdForButtons == null;


  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="bounty-details">
      {/* DIAGNOSTIC PANEL (Ctrl+Shift+D to toggle) */}
      {showDiagnostics && (
        <DiagnosticPanel
          job={job}
          bountyId={bountyId}
          resolvedBountyId={resolvedBountyId}
          onChainId={onChainIdForButtons}
          statusOverride={statusOverride}
          deadlinePassed={deadlinePassed}
          submissions={submissions}
          walletState={walletState}
          onRefresh={() => loadJobDetails()}
          onManualIdSet={handleManualBountyIdSet}
          onRetryResolution={handleRetryResolution}
          resolveNote={resolveNote}
          resolvingId={resolvingId}
        />
      )}

      {/* STATUS OVERRIDE WARNING */}
      {statusOverride && (
        <div style={{
          backgroundColor: '#fff3e0',
          border: '2px solid #ff9800',
          padding: '0.75rem 1rem',
          borderRadius: '6px',
          marginBottom: '1rem',
          fontSize: '0.9rem'
        }}>
          ⚠️ <strong>Status Override:</strong> Backend shows "{statusOverride.backendStatus}" but {statusOverride.reason}. 
          Using on-chain status: <strong>{statusOverride.onChainStatus}</strong>
          <button 
            onClick={() => loadJobDetails()} 
            style={{ marginLeft: '1rem', fontSize: '0.85rem' }}
            className="btn btn-sm"
          >
            🔄 Refresh
          </button>
        </div>
      )}

      {/* RESOLUTION STATUS (shown when trying to resolve bountyId) */}
      {resolveNote && !effectivelyExpired && (
        <div style={{
          backgroundColor: '#e3f2fd',
          border: '2px solid #2196f3',
          padding: '0.75rem 1rem',
          borderRadius: '6px',
          marginBottom: '1rem',
          fontSize: '0.9rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem'
        }}>
          <div className="spinner" style={{
            width: '16px',
            height: '16px',
            border: '2px solid #90caf9',
            borderTop: '2px solid #1976d2',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            flexShrink: 0
          }} />
          <span>📡 {resolveNote}</span>
          <button 
            onClick={() => setShowDiagnostics(true)}
            style={{ 
              marginLeft: 'auto', 
              fontSize: '0.8rem',
              padding: '0.25rem 0.5rem',
              backgroundColor: '#1976d2',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Open Diagnostics
          </button>
        </div>
      )}

      {/* EXPIRED Status Banner (also shown when effectively expired) */}
      {effectivelyExpired && (
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
              evaluationResults={evaluationResults}
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
                effectivelyExpired || isClosed || isAwarded ? 'Ended' :
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
          {isOpen && !deadlinePassed && walletState.isConnected && (
            <Link to={`/bounty/${bountyId}/submit`} className="btn btn-primary btn-lg">
              Submit Work
            </Link>
          )}

          {isOpen && !deadlinePassed && !walletState.isConnected && (
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

          {effectivelyExpired && !isExpired && (
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
              evaluationResults={evaluationResults}
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
                evaluationResult={evaluationResults.get(submission.submissionId)}
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

/**
 * DiagnosticPanel - Shows backend vs on-chain status comparison
 * Toggle with Ctrl+Shift+D
 */
function DiagnosticPanel({ 
  job, 
  bountyId, 
  resolvedBountyId, 
  onChainId, 
  statusOverride, 
  deadlinePassed,
  submissions,
  walletState,
  onRefresh,
  onManualIdSet,
  onRetryResolution,
  resolveNote,
  resolvingId
}) {
  const now = Math.floor(Date.now() / 1000);
  const [manualIdInput, setManualIdInput] = useState('');
  
  return (
    <div style={{
      backgroundColor: '#1a1a2e',
      color: '#e0e0e0',
      padding: '1rem',
      borderRadius: '8px',
      marginBottom: '1.5rem',
      fontFamily: 'monospace',
      fontSize: '0.85rem'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: 0, color: '#4fc3f7' }}>🔧 Diagnostic Panel</h3>
        <span style={{ color: '#888', fontSize: '0.75rem' }}>Ctrl+Shift+D to toggle</span>
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <div>
          <div style={{ color: '#aaa', marginBottom: '0.25rem' }}>IDs:</div>
          <div>Backend jobId: <span style={{ color: '#4caf50' }}>{bountyId}</span></div>
          <div>job.bountyId: <span style={{ color: job?.bountyId != null ? '#4caf50' : '#f44336' }}>{job?.bountyId ?? 'null'}</span></div>
          <div>job.onChainId: <span style={{ color: job?.onChainId != null ? '#4caf50' : '#f44336' }}>{job?.onChainId ?? 'null'}</span></div>
          <div>resolvedBountyId: <span style={{ color: resolvedBountyId != null ? '#4caf50' : '#888' }}>{resolvedBountyId ?? 'null'}</span></div>
          <div>Effective onChainId: <span style={{ color: onChainId != null ? '#4caf50' : '#f44336', fontWeight: 'bold' }}>{onChainId ?? 'MISSING'}</span></div>
        </div>
        
        <div>
          <div style={{ color: '#aaa', marginBottom: '0.25rem' }}>Status:</div>
          <div>Current status: <span style={{ color: '#ffeb3b' }}>{job?.status || 'unknown'}</span></div>
          {statusOverride && (
            <>
              <div>Original backend: <span style={{ color: '#888' }}>{statusOverride.backendStatus}</span></div>
              <div>Override reason: <span style={{ color: '#ff9800', fontSize: '0.8rem' }}>{statusOverride.reason}</span></div>
            </>
          )}
          <div>Deadline: <span style={{ color: deadlinePassed ? '#f44336' : '#4caf50' }}>
            {job?.submissionCloseTime ? new Date(job.submissionCloseTime * 1000).toLocaleString() : 'unknown'}
            {deadlinePassed && ' (PASSED)'}
          </span></div>
          <div>Now: {new Date(now * 1000).toLocaleString()}</div>
        </div>
      </div>

      {/* Resolution status */}
      {resolveNote && (
        <div style={{ 
          marginTop: '0.75rem', 
          padding: '0.5rem', 
          backgroundColor: '#2d2d44', 
          borderRadius: '4px',
          color: '#ffcc80'
        }}>
          📡 {resolveNote}
        </div>
      )}

      {/* Manual ID input - shown when onChainId is missing */}
      {onChainId == null && onManualIdSet && (
        <div style={{ 
          marginTop: '0.75rem', 
          padding: '0.75rem', 
          backgroundColor: '#2d2d44', 
          borderRadius: '4px',
          border: '1px solid #ff9800'
        }}>
          <div style={{ color: '#ff9800', marginBottom: '0.5rem', fontWeight: 'bold' }}>
            ⚠️ Manual Override (use if you know the on-chain bountyId)
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="number"
              min="0"
              placeholder="Enter on-chain bountyId"
              value={manualIdInput}
              onChange={(e) => setManualIdInput(e.target.value)}
              style={{
                flex: 1,
                padding: '0.4rem',
                borderRadius: '4px',
                border: '1px solid #555',
                backgroundColor: '#1a1a2e',
                color: '#e0e0e0',
                fontFamily: 'monospace'
              }}
            />
            <button
              onClick={() => {
                if (manualIdInput) {
                  onManualIdSet(manualIdInput);
                  setManualIdInput('');
                }
              }}
              style={{
                padding: '0.4rem 0.75rem',
                backgroundColor: '#ff9800',
                color: '#000',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              Set ID
            </button>
          </div>
          
          {/* Search help - show creator and deadline for BaseScan lookup */}
          <div style={{ marginTop: '0.75rem', padding: '0.5rem', backgroundColor: '#1a1a2e', borderRadius: '4px' }}>
            <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: '0.25rem' }}>
              🔍 To find your bountyId on BaseScan:
            </div>
            <div style={{ fontSize: '0.75rem', color: '#aaa' }}>
              Creator: <span style={{ color: '#4fc3f7', fontFamily: 'monospace' }}>{job?.creator || 'unknown'}</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#aaa' }}>
              Deadline (unix): <span style={{ color: '#4fc3f7', fontFamily: 'monospace' }}>{job?.submissionCloseTime || 'unknown'}</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '0.5rem' }}>
              Search for BountyCreated events on the contract where creator matches your address
            </div>
          </div>
        </div>
      )}
      
      <div style={{ marginTop: '0.75rem' }}>
        <div style={{ color: '#aaa', marginBottom: '0.25rem' }}>Submissions ({submissions.length}):</div>
        {submissions.length === 0 ? (
          <div style={{ marginLeft: '0.5rem', color: '#888' }}>No submissions</div>
        ) : (
          submissions.map(s => (
            <div key={s.submissionId} style={{ marginLeft: '0.5rem' }}>
              #{s.submissionId}: {s.status} 
              {s.submittedAt && ` (${((now - s.submittedAt) / 60).toFixed(1)}min ago)`}
            </div>
          ))
        )}
      </div>
      
      <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={onRefresh} style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}>
          🔄 Refresh Data
        </button>
        {onChainId == null && onRetryResolution && (
          <button 
            onClick={onRetryResolution} 
            disabled={resolvingId}
            style={{ 
              fontSize: '0.8rem', 
              padding: '0.25rem 0.5rem',
              backgroundColor: resolvingId ? '#555' : '#ff9800',
              color: resolvingId ? '#888' : '#000',
              border: 'none',
              borderRadius: '4px',
              cursor: resolvingId ? 'not-allowed' : 'pointer'
            }}
          >
            {resolvingId ? '⏳ Resolving...' : '🔍 Retry Resolution'}
          </button>
        )}
        <span style={{ color: '#888', fontSize: '0.75rem', alignSelf: 'center' }}>
          Wallet: {walletState.isConnected ? `${walletState.address?.slice(0,8)}...` : 'Not connected'}
        </span>
      </div>

      {/* Quick info about the job for debugging */}
      <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#666' }}>
        Creator: {job?.creator || 'unknown'} | 
        Rubric CID: {job?.rubricCid?.slice(0,12) || 'none'}... |
        txHash: {job?.txHash?.slice(0,12) || job?.creationTxHash?.slice(0,12) || 'none'}...
      </div>
    </div>
  );
}

function PendingSubmissionsPanel({
  pendingSubmissions,
  getSubmissionAge,
  onFinalize,
  onFailTimeout,
  finalizingSubmissions,
  failingSubmissions,
  pollingSubmissions,
  evaluationResults,
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
        const evalResult = evaluationResults?.get(s.submissionId);

        return (
          <div key={s.submissionId} style={{
            marginBottom: '1rem',
            padding: '0.75rem',
            backgroundColor: evalResult?.ready ? '#e8f5e9' : '#fff',
            border: evalResult?.ready ? '2px solid #4caf50' : '1px solid #ddd',
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

            {/* Evaluation ready indicator */}
            {evalResult?.ready && (
              <div style={{
                marginBottom: '0.5rem',
                padding: '0.5rem',
                backgroundColor: '#c8e6c9',
                borderRadius: '4px',
                fontSize: '0.85rem',
                color: '#2e7d32'
              }}>
                ✅ <strong>AI Evaluation Complete!</strong> Score: {evalResult.scores.acceptance.toFixed(1)}% ({evalResult.scores.rejection.toFixed(1)}% rejection)
              </div>
            )}

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
                className={evalResult?.ready ? "btn btn-success btn-sm" : "btn btn-primary btn-sm"}
                style={{ 
                  fontSize: '0.85rem', 
                  padding: '0.4rem 0.8rem',
                  fontWeight: evalResult?.ready ? 'bold' : 'normal'
                }}
              >
                {isFinalizing ? '⏳ Finalizing...' : evalResult?.ready ? '🎉 Claim Results & Update Status' : '✅ Finalize'}
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

            {!canTimeout && !evalResult?.ready && (
              <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.5rem' }}>
                ⏳ Force-fail available in {(timeoutMinutes - ageMinutes).toFixed(1)} min
              </div>
            )}
          </div>
        );
      })}
      <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#666' }}>
        💡 Auto-checking every 15 seconds. Submissions stuck &gt;{timeoutMinutes} minutes can be force-failed.
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
  evaluationResults,
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
          evaluationResults={evaluationResults}
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
  evaluationResult,
  disableActions,
  getSubmissionAge,
  timeoutMinutes
}) {
  const isPending = isPendingStatus(submission.status);
  const isApproved = submission.status === 'APPROVED' || submission.status === 'ACCEPTED' || submission.status === 'PassedPaid';
  const isRejected = submission.status === 'REJECTED' || submission.status === 'Failed';
  const ageMinutes = isPending && submission.submittedAt ? getSubmissionAge(submission.submittedAt) : 0;
  const canTimeout = ageMinutes > timeoutMinutes;
  const canFinalize = isPending && !isPolling;
  const hasEvalReady = evaluationResult?.ready;

  // Helper to get display status for pending submissions
  const getStatusDisplay = () => {
    if (isApproved) return '✅ APPROVED';
    if (isRejected) return '❌ REJECTED';
    if (isPending) return '⏳ EVALUATING';
    return submission.status;
  };

  const getStatusBadgeClass = () => {
    if (isApproved) return 'status-approved';
    if (isRejected) return 'status-rejected';
    if (isPending) return 'status-pending';
    return `status-${submission.status?.toLowerCase()}`;
  };

  return (
    <div className="submission-card" style={{
      border: hasEvalReady ? '2px solid #4caf50' : undefined,
      backgroundColor: hasEvalReady ? '#f1f8e9' : undefined
    }}>
      <div className="submission-header">
        <span className="hunter">{submission.hunter?.substring(0, 10)}...</span>
        <span className={`status-badge ${getStatusBadgeClass()}`}>
          {getStatusDisplay()}
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
        <span>Submitted: {submission.submittedAt ? new Date(submission.submittedAt * 1000).toLocaleString() : 'Just now'}</span>
      </div>

      {/* NEW: Evaluation ready indicator */}
      {hasEvalReady && (
        <div style={{
          marginTop: '0.75rem',
          padding: '0.75rem',
          backgroundColor: '#c8e6c9',
          border: '1px solid #81c784',
          borderRadius: '4px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '1rem', color: '#2e7d32', fontWeight: 'bold', marginBottom: '0.25rem' }}>
            ✅ AI Evaluation Complete!
          </div>
          <div style={{ fontSize: '0.9rem', color: '#388e3c' }}>
            Score: {evaluationResult.scores.acceptance.toFixed(1)}% ({evaluationResult.scores.rejection.toFixed(1)}% rejection)
          </div>
        </div>
      )}

      {/* Waiting for evaluation indicator */}
      {isPending && !hasEvalReady && !isPolling && (
        <div style={{
          marginTop: '0.75rem',
          padding: '0.75rem',
          backgroundColor: '#fff3e0',
          border: '1px solid #ffcc80',
          borderRadius: '4px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '0.9rem', color: '#e65100', fontWeight: 'bold' }}>
            ⏳ Waiting for AI evaluation...
          </div>
          <div style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.25rem' }}>
            {ageMinutes.toFixed(1)} min elapsed • Checking every 15s
          </div>
        </div>
      )}

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
              className={hasEvalReady ? "btn btn-success" : "btn btn-primary btn-sm"}
              style={{ 
                fontSize: hasEvalReady ? '1rem' : '0.85rem', 
                padding: hasEvalReady ? '0.75rem 1rem' : '0.4rem 0.8rem', 
                width: '100%',
                fontWeight: hasEvalReady ? 'bold' : 'normal'
              }}
            >
              {isFinalizing 
                ? '⏳ Processing transaction...' 
                : hasEvalReady 
                  ? '🎉 Claim Results & Update Status' 
                  : '✅ Finalize Submission (check results)'}
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
          ) : !hasEvalReady && (
            <div style={{ fontSize: '0.8rem', color: '#888', textAlign: 'center' }}>
              Force-fail in {(timeoutMinutes - ageMinutes).toFixed(1)} min
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

