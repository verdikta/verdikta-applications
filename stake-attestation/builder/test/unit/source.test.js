// Acceptance 2: for a contract listing, the deployed bytecode's verified source (explorer API from
// config) is compared with the repository at baseCommit and what it builds to; any mismatch stops
// the listing. Explorer answers come only from recorded responses (test/fixtures/explorer: the
// Etherscan-v2 API's getsourcecode and eth_getCode shapes, recorded for the fixture contract
// test/fixtures/vault), never a live explorer. The repository's build is a double here, answering
// with forge's recorded artifact and config for the fixture (test/fixtures/forge); the real one,
// with trusted tools and an adversarial listing, is in source.docker.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createExplorer, parseSourceResult } from '../../src/explorer.js';
import { checkVerifiedSource, compareCompilerPin, compareRepoBuild, contractPathOf, normalizeRuntime } from '../../src/sourceCheck.js';
import { FIXTURES, readFixture, recordedExplorer } from '../helpers/fakes.js';
import { contractDraft } from '../helpers/specs.js';

const ARTIFACT = readFixture('forge', 'Vault.json');
const CONFIG = readFixture('forge', 'config.json');
const VAULT_SOL = fs.readFileSync(path.join(FIXTURES, 'vault', 'src', 'Vault.sol'));
const KEY = 'TESTKEY-not-a-real-explorer-key';
const SOLC = { version: '0.8.31+commit.fd3a2265', sha256: 'acf358d82da7db033debb2f4db11e1c9cfcb02b0cb5b5ddbb9635ad817b41bdd', platform: 'linux/amd64' };

/** The repository's build at baseCommit, as a double: what it reads at each path, its config, its artifact. */
function builder({ files = { 'src/Vault.sol': VAULT_SOL }, config = CONFIG, artifact = ARTIFACT, exitCode = 0, skipped = [] } = {}) {
  const calls = [];
  const buildRepo = async (req) => {
    calls.push(req);
    return {
      files: new Map(req.paths.map((p) => [p, Object.hasOwn(files, p) ? Buffer.from(files[p]) : null])),
      config,
      artifact: exitCode === 0 ? artifact : null,
      build: { exitCode, log: exitCode ? 'Compiler run failed' : '' },
      skippedSubmodules: skipped,
      solc: SOLC,
    };
  };
  return { buildRepo, calls };
}

async function check(routes, { apiKey = KEY, b = builder() } = {}) {
  const rec = recordedExplorer(routes);
  const explorer = createExplorer({ apiUrl: rec.apiUrl, apiKey, chainId: 8453, fetch: rec.fetch, timeoutMs: 5000 });
  const result = await checkVerifiedSource({ spec: contractDraft(), explorer, buildRepo: b.buildRepo });
  return { result, rec, b };
}

const MATCH = { getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault.json' };
const codes = (r) => r.issues.map((i) => i.code);
const clone = (v) => JSON.parse(JSON.stringify(v));

test('the verified files are the listed commit\'s and the repository builds them to the deployed code: the listing goes on', async () => {
  const { result, b, rec } = await check(MATCH);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.summary.contract, { path: 'src/Vault.sol', name: 'Vault' });
  assert.equal(result.summary.filesCompared, 1);
  assert.equal(result.summary.bytecode, 'match');
  assert.equal(result.summary.metadata, 'match');
  assert.deepEqual(result.summary.solc, SOLC);
  // The build uses the release the explorer names, for the explorer's contract, and reads back its files.
  assert.deepEqual(b.calls, [{ version: '0.8.31+commit.fd3a2265', contractPath: 'src/Vault.sol', contractName: 'Vault', paths: ['src/Vault.sol'] }]);
  for (const u of rec.seen) {
    assert.equal(u.searchParams.get('chainid'), '8453');
    assert.equal(u.searchParams.get('address'), contractDraft().artifact.address);
  }
});

test('immutables and solc\'s metadata trailer are masked; every other byte of the runtime must match', () => {
  const runtime = ARTIFACT.deployedBytecode;
  const deployed = readFixture('explorer', 'getcode-vault.json').result;
  assert.notEqual(deployed, runtime.object, 'the deployed code carries the immutable owner');
  const a = normalizeRuntime(deployed, runtime);
  const b = normalizeRuntime(runtime.object, runtime);
  assert.ok(a.code.equals(b.code));
  assert.equal(a.metadata.toString('hex'), b.metadata.toString('hex'));
  assert.ok(!normalizeRuntime(readFixture('explorer', 'getcode-vault-other.json').result, runtime).code.equals(b.code));
  // Without solc's CBOR trailer nothing is split off: every byte is compared.
  const bare = normalizeRuntime('0x6080604052a10002', {});
  assert.equal(bare.metadata.length, 0);
  assert.equal(bare.code.toString('hex'), '6080604052a10002');
  assert.throws(() => normalizeRuntime(`0x60__$${'a'.repeat(34)}$__`, {}), /hex/, 'an unlinked placeholder is never masked');
});

