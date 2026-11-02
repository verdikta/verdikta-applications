// Doubles for the baseline scan's unit tests: the listed commit's files, a docker CLI that plays
// Semgrep and the secret scanner from scripted answers, and a reader for what the scanners were
// fed on stdin. None of them reaches the network or a provider.
import { fakeDocker } from './fakes.js';
import { SCAN_TOOLS } from '../../src/scanTools.js';

/** Tree entries as commitTree() returns them. */
export function entries(files) {
  return Object.entries(files).map(([p, v]) => (typeof v === 'string'
    ? { path: p, mode: '100644', bytes: Buffer.from(v, 'utf8') }
    : { path: p, mode: v.mode, bytes: Buffer.from(v.text ?? '', 'utf8') }));
}

/** The files a scanner received on stdin (a tar stream with a PAX path header per file), by path. */
export function decodeInput(buf) {
  const out = new Map();
  let at = 0;
  let pending = null;
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/, ''), 8);
    const type = String.fromCharCode(h[156]);
    const body = buf.subarray(at + 512, at + 512 + size);
    if (type === 'x') pending = /path=([^\n]*)\n/.exec(body.toString('utf8'))[1];
    else {
      out.set(pending, body.toString('utf8'));
      pending = null;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// Stands for "every file Semgrep was given": scanDocker fills it in from the run's stdin.
const SENT = '__every_file_sent__';

/** Semgrep's JSON; `scanned` (repository paths) defaults to every file it was given. */
export function semgrepAnswer(results = [], errors = [], scanned = null) {
  return JSON.stringify({ version: SCAN_TOOLS.semgrep.version, results, errors, paths: { scanned: scanned === null ? SENT : scanned.map((p) => `/work/src/${p}`) } });
}

function fillScanned(answer, stdin) {
  if (!answer || typeof answer.stdout !== 'string' || !answer.stdout.includes(SENT)) return answer;
  const sent = [...decodeInput(stdin).keys()].filter((p) => p.startsWith('src/')).map((p) => `/work/${p}`);
  return { ...answer, stdout: answer.stdout.replace(JSON.stringify(SENT), JSON.stringify(sent)) };
}

export function semgrepResult({ rule, path, line, severity = 'ERROR', message = 'a finding' }) {
  return { check_id: rule, path: `/work/src/${path}`, start: { line, col: 1 }, end: { line, col: 2 }, extra: { message, severity, lines: 'the source line', metadata: {} } };
}

export function gitleaksResult({ rule = 'generic-api-key', path, line, secret = 'REDACTED' }) {
  return { RuleID: rule, Description: 'Detected a Generic API Key', StartLine: line, EndLine: line, Match: `apiKey = "${secret}"`, Secret: secret, File: `/work/src/${path}`, Entropy: 4.7, Fingerprint: `/work/src/${path}:${rule}:${line}` };
}

/**
 * A docker double for a scan: both pinned images are present; `semgrep` and `gitleaks` answer a
 * run of their image ({ exitCode, stdout, stderr }). Every call and every stdin is recorded.
 */
export function scanDocker({ semgrep = { stdout: semgrepAnswer() }, gitleaks = { stdout: '[]' }, present = true } = {}) {
  const runs = [];
  const docker = fakeDocker((args, opts) => {
    if (args[0] === 'image' && args[1] === 'inspect') return present ? { stdout: '[{}]' } : { exitCode: 1, stderr: 'No such image' };
    if (args[0] === 'pull') return {};
    if (args[0] === 'run') {
      const image = args.find((a) => a === SCAN_TOOLS.semgrep.image || a === SCAN_TOOLS.gitleaks.image);
      runs.push({ args, image, stdin: opts.stdin });
      if (image === SCAN_TOOLS.semgrep.image) return fillScanned(typeof semgrep === 'function' ? semgrep(args, opts) : semgrep, opts.stdin);
      if (image === SCAN_TOOLS.gitleaks.image) return typeof gitleaks === 'function' ? gitleaks(args, opts) : gitleaks;
      return { exitCode: 125, stderr: 'unexpected image' };
    }
    return {};
  });
  return { docker, runs };
}

/** The deps of a scan whose listed commit holds `files`. */
export function scanDeps(files, over = {}) {
  const calls = { fetch: [], tree: [] };
  const d = scanDocker(over);
  return {
    calls,
    runs: d.runs,
    docker: d.docker,
    deps: {
      docker: d.docker,
      fetchListedCommit: async (req) => { calls.fetch.push(req); return { gitDir: req.dir }; },
      commitTree: async (req) => { calls.tree.push(req); return { entries: entries(files), skipped: over.skipped ?? [] }; },
      ...over.deps,
    },
  };
}
