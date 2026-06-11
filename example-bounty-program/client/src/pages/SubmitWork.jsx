import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Upload,
  Lightbulb,
  Coins,
  MessageSquare,
  FolderOpen,
  AlertTriangle,
  CheckCircle,
  Link2,
  FileText,
  Package,
  Copy,
  X,
  Send,
  Hourglass,
} from 'lucide-react';
import { useToast } from '../components/Toast';
import JuryModels from '../components/JuryModels';
import { apiService } from '../services/api';
import { getContractService } from '../services/contractService';
import { config, currentNetwork } from '../config';
import {
  BountyStatus,
  getBountyStatusLabel,
  getBountyStatusDescription,
  getBountyStatusIcon,
  getBountyBadgeProps,
  isBountyOpen,
} from '../utils/statusDisplay';
import './SubmitWork.css';

function SubmitWork({ walletState }) {
  const toast = useToast();
  const { bountyId } = useParams();
  const navigate = useNavigate();

  const [job, setJob] = useState(null);
  const [loadingJob, setLoadingJob] = useState(true);
  const [files, setFiles] = useState([]);
  const [submissionNarrative, setSubmissionNarrative] = useState(
    'Thank you for giving me the opportunity to submit this work. You can find it below in the references section.'
  );
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [error, setError] = useState(null);
  const [submissionResult, setSubmissionResult] = useState(null);
  const [showCIDDialog, setShowCIDDialog] = useState(false);

  // Load job details to check if submission is allowed
  useEffect(() => {
    loadJobDetails();
  }, [bountyId, walletState.isConnected]);

  // jobId === onChainId in the aligned ID system
  const getOnChainId = (job) => {
    return job.jobId != null ? Number(job.jobId) : null;
  };

  // A bounty is "windowed" if the creator has an assessment window
  // during which they can approve submissions directly (skipping AI eval).
  // Derived from creatorAssessmentWindowSize > 0.
  const isWindowed = Number(job?.creatorAssessmentWindowSize || 0) > 0;
  const windowMinutes = isWindowed
    ? Math.max(1, Math.round(Number(job.creatorAssessmentWindowSize) / 60))
    : 0;
  const creatorPaymentEth = isWindowed
    ? (job?.creatorDeterminationPayment ?? '?')
    : null;

  const loadJobDetails = async () => {
    try {
      setLoadingJob(true);
      const response = await apiService.getJob(bountyId, true);

      // Check if bounty belongs to the current network
      const jobContract = (response.job.contractAddress || '').toLowerCase();
      const currentContract = (config.bountyEscrowAddress || '').toLowerCase();
      if (jobContract && currentContract && jobContract !== currentContract) {
        setError(
          `This bounty was created on a different network. ` +
          `You are currently connected to ${currentNetwork.name}. ` +
          `Please switch to the correct network to interact with this bounty.`
        );
        setLoadingJob(false);
        return;
      }

      // Verify on-chain status if wallet is connected
      if (walletState.isConnected) {
        const onChainId = getOnChainId(response.job);

        if (onChainId === null) {
          console.warn('⚠️ On-chain ID not yet available - bounty may still be syncing');
          // Continue loading but submission will be blocked until onChainId is available
        } else {
          try {
            const contractService = getContractService();
            if (!contractService.isConnected()) {
              await contractService.connect();
            }

            const onChainStatus = await contractService.getBountyStatus(onChainId);

            // If mismatch, use on-chain as source of truth
            if (onChainStatus !== response.job.status) {
              console.warn('⚠️ Backend out of sync!', {
                backend: response.job.status,
                onChain: onChainStatus
              });
              response.job.status = onChainStatus;
            }

            console.log('✅ Bounty status verified:', onChainStatus);
          } catch (statusErr) {
            console.error('Could not verify on-chain status:', statusErr);
            // Continue with backend data if on-chain check fails
          }
        }
      }

      setJob(response.job);
    } catch (err) {
      console.error('Error loading job:', err);
      setError('Failed to load job details. Please try again.');
    } finally {
      setLoadingJob(false);
    }
  };

  const handleFileAdd = (e) => {
    const selectedFiles = Array.from(e.target.files);

    if (selectedFiles.length === 0) return;

    const allowedTypes = [
      // Documents
      '.txt', '.md', '.pdf', '.docx',
      // Images
      '.jpg', '.jpeg', '.png', '.bmp',
      // Programming languages
      '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.hpp',
      '.cs', '.rb', '.go', '.rs', '.php', '.swift', '.kt', '.sol', '.r', '.m',
      // Web
      '.html', '.css', '.scss', '.sass',
      // Data/Config
      '.json', '.xml', '.yaml', '.yml', '.toml', '.csv',
      // Shell
      '.sh', '.bat', '.ps1',
      // Other
      '.sql'
    ];
    const validFiles = [];

    for (const file of selectedFiles) {
      // Validate file size (20 MB)
      if (file.size > 20 * 1024 * 1024) {
        toast.error(`File "${file.name}" is too large. Maximum size is 20 MB.`);
        continue;
      }

      // Validate file type
      const extension = '.' + file.name.split('.').pop().toLowerCase();
      if (!allowedTypes.includes(extension)) {
        toast.error(`Invalid file type for "${file.name}". Allowed: ${allowedTypes.join(', ')}`);
        continue;
      }

      validFiles.push({
        file,
        description: `Work product file: ${file.name}`
      });
    }

    setFiles(prev => [...prev, ...validFiles]);
    setError(null);
    e.target.value = ''; // Reset input
  };

  const handleFileRemove = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleDescriptionChange = (index, description) => {
    setFiles(prev => prev.map((item, i) =>
      i === index ? { ...item, description } : item
    ));
  };

  const handleNarrativeChange = (e) => {
    const text = e.target.value;
    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;

    if (wordCount <= 200) {
      setSubmissionNarrative(text);
    }
  };

  const getWordCount = () => {
    return submissionNarrative.trim().split(/\s+/).filter(w => w.length > 0).length;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (files.length === 0) {
      toast.warning('Please select at least one file');
      return;
    }

    if (!walletState.isConnected) {
      toast.warning('Please connect your wallet first');
      return;
    }

    // Double-check status before submission
    if (!isBountyOpen(job?.status)) {
      toast.warning('This bounty is no longer accepting submissions');
      return;
    }

    // Check if targeted bounty and connected wallet doesn't match
    if (job?.targetHunter && walletState.address?.toLowerCase() !== job.targetHunter.toLowerCase()) {
      toast.warning('This bounty is targeted to a specific address. Only that address can submit.');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Get contract service once at the start
      const contractService = getContractService();

      // Get the on-chain ID for all contract calls
      const onChainId = getOnChainId(job);

      // Check if we have a valid on-chain ID
      if (onChainId === null) {
        throw new Error(
          'This bounty is still syncing with the blockchain. ' +
          'Please wait a moment and refresh the page, then try again.'
        );
      }

      // CRITICAL: Verify on-chain status before proceeding
      setLoadingMessage('Verifying bounty status on blockchain...');
      if (!contractService.isConnected()) {
        await contractService.connect();
      }

      // Check if bounty is actually open on-chain
      try {
        const onChainStatus = await contractService.getBountyStatus(onChainId);
        console.log('On-chain bounty status:', onChainStatus);

        if (!isBountyOpen(onChainStatus)) {
          // Update the UI state to reflect reality
          setJob(prev => ({ ...prev, status: onChainStatus }));

          throw new Error(
            `This bounty is ${getBountyStatusLabel(onChainStatus).toLowerCase()} on-chain and cannot accept submissions. ` +
            `The backend was out of sync. Please try refreshing the page.`
          );
        }
      } catch (statusError) {
        console.error('Error checking on-chain status:', statusError);
        throw new Error(
          'Could not verify bounty status on blockchain. ' +
          (statusError.message || 'Please ensure you are on the correct network.')
        );
      }

      // STEP 1: Upload to IPFS
      setLoadingMessage('Uploading files to IPFS...');

      const formData = new FormData();
      files.forEach(({ file }) => {
        formData.append('files', file);
      });
      formData.append('hunter', walletState.address);
      formData.append('submissionNarrative', submissionNarrative);

      const fileDescriptions = {};
      files.forEach(({ file, description }) => {
        fileDescriptions[file.name] = description;
      });
      formData.append('fileDescriptions', JSON.stringify(fileDescriptions));

      const response = await apiService.submitWorkMultiple(bountyId, formData);
      console.log('✅ IPFS upload complete:', response);

      // Get the hunterCid from the response:
      // - hunterCid: Hunter's work product archive (bCID containing the actual submission)
      const { hunterCid } = response.submission;
      
      // Get the evaluationCid from the job data:
      // - evaluationCid: The evaluation package CID (contains jury config, rubric reference, instructions)
      // - This was set when the bounty was created and stored on-chain
      const evaluationCid = job.evaluationCid;
      if (!evaluationCid) {
        throw new Error('Evaluation CID not found in job data. The bounty may not have been properly created.');
      }

      // STEP 2: Prepare submission on-chain (deploys EvaluationWallet)
      // Pass both CIDs: evaluationCid (must match bounty's stored CID) and hunterCid (work product)
      setLoadingMessage('Preparing submission on blockchain...');
      const { submissionId, evalWallet, ethMaxBudget } = await contractService.prepareSubmission(
        onChainId,           // Use on-chain ID, not URL parameter
        evaluationCid,       // Evaluation package CID (must match bounty's stored evaluationCid)
        hunterCid,           // Hunter's work product CID
        submissionNarrative || "",  // addendum
        500,                  // alpha: timeliness-vs-quality blend (0-1000). 500 = equal; weighted = ((1000-alpha)*quality + alpha*timeliness)/1000
        "20000000000000",     // maxOracleFee (0.00002 ETH) — under the 0.0004 ETH on-chain ceiling
        "10000000000000",     // estimatedBaseCost (0.00001 ETH)
        "3"                   // maxFeeBasedScaling: x-factor cap on fee-based boost (contract scales by 1e18 internally; must be >= 1)
      );

      console.log('✅ Submission prepared:', {
        submissionId,
        evalWallet,
        ethMaxBudget,
        ethMaxBudgetFormatted: `${Number(ethMaxBudget) / 1e18} ETH`
      });

      // STEP 2.5: Confirm submission in backend (now that we have the on-chain submissionId)
      // This creates the backend record with the correct ID, preventing orphaned submissions
      setLoadingMessage('Confirming submission...');
      try {
        await apiService.confirmSubmission(bountyId, {
          submissionId,
          hunter: walletState.address,
          hunterCid,
          evalWallet,
          fileCount: files.length,
          files: files.map(f => ({ name: f.file.name, size: f.file.size, description: f.description }))
        });
        console.log('✅ Backend submission confirmed');
      } catch (confirmErr) {
        // Non-fatal if it's just a duplicate (idempotent endpoint)
        console.warn('⚠️ Confirm submission warning:', confirmErr.message);
      }

      // ============================================================
      // WINDOWED BOUNTY BRANCH
      // ============================================================
      // For windowed bounties, the contract puts the submission into
      // PendingCreatorApproval and rejects startPreparedSubmission
      // until the window expires ("creator window still open" revert).
      //
      // The correct flow is:
      //   1. Stop here — do NOT call startPreparedSubmission.
      //   2. Sync the backend so the new submission shows up.
      //   3. Hand off to BountyDetails, where:
      //      - the creator can approve directly (handleCreatorApprove), or
      //      - after the window expires anyone can call handleStartSubmission,
      //        which funds and calls startPreparedSubmission with ETH.
      // ============================================================
      if (isWindowed) {
        setLoadingMessage('Syncing submission status...');
        try {
          await apiService.refreshSubmission(bountyId, submissionId);
          console.log('✅ Backend synced (windowed branch)');
        } catch (syncErr) {
          console.warn('⚠️ Backend sync failed (will auto-sync later):', syncErr.message);
        }

        setSubmissionResult({
          ...response,
          windowed: true,
          blockchainData: {
            submissionId,
            evalWallet,
            ethMaxBudget,
            txHash: null,
            blockNumber: null,
            // creatorWindowEnd is set by the contract to
            // block.timestamp + creatorAssessmentWindowSize. We can't read
            // it back here without an extra RPC call, so we approximate
            // from the current time. The dialog will refine via countdown.
            creatorWindowEndApprox: Math.floor(Date.now() / 1000) +
              Number(job.creatorAssessmentWindowSize || 0),
          },
        });
        setShowCIDDialog(true);
        return;
      }

      // STEP 3: Start the Verdikta evaluation, funding it with ETH (msg.value = ethMaxBudget).
      // No ERC20 approval is needed; unspent prepay is refunded to the hunter at finalization.
      // hunterCid was already stored in prepareSubmission, no need to pass again
      setLoadingMessage(`Starting AI evaluation (${(Number(ethMaxBudget) / 1e18).toFixed(4)} ETH prepay)...`);
      console.log('🔄 Starting evaluation for bountyId:', onChainId, 'submissionId:', submissionId, 'value:', ethMaxBudget);
      const evalResult = await contractService.startPreparedSubmission(onChainId, submissionId, ethMaxBudget);
      console.log('✅ Evaluation started:', evalResult);

      // STEP 5: Sync backend status from blockchain
      // This updates the backend from "Prepared" to "PENDING_EVALUATION"
      setLoadingMessage('Syncing submission status...');
      try {
        const refreshResult = await apiService.refreshSubmission(bountyId, submissionId);
        console.log('✅ Backend synced:', refreshResult);
      } catch (syncErr) {
        // Non-fatal - the auto-refresh will eventually sync it
        console.warn('⚠️ Backend sync failed (will auto-sync later):', syncErr.message);
      }

      // Show success with blockchain data
      setSubmissionResult({
        ...response,
        blockchainData: {
          submissionId,
          evalWallet,
          ethMaxBudget,
          txHash: evalResult.txHash,
          blockNumber: evalResult.blockNumber
        }
      });
      setShowCIDDialog(true);

    } catch (err) {
      console.error('Error submitting work:', err);

      // Better error messages for common issues
      let errorMessage = err.message || 'Failed to submit work';
      const originalError = errorMessage; // Keep original for logging

      if (errorMessage.includes('insufficient funds for gas') ||
          errorMessage.toLowerCase().includes('insufficient funds')) {
        errorMessage = '💰 Insufficient ETH to fund the evaluation. Get testnet ETH from a Base Sepolia faucet.';
      } else if (errorMessage.includes('user rejected') || errorMessage.includes('User denied') ||
                 errorMessage.includes('ACTION_REJECTED')) {
        errorMessage = '🚫 Transaction cancelled by user';
      } else if (errorMessage.includes('Incorrect ETH amount') || errorMessage.includes('wrong eth amount')) {
        errorMessage = '⚠️ Incorrect ETH prepay amount for the evaluation. Please refresh and try again.';
      } else if (errorMessage.includes('bounty is targeted')) {
        errorMessage = 'This bounty is restricted to a specific address. Only the targeted wallet can submit.';
      } else if (errorMessage.includes('deadline passed')) {
        errorMessage = 'Submission deadline has passed';
      } else if (errorMessage.includes('not open')) {
        errorMessage = 'Bounty is not accepting submissions';
      }

      // Log original error for debugging
      console.error('Original error:', originalError);

      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setLoading(false);
      setLoadingMessage('');
    }
  };

  const handleCloseCIDDialog = () => {
    setShowCIDDialog(false);
    // For windowed bounties, hand off to BountyDetails with a marker so it
    // can show a one-shot post-submit banner pointing at the new submission.
    const submittedId = submissionResult?.blockchainData?.submissionId;
    if (submissionResult?.windowed && submittedId != null) {
      navigate(`/bounty/${bountyId}?submitted=${submittedId}`);
    } else {
      navigate(`/bounty/${bountyId}`);
    }
  };

  // Loading state while checking job status
  if (loadingJob) {
    return (
      <div className="submit-work">
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading bounty details...</p>
        </div>
      </div>
    );
  }

  // Wallet not connected
  if (!walletState.isConnected) {
    return (
      <div className="submit-work">
        <div className="alert alert-warning">
          <h2>Wallet Not Connected</h2>
          <p>Please connect your wallet to submit work.</p>
          <button onClick={() => navigate(`/bounty/${bountyId}`)} className="btn btn-secondary">
            Back to Bounty
          </button>
        </div>
      </div>
    );
  }

  // Check if targeted bounty and user is not the target
  if (job && job.targetHunter && walletState.isConnected &&
      walletState.address?.toLowerCase() !== job.targetHunter.toLowerCase()) {
    return (
      <div className="submit-work">
        <div className="alert alert-warning">
          <h2>Targeted Bounty</h2>
          <p>This bounty is targeted to a specific address. Only that wallet can submit work.</p>
          <p style={{ marginTop: '0.5rem' }}>
            <strong>Target:</strong> <code>{job.targetHunter}</code>
          </p>
          <p style={{ marginTop: '0.25rem' }}>
            <strong>Your wallet:</strong> <code>{walletState.address}</code>
          </p>
          <button
            onClick={() => navigate(`/bounty/${bountyId}`)}
            className="btn btn-primary"
            style={{ marginTop: '1rem' }}
          >
            Back to Bounty
          </button>
        </div>
      </div>
    );
  }

  // Check bounty status - only allow submission if OPEN
  if (job && !isBountyOpen(job.status)) {
    const statusIcon = getBountyStatusIcon(job.status) || '⚠️';
    const statusDescription = getBountyStatusDescription(job.status);

    return (
      <div className="submit-work">
        <div className="alert alert-warning">
          <h2>{statusIcon} Cannot Submit Work</h2>
          <p>{statusDescription}</p>
          <p style={{ marginTop: '1rem' }}>
            <strong>Bounty Status:</strong> {getBountyStatusLabel(job.status)}
          </p>
          {job.submissionCloseTime && (
            <p>
              <strong>Deadline was:</strong> {new Date(job.submissionCloseTime * 1000).toLocaleString()}
            </p>
          )}
          <button
            onClick={() => navigate(`/bounty/${bountyId}`)}
            className="btn btn-primary"
            style={{ marginTop: '1rem' }}
          >
            Back to Bounty Details
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="submit-work">
      <div className="submit-header">
        <h1><Upload size={28} className="inline-icon" /> Submit Your Work</h1>
        <p>Upload your deliverable for AI evaluation</p>
        {job && (
          <div className="bounty-info">
            <span {...getBountyBadgeProps(job.status)}>{getBountyStatusLabel(job.status)}</span>
            <span className="bounty-amount">{job.bountyAmount} ETH</span>
            {job.submissionCloseTime && (
              <span className="deadline-info">
                Deadline: {new Date(job.submissionCloseTime * 1000).toLocaleString()}
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="alert alert-error">
          <p>{error}</p>
        </div>
      )}

      {isWindowed && (
        <div className="alert alert-info windowed-info-panel">
          <h3>
            <Hourglass size={18} className="inline-icon" /> This is a windowed bounty
          </h3>
          <p>
            After you submit, the bounty creator has <strong>{windowMinutes} minute{windowMinutes === 1 ? '' : 's'}</strong>
            {' '}to approve your work directly. If they approve, you receive
            {' '}<strong>{creatorPaymentEth} ETH</strong> immediately and the bounty closes — no AI evaluation runs.
          </p>
          <p>
            If they don't approve within the window, AI evaluation becomes available. You (or anyone) can trigger it
            from this bounty's details page after the window expires. Triggering AI evaluation requires a small ETH
            prepay (refunded if unspent).
          </p>
          <p>
            <strong>You will not be asked to fund the evaluation at submit time.</strong> Only ETH for gas is needed right now.
          </p>
        </div>
      )}

      {job && (
        <JuryModels
          bountyId={bountyId}
          juryNodes={job.juryNodes}
          evaluationCid={job.evaluationCid}
          title="Who will evaluate your submission"
          description="These AI models will independently score your work; the final score is a weighted average. Review them before you submit."
        />
      )}

      <form onSubmit={handleSubmit} className="submit-form">
        <div className="form-section">
          <h2>Submission Narrative</h2>
          <div className="form-group">
            <label htmlFor="narrative">
              Your Message to the Evaluators (Optional)
              <span className="word-count">
                {getWordCount()} / 200 words
              </span>
            </label>
            <textarea
              id="narrative"
              value={submissionNarrative}
              onChange={handleNarrativeChange}
              rows={4}
              placeholder="Explain any nuances about your submission that will help the AI evaluators understand your work..."
            />
            <small>
              Customize your submission message (max 200 words). This will be included in the evaluation.
            </small>
          </div>
        </div>

        <div className="form-section">
          <h2>Upload Files</h2>

          <div className="form-group">
            <label htmlFor="files">Add Files *</label>
            <input
              id="files"
              type="file"
              onChange={handleFileAdd}
              accept=".txt,.md,.pdf,.docx,.jpg,.jpeg,.png,.bmp,.py,.js,.ts,.jsx,.tsx,.java,.c,.cpp,.h,.hpp,.cs,.rb,.go,.rs,.php,.swift,.kt,.sol,.r,.m,.html,.css,.scss,.sass,.json,.xml,.yaml,.yml,.toml,.csv,.sh,.bat,.ps1,.sql"
              multiple
            />
            <small>
              Allowed formats: Code files (.py, .sol, .cpp, .js, .ts, .java, .c, .h, .go, .rs, etc.), documents (.txt, .md, .pdf, .docx), images (.jpg, .png, .bmp), and data files (.json, .xml, .yaml, .csv)<br />
              Maximum size per file: 20 MB | You can add up to 10 files
            </small>
          </div>

          {files.length > 0 && (
            <div className="files-list">
              <h3>Files to Submit ({files.length})</h3>
              {files.map((item, index) => (
                <div key={index} className="file-item">
                  <div className="file-header">
                    <div className="file-info">
                      <strong>{item.file.name}</strong>
                      <span className="file-size">
                        {(item.file.size / 1024).toFixed(2)} KB
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleFileRemove(index)}
                      className="btn-remove"
                      title="Remove file"
                    >
                      ×
                    </button>
                  </div>
                  <div className="file-description">
                    <label htmlFor={`desc-${index}`}>
                      Description (helps AI understand this file):
                    </label>
                    <input
                      id={`desc-${index}`}
                      type="text"
                      value={item.description}
                      onChange={(e) => handleDescriptionChange(index, e.target.value)}
                      placeholder="Describe this file's purpose..."
                      maxLength={200}
                    />
                  </div>
                </div>
              ))}
              <div className="files-summary">
                <strong>Total size:</strong> {(files.reduce((sum, item) => sum + item.file.size, 0) / 1024).toFixed(2)} KB
              </div>
            </div>
          )}
        </div>

        <div className="form-actions">
          <button
            type="submit"
            disabled={loading || files.length === 0}
            className="btn btn-primary btn-lg"
          >
            {loading ? 'Processing...' : <><Send size={18} className="inline-icon" /> Submit {files.length} File{files.length !== 1 ? 's' : ''}</>}
          </button>
          <button
            type="button"
            onClick={() => navigate(`/bounty/${bountyId}`)}
            className="btn btn-secondary"
            disabled={loading}
          >
            Cancel
          </button>
        </div>

        {loading && (
          <div className="loading-status">
            <div className="spinner"></div>
            <p>{loadingMessage || 'Processing submission...'}</p>
            <small style={{ marginTop: '0.5rem', display: 'block', color: '#666' }}>
              This involves multiple blockchain transactions. Please approve each one in MetaMask.
            </small>
          </div>
        )}
      </form>

      <div className="help-section">
        <h3><Lightbulb size={18} className="inline-icon" /> What Happens Next?</h3>
        {isWindowed ? (
          <ol>
            <li>Your files are uploaded to IPFS (permanent storage)</li>
            <li>Hunter Submission CID is generated with your work and narrative</li>
            <li>Smart contract creates an EvaluationWallet and records your submission as <em>Pending Creator Approval</em></li>
            <li>The creator has <strong>{windowMinutes} minute{windowMinutes === 1 ? '' : 's'}</strong> to approve directly. If they approve, you receive <strong>{creatorPaymentEth} ETH</strong> immediately and the bounty closes 🎉</li>
            <li>If the window expires without creator approval, you'll see a <em>Start AI Evaluation</em> button on the bounty details page. Clicking it attaches a small ETH prepay and starts oracle evaluation</li>
            <li>Oracle results are written back on-chain within 1-5 minutes after evaluation starts</li>
          </ol>
        ) : (
          <ol>
            <li>Your files are uploaded to IPFS (permanent storage)</li>
            <li>Hunter Submission CID is generated with your work and narrative</li>
            <li>Smart contract creates an EvaluationWallet for your submission</li>
            <li>You attach a small ETH prepay (~0.00024 ETH) to fund AI evaluation — unspent ETH is refunded to you when the result finalizes</li>
            <li>Evaluation starts with your Hunter CID + the bounty's evaluation package</li>
            <li>Results are written back on-chain within 1-5 minutes</li>
            <li>If you pass, bounty is awarded automatically! 🎉</li>
          </ol>
        )}

        <h3><Coins size={18} className="inline-icon" /> Required Tokens</h3>
        <p>
          Each submission requires only <strong>ETH</strong>:
        </p>
        <ul>
          <li><strong>ETH</strong> for gas fees (~0.005 ETH on Base Sepolia)</li>
          <li><strong>ETH</strong> prepay for AI evaluation (~0.00024 ETH worst case, mostly refunded)</li>
        </ul>
        <p>
          Get testnet ETH from a <a href="https://docs.base.org/chain/network-faucets" target="_blank" rel="noopener noreferrer">Base Sepolia faucet</a>.
        </p>

        <h3><MessageSquare size={18} className="inline-icon" /> About Your Submission Narrative</h3>
        <p>
          The narrative you provide is included in the primary_query.json file sent to the AI evaluators.
          Use it to explain any nuances, context, or special considerations about your work. This helps the
          AI better understand and evaluate your submission according to the rubric.
        </p>

        <h3><FolderOpen size={18} className="inline-icon" /> Multiple Files Support</h3>
        <p>
          You can submit up to 10 files. Each file should have a clear description that helps the AI
          understand its purpose. All files are referenced in the manifest according to the <a href="https://docs.verdikta.com/verdikta-common/MANIFEST_SPECIFICATION/" target="_blank" rel="noopener noreferrer">Verdikta Manifest Specification</a>.
        </p>

        <h3><AlertTriangle size={18} className="inline-icon" /> Important Notes</h3>
        <ul>
          {isWindowed ? (
            <li>You'll need to approve <strong>1 transaction</strong> in MetaMask right now (the on-chain submission). Funding the AI evaluation only happens later, if the creator doesn't approve within the window.</li>
          ) : (
            <li>You'll need to approve <strong>2 transactions</strong> in MetaMask (the submission, then the ETH-funded evaluation start)</li>
          )}
          <li>Evaluation is final (no appeals in MVP)</li>
          <li>First passing submission wins the bounty</li>
          <li>Your submission becomes public once uploaded</li>
          <li>Make sure you have enough ETH before submitting</li>
          {!isWindowed && (
            <li>
              <strong>Creator approval window:</strong> Some bounties give the creator a time window to approve
              submissions directly (skipping AI evaluation). This bounty does not have one — your submission
              will go straight to AI evaluation.
            </li>
          )}
        </ul>
      </div>

      {/* Success Dialog with Blockchain Info */}
      {showCIDDialog && submissionResult && (
        <div className="cid-dialog-overlay" onClick={handleCloseCIDDialog}>
          <div className="cid-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>
              {submissionResult.windowed
                ? <><Hourglass size={24} className="inline-icon" /> Submission Recorded — Awaiting Creator</>
                : <><CheckCircle size={24} className="inline-icon" /> Submission Complete!</>}
            </h2>
            <p className="dialog-intro">
              {submissionResult.windowed
                ? `Your work is on-chain. The creator has ${windowMinutes} minute${windowMinutes === 1 ? '' : 's'} to approve directly. If they don't, you'll be able to trigger AI evaluation from the bounty details page.`
                : 'Your work has been submitted and AI evaluation is in progress!'}
            </p>

            {submissionResult.blockchainData && (
              <div className="cid-section blockchain-info">
                <h3><Link2 size={18} className="inline-icon" /> Blockchain Status</h3>
                <div className="blockchain-details">
                  <p>
                    <strong>Submission ID:</strong> {submissionResult.blockchainData.submissionId}
                  </p>
                  <p>
                    <strong>Evaluation Wallet:</strong>
                    <code className="inline-code">{submissionResult.blockchainData.evalWallet}</code>
                  </p>
                  {submissionResult.windowed ? (
                    <>
                      <p>
                        <strong>Status:</strong> Pending Creator Approval
                      </p>
                      <p>
                        <strong>Creator window ends:</strong>{' '}
                        {new Date(submissionResult.blockchainData.creatorWindowEndApprox * 1000).toLocaleTimeString()}
                        {' '}(approximately {windowMinutes} min from now)
                      </p>
                      <p>
                        <strong>Creator payout if approved:</strong> {creatorPaymentEth} ETH
                      </p>
                      <p className="success-note">
                        <Hourglass size={14} className="inline-icon" /> No evaluation fee was spent. You'll only fund the AI evaluation (a small ETH prepay) if you trigger it later.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>
                        <strong>Transaction:</strong>{' '}
                       <a
                          href={`https://sepolia.basescan.org/tx/${submissionResult.blockchainData.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          View on BaseScan ↗
                        </a>
                      </p>
                      <p className="success-note">
                        <CheckCircle size={14} className="inline-icon" /> Oracles are now evaluating your submission...
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}

            {submissionResult.submission.files && submissionResult.submission.files.length > 0 && (
              <div className="cid-section">
                <h3><FileText size={18} className="inline-icon" /> Submitted Files</h3>
                {submissionResult.submission.files.map((file, index) => (
                  <div key={index} className="submitted-file-info">
                    <strong>{file.filename}</strong> ({(file.size / 1024).toFixed(2)} KB)
                    {file.description && <p className="file-desc-small">{file.description}</p>}
                  </div>
                ))}
                <p className="total-size">
                  <strong>Total:</strong> {(submissionResult.submission.totalSize / 1024).toFixed(2)} KB
                </p>
              </div>
            )}

            <div className="cid-section">
              <h3><Package size={18} className="inline-icon" /> IPFS CID</h3>
              <div className="cid-group">
                <label>Hunter Submission CID:</label>
                <div className="cid-value">
                  <code>{submissionResult.submission.hunterCid}</code>
                  <button
                    onClick={() => navigator.clipboard.writeText(submissionResult.submission.hunterCid)}
                    className="btn-copy"
                    title="Copy to clipboard"
                  >
                    <Copy size={14} />
                  </button>
                </div>
                <small style={{ display: 'block', marginTop: '0.5rem', color: '#666' }}>
                  The evaluation package CID is stored in the bounty on-chain.
                </small>
              </div>
            </div>

            <div className="dialog-actions">
              <button onClick={handleCloseCIDDialog} className="btn btn-primary">
                {submissionResult.windowed ? 'Go to Bounty Details' : 'Back to Bounty Details'}
              </button>
            </div>

            <p className="dialog-footer">
              <small>
                <Lightbulb size={14} className="inline-icon" />{' '}
                {submissionResult.windowed
                  ? 'The bounty details page will live-update as the creator decides or the window expires.'
                  : 'Check back in a few minutes to see your evaluation results!'}
              </small>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default SubmitWork;

