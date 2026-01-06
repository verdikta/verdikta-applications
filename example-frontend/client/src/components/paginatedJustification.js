// src/components/PaginatedJustification.js

import React, { useState, useEffect, useCallback } from 'react';
import { fetchWithRetry, tryParseJustification } from '../utils/fetchUtils';
import ModelStatusGrid from './ModelStatusGrid';
import WarningsList from './WarningsList';

// Simple arrow components to avoid external dependency
const ChevronLeft = () => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    width="24" 
    height="24" 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
  >
    <path d="M15 18l-6-6 6-6"/>
  </svg>
);

const ChevronRight = () => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    width="24" 
    height="24" 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
  >
    <path d="M9 18l6-6-6-6"/>
  </svg>
);

const PaginatedJustification = ({ 
  resultCid, 
  initialText,
  onFetchComplete,
  onUpdateOutcomes,
  onUpdateTimestamp,
  setOutcomeLabels 
}) => {
  const [currentPage, setCurrentPage] = useState(0);
  const [justifications, setJustifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  
  // Enhanced error reporting data
  const [metadata, setMetadata] = useState([]);
  const [modelResults, setModelResults] = useState([]);
  const [warnings, setWarnings] = useState([]);

  // Parse CID string to handle multiple CIDs separated by commas
  const cids = (() => {
    if (!resultCid) return [];
    
    // Simple split for comma-separated CIDs
    return resultCid.split(',').map(cid => cid.trim()).filter(Boolean);
  })();

  // Define loadJustification as a useCallback function to include it in the dependencies
  const loadJustification = useCallback(async (cid, index) => {
    setLoading(true);
    setError(null);
    try {
      console.log(`[PaginatedJustification] Fetching justification ${index + 1} for CID:`, cid);
      const startTime = Date.now();
      const response = await fetchWithRetry(cid);
      const fetchDuration = Date.now() - startTime;
      console.log(`[PaginatedJustification] Received response for CID ${cid} in ${fetchDuration}ms`);
      
      const justificationData = await tryParseJustification(
        response,
        cid,
        onUpdateOutcomes,
        onUpdateTimestamp,
        setOutcomeLabels
      );
      
      // Handle both old (string) and new (object) formats
      const result = typeof justificationData === 'string' 
        ? { text: justificationData, metadata: null, modelResults: null, warnings: null, error: null }
        : justificationData;
      
      console.log(`[PaginatedJustification] Parsed justification ${index + 1}:`, result.text?.substring(0, 100) + '...');
      return result;
    } catch (error) {
      console.error(`[PaginatedJustification] Error loading justification ${index + 1} for CID ${cid}:`, error);
      const errorMsg = `Failed to fetch CID ${cid}: ${error.message}`;
      setError(errorMsg);
      return {
        text: errorMsg,
        metadata: null,
        modelResults: null,
        warnings: null,
        error: error.message
      };
    }
  }, [onUpdateOutcomes, onUpdateTimestamp, setOutcomeLabels]);

  useEffect(() => {
    // Reset state when resultCid changes
    if (resultCid) {
      setHasLoaded(false);
    }
  }, [resultCid]);

  useEffect(() => {
    console.log('PaginatedJustification effect triggered:', {
      resultCid,
      initialText,
      cidsLength: cids.length,
      hasLoaded
    });

    // If we've already loaded this CID, don't reload
    if (hasLoaded) {
      return;
    }

    // Initialize with initial text if available and no CIDs
    if (initialText && cids.length === 0) {
      setJustifications([initialText]);
      setHasLoaded(true);
      return;
    }

    // Load justifications if we have CIDs
    if (cids.length > 0) {
      console.log(`[PaginatedJustification] Loading ${cids.length} justification(s)`);
      Promise.all(cids.map((cid, index) => loadJustification(cid, index)))
        .then(results => {
          console.log(`[PaginatedJustification] Loaded ${results.length} justifications`);
          const validResults = results.filter(Boolean);
          
          // Separate text and enhanced data
          setJustifications(validResults.map(r => typeof r === 'string' ? r : r.text));
          setMetadata(validResults.map(r => typeof r === 'object' ? r.metadata : null));
          setModelResults(validResults.map(r => typeof r === 'object' ? r.modelResults : null));
          setWarnings(validResults.map(r => typeof r === 'object' ? r.warnings : null));
          
          setLoading(false);
          setHasLoaded(true);
          
          // Call onFetchComplete with the first valid result (text only for backward compatibility)
          const firstText = validResults[0];
          const validResult = typeof firstText === 'string' 
            ? firstText 
            : firstText?.text;
          
          if (onFetchComplete && validResult && !validResult.startsWith('Error') && !validResult.startsWith('Failed to fetch')) {
            console.log('[PaginatedJustification] Calling onFetchComplete with result');
            onFetchComplete(validResult);
          }
        })
        .catch(error => {
          console.error('[PaginatedJustification] Error in Promise.all:', error);
          setError(error.message);
          setLoading(false);
          setHasLoaded(true);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultCid, initialText, hasLoaded, loadJustification, onFetchComplete]);

  // If no CIDs and no justifications, show appropriate message
  if (cids.length === 0 && justifications.length === 0) {
    return <div className="text-gray-500">No justification available</div>;
  }

  const currentJustification = justifications[currentPage] || '';
  const currentMetadata = metadata[currentPage] || null;
  const currentModelResults = modelResults[currentPage] || null;
  const currentWarnings = warnings[currentPage] || null;

  return (
    <div className="w-full space-y-4">
      {/* Navigation controls - only show if multiple CIDs */}
      {cids.length > 1 && (
        <div className="flex items-center justify-between bg-gray-100 p-4 rounded-lg">
          <button
            onClick={() => setCurrentPage(prev => Math.max(0, prev - 1))}
            disabled={currentPage === 0 || loading}
            className="flex items-center px-3 py-2 bg-white rounded-md shadow 
                     disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronLeft />
            <span className="ml-2">Previous</span>
          </button>
          
          <div className="text-sm text-gray-600">
            Justification {currentPage + 1} of {cids.length}
          </div>
          
          <button
            onClick={() => setCurrentPage(prev => Math.min(cids.length - 1, prev + 1))}
            disabled={currentPage === cids.length - 1 || loading}
            className="flex items-center px-3 py-2 bg-white rounded-md shadow
                     disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="mr-2">Next</span>
            <ChevronRight />
          </button>
        </div>
      )}

      {/* Current CID display with metadata badge */}
      <div className="flex items-center justify-between text-sm text-gray-500 mb-4">
        <span>Current CID: {cids[currentPage]}</span>
        {currentMetadata && (
          <span className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-semibold">
            {currentMetadata.models_successful}/{currentMetadata.models_requested} models
            {currentMetadata.total_duration_ms && (
              <span className="opacity-70"> • {(currentMetadata.total_duration_ms / 1000).toFixed(1)}s</span>
            )}
          </span>
        )}
      </div>

      {/* Model Status Grid */}
      {currentModelResults && currentModelResults.length > 0 && (
        <ModelStatusGrid modelResults={currentModelResults} />
      )}

      {/* Warnings List */}
      {currentWarnings && currentWarnings.length > 0 && (
        <WarningsList warnings={currentWarnings} />
      )}

      {/* Justification content */}
      <div className="bg-white p-6 rounded-lg shadow whitespace-pre-wrap">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
          </div>
        ) : error ? (
          <div className="text-red-500">{error}</div>
        ) : (
          currentJustification || 'No justification text available'
        )}
      </div>
    </div>
  );
};

export default PaginatedJustification;
