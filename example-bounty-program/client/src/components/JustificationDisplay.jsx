import { useState, useEffect } from 'react';
import ModelStatusGrid from './ModelStatusGrid';
import WarningsList from './WarningsList';
import { apiService } from '../services/api';
import './JustificationDisplay.css';

/**
 * JustificationDisplay - Displays AI jury justification with elegant UX
 * 
 * Features:
 * - Collapsible/expandable design for clean UI
 * - Status-aware theming (passed/failed)
 * - Multi-CID pagination support
 * - Loading and error states
 * - Formatted text with proper typography
 * 
 * @param {Array<string>} justificationCids - Array of IPFS CIDs containing justifications
 * @param {boolean} passed - Whether the submission passed (for theming)
 * @param {number} score - The evaluation score
 * @param {number} threshold - The passing threshold
 * @param {Array} juryNodes - Array of jury node configurations (optional)
 */
function JustificationDisplay({ justificationCids, passed, score, threshold, juryNodes }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [justifications, setJustifications] = useState([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  
  // Enhanced error reporting data
  const [metadata, setMetadata] = useState([]);
  const [modelResults, setModelResults] = useState([]);
  const [warnings, setWarnings] = useState([]);

  // Normalize justificationCids to always be an array
  // The blockchain stores justificationCids as a comma-separated string, not an array
  const normalizedCids = (() => {
    if (!justificationCids) return [];
    
    // If it's already an array, return it (filtered for valid strings)
    if (Array.isArray(justificationCids)) {
      return justificationCids.filter(cid => cid && typeof cid === 'string' && cid.trim().length > 0);
    }
    
    // If it's a string, split by comma (contract format) or return as single-item array
    if (typeof justificationCids === 'string') {
      const trimmed = justificationCids.trim();
      if (!trimmed) return [];
      
      // Check if it contains commas (multiple CIDs)
      if (trimmed.includes(',')) {
        return trimmed.split(',')
          .map(cid => cid.trim())
          .filter(cid => cid.length > 0 && cid !== '0'); // Filter out empty and '0' (placeholder)
      }
      
      // Single CID (not a placeholder)
      return trimmed !== '0' ? [trimmed] : [];
    }
    
    // If it's an object with justificationCids property, recurse
    if (justificationCids.justificationCids) {
      return normalizedCids(justificationCids.justificationCids);
    }
    
    console.warn('[JustificationDisplay] Unexpected justificationCids format:', justificationCids);
    return [];
  })();

  // Fetch justifications when expanded
  useEffect(() => {
    if (!isExpanded || hasLoaded || normalizedCids.length === 0) {
      return;
    }

    const fetchJustifications = async () => {
      setLoading(true);
      setError(null);

      try {
        console.log('[JustificationDisplay] Fetching justifications for CIDs:', normalizedCids);
        
        const results = await Promise.all(
          normalizedCids.map(async (cid) => {
            try {
              console.log(`[JustificationDisplay] Fetching CID: ${cid}`);
              
              // Fetch from server endpoint using API service (includes auth headers)
              const text = await apiService.fetchFromIPFS(cid);
              
              // Try to parse as JSON first (new format)
              try {
                const data = JSON.parse(text);
                
                // Return an object with both justification text and enhanced data
                return {
                  text: data.justification || JSON.stringify(data, null, 2),
                  metadata: data.metadata || null,
                  modelResults: data.model_results || null,
                  warnings: data.warnings || null,
                  error: data.error || null
                };
              } catch {
                // Return as plain text if not JSON (backward compatibility)
                return {
                  text: text,
                  metadata: null,
                  modelResults: null,
                  warnings: null,
                  error: null
                };
              }
            } catch (err) {
              console.error(`[JustificationDisplay] Error fetching CID ${cid}:`, err);
              return {
                text: `Error loading justification: ${err.message}`,
                metadata: null,
                modelResults: null,
                warnings: null,
                error: err.message
              };
            }
          })
        );

        // Separate text and enhanced data
        const validResults = results.filter(Boolean);
        setJustifications(validResults.map(r => typeof r === 'string' ? r : r.text));
        setMetadata(validResults.map(r => typeof r === 'object' ? r.metadata : null));
        setModelResults(validResults.map(r => typeof r === 'object' ? r.modelResults : null));
        setWarnings(validResults.map(r => typeof r === 'object' ? r.warnings : null));
        setHasLoaded(true);
      } catch (err) {
        console.error('[JustificationDisplay] Error loading justifications:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchJustifications();
  }, [isExpanded, hasLoaded, normalizedCids]);

  // Don't render if no CIDs
  if (normalizedCids.length === 0) {
    console.warn('[JustificationDisplay] No valid CIDs to display');
    return null;
  }

  const currentJustification = justifications[currentPage] || '';
  const hasMultiple = normalizedCids.length > 1;
  
  // Get enhanced data for current page
  const currentMetadata = metadata[currentPage] || null;
  const currentModelResults = modelResults[currentPage] || null;
  const currentWarnings = warnings[currentPage] || null;
  
  // Calculate the actual number of AI models from jury configuration
  // Prefer metadata if available (more accurate), fall back to jury config
  const totalAIModels = (() => {
    // Use metadata if available (from enhanced reporting)
    if (currentMetadata?.models_requested) {
      return currentMetadata.models_requested;
    }
    
    // Fall back to jury configuration
    if (!juryNodes || !Array.isArray(juryNodes) || juryNodes.length === 0) {
      return null; // Unknown
    }
    
    // Sum up the runs (NO_COUNTS) for each node to get total model invocations
    return juryNodes.reduce((total, node) => {
      // Each node can have multiple runs, count each run as a separate model evaluation
      return total + (node.runs || node.NO_COUNTS || 1);
    }, 0);
  })();

  return (
    <div className={`justification-display ${passed ? 'passed' : 'failed'}`}>
      {/* Toggle Button */}
      <button
        className="justification-toggle"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
        <span className="toggle-text">
          {isExpanded ? 'Hide' : 'View'} AI Reasoning
        </span>
        <span className="cid-count">
          {normalizedCids.length} {normalizedCids.length === 1 ? 'justification' : 'justifications'}
        </span>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="justification-content">
          {/* Header with score context */}
          <div className="justification-header">
            <div className="score-context">
              <div className="score-label">Final Score</div>
              <div className={`score-value ${passed ? 'passed' : 'failed'}`}>
                {score?.toFixed(1)}%
              </div>
              <div className="threshold-label">
                (Threshold: {threshold}%)
              </div>
              {/* Model success rate badge */}
              {currentMetadata && (
                <div className="metadata-badge">
                  {currentMetadata.models_successful}/{currentMetadata.models_requested} models
                  {currentMetadata.total_duration_ms && (
                    <span className="duration"> • {(currentMetadata.total_duration_ms / 1000).toFixed(1)}s</span>
                  )}
                </div>
              )}
            </div>
            <div className={`verdict ${passed ? 'passed' : 'failed'}`}>
              {passed ? '✅ PASSED' : '⚠️ DID NOT MEET THRESHOLD'}
            </div>
          </div>

          {/* Navigation for multiple justifications */}
          {hasMultiple && justifications.length > 0 && (
            <div className="justification-nav">
              <button
                className="nav-button"
                onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
                disabled={currentPage === 0}
              >
                ← Previous
              </button>
              <span className="page-indicator">
                Justification {currentPage + 1} of {justifications.length}
              </span>
              <button
                className="nav-button"
                onClick={() => setCurrentPage(Math.min(justifications.length - 1, currentPage + 1))}
                disabled={currentPage === justifications.length - 1}
              >
                Next →
              </button>
            </div>
          )}

          {/* CID Info */}
          <div className="cid-info">
            <span className="cid-label">IPFS CID:</span>
            <a
              href={`https://ipfs.io/ipfs/${normalizedCids[currentPage]}`}
              target="_blank"
              rel="noopener noreferrer"
              className="cid-link"
            >
              {normalizedCids[currentPage]}
            </a>
          </div>

          {/* Model Status Grid - Show before justification text */}
          {currentModelResults && currentModelResults.length > 0 && (
            <ModelStatusGrid modelResults={currentModelResults} />
          )}

          {/* Warnings - Show before justification text */}
          {currentWarnings && currentWarnings.length > 0 && (
            <WarningsList warnings={currentWarnings} />
          )}

          {/* Justification Text */}
          <div className="justification-body">
            {loading ? (
              <div className="loading-state">
                <div className="spinner"></div>
                <p>Loading AI reasoning...</p>
              </div>
            ) : error ? (
              <div className="error-state">
                <p>⚠️ Error loading justification: {error}</p>
                <button onClick={() => {
                  setHasLoaded(false);
                  setError(null);
                }}>
                  Try Again
                </button>
              </div>
            ) : currentJustification ? (
              <div className="justification-text">
                {currentJustification}
              </div>
            ) : (
              <div className="empty-state">
                No justification text available
              </div>
            )}
          </div>

          {/* Footer Info */}
          <div className="justification-footer">
            <p className="footer-note">
              {totalAIModels ? (
                <>
                  💡 This reasoning was generated by {totalAIModels} AI {totalAIModels === 1 ? 'model' : 'models'} 
                  {' '}evaluating the submission against the rubric criteria.
                </>
              ) : (
                <>
                  💡 This reasoning was generated by an AI jury evaluating the submission against the rubric criteria.
                </>
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default JustificationDisplay;

