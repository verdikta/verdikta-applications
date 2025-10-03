import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../services/api';
import './CreateBounty.css';

function CreateBounty({ walletState }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Form state
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    payoutAmount: '',
    classId: 128,
    threshold: 82,
    criteria: [
      { id: 'originality', description: 'Content must be original', must: true, weight: 0.0 },
      { id: 'quality', description: 'Overall quality', must: false, weight: 1.0 }
    ],
    forbiddenContent: ['NSFW', 'Hate speech'],
    deliverableRequirements: {
      format: ['markdown', 'pdf']
    }
  });

  // TODO: Implement full multi-step form
  // For MVP, provide basic interface

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!walletState.isConnected) {
      alert('Please connect your wallet first');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Step 1: Upload rubric to IPFS
      const rubricJson = {
        title: formData.title,
        description: formData.description,
        threshold: formData.threshold,
        criteria: formData.criteria,
        forbidden_content: formData.forbiddenContent,
        deliverable_requirements: formData.deliverableRequirements
      };

      const uploadResult = await apiService.uploadRubric(rubricJson, formData.classId);
      
      console.log('Rubric uploaded to IPFS:', uploadResult.rubricCid);
      alert(`✅ Rubric uploaded to IPFS!\n\nCID: ${uploadResult.rubricCid}\n\nNext step: Create bounty on-chain with this CID (requires deployed smart contract)`);

      // TODO: Step 2 - Call smart contract createBounty() with rubricCid
      // This requires the BountyEscrow contract to be deployed
      
      // For now, show success and navigate home
      navigate('/');

    } catch (err) {
      console.error('Error creating bounty:', err);
      setError(err.response?.data?.details || err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!walletState.isConnected) {
    return (
      <div className="create-bounty">
        <div className="alert alert-warning">
          <h2>Wallet Not Connected</h2>
          <p>Please connect your wallet to create a bounty.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="create-bounty">
      <div className="create-header">
        <h1>Create New Bounty</h1>
        <p>Define your requirements and lock ETH in escrow</p>
      </div>

      {error && (
        <div className="alert alert-error">
          <p>❌ {error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="bounty-form">
        <div className="form-section">
          <h2>Bounty Details</h2>
          
          <div className="form-group">
            <label htmlFor="title">Title *</label>
            <input
              id="title"
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              placeholder="e.g., Technical Blog Post on Solidity"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="description">Description *</label>
            <textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Describe what you want in detail..."
              rows={4}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="payoutAmount">Payout Amount (ETH) *</label>
            <input
              id="payoutAmount"
              type="number"
              step="0.001"
              min="0.001"
              value={formData.payoutAmount}
              onChange={(e) => setFormData({ ...formData, payoutAmount: e.target.value })}
              placeholder="0.1"
              required
            />
            <small>Minimum: 0.001 ETH</small>
          </div>
        </div>

        <div className="form-section">
          <h2>Evaluation Criteria</h2>
          
          <div className="form-group">
            <label htmlFor="threshold">Passing Threshold (0-100) *</label>
            <input
              id="threshold"
              type="number"
              min="0"
              max="100"
              value={formData.threshold}
              onChange={(e) => setFormData({ ...formData, threshold: parseInt(e.target.value) })}
              required
            />
            <small>Submissions must score above this to win</small>
          </div>

          <div className="criteria-list">
            <h3>Criteria</h3>
            <p className="hint">Default criteria shown. Customize in full implementation.</p>
            {formData.criteria.map((criterion, index) => (
              <div key={index} className="criterion-item">
                <strong>{criterion.id}</strong>: {criterion.description}
                {criterion.must && <span className="badge">MUST</span>}
                {!criterion.must && <span className="weight">Weight: {criterion.weight}</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="form-section">
          <h2>AI Configuration</h2>
          
          <div className="form-group">
            <label htmlFor="classId">Verdikta Class</label>
            <select
              id="classId"
              value={formData.classId}
              onChange={(e) => setFormData({ ...formData, classId: parseInt(e.target.value) })}
            >
              <option value={128}>Class 128 (Frontier Models - GPT-4, Claude)</option>
              <option value={0}>Class 0 (Open Source Models)</option>
            </select>
            <small>Higher class = more capable AI, higher LINK fees</small>
          </div>
        </div>

        <div className="form-actions">
          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary btn-lg"
          >
            {loading ? 'Creating Bounty...' : 'Create Bounty'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="btn btn-secondary"
          >
            Cancel
          </button>
        </div>

        {loading && (
          <div className="loading-status">
            <div className="spinner"></div>
            <p>Uploading rubric to IPFS...</p>
          </div>
        )}
      </form>

      <div className="help-section">
        <h3>💡 How Bounty Creation Works</h3>
        <ol>
          <li>Define your requirements (rubric)</li>
          <li>Set payout amount in ETH</li>
          <li>Rubric is uploaded to IPFS (immutable)</li>
          <li>Smart contract locks your ETH in escrow</li>
          <li>24-hour cancellation lock begins</li>
          <li>Hunters can now submit work</li>
        </ol>
      </div>
    </div>
  );
}

export default CreateBounty;

