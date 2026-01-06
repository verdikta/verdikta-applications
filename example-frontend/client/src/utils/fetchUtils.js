// src/utils/fetchUtils.js

const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:5000';

/**
 * Fetch file/text from the server by calling: GET /api/fetch/:cid
 * The server handles IPFS interactions and returns the raw data.
 *
 * @param {string} cid The IPFS CID
 * @param {number|object} [retriesOrOptions=3] Number of retry attempts or options object
 * @param {number} [delay=2000] Delay between retries in milliseconds
 * @returns {Promise<Response>} The fetch Response object.
 */
const fetchWithRetry = async (cid, retriesOrOptions = 3, delay = 2000) => {
  console.log('[fetchWithRetry] Called with CID:', cid);
  
  if (!cid) {
    throw new Error('CID is required for fetching data');
  }

  // Handle the case where the second parameter is an options object
  let retries = 3;
  let options = {};
  let timeout = 60000; // 60 second timeout for IPFS fetches
  
  if (typeof retriesOrOptions === 'object') {
    options = retriesOrOptions;
    retries = options.retries || 3;
    timeout = options.timeout || 60000;
  } else {
    retries = retriesOrOptions;
  }

  const baseUrl = SERVER_URL.endsWith('/') ? SERVER_URL.slice(0, -1) : SERVER_URL;
  let url = `${baseUrl}/api/fetch/${cid.trim()}`;
  
  console.log('[fetchWithRetry] Server URL:', SERVER_URL);
  console.log('[fetchWithRetry] Full URL:', url);
  
  // Add query parameters if we have options
  if (options.isQueryPackage) {
    url += '?isQueryPackage=true';
  }

  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[fetchWithRetry] Fetching from server route: ${url} (attempt ${i + 1}/${retries}, timeout: ${timeout}ms)`);
      
      // Create an AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.error(`[fetchWithRetry] Request timeout after ${timeout}ms`);
        controller.abort();
      }, timeout);
      
      try {
        const fetchStart = Date.now();
        const response = await fetch(url, { 
          mode: 'cors',
          headers: {
            'Accept': 'application/json, text/plain, */*'
          },
          signal: controller.signal
        });
        
        const fetchDuration = Date.now() - fetchStart;
        clearTimeout(timeoutId);
        
        console.log(`[fetchWithRetry] Received response in ${fetchDuration}ms, status: ${response.status}, ok: ${response.ok}`);
        
        if (!response.ok) {
          const errorText = await response.text().catch(() => 'No error details available');
          throw new Error(`HTTP error! status: ${response.status}, details: ${errorText}`);
        }
        
        console.log('[fetchWithRetry] Fetch successful, returning response');
        return response;
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        if (fetchErr.name === 'AbortError') {
          throw new Error(`Request timeout after ${timeout}ms`);
        }
        throw fetchErr;
      }
    } catch (err) {
      console.error(`[fetchWithRetry] Fetch attempt ${i + 1} failed:`, err.message, err);
      if (i === retries - 1) {
        const finalError = new Error(`Failed to fetch CID ${cid}: ${err.message}`);
        console.error('[fetchWithRetry] All retry attempts exhausted, throwing error:', finalError);
        throw finalError;
      }
      console.log(`[fetchWithRetry] Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`Failed to fetch after ${retries} attempts`);
};

/**
 * Parse the justification response from the server
 * Returns an object with justification text and optional enhanced data
 */
const tryParseJustification = async (response, cid, setOutcomes, setResultTimestamp, setOutcomeLabels) => {
  if (!response) {
    throw new Error('Response is required for parsing justification');
  }

  try {
    const rawText = await response.text();
    console.log('Raw response:', {
      cid,
      contentType: response.headers?.get('content-type'),
      length: rawText.length,
      preview: rawText.slice(0, 200)
    });

    // Try to parse as JSON
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseError) {
      console.error('Failed to parse response as JSON:', parseError);
      // Return raw text wrapped in result object (backward compatibility)
      return {
        text: rawText,
        metadata: null,
        modelResults: null,
        warnings: null,
        error: null
      };
    }

    console.log('Parsed JSON data:', data);
    
    // Handle new format with scores array
    if (data.scores && Array.isArray(data.scores)) {
      // Convert scores array to outcomes array
      const outcomeScores = data.scores.map(item => item.score);
      setOutcomes?.(outcomeScores);
      
      // Always update outcome labels from scores array
      const outcomeLabels = data.scores.map(item => item.outcome);
      setOutcomeLabels?.(outcomeLabels);
    }

    // Set the timestamp if it exists
    if (data.timestamp) {
      setResultTimestamp?.(data.timestamp);
    }

    // Return justification text with enhanced data
    return {
      text: data.justification || JSON.stringify(data, null, 2),
      metadata: data.metadata || null,
      modelResults: data.model_results || null,
      warnings: data.warnings || null,
      error: data.error || null
    };
  } catch (parseError) {
    console.error('Error parsing justification:', parseError);
    throw new Error(`Failed to parse justification for CID ${cid}: ${parseError.message}`);
  }
};

export {
  fetchWithRetry,
  tryParseJustification
}; 