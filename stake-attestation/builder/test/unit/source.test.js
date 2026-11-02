// Acceptance 2: for a contract listing, the deployed bytecode's verified source (explorer API from
// config) is compared with the repository at baseCommit and what it compiles to; any mismatch
// stops the listing. Explorer answers come only from recorded responses (test/fixtures/explorer:
// the Etherscan-v2 API's getsourcecode and eth_getCode shapes, recorded for the fixture contract
// test/fixtures/vault), never a live explorer; the compile is solc 0.8.31's recorded output for
// the verified input (test/fixtures/solc/vault-output.json). Nothing the listing chose (its
// compiler, its image's files) takes part: see source.docker.test.js for the adversarial case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createExplorer, parseSourceResult } from '../../src/explorer.js';
import { checkVerifiedSource, compareCompiled, compilerInput, normalizeRuntime } from '../../src/sourceCheck.js';
import { FIXTURES, readFixture, recordedExplorer } from '../helpers/fakes.js';
import { contractDraft } from '../helpers/specs.js';

const OUTPUT = readFixture('solc', 'vault-output.json');
const RUNTIME = OUTPUT.contracts['src/Vault.sol'].Vault.evm.deployedBytecode;
const VAULT_SOL = fs.readFileSync(path.join(FIXTURES, 'vault', 'src', 'Vault.sol'));
const KEY = 'TESTKEY-not-a-real-explorer-key';
const SOLC = { version: '0.8.31+commit.fd3a2265', sha256: 'acf358d82da7db033debb2f4db11e1c9cfcb02b0cb5b5ddbb9635ad817b41bdd' };

/** The listed commit's side, as a double: path -> { origin, bytes }. */
function reader(files = { 'src/Vault.sol': { origin: 'commit', bytes: VAULT_SOL } }) {
  const calls = [];
  const readFiles = async (req) => {
    calls.push(req);
    return new Map(req.paths.map((p) => [p, files[p] ?? { origin: 'missing', bytes: null }]));
  };
  return { readFiles, calls };
}

/** The trusted compiler, as a double answering with solc's recorded output. */
function compiler(output = OUTPUT) {
  const calls = [];
  return { compile: async (req) => { calls.push(req); return { output, solc: SOLC }; }, calls };
}

async function check(routes, { apiKey = KEY, read = reader(), comp = compiler() } = {}) {
  const rec = recordedExplorer(routes);
  const explorer = createExplorer({ apiUrl: rec.apiUrl, apiKey, chainId: 8453, fetch: rec.fetch, timeoutMs: 5000 });
  const result = await checkVerifiedSource({ spec: contractDraft(), explorer, readFiles: read.readFiles, compile: comp.compile });
  return { result, rec, read, comp };
}

const MATCH = { getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault.json' };
const codes = (r) => r.issues.map((i) => i.code);

test('the verified files are the listed commit\'s and, compiled as verified, give the deployed code: the listing goes on', async () => {
  const { result, read, comp, rec } = await check(MATCH);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.summary.contract, { path: 'src/Vault.sol', name: 'Vault' });
  assert.equal(result.summary.filesCompared, 1);
  assert.equal(result.summary.bytecode, 'match');
  assert.equal(result.summary.metadata, 'match');
  assert.deepEqual(result.summary.solc, SOLC);
  assert.deepEqual(read.calls.map((c) => c.paths), [['src/Vault.sol']]);
  // The compiler is the release the explorer names, on the explorer's own input.
  assert.equal(comp.calls[0].version, '0.8.31+commit.fd3a2265');
  assert.equal(comp.calls[0].input.sources['src/Vault.sol'].content, VAULT_SOL.toString());
  for (const u of rec.seen) {
    assert.equal(u.searchParams.get('chainid'), '8453');
    assert.equal(u.searchParams.get('address'), contractDraft().artifact.address);
  }
});

