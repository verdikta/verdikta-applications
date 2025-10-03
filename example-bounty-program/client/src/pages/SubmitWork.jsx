import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiService } from '../services/api';
import './SubmitWork.css';

function SubmitWork({ walletState }) {
  const { bountyId } = useParams();
  const navigate = useNavigate();
  
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [uploadResult, setUploadResult] = useState(null);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    
    if (!selectedFile) {
      setFile(null);
      return;
    }

    // Validate file size (20 MB)
    if (selectedFile.size > 20 * 1024 * 1024) {
      alert('File too large. Maximum size is 20 MB.');
      e.target.value = '';
      return;
    }

    // Validate file type
    const allowedTypes = ['.txt', '.md', '.jpg', '.jpeg', '.png', '.pdf', '.docx'];
    const extension = '.' + selectedFile.name.split('.').pop().toLowerCase();
    
    if (!allowedTypes.includes(extension)) {
      alert(`Invalid file type. Allowed: ${allowedTypes.join(', ')}`);
      e.target.value = '';
      return;
    }

    setFile(selectedFile);
    setError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!file) {
      alert('Please select a file');
      return;
    }

    if (!walletState.isConnected) {
      alert('Please connect your wallet first');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Step 1: Upload to IPFS
      const uploadResponse = await apiService.uploadDeliverable(bountyId, file);
      setUploadResult(uploadResponse);

      console.log('Deliverable uploaded:', uploadResponse.deliverableCid);

      alert(`✅ File uploaded to IPFS!\n\nCID: ${uploadResponse.deliverableCid}\n\nNext: Submit on-chain and request evaluation (requires deployed contract)`);

      // TODO: Step 2 - Call contract.submitAndEvaluate() with CID
      // This requires BountyEscrow contract deployment
      
      // For now, show success
      navigate(`/bounty/${bountyId}`);

    } catch (err) {
      console.error('Error submitting work:', err);
      setError(err.response?.data?.details || err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!walletState.isConnected) {
    return (
      <div className="submit-work">
        <div className="alert alert-warning">
          <h2>Wallet Not Connected</h2>
          <p>Please connect your wallet to submit work.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="submit-work">
      <div className="submit-header">
        <h1>Submit Your Work</h1>
        <p>Upload your deliverable for AI evaluation</p>
      </div>

      {error && (
        <div className="alert alert-error">
          <p>❌ {error}</p>
        </div>
      )}

      {uploadResult && (
        <div className="alert alert-success">
          <h3>✅ File Uploaded Successfully!</h3>
          <p><strong>CID:</strong> {uploadResult.deliverableCid}</p>
          <p><strong>Size:</strong> {(uploadResult.size / 1024).toFixed(2)} KB</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="submit-form">
        <div className="form-section">
          <h2>Upload Deliverable</h2>
          
          <div className="form-group">
            <label htmlFor="file">Select File *</label>
            <input
              id="file"
              type="file"
              onChange={handleFileChange}
              accept=".txt,.md,.jpg,.jpeg,.png,.pdf,.docx"
              required
            />
            <small>
              Allowed formats: .txt, .md, .jpg, .png, .pdf, .docx<br />
              Maximum size: 20 MB
            </small>
          </div>

          {file && (
            <div className="file-preview">
              <h3>Selected File</h3>
              <p><strong>Name:</strong> {file.name}</p>
              <p><strong>Size:</strong> {(file.size / 1024).toFixed(2)} KB</p>
              <p><strong>Type:</strong> {file.type || 'Unknown'}</p>
            </div>
          )}
        </div>

        <div className="form-actions">
          <button
            type="submit"
            disabled={loading || !file}
            className="btn btn-primary btn-lg"
          >
            {loading ? 'Uploading...' : 'Submit Work'}
          </button>
          <button
            type="button"
            onClick={() => navigate(`/bounty/${bountyId}`)}
            className="btn btn-secondary"
          >
            Cancel
          </button>
        </div>

        {loading && (
          <div className="loading-status">
            <div className="spinner"></div>
            <p>Uploading to IPFS...</p>
          </div>
        )}
      </form>

      <div className="help-section">
        <h3>💡 What Happens Next?</h3>
        <ol>
          <li>Your file is uploaded to IPFS (permanent storage)</li>
          <li>You'll pay a LINK fee for AI evaluation</li>
          <li>Verdikta's AI jury evaluates your work (1-5 minutes)</li>
          <li>If you pass the threshold, ETH is sent to your wallet automatically!</li>
          <li>If you don't pass, you can try again (new fee applies)</li>
        </ol>

        <h3>⚠️ Important Notes</h3>
        <ul>
          <li>Each submission requires a LINK token fee</li>
          <li>Evaluation is final (no appeals in MVP)</li>
          <li>First passing submission wins</li>
          <li>Your submission becomes public once uploaded</li>
        </ul>
      </div>
    </div>
  );
}

export default SubmitWork;



