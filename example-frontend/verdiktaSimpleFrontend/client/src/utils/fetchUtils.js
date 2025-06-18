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
  if (!cid) {
    throw new Error('CID is required for fetching data');
  }

  // Handle the case where the second parameter is an options object
  let retries = 3;
  let options = {};
  
  if (typeof retriesOrOptions === 'object') {
    options = retriesOrOptions;
    retries = options.retries || 3;
  } else {
    retries = retriesOrOptions;
  }

  const baseUrl = SERVER_URL.endsWith('/') ? SERVER_URL.slice(0, -1) : SERVER_URL;
  let url = `${baseUrl}/api/fetch/${cid.trim()}`;
  
  // Add query parameters if we have options
  if (options.isQueryPackage) {
    url += '?isQueryPackage=true';
  }

  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Fetching from server route: ${url} (attempt ${i + 1}/${retries})`);
      const response = await fetch(url, { 
        mode: 'cors',
        headers: {
          'Accept': 'application/json, text/plain, */*'
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'No error details available');
        throw new Error(`HTTP error! status: ${response.status}, details: ${errorText}`);
      }
      
      return response;
    } catch (err) {
      console.error(`Fetch attempt ${i + 1} failed:`, err.message);
      if (i === retries - 1) {
        throw new Error(`Failed to fetch CID ${cid}: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`Failed to fetch after ${retries} attempts`);
};

/**
 * Parse the justification response from the server
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
      return rawText; // Return raw text if JSON parsing fails
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

    // Return the justification text
    return data.justification || JSON.stringify(data, null, 2);
  } catch (parseError) {
    console.error('Error parsing justification:', parseError);
    throw new Error(`Failed to parse justification for CID ${cid}: ${parseError.message}`);
  }
};

export {
  fetchWithRetry,
  tryParseJustification
}; 