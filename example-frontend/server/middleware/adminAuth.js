// server/middleware/adminAuth.js
const { isAdmin } = require('../utils/adminsManager');
const { verifySignature } = require('../utils/signatureVerification');

/**
 * Read-only admin gate (GET /api/admins). The address is a claim, not a proof:
 * it only hides the admin list from casual callers. Writes use
 * requireAdminWithSignature below.
 */
async function requireAdmin(req, res, next) {
  try {
    // Get address from various sources
    const address = req.query?.address || req.headers?.['x-wallet-address'];

    if (!address) {
      return res.status(401).json({
        success: false,
        error: 'No wallet address provided'
      });
    }

    const adminStatus = await isAdmin(address);

    if (!adminStatus.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Admin privileges required.'
      });
    }

    // Attach admin info to request for later use
    req.adminAddress = address.toLowerCase();
    req.isBootstrapAdmin = adminStatus.isBootstrap;

    next();
  } catch (error) {
    console.error('Error in requireAdmin middleware:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify admin status'
    });
  }
}

/**
 * Signed admin actions.
 *
 * The signed text (client/src/utils/signatureUtils.js createSignatureMessage) is
 *
 *   Verdikta Playground - <action>
 *
 *   <JSON of the request data, or empty>
 *
 *   Timestamp: <ms>
 *   This signature authorizes the above action.
 *
 * and the request body is { ...data, auth: { message, signature, address } }.
 * A signature is accepted only for the action it names, only with exactly the
 * data it signed (for a DELETE, data.target must be the address in the URL),
 * only within SIGNATURE_WINDOW_MS of its timestamp (either side), and only once.
 *
 * Before this, any personal_sign text by an admin containing "Timestamp: <n>"
 * authorized every action with any body, and a timestamp in the future never
 * expired: one phished or replayed signature was a permanent admin credential
 * (add an admin, or replace the contract list every user's queries pay).
 */
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const MESSAGE_RE = /^Verdikta Playground - ([^\n]+)\n\n([\s\S]*)\n\nTimestamp: (\d{1,16})\nThis signature authorizes the above action\.$/;

// signature (lowercase) -> expiry ms; a signature is good for one request.
const usedSignatures = new Map();
function claimSignature(signature, now) {
  for (const [sig, exp] of usedSignatures) if (exp <= now) usedSignatures.delete(sig);
  const key = String(signature).toLowerCase();
  if (usedSignatures.has(key)) return false;
  usedSignatures.set(key, now + 2 * SIGNATURE_WINDOW_MS);
  return true;
}

/** JSON with object keys sorted, so two equal values compare equal as text. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Check a signed request against the action it must authorize.
 * @returns {{ ok: true, address: string } | { ok: false, status: number, error: string }}
 */
function checkSignedAction(req, action, { targetParam = null, now = Date.now() } = {}) {
  const auth = req.body?.auth;
  const { message, signature, address } = auth || {};
  if (typeof message !== 'string' || typeof signature !== 'string' || typeof address !== 'string') {
    return { ok: false, status: 400, error: 'Missing auth: { message, signature, address }' };
  }
  const m = MESSAGE_RE.exec(message);
  if (!m) return { ok: false, status: 401, error: 'Unrecognized signed message' };
  if (m[1] !== action) return { ok: false, status: 401, error: `Signature is for "${m[1]}", not "${action}"` };

  const ts = Number(m[3]);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > SIGNATURE_WINDOW_MS) {
    return { ok: false, status: 401, error: 'Signature has expired. Please sign again.' };
  }

  let signed;
  try {
    signed = m[2].trim() === '' ? {} : JSON.parse(m[2]);
  } catch {
    return { ok: false, status: 401, error: 'Signed data is not valid JSON' };
  }
  const { auth: _auth, ...data } = req.body || {};
  if (canonical(signed) !== canonical(data)) {
    return { ok: false, status: 401, error: 'Request data does not match the signed data' };
  }
  if (targetParam) {
    const target = String(req.params?.[targetParam] || '').toLowerCase();
    if (!target || String(signed.target || '').toLowerCase() !== target) {
      return { ok: false, status: 401, error: 'Signature does not name this target' };
    }
  }
  if (!verifySignature(message, signature, address)) {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }
  if (!claimSignature(signature, now)) {
    return { ok: false, status: 401, error: 'Signature already used. Please sign again.' };
  }
  return { ok: true, address: address.toLowerCase() };
}

/**
 * Middleware factory: the signer must be an admin and the signature must
 * authorize exactly `action` (see checkSignedAction).
 */
function requireAdminWithSignature(action, options = {}) {
  if (typeof action !== 'string') throw new Error('requireAdminWithSignature(action) needs the action name');
  return async (req, res, next) => {
    try {
      const signer = req.body?.auth?.address;
      const adminStatus = await isAdmin(signer);
      if (!adminStatus.isAdmin) {
        return res.status(403).json({ success: false, error: 'Access denied. Admin privileges required.' });
      }
      const check = checkSignedAction(req, action, options);
      if (!check.ok) return res.status(check.status).json({ success: false, error: check.error });
      req.verifiedAddress = check.address;
      req.adminAddress = check.address;
      req.isBootstrapAdmin = adminStatus.isBootstrap;
      next();
    } catch (error) {
      console.error('Error in requireAdminWithSignature middleware:', error);
      res.status(500).json({ success: false, error: 'Failed to verify signature' });
    }
  };
}

module.exports = {
  requireAdmin,
  requireAdminWithSignature,
  checkSignedAction,
  SIGNATURE_WINDOW_MS,
};
