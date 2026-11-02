// The disclosed ciphertext, from the site's IPFS gateway: GET <gateway>/ipfs/<cid>. The request
// carries the CID only. The CID is checked against the contract's own rule first, and the body is
// read up to a cap, so a hostile gateway cannot make the page hold more than that.
export const MAX_CIPHERTEXT_BYTES = 64 * 1024 * 1024;
const CID = /^[0-9A-Za-z]{46,100}$/; // StakeAttestation._isValidCid
const TIMEOUT_MS = 60_000;

function fail(key, vars = {}) {
  return Object.assign(new Error(`ciphertext unavailable: ${key}`), { reason: { key, vars } });
}

/**
 * @param {string} gateway - e.g. https://gateway.example (no trailing slash)
 * @param {string} cid
 * @returns {Promise<Uint8Array>}
 */
export async function fetchCiphertext(gateway, cid, { maxBytes = MAX_CIPHERTEXT_BYTES, fetchImpl = fetch } = {}) {
  if (!CID.test(cid)) throw fail('cid');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetchImpl(`${gateway}/ipfs/${cid}`, { signal: ctl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    } catch {
      throw fail('network');
    }
    if (!res.ok) throw fail('http', { status: res.status });
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) throw fail('tooLarge', { max: maxBytes });
    if (!res.body) {
      const whole = new Uint8Array(await res.arrayBuffer());
      if (whole.byteLength > maxBytes) throw fail('tooLarge', { max: maxBytes });
      return whole;
    }
    const reader = res.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        throw fail('network');
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw fail('tooLarge', { max: maxBytes });
      }
      parts.push(chunk.value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
