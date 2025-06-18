// src/utils/serverUtils.js

const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:5000';

/**
 * Uploads a file to the server and returns the IPFS CID
 * @param {File|Blob} file - The file to upload
 * @param {Function} [setUploadProgress] - Optional callback for upload progress
 * @returns {Promise<string>} The IPFS CID of the uploaded file
 */
export const uploadToServer = async (file, setUploadProgress) => {
  const formData = new FormData();
  formData.append('file', file);

  try {
    // Fix the URL to prevent double slashes
    const baseUrl = SERVER_URL.endsWith('/') ? SERVER_URL.slice(0, -1) : SERVER_URL;
    console.log(`Attempting to connect to server at: ${baseUrl}`);
    const response = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      body: formData,
      mode: 'cors',
      headers: {
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.details || 'Upload failed');
    }

    const data = await response.json();
    return data.cid;
  } catch (error) {
    if (error.message.includes('Failed to fetch') || error.message.includes('ERR_CONNECTION_REFUSED')) {
      console.error('Server connection error:', error);
      throw new Error(
        'Unable to connect to server. Please ensure:\n' +
        '1. The server is running (run npm start in server directory)\n' +
        '2. The server URL is correct in .env (REACT_APP_SERVER_URL)\n' +
        '3. You can access the server at: ' + SERVER_URL
      );
    }
    console.error('Error uploading to server:', error);
    throw new Error('Failed to upload file to IPFS: ' + error.message);
  }
}; 