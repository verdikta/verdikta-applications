// client/src/utils/signatureUtils.js
import { ethers } from 'ethers';

/**
 * Creates a message for signing
 * @param {string} action - The action being performed
 * @param {Object} data - Additional data to include
 * @returns {string} The message to sign
 */
export function createSignatureMessage(action, data = {}) {
  const timestamp = Date.now();
  const dataString = Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '';

  return `Verdikta Playground - ${action}

${dataString}

Timestamp: ${timestamp}
This signature authorizes the above action.`;
}

/**
 * Requests the user to sign a message with MetaMask
 * @param {string} action - The action being performed (e.g., "Add Administrator")
 * @param {Object} data - Additional data to include in the message
 * @returns {Promise<Object>} { message, signature, address }
 */
export async function requestSignature(action, data = {}) {
  try {
    if (!window.ethereum) {
      throw new Error('No wallet detected. Please install MetaMask.');
    }

    // Get the connected account
    const ethereum = window.ethereum?.providers?.find(p => p.isMetaMask) ?? window.ethereum;
    const provider = new ethers.BrowserProvider(ethereum);
    const signer = await provider.getSigner();
    const address = await signer.getAddress();

    // Create the message
    const message = createSignatureMessage(action, data);

    // Request signature from MetaMask
    const signature = await signer.signMessage(message);

    return {
      message,
      signature,
      address
    };
  } catch (error) {
    console.error('Error requesting signature:', error);

    // Handle user rejection
    if (error.code === 4001 || error.code === 'ACTION_REJECTED') {
      throw new Error('Signature request was rejected');
    }

    throw error;
  }
}

/**
 * Helper to sign and send a request to the backend
 * @param {string} action - The action description
 * @param {string} url - The API endpoint
 * @param {string} method - HTTP method
 * @param {Object} additionalData - Additional data to send in the request body
 * @returns {Promise<Object>} The API response
 */
export async function signAndSend(action, url, method = 'POST', additionalData = {}) {
  // Request signature
  const { message, signature, address } = await requestSignature(action, additionalData);

  // Send request with signature
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      signature,
      address,
      ...additionalData
    }),
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}
