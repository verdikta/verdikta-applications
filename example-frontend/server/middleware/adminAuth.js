// server/middleware/adminAuth.js
const { isAdmin } = require('../utils/adminsManager');
const { verifySignature, isSignatureRecent } = require('../utils/signatureVerification');

/**
 * Middleware to check if the requester is an admin
 * Expects address in request body, query, or header
 */
async function requireAdmin(req, res, next) {
  try {
    // Get address from various sources
    const address = req.body?.address || req.query?.address || req.headers?.['x-wallet-address'];

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
 * Middleware to verify signature for state-changing operations
 * Expects message and signature in request body
 */
async function requireSignature(req, res, next) {
  try {
    const { message, signature, address } = req.body;

    if (!message || !signature || !address) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: message, signature, and address'
      });
    }

    // Check if signature is recent (within 5 minutes)
    if (!isSignatureRecent(message)) {
      return res.status(401).json({
        success: false,
        error: 'Signature has expired. Please sign again.'
      });
    }

    // Verify the signature
    const isValid = verifySignature(message, signature, address);

    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid signature'
      });
    }

    // Attach verified address to request
    req.verifiedAddress = address.toLowerCase();

    next();
  } catch (error) {
    console.error('Error in requireSignature middleware:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify signature'
    });
  }
}

/**
 * Combined middleware: requires both admin status and valid signature
 */
async function requireAdminWithSignature(req, res, next) {
  // First check if they're an admin
  await requireAdmin(req, res, async (err) => {
    if (err) return next(err);

    // Then verify their signature
    await requireSignature(req, res, next);
  });
}

module.exports = {
  requireAdmin,
  requireSignature,
  requireAdminWithSignature
};
