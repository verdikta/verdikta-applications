// A ZIP writer for tests: deflated members (method 8), optionally under a folder, and optionally
// declaring a size other than the member's real one (what a zip bomb does to slip past a check
// of declared sizes). The server's own writer (src/zip.js) stores members.
import zlib from 'node:zlib';

import { crc32 } from '../../src/zip.js';

/**
 * @param {{ name: string, bytes: Buffer, declaredSize?: number }[]} entries
 * @param {{ descriptors?: boolean }} [o] - sizes and CRC after each member and only in the central
 *   directory, as a streaming writer leaves them (actions/upload-artifact's archives)
 */
export function zipDeflated(entries, { descriptors = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes, declaredSize } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = zlib.deflateRawSync(bytes);
    const size = declaredSize ?? bytes.length;
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(descriptors ? 0x0808 : 0x0800, 6);
    local.writeUInt16LE(8, 8);
    if (!descriptors) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    let trailer = 0;
    if (descriptors) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(data.length, 8);
      d.writeUInt32LE(size, 12);
      locals.push(d);
      trailer = d.length;
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(descriptors ? 0x0808 : 0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length + trailer;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
