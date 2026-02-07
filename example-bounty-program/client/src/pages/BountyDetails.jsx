import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  RefreshCw,
  AlertTriangle,
  Clock,
  Lock,
  Check,
  X,
  FileText,
  Send,
  Hourglass,
  Trophy,
  Search,
  Loader2,
  Ban,
} from 'lucide-react';
import { useToast } from '../components/Toast';
import { apiService } from '../services/api';
import { getContractService } from '../services/contractService';
import { config, currentNetwork } from '../config';
import {
  BountyStatus,
  ON_CHAIN_STATUS_MAP,
  getBountyStatusLabel,
  getBountyBadgeProps,
  getBountyStatusDescription,
  isBountyOpen,
  isSubmissionPending,
  isSubmissionOnChain,
  getSubmissionStatusLabel,
  getSubmissionStatusIcon,
  getSubmissionBadgeProps,
  hasAnyPendingSubmissions,
  IconName,
} from '../utils/statusDisplay';
import JustificationDisplay from '../components/JustificationDisplay';
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
  // NOTE: Must match contract's 20 minute requirement in failTimedOutSubmission()
  SUBMISSION_TIMEOUT_MINUTES: 10,

  // How often to update the live timer display (1 second)
  TIMER_UPDATE_INTERVAL_MS: 1000,

  // How often to check if Verdikta evaluation is ready (15 seconds)
  EVALUATION_CHECK_INTERVAL_MS: 15000,
};

// Alias for backwards compatibility with existing code
const isPendingStatus = isSubmissionPending;

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Copy text to clipboard with fallback for HTTP (non-secure) contexts.
 * navigator.clipboard requires HTTPS, so we fall back to execCommand.
 */
function copyToClipboard(text, toast) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text);
  } else {
    // Fallback for HTTP
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
  }
  toast.success('Copied to clipboard');
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

