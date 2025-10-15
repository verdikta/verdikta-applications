import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiService } from '../services/api';
import './BountyDetails.css';

function BountyDetails({ walletState }) {
  const { bountyId } = useParams();
  const [job, setJob] = useState(null);
  const [rubric, setRubric] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadJobDetails();
  }, [bountyId]);

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
          <h2>⚠️ Job Not Found</h2>
          <p>{error}</p>
          <Link to="/" className="btn btn-primary">Back to Home</Link>
        </div>
      </div>
    );
  }

  // Calculate time remaining
  const now = Math.floor(Date.now() / 1000);
  const timeRemaining = job ? job.submissionCloseTime - now : 0;
  const hoursRemaining = Math.max(0, Math.floor(timeRemaining / 3600));
  const isOpen = job?.status === 'OPEN' && timeRemaining > 0;

  return (
    <div className="bounty-details">
      <div className="bounty-header">
        <div className="header-content">
          <h1>{job?.title || `Job #${bountyId}`}</h1>
          <span className={`status-badge status-${job?.status?.toLowerCase()}`}>
            {job?.status}
          </span>
          {job?.workProductType && (
            <span className="work-type-badge">{job.workProductType}</span>
          )}
        </div>
        <div className="bounty-stats">
          <div className="stat">
            <span className="label">Payout</span>
            <span className="value">
              {job?.bountyAmount} ETH
              {job?.bountyAmountUSD > 0 && (
                <small> (${job.bountyAmountUSD})</small>
              )}
            </span>
          </div>
          <div className="stat">
            <span className="label">Submissions</span>
            <span className="value">{job?.submissionCount || 0}</span>
          </div>
          <div className="stat">
            <span className="label">Threshold</span>
            <span className="value">{job?.threshold || '??'}%</span>
          </div>
          <div className="stat">
            <span className="label">Time Remaining</span>
            <span className="value">
              {timeRemaining <= 0 ? (
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
          {!isOpen ? (
            <div className="alert alert-warning">
              {job?.status === 'COMPLETED' 
                ? '🎉 This job has been completed and a winner has been paid!'
                : 'This job is no longer accepting submissions'}
            </div>
          ) : walletState.isConnected ? (
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



