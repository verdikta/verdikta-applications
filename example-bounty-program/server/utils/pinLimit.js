/**
 * Per-client-address budget for routes that PIN to IPFS (the operator's Pinata account
 * pays): job creation, submissions, rubric pins. Keys don't identify anyone (the website
 * key is public and bot keys are free), so the address is the only handle.
 */
const { createRateLimiter, clientAddress } = require('./rateLimiter');
const { sendError, ErrorCodes } = require('./apiErrors');

const pinLimiter = createRateLimiter({
  windowMs: Number(process.env.PIN_RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000,
  max: Number(process.env.PIN_RATE_LIMIT_MAX) || 40,
});

function limitPins(req, res, next) {
  // The route suites post hundreds of creates from one address; a test that wants the
  // limit sets PIN_RATE_LIMIT_MAX.
  if (process.env.NODE_ENV === 'test' && !process.env.PIN_RATE_LIMIT_MAX) return next();
  const { allowed, retryAfterSeconds } = pinLimiter.hit(clientAddress(req));
  if (allowed) return next();
  res.set('Retry-After', String(retryAfterSeconds));
  return sendError(res, 429, {
    code: ErrorCodes.RATE_LIMIT,
    message: 'Too many uploads',
    details: `Routes that pin to IPFS are limited per client address. Retry in ${retryAfterSeconds}s.`,
    fix: 'Debug request shapes with the free validators (POST /api/jobs/rubric/validate, /api/jobs/:id/submit/dry-run), which pin nothing.',
  });
}

module.exports = { limitPins, pinLimiter };
