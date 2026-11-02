// The repository's own build of the verified contract, at baseCommit, with tools the listing did
// not choose: the pinned base image's forge (everything in the env image outside /repo and
// /opt/verdikta/tools is that base's bytes, and its directories come first on PATH) and the
// checksummed solc (src/solc.js), passed with `--use`. Run in a fresh sandbox (src/docker.js: no
// network, uid 10001, read-only root) that receives everything on stdin:
//
//   1. the solc binary, kept in a directory nothing else can write to;
//   2. the listed commit's files from the objects the builder fetched (src/commitFiles.js), laid out
//      as the code-runner's forced checkout lays them out;
//   3. the image's untracked files (its installed dependencies) copied in around them, never over a
//      tracked path, as the code-runner keeps them.
//
// The verified source's files are read from that tree, through any symbolic link exactly as the
// build and every claim's run will read them, before anything compiles. Then `forge config --json`
// (the repository's compiler pin) and `forge build --force --offline --use <solc>` of the contract's
// file, whose artifact the check compares with the deployed code.
import { runSandboxed } from './docker.js';
import { BuilderError } from './errors.js';
import { tail } from './proc.js';

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

const SCRIPT = [
  'set -eu',
  'export LC_ALL=C',
  'mkdir -p /work/.verdikta /work/src',
  'head -c "$1" > /work/.verdikta/solc',
  'chmod 0500 /work/.verdikta/solc && chmod 0500 /work/.verdikta',
  'contract=$2; name=$3; shift 3',
  'cd /work/src',
  // The listed commit's files: "<mode> <size> <base64 path>" then exactly <size> bytes.
  'while IFS=" " read -r mode size enc; do',
  '  [ "$mode" = end ] && break',
  '  p=$(printf "%s" "$enc" | base64 -d)',
  '  mkdir -p -- "$(dirname -- "$p")"',
  '  if [ "$mode" = 120000 ]; then t=$(head -c "$size"); ln -s -- "$t" "$p"; else head -c "$size" > "$p"; fi',
  '  [ "$mode" = 100755 ] && chmod 0755 "$p"',
  '  :',
  'done',
  // The image's untracked files around them, never over what is there.
  'copy=0',
  '{ tar -C /repo --exclude=.git -cf - . | tar -C /work/src --skip-old-files -xf - ; } 2>/work/.copy-errors || copy=$?',
  'printf "T %s %s\\n" "$copy" "$(tail -c 2000 /work/.copy-errors | base64 -w0)"',
  // The verified files as the build reads them.
  'for p in "$@"; do',
  '  enc=$(printf "%s" "$p" | base64 -w0)',
  '  if [ -f "$p" ]; then printf "F %s " "$enc"; base64 -w0 < "$p"; printf "\\n"; else printf "M %s\\n" "$enc"; fi',
  'done',
  'printf "C %s\\n" "$(forge config --json 2>/dev/null | base64 -w0)"',
  'status=0',
  'forge build --force --offline --use /work/.verdikta/solc --out /work/out -- "$contract" >&2 || status=$?',
  'printf "B %s\\n" "$status"',
  'base=$(basename -- "$contract")',
  'if [ "$status" = 0 ] && [ -f "/work/out/$base/$name.json" ]; then printf "A %s\\n" "$(base64 -w0 < "/work/out/$base/$name.json")"; fi',
  '',
].join('\n');

/** The stdin of a build: the solc binary, then the commit's files, then the end marker. */
export function buildInput(solcBytes, entries) {
  const parts = [solcBytes];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.bytes.length} ${Buffer.from(e.path, 'utf8').toString('base64')}\n`, 'utf8'), e.bytes);
  }
  parts.push(Buffer.from('end 0 -\n', 'utf8'));
  return Buffer.concat(parts);
}

/** The argv of a build: the script, then solc's size, the contract's file and name, and the verified paths. */
export function buildArgv({ solcSize, contractPath, contractName, paths }) {
  return ['/bin/sh', '-c', SCRIPT, 'vab-build', String(solcSize), contractPath, contractName, ...paths];
}

/**
 * @param {object} o
 * @param {object} o.docker
 * @param {string} o.image - the pushed env image (for its pinned forge and its untracked files)
 * @param {string} o.platform
 * @param {{ bytes: Buffer }} o.solc - fetchSolc()
 * @param {{ path: string, mode: string, bytes: Buffer }[]} o.entries - commitTree().entries
 * @param {string} o.contractPath - the contract's source file
 * @param {string} o.contractName
 * @param {string[]} o.paths - the verified source's files, to read back
 * @returns {Promise<{ files: Map<string, Buffer|null>, config: object|null, artifact: object|null, copy: { exitCode: number, errors: string }|null, build: { exitCode: number, log: string } }>}
 */
export async function buildAtCommit({ docker, image, platform, solc, entries, contractPath, contractName, paths, timeoutMs = 900000 }) {
  const r = await runSandboxed({
    docker,
    image,
    platform,
    argv: buildArgv({ solcSize: solc.bytes.length, contractPath, contractName, paths }),
    stdin: buildInput(solc.bytes, entries),
    timeoutMs,
    maxBytes: MAX_OUTPUT_BYTES,
  });
  if (r.spawnError) throw new BuilderError('DOCKER_UNAVAILABLE', r.spawnError, { step: 'verifiedSource' });
  if (r.timedOut) throw new BuilderError('SOURCE_BUILD_TIMEOUT', `the build at baseCommit did not finish in ${Math.round(timeoutMs / 1000)} s`, { step: 'verifiedSource' });
  const lines = r.stdout.toString('utf8').split('\n').filter(Boolean);
  const status = lines.find((l) => l.startsWith('B '));
  if (r.exitCode !== 0 || r.stdoutTruncated || !status) {
    throw new BuilderError('SOURCE_READ_FAILED', `the listed commit could not be laid out in the sandbox: ${tail(r.stderr, 2000).trim() || `exit ${r.exitCode}`}`, { step: 'verifiedSource' });
  }
  const files = new Map(paths.map((p) => [p, null]));
  let config = null;
  let artifact = null;
  let copy = null;
  const dec = (s) => Buffer.from(s ?? '', 'base64');
  for (const line of lines) {
    const [kind, a, b] = line.split(' ');
    if (kind === 'F') files.set(dec(a).toString('utf8'), dec(b));
    else if (kind === 'T') copy = { exitCode: Number(a), errors: dec(b).toString('utf8') };
    else if (kind === 'C') {
      try { config = JSON.parse(dec(a).toString('utf8')); } catch { config = null; }
    } else if (kind === 'A') {
      try { artifact = JSON.parse(dec(a).toString('utf8')); } catch { artifact = null; }
    }
  }
  const exitCode = Number(status.slice(2));
  return { files, config, artifact, copy, build: { exitCode, log: exitCode === 0 ? '' : tail(r.stderr) } };
}
