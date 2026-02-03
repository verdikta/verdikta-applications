// server/utils/signatureVerification.js
const { ethers } = require('ethers');

/**
 * Verifies an Ethereum signature
 * @param {string} message - The original message that was signed
 * @param {string} signature - The signature to verify
 * @param {string} expectedAddress - The address that should have signed the message
 * @returns {boolean} True if signature is valid
 */
function verifySignature(message, signature, expectedAddress) {
  try {
    // Recover the address from the signature
    const recoveredAddress = ethers.verifyMessage(message, signature);

    // Compare addresses (case-insensitive)
    return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

/**
 * Creates a standardized message for signing
 * @param {string} action - The action being performed (e.g., "add_admin", "remove_admin")
 * @param {Object} data - Additional data to include in the message
 * @returns {string} The message to sign
 */
function createSignatureMessage(action, data = {}) {
  const timestamp = Date.now();
  const dataString = Object.keys(data).length > 0 ? JSON.stringify(data) : '';

  return `Verdikta Playground - ${action}

${dataString}

Timestamp: ${timestamp}
This signature authorizes the above action.`;
}

/**
 * Validates that a signature is recent (within 5 minutes)
 * @param {string} message - The signed message
 * @returns {boolean} True if signature is recent
 */
function isSignatureRecent(message) {
  try {
    // Extract timestamp from message
    const timestampMatch = message.match(/Timestamp: (\d+)/);
    if (!timestampMatch) {
      return false;
    }

    const messageTimestamp = parseInt(timestampMatch[1], 10);
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;

    return (now - messageTimestamp) < fiveMinutes;
  } catch (error) {
    console.error('Error checking signature timestamp:', error);
    return false;
  }
}

module.exports = {
  verifySignature,
  createSignatureMessage,
  isSignatureRecent
};
