/**
 * My Bounties Page
 * Dashboard for bounty creators to view and download submissions to their bounties
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Package,
  RefreshCw,
  Download,
  AlertTriangle,
  FileText,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Hourglass,
  HelpCircle,
  Clock,
  Loader2,
  Eye,
} from 'lucide-react';
import { renderMarkdownSafe } from '../utils/markdownPreview';
import { useToast } from '../components/Toast';
import { apiService } from '../services/api';
import { getContractService } from '../services/contractService';
import {
  getBountyStatusLabel,
  getBountyBadgeProps,
  getSubmissionStatusLabel,
  getSubmissionStatusBadgeClass,
  getSubmissionStatusIcon,
  getArchiveStatusInfo,
  isSubmissionPending,
  BountyStatus,
  IconName,
} from '../utils/statusDisplay';
import './MyBounties.css';

/**
 * Copy text to clipboard with fallback for HTTP (non-secure) contexts.
 */
function copyToClipboard(text, toast) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text);
  } else {
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

/**
 * Truncate an Ethereum address for display.
 */
function truncateAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 8)}...`;
}

/**
 * Map IconName constants to Lucide icon components.
 */
const ICON_MAP = {
  [IconName.CHECK]: Check,
  [IconName.X]: X,
  [IconName.HOURGLASS]: Hourglass,
  [IconName.HELP]: HelpCircle,
  [IconName.ALERT]: AlertTriangle,
  [IconName.REFRESH]: RefreshCw,
};

/**
 * Render a status icon from an IconName constant.
 */
function StatusIconComponent({ iconName, size = 12, className = '' }) {
  const IconComponent = ICON_MAP[iconName];
  if (!IconComponent) return null;
  return <IconComponent size={size} className={className} />;
}

/**
 * Get submission status display info, accounting for timed-out evaluations.
 * If the bounty is no longer open and the submission is still pending, it timed out.
 */
function getEffectiveSubmissionStatus(submissionStatus, bountyStatus) {
  const isPending = isSubmissionPending(submissionStatus);
  const bountyOpen = bountyStatus === BountyStatus.OPEN;

  if (isPending && !bountyOpen) {
    // Submission was pending but bounty closed - evaluation timed out
    return {
      label: 'Timed Out',
      icon: Clock,
      badgeClass: 'status-timeout',
    };
  }

  // Normal status
  return {
    label: getSubmissionStatusLabel(submissionStatus),
    iconName: getSubmissionStatusIcon(submissionStatus),
    badgeClass: getSubmissionStatusBadgeClass(submissionStatus),
  };
}

function MyBounties({ walletState }) {
  const toast = useToast();
  const [bounties, setBounties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [expandedBounty, setExpandedBounty] = useState(null);
  const [downloadingSubmission, setDownloadingSubmission] = useState(null);
  const [downloadResult, setDownloadResult] = useState(null);
  const [approvingSubmission, setApprovingSubmission] = useState(null);
  const [previewingSubmission, setPreviewingSubmission] = useState(null);
  const [previewResult, setPreviewResult] = useState(null);

  const { isConnected, address } = walletState;

  // Load bounties for connected wallet
  const loadBounties = useCallback(async () => {
    if (!address) return;

    setLoading(true);
    setError(null);

    try {
      const result = await apiService.getPosterBounties(address, { includeExpired });
      setBounties(result.bounties || []);
    } catch (err) {
      console.error('Failed to load bounties:', err);
      setError(err.message || 'Failed to load bounties');
    } finally {
      setLoading(false);
    }
  }, [address, includeExpired]);

  useEffect(() => {
    if (isConnected && address) {
      loadBounties();
    } else {
      setBounties([]);
      setLoading(false);
    }
  }, [isConnected, address, loadBounties]);

  // Handle download click
  const handleDownload = async (jobId, submissionId) => {
    if (!address) return;

    setDownloadingSubmission(`${jobId}-${submissionId}`);
    setDownloadResult(null);

    try {
      const result = await apiService.getSubmissionDownload(jobId, submissionId, address);
      setDownloadResult({
        jobId,
        submissionId,
        ...result
      });

      // Open the primary download URL in a new tab
      if (result.downloadUrls?.primary) {
        window.open(result.downloadUrls.primary, '_blank');
      }

      // Refresh the bounty list to show updated retrieval status
      loadBounties();
    } catch (err) {
      console.error('Download failed:', err);
      toast.error(`Download failed: ${err.message}`);
    } finally {
      setDownloadingSubmission(null);
    }
  };

  // Handle inline preview click
  const handlePreview = async (jobId, submissionId) => {
    if (!address) return;
    setPreviewingSubmission(`${jobId}-${submissionId}`);
    try {
      const result = await apiService.getSubmissionPreview(jobId, submissionId, address);
      setPreviewResult({ jobId, submissionId, ...result });
    } catch (err) {
      console.error('Preview failed:', err);
      toast.error(`Preview failed: ${err.message}`);
    } finally {
      setPreviewingSubmission(null);
    }
  };

  // Handle creator approval
  const handleCreatorApprove = async (bounty, submissionId) => {
    const key = `${bounty.jobId}-${submissionId}`;
    const creatorPay = bounty.creatorDeterminationPayment || bounty.bountyAmount || '?';

    const confirmed = window.confirm(
      `Approve submission #${submissionId} for bounty "${bounty.title}"?\n\n` +
      `This will pay the hunter ${creatorPay} ETH from the bounty escrow.\n\n` +
      'This action requires a blockchain transaction that you must sign.'
    );
    if (!confirmed) return;

    setApprovingSubmission(key);
    try {
      const contractService = getContractService();
      if (!contractService.isConnected()) await contractService.connect();

      await contractService.creatorApproveSubmission(bounty.jobId, submissionId);
      toast.success(`Submission #${submissionId} approved!`);
      loadBounties();
    } catch (err) {
      console.error('Error approving submission:', err);
      toast.error(`Failed to approve: ${err.message}`);
    } finally {
      setApprovingSubmission(null);
    }
  };

  // Format date
  const formatDate = (timestamp) => {
    if (!timestamp) return 'N/A';
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Get archive status badge using centralized utility
  const getArchiveStatusBadge = (submission) => {
    let info;
    if (submission.isExpired) {
      info = getArchiveStatusInfo('expired');
    } else if (submission.retrievedByPoster) {
      info = getArchiveStatusInfo('retrieved');
    } else {
      info = getArchiveStatusInfo(submission.archiveStatus);
    }
    return (
      <span className={`archive-badge ${info.badgeClass}`} title={info.description}>
        <StatusIconComponent iconName={info.icon} size={12} className="inline-icon" /> {info.label}
      </span>
    );
  };

  // Not connected state
  if (!isConnected) {
    return (
      <div className="my-bounties">
        <div className="page-header">
          <h1><Package size={28} className="inline-icon" /> My Bounties</h1>
          <p>View and download submissions to bounties you've created</p>
        </div>
        <div className="alert alert-warning">
          <h3>Wallet Not Connected</h3>
          <p>Please connect your wallet to view your bounties and submissions.</p>
        </div>
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="my-bounties">
        <div className="page-header">
          <h1><Package size={28} className="inline-icon" /> My Bounties</h1>
          <p>View and download submissions to bounties you've created</p>
        </div>
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Loading your bounties...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="my-bounties">
      <div className="page-header">
        <h1><Package size={28} className="inline-icon" /> My Bounties</h1>
        <p>View and download submissions to bounties you've created</p>
        <div className="header-meta">
          <span className="wallet-label">Connected as: </span>
          <code className="wallet-address">{address}</code>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <p>{error}</p>
          <button onClick={loadBounties} className="btn btn-sm btn-secondary">
            Retry
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="controls-bar">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={includeExpired}
            onChange={(e) => setIncludeExpired(e.target.checked)}
          />
          Show expired archives
        </label>
        <button onClick={loadBounties} className="btn btn-sm btn-secondary btn-with-icon">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Download Result Modal */}
      {downloadResult && (
        <div className="download-modal-overlay" onClick={() => setDownloadResult(null)}>
          <div className="download-modal" onClick={(e) => e.stopPropagation()}>
            <h3><Download size={20} className="inline-icon" /> Download Started</h3>
            <p>The submission archive should begin downloading. If it doesn't, use the links below:</p>
            
            <div className="download-links">
             <a 
                href={downloadResult.downloadUrls?.primary}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
              >
                Primary Download (Pinata)
              </a>
             <a 
                href={downloadResult.downloadUrls?.fallback}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary"
              >
                Fallback (IPFS.io)
              </a>
            </div>

            <div className="download-warning">
              <p><AlertTriangle size={16} className="inline-icon" /> <strong>Important:</strong> This archive will expire in {downloadResult.submission?.daysUntilExpiry || 7} days.</p>
              <p>Please save the file locally for permanent access.</p>
            </div>

            <div className="download-info">
              <p>
                <strong>Submitter:</strong>{' '}
                <span
                  style={{ cursor: 'pointer' }}
                  title="Click to copy address"
                  onClick={() => copyToClipboard(downloadResult.submission?.hunter, toast)}
                >
                  {downloadResult.submission?.hunter}
                </span>
              </p>
              <p>
                <strong>CID:</strong>{' '}
                <code
                  style={{ cursor: 'pointer' }}
                  title="Click to copy CID"
                  onClick={() => copyToClipboard(downloadResult.submission?.hunterCid, toast)}
                >
                  {downloadResult.submission?.hunterCid}
                </code>
              </p>
            </div>

            <button onClick={() => setDownloadResult(null)} className="btn btn-secondary">
              Close
            </button>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewResult && (
        <div className="download-modal-overlay" onClick={() => setPreviewResult(null)}>
          <div
            className="download-modal preview-modal"
            style={{ maxWidth: '900px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3><Eye size={20} className="inline-icon" /> Submission Preview</h3>
            {previewResult.previewable ? (
              <>
                <div className="preview-meta" style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                  <strong>File:</strong> <code>{previewResult.filename}</code>
                  {' · '}
                  <strong>Format:</strong> {previewResult.format}
                  {previewResult.truncated && (
                    <span style={{ color: 'var(--warning, #b45309)', marginLeft: '0.5rem' }}>
                      (truncated — download for full content)
                    </span>
                  )}
                </div>
                <div
                  className="preview-body"
                  style={{
                    background: 'var(--bg-alt, #fafafa)',
                    border: '1px solid var(--border, #e5e7eb)',
                    borderRadius: '6px',
                    padding: '1rem',
                    maxHeight: '60vh',
                    overflow: 'auto',
                  }}
                >
                  {previewResult.format === 'md' ? (
                    <div
                      className="markdown-body"
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdownSafe(previewResult.content || ''),
                      }}
                    />
                  ) : (
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                      {previewResult.content}
                    </pre>
                  )}
                </div>
              </>
            ) : (
              <div className="alert alert-warning">
                <p style={{ margin: 0 }}>
                  <AlertTriangle size={16} className="inline-icon" />{' '}
                  {previewResult.reason === 'too-large' ? (
                    <>
                      <strong>File too large for inline preview.</strong>
                      {previewResult.filename ? <> (<code>{previewResult.filename}</code>
                      {previewResult.byteLength ? <> — {Math.round(previewResult.byteLength / 1024)} KB</> : null}
                      )</> : null}{' '}
                      Use <strong>Download ZIP</strong> below to get the full archive.
                    </>
                  ) : previewResult.reason === 'not-found' ? (
                    <>
                      <strong>The expected file wasn't found in the archive.</strong>{' '}
                      Use <strong>Download ZIP</strong> below to inspect it directly.
                    </>
                  ) : (
                    <>
                      <strong>Nothing to preview inline.</strong>{' '}
                      This submission doesn't contain a text-based file (.md, .txt, .json, .csv).{' '}
                      Use <strong>Download ZIP</strong> below to get the work product.
                    </>
                  )}
                </p>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button
                onClick={() => {
                  handleDownload(previewResult.jobId, previewResult.submissionId);
                  setPreviewResult(null);
                }}
                className={previewResult.previewable ? 'btn btn-secondary' : 'btn btn-primary'}
              >
                <Download size={14} className="inline-icon" /> Download ZIP
              </button>
              <button onClick={() => setPreviewResult(null)} className="btn btn-secondary">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bounties List */}
      {bounties.length === 0 ? (
        <div className="empty-state">
          <h3>No Bounties Found</h3>
          <p>You haven't created any bounties yet, or none have submissions.</p>
          <Link to="/create" className="btn btn-primary">
            Create Your First Bounty
          </Link>
        </div>
      ) : (
        <div className="bounties-list">
          {bounties.map((bounty) => (
            <div key={bounty.jobId} className="bounty-card">
              <div 
                className="bounty-header"
                onClick={() => setExpandedBounty(expandedBounty === bounty.jobId ? null : bounty.jobId)}
              >
                <div className="bounty-title-row">
                  <h3>{bounty.title}</h3>
                  <span {...getBountyBadgeProps(bounty.status)}>
                    {getBountyStatusLabel(bounty.status)}
                  </span>
                </div>
                <div className="bounty-meta">
                  <span className="meta-item">
                    <strong>{bounty.bountyAmount}</strong> ETH
                  </span>
                  <span className="meta-item">
                    <strong>{bounty.archivedSubmissionCount}</strong> submission{bounty.archivedSubmissionCount !== 1 ? 's' : ''}
                  </span>
                  <span className="meta-item">
                    {bounty.submissionCloseTime && bounty.submissionCloseTime * 1000 < Date.now()
                      ? 'Closed:'
                      : 'Closes:'} {formatDate(bounty.submissionCloseTime)}
                  </span>
                  <span className="expand-icon">
                    {expandedBounty === bounty.jobId ? '▼' : '▶'}
                  </span>
                </div>
              </div>

              {/* Expanded Submissions */}
              {expandedBounty === bounty.jobId && (
                <div className="submissions-section">
                  {bounty.submissions.length === 0 ? (
                    <p className="no-submissions">No submissions to this bounty yet.</p>
                  ) : (
                    <div className="submissions-list">
                      <div className="submissions-header">
                        <span>Submitter</span>
                        <span>Status</span>
                        <span>Score</span>
                        <span>Archive</span>
                        <span>Submitted</span>
                        <span>Action</span>
                      </div>
                      {bounty.submissions.map((sub) => (
                        <div key={sub.submissionId} className="submission-row">
                          <span
                            className="hunter-address"
                            data-label="Submitter"
                            title={sub.hunter ? `${sub.hunter} — Click to copy` : 'Address not available'}
                            style={{ cursor: sub.hunter ? 'pointer' : 'default' }}
                            onClick={() => sub.hunter && copyToClipboard(sub.hunter, toast)}
                          >
                            {truncateAddress(sub.hunter) || '—'}
                          </span>
                          {(() => {
                            const effectiveStatus = getEffectiveSubmissionStatus(sub.status, bounty.status);
                            return (
                              <span className={`sub-status ${effectiveStatus.badgeClass}`} data-label="Status">
                                {effectiveStatus.icon
                                  ? <effectiveStatus.icon size={12} className="inline-icon" />
                                  : <StatusIconComponent iconName={effectiveStatus.iconName} size={12} className="inline-icon" />}
                                {' '}{effectiveStatus.label}
                              </span>
                            );
                          })()}
                          <span className="score" data-label="Score">
                            {sub.score != null ? `${sub.score.toFixed(1)}%` : '—'}
                          </span>
                          <span className="archive-status" data-label="Archive">
                            {getArchiveStatusBadge(sub)}
                            {sub.daysUntilExpiry != null && !sub.isExpired && (
                              <span className="days-left">
                                ({sub.daysUntilExpiry}d left)
                              </span>
                            )}
                          </span>
                          <span className="submitted-date" data-label="Submitted">
                            {formatDate(sub.submittedAt)}
                          </span>
                          <span className="action-cell" style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            {/* Creator approve button for PendingCreatorApproval */}
                            {sub.status === 'PendingCreatorApproval' && (() => {
                              const windowEnd = sub.creatorWindowEnd || 0;
                              const now = Math.floor(Date.now() / 1000);
                              const windowOpen = windowEnd > now;
                              const key = `${bounty.jobId}-${sub.submissionId}`;
                              const isApproving = approvingSubmission === key;

                              if (windowOpen) {
                                return (
                                  <button
                                    onClick={() => handleCreatorApprove(bounty, sub.submissionId)}
                                    disabled={isApproving}
                                    className="btn btn-sm btn-success"
                                    title={`Approve and pay ${bounty.creatorDeterminationPayment || '?'} ETH (${Math.ceil((windowEnd - now) / 60)} min left)`}
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem' }}
                                  >
                                    {isApproving
                                      ? <Loader2 size={12} className="spin" />
                                      : <><Check size={12} /> Approve</>}
                                  </button>
                                );
                              }
                              return (
                                <span className="expired-label" title="Creator approval window expired — proceed via bounty details page" style={{ fontSize: '0.75rem' }}>
                                  Window expired
                                </span>
                              );
                            })()}
                            {/* Preview + Download buttons */}
                            {sub.hunterCid && !sub.isExpired ? (
                              <>
                                <button
                                  onClick={() => handlePreview(bounty.jobId, sub.submissionId)}
                                  disabled={previewingSubmission === `${bounty.jobId}-${sub.submissionId}`}
                                  className="btn btn-sm btn-secondary"
                                  title="Preview inline (text/markdown/json/csv)"
                                >
                                  {previewingSubmission === `${bounty.jobId}-${sub.submissionId}`
                                    ? <RefreshCw size={14} className="spin" />
                                    : <Eye size={14} />}
                                </button>
                                <button
                                  onClick={() => handleDownload(bounty.jobId, sub.submissionId)}
                                  disabled={downloadingSubmission === `${bounty.jobId}-${sub.submissionId}`}
                                  className="btn btn-sm btn-primary download-btn"
                                  title={sub.retrievedByPoster ? 'Download again (already retrieved)' : 'Download submission'}
                                >
                                  {downloadingSubmission === `${bounty.jobId}-${sub.submissionId}`
                                    ? <RefreshCw size={14} className="spin" />
                                    : <Download size={14} />}
                                </button>
                              </>
                            ) : sub.status !== 'PendingCreatorApproval' && (
                              sub.isExpired ? (
                                <span className="expired-label">Expired</span>
                              ) : (
                                <span className="no-content">—</span>
                              )
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  
                  <div className="bounty-actions">
                    <Link to={`/bounty/${bounty.jobId}`} className="btn btn-sm btn-secondary">
                      View Bounty Details →
                    </Link>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Info Section */}
      <div className="info-section">
        <h4><FileText size={18} className="inline-icon" /> About Submission Archives</h4>
        <ul>
          <li><strong>30 days:</strong> Submissions are archived for 30 days after your bounty closes.</li>
          <li><strong>7 days after download:</strong> Once you download a submission, it remains available for 7 more days.</li>
          <li><strong>Save locally:</strong> Always save downloaded files to your computer for permanent access.</li>
          <li><strong>ZIP format:</strong> Submissions are ZIP archives containing the work product and a manifest.</li>
          <li><strong>Inline preview:</strong> Text-based work products (.md, .txt, .json, .csv) can be previewed in-browser without starting the 7-day retrieval countdown — only Download does that.</li>
        </ul>
      </div>
    </div>
  );
}

export default MyBounties;

