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

const PUBLIC_GATEWAYS = [
  'https://ipfs.io',
  'https://gateway.pinata.cloud',
  'https://cloudflare-ipfs.com',
  'https://dweb.link',
];

const MIN_QUERY_LEN = 10;
const MAX_QUERY_LEN = 10000;

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

/**
 * Fetch raw bytes for a CID via public IPFS gateways, with fallback.
 * Binary-safe (unlike routes/ipfsRoutes.js's fetchWithFallback, which reads
 * `.text()` and would corrupt a ZIP). Throws with `.gatewayFailure = true`
 * when every gateway failed — callers must NOT treat that as "malformed".
 *
 * @param {string} cid
 * @param {number} [timeoutMs]
 * @returns {Promise<Buffer>}
 */
async function fetchArchiveBuffer(cid, timeoutMs = 20000) {
  let lastErr = null;
  for (const gateway of PUBLIC_GATEWAYS) {
    const url = `${gateway}/ipfs/${cid}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Verdikta-Bounty-Server/1.0', Accept: 'application/octet-stream, */*' },
      });
      if (!res.ok) {
        lastErr = new Error(`gateway ${gateway} -> HTTP ${res.status}`);
        continue;
      }
      const arrayBuffer = await res.arrayBuffer();
      logger.debug('[archiveShapeValidator] fetched archive', { cid, gateway, bytes: arrayBuffer.byteLength });
      return Buffer.from(arrayBuffer);
    } catch (e) {
      lastErr = e;
      logger.debug('[archiveShapeValidator] gateway failed', { cid, gateway, error: e.message });
    } finally {
      clearTimeout(timer);
    }
  }
  const err = new Error(`Failed to fetch CID ${cid} from all gateways: ${lastErr ? lastErr.message : 'unknown error'}`);
  err.gatewayFailure = true;
  throw err;
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

  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch (e) {
    return { ok: false, check: 'manifest-not-json', message: 'manifest.json is not valid JSON.' };
  }

  if (manifest.name !== undefined && manifest.name !== 'submittedWork') {
    return {
      ok: false,
      check: 'manifest-wrong-name',
      message: `manifest.json "name" must be "submittedWork" or absent — got ${JSON.stringify(manifest.name)}.`,
    };
  }

  const primaryFilename = manifest && manifest.primary && manifest.primary.filename;
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

  let primaryContent;
  try {
    primaryContent = JSON.parse(primaryEntry.getData().toString('utf8'));
  } catch (e) {
    return {
      ok: false,
      check: 'primary-not-json',
      message: `Primary file "${primaryFilename}" is not valid JSON — arbiters JSON-parse it directly.`,
    };
  }

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
 * (network/availability — not the hunter's fault) from a genuine shape
 * failure via the `gatewayFailure` flag on the thrown/returned error.
 * @param {string} cid
 * @returns {Promise<{ ok: true } | { ok: false, check: string, message: string, gatewayFailure?: true }>}
 */
async function fetchAndValidateArchiveShape(cid) {
  let buffer;
  try {
    buffer = await fetchArchiveBuffer(cid);
  } catch (e) {
    return {
      ok: false,
      check: 'gateway-unreachable',
      message: e.message,
      gatewayFailure: true,
    };
  }
  return validateArchiveShape(buffer);
}

module.exports = {
  validateArchiveShape,
  fetchArchiveBuffer,
  fetchAndValidateArchiveShape,
  CONFORMING_SHAPE_EXAMPLE,
};
