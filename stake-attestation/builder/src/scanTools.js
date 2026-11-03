// The baseline scan's tools (design §8.3): Semgrep with Verdikta's Solidity rules and a secret
// scanner, both pinned by release and digest, the rules by version and SHA-256. Each runs in a
// fresh sandbox of its pinned image (src/docker.js: no network, read-only root, uid 10001) that
// receives the in-scope files on stdin, so nothing of the host is mounted into it; what it prints
// is parsed here into findings that keep the rule, the path, the lines and the message, never a
// source line or a secret's value.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeReview } from './common.js';
import { BuilderError } from './errors.js';

/** Where the builder's own rule files live. */
export const RULES_DIR = fileURLToPath(new URL('../scan-rules/', import.meta.url));

export const SCAN_TOOLS = Object.freeze({
  // semgrep/semgrep 1.181.0 (2026-10-14), the multi-platform index.
  semgrep: Object.freeze({ version: '1.181.0', image: 'docker.io/semgrep/semgrep@sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b' }),
  // zricethezav/gitleaks v8.30.1 (2026-03-21), the multi-platform index; its built-in rules.
  gitleaks: Object.freeze({ version: 'v8.30.1', image: 'docker.io/zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f' }),
  // Verdikta's rule set: the version @verdikta/common pins, and the exact bytes of the file.
  rules: Object.freeze({ version: codeReview.SEMGREP_RULES_VERSION, file: 'solidity.yml', sha256: '11900db04cec1f2a4fa469ab5adfe3b742b8d3cb749ea77f76ada23e5a6202e9' }),
});

const MAX_FINDINGS = 500;
const MAX_ERRORS = 50;
const MAX_TEXT = 500;
const SRC = '/work/src/';

const cut = (s, n = MAX_TEXT) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * The pinned rules file's bytes, checked against the pin.
 * @param {string} [dir] - RULES_DIR unless a test gives another
 * @throws {BuilderError} SCAN_RULES_MODIFIED
 */
export function loadRules(dir = RULES_DIR) {
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(dir, SCAN_TOOLS.rules.file));
  } catch (err) {
    throw new BuilderError('SCAN_RULES_MODIFIED', `the scan rules cannot be read: ${err.message}`, { step: 'scan' });
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== SCAN_TOOLS.rules.sha256) {
    throw new BuilderError('SCAN_RULES_MODIFIED', `the scan rules are not the pinned rule set ${SCAN_TOOLS.rules.version} (SHA-256 ${sha256})`, { step: 'scan' });
  }
  return { name: SCAN_TOOLS.rules.file, bytes, sha256 };
}

