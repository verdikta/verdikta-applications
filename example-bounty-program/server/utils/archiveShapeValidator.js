/**
 * Archive Shape Validator
 *
 * Shape-checks a hunter-supplied submission (bCID) archive BEFORE it is used
 * in a prepareSubmission transaction, or flagged after the fact on confirm.
 *
 * This checks structure only (readable ZIP, manifest.json present and valid,
 * primary file present/JSON/query length) — never business content. See
 * verdikta-arbiter external-adapter/doc/MANIFEST_SPECIFICATION.md, section
 * "Submitted-work (bCID) archives", for the full spec this mirrors.
 *
 * Written to fix https://github.com/verdikta/verdikta-applications/issues/34:
 * three hunter-pinned archives (bounties 57, 58, 59) were malformed in three
 * different ways, each one only discovered after the evaluation prepay was
 * already spent and every arbiter aborted.
 */

const AdmZip = require('adm-zip');
const logger = require('./logger');
const { config } = require('../config');
const { MAX_FILE_SIZE } = require('./validation');

// Tried after the configured gateways (config.pinataGateway, config.ipfsGateway)
// — the same pair probeCidAccessibility uses for /diagnose.
const FALLBACK_GATEWAYS = [
  'https://ipfs.io',
  'https://dweb.link',
];

const MIN_QUERY_LEN = 10;
const MAX_QUERY_LEN = 10000;

// Same bare-CID rule the contract enforces ("bad hunterCid"); also keeps the
// value from smuggling a path or query string into the gateway URL.
const BARE_CID_RE = /^[A-Za-z0-9]{46,100}$/;

// POST /:jobId/submit accepts up to 10 work-product files of MAX_FILE_SIZE
// each, so no archive it builds can exceed this. Larger downloads are cut off.
const MAX_ARCHIVE_BYTES = 11 * MAX_FILE_SIZE;

// manifest.json and the primary query are small JSON files (the query itself is
// capped at 10,000 chars). Entries declaring more than this are never inflated,
// which also bounds zip-bomb expansion (adm-zip caps output at the declared size).
const MAX_JSON_ENTRY_BYTES = 1024 * 1024;

const DEFAULT_PER_GATEWAY_TIMEOUT_MS = 15000;
const DEFAULT_TOTAL_TIMEOUT_MS = 40000;

// Same shape `createHunterSubmissionCIDArchive` (utils/archiveGenerator.js)
// produces via POST /:jobId/submit — the reference for what "conforming"
// means, quoted back to callers so they can fix their own archive.
const CONFORMING_SHAPE_EXAMPLE = {
  version: '1.0',
  name: 'submittedWork',
  primary: { filename: 'primary_query.json' },
  additional: [
    { name: 'content', type: 'utf8/file', filename: 'submission.md', description: 'The submitted work product' },
  ],
};

function gatewayList() {
  const all = [config.pinataGateway, config.ipfsGateway, ...FALLBACK_GATEWAYS]
    .filter(Boolean)
    .map(g => String(g).replace(/\/+$/, ''));
  return [...new Set(all)];
}

function tooLargeError(bytes) {
  const err = new Error(`Archive exceeds ${MAX_ARCHIVE_BYTES} bytes${bytes ? ` (got at least ${bytes})` : ''}.`);
  err.tooLarge = true;
  return err;
}

