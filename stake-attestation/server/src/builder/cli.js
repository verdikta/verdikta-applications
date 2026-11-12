// The environment builder (stake-attestation/builder, nodes P3a, P3b) behind the interface the
// listing flow uses: build({ draft, knownIssues, maker, deploymentProof }) resolves to
//
//   { status: 'accepted', report, files: { codeReview, baseline, knownIssues, attestation }, devTrust }
//   { status: 'refused',  report, files: null, devTrust: null }
//   { status: 'error',    report|null, files: null, devTrust: null, error?: { code, detail }, holdSlot? }
//
// and scan({ spec }), the baseline scan (design §8.3), to
//
//   { status: 'ok'|'error', doc, error: null }        the builder's scan-findings.json, parsed
//   { status: 'error', doc: null, error: { code, detail }, holdSlot? }   no document came back
//
// `holdSlot: true` means the server had to stop the builder, so what it started may still be
// running under the Docker daemon: the listing flow then keeps that build slot taken (runStep).
//
// The scan's document is the maker's alone (node P4b2): `verdikta-build-env scan` writes it into
// a new folder inside the step's own folder (owner-only, as mkdtemp makes it), the server reads it
// once and removes the folder, and nothing the step printed is logged or returned beyond the
// builder's error code, because a scanner's output can name a finding.
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

import { PROOF_REFUSALS } from '@verdikta/stake-attestation-shared/control-proof';

const REPORT_FILE = 'validation-report.json';
const DEV_TRUST_FILE = 'dev-trust.json';
/** Where `verdikta-build-env scan` writes the maker's findings (the builder's SCAN_FILE, builder/src/outputs.js). */
export const SCAN_FILE = 'scan-findings.json';
const SCAN_MAX_BYTES = 16 * 1024 * 1024;
const PLAIN_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
const OUTPUT_CAP = 64 * 1024;
const DEFAULT_GRACE_MS = 30000;

const tail = (buf, n = 600) => buf.toString('utf8').slice(-n).trim();
// The builder's own error line, "verdikta-build-env: CODE: detail": only the code goes into a
// result the maker sees; the output itself stays in the server's log.
const builderCode = (buf) => /verdikta-build-env: (?:scan )?([A-Z][A-Z0-9_]{0,63})\b/.exec(buf.toString('utf8'))?.[1] ?? null;

export function childEnv(env, names, tmp) {
  const out = {};
  for (const n of ['PATH', 'HOME', ...names]) if (typeof env[n] === 'string') out[n] = env[n];
  // the builder's own temporary folders (and docker's, git's) go inside the server's build
  // folder, which is removed however the step ends
  out.TMPDIR = tmp;
  return out;
}

/**
 * Runs `node bin ...args` as the leader of its own process group, so a stop reaches everything
 * the step started (git, the docker CLI, an external signer), not only the builder.
 *
 * The server's timeout is a backstop: the builder bounds each of its own steps and cleans up
 * after them (it removes its sandbox containers in a finally), so SA_BUILDER_TIMEOUT_MS is set
 * above the sum of those limits and fires only for a builder that hangs. Then the group gets
 * SIGTERM, which the docker CLI forwards to the container it is attached to (and which cancels a
 * BuildKit build), and `graceMs` to finish; whatever is left gets SIGKILL. Anything of the group
 * still running when the builder exits is stopped the same way.
 *
 * The step settles only when the builder has exited and its process group is empty (polled
 * with signal 0): the builder's own children have pipes of their own, so the builder's pipes
 * closing says nothing about them. `interrupted` says the server had to signal the group (a
 * timeout, or members left when the builder exited), and `forced` that SIGKILL was needed. An
 * empty group does not show that a container the docker CLI started has gone: it runs under the
 * Docker daemon, and a client cut off mid-run can return without waiting for it. So after any
 * interruption the caller must not count the slot as free.
 * @returns {Promise<{ code: number|null, spawnError: string|null, timedOut: boolean, interrupted: boolean, forced: boolean, stdout: Buffer, stderr: Buffer }>}
 */
