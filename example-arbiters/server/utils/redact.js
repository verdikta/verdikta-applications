/**
 * Strip configured secrets (RPC URLs with their API keys, *_KEY values) from
 * text the server sends or logs.
 *
 * ethers v6 puts the full request URL into its error messages ("server
 * response 429 ... info={ requestUrl: https://base-mainnet.infura.io/v3/<key> }"),
 * and those messages reach API responses (`details`, `error`, `scanError`,
 * per-arbiter `error`) and the analytics cache. Any RPC failure, which an
 * attacker can provoke by exhausting the provider's rate limit, would then
 * hand out the key. This module is applied to every JSON response (server.js)
 * and to log lines (utils/logger.js).
 */

// Env vars whose values are, or carry, a credential.
const SECRET_NAME_RE = /(^|_)(KEY|SECRET|TOKEN|PASSWORD)$|RPC(_PROVIDER)?_URL$|^RPC_URL$/i;
const MIN_SECRET_LEN = 8;

/** The strings to redact, longest first (a URL before the key inside it). */
function secretStrings(env = process.env) {
  const out = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_NAME_RE.test(name)) continue;
    const v = String(value).trim();
    if (v.length >= MIN_SECRET_LEN) out.add(v);
    // A URL's key usually sits in its path or query (Infura /v3/<key>,
    // Alchemy /v2/<key>, ?apikey=): redact that part on its own as well, since
    // a message may quote the URL re-encoded or without its scheme.
    try {
      const u = new URL(v);
      const tail = `${u.pathname}${u.search}`;
      if (tail.replace(/[/?=&]/g, '').length >= MIN_SECRET_LEN) out.add(tail);
      if (u.password) out.add(u.password);
    } catch { /* not a URL */ }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replace every configured secret in `text` with "[redacted]". */
function redact(text, env = process.env) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const s of secretStrings(env)) {
    if (out.includes(s)) out = out.split(s).join('[redacted]');
  }
  return out;
}

module.exports = { redact, secretStrings };
