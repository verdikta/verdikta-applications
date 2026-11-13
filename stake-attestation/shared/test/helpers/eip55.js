// EIP-55 checksums for this package's tests. The package has no dependency, so the address rule that needs ethers'
// getAddress takes this one here: Keccak-256 (the original padding, 0x01, as Ethereum hashes) over the address's
// lowercase hex, each letter uppercased where its hash nibble is 8 or more. test/repo/controlFile.test.js holds it to
// published vectors before it relies on it.
const MASK = (1n << 64n) - 1n;
const RATE = 136;
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

/** Keccak-f[1600] on 25 lanes, lane (x, y) at x + 5y. */
function permute(s) {
  let r = 1;
  for (let round = 0; round < 24; round += 1) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    let x = 1;
    let y = 0;
    let current = s[1];
    for (let t = 0; t < 24; t += 1) {
      [x, y] = [y, (2 * x + 3 * y) % 5];
      const next = s[x + 5 * y];
      s[x + 5 * y] = rotl(current, (((t + 1) * (t + 2)) / 2) % 64);
      current = next;
    }
    for (let row = 0; row < 25; row += 5) {
      const lanes = s.slice(row, row + 5);
      for (let i = 0; i < 5; i += 1) s[row + i] = lanes[i] ^ (~lanes[(i + 1) % 5] & MASK & lanes[(i + 2) % 5]);
    }
    for (let j = 0; j < 7; j += 1) {
      r = ((r << 1) ^ ((r >> 7) * 0x71)) % 256;
      if (r & 2) s[0] ^= 1n << BigInt((1 << j) - 1);
    }
  }
}

/** @param {Uint8Array|Buffer} bytes @returns {string} 64 lowercase hex digits */
export function keccak256Hex(bytes) {
  const padded = Buffer.alloc((Math.floor(bytes.length / RATE) + 1) * RATE);
  Buffer.from(bytes).copy(padded);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i += 1) s[i] ^= padded.readBigUInt64LE(off + 8 * i);
    permute(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i += 1) out.writeBigUInt64LE(s[i], 8 * i);
  return out.toString('hex');
}

/** The EIP-55 spelling of a 0x address of 40 hex digits, in any case. @returns {string} */
export function toChecksumAddress(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new TypeError('not a 20-byte 0x address');
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256Hex(Buffer.from(lower, 'ascii'));
  return `0x${[...lower].map((ch, i) => (Number.parseInt(hash[i], 16) >= 8 ? ch.toUpperCase() : ch)).join('')}`;
}
