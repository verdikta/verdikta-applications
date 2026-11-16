// The verified-source check for a `contract` listing (design §8.2 step 1, §8.8): the deployed
// bytecode's verified source, from the explorer configured for the listing's chain, against the
// repository at baseCommit and what it compiles to. A mismatch stops the listing.
//
// The repository is built as every claim's run will build it, with tools the listing did not
// choose (src/repoBuild.js): the listed commit's files from the objects the builder fetched, the
// image's installed dependencies around them, the pinned base's forge, and the solc release the
// explorer names from the Solidity project's checksummed binaries (src/solc.js). Then:
//   files     every file of the verified source is byte-identical to that path in the tree the
//             build reads (through any symbolic link, as the build reads it);
//   compiler  the repository pins that solc release (foundry.toml `solc = "x.y.z"`) and builds with
//             the verified optimizer, EVM and IR settings;
//   sources   the build of the contract uses only files of the verified source, with their bytes
//             (so no remapping selects a file the explorer never saw);
//   bytecode  its runtime code is the deployed code, every byte but the immutables (filled in at
//             deployment) and solc's CBOR metadata trailer. An unlinked library reference is
//             refused: its address could not be checked.
// So the deployed code is what the listed commit builds to, with the repository's own settings,
// whatever the explorer's own matching did and whatever the maker's setup put in the image.
import crypto from 'node:crypto';

import { keccak_256 as keccak256 } from '@noble/hashes/sha3';

