/**
 * Website create-attempt reports (POST /api/jobs/:jobId/create-attempt).
 *
 * The create page creates an API job, then asks the wallet to send createBounty.
 * When the wallet step fails the job stays unlinked and, before these reports,
 * nothing about the failure ever reached the server (2026-10-16: jobs 287, 288,
 * 298-303). The page now reports how far each attempt got and how it failed.
 *
 * The data is a hint, not evidence: the client key ships in the public bundle
 * and creator addresses are public, so anyone can write a report for an
 * unlinked job. Everything is reduced to known keys, enums and short strings.
 */

const EVENTS = ['sign_requested', 'tx_sent', 'failed'];
const STEPS = ['connect', 'staticCall', 'send', 'wait', 'link'];
const CATEGORIES = [
  'rejected_in_wallet',
  'insufficient_funds',
  'contract_would_revert',
  'reverted_onchain',
  'wrong_network',
  'wallet_prompt_pending',
  'wallet_timeout',
  'wallet_or_rpc_error',
  'link_failed',
  'unknown',
];
const ACCOUNT_TYPES = ['eoa', 'eip7702', 'contract', 'unknown'];

const MAX_ATTEMPTS = 10;
const MAX_TEXT = 500;
const MAX_SHORT = 100;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const text = (v, max = MAX_TEXT) => {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};
const oneOf = (v, allowed) => (allowed.includes(v) ? v : undefined);
const matches = (v, re) => (typeof v === 'string' && re.test(v) ? v : undefined);
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);

/**
 * Reduce a report body to the stored shape. Unknown keys are dropped and every
 * value is type-checked or truncated. Returns { event } or { error }.
 */
function sanitizeCreateAttempt(body, { now = () => new Date() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object' };
  const event = oneOf(body.event, EVENTS);
  if (!event) return { error: `event must be one of: ${EVENTS.join(', ')}` };

  const out = {
    event,
    receivedAt: now().toISOString(),
    at: text(body.at, 40),
    step: oneOf(body.step, STEPS),
    category: oneOf(body.category, CATEGORIES),
    code: text(body.code, MAX_SHORT),
    rpcCode: text(body.rpcCode, MAX_SHORT),
    reason: text(body.reason),
    message: text(body.message),
    walletMessage: text(body.walletMessage),
    txHash: matches(body.txHash, TX_HASH_RE),
    chainId: int(body.chainId, 1, Number.MAX_SAFE_INTEGER),
    wallet: text(body.wallet, MAX_SHORT),
    browser: text(body.browser, 20),
    mobile: typeof body.mobile === 'boolean' ? body.mobile : undefined,
    accountType: oneOf(body.accountType, ACCOUNT_TYPES),
    delegate: matches(body.delegate, ADDRESS_RE),
    elapsedMs: int(body.elapsedMs, 0, 24 * 3600 * 1000),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return { event: out };
}

/** A job the website can still be reporting a failed create for. */
const isUnlinked = (job) => !job.onChain && !job.syncedFromBlockchain;

/** Append, keeping the newest MAX_ATTEMPTS. */
const appendAttempt = (attempts, event) =>
  [...(Array.isArray(attempts) ? attempts : []), event].slice(-MAX_ATTEMPTS);

/** Short view for admin listings. */
const attemptSummary = (job) => {
  const attempts = Array.isArray(job.createAttempts) ? job.createAttempts : [];
  return { createAttemptCount: attempts.length, lastCreateAttempt: attempts[attempts.length - 1] || null };
};

module.exports = {
  EVENTS,
  STEPS,
  CATEGORIES,
  MAX_ATTEMPTS,
  MAX_TEXT,
  ADDRESS_RE,
  sanitizeCreateAttempt,
  isUnlinked,
  appendAttempt,
  attemptSummary,
};
