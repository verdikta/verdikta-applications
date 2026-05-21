/**
 * Signed-message auth for creator-only off-chain mutations.
 *
 * The canonical message is a plain-text block the wallet signs via
 * personal_sign (ethers `signer.signMessage`). Format:
 *
 *   Verdikta Bounty: set public submissions
 *   Bounty ID: <numeric-jobId>
 *   Public: true|false
 *   Timestamp: <ISO-8601 UTC>
 *
 * The server recovers the signer via ethers.verifyMessage, checks the
 * fields match the intended action, and enforces a short validity window
 * to prevent replay of ancient signatures.
 */
const { ethers } = require('ethers');

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

function buildPublicSubmissionsMessage({ bountyId, publicSubmissions, timestamp }) {
  const ts = timestamp || new Date().toISOString();
  return [
    'Verdikta Bounty: set public submissions',
    `Bounty ID: ${bountyId}`,
    `Public: ${publicSubmissions ? 'true' : 'false'}`,
    `Timestamp: ${ts}`,
  ].join('\n');
}

function parsePublicSubmissionsMessage(message) {
  const lines = String(message || '').split('\n').map(l => l.trim());
  if (lines[0] !== 'Verdikta Bounty: set public submissions') {
    throw new Error('Unrecognized message header');
  }
  const fields = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const bountyIdRaw = fields['Bounty ID'];
  const publicRaw   = fields['Public'];
  const tsRaw       = fields['Timestamp'];
  if (bountyIdRaw == null || publicRaw == null || tsRaw == null) {
    throw new Error('Message missing required fields');
  }
  const bountyId = Number(bountyIdRaw);
  if (!Number.isInteger(bountyId) || bountyId < 0) {
    throw new Error('Invalid Bounty ID');
  }
  if (publicRaw !== 'true' && publicRaw !== 'false') {
    throw new Error('Invalid Public value');
  }
  const timestampMs = Date.parse(tsRaw);
  if (!Number.isFinite(timestampMs)) {
    throw new Error('Invalid Timestamp');
  }
  return {
    bountyId,
    publicSubmissions: publicRaw === 'true',
    timestampMs,
  };
}

function verifyPublicSubmissionsAction({
  message,
  signature,
  expectedSigner,
  expectedBountyId,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
}) {
  const parsed = parsePublicSubmissionsMessage(message);

  if (Number(parsed.bountyId) !== Number(expectedBountyId)) {
    throw new Error('Message Bounty ID does not match path');
  }

  const age = Date.now() - parsed.timestampMs;
  if (age < -60_000 || age > maxAgeMs) {
    throw new Error('Signature expired or from the future; request a fresh one');
  }

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (err) {
    throw new Error(`Signature verification failed: ${err.message}`);
  }

  if (recovered.toLowerCase() !== String(expectedSigner || '').toLowerCase()) {
    throw new Error('Signature does not match expected signer');
  }

  return parsed;
}

module.exports = {
  buildPublicSubmissionsMessage,
  parsePublicSubmissionsMessage,
  verifyPublicSubmissionsAction,
};
