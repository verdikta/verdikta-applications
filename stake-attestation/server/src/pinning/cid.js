// The CID of bytes stored as one raw block: CIDv1, codec raw (0x55), multihash sha2-256, base32
// lowercase with the multibase prefix "b" (bafkrei...). It is what kubo's `add --cid-version 1
// --raw-leaves` answers for a file of one chunk, and the mock store's key.
import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
// kubo's default chunker (size-262144): a file up to one chunk is a single raw leaf.
export const SINGLE_BLOCK_MAX = 262144;

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

/** @param {Uint8Array} bytes */
export function rawCid(bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest();
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`;
}

/** A CIDv1 raw sha2-256 CID, the only form whose bytes a pin can be checked against here. */
export function isRawSha256Cid(cid) {
  return typeof cid === 'string' && /^bafkrei[a-z2-7]{52}$/.test(cid);
}
