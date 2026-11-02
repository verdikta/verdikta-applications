// The verified-source check for a `contract` listing (design §8.2 step 1, §8.8): the deployed
// bytecode's verified source, from the explorer configured for the listing's chain, against the
// repository at baseCommit and what it compiles to. A mismatch stops the listing.
//
// Two comparisons, neither of which runs anything the listing chose:
//   files     every file of the verified source is byte-identical to the file at that path in
//             the listed commit, read from objects the builder fetched by id (src/commitFiles.js),
//             or, for a path the commit does not track, to the image's installed dependency;
//   bytecode  the verified standard-JSON input (those same bytes, the verified settings, the
//             verified libraries) compiled by the solc release the explorer names, from the
//             Solidity project's checksummed binaries (src/solc.js), in a sandbox of the pinned
//             base image, gives the deployed runtime code, every byte but the immutables (filled
//             in at deployment) and solc's CBOR metadata trailer. A contract with an unlinked
//             library reference is refused: its library address could not be checked.
// So the deployed code is the listed commit's code compiled as verified, whatever the explorer's
// own matching did, and whatever the maker's setup put in the env image.
import crypto from 'node:crypto';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_SOURCE_FILES = 2000;
const SOLC_KEY = Buffer.from('64736f6c63', 'hex'); // CBOR text "solc"
const OUTPUTS = Object.freeze(['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'evm.deployedBytecode.linkReferences', 'metadata']);

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

/** The standard-JSON input the verified contract compiles from, asking for the runtime code. */
export function compilerInput(source) {
  const settings = source.format === 'standard-json'
    ? { ...source.settings }
    : {
        optimizer: { enabled: source.optimizer.enabled, runs: source.optimizer.runs },
        ...(source.evmVersion ? { evmVersion: source.evmVersion } : {}),
      };
  settings.outputSelection = { '*': { '*': [...OUTPUTS] } };
  return {
    language: 'Solidity',
    sources: Object.fromEntries(Object.entries(source.sources).map(([p, content]) => [p, { content }])),
    settings,
  };
}

/** Compares the verified files with the listed commit's (or the image's untracked) files. */
export function compareFiles(source, files) {
  const issues = [];
  for (const [p, content] of Object.entries(source.sources)) {
    const f = files.get(p);
    const verified = Buffer.from(content, 'utf8');
    if (f && f.origin === 'symlink') {
      issues.push({ code: 'SOURCE_FILE_MISMATCH', path: p, detail: f.detail });
    } else if (!f || f.origin === 'missing' || !f.bytes) {
      issues.push({ code: 'SOURCE_FILE_MISSING', path: p, detail: f?.detail ?? `${p} is in the verified source but not in the repository at baseCommit or its installed dependencies` });
    } else if (!f.bytes.equals(verified)) {
      issues.push({ code: 'SOURCE_FILE_MISMATCH', path: p, detail: `${p} differs: the ${f.origin === 'untracked' ? 'image\'s installed file' : 'listed commit'} has sha256 ${sha256(f.bytes)}, the verified source ${sha256(verified)}` });
    }
  }
  return issues;
}

/**
 * Compares solc's output for the verified input with the deployed code.
 * @param {object} o
 * @param {object} o.source - parseSourceResult()
 * @param {object} o.output - solc's standard-JSON output for compilerInput(source)
 * @param {string} o.deployedCode - 0x hex
 */
export function compareCompiled({ source, output, deployedCode }) {
  const warnings = [];
  const none = (code, detail, contract = null) => ({ issues: [{ code, detail }], warnings, contract, bytecode: 'not compared', metadata: 'not compared' });
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    return none('SOURCE_COMPILE_FAILED', `the verified source does not compile with solc ${source.compilerVersion}: ${String(errors[0].formattedMessage || errors[0].message).slice(0, 500)}`);
  }
  const want = splitName(source.contractName);
  if (!want.path && source.contractFile) want.path = source.contractFile;
  const candidates = [];
  for (const [p, contracts] of Object.entries(output.contracts || {})) {
    if (want.path && p !== want.path) continue;
    if (contracts && Object.hasOwn(contracts, want.name)) candidates.push({ path: p, name: want.name, out: contracts[want.name] });
  }
  if (candidates.length !== 1) {
    return none(candidates.length ? 'SOURCE_CONTRACT_AMBIGUOUS' : 'SOURCE_CONTRACT_NOT_FOUND', `the verified source compiles to ${candidates.length} contracts named ${source.contractName}${want.path ? ` in ${want.path}` : ''}`);
  }
  const [c] = candidates;
  const contract = { path: c.path, name: c.name };
  const runtime = c.out?.evm?.deployedBytecode;
  if (!runtime || typeof runtime.object !== 'string') return none('SOURCE_CONTRACT_NOT_FOUND', `solc produced no runtime code for ${c.path}:${c.name}`, contract);
  const links = Object.entries(runtime.linkReferences || {}).flatMap(([file, libs]) => Object.keys(libs || {}).map((lib) => `${file}:${lib}`));
  if (links.length) {
    return none('SOURCE_LIBRARIES_UNSUPPORTED', `${c.path}:${c.name} calls external libraries whose addresses the verified source does not fix (${links.slice(0, 5).join(', ')}): the deployed library code could not be checked`, contract);
  }
  const issues = [];
  let bytecode;
  let metadata = 'not compared';
  try {
    const deployed = normalizeRuntime(deployedCode, runtime);
    const built = normalizeRuntime(runtime.object, runtime);
    if (deployed.code.equals(built.code)) {
      bytecode = 'match';
      metadata = deployed.metadata.equals(built.metadata) ? 'match' : 'differs';
      if (metadata === 'differs') warnings.push({ code: 'BYTECODE_METADATA_DIFFERS', detail: 'the runtime code matches; the metadata hash in its trailer differs' });
    } else {
      bytecode = 'mismatch';
      issues.push({ code: 'BYTECODE_MISMATCH', detail: `the deployed runtime code (${deployed.code.length} bytes) is not what ${c.path}:${c.name} compiles to as verified (${built.code.length} bytes; first difference at byte ${firstDifference(deployed.code, built.code)})` });
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
 * @param {(req: { paths: string[] }) => Promise<Map<string, { origin: string, bytes: Buffer|null, detail?: string }>>} o.readFiles -
 *   the listed commit's files (commitFiles.readCommitFiles, then the image for untracked ones)
 * @param {(req: { version: string, input: object }) => Promise<{ output: object, solc: { version: string, sha256: string } }>} o.compile -
 *   the trusted compiler (solc.js)
 * @throws {BuilderError} EXPLORER_UNAVAILABLE, SOLC_* (to be retried; not the maker's refusal)
 */
export async function checkVerifiedSource({ spec, explorer, readFiles, compile }) {
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
  const code = await explorer.getCode(address);
  if (code === '0x') return refuse('SOURCE_NO_CODE', `there is no code at ${address} on chain ${chainId}`, source);

  const files = await readFiles({ paths });
  const fileIssues = compareFiles(source, files);
  const filesCompared = paths.length;
  if (fileIssues.length) return result(fileIssues, [], summaryOf(source, { filesCompared }));

  const { output, solc } = await compile({ version: source.compilerVersion, input: compilerInput(source) });
  const c = compareCompiled({ source, output, deployedCode: code });
  return result(c.issues, c.warnings, summaryOf(source, { contract: c.contract, filesCompared, bytecode: c.bytecode, metadata: c.metadata, solc }));
}
