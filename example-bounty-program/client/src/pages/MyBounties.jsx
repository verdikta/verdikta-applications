/**
 * My Bounties Page
 * Dashboard for bounty creators to view and download submissions to their bounties
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { apiService } from '../services/api';
import {
  getBountyStatusLabel,
  getBountyBadgeProps,
  getSubmissionStatusDisplay,
  getSubmissionStatusBadgeClass,
  getArchiveStatusInfo,
} from '../utils/statusDisplay';
import './MyBounties.css';

function MyBounties({ walletState }) {
  const [bounties, setBounties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [expandedBounty, setExpandedBounty] = useState(null);
  const [downloadingSubmission, setDownloadingSubmission] = useState(null);
  const [downloadResult, setDownloadResult] = useState(null);

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
      alert(`Download failed: ${err.message}`);
    } finally {
      setDownloadingSubmission(null);
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
    if (submission.isExpired) {
      const info = getArchiveStatusInfo('expired');
      return <span className={`archive-badge ${info.badgeClass}`} title={info.description}>{info.icon} {info.label}</span>;
    }
    if (submission.retrievedByPoster) {
      const info = getArchiveStatusInfo('retrieved');
      return <span className={`archive-badge ${info.badgeClass}`} title={info.description}>{info.icon} {info.label}</span>;
    }
    const info = getArchiveStatusInfo(submission.archiveStatus);
    return <span className={`archive-badge ${info.badgeClass}`} title={info.description}>{info.icon} {info.label}</span>;
  };

  // Not connected state
  if (!isConnected) {
    return (
      <div className="my-bounties">
        <div className="page-header">
          <h1>📦 My Bounties</h1>
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
          <h1>📦 My Bounties</h1>
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
        <h1>📦 My Bounties</h1>
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
        <button onClick={loadBounties} className="btn btn-sm btn-secondary">
          🔄 Refresh
        </button>
      </div>

      {/* Download Result Modal */}
      {downloadResult && (
        <div className="download-modal-overlay" onClick={() => setDownloadResult(null)}>
          <div className="download-modal" onClick={(e) => e.stopPropagation()}>
            <h3>📥 Download Started</h3>
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
              <p>⚠️ <strong>Important:</strong> This archive will expire in {downloadResult.submission?.daysUntilExpiry || 7} days.</p>
              <p>Please save the file locally for permanent access.</p>
            </div>

            <div className="download-info">
              <p><strong>Hunter:</strong> {downloadResult.submission?.hunter}</p>
              <p><strong>CID:</strong> <code>{downloadResult.submission?.hunterCid}</code></p>
            </div>

            <button onClick={() => setDownloadResult(null)} className="btn btn-secondary">
              Close
            </button>
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
                    Closes: {formatDate(bounty.submissionCloseTime)}
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
                        <span>Hunter</span>
                        <span>Status</span>
                        <span>Score</span>
                        <span>Archive</span>
                        <span>Submitted</span>
                        <span>Action</span>
                      </div>
                      {bounty.submissions.map((sub) => (
                        <div key={sub.submissionId} className="submission-row">
                          <span className="hunter-address" title={sub.hunter}>
                            {sub.hunter?.slice(0, 6)}...{sub.hunter?.slice(-4)}
                          </span>
                          <span className={`sub-status ${getSubmissionStatusBadgeClass(sub.status)}`}>
                            {getSubmissionStatusDisplay(sub.status)}
                          </span>
                          <span className="score">
                            {sub.score != null ? `${sub.score.toFixed(1)}%` : '—'}
                          </span>
                          <span className="archive-status">
                            {getArchiveStatusBadge(sub)}
                            {sub.daysUntilExpiry != null && !sub.isExpired && (
                              <span className="days-left">
                                ({sub.daysUntilExpiry}d left)
                              </span>
                            )}
                          </span>
                          <span className="submitted-date">
                            {formatDate(sub.submittedAt)}
                          </span>
                          <span className="action-cell">
                            {sub.hunterCid && !sub.isExpired ? (
                              <button
                                onClick={() => handleDownload(bounty.jobId, sub.submissionId)}
                                disabled={downloadingSubmission === `${bounty.jobId}-${sub.submissionId}`}
                                className="btn btn-sm btn-primary download-btn"
                                title={sub.retrievedByPoster ? 'Download again (already retrieved)' : 'Download submission'}
                              >
                                {downloadingSubmission === `${bounty.jobId}-${sub.submissionId}` 
                                  ? '...' 
                                  : sub.retrievedByPoster 
                                    ? '↓' 
                                    : '📥'}
                              </button>
                            ) : sub.isExpired ? (
                              <span className="expired-label">Expired</span>
                            ) : (
                              <span className="no-content">—</span>
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
        <h4>📋 About Submission Archives</h4>
        <ul>
          <li><strong>30 days:</strong> Submissions are archived for 30 days after your bounty closes.</li>
          <li><strong>7 days after download:</strong> Once you download a submission, it remains available for 7 more days.</li>
          <li><strong>Save locally:</strong> Always save downloaded files to your computer for permanent access.</li>
          <li><strong>ZIP format:</strong> Submissions are ZIP archives containing the work product and a manifest.</li>
        </ul>
      </div>
    </div>
  );
}

export default MyBounties;