test('a verified source that differs from what the build reads at that path stops the listing', async () => {
  assert.deepEqual(codes((await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-edited.json' })).result), ['SOURCE_FILE_MISMATCH']);
  assert.deepEqual(codes((await check(MATCH, { b: builder({ files: {} }) })).result), ['SOURCE_FILE_MISSING']);
});

test('the repository must pin the solc release the contract was verified with', async () => {
  assert.deepEqual(codes((await check(MATCH, { b: builder({ config: { ...CONFIG, solc: '0.8.30' } }) })).result), ['SOURCE_COMPILER_MISMATCH']);
  assert.deepEqual(codes((await check(MATCH, { b: builder({ config: { ...CONFIG, solc: null } }) })).result), ['SOURCE_COMPILER_NOT_PINNED']);
  assert.deepEqual(codes((await check(MATCH, { b: builder({ config: { ...CONFIG, solc: '/opt/verdikta/tools/bin/solc' } }) })).result), ['SOURCE_COMPILER_NOT_PINNED']);
  assert.deepEqual(codes((await check(MATCH, { b: builder({ config: null }) })).result), ['SOURCE_COMPILER_NOT_PINNED']);
  const source = parseSourceResult(readFixture('explorer', 'getsourcecode-vault.json'));
  assert.deepEqual(compareCompilerPin({ solc: 'v0.8.31' }, source), []);
});

test('settings in foundry.toml that build other code than the deployment stop the listing, and the detail names them', async () => {
  const noOpt = clone(ARTIFACT);
  noOpt.metadata.settings.optimizer = { enabled: false, runs: 200 };
  noOpt.deployedBytecode.object = readFixture('explorer', 'getcode-vault-other.json').result;
  const { result } = await check(MATCH, { b: builder({ artifact: noOpt }) });
  assert.deepEqual(codes(result), ['BYTECODE_MISMATCH']);
  assert.match(result.issues[0].detail, /optimizer on vs off/);
});

test('a build that uses a file the verified source lacks (say, through a remapping), or other bytes for it, stops the listing', async () => {
  const extra = clone(ARTIFACT);
  extra.metadata.sources['lib/evil/Math.sol'] = { keccak256: `0x${'0'.repeat(64)}` };
  assert.deepEqual(codes((await check(MATCH, { b: builder({ artifact: extra }) })).result), ['SOURCE_FILES_DIFFER']);
  const other = clone(ARTIFACT);
  other.metadata.sources['src/Vault.sol'].keccak256 = `0x${'1'.repeat(64)}`;
  assert.deepEqual(codes((await check(MATCH, { b: builder({ artifact: other }) })).result), ['SOURCE_FILES_DIFFER']);
});

test('deployed bytecode the repository does not build to stops the listing', async () => {
  assert.deepEqual(codes((await check({ ...MATCH, getcode: 'getcode-vault-other.json' })).result), ['BYTECODE_MISMATCH']);
});

test('an external library the build does not link is refused: its deployed address could not be checked', async () => {
  const linked = clone(ARTIFACT);
  linked.deployedBytecode.linkReferences = { 'src/Lib.sol': { Lib: [{ start: 10, length: 20 }] } };
  assert.ok(codes((await check(MATCH, { b: builder({ artifact: linked }) })).result).includes('SOURCE_LIBRARIES_UNSUPPORTED'));
});

test('a build that fails, or yields no artifact for the contract, stops the listing', async () => {
  const failed = (await check(MATCH, { b: builder({ exitCode: 1 }) })).result;
  assert.deepEqual(codes(failed), ['SOURCE_BUILD_FAILED']);
  assert.match(failed.issues[0].log, /Compiler run failed/);
  assert.deepEqual(codes((await check(MATCH, { b: builder({ artifact: null }) })).result), ['SOURCE_CONTRACT_NOT_FOUND']);
  const elsewhere = clone(ARTIFACT);
  elsewhere.metadata.settings.compilationTarget = { 'test/mocks/Vault.sol': 'Vault' };
  assert.deepEqual(compareRepoBuild({ source: parseSourceResult(readFixture('explorer', 'getsourcecode-vault.json')), artifact: elsewhere, contractPath: 'src/Vault.sol', deployedCode: '0x00' }).issues.map((i) => i.code), ['SOURCE_CONTRACT_NOT_FOUND']);
});

test('no code at the address, an unverified contract, a proxy or a flattened source stop the listing before any build', async () => {
  for (const [routes, code] of [
    [{ ...MATCH, getcode: 'getcode-empty.json' }, 'SOURCE_NO_CODE'],
    [{ ...MATCH, getsourcecode: 'getsourcecode-unverified.json' }, 'SOURCE_NOT_VERIFIED'],
    [{ ...MATCH, getsourcecode: 'getsourcecode-vault-proxy.json' }, 'SOURCE_PROXY_UNSUPPORTED'],
    [{ ...MATCH, getsourcecode: 'getsourcecode-vault-flattened.json' }, 'SOURCE_FLATTENED_UNSUPPORTED'],
    [{ ...MATCH, getsourcecode: 'getsourcecode-vault-escape.json' }, 'SOURCE_PATH_INVALID'],
  ]) {
    const { result, b } = await check(routes);
    assert.deepEqual(codes(result), [code]);
    assert.equal(b.calls.length, 0, code);
  }
});

test('the compiler is the release the explorer names, whatever it is', async () => {
  const { b, result } = await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-old-compiler.json' });
  assert.equal(b.calls[0].version, '0.8.30+commit.73712a01');
  assert.deepEqual(codes(result), ['SOURCE_COMPILER_MISMATCH'], 'and the repository pins 0.8.31');
});

test('the contract\'s file: path:Name, ContractFileName, or the one verified file that declares it', () => {
  const s = (over) => ({ contractName: 'Vault', contractFile: null, sources: { 'src/Vault.sol': 'contract Vault {}', 'src/B.sol': 'contract B {}' }, ...over });
  assert.equal(contractPathOf(s({ contractName: 'src/B.sol:Vault' })), 'src/B.sol');
  assert.equal(contractPathOf(s({ contractFile: 'src/B.sol' })), 'src/B.sol');
  assert.equal(contractPathOf(s()), 'src/Vault.sol');
  assert.equal(contractPathOf(s({ sources: { 'a.sol': 'contract Vault {}', 'b.sol': 'abstract contract Vault {}' } })), null);
});

test('the older multi-file source format is checked the same way', async () => {
  const { result } = await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-multifile.json' });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('a verified file in a submodule the builder could not authenticate stops the listing', async () => {
  const b = builder({ files: { 'src/Vault.sol': VAULT_SOL }, skipped: [{ path: 'src', detail: 'no https URL for it in .gitmodules' }] });
  const { result } = await check(MATCH, { b });
  assert.deepEqual(result.issues.map((i) => [i.code, i.path]), [['SOURCE_SUBMODULE_UNVERIFIABLE', 'src/Vault.sol']]);
});

test('compiler settings that differ from the verified ones stop the listing, even when this contract\'s code comes out the same', async () => {
  const runs = clone(ARTIFACT);
  runs.metadata.settings.optimizer = { enabled: true, runs: 1000 };
  const { result } = await check(MATCH, { b: builder({ artifact: runs }) });
  assert.equal(result.summary.bytecode, 'match');
  assert.deepEqual(codes(result), ['SOURCE_SETTINGS_MISMATCH']);
  assert.match(result.issues[0].detail, /optimizer runs 200 vs 1000/);
  const evm = clone(ARTIFACT);
  evm.metadata.settings.evmVersion = 'prague';
  assert.deepEqual(codes((await check(MATCH, { b: builder({ artifact: evm }) })).result), ['SOURCE_SETTINGS_MISMATCH']);
});

test('an omitted optimizer runs is solc\'s default, 200; an explicit 0 stays 0', async () => {
  const omitted = await check({ ...MATCH, getsourcecode: 'getsourcecode-vault-default-runs.json' });
  assert.equal(omitted.result.ok, true, JSON.stringify(omitted.result.issues));
  assert.deepEqual(parseSourceResult(readFixture('explorer', 'getsourcecode-vault-default-runs.json')).optimizer, { enabled: true, runs: 200 });
  const zero = clone(ARTIFACT);
  zero.metadata.settings.optimizer = { enabled: true, runs: 0 };
  assert.match((await check(MATCH, { b: builder({ artifact: zero }) })).result.issues[0].detail, /optimizer runs 200 vs 0/);
  const unset = clone(ARTIFACT);
  delete unset.metadata.settings.optimizer.runs;
  assert.equal((await check(MATCH, { b: builder({ artifact: unset }) })).result.ok, true, 'the repository\'s omitted runs is 200 too');
});

test('a submodule the build could not fetch is reported', async () => {
  const { result } = await check(MATCH, { b: builder({ skipped: [{ path: 'lib/forge-std', detail: 'no https URL for it in .gitmodules' }] }) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.map((w) => w.code), ['SUBMODULE_NOT_FETCHED']);
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
