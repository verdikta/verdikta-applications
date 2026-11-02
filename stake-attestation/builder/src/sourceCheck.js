// The verified-source check for a `contract` listing (design §8.2 step 1, §8.8): the deployed
// bytecode's verified source, from the explorer configured for the listing's chain, against the
// repository at baseCommit and the artifacts compiled there. A mismatch stops the listing.
//
// Three comparisons, each sufficient to stop it:
//   files     every file of the verified source is byte-identical to the file at that path in the
//             listed commit (read from the commit's objects, no git filter or config of the
//             image's applied) or, for an untracked dependency, in the image;
//   compiler  the artifact compiled at baseCommit for the explorer's contract used the compiler
//             version and the optimizer, EVM and IR settings the source was verified with, and
//             only files the verified source contains;
//   bytecode  that artifact's runtime code is the deployed code, every byte but the immutables
//             (filled in at deployment) and the CBOR metadata trailer.
// The compile runs in the env image as every later run of it does: no network, the sandbox user,
// a read-only root (src/docker.js).
import crypto from 'node:crypto';

import { BuilderError } from './errors.js';
import { runSandboxed } from './docker.js';
import { tail } from './proc.js';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SOLC_KEY = Buffer.from('64736f6c63', 'hex');
const MAX_SOURCE_FILES = 2000;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** A repository-relative path: no leading slash, no `.` or `..` segment, no NUL, newline or backslash. */
export function isSourcePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return false;
  if (p.startsWith('/') || /[\0\n\r\\]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function hexBytes(hex) {
  const h = String(hex).replace(/^0x/, '').replace(/__\$[0-9a-fA-F]{34}\$__/g, '0'.repeat(40));
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new TypeError('bytecode is not hex');
  return Buffer.from(h, 'hex');
}

/**
 * Runtime bytecode with the immutables and library addresses zeroed and the CBOR metadata
 * trailer (its length in the last two bytes) split off.
 * @param {string} hex
 * @param {{ immutableReferences?: object, linkReferences?: object }} refs - the artifact's deployedBytecode
 * @returns {{ code: Buffer, metadata: Buffer }}
 */
export function normalizeRuntime(hex, refs = {}) {
  const bytes = hexBytes(hex);
  const zero = (start, length) => {
    if (Number.isInteger(start) && Number.isInteger(length) && start >= 0 && start + length <= bytes.length) bytes.fill(0, start, start + length);
  };
  for (const list of Object.values(refs.immutableReferences || {})) for (const { start, length } of list) zero(start, length);
  for (const file of Object.values(refs.linkReferences || {})) for (const list of Object.values(file)) for (const { start, length } of list) zero(start, length);
  if (bytes.length >= 2) {
    const len = bytes.readUInt16BE(bytes.length - 2);
    const at = bytes.length - 2 - len;
    // solc's trailer: a CBOR map (0xa1-0xbf) that names the compiler ("solc", text of 4 bytes).
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

/**
 * Compares what the explorer verified with what the listed commit holds and compiles to.
 * @param {object} o
 * @param {object} o.source - parseSourceResult()
 * @param {string} o.deployedCode - 0x hex
 * @param {Map<string, Buffer|null>} o.files - the repository's file at each source path, null when absent
 * @param {{ file: string, json: object }[]} o.artifacts - forge artifacts named like the contract
 */
export function compareVerifiedSource({ source, deployedCode, files, artifacts }) {
  const issues = [];
  const warnings = [];
  const want = splitName(source.contractName);
  if (!want.path && source.contractFile) want.path = source.contractFile;
  const sourcePaths = Object.keys(source.sources || {});

  // The artifact for the explorer's contract, by its compilation target.
  const candidates = artifacts.filter(({ json }) => {
    const target = Object.entries(json?.metadata?.settings?.compilationTarget || {});
    if (target.length !== 1 || target[0][1] !== want.name) return false;
    if (want.path && target[0][0] !== want.path) return false;
    return sourcePaths.includes(target[0][0]);
  });
  let contract = null;
  if (candidates.length === 0) {
    issues.push({ code: 'SOURCE_CONTRACT_NOT_FOUND', detail: `the compile at baseCommit has no artifact for ${source.contractName} in the verified source's files` });
  } else if (candidates.length > 1) {
    issues.push({ code: 'SOURCE_CONTRACT_AMBIGUOUS', detail: `the compile at baseCommit has ${candidates.length} artifacts for ${source.contractName}: ${candidates.map((c) => c.file).join(', ')}` });
  } else {
    const [p, n] = Object.entries(candidates[0].json.metadata.settings.compilationTarget)[0];
    contract = { path: p, name: n };
  }

  // Files: byte for byte.
  for (const p of sourcePaths) {
    const repo = files.get(p);
    const verified = Buffer.from(source.sources[p], 'utf8');
    if (!repo) {
      issues.push({ code: 'SOURCE_FILE_MISSING', path: p, detail: `${p} is in the verified source but not in the repository at baseCommit` });
    } else if (!repo.equals(verified)) {
      issues.push({ code: 'SOURCE_FILE_MISMATCH', path: p, detail: `${p} differs: the repository at baseCommit has sha256 ${sha256(repo)}, the verified source ${sha256(verified)}` });
    }
  }

  let bytecode = 'not compared';
  let metadata = 'not compared';
  if (contract) {
    const art = candidates[0].json;
    const meta = art.metadata;
    const compiled = meta.compiler?.version;
    if (compiled !== source.compilerVersion) {
      issues.push({ code: 'SOURCE_COMPILER_MISMATCH', detail: `verified with solc ${source.compilerVersion || 'unknown'}; the compile at baseCommit used ${compiled || 'unknown'}` });
    }
    const s = meta.settings || {};
    const diffs = [];
    const optimizer = { enabled: s.optimizer?.enabled === true, runs: Number(s.optimizer?.runs) || 0 };
    if (optimizer.enabled !== source.optimizer.enabled) diffs.push(`optimizer ${source.optimizer.enabled ? 'on' : 'off'} vs ${optimizer.enabled ? 'on' : 'off'}`);
    else if (optimizer.enabled && optimizer.runs !== source.optimizer.runs) diffs.push(`optimizer runs ${source.optimizer.runs} vs ${optimizer.runs}`);
    if (source.evmVersion && (s.evmVersion || '').toLowerCase() !== source.evmVersion) diffs.push(`evmVersion ${source.evmVersion} vs ${s.evmVersion || 'default'}`);
    if (source.viaIR !== (s.viaIR === true)) diffs.push(`viaIR ${source.viaIR} vs ${s.viaIR === true}`);
    if (diffs.length) issues.push({ code: 'SOURCE_SETTINGS_MISMATCH', detail: `the verified settings differ from the compile at baseCommit (verified vs compiled): ${diffs.join('; ')}` });
    const used = Object.keys(meta.sources || {});
    const lacking = used.filter((p) => !sourcePaths.includes(p));
    if (lacking.length) {
      issues.push({ code: 'SOURCE_FILES_DIFFER', detail: `the compile at baseCommit uses files the verified source lacks: ${lacking.slice(0, 20).join(', ')}` });
    }
    const extra = sourcePaths.filter((p) => !used.includes(p));
    if (extra.length) warnings.push({ code: 'SOURCE_EXTRA_FILES', detail: `the verified source has files the contract does not use: ${extra.slice(0, 20).join(', ')}` });
    try {
      const deployed = normalizeRuntime(deployedCode, art.deployedBytecode);
      const built = normalizeRuntime(art.deployedBytecode.object, art.deployedBytecode);
      if (deployed.code.equals(built.code)) {
        bytecode = 'match';
        metadata = deployed.metadata.equals(built.metadata) ? 'match' : 'differs';
        if (metadata === 'differs') warnings.push({ code: 'BYTECODE_METADATA_DIFFERS', detail: 'the runtime code matches; the metadata hash differs (source paths or settings outside the code)' });
      } else {
        bytecode = 'mismatch';
        issues.push({ code: 'BYTECODE_MISMATCH', detail: `the deployed runtime code (${deployed.code.length} bytes) is not what ${contract.path}:${contract.name} compiles to at baseCommit (${built.code.length} bytes; first difference at byte ${firstDifference(deployed.code, built.code)})` });
      }
    } catch (err) {
      bytecode = 'mismatch';
      issues.push({ code: 'BYTECODE_MISMATCH', detail: `the bytecode could not be compared: ${err.message}` });
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    contract,
    summary: {
      contract,
      compilerVersion: source.compilerVersion,
      format: source.format,
      filesCompared: sourcePaths.length,
      bytecode,
      metadata,
    },
  };
}

function early(code, detail, source) {
  return {
    ok: false,
    issues: [{ code, detail }],
    warnings: [],
    contract: null,
    summary: { contract: null, compilerVersion: source?.compilerVersion ?? null, format: source?.format ?? null, filesCompared: 0, bytecode: 'not compared', metadata: 'not compared' },
  };
}

/**
 * The whole check for a contract listing.
 * @param {object} o
 * @param {object} o.spec - the draft code_review.json (artifact.kind contract)
 * @param {{ getSource(a:string): Promise<object>, getCode(a:string): Promise<string> }} o.explorer
 * @param {(req: { baseCommit: string, contractName: string, paths: string[] }) => Promise<{ files: Map, artifacts: object[], build: { exitCode: number, log: string } }>} o.collect
 * @throws {BuilderError} EXPLORER_UNAVAILABLE (to be retried; not the maker's refusal)
 */
export async function checkVerifiedSource({ spec, explorer, collect }) {
  const { address } = spec.artifact;
  const source = await explorer.getSource(address);
  if (!source.verified) return early('SOURCE_NOT_VERIFIED', `${address} has no verified source on the explorer`, source);
  if (source.proxy) {
    return early('SOURCE_PROXY_UNSUPPORTED', `${address} is a proxy${source.implementation ? ` (implementation ${source.implementation})` : ''}: the code behind it can change, so it cannot be staked as one version`, source);
  }
  if (source.format === 'flattened') {
    return early('SOURCE_FLATTENED_UNSUPPORTED', 'the source was verified as one flattened file, which cannot be compared file by file with the repository; verify it with its standard JSON input (forge verify-contract)', source);
  }
  const paths = Object.keys(source.sources);
  const bad = paths.filter((p) => !isSourcePath(p));
  if (bad.length) return early('SOURCE_PATH_INVALID', `the verified source names paths outside the repository: ${bad.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}`, source);
  if (paths.length === 0 || paths.length > MAX_SOURCE_FILES) return early('SOURCE_PATH_INVALID', `the verified source has ${paths.length} files`, source);
  const { name } = splitName(source.contractName);
  if (!IDENT.test(name)) return early('SOURCE_CONTRACT_NOT_FOUND', `the explorer's contract name ${JSON.stringify(source.contractName)} is not a Solidity identifier`, source);
  const code = await explorer.getCode(address);
  if (code === '0x') return early('SOURCE_NO_CODE', `there is no code at ${address} on chain ${spec.artifact.chainId}`, source);
  const collected = await collect({ baseCommit: spec.baseCommit, contractName: name, paths });
  if (collected.build.exitCode !== 0) {
    const r = early('SOURCE_BUILD_FAILED', 'forge build failed at baseCommit in the env image', source);
    r.issues[0].log = collected.build.log;
    return r;
  }
  return compareVerifiedSource({ source, deployedCode: code, files: collected.files, artifacts: collected.artifacts });
}

// The script that rebuilds the listed commit's tree from the image's git objects, never its
// checkout, config, attributes or hooks (as the code-runner's forced checkout does; objects that
// do not hash to their ids are the code-runner's listing check to refuse), adds the image's
// untracked files (installed dependencies), compiles with forge, and prints one line each: the
// build's exit status, every requested file (or its absence) and every artifact named like the
// contract, base64. Arguments: baseCommit, the contract name, then the source paths.
const COLLECT_SCRIPT = [
  'set -eu',
  'sha=$1; name=$2; shift 2',
  'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null LC_ALL=C',
  "TAB=$(printf '\\t')",
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.autocrlf=false -c core.symlinks=true -c core.quotePath=false "$@"; }',
  'mkdir -p /work/src && cd /work/src',
  'if [ ${#sha} = 64 ]; then g init -q --template= --object-format=sha256 >&2; else g init -q --template= >&2; fi',
  'mkdir -p .git/info .git/objects/info',
  "printf '* !filter !diff !merge !text !crlf !eol !ident !working-tree-encoding\\n' > .git/info/attributes",
  "find /repo -type d -name objects -path '*.git*' > .git/objects/info/alternates",
  'g read-tree "$sha" >&2',
  // Submodules: each gitlink's tree in its place, when the image holds its objects.
  'round=0',
  'while [ "$round" -lt 16 ]; do',
  '  round=$((round + 1)); found=0',
  '  g ls-files -s > /tmp/vab-index',
  '  while IFS="$TAB" read -r meta p; do',
  '    mode=${meta%% *}; rest=${meta#* }; obj=${rest%% *}',
  '    [ "$mode" = 160000 ] || continue',
  '    found=1',
  '    g rm -q --cached -- "$p" >&2',
  '    if g cat-file -e "$obj^{tree}" 2>/dev/null; then g read-tree --prefix="$p/" "$obj^{tree}" >&2; fi',
  '  done < /tmp/vab-index',
  '  [ "$found" = 1 ] || break',
  'done',
  'g checkout-index --all --force >&2',
  'tar -C /repo --exclude=.git -cf - . | tar -C /work/src --skip-old-files -xf - >&2 2>/dev/null || true',
  'status=0',
  'forge build --force --out /work/.verdikta-out >&2 || status=$?',
  "printf 'B %s\\n' \"$status\"",
  'for p in "$@"; do',
  "  enc=$(printf '%s' \"$p\" | base64 -w0)",
  "  if [ -f \"/work/src/$p\" ]; then printf 'F %s ' \"$enc\"; base64 -w0 < \"/work/src/$p\"; printf '\\n'; else printf 'M %s\\n' \"$enc\"; fi",
  'done',
  'if [ "$status" = 0 ]; then',
  '  find /work/.verdikta-out -type f -name "$name.json" | while IFS= read -r a; do',
  "    printf 'A %s ' \"$(printf '%s' \"$a\" | base64 -w0)\"; base64 -w0 < \"$a\"; printf '\\n'",
  '  done',
  'fi',
  '',
].join('\n');

/**
 * Compiles the listed commit in the env image and returns the requested files and the contract's
 * artifacts.
 * @param {object} o
 * @param {object} o.docker
 * @param {string} o.image - the pushed image, by digest
 * @param {string} o.platform - the platform this daemon runs
 * @param {string} o.baseCommit
 * @param {string} o.contractName
 * @param {string[]} o.paths
 * @param {number} [o.timeoutMs]
 */
export async function collectFromImage({ docker, image, platform, baseCommit, contractName, paths, timeoutMs = 600000 }) {
  if (!IDENT.test(contractName)) throw new TypeError('contractName must be a Solidity identifier');
  if (!paths.every(isSourcePath)) throw new TypeError('paths must be repository-relative');
  const r = await runSandboxed({
    docker,
    image,
    platform,
    argv: ['/bin/sh', '-c', COLLECT_SCRIPT, 'vab-collect', baseCommit, contractName, ...paths],
    timeoutMs,
    maxBytes: MAX_OUTPUT_BYTES,
  });
  if (r.spawnError) throw new BuilderError('DOCKER_UNAVAILABLE', r.spawnError, { step: 'verifiedSource' });
  if (r.timedOut) throw new BuilderError('SOURCE_COLLECT_FAILED', `the compile at baseCommit did not finish in ${Math.round(timeoutMs / 1000)} s`, { step: 'verifiedSource' });
  if (r.stdoutTruncated) throw new BuilderError('SOURCE_COLLECT_FAILED', `the compile's artifacts are larger than ${MAX_OUTPUT_BYTES} bytes`, { step: 'verifiedSource' });
  const lines = r.stdout.toString('utf8').split('\n').filter(Boolean);
  const status = lines.find((l) => l.startsWith('B '));
  if (r.exitCode !== 0 || !status) {
    throw new BuilderError('SOURCE_COLLECT_FAILED', `the listed commit could not be rebuilt from the image's objects: ${tail(r.stderr, 2000).trim()}`, { step: 'verifiedSource' });
  }
  const exitCode = Number(status.slice(2));
  const files = new Map(paths.map((p) => [p, null]));
  const artifacts = [];
  const dec = (s) => Buffer.from(s, 'base64');
  for (const line of lines) {
    const [kind, name, body = ''] = line.split(' ');
    if (kind === 'F') files.set(dec(name).toString('utf8'), dec(body));
    else if (kind === 'A') {
      try {
        artifacts.push({ file: dec(name).toString('utf8').replace(/^\/work\//, ''), json: JSON.parse(dec(body).toString('utf8')) });
      } catch {
        /* an artifact that is not JSON is not one */
      }
    }
  }
  return { files, artifacts, build: { exitCode, log: exitCode === 0 ? '' : tail(r.stderr) } };
}
