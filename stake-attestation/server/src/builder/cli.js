// The environment builder (stake-attestation/builder, node P3a) behind the interface the listing
// flow uses: build({ draft, knownIssues }) resolves to
//
//   { status: 'accepted', report, files: { codeReview, baseline, knownIssues, attestation }, devTrust }
//   { status: 'refused',  report, files: null, devTrust: null }
//   { status: 'error',    report|null, files: null, devTrust: null, error?: { code, detail } }
//
// It runs the builder's own command line, as the site's workflow would, in two processes:
// `verdikta-build-env build` (it runs the maker's setup inside Docker and holds no secret; it
// refuses to start while the signing key is in its environment), then, for an accepted build,
// `verdikta-build-env sign` (design §20 decision 3: signing apart from the build). Each process
// gets PATH, HOME and only the variables config names for that step, so neither ever sees the
// server's pinning credentials and `build` never sees the signing key. Nothing secret goes in an
// argument. Exit status: 0 accepted (or signed), 2 refused, 1 error, as the builder documents.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPORT_FILE = 'validation-report.json';
const DEV_TRUST_FILE = 'dev-trust.json';
const PLAIN_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
const OUTPUT_CAP = 64 * 1024;
const KILL_GRACE_MS = 5000;

const tail = (buf, n = 600) => buf.toString('utf8').slice(-n).trim();
// The builder's own error line, "verdikta-build-env: CODE: detail": only the code goes into a
// result the maker sees; the output itself stays in the server's log.
const builderCode = (buf) => /verdikta-build-env: ([A-Z][A-Z0-9_]+)/.exec(buf.toString('utf8'))?.[1] ?? null;

function childEnv(env, names, tmp) {
  const out = {};
  for (const n of ['PATH', 'HOME', ...names]) if (typeof env[n] === 'string') out[n] = env[n];
  // the builder's own temporary folders (and docker's, git's) go inside the server's build
  // folder, which is removed however the step ends
  out.TMPDIR = tmp;
  return out;
}

/**
 * Runs `node bin ...args` as the leader of its own process group, so a timeout reaches
 * everything the step started (git, docker, an external signer), not only the builder: SIGTERM
 * to the group, SIGKILL after a grace period. Anything of the group still running when the
 * builder exits is killed too. The promise settles when the step's output pipes close, so a
 * build slot is held until the whole tree has gone (or, after SIGKILL, a grace period more for
 * a process that left the group).
 * @returns {Promise<{ code: number|null, spawnError: string|null, timedOut: boolean, stdout: Buffer, stderr: Buffer }>}
 */
function runStep({ nodePath, bin, args, env, timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(nodePath, [bin, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const out = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const keep = (which) => (chunk) => {
      out[which] = Buffer.concat([out[which], chunk]);
      if (out[which].length > OUTPUT_CAP) out[which] = out[which].subarray(out[which].length - OUTPUT_CAP);
    };
    child.stdout.on('data', keep('stdout'));
    child.stderr.on('data', keep('stderr'));
    const killGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* the group has gone */
      }
    };
    let timedOut = false;
    let done = false;
    const timers = [];
    const finish = (r) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      resolve({ ...r, timedOut, ...out });
    };
    timers.push(setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      timers.push(setTimeout(() => {
        killGroup('SIGKILL');
        timers.push(setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code: child.exitCode, spawnError: null });
        }, KILL_GRACE_MS));
      }, KILL_GRACE_MS));
    }, timeoutMs));
    child.on('error', (err) => finish({ code: null, spawnError: err.message }));
    child.on('exit', () => killGroup('SIGKILL'));
    child.on('close', (code) => finish({ code, spawnError: null }));
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readNamed(dir, name) {
  if (typeof name !== 'string' || !PLAIN_NAME.test(name)) return null;
  try {
    return fs.readFileSync(path.join(dir, name));
  } catch {
    return null;
  }
}

const errored = (code, detail, report = null) => ({ status: 'error', report, files: null, devTrust: null, error: { code, detail } });

