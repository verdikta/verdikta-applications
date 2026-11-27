/**
 * Operator-only routes. The website's X-Client-Key ships in the browser bundle and a bot
 * key is free to register, so neither identifies the operator: a route that changes or
 * deletes data for everyone (orphan cleanup, pin probes, manual archival runs) needs
 * X-Admin-Key equal to ADMIN_API_KEY. With ADMIN_API_KEY unset those routes are off.
 */
const crypto = require('crypto');
const { sendError, ErrorCodes } = require('./apiErrors');

function keyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_API_KEY || '';
  if (!expected) {
    return sendError(res, 403, {
      code: ErrorCodes.AUTH_INVALID,
      message: 'Operator route disabled',
      details: 'This route is for the site operator and ADMIN_API_KEY is not configured on this server.',
    });
  }
  if (!keyMatches(req.headers['x-admin-key'], expected)) {
    return sendError(res, 403, {
      code: ErrorCodes.AUTH_INVALID,
      message: 'Operator key required',
      details: 'Send X-Admin-Key with the server\'s ADMIN_API_KEY.',
    });
  }
  return next();
}

module.exports = { requireAdmin, keyMatches };