test('the compile input is the verified one: its sources, settings and libraries, asking only for the runtime code', () => {
  const source = parseSourceResult(readFixture('explorer', 'getsourcecode-vault.json'));
  const input = compilerInput({ ...source, settings: { ...source.settings, libraries: { 'src/L.sol': { L: '0x0000000000000000000000000000000000000001' } } } });
  assert.equal(input.language, 'Solidity');
  assert.deepEqual(input.settings.optimizer, { enabled: true, runs: 200 });
  assert.equal(input.settings.evmVersion, 'cancun');
  assert.deepEqual(input.settings.libraries, { 'src/L.sol': { L: '0x0000000000000000000000000000000000000001' } });
  assert.deepEqual(input.settings.outputSelection, { '*': { '*': ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'evm.deployedBytecode.linkReferences', 'metadata'] } });
  const off = compilerInput(parseSourceResult(readFixture('explorer', 'getsourcecode-vault-no-optimizer.json')));
  assert.deepEqual(off.settings.optimizer, { enabled: false, runs: 200 });
});

test('immutables and solc\'s metadata trailer are masked; every other byte of the runtime must match', () => {
  const deployed = readFixture('explorer', 'getcode-vault.json').result;
  assert.notEqual(deployed.replace(/^0x/, ''), RUNTIME.object, 'the deployed code carries the immutable owner');
  const a = normalizeRuntime(deployed, RUNTIME);
  const b = normalizeRuntime(RUNTIME.object, RUNTIME);
  assert.ok(a.code.equals(b.code));
  assert.equal(a.metadata.toString('hex'), b.metadata.toString('hex'));
  const other = normalizeRuntime(readFixture('explorer', 'getcode-vault-other.json').result, RUNTIME);
  assert.ok(!other.code.equals(b.code));
  // Without solc's CBOR trailer nothing is split off: every byte is compared.
  const bare = normalizeRuntime('0x6080604052a10002', {});
  assert.equal(bare.metadata.length, 0);
  assert.equal(bare.code.toString('hex'), '6080604052a10002');
});

test('a verified source that differs from the listed commit stops the listing, before anything is compiled', async () => {
  const { result, comp } = await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-edited.json' });
  assert.deepEqual(codes(result), ['SOURCE_FILE_MISMATCH']);
  assert.equal(result.issues[0].path, 'src/Vault.sol');
  assert.equal(comp.calls.length, 0);
});

test('a file missing from the commit and its dependencies, or a symbolic link there, stops the listing', async () => {
  assert.deepEqual(codes((await check(MATCH, { read: reader({}) })).result), ['SOURCE_FILE_MISSING']);
  const link = reader({ 'src/Vault.sol': { origin: 'symlink', bytes: null, detail: 'src/Vault.sol is a symbolic link in the listed commit' } });
  assert.deepEqual(codes((await check(MATCH, { read: link })).result), ['SOURCE_FILE_MISMATCH']);
  // An installed dependency (untracked in the commit) is compared as the image holds it.
  const dep = reader({ 'src/Vault.sol': { origin: 'untracked', bytes: VAULT_SOL } });
  assert.equal((await check(MATCH, { read: dep })).result.ok, true);
});

test('deployed bytecode the verified compile does not reproduce stops the listing', async () => {
  const { result } = await check({ ...MATCH, getcode: 'getcode-vault-other.json' });
  assert.deepEqual(codes(result), ['BYTECODE_MISMATCH']);
});

test('an external library the verified source does not link is refused: its address could not be checked', async () => {
  const linked = JSON.parse(JSON.stringify(OUTPUT));
  linked.contracts['src/Vault.sol'].Vault.evm.deployedBytecode.linkReferences = { 'src/Lib.sol': { Lib: [{ start: 10, length: 20 }] } };
  const { result } = await check(MATCH, { comp: compiler(linked) });
  assert.deepEqual(codes(result), ['SOURCE_LIBRARIES_UNSUPPORTED']);
});