// Read a fetch Response body into a Buffer, aborting once it passes maxBytes.
async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel?.(); } catch (_) { /* ignore */ }
    throw tooLargeError(declared);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) { /* ignore */ }
      throw tooLargeError(total);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetch raw bytes for a CID via the configured gateways, then public ones.
 * Binary-safe (unlike routes/ipfsRoutes.js's fetchWithFallback, which reads
 * `.text()` and would corrupt a ZIP). Stops at an overall deadline so callers
 * stay inside their own client/proxy timeouts.
 *
 * Throws with `.gatewayFailure = true` when no gateway delivered the bytes in
 * time — callers must NOT treat that as "malformed". Throws with
 * `.tooLarge = true` when the archive exceeds MAX_ARCHIVE_BYTES.
 *
 * @param {string} cid
 * @param {{ perGatewayTimeoutMs?: number, totalTimeoutMs?: number, maxBytes?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
async function fetchArchiveBuffer(cid, opts = {}) {
  const {
    perGatewayTimeoutMs = DEFAULT_PER_GATEWAY_TIMEOUT_MS,
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
    maxBytes = MAX_ARCHIVE_BYTES,
  } = opts;
  const deadline = Date.now() + totalTimeoutMs;
  let lastErr = null;
  for (const gateway of gatewayList()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastErr = new Error(`overall ${totalTimeoutMs}ms deadline reached`);
      break;
    }
    // When the overall deadline is nearer than the per-gateway timeout, this attempt
    // gets the rest of the budget; if it then times out, the deadline is reached.
    const attemptMs = Math.min(perGatewayTimeoutMs, remaining);
    const attemptEndsAtDeadline = attemptMs === remaining;
    try {
      const res = await fetch(`${gateway}/ipfs/${cid}`, {
        signal: AbortSignal.timeout(attemptMs),
        headers: { 'User-Agent': 'Verdikta-Bounty-Server/1.0', Accept: 'application/octet-stream, */*' },
      });
      if (!res.ok) {
        try { await res.body?.cancel?.(); } catch (_) { /* ignore */ }
        lastErr = new Error(`gateway ${gateway} -> HTTP ${res.status}`);
        continue;
      }
      const buffer = await readBodyCapped(res, maxBytes);
      logger.debug('[archiveShapeValidator] fetched archive', { cid, gateway, bytes: buffer.length });
      return buffer;
    } catch (e) {
      if (e.tooLarge) throw e;
      lastErr = e;
      logger.debug('[archiveShapeValidator] gateway failed', { cid, gateway, error: e.message });
      if (attemptEndsAtDeadline && e && e.name === 'TimeoutError') {
        // Do not re-read the clock here: the abort timer can fire a millisecond before
        // Date.now() reaches the deadline, which would start one more (1 ms) attempt.
        lastErr = new Error(`overall ${totalTimeoutMs}ms deadline reached`);
        break;
      }
    }
  }
  const err = new Error(`Failed to fetch CID ${cid} from all gateways: ${lastErr ? lastErr.message : 'unknown error'}`);
  err.gatewayFailure = true;
  throw err;
}

// Parse a small JSON entry without inflating anything that declares itself
// larger than MAX_JSON_ENTRY_BYTES. An empty entry is reported as not-JSON
// without calling getData() (adm-zip skips its output cap when size is 0).
function readJsonEntry(entry) {
  const size = entry.header.size;
  if (size > MAX_JSON_ENTRY_BYTES) return { ok: false, reason: 'too-large', size };
  if (!size) return { ok: false, reason: 'not-json' };
  try {
    return { ok: true, value: JSON.parse(entry.getData().toString('utf8')) };
  } catch (e) {
    return { ok: false, reason: 'not-json' };
  }
}

/**
 * Shape-check an in-memory archive buffer.
 * @param {Buffer} buffer
 * @returns {{ ok: true } | { ok: false, check: string, message: string }}
 */
function validateArchiveShape(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
    // AdmZip parses the central directory lazily; force it now so a
    // corrupt/non-ZIP buffer throws here instead of on first getEntries().
    zip.getEntries();
  } catch (e) {
    return { ok: false, check: 'not-a-zip', message: 'Archive is not a readable ZIP file.' };
  }

  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    return { ok: false, check: 'manifest-missing', message: 'manifest.json not found at the archive root.' };
  }

  const manifestRead = readJsonEntry(manifestEntry);
  if (!manifestRead.ok && manifestRead.reason === 'too-large') {
    return {
      ok: false,
      check: 'manifest-too-large',
      message: `manifest.json is ${manifestRead.size} bytes uncompressed; the limit is ${MAX_JSON_ENTRY_BYTES}.`,
    };
  }
  if (!manifestRead.ok || !manifestRead.value || typeof manifestRead.value !== 'object') {
    return { ok: false, check: 'manifest-not-json', message: 'manifest.json is not a valid JSON object.' };
  }
  const manifest = manifestRead.value;

  if (manifest.name !== undefined && manifest.name !== 'submittedWork') {
    return {
      ok: false,
      check: 'manifest-wrong-name',
      message: `manifest.json "name" must be "submittedWork" or absent — got ${JSON.stringify(manifest.name)}.`,
    };
  }

  const primaryFilename = manifest.primary && manifest.primary.filename;
  if (!primaryFilename || typeof primaryFilename !== 'string') {
    return { ok: false, check: 'primary-missing', message: 'manifest.json is missing "primary.filename".' };
  }

  const primaryEntry = zip.getEntry(primaryFilename);
  if (!primaryEntry) {
    return {
      ok: false,
      check: 'primary-not-in-archive',
      message: `manifest.json "primary.filename" ("${primaryFilename}") is not present in the archive.`,
    };
  }

  const primaryRead = readJsonEntry(primaryEntry);
  if (!primaryRead.ok && primaryRead.reason === 'too-large') {
    return {
      ok: false,
      check: 'primary-too-large',
      message: `Primary file "${primaryFilename}" is ${primaryRead.size} bytes uncompressed; the limit is ${MAX_JSON_ENTRY_BYTES}.`,
    };
  }
  if (!primaryRead.ok) {
    return {
      ok: false,
      check: 'primary-not-json',
      message: `Primary file "${primaryFilename}" is not valid JSON — arbiters JSON-parse it directly.`,
    };
  }
  const primaryContent = primaryRead.value;

  const query = primaryContent && primaryContent.query;
  if (typeof query !== 'string' || query.length < MIN_QUERY_LEN || query.length > MAX_QUERY_LEN) {
    return {
      ok: false,
      check: 'primary-query-invalid',
      message: `Primary file's "query" must be a string between ${MIN_QUERY_LEN} and ${MAX_QUERY_LEN} characters — ` +
        (typeof query === 'string' ? `got ${query.length} characters.` : `got ${query === undefined ? 'no query field' : typeof query}.`),
    };
  }

  return { ok: true };
}

