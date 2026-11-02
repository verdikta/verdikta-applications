// Acceptance 2: for a contract listing, the deployed bytecode's verified source (explorer API from
// config) is compared with the repository's files and the artifacts compiled at baseCommit; any
// mismatch stops the listing. Explorer answers come only from recorded responses
// (test/fixtures/explorer: the Etherscan-v2 API's getsourcecode and eth_getCode shapes, recorded
// for the fixture contract test/fixtures/vault compiled with solc 0.8.31), never a live explorer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createExplorer, parseSourceResult } from '../../src/explorer.js';
import { checkVerifiedSource, compareVerifiedSource, normalizeRuntime } from '../../src/sourceCheck.js';
import { FIXTURES, readFixture, recordedExplorer } from '../helpers/fakes.js';
import { contractDraft } from '../helpers/specs.js';

const ARTIFACT = readFixture('artifacts', 'Vault.json');
const VAULT_SOL = fs.readFileSync(path.join(FIXTURES, 'vault', 'src', 'Vault.sol'));
const KEY = 'TESTKEY-not-a-real-explorer-key';

/** The image's side, as a fake: the repository's files at baseCommit and the forge artifacts compiled there. */
function collector({ files = { 'src/Vault.sol': VAULT_SOL }, artifacts = [{ file: 'out/Vault.sol/Vault.json', json: ARTIFACT }], exitCode = 0 } = {}) {
  const calls = [];
  const collect = async (req) => {
    calls.push(req);
    const map = new Map(req.paths.map((p) => [p, Object.hasOwn(files, p) ? Buffer.from(files[p]) : null]));
    return { files: map, artifacts, build: { exitCode, log: exitCode ? 'Compiler run failed' : '' } };
  };
  return { collect, calls };
}

async function check(routes, { apiKey = KEY, collect = collector() } = {}) {
  const rec = recordedExplorer(routes);
  const explorer = createExplorer({ apiUrl: rec.apiUrl, apiKey, chainId: 8453, fetch: rec.fetch, timeoutMs: 5000 });
  const result = await checkVerifiedSource({ spec: contractDraft(), explorer, collect: collect.collect });
  return { result, rec, collect };
}

const MATCH = { getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault.json' };
const codes = (r) => r.issues.map((i) => i.code);

test('the verified source matches the repository at baseCommit and its compiled bytecode: the listing goes on', async () => {
  const { result, collect, rec } = await check(MATCH);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.summary.contract, { path: 'src/Vault.sol', name: 'Vault' });
  assert.equal(result.summary.compilerVersion, '0.8.31+commit.fd3a2265');
  assert.equal(result.summary.filesCompared, 1);
  assert.equal(result.summary.bytecode, 'match');
  // The compile happened at the listing's commit, for the explorer's contract and files.
  assert.deepEqual(collect.calls.map((c) => [c.baseCommit, c.contractName, c.paths]), [[contractDraft().baseCommit, 'Vault', ['src/Vault.sol']]]);
  // Both explorer calls were for the listed chain and address.
  for (const u of rec.seen) {
    assert.equal(u.searchParams.get('chainid'), '8453');
    assert.equal(u.searchParams.get('address'), contractDraft().artifact.address);
  }
});

test('immutables and the metadata trailer are masked; every other byte of the runtime must match', () => {
  const deployed = readFixture('explorer', 'getcode-vault.json').result;
  assert.notEqual(deployed, ARTIFACT.deployedBytecode.object, 'the deployed code carries the immutable owner');
  const a = normalizeRuntime(deployed, ARTIFACT.deployedBytecode);
  const b = normalizeRuntime(ARTIFACT.deployedBytecode.object, ARTIFACT.deployedBytecode);
  assert.ok(a.code.equals(b.code));
  assert.equal(a.metadata.toString('hex'), b.metadata.toString('hex'));
  const other = normalizeRuntime(readFixture('explorer', 'getcode-vault-other.json').result, ARTIFACT.deployedBytecode);
  assert.ok(!other.code.equals(b.code));
  // Without solc's CBOR trailer nothing is split off: every byte is compared.
  const bare = normalizeRuntime('0x6080604052a10002', {});
  assert.equal(bare.metadata.length, 0);
  assert.equal(bare.code.toString('hex'), '6080604052a10002');
});

test('a verified source that differs from the repository at baseCommit stops the listing', async () => {
  const { result } = await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-edited.json' });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('SOURCE_FILE_MISMATCH'), JSON.stringify(result.issues));
  const issue = result.issues.find((i) => i.code === 'SOURCE_FILE_MISMATCH');
  assert.equal(issue.path, 'src/Vault.sol');
});