/**
 * @param {{ bin: string, config: string|null, workDir: string, buildEnv: string[], signEnv: string[], timeoutMs: number }} cfg - config.builder
 * @param {{ env?: Record<string, string|undefined>, nodePath?: string, logger?: { warn: Function } }} [o]
 */
export function createCliBuilder(cfg, { env = process.env, nodePath = process.execPath, logger = null } = {}) {
  const step = (args, names, cwd) => runStep({ nodePath, bin: cfg.bin, args, env: childEnv(env, names, path.join(cwd, 'tmp')), timeoutMs: cfg.timeoutMs, cwd });
  const exited = (what, r) => {
    logger?.warn(`builder ${what} exited ${r.code}: ${tail(r.stderr)}`);
    const code = builderCode(r.stderr);
    return `the builder's ${what} step exited ${r.code}${code ? `: ${code}` : ''}`;
  };

  return {
    async build({ draft, knownIssues }) {
      if (!cfg.config) return errored('BUILDER_NOT_CONFIGURED', 'no builder config is set (SA_BUILDER_CONFIG)');
      const dir = fs.mkdtempSync(path.join(cfg.workDir, 'sa-build-'));
      try {
        fs.mkdirSync(path.join(dir, 'tmp'));
        const specPath = path.join(dir, 'draft.json');
        fs.writeFileSync(specPath, `${JSON.stringify(draft, null, 2)}\n`);
        const args = ['build', '--config', cfg.config, '--spec', specPath];
        if (knownIssues) {
          const kiPath = path.join(dir, 'known_issues.json');
          fs.writeFileSync(kiPath, knownIssues);
          args.push('--known-issues', kiPath);
        }
        const out = path.join(dir, 'out');
        args.push('--out', out);

        const b = await step(args, cfg.buildEnv, dir);
        if (b.timedOut) return errored('BUILDER_TIMEOUT', `the build did not finish in ${cfg.timeoutMs} ms`, readJson(path.join(out, REPORT_FILE)));
        if (b.spawnError) return errored('BUILDER_FAILED', `the builder could not be started: ${b.spawnError}`);
        const report = readJson(path.join(out, REPORT_FILE));
        if (!report) return errored('BUILDER_NO_REPORT', `${exited('build', b)}, with no validation report`);
        if (b.code === 2 && report.status === 'refused') return { status: 'refused', report, files: null, devTrust: null };
        if (b.code !== 0 || report.status !== 'accepted') {
          return { status: 'error', report, files: null, devTrust: null, error: report.error ?? { code: 'BUILD_FAILED', detail: exited('build', b) } };
        }

        const s = await step(['sign', '--config', cfg.config, '--dir', out], cfg.signEnv, dir);
        if (s.timedOut) return errored('BUILDER_TIMEOUT', `signing did not finish in ${cfg.timeoutMs} ms`, report);
        if (s.spawnError) return errored('SIGNING_FAILED', `the builder's sign step could not be started: ${s.spawnError}`, report);
        if (s.code !== 0) return errored('SIGNING_FAILED', exited('sign', s), report);
        const signed = readJson(path.join(out, REPORT_FILE)) ?? report;
        const codeReview = readNamed(out, 'code_review.json');
        const spec = codeReview ? (() => { try { return JSON.parse(codeReview.toString('utf8')); } catch { return null; } })() : null;
        if (!spec) return errored('BUILDER_OUTPUT_INVALID', 'the build wrote no readable code_review.json', signed);
        const files = {
          codeReview,
          baseline: readNamed(out, spec.baseline),
          knownIssues: spec.stake?.knownIssues ? readNamed(out, spec.stake.knownIssues) : null,
          attestation: readNamed(out, spec.attestation),
        };
        if (!files.baseline || !files.attestation || (spec.stake?.knownIssues && !files.knownIssues)) {
          return errored('BUILDER_OUTPUT_INVALID', 'the build\'s output folder lacks a file code_review.json names', signed);
        }
        return { status: 'accepted', report: signed, files, devTrust: readJson(path.join(out, DEV_TRUST_FILE)) };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