export function runStep({ nodePath, bin, args, env, timeoutMs, graceMs, cwd }) {
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
    const groupAlive = () => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (err) {
        return err.code === 'EPERM';
      }
    };
    let timedOut = false;
    let stopping = false;
    let forced = false;
    let exited = false;
    let closed = false;
    let exitCode = null;
    let done = false;
    let poll = null;
    let pipeWait = null;
    const timers = [];
    const finish = (r) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      if (poll) clearInterval(poll);
      if (pipeWait) clearTimeout(pipeWait);
      resolve({ ...r, timedOut, interrupted: stopping, forced, ...out });
    };
    const settle = () => {
      if (done || !exited) return;
      if (groupAlive()) {
        if (!poll) poll = setInterval(settle, 100);
        return;
      }
      if (closed) return finish({ code: exitCode, spawnError: null });
      // the group has gone, but something outside it still holds the pipes: keep what was read
      if (!pipeWait) {
        pipeWait = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code: exitCode, spawnError: null });
        }, 1000);
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killGroup('SIGTERM');
      timers.push(setTimeout(() => {
        if (!groupAlive() && exited) return;
        forced = true;
        killGroup('SIGKILL');
        // a member that cannot be killed (or a leader that never exits): stop waiting
        timers.push(setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code: exitCode, spawnError: null });
        }, graceMs));
      }, graceMs));
    };
    timers.push(setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs));
    child.on('error', (err) => finish({ code: null, spawnError: err.message }));
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      if (groupAlive()) stop();
      settle();
    });
    child.on('close', () => {
      closed = true;
      settle();
    });
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

const errored = (code, detail, report = null, extra = {}) => ({ status: 'error', report, files: null, devTrust: null, error: { code, detail }, ...extra });
const scanErrored = (code, detail, extra = {}) => ({ status: 'error', doc: null, error: { code, detail }, ...extra });

/** Why a stopped step ended: its slot stays taken (holdSlot), since daemon cleanup is unconfirmed. */
function stopReason(what, r, cfg) {
  const how = r.forced ? 'and was killed (it did not stop on SIGTERM)' : 'and was stopped';
  if (r.timedOut) return { code: 'BUILDER_TIMEOUT', detail: `the builder's ${what} step did not finish in ${cfg.timeoutMs} ms ${how}` };
  return { code: 'BUILDER_INTERRUPTED', detail: `the builder's ${what} step left processes running when it exited, which were stopped ${r.forced ? 'with SIGKILL' : 'with SIGTERM'}` };
}

function stopped(what, r, cfg, report) {
  const { code, detail } = stopReason(what, r, cfg);
  return errored(code, detail, report, { holdSlot: true });
}

/** Why the builder config cannot be used, or null. */
function configProblem(cfg) {
  if (!cfg.config) return { code: 'BUILDER_NOT_CONFIGURED', detail: 'no builder config is set (SA_BUILDER_CONFIG)' };
  const builderConfig = readJson(cfg.config);
  if (!builderConfig || typeof builderConfig !== 'object') return { code: 'BUILDER_CONFIG_INVALID', detail: 'the builder config (SA_BUILDER_CONFIG) is not a JSON object' };
  if (Object.hasOwn(builderConfig, 'workDir')) {
    // a folder of the builder's choosing would outlive a build the server has to stop
    return { code: 'BUILDER_CONFIG_INVALID', detail: 'leave workDir out of the builder config: the server gives each build a temporary folder of its own (TMPDIR) and removes it' };
  }
  return null;
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The scan's document, or what is wrong with it. Never the parser's message or any of the file's
 * text: both can quote a finding.
 */
function readScanDoc(out) {
  const file = path.join(out, SCAN_FILE);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { missing: true };
  }
  if (!st.isFile()) return { problem: { code: 'SCAN_OUTPUT_INVALID', detail: `the scan's ${SCAN_FILE} is not a regular file` } };
  if (st.size > SCAN_MAX_BYTES) return { problem: { code: 'SCAN_OUTPUT_TOO_LARGE', detail: `the scan's ${SCAN_FILE} is larger than ${SCAN_MAX_BYTES} bytes` } };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { problem: { code: 'SCAN_OUTPUT_INVALID', detail: `the scan's ${SCAN_FILE} is not JSON` } };
  }
  if (!isObject(doc) || doc.kind !== 'verdikta-baseline-scan' || doc.audience !== 'maker' || !['ok', 'error'].includes(doc.status) || !Array.isArray(doc.findings)) {
    return { problem: { code: 'SCAN_OUTPUT_INVALID', detail: `the scan's ${SCAN_FILE} is not a baseline scan document` } };
  }
  return { doc };
}

/**
 * @param {{ bin: string, config: string|null, workDir: string, buildEnv: string[], signEnv: string[], scanEnv?: string[], scanAgent?: boolean, timeoutMs: number, graceMs?: number }} cfg - config.builder
 * @param {{ env?: Record<string, string|undefined>, nodePath?: string, logger?: { warn: Function } }} [o]
 */
