// src/components/PaginatedJustification.js

import React, { useState, useEffect, useCallback } from 'react';
import { fetchWithRetry, tryParseJustification } from '../utils/fetchUtils';

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
      
      const justificationText = await tryParseJustification(
        response,
        cid,
        onUpdateOutcomes,
        onUpdateTimestamp,
        setOutcomeLabels
      );
      console.log(`[PaginatedJustification] Parsed justification ${index + 1}:`, justificationText?.substring(0, 100) + '...');
      return justificationText;
    } catch (error) {
      console.error(`[PaginatedJustification] Error loading justification ${index + 1} for CID ${cid}:`, error);
      const errorMsg = `Failed to fetch CID ${cid}: ${error.message}`;
      setError(errorMsg);
      return errorMsg;
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
          setJustifications(validResults);
          setLoading(false);
          setHasLoaded(true);
          
          // Call onFetchComplete with the first valid result
          const validResult = validResults.find(r => !r.startsWith('Error') && !r.startsWith('Failed to fetch'));
          if (onFetchComplete && validResult) {
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

      {/* Current CID display */}
      {cids[currentPage] && (
        <div className="text-sm text-gray-500 mb-4">
          Current CID: {cids[currentPage]}
        </div>
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
