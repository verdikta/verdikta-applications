// Reading named members of a ZIP from its central directory, without extracting the archive. A
// listing archive is the maker's, and a small download can expand to gigabytes (a "zip bomb"), so
// only the members asked for are read, each held to a byte cap twice: its declared size before
// anything is inflated, and the inflated output itself (zlib's maxOutputLength). Stored (0) and
// deflated (8) members only; ZIP64, encrypted members and duplicate names are refused, and every
// member read must match its declared size and CRC-32.
import zlib from 'node:zlib';

import { crc32 } from './zip.js';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'ZipError';
    this.code = code;
  }
}

const invalid = (detail) => new ZipError('ZIP_INVALID', detail);

/**
 * The archive's members by name, from its central directory.
 * @param {Buffer} bytes
 * @returns {Map<string, { name: string, method: number, crc: number, compressedSize: number, size: number, localOffset: number }>}
 */
export function zipDirectory(bytes, { maxEntries = 1024 } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) throw invalid('too short to be a ZIP');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - MAX_COMMENT); i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw invalid('no end of central directory');
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw invalid('ZIP64 archives are not read');
  if (count > maxEntries) throw new ZipError('ZIP_TOO_LARGE', `more than ${maxEntries} members`);
  if (offset + size > end) throw invalid('the central directory runs past its end');
  const entries = new Map();
  let p = offset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > offset + size || bytes.readUInt32LE(p) !== CENTRAL) throw invalid('a central directory entry is malformed');
    const flags = bytes.readUInt16LE(p + 8);
    const method = bytes.readUInt16LE(p + 10);
    const crc = bytes.readUInt32LE(p + 16);
    const compressedSize = bytes.readUInt32LE(p + 20);
    const memberSize = bytes.readUInt32LE(p + 24);
    const nameLength = bytes.readUInt16LE(p + 28);
    const extraLength = bytes.readUInt16LE(p + 30);
    const commentLength = bytes.readUInt16LE(p + 32);
    const localOffset = bytes.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || memberSize === 0xffffffff || localOffset === 0xffffffff) throw invalid('ZIP64 members are not read');
    if (flags & 1) throw invalid('encrypted members are not read');
    if (p + 46 + nameLength > offset + size) throw invalid('a member name runs past the central directory');
    const name = bytes.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    if (entries.has(name)) throw invalid(`${name} appears twice`);
    entries.set(name, { name, method, crc, compressedSize, size: memberSize, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * One member's bytes, at most `maxBytes` of them.
 * @throws {ZipError} ZIP_TOO_LARGE past the cap, ZIP_INVALID otherwise
 */
export function readZipMember(bytes, entry, maxBytes) {
  if (entry.size > maxBytes) throw new ZipError('ZIP_TOO_LARGE', `${entry.name} is ${entry.size} bytes (at most ${maxBytes})`);
  const p = entry.localOffset;
  if (p + 30 > bytes.length || bytes.readUInt32LE(p) !== LOCAL) throw invalid(`${entry.name}'s local header is missing`);
  const start = p + 30 + bytes.readUInt16LE(p + 26) + bytes.readUInt16LE(p + 28);
  if (start + entry.compressedSize > bytes.length) throw invalid(`${entry.name} runs past the archive`);
  const data = bytes.subarray(start, start + entry.compressedSize);
  let out;
  if (entry.method === 0) {
    out = Buffer.from(data);
  } else if (entry.method === 8) {
    try {
      out = zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw new ZipError('ZIP_TOO_LARGE', `${entry.name} inflates past ${maxBytes} bytes`);
      throw invalid(`${entry.name} does not inflate`);
    }
  } else {
    throw invalid(`${entry.name} uses compression method ${entry.method}`);
  }
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw invalid(`${entry.name} does not match its size and CRC-32`);
  return out;
}
