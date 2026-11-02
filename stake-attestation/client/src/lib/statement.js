// The maker's dispute statement (design §13.2, erratum E2): UTF-8 text of at most
// MAX_DISPUTE_STATEMENT_BYTES (common's 4,096), pinned to IPFS by the site's server, because the
// browser holds no pinning credentials. dispute() stores only its CID; the contract writes it
// into the request's second addendum line, "verdikta-dispute: <cid>", and the arbiters fetch it.
//
// The page checks the text before the wallet is asked anything, and checks the CID the server
// answers before anything is paid: it must be the raw sha2-256 CID of the bytes sent (CIDv1,
// codec raw, bafkrei...). A statement of at most 4,096 bytes is one block, which every pinning
// backend the server uses answers in that form (it asks for CIDv1 with raw leaves); any other
// CID cannot be checked against the bytes here, so it is refused.
import { getBytes, sha256 } from 'ethers';

export const MAX_STATEMENT_BYTES = 4096;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const RAW_CID = /^bafkrei[a-z2-7]{52}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * @returns {{ ok: true, bytes: Uint8Array, length: number } | { ok: false, error: 'empty'|'tooLong'|'malformed', bytes: Uint8Array|null, length: number }}
 */
export function checkStatement(text) {
  const s = String(text);
  if (LONE_SURROGATE.test(s)) return { ok: false, error: 'malformed', bytes: null, length: 0 };
  const bytes = new TextEncoder().encode(s);
  if (!s.trim()) return { ok: false, error: 'empty', bytes, length: bytes.length };
  if (bytes.length > MAX_STATEMENT_BYTES) return { ok: false, error: 'tooLong', bytes, length: bytes.length };
  return { ok: true, bytes, length: bytes.length };
}

/** 0x and the 64 hex digits of SHA-256(bytes). */
export const statementSha256 = (bytes) => sha256(bytes);

function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** CIDv1, codec raw, multihash sha2-256, base32 with its "b" prefix: the CID of one raw block. */
export function rawCid(bytes) {
  const prefixed = new Uint8Array(36);
  prefixed.set([0x01, 0x55, 0x12, 0x20]);
  prefixed.set(getBytes(sha256(bytes)), 4);
  return `b${base32(prefixed)}`;
}

/** Whether the server's CID is the raw CID of these bytes (see above). */
export function cidMatches(cid, bytes) {
  return typeof cid === 'string' && RAW_CID.test(cid) && cid === rawCid(bytes);
}