export function createCliBuilder(cfg, { env = process.env, nodePath = process.execPath, logger = null } = {}) {
  const graceMs = cfg.graceMs ?? DEFAULT_GRACE_MS;
  const step = (args, names, cwd) => runStep({ nodePath, bin: cfg.bin, args, env: childEnv(env, names, path.join(cwd, 'tmp')), timeoutMs: cfg.timeoutMs, graceMs, cwd });
  const exited = (what, r) => {
    logger?.warn(`builder ${what} exited ${r.code}: ${tail(r.stderr)}`);
    const code = builderCode(r.stderr);
    return `the builder's ${what} step exited ${r.code}${code ? `: ${code}` : ''}`;
  };

  return {
    async build({ draft, knownIssues, maker = null, deploymentProof = null }) {
      const problem = configProblem(cfg);
      if (problem) return errored(problem.code, problem.detail);
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
        // the project's proof: the builder reads the repository for itself, and refuses without it
        if (maker) args.push('--maker', maker);
        if (deploymentProof) {
          const proofPath = path.join(dir, 'control-proof.json');
          fs.writeFileSync(proofPath, `${JSON.stringify(deploymentProof)}\n`);
          args.push('--control-proof', proofPath);
        }
        const out = path.join(dir, 'out');
        args.push('--out', out);

        const b = await step(args, cfg.buildEnv, dir);
        if (b.interrupted) return stopped('build', b, cfg, readJson(path.join(out, REPORT_FILE)));
        if (b.spawnError) return errored('BUILDER_FAILED', `the builder could not be started: ${b.spawnError}`);
        const report = readJson(path.join(out, REPORT_FILE));
        if (!report) return errored('BUILDER_NO_REPORT', `${exited('build', b)}, with no validation report`);
        if (b.code === 2 && report.status === 'refused') return { status: 'refused', report, files: null, devTrust: null };
        if (b.code !== 0 || report.status !== 'accepted') {
          return { status: 'error', report, files: null, devTrust: null, error: report.error ?? { code: 'BUILD_FAILED', detail: exited('build', b) } };
        }

        const s = await step(['sign', '--config', cfg.config, '--dir', out, ...(maker ? ['--maker', maker] : [])], cfg.signEnv, dir);
        if (s.interrupted) return stopped('sign', s, cfg, report);
        if (s.spawnError) return errored('SIGNING_FAILED', `the builder's sign step could not be started: ${s.spawnError}`, report);
        // the builder's exit status: 2 is a refusal, and as in build its report says why (node P11)
        if (s.code === 2) {
          const refused = readJson(path.join(out, REPORT_FILE));
          if (refused?.status === 'refused') return { status: 'refused', report: refused, files: null, devTrust: null };
        }
        if (s.code !== 0) {
          // sign reads the project's proof again: one that no longer stands is a refusal like the build's
          const refusedFor = builderCode(s.stderr);
          if (refusedFor && Object.hasOwn(PROOF_REFUSALS, refusedFor)) {
            logger?.warn(`builder sign refused the listing: ${refusedFor}`);
            const detail = PROOF_REFUSALS[refusedFor];
            return { status: 'refused', report: { ...report, status: 'refused', refusals: [{ code: refusedFor, detail, step: 'sign' }] }, files: null, devTrust: null };
          }
          return errored('SIGNING_FAILED', exited('sign', s), report);
        }
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

    /** The baseline scan of `spec` (the listing's code_review.json): see the head of this file. */
    async scan({ spec }) {
      const problem = configProblem(cfg);
      if (problem) return scanErrored(problem.code, problem.detail);
      const dir = fs.mkdtempSync(path.join(cfg.workDir, 'sa-scan-'));
      try {
        fs.mkdirSync(path.join(dir, 'tmp'));
        const specPath = path.join(dir, 'code_review.json');
        fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
        // a new folder, which the builder makes owner-only, inside this owner-only one
        const out = path.join(dir, 'scan');
        const args = ['scan', '--config', cfg.config, '--spec', specPath, '--out', out, ...(cfg.scanAgent ? ['--agent'] : [])];
        const r = await step(args, cfg.scanEnv ?? [], dir);
        if (r.interrupted) {
          const { code, detail } = stopReason('scan', r, cfg);
          return scanErrored(code, detail, { holdSlot: true });
        }
        if (r.spawnError) return scanErrored('SCAN_STEP_FAILED', 'the builder\'s scan step could not be started');
        const code = r.code === 0 ? null : builderCode(r.stderr);
        // the exit status and the builder's error code, never its output
        if (r.code !== 0) logger?.warn(`builder scan exited ${r.code}${code ? `: ${code}` : ''}`);
        const read = readScanDoc(out);
        if (read.missing) {
          return scanErrored('SCAN_STEP_FAILED', r.code === 0 ? `the builder's scan step exited 0 and wrote no ${SCAN_FILE}` : `the builder's scan step exited ${r.code}${code ? `: ${code}` : ''}`);
        }
        if (read.problem) return scanErrored(read.problem.code, read.problem.detail);
        return { status: r.code === 0 && read.doc.status === 'ok' ? 'ok' : 'error', doc: read.doc, error: null };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
