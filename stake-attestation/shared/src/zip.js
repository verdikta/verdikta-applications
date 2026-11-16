// A ZIP writer whose bytes are a function of its input only: entries in the order given, stored
// (no compression, so no dependence on the zlib build), a fixed timestamp (1980-01-01 00:00, the
// format's epoch), UTF-8 names, regular files with mode 0644. The same listing therefore always
// pins to the same CID, and anyone can rebuild the archive from its members and compare.
// Archives here are a few JSON files: well under the 4 GiB a plain (non-ZIP64) entry holds.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UTF8_NAMES = 0x0800;
const VERSION = 20; // 2.0: stored entries, directories not used
const MADE_BY_UNIX = (3 << 8) | VERSION;
const FILE_MODE = (0o100644 << 16) >>> 0;
const MAX_ENTRY = 0xfffffffe;

/**
 * @param {{ name: string, bytes: Buffer }[]} entries - plain file names, distinct
 * @returns {Buffer}
 */
export function zipStored(entries) {
  const names = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    if (typeof name !== 'string' || !/^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/.test(name) || names.has(name)) {
      throw new TypeError(`zip: ${JSON.stringify(name)} is not a distinct plain file name`);
    }
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ENTRY) throw new TypeError(`zip: ${name} must be a Buffer under 4 GiB`);
    names.add(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(FILE_MODE, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}