test('a verified input that does not compile, or names no single such contract, stops the listing', async () => {
  const failing = { errors: [{ severity: 'error', formattedMessage: 'ParserError: Expected ";"' }], contracts: {} };
  assert.deepEqual(codes((await check(MATCH, { comp: compiler(failing) })).result), ['SOURCE_COMPILE_FAILED']);
  assert.deepEqual(codes((await check(MATCH, { comp: compiler({ contracts: {} }) })).result), ['SOURCE_CONTRACT_NOT_FOUND']);
  const source = parseSourceResult(readFixture('explorer', 'getsourcecode-vault.json'));
  const two = { contracts: { 'a/Vault.sol': OUTPUT.contracts['src/Vault.sol'], 'b/Vault.sol': OUTPUT.contracts['src/Vault.sol'] } };
  const deployedCode = readFixture('explorer', 'getcode-vault.json').result;
  assert.equal(compareCompiled({ source: { ...source, contractFile: null }, output: two, deployedCode }).issues[0].code, 'SOURCE_CONTRACT_AMBIGUOUS');
});

test('no code at the address, an unverified contract, a proxy or a flattened source stop the listing', async () => {
  assert.deepEqual(codes((await check({ ...MATCH, getcode: 'getcode-empty.json' })).result), ['SOURCE_NO_CODE']);
  assert.deepEqual(codes((await check({ ...MATCH, getsourcecode: 'getsourcecode-unverified.json' })).result), ['SOURCE_NOT_VERIFIED']);
  assert.deepEqual(codes((await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-proxy.json' })).result), ['SOURCE_PROXY_UNSUPPORTED']);
  assert.deepEqual(codes((await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-flattened.json' })).result), ['SOURCE_FLATTENED_UNSUPPORTED']);
});

test('the compiler is the one the explorer names, whatever it is: a wrong claim shows as a bytecode mismatch', async () => {
  const { comp } = await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-old-compiler.json' });
  assert.equal(comp.calls[0].version, '0.8.30+commit.73712a01');
});

test('a source path outside the repository is refused before anything reads it', async () => {
  const { result, read } = await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-escape.json' });
  assert.deepEqual(codes(result), ['SOURCE_PATH_INVALID']);
  assert.equal(read.calls.length, 0);
});

test('the older multi-file source format compiles with the explorer\'s optimizer and EVM fields', async () => {
  const { result, comp } = await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-multifile.json' });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(comp.calls[0].input.settings.optimizer, { enabled: true, runs: 200 });
  assert.equal(comp.calls[0].input.settings.evmVersion, 'cancun');
});

test('an explorer error is not the maker\'s refusal: it fails the build, to be retried', async () => {
  await assert.rejects(check({ ...MATCH, getsourcecode: 'ratelimit.json' }), (err) => err.code === 'EXPLORER_UNAVAILABLE' && !err.refusal);
});

test('the API key comes from config only, is sent as the apikey parameter and appears nowhere in the result', async () => {
  const { result, rec } = await check(MATCH);
  assert.ok(rec.seen.every((u) => u.searchParams.get('apikey') === KEY));
  assert.ok(!JSON.stringify(result).includes(KEY));
  const err = await check({ ...MATCH, getsourcecode: 'ratelimit.json' }).catch((e) => e);
  assert.ok(!String(err.message).includes(KEY) && !String(err.stack).includes(KEY));
  const noKey = await check(MATCH, { apiKey: null });
  assert.ok(noKey.rec.seen.every((u) => !u.searchParams.has('apikey')));
});

test('parseSourceResult reads the three SourceCode forms and the language', () => {
  const std = parseSourceResult(readFixture('explorer', 'getsourcecode-vault.json'));
  assert.equal(std.verified, true);
  assert.equal(std.format, 'standard-json');
  assert.equal(std.language, 'Solidity');
  assert.deepEqual(Object.keys(std.sources), ['src/Vault.sol']);
  assert.deepEqual(std.optimizer, { enabled: true, runs: 200 });
  assert.equal(std.evmVersion, 'cancun');
  assert.equal(parseSourceResult(readFixture('explorer', 'getsourcecode-vault-multifile.json')).format, 'multi-file');
  assert.equal(parseSourceResult(readFixture('explorer', 'getsourcecode-vault-flattened.json')).format, 'flattened');
  assert.equal(parseSourceResult(readFixture('explorer', 'getsourcecode-unverified.json')).verified, false);
});
