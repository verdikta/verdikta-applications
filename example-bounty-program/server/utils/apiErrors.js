/**
 * Structured API Error Responses
 *
 * Every error tells agents: (1) what went wrong, (2) why, (3) how to fix it.
 *
 * Response shape (backward-compatible — `error` stays a string):
 *   {
 *     success: false,
 *     error:   "Human-readable message",
 *     code:    "MACHINE_READABLE_CODE",
 *     details: "Specific context for this instance",
 *     fix:     "Actionable next step",
 *     tips:    ["additional guidance", ...]
 *   }
 */

/**
 * Send a structured error response.
 *
 * @param {object} res          Express response
 * @param {number} status       HTTP status code
 * @param {object} opts
 * @param {string} opts.code    Machine-readable error code
 * @param {string} opts.message Human-readable summary (also used as `error` for compat)
 * @param {string} [opts.details]  Instance-specific context
 * @param {string} [opts.fix]      Actionable fix instruction
 * @param {string[]} [opts.tips]   Additional guidance array
 * @param {object} [opts.extra]    Any additional fields to merge into the response
 */
function sendError(res, status, { code, message, details, fix, tips, extra } = {}) {
  const body = {
    success: false,
    error: message,
    code,
  };
  if (details !== undefined) body.details = details;
  if (fix !== undefined) body.fix = fix;
  if (tips && tips.length > 0) body.tips = tips;
  if (extra) Object.assign(body, extra);
  return res.status(status).json(body);
}

// ---------------------------------------------------------------------------
// Pre-defined error codes — importable constants
// ---------------------------------------------------------------------------

const ErrorCodes = {
  // Auth
  AUTH_MISSING:      'AUTH_MISSING',
  AUTH_INVALID:      'AUTH_INVALID',

  // Bounty
  BOUNTY_NOT_FOUND:  'BOUNTY_NOT_FOUND',
  BOUNTY_EXPIRED:    'BOUNTY_EXPIRED',
  BOUNTY_CLOSED:     'BOUNTY_CLOSED',
  BOUNTY_NOT_OPEN:   'BOUNTY_NOT_OPEN',

  // Submission
  SUBMISSION_NO_FILES:       'SUBMISSION_NO_FILES',
  SUBMISSION_INVALID_HUNTER: 'SUBMISSION_INVALID_HUNTER',
  SUBMISSION_WINDOW_CLOSED:  'SUBMISSION_WINDOW_CLOSED',
  SUBMISSION_MISSING_CID:    'SUBMISSION_MISSING_CID',
  SUBMISSION_NARRATIVE_LONG: 'SUBMISSION_NARRATIVE_LONG',
  SUBMISSION_NOT_FOUND:      'SUBMISSION_NOT_FOUND',

  // Validation
  VALIDATION_MISSING_FIELD:  'VALIDATION_MISSING_FIELD',
  VALIDATION_INVALID_FORMAT: 'VALIDATION_INVALID_FORMAT',

  // On-chain
  ONCHAIN_TX_NOT_FOUND:   'ONCHAIN_TX_NOT_FOUND',
  ONCHAIN_TX_REVERTED:    'ONCHAIN_TX_REVERTED',
  ONCHAIN_PARSE_FAILED:   'ONCHAIN_PARSE_FAILED',
  ONCHAIN_NOT_AVAILABLE:  'ONCHAIN_NOT_AVAILABLE',
  ONCHAIN_NO_EVAL_PKG:    'ONCHAIN_NO_EVAL_PKG',

  // Bot
  BOT_MISSING_FIELDS:  'BOT_MISSING_FIELDS',
  BOT_INVALID_NAME:    'BOT_INVALID_NAME',
  BOT_INVALID_ADDRESS: 'BOT_INVALID_ADDRESS',

  // Generic
  NOT_FOUND:        'NOT_FOUND',
  INTERNAL_ERROR:   'INTERNAL_ERROR',
  RATE_LIMIT:       'RATE_LIMIT_EXCEEDED',
};

module.exports = { sendError, ErrorCodes };
