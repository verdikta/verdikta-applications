/**
 * Bounded reads of untrusted archives and HTTP bodies.
 *
 * Every evaluation package (evaluationCid) and hunter archive (hunterCid) is chosen by
 * whoever calls createBounty / prepareSubmission on chain, and the server reads them on
 * its own (the sync's metadata heal) and for any API client. adm-zip's getData() first
 * allocates the entry's DECLARED size (Buffer.alloc(header.size)) and then inflates it:
 * a 1 MB zip whose manifest.json inflates to 1 GiB got this process OOM-killed. Read
 * entries through readEntry() instead: the declared size is checked, and the inflation
 * itself is capped (zlib maxOutputLength) whatever the headers claim.
 */
const zlib = require('zlib');

const DEFAULT_ENTRY_MAX_BYTES = Number(process.env.ZIP_ENTRY_MAX_BYTES) || 20 * 1024 * 1024;
const DEFAULT_BODY_MAX_BYTES = Number(process.env.IPFS_FETCH_MAX_BYTES) || 50 * 1024 * 1024;

class TooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TooLargeError';
    this.code = 'TOO_LARGE';
  }
}

/** The entry's bytes, at most maxBytes of them; throws TooLargeError past that. */
function readEntry(entry, maxBytes = DEFAULT_ENTRY_MAX_BYTES) {
  if (!entry || entry.isDirectory) return Buffer.alloc(0);
  const h = entry.header || {};
  if (h.encrypted) throw new Error(`zip entry ${entry.entryName} is encrypted`);
  if (Number(h.size) > maxBytes) {
    throw new TooLargeError(`zip entry ${entry.entryName} declares ${h.size} bytes (limit ${maxBytes})`);
  }
  const raw = entry.getCompressedData();
  if (h.method === 0) {
    if (raw.length > maxBytes) throw new TooLargeError(`zip entry ${entry.entryName} is over ${maxBytes} bytes`);
    return raw;
  }
  if (h.method === 8) {
    if (!raw.length) return Buffer.alloc(0);
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch (e) {
      if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) {
        throw new TooLargeError(`zip entry ${entry.entryName} inflates past ${maxBytes} bytes`);
      }
      throw e;
    }
  }
  throw new Error(`zip entry ${entry.entryName} uses unsupported compression method ${h.method}`);
}

/** readEntry() as UTF-8 text. */
function readEntryText(entry, maxBytes = DEFAULT_ENTRY_MAX_BYTES) {
  return readEntry(entry, maxBytes).toString('utf8');
}

/**
 * A fetch Response body as a Buffer, refusing more than maxBytes (Content-Length first,
 * then while streaming), so a huge CID cannot fill the heap.
 */
async function readBodyCapped(response, maxBytes = DEFAULT_BODY_MAX_BYTES) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* ignore */ }
    throw new TooLargeError(`response declares ${declared} bytes (limit ${maxBytes})`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw new TooLargeError(`response exceeds ${maxBytes} bytes`);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new TooLargeError(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

module.exports = {
  readEntry,
  readEntryText,
  readBodyCapped,
  TooLargeError,
  DEFAULT_ENTRY_MAX_BYTES,
  DEFAULT_BODY_MAX_BYTES,
};
