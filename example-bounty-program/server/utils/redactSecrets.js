/**
 * Keep secrets out of API responses. ethers v6 puts the provider URL in every HTTP error
 * message (`info={ "requestUrl": "https://base-sepolia.infura.io/v3/<key>" }`), and many
 * routes answer `details: error.message`, so an RPC hiccup handed the Infura/Alchemy key
 * to whoever asked. Every JSON response is scrubbed of the server's secret env values and
 * of provider-key URL shapes.
 */
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|JWT|PRIVATE|RPC|URL)/i;
const PUBLIC_NAMES = new Set(['FRONTEND_CLIENT_KEY', 'PUBLIC_SITE_URL', 'IPFS_GATEWAY', 'PINATA_GATEWAY', 'IPFS_PINNING_SERVICE']);
// Each anchored on a provider host, or on an http(s) URL for the query form: every JSON response
// passes through here, including submitted files (GET .../content serves binaries as base64), and a
// bare "/v2/" + 24 base64 characters occurs in about half of all 10 MiB random files (sec5 fix review).
const URL_KEY_PATTERNS = [
  /(infura\.io\/v3\/)[0-9a-fA-F]{32}/g,                                  // Infura
  /(alchemy\.com\/v2\/)[A-Za-z0-9_-]{24,}/g,                             // Alchemy
];
// The query form (an http(s) URL with ?apikey= / api_key= / key= / token=) is scanned token by
// token, in linear time. As one regex, /https?:\/\/[^\s"?]+\?.../ rescanned to the end of the string
// from every "http://" when no "?" followed: quadratic, and a submitted text file of "http://x"
// repeated (served by GET .../content) held the event loop for minutes (review 2026-11-27, item 3).
const TOKEN = /[^\s"]+/g;
const QUERY_KEY = /([?&](?:apikey|api_key|key|token)=)[^&]+/gi;

function redactQueryKeys(s) {
  if (!s.includes('://')) return s;
  return s.replace(TOKEN, (tok) => {
    const m = /https?:\/\//i.exec(tok);
    if (!m) return tok;
    const q = tok.indexOf('?', m.index + m[0].length);
    if (q < 0) return tok;
    return tok.slice(0, q) + tok.slice(q).replace(QUERY_KEY, '$1[redacted]');
  });
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function secretValues(env = process.env) {
  const out = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || PUBLIC_NAMES.has(name) || !SECRET_NAME.test(name)) continue;
    if (/^https?:\/\/[^/]+\/?$/.test(value)) continue; // a bare origin holds no key
    out.push(value);
    const bare = value.replace(/^Bearer\s+/i, '');
    if (bare !== value) out.push(bare);
  }
  return out.sort((a, b) => b.length - a.length);
}

let _memo = { sig: null, values: [] };
function currentSecrets() {
  const sig = Object.keys(process.env).length + ':' + (process.env.RPC_URL || '').length + ':' + (process.env.INFURA_API_KEY || '').length;
  if (_memo.sig !== sig) _memo = { sig, values: secretValues() };
  return _memo.values;
}

function redact(text, values = currentSecrets()) {
  let s = String(text);
  for (const v of values) if (s.includes(v)) s = s.replace(new RegExp(escapeRe(v), 'g'), '[redacted]');
  for (const re of URL_KEY_PATTERNS) s = s.replace(re, '$1[redacted]');
  return redactQueryKeys(s);
}

/** Express middleware: res.json bodies are redacted before they leave. */
function redactJsonResponses(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    let text;
    try { text = JSON.stringify(body); } catch { return json(body); }
    if (text === undefined) return json(body);
    const clean = redact(text);
    if (clean === text) return json(body);
    try { return json(JSON.parse(clean)); } catch { return json(body); }
  };
  next();
}

module.exports = { redact, redactJsonResponses, secretValues };
