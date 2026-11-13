// The project's proof for this repository's own listings (node P25; docs/control-proof.md): the testnet launch's
// seeded listings are of this repository, so its root holds .verdikta/stake-control.json naming the testnet maker.
// A listing of it counts only at a commit that holds the file, so the file parses with the shared parser, names one
// address written in its EIP-55 form, and is the only file under .verdikta/. A new maker changes the file and
// TESTNET_MAKER in one commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CONTROL_FILE, createControlProof } from '../../src/controlProof.js';
import { keccak256Hex, toChecksumAddress } from '../helpers/eip55.js';
import { REPO_ROOT } from './helpers.js';

const TESTNET_MAKER = '0xC8658795Faa64Ac57230c07F15055f33bD06aBDB';
const FILE = path.join(REPO_ROOT, CONTROL_FILE);
// the builder's cap on the proof's blob (builder/src/controlCheck.js)
const CONTROL_FILE_MAX_BYTES = 4096;

// parseControlFile reads getAddress alone; nothing else createControlProof takes is called here
const unused = () => { throw new Error('not used by parseControlFile'); };
const { parseControlFile } = createControlProof({
  AbiCoder: { defaultAbiCoder: () => ({ encode: unused }) },
  Interface: class { encodeFunctionData() { return '0x'; } },
  getAddress: toChecksumAddress,
  hashMessage: unused,
  keccak256: unused,
  verifyMessage: unused,
});

test('the checksum this test reads by is EIP-55\'s: Keccak-256\'s vectors and EIP-55\'s own examples', () => {
  assert.equal(keccak256Hex(Buffer.alloc(0)), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256Hex(Buffer.from('abc')), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  for (const a of [
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
    '0xde709f2102306220921060314715629080e2fb77',
    '0x27b1fdb04752bbc536007a920d24acb045561c26',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]) assert.equal(toChecksumAddress(a.toLowerCase()), a);
  // and the parser refuses with it what it refuses with ethers': a failed checksum names nobody
  assert.equal(parseControlFile(JSON.stringify({ version: 1, maker: '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed' })).problem, 'ADDRESS_FORM');
});

test(`${CONTROL_FILE} at the repository's root parses with the shared parser and names the testnet maker`, () => {
  assert.ok(fs.existsSync(FILE), `${CONTROL_FILE} is missing at the repository's root`);
  const text = fs.readFileSync(FILE, 'utf8');
  const parsed = parseControlFile(text);
  assert.deepEqual(parsed, { maker: TESTNET_MAKER, problem: null });
});

test('the file writes its address in EIP-55 form, character for character, and holds nothing but the documented keys', () => {
  const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.deepEqual(Object.keys(doc).sort(), ['maker', 'version']);
  assert.equal(doc.version, 1);
  assert.equal(doc.maker, toChecksumAddress(doc.maker), 'the maker is written checksummed, not in another case');
  assert.equal(doc.maker, TESTNET_MAKER);
});

test('the file is what the builder reads: a regular file, UTF-8 with no byte-order mark, under its byte cap', () => {
  const stat = fs.lstatSync(FILE);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'a regular file, not a link');
  const bytes = fs.readFileSync(FILE);
  assert.ok(bytes.length <= CONTROL_FILE_MAX_BYTES, `${bytes.length} bytes`);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'no byte-order mark');
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes.toString('utf8'));
});

test('nothing else is under .verdikta/', () => {
  const dir = path.join(REPO_ROOT, path.dirname(CONTROL_FILE));
  assert.deepEqual(fs.readdirSync(dir), [path.basename(CONTROL_FILE)]);
});
