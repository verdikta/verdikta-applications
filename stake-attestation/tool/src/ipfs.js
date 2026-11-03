// Pinning and reading back. A pin is not taken on the service's word. The CID of bytes stored as one raw block
// (CIDv1, raw, sha2-256: bafkrei...) names their hash, so it is recomputed here; and every CID, whatever its
// form, is read back through the gateway and hashed. A multi-block file's CID is a tree only the service's
// chunker decides, so for those the read-back is all there is, and the pair (pin service, gateway) is the
// hunter's own choice.
//
// A credential is read when a pin is made, and is never in a message. A service's answer is parsed, never quoted.
import crypto from 'node:crypto';

import { isCidShaped } from '@verdikta/stake-attestation-shared/execution-evidence';

import { fail } from './errors.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The CID of bytes stored as one raw block. */
export function rawCid(bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest();
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`;
}

export const isRawSha256Cid = (cid) => typeof cid === 'string' && /^bafkrei[a-z2-7]{52}$/.test(cid);

// StakeAttestation._isValidCid (46 to 100 letters and digits, shared/src/executionEvidence.js) and the runner's request rule, both.
const RUNNER_CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})$/;
export const isStorableCid = (cid) => isCidShaped(cid) && RUNNER_CID.test(cid);
export { isCidShaped };

export const sha256Hex0x = (bytes) => `0x${crypto.createHash('sha256').update(bytes).digest('hex')}`;

const PIN_TIMEOUT_MS = 120_000;
const DEFAULT_URLS = Object.freeze({ filebase: 'https://rpc.filebase.io', pinata: 'https://api.pinata.cloud' });

async function postFile({ fetchImpl, url, form, token, timeoutMs, backend }) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', body: form, headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw fail('PIN_FAILED', `${backend} could not be reached`);
  }
  // Read but never quoted: a service may echo the request's credential in an error.
  const text = await res.text().catch(() => '');
  if (!res.ok) throw fail('PIN_FAILED', `${backend} answered HTTP ${res.status}`);
  return text;
}

/**
 * @param {{ backend: 'kubo'|'filebase'|'pinata', url?: string, token?: string|null, timeoutMs?: number }} cfg
 * @param {{ fetch?: typeof fetch }} [o]
 * @returns {{ backend: string, pin(bytes: Buffer, o?: { name?: string }): Promise<string> }}
 */
export function createPinner(cfg, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const { backend, token = null, timeoutMs = PIN_TIMEOUT_MS } = cfg ?? {};
  if (!['kubo', 'filebase', 'pinata'].includes(backend)) throw fail('PIN_CONFIG', 'the backend is kubo, filebase or pinata');
  const base = cfg.url ?? DEFAULT_URLS[backend];
  if (!base) throw fail('PIN_CONFIG', `${backend} needs a URL`);
  const needsToken = backend !== 'kubo';
  const pinFor = (bytes, name) => {
    if (needsToken && !token) throw fail('PIN_CONFIG', `${backend} needs a token`);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
    return form;
  };
  if (backend === 'pinata') {
    return {
      backend,
      async pin(bytes, { name = 'claim.bin' } = {}) {
        const form = pinFor(bytes, name);
        form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
        form.append('pinataMetadata', JSON.stringify({ name }));
        const text = await postFile({ fetchImpl, url: new URL('/pinning/pinFileToIPFS', base), form, token, timeoutMs, backend });
        try {
          return JSON.parse(text)?.IpfsHash;
        } catch {
          throw fail('PIN_FAILED', 'pinata answered something other than JSON');
        }
      },
    };
  }
  const endpoint = new URL('/api/v0/add', base);
  for (const [k, v] of Object.entries({ pin: 'true', 'cid-version': '1', 'raw-leaves': 'true', hash: 'sha2-256', quieter: 'true' })) endpoint.searchParams.set(k, v);
  return {
    backend,
    async pin(bytes, { name = 'claim.bin' } = {}) {
      const form = pinFor(bytes, name);
      const text = await postFile({ fetchImpl, url: endpoint, form, token, timeoutMs, backend });
      try {
        return JSON.parse(text.trim().split('\n').filter(Boolean).pop())?.Hash;
      } catch {
        throw fail('PIN_FAILED', `${backend} answered something other than JSON`);
      }
    },
  };
}

/** GET <gateway>/ipfs/<cid>, held to a byte cap and a timeout. @returns {Promise<Buffer>} @throws {Error} with a `why` */
export async function gatewayGet(gateway, cid, { maxBytes, timeoutMs = 60_000, fetchImpl = globalThis.fetch } = {}) {
  if (!isCidShaped(cid)) throw Object.assign(new Error('not a CID'), { why: 'not-a-cid' });
  const url = `${String(gateway).replace(/\/+$/, '')}/ipfs/${cid}`;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { accept: 'application/octet-stream, */*' } });
  } catch {
    throw Object.assign(new Error('unreachable'), { why: 'unreachable' });
  }
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => {});
    throw Object.assign(new Error(`HTTP ${res.status}`), { why: 'unavailable' });
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel?.().catch(() => {});
    throw Object.assign(new Error('too large'), { why: 'too-large' });
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) throw Object.assign(new Error('too large'), { why: 'too-large' });
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    if (err?.why) throw err;
    throw Object.assign(new Error('cut off'), { why: 'unavailable' });
  }
  return Buffer.concat(chunks);
}
