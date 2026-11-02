// The maker's dispute statement (design §13.2, erratum E2): UTF-8 text of at most
// MAX_DISPUTE_STATEMENT_BYTES (common's 4,096), pinned to IPFS by the site's server, because the
// browser holds no pinning credentials. dispute() stores only its CID; the contract writes it
// into the request's second addendum line, "verdikta-dispute: <cid>", and the arbiters fetch it.
//
// The page checks the text before the wallet is asked anything, and checks the CID the server
// answers: in the raw sha2-256 form (bafkrei..., what one block of bytes gets, and what the
// server's pinning asks for) it must be the CID of the bytes sent. Another form cannot be checked
// in the browser and is taken as the server gives it, if the contract can store it.
import { getBytes, sha256 } from 'ethers';

export const MAX_STATEMENT_BYTES = 4096;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// StakeAttestation._isValidCid
const STORABLE_CID = /^[0-9A-Za-z]{46,100}$/;
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

/** Whether the server's CID can name these bytes on-chain (see above). */
export function cidMatches(cid, bytes) {
  if (typeof cid !== 'string' || !STORABLE_CID.test(cid)) return false;
  if (cid.startsWith('bafkrei')) return RAW_CID.test(cid) && cid === rawCid(bytes);
  return true;
}