test('deployed bytecode the compile at baseCommit does not reproduce stops the listing', async () => {
  const { result } = await check({ ...MATCH, getcode: 'getcode-vault-other.json' });
  assert.deepEqual(codes(result), ['BYTECODE_MISMATCH']);
});

test('no code at the address, an unverified contract, a proxy or a flattened source stop the listing', async () => {
  assert.deepEqual(codes((await check({ ...MATCH, getcode: 'getcode-empty.json' })).result), ['SOURCE_NO_CODE']);
  assert.deepEqual(codes((await check({ ...MATCH, getsourcecode: 'getsourcecode-unverified.json' })).result), ['SOURCE_NOT_VERIFIED']);
  assert.deepEqual(codes((await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-proxy.json' })).result), ['SOURCE_PROXY_UNSUPPORTED']);
  assert.deepEqual(codes((await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-flattened.json' })).result), ['SOURCE_FLATTENED_UNSUPPORTED']);
});

test('another compiler or other optimizer settings than the artifacts at baseCommit stop the listing', async () => {
  assert.ok(codes((await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-old-compiler.json' })).result).includes('SOURCE_COMPILER_MISMATCH'));
  assert.ok(codes((await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-no-optimizer.json' })).result).includes('SOURCE_SETTINGS_MISMATCH'));
});

test('a source path outside the repository is refused before anything reads it', async () => {
  const c = collector();
  const { result } = await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-escape.json' }, { collect: c });
  assert.deepEqual(codes(result), ['SOURCE_PATH_INVALID']);
  assert.equal(c.calls.length, 0, 'the image was never asked for it');
});

test('the older multi-file source format is compared the same way', async () => {
  const { result } = await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-multifile.json' });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('a file the verified source lacks, a missing file or a missing contract artifact stop the listing', async () => {
  const extra = JSON.parse(JSON.stringify(ARTIFACT));
  extra.metadata.sources['src/Lib.sol'] = { keccak256: `0x${'0'.repeat(64)}` };
  assert.ok(codes((await check(MATCH, { collect: collector({ artifacts: [{ file: 'out/Vault.sol/Vault.json', json: extra }] }) })).result).includes('SOURCE_FILES_DIFFER'));
  assert.ok(codes((await check(MATCH, { collect: collector({ files: {} }) })).result).includes('SOURCE_FILE_MISSING'));
  assert.deepEqual(codes((await check(MATCH, { collect: collector({ artifacts: [] }) })).result), ['SOURCE_CONTRACT_NOT_FOUND']);
  assert.deepEqual(codes((await check(MATCH, { collect: collector({ exitCode: 1 }) })).result), ['SOURCE_BUILD_FAILED']);
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

test('parseSourceResult reads the three SourceCode forms', () => {
  const std = parseSourceResult(readFixture('explorer', 'getsourcecode-vault.json'));
  assert.equal(std.verified, true);
  assert.equal(std.format, 'standard-json');
  assert.deepEqual(Object.keys(std.sources), ['src/Vault.sol']);
  assert.deepEqual(std.optimizer, { enabled: true, runs: 200 });
  assert.equal(std.evmVersion, 'cancun');
  assert.equal(parseSourceResult(readFixture('explorer', 'getsourcecode-vault-multifile.json')).format, 'multi-file');
  assert.equal(parseSourceResult(readFixture('explorer', 'getsourcecode-vault-flattened.json')).format, 'flattened');
  assert.equal(parseSourceResult(readFixture('explorer', 'getsourcecode-unverified.json')).verified, false);
});

test('direct comparison: the artifact for the explorer\'s contract is chosen by its compilation target', () => {
  const source = parseSourceResult(readFixture('explorer', 'getsourcecode-vault.json'));
  const decoy = JSON.parse(JSON.stringify(ARTIFACT));
  decoy.metadata.settings.compilationTarget = { 'test/mocks/Vault.sol': 'Vault' };
  const r = compareVerifiedSource({
    source,
    deployedCode: readFixture('explorer', 'getcode-vault.json').result,
    files: new Map([['src/Vault.sol', VAULT_SOL]]),
    artifacts: [{ file: 'out/mocks/Vault.json', json: decoy }, { file: 'out/Vault.sol/Vault.json', json: ARTIFACT }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.contract.path, 'src/Vault.sol');
});
