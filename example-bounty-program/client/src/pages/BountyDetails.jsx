import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiService } from '../services/api';
import './BountyDetails.css';

function BountyDetails({ walletState }) {
  const { bountyId } = useParams();
  const [bounty, setBounty] = useState(null);
  const [rubric, setRubric] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadBountyDetails();
  }, [bountyId]);

  const loadBountyDetails = async () => {
    try {
      setLoading(true);
      setError(null);

      // TODO: Load from blockchain once contracts are deployed
      const response = await apiService.getBounty(bountyId);
      setBounty(response.bounty);

      // If rubric CID is available, fetch it
      if (response.bounty?.rubricCid) {
        const rubricData = await apiService.fetchFromIPFS(response.bounty.rubricCid);
        setRubric(JSON.parse(rubricData));
      }
    } catch (err) {
      console.error('Error loading bounty:', err);
      setError(err.response?.data?.details || err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bounty-details">
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading bounty details...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bounty-details">
        <div className="alert alert-error">
          <h2>⚠️ Bounty Not Found</h2>
          <p>{error}</p>
          <p className="hint">This endpoint requires deployed smart contracts.</p>
          <Link to="/" className="btn btn-primary">Back to Home</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="bounty-details">
      <div className="bounty-header">
        <div className="header-content">
          <h1>{bounty?.title || `Bounty #${bountyId}`}</h1>
          <span className={`status-badge status-${bounty?.status?.toLowerCase()}`}>
            {bounty?.status}
          </span>
        </div>
        <div className="bounty-stats">
          <div className="stat">
            <span className="label">Payout</span>
            <span className="value">{bounty?.payoutETH} ETH</span>
          </div>
          <div className="stat">
            <span className="label">Submissions</span>
            <span className="value">{bounty?.submissionCount || 0}</span>
          </div>
          <div className="stat">
            <span className="label">Threshold</span>
            <span className="value">{rubric?.threshold || '??'}/100</span>
          </div>
        </div>
      </div>

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
          {walletState.isConnected ? (
            <Link to={`/bounty/${bountyId}/submit`} className="btn btn-primary btn-lg">
              Submit Work
            </Link>
          ) : (
            <div className="alert alert-info">
              Connect your wallet to submit work
            </div>
          )}
        </div>
      </section>

      <section className="submissions-section">
        <h2>Submissions</h2>
        {bounty?.submissions?.length > 0 ? (
          <div className="submissions-list">
            {bounty.submissions.map((submission) => (
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



