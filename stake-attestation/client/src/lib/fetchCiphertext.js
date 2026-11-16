// The disclosed ciphertext, from the site's IPFS gateways (VITE_IPFS_GATEWAY, src/config.js): GET <gateway>/ipfs/<cid>.
// The request carries the CID only. The CID is checked against the contract's own rule first, once, before any gateway
// is asked, and each gateway's body is read up to the same cap, so a hostile gateway cannot make the page hold more
// than that.
//
// The gateways are asked one at a time, in the configured order, and the next one only when a gateway fails to
// deliver: a network error (a body cut off included), an answer that is not 2xx, or no whole body within the timeout.
// A body that arrives is returned as it is, whatever its bytes. Whether it is the committed ciphertext is
// checkDisclosure's to judge, against the chain's ciphertextSha256 (lib/check.js): the list adds no trust, and a
// gateway's wrong bytes are reported as they are, never swapped for another gateway's. A body over the cap ends the
// fetch too: every honest gateway serves a CID's bytes alike, so their size is not one gateway's failure. When every
// gateway fails, the error is the last one's, a reason in the check page's words (STRINGS.check.reasons; a timeout is
// `network`, the gateway could not be reached).
//
// The wait is bounded. Each gateway has GATEWAY_TIMEOUT_MS (60 s) from its request to the body's last byte, and its
// request is aborted then, whether or not the fetch honours the abort. So the whole fetch takes at most
// GATEWAY_TIMEOUT_MS times the number of gateways (two in deploy/client.env: 2 minutes), and one gateway waits as long
// as it always did.
export const MAX_CIPHERTEXT_BYTES = 64 * 1024 * 1024;
export const GATEWAY_TIMEOUT_MS = 60_000;
const CID = /^[0-9A-Za-z]{46,100}$/; // StakeAttestation._isValidCid

function fail(key, vars = {}) {
  return Object.assign(new Error(`ciphertext unavailable: ${key}`), { reason: { key, vars } });
}

// the failures after which the next gateway is asked: the gateway's, not the content's
const MOVES_ON = new Set(['network', 'http']);

/** `promise`, or a rejection as soon as `signal` aborts: the timeout holds even for a fetch that ignores its signal. */
function beforeAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('timed out'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    const done = () => signal.removeEventListener('abort', onAbort);
    promise.then((v) => { done(); resolve(v); }, (e) => { done(); reject(e); });
    return undefined;
  });
}

async function fetchFrom(gateway, cid, { maxBytes, fetchImpl, timeoutMs }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let reader = null;
  try {
    let res;
    try {
      res = await beforeAbort(
        Promise.resolve().then(() => fetchImpl(`${gateway}/ipfs/${cid}`, { signal: ctl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })),
        ctl.signal,
      );
    } catch {
      throw fail('network');
    }
    if (!res.ok) throw fail('http', { status: res.status });
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) throw fail('tooLarge', { max: maxBytes });
    if (!res.body) {
      let whole;
      try {
        whole = new Uint8Array(await beforeAbort(res.arrayBuffer(), ctl.signal));
      } catch {
        throw fail('network');
      }
      if (whole.byteLength > maxBytes) throw fail('tooLarge', { max: maxBytes });
      return whole;
    }
    reader = res.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      let chunk;
      try {
        chunk = await beforeAbort(reader.read(), ctl.signal);
      } catch {
        throw fail('network');
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw fail('tooLarge', { max: maxBytes });
      parts.push(chunk.value);
    }
    reader = null;
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  } catch (err) {
    // nothing of a gateway given up on stays open
    ctl.abort();
    reader?.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string|readonly string[]} gateways - one gateway or several, in order, e.g. https://gateway.example (no
 *        trailing slash)
 * @param {string} cid
 * @param {{ maxBytes?: number, fetchImpl?: typeof fetch, timeoutMs?: number }} [o] - timeoutMs: each gateway's
 * @returns {Promise<Uint8Array>} the first body a gateway delivers; otherwise it throws the last gateway's failure,
 *          an Error with `reason` ({ key, vars }, STRINGS.check.reasons)
 */
export async function fetchCiphertext(gateways, cid, { maxBytes = MAX_CIPHERTEXT_BYTES, fetchImpl = fetch, timeoutMs = GATEWAY_TIMEOUT_MS } = {}) {
  const list = typeof gateways === 'string' ? [gateways] : [...gateways];
  if (!list.length) throw new TypeError('fetchCiphertext: no gateway');
  if (!CID.test(cid)) throw fail('cid');
  let last;
  for (const gateway of list) {
    try {
      return await fetchFrom(gateway, cid, { maxBytes, fetchImpl, timeoutMs });
    } catch (err) {
      if (!MOVES_ON.has(err.reason?.key)) throw err;
      last = err;
    }
  }
  throw last;
}
