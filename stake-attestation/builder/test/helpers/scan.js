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

/** The files a scanner received on stdin ("<mode> <size> <base64 path>" then the bytes), by path. */
export function decodeInput(buf) {
  const out = new Map();
  let at = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, at);
    const [mode, size, enc] = buf.subarray(at, nl).toString('utf8').split(' ');
    if (mode === 'end') break;
    const n = Number(size);
    out.set(Buffer.from(enc, 'base64').toString('utf8'), buf.subarray(nl + 1, nl + 1 + n).toString('utf8'));
    at = nl + 1 + n;
  }
  return out;
}

export function semgrepAnswer(results = [], errors = []) {
  return JSON.stringify({ version: SCAN_TOOLS.semgrep.version, results, errors, paths: { scanned: [] } });
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
      if (image === SCAN_TOOLS.semgrep.image) return typeof semgrep === 'function' ? semgrep(args, opts) : semgrep;
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