function BountyDetails({ walletState }) {
  const toast = useToast();
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
  const [cancelingSubmissions, setCancelingSubmissions] = useState(new Set());
  const [refreshingSubmissions, setRefreshingSubmissions] = useState(new Set());

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

  // jobId === onChainId (aligned ID system)
  const getOnChainBountyId = useCallback(() => {
    const id = parseInt(bountyId, 10);
    return Number.isNaN(id) ? null : id;
  }, [bountyId]);

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

    // Get on-chain submissions that aren't already being actively polled after finalization
    // Skip "Prepared" submissions - they don't exist on-chain yet
    // Skip already-evaluated submissions (ACCEPTED_PENDING_CLAIM / REJECTED_PENDING_FINALIZATION)
    const pendingSubs = submissions.filter(s =>
      isSubmissionOnChain(s.status) &&
      s.status !== 'ACCEPTED_PENDING_CLAIM' &&
      s.status !== 'REJECTED_PENDING_FINALIZATION' &&
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

      // Only check on-chain submissions (not Prepared)
      const currentSubs = submissionsRef.current.filter(s =>
        isSubmissionOnChain(s.status) &&
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

      // Check if bounty belongs to the current network
      const jobContract = (finalJob?.contractAddress || '').toLowerCase();
      const currentContract = (config.bountyEscrowAddress || '').toLowerCase();
      if (jobContract && currentContract && jobContract !== currentContract) {
        setError(
          `This bounty was created on a different network. ` +
          `You are currently connected to ${currentNetwork.name}. ` +
          `Please switch to the correct network to interact with this bounty.`
        );
        setLoading(false);
        return null;
      }

      // Store backend status before any override
      const backendStatus = finalJob?.status;

      // ========================================================================
      // ON-CHAIN STATUS VERIFICATION
      // Check if on-chain status differs from backend and override if needed
      // ========================================================================
      if (finalJob) {
        const onChainId = finalJob.jobId;
        
        if (onChainId != null) {
          try {
            const contractService = getContractService();
            // getBountyStatus() returns a string: "OPEN", "EXPIRED", "AWARDED", or "CLOSED"
            const onChainStatus = await contractService.getBountyStatus(Number(onChainId));

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
            console.log('[Status] Could not verify on-chain status:', err.message);
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

  // Initial load - only runs on mount and when bountyId/retryCount changes
  // Note: We intentionally do NOT include loadJobDetails in deps to avoid
  // resetting state when loadJobDetails reference changes
  useEffect(() => {
    isMountedRef.current = true;
    loadJobDetails();
    
    // Only reset on actual bountyId change (initial mount or navigation)
    // Don't reset when just retrying
    if (retryCount === 0) {
      setResolvedBountyId(null);
      setResolvingId(false);
      setResolveNote('');
      setEvaluationResults(new Map());
      setStatusOverride(null);
    }

    return () => {
      isMountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bountyId, retryCount]);

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

      // Only refresh on-chain submissions (PendingVerdikta), not Prepared ones
      // Prepared submissions don't exist on-chain yet, so blockchain refresh will fail
      const pendingSubs = currentSubs.filter(s => {
        if (!isSubmissionOnChain(s.status)) return false;
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

      // jobId === onChainId in the aligned system, so resolution is trivial
      if (job?.jobId != null) {
        if (!cancelled) {
          setResolvedBountyId(Number(job.jobId));
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
      toast.warning('Please connect your wallet first');
      return;
    }

    const onChainId = getOnChainBountyId();
    if (onChainId == null) {
      toast.warning('Unable to determine the on-chain bounty ID yet. Please wait for sync or refresh.');
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

        toast.success(`Submission #${submissionId} finalized! Status: ${statusDisplay}, Score: ${updatedSubmission.acceptance?.toFixed(1) || 'N/A'}%`);

        // Reload the full job details
        loadJobDetails(true);
      });

      // If polling timed out, show a different message
      if (!pollResult.success && pollResult.reason === 'timeout') {
        toast.info('Transaction confirmed! Status is syncing. The page will auto-refresh.');

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

      toast.error(`Failed to finalize submission #${submissionId}: ${err.message}`);
    }
  };

  const handleFailTimedOutSubmission = async (submissionId) => {
    if (!walletState.isConnected) {
      toast.warning('Please connect your wallet first');
      return;
    }

    const onChainId = getOnChainBountyId();
    if (onChainId == null) {
      toast.warning('Unable to determine the on-chain bounty ID yet. Please wait for sync or refresh.');
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

      toast.success(`Submission #${submissionId} marked as failed (timeout). LINK tokens refunded.`);

      setRetryCount(0);
      await loadJobDetails();
    } catch (err) {
      console.error('❌ Error failing timed-out submission:', err);
      setError(err.message || 'Failed to mark submission as timed-out');
      toast.error(`Failed to timeout submission #${submissionId}: ${err.message}`);
    } finally {
      setFailingSubmissions(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
    }
  };

  const handleCancelSubmission = async (submissionId) => {
    const confirmed = window.confirm(
      `Cancel submission #${submissionId}?\n\n` +
      'This will remove the submission from the system.\n' +
      'Only Prepared (not started) submissions can be cancelled.'
    );
    if (!confirmed) return;

    try {
      setCancelingSubmissions(prev => new Set(prev).add(submissionId));
      setError(null);

      const currentJobId = jobRef.current?.jobId || job?.jobId;
      await apiService.cancelSubmission(currentJobId, submissionId);

      toast.success(`Submission #${submissionId} has been cancelled.`);

      setRetryCount(0);
      await loadJobDetails();
    } catch (err) {
      console.error('Error cancelling submission:', err);
      setError(err.message || 'Failed to cancel submission');
      toast.error(`Failed to cancel submission: ${err.message}`);
    } finally {
      setCancelingSubmissions(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
    }
  };

  const handleRefreshSubmission = async (submissionId) => {
    try {
      setRefreshingSubmissions(prev => new Set(prev).add(submissionId));
      setError(null);

      const currentJobId = jobRef.current?.jobId || job?.jobId;
      const result = await apiService.refreshSubmission(currentJobId, submissionId);

      if (result.success) {
        // Update the submission in state
        setSubmissions(prev =>
          prev.map(s =>
            s.submissionId === submissionId ? { ...s, ...result.submission } : s
          )
        );

        if (result.submission.status !== 'Prepared' && result.submission.status !== 'PREPARED') {
          toast.success(`Submission status updated to: ${result.submission.status}`);
        } else {
          toast.warning('Submission is still in Prepared state. The evaluation may not have started.');
        }
      }
    } catch (err) {
      console.error('Error refreshing submission:', err);
      setError(err.message || 'Failed to refresh submission');
      toast.error(`Failed to refresh submission: ${err.message}`);
    } finally {
      setRefreshingSubmissions(prev => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
    }
  };

  const handleCloseExpiredBounty = async () => {
    if (!walletState.isConnected) {
      toast.warning('Please connect your wallet first');
      return;
    }

    const onChainId = getOnChainBountyId();
    if (onChainId == null) {
      toast.warning('Unable to determine the on-chain bounty ID yet. Please wait for sync or refresh.');
      return;
    }

    // Check for pending submissions that need to be finalized first
    const pendingToFinalize = submissions.filter(s => {
      const status = (s.status || s.onChainStatus || '').toLowerCase();
      return status === 'pendingverdikta' || status === 'pending_evaluation';
    });

    let confirmMessage = 'Close this expired bounty and return funds to the creator?\n\n';
    if (pendingToFinalize.length > 0) {
      confirmMessage += `This will first finalize ${pendingToFinalize.length} pending submission(s), then close the bounty.\n`;
      confirmMessage += `You will need to sign ${pendingToFinalize.length + 1} transaction(s).\n\n`;
    }
    confirmMessage += 'This action requires blockchain transaction(s) that you must sign.';

    const confirmed = window.confirm(confirmMessage);
    if (!confirmed) return;

    try {
      setClosingBounty(true);
      setError(null);

      const contractService = getContractService();
      if (!contractService.isConnected()) await contractService.connect();

      // First, finalize any pending submissions
      if (pendingToFinalize.length > 0) {
        for (let i = 0; i < pendingToFinalize.length; i++) {
          const sub = pendingToFinalize[i];
          const subId = sub.onChainSubmissionId ?? sub.submissionId;
          setClosingMessage(`Finalizing submission ${i + 1}/${pendingToFinalize.length} (#${subId})...`);

          try {
            await contractService.finalizeSubmission(onChainId, subId);
            toast.info(`Finalized submission #${subId}`);
          } catch (err) {
            // If finalization fails, warn but continue trying others
            console.warn(`Failed to finalize submission #${subId}:`, err.message);
            toast.warning(`Could not finalize submission #${subId}: ${err.message}`);
          }
        }

        // Brief pause to let blockchain state settle
        setClosingMessage('Preparing to close bounty...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      setClosingMessage('Closing bounty...');
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
        toast.success(`Bounty closed! ${job?.bountyAmount ?? '...'} ETH returned to creator.`);
      } else {
        toast.info('Transaction confirmed! Status is syncing and will update shortly.');
      }

      setRetryCount(0);
      await loadJobDetails();
    } catch (err) {
      console.error('❌ Error closing bounty:', err);
      setError(err.message || 'Failed to close bounty');
      toast.error(`Failed to close bounty: ${err.message}`);
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
          <h2><AlertTriangle size={24} className="inline-icon" /> Job Not Found</h2>
          <p>{error}</p>
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <Link to="/" className="btn btn-primary">Back to Home</Link>
            <button onClick={() => setRetryCount(0)} className="btn btn-secondary btn-with-icon">
              <RefreshCw size={16} /> Try Again
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
  const isExpired = status === 'EXPIRED' || status?.includes?.('EXPIRED');
  const isAwarded = status === 'AWARDED';
  const isClosed = status === 'CLOSED';

  // Treat as expired if: status is EXPIRED, OR deadline passed (even if backend says OPEN)
  const effectivelyExpired = isExpired || (isOpen && deadlinePassed);

  // For expired bounties, only PendingVerdikta blocks closing (Prepared can never start)
  // For open bounties, both Prepared and PendingVerdikta are considered active
  const isActivelyPending = (status) => {
    const s = status?.toString?.() || '';
    if (effectivelyExpired) {
      // Only actively-evaluating submissions block closing an expired bounty
      return s === 'PendingVerdikta' || s === 'PENDING_EVALUATION';
    }
    return isPendingStatus(status);
  };

  const hasActiveSubmissions = submissions.some(s =>
    isActivelyPending(s.status)
  );

  const pendingSubmissions = submissions.filter(s =>
    isActivelyPending(s.status)
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
          <AlertTriangle size={16} className="inline-icon" /> <strong>Status Override:</strong> Backend shows "{statusOverride.backendStatus}" but {statusOverride.reason}.
          Using on-chain status: <strong>{statusOverride.onChainStatus}</strong>
          <button
            onClick={() => loadJobDetails()}
            style={{ marginLeft: '1rem', fontSize: '0.85rem' }}
            className="btn btn-sm btn-with-icon"
          >
            <RefreshCw size={14} /> Refresh
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
          backgroundColor: job?.onChain === false ? '#f8d7da' : '#fff3cd',
          border: `3px solid ${job?.onChain === false ? '#f5c6cb' : '#ffc107'}`,
          padding: '1.5rem',
          borderRadius: '8px',
          marginBottom: '2rem',
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        }}>
          {/* Show different content for jobs that never went on-chain */}
          {job?.onChain === false ? (
            <>
              <h2 style={{ margin: '0 0 1rem 0', color: '#721c24', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Clock size={28} /> Bounty Never Deployed
              </h2>
              <p style={{ marginBottom: '1rem', fontSize: '1.1rem', color: '#721c24' }}>
                This bounty was created but <strong>never deployed on-chain</strong>.
                The blockchain transaction may have failed or was never submitted.
              </p>
              <p style={{ marginBottom: '0', fontSize: '1rem', color: '#856404' }}>
                No escrow exists to reclaim. This job will be automatically archived.
              </p>
            </>
          ) : (
            <>
              <h2 style={{ margin: '0 0 1rem 0', color: '#856404', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Clock size={28} /> Expired Bounty - Action Required
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
                  onCancel={handleCancelSubmission}
                  finalizingSubmissions={finalizingSubmissions}
                  failingSubmissions={failingSubmissions}
                  cancelingSubmissions={cancelingSubmissions}
                  pollingSubmissions={pollingSubmissions}
                  evaluationResults={evaluationResults}
                  disableActions={disableActionsForMissingId}
                  timeoutMinutes={CONFIG.SUBMISSION_TIMEOUT_MINUTES}
                  job={job}
                  toast={toast}
                />
              )}

              {!walletState.isConnected ? (
                <div className="alert alert-info">
                  <strong>Connect your wallet</strong> to finalize submissions and close this bounty.
                </div>
              ) : (
                <>
                  {hasActiveSubmissions && (
                    <div className="alert alert-info" style={{ marginBottom: '0.75rem' }}>
                      {pendingSubmissions.length} pending submission(s) will be auto-finalized when you close the bounty.
                    </div>
                  )}
                  <button
                    onClick={handleCloseExpiredBounty}
                    disabled={closingBounty || disableActionsForMissingId}
                    className="btn btn-warning btn-lg"
                    style={{ width: '100%', fontSize: '1.2rem', padding: '1.25rem', fontWeight: 'bold' }}
                    title={disableActionsForMissingId ? 'Resolving on-chain bountyId…' : undefined}
                  >
                    {closingBounty
                      ? <><Loader2 size={20} className="spin" /> {closingMessage || 'Processing...'}</>
                      : <><Lock size={20} /> Close Expired Bounty & Return Funds</>}
                  </button>
                  {disableActionsForMissingId && !closingBounty && (
                    <p style={{ marginTop: 8, color: '#666', fontSize: '0.9rem' }}>
                      Resolving on-chain bounty ID...
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Bounty Header */}
      <div className="bounty-header">
        <div className="header-content">
          <h1>{job?.title || `Job #${bountyId}`}</h1>
          <span {...getBountyBadgeProps(status)}>{getBountyStatusLabel(status)}</span>
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
            <span className="label">Bounty #</span>
            <span className="value">{getOnChainBountyId() ?? '...'}</span>
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
          {/* Support both camelCase and snake_case naming */}
          {((rubric.forbiddenContent || rubric.forbidden_content)?.length > 0) && (
            <div className="forbidden-content">
              <h3><Ban size={18} className="inline-icon" /> Forbidden Content</h3>
              <ul>{(rubric.forbiddenContent || rubric.forbidden_content).map((item, index) => (<li key={index}>{item}</li>))}</ul>
            </div>
          )}
        </section>
      )}

      {/* Jury Configuration Section - AI Models */}
      {job?.juryNodes && job.juryNodes.length > 0 && (
        <section className="jury-section">
          <h2>AI Jury Configuration</h2>
          <p className="jury-description">
            Submissions are evaluated by multiple AI models. Each model scores independently,
            and the final score is a weighted average.
          </p>
          <div className="jury-grid">
            {job.juryNodes.map((node, index) => (
              <div key={index} className="jury-card">
                <div className="jury-provider">{node.provider}</div>
                <div className="jury-model">{node.model}</div>
                <div className="jury-details">
                  <span className="jury-weight">Weight: {Math.round(node.weight * 100)}%</span>
                  {node.runs > 1 && <span className="jury-runs">{node.runs} runs</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Actions Section */}
      <section className="actions-section">
        <h2>Actions</h2>
        <div className="action-buttons">
          {isOpen && !deadlinePassed && walletState.isConnected && (
            <Link to={`/bounty/${bountyId}/submit`} className="btn btn-primary btn-lg btn-with-icon">
              <Send size={20} /> Submit Work
            </Link>
          )}

          {isOpen && !deadlinePassed && !walletState.isConnected && (
            <div className="alert alert-info">Connect your wallet to submit work</div>
          )}

          {isAwarded && (
            <div className="alert alert-success">
              <Trophy size={20} className="inline-icon" /> This bounty has been completed and the winner has been paid {job?.bountyAmount ?? '...'} ETH!
            </div>
          )}

          {isClosed && (
            <div className="alert alert-info">
              This bounty has been closed and {job?.bountyAmount ?? '...'} ETH has been returned to the creator.
            </div>
          )}

          {effectivelyExpired && !isExpired && job?.onChain !== false && (
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
              onCancel={handleCancelSubmission}
              finalizingSubmissions={finalizingSubmissions}
              failingSubmissions={failingSubmissions}
              cancelingSubmissions={cancelingSubmissions}
              pollingSubmissions={pollingSubmissions}
              evaluationResults={evaluationResults}
              timeoutMinutes={CONFIG.SUBMISSION_TIMEOUT_MINUTES}
              toast={toast}
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
                jobId={bountyId}
                walletState={walletState}
                onFailTimeout={handleFailTimedOutSubmission}
                onFinalize={handleFinalizeSubmission}
                onCancel={handleCancelSubmission}
                onRefresh={handleRefreshSubmission}
                isFailing={failingSubmissions.has(submission.submissionId)}
                isFinalizing={finalizingSubmissions.has(submission.submissionId)}
                isCanceling={cancelingSubmissions.has(submission.submissionId)}
                isRefreshing={refreshingSubmissions.has(submission.submissionId)}
                isPolling={pollingSubmissions.has(submission.submissionId)}
                pollingState={pollingSubmissions.get(submission.submissionId)}
                evaluationResult={evaluationResults.get(submission.submissionId)}
                disableActions={disableActionsForMissingId}
                getSubmissionAge={getSubmissionAge}
                timeoutMinutes={CONFIG.SUBMISSION_TIMEOUT_MINUTES}
                threshold={job?.threshold ?? 80}
                juryNodes={job?.juryNodes}
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
          <div>URL bountyId: <span style={{ color: '#4caf50' }}>{bountyId}</span></div>
          <div>job.jobId: <span style={{ color: job?.jobId != null ? '#4caf50' : '#f44336' }}>{job?.jobId ?? 'null'}</span></div>
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
        <button onClick={onRefresh} style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
          <RefreshCw size={12} /> Refresh Data
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
              cursor: resolvingId ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem'
            }}
          >
            {resolvingId ? <><Loader2 size={12} className="spin" /> Resolving...</> : <><Search size={12} /> Retry Resolution</>}
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
  onCancel,
  finalizingSubmissions,
  failingSubmissions,
  cancelingSubmissions,
  pollingSubmissions,
  evaluationResults,
  disableActions,
  timeoutMinutes,
  job,
  toast
}) {
  return (
    <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
      <h4 style={{ margin: '0 0 0.75rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Hourglass size={18} /> Pending Evaluations</h4>
      <p style={{ marginBottom: '0.75rem' }}>
        The following submissions are being evaluated:
      </p>
      {pendingSubmissions.map(s => {
        const ageMinutes = getSubmissionAge(s.submittedAt);
        const isOnChain = isSubmissionOnChain(s.status);
        const isPrepared = s.status === 'Prepared' || s.status === 'PREPARED';
        // Only allow timeout for on-chain submissions (not Prepared)
        const canTimeout = isOnChain && ageMinutes > timeoutMinutes;
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
                Submission #{s.submissionId} by{' '}
                <span
                  style={{ cursor: 'pointer', textDecoration: 'underline dotted' }}
                  title={`${s.hunter} (click to copy)`}
                  onClick={() => copyToClipboard(s.hunter, toast)}
                >
                  {s.hunter?.substring(0, 10)}...
                </span>
              </span>
              <span style={{ fontSize: '0.85rem', color: '#888', marginLeft: 'auto' }}>
                {ageMinutes.toFixed(1)} min elapsed
              </span>
            </div>

            {/* Evaluation ready indicator */}
            {evalResult?.ready && (() => {
              const score = evalResult.scores.acceptance;
              const threshold = job?.threshold ?? 80;
              const passed = score >= threshold;
              return (
                <div style={{
                  marginBottom: '0.5rem',
                  padding: '0.5rem',
                  backgroundColor: passed ? '#c8e6c9' : '#fff3e0',
                  borderRadius: '4px',
                  fontSize: '0.85rem',
                  color: passed ? '#2e7d32' : '#b57c00'
                }}>
                  {passed ? <Check size={16} className="inline-icon" /> : <X size={16} className="inline-icon" />} <strong>AI Evaluation Complete — {passed ? 'Accepted' : 'Not Accepted'}</strong> Score: {score.toFixed(1)}% ({threshold}% required)
                </div>
              );
            })()}

            {isPolling && pollState && (
              <div style={{
                marginBottom: '0.5rem',
                padding: '0.5rem',
                backgroundColor: '#e3f2fd',
                borderRadius: '4px',
                fontSize: '0.85rem',
                color: '#1565c0',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}>
                <RefreshCw size={14} className="spin" /> Checking results... ({pollState.attempts}/{pollState.maxAttempts})
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {/* Show message and cancel button for Prepared submissions */}
              {isPrepared && (
                <>
                  <div style={{ fontSize: '0.85rem', color: '#e65100', padding: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <FileText size={14} /> Not started on-chain yet
                  </div>
                  <button
                    onClick={() => onCancel(s.submissionId)}
                    disabled={cancelingSubmissions?.has(s.submissionId) || disableActions}
                    className="btn btn-outline-danger btn-sm"
                    style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                  >
                    {cancelingSubmissions?.has(s.submissionId) ? <><Loader2 size={12} className="spin" /></> : <><X size={12} /> Cancel</>}
                  </button>
                </>
              )}

              {/* Only show Finalize button for on-chain submissions */}
              {isOnChain && (
                <button
                  onClick={() => onFinalize(s.submissionId)}
                  disabled={isFinalizing || isPolling || disableActions}
                  className={evalResult?.ready ? "btn btn-success btn-sm" : "btn btn-primary btn-sm"}
                  style={{
                    fontSize: '0.85rem',
                    padding: '0.4rem 0.8rem',
                    fontWeight: evalResult?.ready ? 'bold' : 'normal',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem'
                  }}
                >
                  {isFinalizing
                    ? <><Loader2 size={14} className="spin" /> Finalizing...</>
                    : evalResult?.ready
                      ? (evalResult.scores.acceptance >= (job?.threshold ?? 80)
                          ? <><Trophy size={14} /> Claim Bounty & Update Status</>
                          : <><Check size={14} /> Finalize & Update Status</>)
                      : <><Check size={14} /> Finalize</>}
                </button>
              )}

              {canTimeout && !evalResult?.ready && (
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
  onCancel,
  finalizingSubmissions,
  failingSubmissions,
  cancelingSubmissions,
  pollingSubmissions,
  evaluationResults,
  timeoutMinutes,
  toast
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
      ) : (
        <>
          {hasActiveSubmissions && (
            <div className="alert alert-info" style={{ marginBottom: '0.75rem' }}>
              {pendingSubmissions.length} pending submission(s) will be auto-finalized when you close the bounty.
            </div>
          )}
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
  jobId,
  walletState,
  onFailTimeout,
  onFinalize,
  onCancel,
  onRefresh,
  isFailing,
  isFinalizing,
  isCanceling,
  isRefreshing,
  isPolling,
  pollingState,
  evaluationResult,
  disableActions,
  getSubmissionAge,
  timeoutMinutes,
  threshold,
  juryNodes
}) {
  const isPending = isPendingStatus(submission.status);
  const isOnChain = isSubmissionOnChain(submission.status);
  const isPrepared = submission.status === 'Prepared' || submission.status === 'PREPARED';
  const isApproved = submission.status === 'APPROVED' || submission.status === 'ACCEPTED' || submission.status === 'PassedPaid' || submission.status === 'ACCEPTED_PENDING_CLAIM';
  const isRejected = submission.status === 'REJECTED' || submission.status === 'Failed' || submission.status === 'REJECTED_PENDING_FINALIZATION';

  // Receipts-as-memes: only show for paid winners
  const isPaidWinner = submission.paidWinner === true;
  const ageMinutes = isPending && submission.submittedAt ? getSubmissionAge(submission.submittedAt) : 0;
  // Only allow timeout for submissions that are actually on-chain (not Prepared)
  const canTimeout = isOnChain && ageMinutes > timeoutMinutes;
  // Only allow finalize for on-chain submissions (not Prepared)
  const canFinalize = isOnChain && !isPolling;
  const hasEvalReady = evaluationResult?.ready;

  return (
    <div className="submission-card" style={{
      border: hasEvalReady ? '2px solid #4caf50' : undefined,
      backgroundColor: hasEvalReady ? '#f1f8e9' : undefined
    }}>
      <div className="submission-header">
        <span className="hunter">
          Submitter:{' '}
          <span
            style={{ cursor: 'pointer' }}
            title="Click to copy address"
            onClick={() => copyToClipboard(submission.hunter, toast)}
          >
            {submission.hunter}
          </span>
        </span>
        {hasEvalReady ? (
          <span
            style={{
              padding: '0.25rem 0.5rem',
              borderRadius: '4px',
              fontSize: '0.85rem',
              fontWeight: 'normal',
              backgroundColor: evaluationResult.scores.acceptance >= threshold ? '#c8e6c9' : '#ffcdd2',
              color: evaluationResult.scores.acceptance >= threshold ? '#2e7d32' : '#c62828',
              cursor: 'default'
            }}
          >
            {evaluationResult.scores.acceptance >= threshold ? '✅ Accepted' : '❌ Not Accepted'}
          </span>
        ) : (
          <span
            {...getSubmissionBadgeProps(submission.status)}
            style={{ cursor: 'default', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
          >
            {getSubmissionStatusIcon(submission.status) === IconName.HOURGLASS && <Hourglass size={14} />}
            {getSubmissionStatusIcon(submission.status) === IconName.CHECK && <Check size={14} />}
            {getSubmissionStatusIcon(submission.status) === IconName.X && <X size={14} />}
            {getSubmissionStatusLabel(submission.status)}
          </span>
        )}
      </div>

      {/* IDs for debugging/manual operations */}
      <div style={{ fontSize: '0.75rem', color: '#888', fontFamily: 'monospace', marginTop: '0.25rem' }}>
        Job: {jobId} | Submission: {submission.submissionId ?? submission.onChainSubmissionId ?? 'N/A'}
      </div>

      {(() => {
        // Don't show score for pending submissions
        if (isPending) return null;

        // Prioritize evaluation result score over stored submission score
        const displayScore = hasEvalReady
          ? evaluationResult.scores.acceptance
          : (submission.score ?? submission.acceptance);

        // Only show if we have a valid score
        if (displayScore == null) return null;

        return (
          <div className="score" style={{
            color: isApproved ? '#28a745' : isRejected ? '#dc3545' : '#666',
            fontWeight: 'bold'
          }}>
            Score: {displayScore.toFixed(1)}%
          </div>
        );
      })()}

      <div className="submission-meta">
        <span>Submitted: {submission.submittedAt ? new Date(submission.submittedAt * 1000).toLocaleString() : 'Just now'}</span>

        {isPaidWinner && (
          <div style={{ marginTop: '0.6rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              className="btn btn-success btn-sm"
              style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem', fontWeight: 'bold' }}
              onClick={() => {
                const url = `${window.location.origin}/r/${jobId}/${submission.submissionId}`;
                window.open(url, '_blank', 'noopener,noreferrer');
              }}
            >
              🧾 Open Receipt
            </button>
            <button
              className="btn btn-outline-primary btn-sm"
              style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
              onClick={async () => {
                const url = `${window.location.origin}/r/${jobId}/${submission.submissionId}`;
                try {
                  // Fetch share data to get amount and winner info
                  const shareData = await apiService.getReceiptShareData(jobId, submission.submissionId);
                  const usdText = shareData.amountUSD ? ` ($${shareData.amountUSD} USD)` : '';
                  const text = shareData.success
                    ? `Receipt: ${shareData.winnerLabel} earned ${shareData.amountEth} ETH${usdText} ✅ "${shareData.title}" ${url}`
                    : `Receipt: Winner earned bounty ✅ ${url}`;
                  await navigator.clipboard.writeText(text);
                  toast.success('Copied share text');
                } catch {
                  // Fallback to basic share text if fetch fails
                  const text = `Receipt: Agent earned bounty ✅ ${url}`;
                  try {
                    await navigator.clipboard.writeText(text);
                    toast.success('Copied share text');
                  } catch {
                    toast.error('Copy failed');
                  }
                }
              }}
            >
              📋 Copy Share Text
            </button>
            <button
              className="btn btn-outline-secondary btn-sm"
              style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
              onClick={async () => {
                const url = `${window.location.origin}/r/${jobId}/${submission.submissionId}`;
                try {
                  await navigator.clipboard.writeText(url);
                  toast.success('Copied receipt link');
                } catch {
                  toast.success('Copy failed');
                }
              }}
            >
              🔗 Copy Receipt Link
            </button>
          </div>
        )}

        {submission.verdiktaAggId && submission.verdiktaAggId !== '0x0000000000000000000000000000000000000000000000000000000000000000' && (
          <div style={{ marginTop: '0.25rem', fontSize: '0.8rem', fontFamily: 'monospace' }}>
            <span style={{ color: '#666' }}>Verdikta Agg ID: </span>
            <span style={{ color: '#1976d2' }}>{submission.verdiktaAggId.slice(0, 18)}...</span>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                const btn = e.currentTarget;
                const originalText = btn.textContent;
                try {
                  await navigator.clipboard.writeText(submission.verdiktaAggId);
                } catch (err) {
                  // Fallback for non-secure contexts
                  const textArea = document.createElement('textarea');
                  textArea.value = submission.verdiktaAggId;
                  textArea.style.position = 'fixed';
                  textArea.style.left = '-9999px';
                  document.body.appendChild(textArea);
                  textArea.select();
                  document.execCommand('copy');
                  document.body.removeChild(textArea);
                }
                btn.textContent = '✓';
                btn.style.backgroundColor = '#c8e6c9';
                setTimeout(() => {
                  btn.textContent = originalText;
                  btn.style.backgroundColor = '#e3f2fd';
                }, 1500);
              }}
              style={{
                marginLeft: '0.5rem',
                padding: '0.1rem 0.3rem',
                fontSize: '0.7rem',
                cursor: 'pointer',
                backgroundColor: '#e3f2fd',
                border: '1px solid #90caf9',
                borderRadius: '3px'
              }}
              title="Copy full Verdikta Agg ID"
            >
              📋
            </button>
          </div>
        )}
      </div>

      {/* NEW: Evaluation ready indicator */}
      {hasEvalReady && (() => {
        const score = evaluationResult.scores.acceptance;
        const passed = score >= threshold;
        return (
          <div style={{
            marginTop: '0.75rem',
            padding: '0.75rem',
            backgroundColor: passed ? '#c8e6c9' : '#fff3e0',
            border: `1px solid ${passed ? '#81c784' : '#ffcc80'}`,
            borderRadius: '4px',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '1rem', color: passed ? '#2e7d32' : '#b57c00', fontWeight: 'bold', marginBottom: '0.25rem' }}>
              {passed ? '✅' : '❌'} AI Evaluation Complete — {passed ? 'Accepted' : 'Not Accepted'}
            </div>
            <div style={{ fontSize: '0.9rem', color: passed ? '#388e3c' : '#c68200' }}>
              Score: {score.toFixed(1)}% ({threshold}% required)
            </div>
          </div>
        );
      })()}

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

      {/* Message for Prepared submissions - not on-chain yet */}
      {isPrepared && (
        <div style={{
          marginTop: '0.75rem',
          padding: '0.75rem',
          backgroundColor: '#fff3e0',
          border: '1px solid #ffcc80',
          borderRadius: '4px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '0.9rem', color: '#e65100', fontWeight: 'bold', marginBottom: '0.25rem' }}>
            📋 Submission Prepared (Not Started)
          </div>
          <div style={{ fontSize: '0.85rem', color: '#bf360c', marginBottom: '0.5rem' }}>
            This submission has not been started on-chain yet.
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => onRefresh(submission.submissionId)}
              disabled={isRefreshing || disableActions}
              className="btn btn-outline-primary btn-sm"
              style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
            >
              {isRefreshing ? '⏳ Checking...' : '🔄 Refresh Status'}
            </button>
            <button
              onClick={() => onCancel(submission.submissionId)}
              disabled={isCanceling || disableActions}
              className="btn btn-outline-danger btn-sm"
              style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
            >
              {isCanceling ? '⏳ Cancelling...' : '❌ Cancel Submission'}
            </button>
          </div>
        </div>
      )}

      {/* Action buttons for pending submissions */}
      {isPending && walletState.isConnected && !isPolling && (
        <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>

          {/* Show Finalize ONLY if on-chain and (evaluation is ready OR timeout not yet available) */}
          {canFinalize && (hasEvalReady || !canTimeout) && (
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
                  ? (evaluationResult.scores.acceptance >= threshold
                      ? '🎉 Claim Bounty & Update Status'
                      : 'Finalize & Update Status')
                  : '✅ Finalize Submission (check results)'}
            </button>
          )}

          {/* Show timeout button when eligible - but NOT if evaluation is ready */}
          {canTimeout && !hasEvalReady && (
            <>
              <div style={{
                fontSize: '0.8rem',
                color: '#e65100',
                textAlign: 'center',
                padding: '0.5rem',
                backgroundColor: '#fff3e0',
                borderRadius: '4px',
                marginBottom: '0.25rem'
              }}>
                ⚠️ Oracle hasn't responded after {ageMinutes.toFixed(0)} min.
                Use the button below to mark as failed and refund LINK.
              </div>
              <button
                onClick={() => onFailTimeout(submission.submissionId)}
                disabled={isFailing || disableActions}
                className="btn btn-warning"
                style={{
                  fontSize: '1rem',
                  padding: '0.75rem 1rem',
                  width: '100%',
                  fontWeight: 'bold'
                }}
              >
                {isFailing ? '⏳ Marking as Failed...' : `⏱️ Fail Timed-Out Submission (${ageMinutes.toFixed(0)} min stuck)`}
              </button>
            </>
          )}
          
          {/* Show countdown only if timeout not yet available and eval not ready */}
          {!canTimeout && !hasEvalReady && (
            <div style={{ fontSize: '0.8rem', color: '#888', textAlign: 'center' }}>
              Force-fail available in {(timeoutMinutes - ageMinutes).toFixed(1)} min
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

      {/* Justification Display - Show for finalized submissions with justification CIDs */}
      {(() => {
        // Validate and normalize justification CIDs for finalized submissions
        const hasValidCids = !isPending && submission.justificationCids && (
          Array.isArray(submission.justificationCids) 
            ? submission.justificationCids.length > 0
            : typeof submission.justificationCids === 'string'
        );
        
        if (hasValidCids) {
          return (
            <JustificationDisplay
              justificationCids={submission.justificationCids}
              passed={isApproved}
              score={submission.score ?? submission.acceptance}
              threshold={threshold}
              juryNodes={juryNodes}
            />
          );
        }
        return null;
      })()}

      {/* Justification Display - Show for pending submissions with evaluation ready */}
      {(() => {
        // Validate and normalize justification CIDs for pending evaluations
        const hasValidCids = isPending && hasEvalReady && evaluationResult.justificationCids && (
          Array.isArray(evaluationResult.justificationCids)
            ? evaluationResult.justificationCids.length > 0
            : typeof evaluationResult.justificationCids === 'string'
        );
        
        if (hasValidCids) {
          return (
            <JustificationDisplay
              justificationCids={evaluationResult.justificationCids}
              passed={evaluationResult.scores.acceptance >= threshold}
              score={evaluationResult.scores.acceptance}
              threshold={threshold}
              juryNodes={juryNodes}
            />
          );
        }
        return null;
      })()}
    </div>
  );
}

export default BountyDetails;

