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

/**
 * Semgrep's argv: offline, no metrics or version check, the pinned rules, JSON on stdout. It
 * runs from /work/src with an empty .semgrepignore there, which replaces Semgrep's default
 * exclusions (test/, tests/, vendor/, node_modules/, ...): every file it is given is a target.
 */
export function semgrepArgv() {
  const script = [
    ...UNPACK,
    'cd /work/src',
    ': > /work/src/.semgrepignore',
    `exec semgrep scan --config /work/rules/${SCAN_TOOLS.rules.file} --json --quiet --metrics off --disable-version-check --no-git-ignore --timeout 30 --max-target-bytes ${SEMGREP_MAX_BYTES} --jobs 2 /work/src`,
    '',
  ].join('\n');
  return ['/bin/sh', '-c', script, 'vab-semgrep'];
}

/**
 * The secret scanner's argv: its built-in rules, secrets redacted, its JSON report on stdout and
 * its log, which names every file it skips and why, on stderr.
 */
export function gitleaksArgv() {
  const script = [
    ...UNPACK,
    `gitleaks dir /work/src --no-banner --no-color --redact --exit-code 0 --log-level debug --max-target-megabytes ${GITLEAKS_MAX_MB} --report-format json --report-path /work/gitleaks.json >&2`,
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

/**
 * Semgrep's JSON: its results as findings, the files it analysed, and its errors (a file it could
 * not parse, say) by kind and place only: an error's message can quote the source.
 * @throws {BuilderError} SCAN_TOOL_FAILED
 */
export function parseSemgrep(stdout) {
  const out = json(stdout, 'semgrep');
  if (!out || !Array.isArray(out.results) || !Array.isArray(out.errors)) throw failed('semgrep', 'its output has no results');
  // A rule's message is the pinned rules file's text: none of them names a metavariable, so no
  // finding carries source text (test/unit/scan.test.js).
  const findings = out.results.slice(0, MAX_FINDINGS).map((r) => {
    const id = String(r.check_id ?? '');
    const at = id.indexOf('verdikta.');
    return {
      tool: 'semgrep',
      rule: at > 0 ? id.slice(at) : id,
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
  const scanned = Array.isArray(out.paths?.scanned) ? out.paths.scanned.map(repoPath) : null;
  if (!scanned) throw failed('semgrep', 'its output does not list the files it analysed');
  return { findings, errors, scanned, truncated: out.results.length > MAX_FINDINGS };
}

/**
 * The files and folders the secret scanner says it skipped, and why, from its log: lines like
 * "skipping file: global allowlist path=/work/src/package-lock.json". Only the reason and the
 * path are kept.
 */
export function parseGitleaksSkips(stderr) {
  const out = [];
  for (const line of Buffer.from(stderr ?? '').toString('utf8').split('\n')) {
    const m = /skipping (file|directory): (.*?)\s+(?:[A-Za-z_]+=(?:"(?:[^"\\]|\\.)*"|\S+)\s+)*path=("(?:[^"\\]|\\.)*"|\S+)/.exec(line);
    if (!m) continue;
    let p = m[3];
    if (p.startsWith('"')) {
      try { p = JSON.parse(p); } catch { continue; }
    }
    out.push({ path: repoPath(p), detail: `the secret scanner skips this ${m[1]}: ${cut(m[2].trim(), 100)}` });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

/**
 * The secret scanner's report: the rule and the place, never the matched text or the secret.
 * @throws {BuilderError} SCAN_TOOL_FAILED
 */
export function parseGitleaks(stdout) {
  const out = json(stdout, 'gitleaks');
  if (!Array.isArray(out)) throw failed('gitleaks', 'its report is not a list');
  const findings = out.slice(0, MAX_FINDINGS).map((r) => ({
    tool: 'gitleaks',
    rule: cut(r.RuleID, 100),
    severity: 'error',
    path: repoPath(r.File),
    line: Number(r.StartLine) || 0,
    endLine: Number(r.EndLine) || Number(r.StartLine) || 0,
    message: cut(r.Description),
  }));
  return { findings, truncated: out.length > MAX_FINDINGS };
}
