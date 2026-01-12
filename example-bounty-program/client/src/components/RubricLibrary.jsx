import { useState, useEffect } from 'react';
import { apiService } from '../services/api';
import * as rubricStorage from '../services/rubricStorage';
import './RubricLibrary.css';

function RubricLibrary({ walletAddress, onLoadRubric, onClose }) {
  const [savedRubrics, setSavedRubrics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingCid, setLoadingCid] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadSavedRubrics();
  }, [walletAddress]);

  const loadSavedRubrics = () => {
    try {
      setLoading(true);
      setError(null);
      
      if (!walletAddress) {
        setError('Wallet not connected');
        return;
      }

      const rubrics = rubricStorage.getSavedRubrics(walletAddress);
      setSavedRubrics(rubrics);
    } catch (err) {
      console.error('Error loading rubrics:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadRubric = async (rubric) => {
    try {
      setLoadingCid(rubric.cid);
      setError(null);

      // Fetch full rubric from IPFS - this is the SOURCE OF TRUTH
      // IPFS content contains: title, criteria, threshold, classId, etc.
      const rubricData = await apiService.fetchFromIPFS(rubric.cid);
      
      // Parse if string
      const rubricJson = typeof rubricData === 'string' 
        ? JSON.parse(rubricData) 
        : rubricData;

      console.log('📥 Fetched rubric from IPFS:', {
        cid: rubric.cid,
        title: rubricJson.title,
        threshold: rubricJson.threshold,
        classId: rubricJson.classId,
        criteriaCount: rubricJson.criteria?.length
      });

      // Increment usage count in cache
      rubricStorage.incrementUsageCount(walletAddress, rubric.cid);

      // Pass IPFS content to parent (source of truth)
      // Add cid for reference, but threshold/classId come from IPFS content
      // For backwards compatibility with old rubrics that don't have threshold/classId,
      // fall back to cached localStorage values
      onLoadRubric({
        ...rubricJson,
        cid: rubric.cid,
        // Use IPFS values if present, fall back to cache for old rubrics
        threshold: rubricJson.threshold ?? rubric.threshold,
        classId: rubricJson.classId ?? rubric.classId,
      });
      
      // Close modal
      onClose();
    } catch (err) {
      console.error('Error loading rubric from IPFS:', err);
      setError(`Failed to load rubric: ${err.message}`);
    } finally {
      setLoadingCid(null);
    }
  };

  const handleDeleteRubric = (rubric) => {
    if (!confirm(`Delete "${rubric.title}"?\n\nThis cannot be undone.`)) {
      return;
    }

    try {
      rubricStorage.deleteRubric(walletAddress, rubric.cid);
      loadSavedRubrics(); // Reload list
    } catch (err) {
      console.error('Error deleting rubric:', err);
      setError(err.message);
    }
  };

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const formatCid = (cid) => {
    if (!cid) return '';
    return cid.length > 12 ? `${cid.slice(0, 6)}...${cid.slice(-6)}` : cid;
  };

  const handleExport = () => {
    const data = JSON.stringify(savedRubrics, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rubrics-${walletAddress?.slice(0, 8) || 'export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        if (!Array.isArray(imported)) throw new Error('Invalid format');
        let added = 0;
        for (const rubric of imported) {
          if (rubric.cid && rubric.title) {
            try {
              rubricStorage.saveRubric(walletAddress, rubric);
              added++;
            } catch { /* skip duplicates */ }
          }
        }
        loadSavedRubrics();
        alert(`Imported ${added} rubric(s)`);
      } catch (err) {
        setError(`Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="rubric-library-overlay" onClick={onClose}>
      <div className="rubric-library-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rubric-library-header">
          <h2>📚 My Saved Rubrics</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="rubric-library-body">
          {error && (
            <div className="alert alert-error">
              <p>❌ {error}</p>
            </div>
          )}

          {loading && (
            <div className="loading-state">
              <div className="spinner"></div>
              <p>Loading your rubrics...</p>
            </div>
          )}

          {!loading && savedRubrics.length === 0 && (
            <div className="empty-state">
              <p className="empty-icon">📝</p>
              <h3>No Saved Rubrics</h3>
              <p>Save a rubric after creating it to reuse it later.</p>
            </div>
          )}

          {!loading && savedRubrics.length > 0 && (
            <div className="rubrics-list">
              {savedRubrics.map((rubric) => (
                <div key={rubric.cid} className="rubric-card">
                  <div className="rubric-card-header">
                    <h3>{rubric.title}</h3>
                    <span className="rubric-cid" title={rubric.cid}>
                      {formatCid(rubric.cid)}
                    </span>
                  </div>

                  <div className="rubric-card-meta">
                    <div className="rubric-meta-item">
                      <span className="meta-label">Threshold:</span>
                      <span className="meta-value">{rubric.threshold}%</span>
                    </div>
                    <div className="rubric-meta-item">
                      <span className="meta-label">Criteria:</span>
                      <span className="meta-value">{rubric.criteriaCount}</span>
                    </div>
                    <div className="rubric-meta-item">
                      <span className="meta-label">Created:</span>
                      <span className="meta-value">{formatDate(rubric.createdAt)}</span>
                    </div>
                    {rubric.usedCount > 0 && (
                      <div className="rubric-meta-item">
                        <span className="meta-label">Used:</span>
                        <span className="meta-value">{rubric.usedCount}×</span>
                      </div>
                    )}
                  </div>

                  <div className="rubric-card-actions">
                    <button
                      className="btn-load"
                      onClick={() => handleLoadRubric(rubric)}
                      disabled={loadingCid === rubric.cid}
                    >
                      {loadingCid === rubric.cid ? (
                        <>⏳ Loading...</>
                      ) : (
                        <>📂 Load Rubric</>
                      )}
                    </button>
                    <button
                      className="btn-delete"
                      onClick={() => handleDeleteRubric(rubric)}
                      disabled={loadingCid === rubric.cid}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rubric-library-footer">
          <p className="storage-info">
            {savedRubrics.length} rubric{savedRubrics.length !== 1 ? 's' : ''} saved locally
          </p>
          <div className="footer-actions">
            <button className="btn-secondary btn-sm" onClick={handleExport} disabled={savedRubrics.length === 0}>
              Export
            </button>
            <label className="btn-secondary btn-sm import-label">
              Import
              <input type="file" accept=".json" onChange={handleImport} hidden />
            </label>
            <button className="btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default RubricLibrary;

