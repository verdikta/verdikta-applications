#!/usr/bin/env node
/**
 * Builds, checks and pins the example frontend's default query package.
 *
 * The package source lives in example-frontend/default-query-package/. An IPFS
 * archive is immutable, so a change to that source (for example to the jury in
 * manifest.json) needs a new archive, a new pin and a new CID in the client:
 * DEFAULT_QUERY_CID in client/src/pages/RunQuery.js.
 *
 *   node scripts/default-query-package.js check          # jury is in the class pool
 *   node scripts/default-query-package.js build [out]    # write the archive, print its CID
 *   node scripts/default-query-package.js pin            # build, pin, print the pinned CID
 *
 * `pin` uses the same service and credential as the server's /api/upload:
 * IPFS_PINNING_SERVICE and IPFS_PINNING_KEY, read from the environment or from
 * server/.env. The key is never printed.
 *
 * The archive is built byte for byte the same on every machine (fixed file
 * order, fixed timestamps, no compression), so the CID `build` prints is the
 * CID `pin` must return for a single-block file pinned with the service's
 * default settings (CIDv0). `pin` fails if the two differ.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE_DIR = path.join(__dirname, '..', '..', 'default-query-package');
// The class the example frontend selects by default.
const DEFAULT_CLASS_ID = 128;
// A file up to this size is stored as one IPFS block, whose CID is computed below.
const SINGLE_BLOCK_LIMIT = 262144;

/** The files of the archive, in archive order: the manifest and every file it names. */
function listPackageFiles(sourceDir = SOURCE_DIR) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
  const names = [
    'manifest.json',
    manifest.primary.filename,
    ...(manifest.additional || []).map((entry) => entry.filename).filter(Boolean),
  ];
  for (const name of names) {
    if (path.basename(name) !== name) {
      throw new Error(`Package file names must be plain file names, got: ${name}`);
    }
  }
  return [...new Set(names)].map((name) => ({
    name,
    data: fs.readFileSync(path.join(sourceDir, name)),
  }));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP archive of the given files: stored (no compression), dated 1980-01-01. */
function buildZip(files) {
  const DOS_TIME = 0;
  const DOS_DATE = 0x21; // 1980-01-01
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function varint(value) {
  const bytes = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(buffer) {
  let value = BigInt(`0x${buffer.toString('hex') || '0'}`);
  let text = '';
  while (value > 0n) {
    text = BASE58[Number(value % 58n)] + text;
    value /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}

/** The CIDv0 an IPFS node gives a file stored as a single UnixFS block. */
function cidV0ForSingleBlock(data) {
  if (data.length > SINGLE_BLOCK_LIMIT) {
    throw new Error(`File is ${data.length} bytes; only files up to ${SINGLE_BLOCK_LIMIT} bytes are one block`);
  }
  const length = varint(data.length);
  const unixfs = Buffer.concat([
    Buffer.from([0x08, 0x02]), // Type = File
    ...(data.length > 0 ? [Buffer.from([0x12]), length, data] : []), // Data
    Buffer.from([0x18]), length, // filesize
  ]);
  const node = Buffer.concat([Buffer.from([0x0a]), varint(unixfs.length), unixfs]);
  const digest = crypto.createHash('sha256').update(node).digest();
  return base58(Buffer.concat([Buffer.from([0x12, 0x20]), digest]));
}

/** Jurors of the manifest that the class does not list, as "provider/model" strings. */
function jurorsOutsideClass(manifest, classInfo) {
  const listed = new Set(
    (classInfo?.models || []).map((m) => `${m.provider.toLowerCase()}/${m.model}`)
  );
  return manifest.juryParameters.AI_NODES
    .map((node) => `${String(node.AI_PROVIDER).toLowerCase()}/${node.AI_MODEL}`)
    .filter((juror) => !listed.has(juror));
}

function checkJury(sourceDir = SOURCE_DIR, classId = DEFAULT_CLASS_ID) {
  const { classMap } = require('@verdikta/common');
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
  const classInfo = classMap.getClass(classId);
  if (!classInfo || classInfo.status !== 'ACTIVE') {
    throw new Error(`Class ${classId} is not an active class in @verdikta/common's class map`);
  }
  const unlisted = jurorsOutsideClass(manifest, classInfo);
  if (unlisted.length > 0) {
    throw new Error(`Class ${classId} does not list: ${unlisted.join(', ')}`);
  }
  return manifest.juryParameters.AI_NODES;
}

function buildArchive(sourceDir = SOURCE_DIR) {
  const archive = buildZip(listPackageFiles(sourceDir));
  return { archive, cid: cidV0ForSingleBlock(archive) };
}

async function main() {
  const [command, outputArg] = process.argv.slice(2);

  if (command === 'check') {
    const jury = checkJury();
    console.log(`Jury is in class ${DEFAULT_CLASS_ID}: ${jury.map((n) => `${n.AI_PROVIDER}/${n.AI_MODEL}`).join(', ')}`);
    return;
  }

  if (command === 'build') {
    checkJury();
    const { archive, cid } = buildArchive();
    const output = path.resolve(outputArg || 'default-query-package.zip');
    fs.writeFileSync(output, archive);
    console.log(`Wrote ${output} (${archive.length} bytes)`);
    console.log(`Expected CID once pinned: ${cid}`);
    return;
  }

  if (command === 'pin') {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    if (!process.env.IPFS_PINNING_KEY) {
      throw new Error('IPFS_PINNING_KEY is not set (environment or server/.env)');
    }
    checkJury();
    const { archive, cid: expectedCid } = buildArchive();
    const { IPFSClient } = require('@verdikta/common');
    const ipfsClient = new IPFSClient({
      gateway: process.env.IPFS_GATEWAY || 'https://ipfs.io',
      pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
      pinningKey: process.env.IPFS_PINNING_KEY,
      timeout: 30000,
      retryOptions: { retries: 3, factor: 2, minTimeout: 1000, maxTimeout: 15000, randomize: true },
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'default-query-package-'));
    const file = path.join(directory, 'default-query-package.zip');
    try {
      fs.writeFileSync(file, archive);
      const pinnedCid = await ipfsClient.uploadToIPFS(file);
      console.log(`Pinned CID: ${pinnedCid}`);
      if (pinnedCid !== expectedCid) {
        throw new Error(`Pinned CID differs from the expected CID ${expectedCid}; use neither until this is understood`);
      }
      console.log('Set DEFAULT_QUERY_CID in client/src/pages/RunQuery.js to this CID.');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    return;
  }

  console.error('Usage: node scripts/default-query-package.js <check | build [output.zip] | pin>');
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  SOURCE_DIR,
  DEFAULT_CLASS_ID,
  listPackageFiles,
  buildZip,
  cidV0ForSingleBlock,
  jurorsOutsideClass,
  checkJury,
  buildArchive,
};