/**
 * Convenience: fetch + validate in one call. Distinguishes gateway failure
 * (network/availability — not the hunter's fault, `gatewayFailure: true`)
 * from a genuine shape failure. Never throws.
 * @param {string} cid
 * @param {{ perGatewayTimeoutMs?: number, totalTimeoutMs?: number, maxBytes?: number }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, check: string, message: string, gatewayFailure?: true }>}
 */
async function fetchAndValidateArchiveShape(cid, opts = {}) {
  if (!BARE_CID_RE.test(String(cid))) {
    return {
      ok: false,
      check: 'cid-invalid',
      message: 'hunterCid must be a bare IPFS CID: 46-100 alphanumeric characters, no path or delimiters.',
    };
  }
  let buffer;
  try {
    buffer = await fetchArchiveBuffer(cid, opts);
  } catch (e) {
    if (e.tooLarge) {
      return { ok: false, check: 'archive-too-large', message: e.message };
    }
    return {
      ok: false,
      check: 'gateway-unreachable',
      message: e.message,
      gatewayFailure: true,
    };
  }
  return validateArchiveShape(buffer);
}

/**
 * The value stored as a submission record's `archiveShape`: "ok",
 * "malformed(<check>)", or "unknown" when the archive could not be fetched —
 * an unreachable gateway is never reported as malformed.
 * @param {{ ok: boolean, check?: string, gatewayFailure?: boolean }} result
 * @returns {string}
 */
function archiveShapeLabel(result) {
  if (!result || result.gatewayFailure) return 'unknown';
  return result.ok ? 'ok' : `malformed(${result.check})`;
}

module.exports = {
  validateArchiveShape,
  fetchArchiveBuffer,
  fetchAndValidateArchiveShape,
  archiveShapeLabel,
  CONFORMING_SHAPE_EXAMPLE,
  MAX_ARCHIVE_BYTES,
  MAX_JSON_ENTRY_BYTES,
};
