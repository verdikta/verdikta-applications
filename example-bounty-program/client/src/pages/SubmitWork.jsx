import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiService } from '../services/api';
import './SubmitWork.css';

function SubmitWork({ walletState }) {
  const { bountyId } = useParams();
  const navigate = useNavigate();
  
  const [files, setFiles] = useState([]);
  const [submissionNarrative, setSubmissionNarrative] = useState(
    'Thank you for giving me the opportunity to submit this work. You can find it below in the references section.'
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [submissionResult, setSubmissionResult] = useState(null);
  const [showCIDDialog, setShowCIDDialog] = useState(false);

  const handleFileAdd = (e) => {
    const selectedFiles = Array.from(e.target.files);
    
    if (selectedFiles.length === 0) return;

    const allowedTypes = ['.txt', '.md', '.jpg', '.jpeg', '.png', '.pdf', '.docx'];
    const validFiles = [];
    
    for (const file of selectedFiles) {
      // Validate file size (20 MB)
      if (file.size > 20 * 1024 * 1024) {
        alert(`File "${file.name}" is too large. Maximum size is 20 MB.`);
        continue;
      }

      // Validate file type
      const extension = '.' + file.name.split('.').pop().toLowerCase();
      if (!allowedTypes.includes(extension)) {
        alert(`Invalid file type for "${file.name}". Allowed: ${allowedTypes.join(', ')}`);
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
      alert('Please select at least one file');
      return;
    }

    if (!walletState.isConnected) {
      alert('Please connect your wallet first');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Prepare form data
      const formData = new FormData();
      
      // Add files
      files.forEach(({ file }) => {
        formData.append('files', file);
      });
      
      // Add hunter address
      formData.append('hunter', walletState.address);
      
      // Add submission narrative
      formData.append('submissionNarrative', submissionNarrative);
      
      // Add file descriptions as JSON
      const fileDescriptions = {};
      files.forEach(({ file, description }) => {
        fileDescriptions[file.name] = description;
      });
      formData.append('fileDescriptions', JSON.stringify(fileDescriptions));

      // Submit work via API
      const response = await apiService.submitWorkMultiple(bountyId, formData);
      setSubmissionResult(response);
      setShowCIDDialog(true);

      console.log('Submission result:', response);

    } catch (err) {
      console.error('Error submitting work:', err);
      setError(err.response?.data?.details || err.message);
      alert(`❌ Error: ${err.response?.data?.details || err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCloseCIDDialog = () => {
    setShowCIDDialog(false);
    navigate(`/bounty/${bountyId}`);
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
              accept=".txt,.md,.jpg,.jpeg,.png,.pdf,.docx"
              multiple
            />
            <small>
              Allowed formats: .txt, .md, .jpg, .png, .pdf, .docx<br />
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
            {loading ? 'Uploading...' : `Submit ${files.length} File${files.length !== 1 ? 's' : ''}`}
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
            <p>Creating archives and uploading to IPFS...</p>
          </div>
        )}
      </form>

      <div className="help-section">
        <h3>💡 What Happens Next?</h3>
        <ol>
          <li>Your files are uploaded to IPFS (permanent storage)</li>
          <li>Hunter Submission CID is generated with your work and narrative</li>
          <li>Each file's description is included in the manifest for AI context</li>
          <li>Primary CID is updated to reference your submission</li>
          <li><strong>For testing:</strong> CIDs are displayed for use with example-frontend</li>
          <li><strong>With smart contracts:</strong> You'll pay LINK fee and get AI evaluation automatically</li>
        </ol>

        <h3>💬 About Your Submission Narrative</h3>
        <p>
          The narrative you provide is included in the primary_query.json file sent to the AI evaluators. 
          Use it to explain any nuances, context, or special considerations about your work. This helps the 
          AI better understand and evaluate your submission according to the rubric.
        </p>

        <h3>📁 Multiple Files Support</h3>
        <p>
          You can submit up to 10 files. Each file should have a clear description that helps the AI 
          understand its purpose. All files are referenced in the manifest according to the <a href="https://docs.verdikta.com/verdikta-common/MANIFEST_SPECIFICATION/" target="_blank" rel="noopener noreferrer">Verdikta Manifest Specification</a>.
        </p>

        <h3>⚠️ Important Notes</h3>
        <ul>
          <li>Each submission requires a LINK token fee (when contracts deployed)</li>
          <li>Evaluation is final (no appeals in MVP)</li>
          <li>First passing submission wins</li>
          <li>Your submission becomes public once uploaded</li>
          <li>File descriptions are visible to AI evaluators</li>
        </ul>
      </div>

      {/* CID Display Dialog for Testing */}
      {showCIDDialog && submissionResult && (
        <div className="cid-dialog-overlay" onClick={handleCloseCIDDialog}>
          <div className="cid-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>✅ Submission Successful!</h2>
            <p className="dialog-intro">
              Your work has been submitted ({submissionResult.submission.fileCount} file{submissionResult.submission.fileCount !== 1 ? 's' : ''}). 
              Use these CIDs to test with the example-frontend:
            </p>

            {submissionResult.submission.files && submissionResult.submission.files.length > 0 && (
              <div className="cid-section">
                <h3>Submitted Files</h3>
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
              <h3>Hunter Submission CID</h3>
              <div className="cid-value">
                <code>{submissionResult.submission.hunterCid}</code>
                <button 
                  onClick={() => navigator.clipboard.writeText(submissionResult.submission.hunterCid)}
                  className="btn-copy"
                  title="Copy to clipboard"
                >
                  📋
                </button>
              </div>
              <p className="cid-note">
                Contains your files, descriptions, and submission narrative
              </p>
            </div>

            <div className="cid-section">
              <h3>Updated Primary CID</h3>
              <div className="cid-value">
                <code>{submissionResult.submission.updatedPrimaryCid}</code>
                <button 
                  onClick={() => navigator.clipboard.writeText(submissionResult.submission.updatedPrimaryCid)}
                  className="btn-copy"
                  title="Copy to clipboard"
                >
                  📋
                </button>
              </div>
              <p className="cid-note">
                References the rubric and your hunter submission
              </p>
            </div>

            <div className="cid-section">
              <h3>For Testing (example-frontend)</h3>
              <div className="testing-info">
                <p><strong>Evaluation Format:</strong></p>
                <div className="cid-value">
                  <code>{submissionResult.testingInfo.evaluationFormat}</code>
                  <button 
                    onClick={() => navigator.clipboard.writeText(submissionResult.testingInfo.evaluationFormat)}
                    className="btn-copy"
                    title="Copy to clipboard"
                  >
                    📋
                  </button>
                </div>
                <p className="help-text">
                  Use this in example-frontend's "Run Query" page to test AI evaluation
                </p>
              </div>
              <div className="testing-details">
                <p><strong>Threshold:</strong> {submissionResult.testingInfo.threshold}%</p>
                <p><strong>Bounty Amount:</strong> {submissionResult.testingInfo.bountyAmount} ETH</p>
              </div>
            </div>

            <div className="dialog-actions">
              <button onClick={handleCloseCIDDialog} className="btn btn-primary">
                Back to Job Details
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SubmitWork;



