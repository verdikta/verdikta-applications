import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiService } from '../services/api';
import './Home.css';

function Home({ walletState }) {
  const [bounties, setBounties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadBounties();
  }, []);

  const loadBounties = async () => {
    try {
      setLoading(true);
      setError(null);

      // TODO: This will work once contract integration is complete
      // For now, show placeholder
      const response = await apiService.listBounties();
      setBounties(response.bounties || []);
    } catch (err) {
      console.error('Error loading bounties:', err);
      
      // Show friendly message for expected error (no contracts yet)
      if (err.response?.status === 501) {
        setError('Contract integration pending. Create your first bounty to test!');
      } else {
        setError('Failed to load bounties. ' + err.message);
      }
      
      // Set empty array for now
      setBounties([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="home">
      <div className="hero">
        <h1>AI-Powered Bounty Program</h1>
        <p className="hero-subtitle">
          Create bounties, submit work, get evaluated by AI, earn ETH automatically
        </p>
        <div className="hero-actions">
          <Link to="/create" className="btn btn-primary btn-lg">
            Create Bounty
          </Link>
          <a href="#how-it-works" className="btn btn-secondary btn-lg">
            How It Works
          </a>
        </div>
      </div>

      <section className="bounties-section">
        <div className="section-header">
          <h2>Active Bounties</h2>
          <div className="filters">
            {/* TODO: Add filters for status, category, payout range */}
          </div>
        </div>

        {loading && (
          <div className="loading">
            <div className="spinner"></div>
            <p>Loading bounties...</p>
          </div>
        )}

        {error && (
          <div className="error-message">
            <p>⚠️ {error}</p>
            <p className="error-hint">
              The backend API is ready, but bounty listing requires deployed smart contracts.
            </p>
          </div>
        )}

        {!loading && !error && bounties.length === 0 && (
          <div className="empty-state">
            <h3>No bounties yet</h3>
            <p>Be the first to create a bounty!</p>
            <Link to="/create" className="btn btn-primary">
              Create First Bounty
            </Link>
          </div>
        )}

        {!loading && bounties.length > 0 && (
          <div className="bounty-grid">
            {bounties.map(bounty => (
              <BountyCard key={bounty.bountyId} bounty={bounty} />
            ))}
          </div>
        )}
      </section>

      <section id="how-it-works" className="how-it-works">
        <h2>How It Works</h2>
        <div className="steps">
          <div className="step">
            <div className="step-number">1</div>
            <h3>Create Bounty</h3>
            <p>Lock ETH in escrow and define evaluation criteria (rubric)</p>
          </div>
          <div className="step">
            <div className="step-number">2</div>
            <h3>Hunters Submit</h3>
            <p>Submit deliverables (essays, designs, code) to be evaluated</p>
          </div>
          <div className="step">
            <div className="step-number">3</div>
            <h3>AI Evaluates</h3>
            <p>Verdikta's AI jury grades submissions against the rubric</p>
          </div>
          <div className="step">
            <div className="step-number">4</div>
            <h3>Auto Payment</h3>
            <p>First passing submission wins ETH automatically</p>
          </div>
        </div>
      </section>

      <section className="features">
        <h2>Why Use Verdikta Bounties?</h2>
        <div className="feature-grid">
          <div className="feature">
            <h3>🤖 AI-Powered</h3>
            <p>Multiple AI models evaluate submissions for fairness and accuracy</p>
          </div>
          <div className="feature">
            <h3>⚡ Automatic</h3>
            <p>No manual review needed - payments happen automatically</p>
          </div>
          <div className="feature">
            <h3>🔒 Trustless</h3>
            <p>ETH locked in smart contract escrow until winner is determined</p>
          </div>
          <div className="feature">
            <h3>📊 Transparent</h3>
            <p>All evaluations and scores are publicly verifiable</p>
          </div>
        </div>
      </section>
    </div>
  );
}

// Bounty Card Component
function BountyCard({ bounty }) {
  return (
    <Link to={`/bounty/${bounty.bountyId}`} className="bounty-card">
      <div className="bounty-header">
        <h3>{bounty.title || `Bounty #${bounty.bountyId}`}</h3>
        <span className={`status-badge status-${bounty.status.toLowerCase()}`}>
          {bounty.status}
        </span>
      </div>
      <p className="bounty-description">{bounty.description}</p>
      <div className="bounty-footer">
        <div className="payout">
          <span className="label">Payout:</span>
          <span className="amount">{bounty.payoutETH} ETH</span>
        </div>
        <div className="submissions">
          <span className="label">Submissions:</span>
          <span className="count">{bounty.submissionCount || 0}</span>
        </div>
      </div>
    </Link>
  );
}

export default Home;