import { optimizerRuns } from './explorer.js';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_SOURCE_FILES = 2000;
const SOLC_KEY = Buffer.from('64736f6c63', 'hex'); // CBOR text "solc"

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** A repository-relative path: no leading slash, no `.` or `..` segment, no NUL, newline or backslash. */
export function isSourcePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return false;
  if (p.startsWith('/') || /[\0\n\r\\]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function hexBytes(hex) {
  const h = String(hex).replace(/^0x/, '');
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new TypeError('the bytecode is not hex (an unlinked library placeholder?)');
  return Buffer.from(h, 'hex');
}

/**
 * Runtime bytecode with the immutables zeroed and solc's CBOR metadata trailer (a map naming
 * "solc", its length in the last two bytes) split off. Nothing else is masked.
 * @param {string} hex
 * @param {{ immutableReferences?: object }} refs - solc's evm.deployedBytecode
 * @returns {{ code: Buffer, metadata: Buffer }}
 */
export function normalizeRuntime(hex, refs = {}) {
  const bytes = hexBytes(hex);
  for (const list of Object.values(refs.immutableReferences || {})) {
    for (const { start, length } of list) {
      if (Number.isInteger(start) && Number.isInteger(length) && start >= 0 && start + length <= bytes.length) bytes.fill(0, start, start + length);
    }
  }
  if (bytes.length >= 2) {
    const len = bytes.readUInt16BE(bytes.length - 2);
    const at = bytes.length - 2 - len;
    if (len > 0 && at >= 0 && bytes[at] >= 0xa1 && bytes[at] <= 0xbf && bytes.subarray(at, bytes.length - 2).includes(SOLC_KEY)) {
      return { code: bytes.subarray(0, at), metadata: bytes.subarray(at) };
    }
  }
  return { code: bytes, metadata: Buffer.alloc(0) };
}

function splitName(name) {
  const i = name.lastIndexOf(':');
  return i === -1 ? { path: null, name } : { path: name.slice(0, i), name: name.slice(i + 1) };
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
}

function summaryOf(source, extra = {}) {
  return { contract: null, compilerVersion: source?.compilerVersion ?? null, format: source?.format ?? null, filesCompared: 0, bytecode: 'not compared', metadata: 'not compared', ...extra };
}

function result(issues, warnings, summary) {
  return { ok: issues.length === 0, issues, warnings, contract: summary.contract, summary };
}

function refuse(code, detail, source, extra) {
  return result([{ code, detail }], [], summaryOf(source, extra));
}

/** Compares the verified files with the files the repository's build reads at those paths. */
export function compareFiles(source, files) {
  const issues = [];
  for (const [p, content] of Object.entries(source.sources)) {
    const bytes = files.get(p);
    const verified = Buffer.from(content, 'utf8');
    if (!bytes) {
      issues.push({ code: 'SOURCE_FILE_MISSING', path: p, detail: `${p} is in the verified source but not a file of the listed commit or its installed dependencies` });
    } else if (!bytes.equals(verified)) {
      issues.push({ code: 'SOURCE_FILE_MISMATCH', path: p, detail: `${p} differs: the listed commit (with its installed dependencies) has sha256 ${sha256(bytes)}, the verified source ${sha256(verified)}` });
    }
  }
  return issues;
}

const SEMVER = /^([0-9]+\.[0-9]+\.[0-9]+)/;

/** The repository's solc pin (forge config's `solc`) against the release the source was verified with. */
export function compareCompilerPin(config, source) {
  const pin = config && typeof config.solc === 'string' ? config.solc.trim().replace(/^v/, '') : null;
  const verified = SEMVER.exec(source.compilerVersion)?.[1] ?? source.compilerVersion;
  if (!pin || !SEMVER.test(pin) || pin.includes('/')) {
    return [{ code: 'SOURCE_COMPILER_NOT_PINNED', detail: `foundry.toml must name the solc release the contract was verified with (solc = "${verified}"); it ${pin ? `names ${JSON.stringify(pin.slice(0, 200))}` : 'names none'}, so claims could build other bytecode than the deployed` }];
  }
  if (SEMVER.exec(pin)[1] !== verified) {
    return [{ code: 'SOURCE_COMPILER_MISMATCH', detail: `foundry.toml pins solc ${pin}; the contract was verified with ${source.compilerVersion}` }];
  }
  return [];
}

/** The contract's source file: `path:Name`, the explorer's ContractFileName, or the one verified file declaring it. */
export function contractPathOf(source) {
  const { path: p, name } = splitName(source.contractName);
  if (p) return p;
  if (source.contractFile) return source.contractFile;
  const decl = new RegExp(`\\b(?:abstract\\s+)?(?:contract|library)\\s+${name.replace(/\$/g, '\\$')}\\b`);
  const files = Object.entries(source.sources).filter(([, c]) => decl.test(c)).map(([f]) => f);
  return files.length === 1 ? files[0] : null;
}

function settingsDiff(source, settings) {
  const diffs = [];
  const opt = { enabled: settings?.optimizer?.enabled === true, runs: optimizerRuns(settings?.optimizer?.runs) };
  if (opt.enabled !== source.optimizer.enabled) diffs.push(`optimizer ${source.optimizer.enabled ? 'on' : 'off'} vs ${opt.enabled ? 'on' : 'off'}`);
  else if (opt.enabled && opt.runs !== source.optimizer.runs) diffs.push(`optimizer runs ${source.optimizer.runs} vs ${opt.runs}`);
  if (source.evmVersion && String(settings?.evmVersion || '').toLowerCase() !== source.evmVersion) diffs.push(`evmVersion ${source.evmVersion} vs ${settings?.evmVersion || 'default'}`);
  if (source.viaIR !== (settings?.viaIR === true)) diffs.push(`viaIR ${source.viaIR} vs ${settings?.viaIR === true}`);
  return diffs;
}

/**
 * Compares the repository's build of the contract with the verified source and the deployed code.
 * @param {object} o
 * @param {object} o.source - parseSourceResult()
 * @param {object|null} o.artifact - forge's artifact for the contract
 * @param {string} o.contractPath
 * @param {string} o.deployedCode - 0x hex
 */
export function compareRepoBuild({ source, artifact, contractPath, deployedCode }) {
  const issues = [];
  const warnings = [];
  const { name } = splitName(source.contractName);
  const target = Object.entries(artifact?.metadata?.settings?.compilationTarget || {});
  if (!artifact || target.length !== 1 || target[0][0] !== contractPath || target[0][1] !== name || !artifact.deployedBytecode) {
    return { issues: [{ code: 'SOURCE_CONTRACT_NOT_FOUND', detail: `the repository's build has no artifact for ${contractPath}:${name}` }], warnings, contract: null, bytecode: 'not compared', metadata: 'not compared' };
  }
  const contract = { path: contractPath, name };
  // Every file the build of the contract used must be a verified file, with its bytes.
  for (const [p, info] of Object.entries(artifact.metadata.sources || {})) {
    if (!Object.hasOwn(source.sources, p)) {
      issues.push({ code: 'SOURCE_FILES_DIFFER', path: p, detail: `the repository's build of ${contractPath}:${name} uses ${p}, which the verified source does not contain` });
    } else if (`0x${Buffer.from(keccak256(Buffer.from(source.sources[p], 'utf8'))).toString('hex')}` !== info?.keccak256) {
      issues.push({ code: 'SOURCE_FILES_DIFFER', path: p, detail: `the repository's build of ${contractPath}:${name} compiled other bytes for ${p} than the verified source holds` });
    }
  }
  const runtime = artifact.deployedBytecode;
  const links = Object.entries(runtime.linkReferences || {}).flatMap(([file, libs]) => Object.keys(libs || {}).map((lib) => `${file}:${lib}`));
  if (links.length) {
    issues.push({ code: 'SOURCE_LIBRARIES_UNSUPPORTED', detail: `${contractPath}:${name} calls external libraries the build does not link (${links.slice(0, 5).join(', ')}): their deployed addresses could not be checked` });
    return { issues, warnings, contract, bytecode: 'not compared', metadata: 'not compared' };
  }
  let bytecode;
  let metadata = 'not compared';
  const diffs = settingsDiff(source, artifact.metadata.settings);
  try {
    const deployed = normalizeRuntime(deployedCode, runtime);
    const built = normalizeRuntime(runtime.object, runtime);
    if (deployed.code.equals(built.code)) {
      bytecode = 'match';
      metadata = deployed.metadata.equals(built.metadata) ? 'match' : 'differs';
      if (metadata === 'differs') warnings.push({ code: 'BYTECODE_METADATA_DIFFERS', detail: 'the runtime code matches; the metadata hash in its trailer differs' });
      if (diffs.length) issues.push({ code: 'SOURCE_SETTINGS_MISMATCH', detail: `the verified compiler settings differ from foundry.toml's (verified vs repository): ${diffs.join('; ')}; claims would build with other settings than the deployment` });
    } else {
      bytecode = 'mismatch';
      issues.push({
        code: 'BYTECODE_MISMATCH',
        detail: `the deployed runtime code (${deployed.code.length} bytes) is not what the listed commit builds ${contractPath}:${name} to (${built.code.length} bytes; first difference at byte ${firstDifference(deployed.code, built.code)})${diffs.length ? `; the verified settings differ from foundry.toml's (verified vs repository): ${diffs.join('; ')}` : ''}`,
      });
    }
  } catch (err) {
    bytecode = 'mismatch';
    issues.push({ code: 'BYTECODE_MISMATCH', detail: `the bytecode could not be compared: ${err.message}` });
  }
  return { issues, warnings, contract, bytecode, metadata };
}

/**
 * The whole check for a contract listing.
 * @param {object} o
 * @param {object} o.spec - the draft code_review.json (artifact.kind contract)
 * @param {{ getSource(a: string): Promise<object>, getCode(a: string): Promise<string> }} o.explorer
 * @param {(req: { version: string, contractPath: string, contractName: string, paths: string[] }) =>
 *   Promise<{ files: Map<string, Buffer|null>, config: object|null, artifact: object|null, build: { exitCode: number, log: string }, solc: object }>} o.buildRepo -
 *   the repository's build at baseCommit with trusted tools (repoBuild.js)
 * @throws {BuilderError} EXPLORER_UNAVAILABLE, SOLC_*, SOURCE_READ_FAILED (to be retried; not the maker's refusal)
 */
export async function checkVerifiedSource({ spec, explorer, buildRepo }) {
  const { address, chainId } = spec.artifact;
  const source = await explorer.getSource(address);
  if (!source.verified) return refuse('SOURCE_NOT_VERIFIED', `${address} has no verified source on the explorer`, source);
  if (source.proxy) {
    return refuse('SOURCE_PROXY_UNSUPPORTED', `${address} is a proxy${source.implementation ? ` (implementation ${source.implementation})` : ''}: the code behind it can change, so it cannot be staked as one version`, source);
  }
  if (source.format === 'flattened') {
    return refuse('SOURCE_FLATTENED_UNSUPPORTED', 'the source was verified as one flattened file, which cannot be compared file by file with the repository; verify it with its standard JSON input (forge verify-contract)', source);
  }
  if (source.language && source.language !== 'Solidity') return refuse('SOURCE_LANGUAGE_UNSUPPORTED', `the source is ${source.language}; this release checks Solidity only`, source);
  const paths = Object.keys(source.sources);
  const bad = paths.filter((p) => !isSourcePath(p));
  if (bad.length) return refuse('SOURCE_PATH_INVALID', `the verified source names paths outside the repository: ${bad.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}`, source);
  if (paths.length === 0 || paths.length > MAX_SOURCE_FILES) return refuse('SOURCE_PATH_INVALID', `the verified source has ${paths.length} files`, source);
  const { name } = splitName(source.contractName);
  if (!IDENT.test(name)) return refuse('SOURCE_CONTRACT_NOT_FOUND', `the explorer's contract name ${JSON.stringify(source.contractName)} is not a Solidity identifier`, source);
  const contractPath = contractPathOf(source);
  if (!contractPath || !paths.includes(contractPath)) return refuse('SOURCE_CONTRACT_NOT_FOUND', `the verified source does not say which of its files declares ${name}`, source);
  const code = await explorer.getCode(address);
  if (code === '0x') return refuse('SOURCE_NO_CODE', `there is no code at ${address} on chain ${chainId}`, source);

  const b = await buildRepo({ version: source.compilerVersion, contractPath, contractName: name, paths });
  const filesCompared = paths.length;
  const unverifiable = (b.skippedSubmodules ?? []).flatMap((sub) => paths.filter((p) => p.startsWith(`${sub.path}/`)).map((p) => ({ sub, p })));
  if (unverifiable.length) {
    return result(unverifiable.map(({ sub, p }) => ({
      code: 'SOURCE_SUBMODULE_UNVERIFIABLE',
      path: p,
      detail: `${p} is in the submodule at ${sub.path}, which the builder could not fetch by the commit its gitlink records (${sub.detail}); its files could not be checked`,
    })), [], summaryOf(source, { filesCompared, solc: b.solc }));
  }
  const fileIssues = compareFiles(source, b.files);
  if (fileIssues.length) return result(fileIssues, [], summaryOf(source, { filesCompared, solc: b.solc }));
  const pinIssues = compareCompilerPin(b.config, source);
  if (pinIssues.length) return result(pinIssues, [], summaryOf(source, { filesCompared, solc: b.solc }));
  if (b.build.exitCode !== 0) {
    const r = refuse('SOURCE_BUILD_FAILED', `forge build of ${contractPath} at baseCommit failed with the verified solc ${source.compilerVersion}`, source, { filesCompared, solc: b.solc });
    r.issues[0].log = b.build.log;
    return r;
  }
  const c = compareRepoBuild({ source, artifact: b.artifact, contractPath, deployedCode: code });
  if (b.copy && b.copy.exitCode !== 0) c.warnings.push({ code: 'UNTRACKED_COPY_INCOMPLETE', detail: `some of the image's untracked files could not be laid out beside the listed commit: ${b.copy.errors.slice(-500)}` });
  for (const sub of b.skippedSubmodules ?? []) c.warnings.push({ code: 'SUBMODULE_NOT_FETCHED', path: sub.path, detail: `the submodule at ${sub.path} was left empty in this check's build (${sub.detail}); the contract does not use it` });
  return result(c.issues, c.warnings, summaryOf(source, { contract: c.contract, filesCompared, bytecode: c.bytecode, metadata: c.metadata, solc: b.solc }));
}