function octal(n, width) {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

/** One 512-byte ustar header. */
function tarHeader(name, size, type) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(10001, 8), 108, 'ascii');
  h.write(octal(10001, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.fill(0x20, 148, 156);
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);

/** A PAX record "<len> path=<p>\n", whose length counts itself. */
function paxPath(p) {
  const body = `path=${p}\n`;
  let len = Buffer.byteLength(body) + 2;
  for (;;) {
    const rec = `${len} ${body}`;
    const n = Buffer.byteLength(rec);
    if (n === len) return Buffer.from(rec, 'utf8');
    len = n;
  }
}

/**
 * A scanner's stdin: a tar stream of the files (each path in a PAX header, so its length does not
 * matter), which the sandbox extracts into its tmpfs. A tar is read to its end by one process,
 * where a shell loop over headers and `head -c` would depend on how busybox buffers its input.
 */
export function scannerInput(files) {
  const parts = [];
  files.forEach((f, i) => {
    const pax = paxPath(f.path);
    parts.push(tarHeader(`PaxHeader/${i}`, pax.length, 'x'), pax, pad(pax.length));
    parts.push(tarHeader(`f${i}`, f.bytes.length, '0'), f.bytes, pad(f.bytes.length));
  });
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// Lays the files out under /work (the sandbox's tmpfs), then runs the tool. Paths come from the
// listed commit's tree (src/commitFiles.js rejects ., .. and .git components).
const UNPACK = [
  'set -eu',
  'export LC_ALL=C',
  'mkdir -p /work/src /work/rules',
  'tar -xf - -C /work',
];

/** Semgrep's per-file limit: a larger file is not analysed, and the scan says so. */
export const SEMGREP_MAX_BYTES = 2000000;
/** The secret scanner's per-file limit, in its unit (MB). */
export const GITLEAKS_MAX_MB = 5;
/** Files that would change what the secret scanner does if they were in its folder. */
export const GITLEAKS_CONFIG_FILES = Object.freeze(['.gitleaks.toml', '.gitleaksignore']);

/** Where Semgrep writes its answer. */
const SEMGREP_ANSWER = '/work/semgrep.json';

/**
 * Semgrep's argv: offline, no metrics or version check, the pinned rules. It runs from /work/src with
 * an empty .semgrepignore there, which replaces Semgrep's default exclusions (test/, tests/, vendor/,
 * node_modules/, ...): every file it is given is a target.
 *
 * What verdikta-arbiter's code-runner measured of Semgrep 1.181.0 (its README, "What the runner
 * forces") and a maker's scan would otherwise lose without a word:
 *
 * - Under gVisor its stdout is cut at 65,536 bytes with exit 0. So the answer is written to a file
 *   and `cat` gives it, in the sandbox's one stdout, which Semgrep never held: it could leave a shared
 *   pipe non-blocking for what comes after. A strict prefix of a JSON object does not parse, so a cut
 *   however it came is a failed scan (parseSemgrep), never a smaller one.
 * - `// nosemgrep` in the source drops a finding: --disable-nosem.
 */
export function semgrepArgv() {
  const script = [
    ...UNPACK,
    'cd /work/src',
    ': > /work/src/.semgrepignore',
    'rc=0',
    `semgrep scan --config /work/rules/${SCAN_TOOLS.rules.file} --json --quiet --output ${SEMGREP_ANSWER} --metrics off --disable-version-check --disable-nosem --no-git-ignore --timeout 30 --max-target-bytes ${SEMGREP_MAX_BYTES} --jobs 2 /work/src > /dev/null 2>&1 || rc=$?`,
    `[ ! -e ${SEMGREP_ANSWER} ] || cat ${SEMGREP_ANSWER}`,
    'exit "$rc"',
    '',
  ].join('\n');
  return ['/bin/sh', '-c', script, 'vab-semgrep'];
}

/**
 * The secret scanner's argv: its built-in rules, secrets redacted, its JSON report on stdout and
 * its trace log, which names every file it opens and every one it skips and why, on stderr.
 */
export function gitleaksArgv() {
  const script = [
    ...UNPACK,
    `gitleaks dir /work/src --no-banner --no-color --redact --exit-code 0 --log-level trace --max-target-megabytes ${GITLEAKS_MAX_MB} --report-format json --report-path /work/gitleaks.json >&2`,
    'cat /work/gitleaks.json',
    '',
  ].join('\n');
  return ['/bin/sh', '-c', script, 'vab-gitleaks'];
}

function repoPath(p) {
  const s = String(p ?? '');
  return s.startsWith(SRC) ? s.slice(SRC.length) : s;
}

function failed(tool, detail) {
  return new BuilderError('SCAN_TOOL_FAILED', `${tool}: ${detail}`, { step: 'scan' });
}

function json(stdout, tool) {
  try {
    return JSON.parse(Buffer.from(stdout).toString('utf8'));
  } catch {
    throw failed(tool, 'its output is not JSON');
  }
}

/** A rule's id, without the folder Semgrep puts in front of it. */
function ruleName(id) {
  const s = String(id ?? '');
  const at = s.indexOf('verdikta.');
  return at > 0 ? s.slice(at) : s;
}

/**
 * Semgrep's JSON: its results as findings, the files it analysed, and its errors (a file it could
 * not parse, say) by kind and place only: an error's message can quote the source. Beside them, what
 * it did not do and says only here (verdikta-arbiter's code-runner reads these the same way):
 *
 * - `skipped_rules`: a rule it skipped found nothing, and reads like one that looked. The rules and
 *   the tool are pinned, so this is the tool's failure, not a fact about the maker's code.
 * - A `Too many matches` error: past 10,000 matches of one rule in one file it drops every result for
 *   the file, with exit 0. `capped` names the file and the rule.
 *
 * @throws {BuilderError} SCAN_TOOL_FAILED
 */
export function parseSemgrep(stdout) {
  const out = json(stdout, 'semgrep');
  if (!out || !Array.isArray(out.results) || !Array.isArray(out.errors)) throw failed('semgrep', 'its output has no results');
  if (out.version !== SCAN_TOOLS.semgrep.version) throw failed('semgrep', `it reports version ${cut(JSON.stringify(out.version), 40)}, not the pinned ${SCAN_TOOLS.semgrep.version}`);
  if (!Array.isArray(out.skipped_rules)) throw failed('semgrep', 'its output does not say which rules it skipped');
  if (out.skipped_rules.length > 0) throw failed('semgrep', `it skipped rules: ${cut(out.skipped_rules.map((r) => ruleName(r?.rule_id)).join(', '))}`);
  // A rule's message is the pinned rules file's text: none of them names a metavariable, so no
  // finding carries source text (test/unit/scan.test.js).
  const findings = out.results.slice(0, MAX_FINDINGS).map((r) => {
    return {
      tool: 'semgrep',
      rule: ruleName(r.check_id),
      severity: String(r.extra?.severity ?? 'INFO').toLowerCase(),
      path: repoPath(r.path),
      line: Number(r.start?.line) || 0,
      endLine: Number(r.end?.line) || Number(r.start?.line) || 0,
      message: cut(r.extra?.message),
    };
  });
  const errors = out.errors.slice(0, MAX_ERRORS).map((e) => {
    const line = Number(e.spans?.[0]?.start?.line);
    return {
      type: cut(Array.isArray(e.type) ? e.type[0] : e.type, 100),
      level: cut(e.level, 20),
      ...(e.path ? { path: repoPath(e.path) } : {}),
      ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    };
  });
  const capped = out.errors
    .filter((e) => (Array.isArray(e.type) ? e.type[0] : e.type) === 'Too many matches')
    .map((e) => ({ rule: cut(ruleName(e.rule_id), 100), path: repoPath(e.path) }));
  const scanned = Array.isArray(out.paths?.scanned) ? out.paths.scanned.map(repoPath) : null;
  if (!scanned) throw failed('semgrep', 'its output does not list the files it analysed');
  return { findings, errors, capped, scanned, truncated: out.results.length > MAX_FINDINGS, errorsTruncated: out.errors.length > MAX_ERRORS };
}

const LOG_PATH = /\spath=("(?:[^"\\]|\\.)*"|\S+)/;
const LOG_LINE = /^\S+\s+(?:TRC|DBG|INF|WRN|ERR|FTL)\s+(.*)$/;
// The file- and folder-level skips of the pinned scanner (gitleaks v8.30.1 sources/files.go and
// sources/file.go), by the start of their message. A skip is recorded in these words, never in
// the log's: some log lines carry a candidate's unredacted text.
const FILE_SKIPS = Object.freeze([
  'skipping directory: global allowlist',
  'skipping directory: could not get info',
  'skipping file: global allowlist',
  'skipping file: could not get info',
  'skipping file: permission denied',
  'skipping file: too large',
  'skipping binary file',
  'skipping archive: exceeds max archive depth',
  'skipping unknown archive type',
  'skipping empty file',
  'skipping symlink',
  'skipping directory',
]);

/**
 * What the secret scanner's trace log says it did with the files it was given: every one it
 * opened ("scanning path") and every file or folder it skipped. Lines about a single candidate
 * ("skipping finding: low entropy", "skipping finding: gitleaks:allow" and the like) say nothing
 * about which files were read and can quote the candidate, so they are ignored; a skip is kept
 * as its path (only one it was given, or a folder of them) and the fixed words above. Nothing is
 * capped: the agent pass is given only what the scanner opened and did not skip.
 * @param {Buffer|string} stderr
 * @param {{ paths: string[] }} given - the repository paths the scanner was given
 * @returns {{ opened: Set<string>, skipped: { path: string, detail: string }[] }}
 */
export function parseGitleaksLog(stderr, { paths }) {
  const given = new Set(paths);
  const known = (p) => given.has(p) || paths.some((x) => x.startsWith(`${p}/`));
  const opened = new Set();
  const skipped = [];
  for (const raw of Buffer.from(stderr ?? '').toString('utf8').split('\n')) {
    const m = LOG_LINE.exec(raw.replace(/\x1b\[[0-9;]*m/g, ''));
    if (!m) continue;
    const msg = m[1];
    const opens = msg.startsWith('scanning path ');
    if (!opens && (!/^skipping\b/.test(msg) || /^skipping finding\b/.test(msg))) continue;
    const pm = LOG_PATH.exec(msg);
    if (!pm) continue;
    let p = pm[1];
    if (p.startsWith('"')) {
      try { p = JSON.parse(p); } catch { continue; }
    }
    p = repoPath(p);
    if (!known(p)) continue;
    if (opens) {
      opened.add(p);
      continue;
    }
    const reason = FILE_SKIPS.find((s) => msg.startsWith(s));
    skipped.push({ path: p, detail: reason ? `the secret scanner: ${reason}` : 'the secret scanner skipped it' });
  }
  return { opened, skipped };
}

/**
 * The secret scanner's report: the rule and the place, never the matched text or the secret.
 * @throws {BuilderError} SCAN_TOOL_FAILED
 */
export function parseGitleaks(stdout) {
  const out = json(stdout, 'gitleaks');
  if (!Array.isArray(out)) throw failed('gitleaks', 'its report is not a list');
  // Every finding, for withholding its lines from the agent pass; the maker's file keeps the first MAX_FINDINGS.
  const all = out.map((r) => ({
    tool: 'gitleaks',
    rule: cut(r.RuleID, 100),
    severity: 'error',
    path: repoPath(r.File),
    line: Number(r.StartLine) || 0,
    endLine: Number(r.EndLine) || Number(r.StartLine) || 0,
    message: cut(r.Description),
  }));
  return { all, findings: all.slice(0, MAX_FINDINGS), truncated: out.length > MAX_FINDINGS };
}
