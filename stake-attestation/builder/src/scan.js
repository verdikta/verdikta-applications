// The baseline scan (design §8.3; node P3b): between listing and open, the site scans the staked
// version for the bugs that are cheap to find, so the stake pays for findings that take work.
//
//   fetch     the listed commit's objects, by id (src/git.js), and its files from them
//             (src/commitFiles.js; submodules are not scanned)
//   scope     the files stake.scope includes and does not exclude; symbolic links are not followed
//   semgrep   Verdikta's pinned Solidity rules (src/scanTools.js) over those files
//   secrets   the pinned secret scanner over the same files
//   agent     with --agent only: one model of the code-standard pool (src/agent.js)
//
// The result, scan-findings.json, is the maker's alone. It is not a judgement and pays nobody:
// nothing from it enters the listing archive, the record, the jury's inputs or known_issues.json
// unless the maker puts it there. So it is written only into a new folder of its own (owner-only
// permissions), never into a build's output folder (`sign` refuses one that holds it), and the
// command prints where it is and nothing of what it says, not even a count.
import fs from 'node:fs';
import path from 'node:path';

import { runAgentPass } from './agent.js';
import { codeReview } from './common.js';
import { commitTree as commitTreeDefault } from './commitFiles.js';
import { createDocker, runSandboxed } from './docker.js';
import { BuilderError } from './errors.js';
import { fetchListedCommit as fetchDefault } from './git.js';
import { SCAN_FILE } from './outputs.js';
import {
  GITLEAKS_CONFIG_FILES, GITLEAKS_MAX_MB, SCAN_TOOLS, SEMGREP_MAX_BYTES,
  gitleaksArgv, loadRules, parseGitleaks, parseGitleaksLog, parseSemgrep, scannerInput, semgrepArgv,
} from './scanTools.js';
import { checkDraft, serializeJson } from './spec.js';
import { BUILDER_VERSION } from './version.js';

export { SCAN_FILE };
export const SCAN_NOTICE = 'For the maker only. Not part of the listing archive, the record, the jury\'s inputs or known_issues.json: publish nothing from it, and list a finding as a known issue only by writing it there yourself.';

const FETCH_TIMEOUT_MS = 600000;
const TOOL_TIMEOUT_MS = 900000;
const TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;
const TOOL_ORDER = { semgrep: 0, gitleaks: 1, agent: 2 };

function newDoc(spec) {
  const stake = spec && spec.stake && typeof spec.stake === 'object' ? spec.stake : {};
  return {
    version: 1,
    kind: 'verdikta-baseline-scan',
    audience: 'maker',
    notice: SCAN_NOTICE,
    builder: { version: BUILDER_VERSION },
    createdAt: new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z'),
    status: 'pending',
    listing: {
      repo: spec?.repo ?? null,
      baseCommit: spec?.baseCommit ?? null,
      artifact: spec?.artifact ?? { kind: 'repo' },
      lowestClassCounted: stake.lowestClassCounted ?? null,
      scope: stake.scope ?? null,
    },
    // inScope: the files the scope names; skipped: in scope but given to no tool (links, submodules).
    // Each tool's notScanned: files it was given or meant for and did not read, and why.
    files: { inScope: [], skipped: [] },
    tools: {
      semgrep: { version: SCAN_TOOLS.semgrep.version, image: SCAN_TOOLS.semgrep.image, rules: { version: SCAN_TOOLS.rules.version, sha256: SCAN_TOOLS.rules.sha256 }, status: 'pending', analysed: 0, notScanned: [], errors: [] },
      secrets: { tool: 'gitleaks', version: SCAN_TOOLS.gitleaks.version, image: SCAN_TOOLS.gitleaks.image, status: 'pending', notScanned: [] },
      agent: { status: 'off' },
    },
    findings: [],
    error: null,
  };
}

/** The in-scope regular files of the listed commit, and what was left out and why. */
export function inScopeFiles(entries, scope, skippedSubmodules = []) {
  const skipped = skippedSubmodules.map((s) => ({ path: s.path, detail: s.detail }));
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const { inScope } = codeReview.splitByStakeScope(entries.map((e) => e.path), scope);
  const files = [];
  for (const p of inScope) {
    const e = byPath.get(p);
    if (e.mode === '120000') skipped.push({ path: p, detail: 'a symbolic link: not followed' });
    else files.push({ path: p, bytes: e.bytes });
  }
  return { files, skipped };
}

/** Pulls a pinned image by digest unless the daemon has it (the daemon checks every byte against the digest). */
async function ensureImage(docker, image, platform) {
  const have = await docker.run(['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 60000 });
  if (have.exitCode === 0) return;
  const r = await docker.run(['pull', '--quiet', '--platform', platform, image], { timeoutMs: 900000 });
  if (r.spawnError || r.exitCode !== 0) throw new BuilderError('SCAN_TOOL_UNAVAILABLE', `the pinned image ${image} could not be pulled`, { step: 'scan' });
}

async function runTool({ docker, image, platform, argv, stdin, tool }) {
  // No logging driver: the findings a scanner prints reach this process and nothing the daemon ships.
  const r = await runSandboxed({ docker, image, platform, argv, stdin, timeoutMs: TOOL_TIMEOUT_MS, maxBytes: TOOL_OUTPUT_BYTES, keepLogs: false });
  if (r.spawnError) throw new BuilderError('DOCKER_UNAVAILABLE', r.spawnError, { step: 'scan' });
  if (r.timedOut) throw new BuilderError('SCAN_TOOL_FAILED', `${tool} did not finish in ${TOOL_TIMEOUT_MS / 1000} s`, { step: 'scan' });
  if (r.stdoutTruncated) throw new BuilderError('SCAN_TOOL_FAILED', `${tool}'s output was cut at ${TOOL_OUTPUT_BYTES} bytes`, { step: 'scan' });
  return r;
}

/** Byte order, whatever the host's locale. */
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

function sortFindings(list) {
  return [...list].sort((a, b) => (TOOL_ORDER[a.tool] - TOOL_ORDER[b.tool])
    || cmp(String(a.path ?? a.paths?.[0] ?? ''), String(b.path ?? b.paths?.[0] ?? ''))
    || (a.line ?? 0) - (b.line ?? 0)
    || cmp(String(a.rule ?? a.title), String(b.rule ?? b.title)));
}

const WITHHELD = '[line withheld from the agent pass: the secret scan flagged it]';
const MAX_NOT_SCANNED = 500;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Text the secret scanner reads line by line: valid UTF-8 with no NUL byte (no archive, no binary). */
function isText(bytes) {
  if (bytes.includes(0)) return false;
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The in-scope files as the agent pass may see them: only those the secret scanner opened and
 * did not skip, and that are plain text; every line it flagged replaced.
 * @param {{ path: string, bytes: Buffer }[]} files
 * @param {object[]} secrets - every secret finding (parseGitleaks().all)
 * @param {{ opened: Set<string>, skipped: { path: string }[] }} log - parseGitleaksLog()
 * @returns {{ files: { path: string, bytes: Buffer }[], withheld: { lines: number, files: string[] } }}
 */
export function withholdSecrets(files, secrets, log) {
  const lines = new Map();
  for (const f of secrets) {
    const set = lines.get(f.path) ?? new Set();
    for (let n = f.line; n <= Math.max(f.line, f.endLine); n += 1) set.add(n);
    lines.set(f.path, set);
  }
  const skipped = log.skipped.map((x) => x.path);
  const out = [];
  const left = [];
  let count = 0;
  for (const f of files) {
    if (!log.opened.has(f.path) || skipped.some((p) => f.path === p || f.path.startsWith(`${p}/`)) || !isText(f.bytes)) {
      left.push(f.path);
      continue;
    }
    const flagged = lines.get(f.path);
    if (!flagged) {
      out.push(f);
      continue;
    }
    const text = f.bytes.toString('utf8').split('\n').map((l, i) => (flagged.has(i + 1) ? WITHHELD : l));
    count += flagged.size;
    out.push({ path: f.path, bytes: Buffer.from(text.join('\n'), 'utf8') });
  }
  return { files: out, withheld: { lines: count, files: left } };
}

/**
 * Scans a listing's staked version. Never throws for what happens during the scan: a failure is
 * recorded in the returned document (status "error"), which is the maker's.
 * @param {object} o
 * @param {object} o.spec - the listing's code_review.json (the draft or the built one)
 * @param {object} o.config - parseConfig()
 * @param {object} [o.deps] - doubles: docker, fetchListedCommit, commitTree, rulesDir, agentFetch
 * @param {string} [o.workDir] - where the temporary folder is made (default config.workDir)
 * @param {boolean} [o.agent] - run the agent pass (off unless asked for)
 * @returns {Promise<{ status: 'ok'|'error', doc: object }>}
 */
export async function scanListing({ spec, config, deps = {}, workDir, agent = false }) {
  const doc = newDoc(spec);
  let tmp = null;
  try {
    const v = checkDraft(spec);
    if (!v.ok) throw new BuilderError('SPEC_INVALID', `code_review.json does not validate: ${v.issues.map((i) => i.code).join(', ')}`, { step: 'scan' });
    if (agent && !config.scan.agent) throw new BuilderError('AGENT_NOT_CONFIGURED', 'the agent pass needs scan.agent in the config', { step: 'scan' });
    const rules = loadRules(deps.rulesDir);
    const docker = deps.docker ?? createDocker({ bin: config.docker.bin, host: config.docker.host });
    const fetchListedCommit = deps.fetchListedCommit ?? fetchDefault;
    const commitTree = deps.commitTree ?? commitTreeDefault;
    const platform = config.platforms.run;

    tmp = fs.mkdtempSync(path.join(workDir ?? config.workDir, 'vab-scan-'));
    const gitDir = path.join(tmp, 'fetched.git');
    await fetchListedCommit({ repo: spec.repo, baseCommit: spec.baseCommit, mirror: config.mirrorFor(spec.repo), dir: gitDir, timeoutMs: FETCH_TIMEOUT_MS });
    const tree = await commitTree({ gitDir, repo: spec.repo, baseCommit: spec.baseCommit, mirrorFor: config.mirrorFor, workDir: tmp, submodules: false });
    const { files, skipped } = inScopeFiles(tree.entries, spec.stake.scope, tree.skipped);
    doc.files = { inScope: files.map((f) => f.path), skipped };

    for (const tool of [SCAN_TOOLS.semgrep, SCAN_TOOLS.gitleaks]) await ensureImage(docker, tool.image, platform);
    const found = [];
    let failure = null;

    // Semgrep's rules are Solidity's: it is given the in-scope .sol files within its size limit,
    // and every one it does not report as analysed is named.
    const sol = files.filter((f) => f.path.endsWith('.sol'));
    const forSemgrep = sol.filter((f) => f.bytes.length <= SEMGREP_MAX_BYTES);
    const semNot = sol.filter((f) => f.bytes.length > SEMGREP_MAX_BYTES).map((f) => ({ path: f.path, detail: `over Semgrep's per-file limit of ${SEMGREP_MAX_BYTES} bytes: not analysed` }));
    try {
      const input = [...forSemgrep.map((f) => ({ path: `src/${f.path}`, bytes: f.bytes })), { path: `rules/${rules.name}`, bytes: rules.bytes }];
      const r = await runTool({ docker, image: SCAN_TOOLS.semgrep.image, platform, argv: semgrepArgv(), stdin: scannerInput(input), tool: 'semgrep' });
      if (r.exitCode !== 0 && r.exitCode !== 1) throw new BuilderError('SCAN_TOOL_FAILED', `semgrep exited ${r.exitCode}`, { step: 'scan' });
      const s = parseSemgrep(r.stdout);
      // Semgrep lists a file as scanned even when it dropped its results, past the match cap, say: that file is not counted.
      const analysed = new Set(s.scanned.filter((p) => !s.unread.has(p)));
      for (const f of forSemgrep) {
        if (s.unread.has(f.path)) semNot.push({ path: f.path, detail: s.unread.get(f.path) });
        else if (!analysed.has(f.path)) semNot.push({ path: f.path, detail: 'Semgrep did not analyse it' });
      }
      doc.tools.semgrep.status = 'ok';
      doc.tools.semgrep.analysed = forSemgrep.filter((f) => analysed.has(f.path)).length;
      doc.tools.semgrep.errors = s.errors;
      if (s.truncated) doc.tools.semgrep.truncated = true;
      if (s.errorsTruncated) doc.tools.semgrep.errorsTruncated = true;
      found.push(...s.findings);
    } catch (err) {
      doc.tools.semgrep.status = 'failed';
      failure ??= err;
    }
    doc.tools.semgrep.notScanned = semNot.slice(0, MAX_NOT_SCANNED);
    if (semNot.length > MAX_NOT_SCANNED) doc.tools.semgrep.notScannedTruncated = true;

    // The secret scanner gets every in-scope file but its own configuration files (which would
    // change its rules); what it opens and what it skips, its trace log says.
    const forSecrets = files.filter((f) => !GITLEAKS_CONFIG_FILES.includes(f.path));
    const secNot = files.filter((f) => GITLEAKS_CONFIG_FILES.includes(f.path)).map((f) => ({ path: f.path, detail: 'the secret scanner\'s own configuration file: not given to it, so it cannot change the scan' }));
    let secrets = null;
    try {
      const r = await runTool({ docker, image: SCAN_TOOLS.gitleaks.image, platform, argv: gitleaksArgv(), stdin: scannerInput(forSecrets.map((f) => ({ path: `src/${f.path}`, bytes: f.bytes }))), tool: 'gitleaks' });
      if (r.exitCode !== 0) throw new BuilderError('SCAN_TOOL_FAILED', `gitleaks exited ${r.exitCode}`, { step: 'scan' });
      const g = parseGitleaks(r.stdout);
      const log = parseGitleaksLog(r.stderr, { paths: forSecrets.map((f) => f.path) });
      secNot.push(...log.skipped);
      const named = new Set(secNot.map((x) => x.path));
      for (const f of forSecrets) {
        if (f.bytes.length > GITLEAKS_MAX_MB * 1000000 && !named.has(f.path)) secNot.push({ path: f.path, detail: `over the secret scanner's per-file limit of ${GITLEAKS_MAX_MB} MB: not read` });
      }
      doc.tools.secrets.status = 'ok';
      if (g.truncated) doc.tools.secrets.truncated = true;
      // A cut log may have lost a skip: then what the scanner read is not known.
      if (r.stderrTruncated) doc.tools.secrets.logTruncated = true;
      else secrets = { all: g.all, log };
      found.push(...g.findings);
    } catch (err) {
      doc.tools.secrets.status = 'failed';
      failure ??= err;
    }
    doc.tools.secrets.notScanned = secNot.slice(0, MAX_NOT_SCANNED);
    if (secNot.length > MAX_NOT_SCANNED) doc.tools.secrets.notScannedTruncated = true;

    if (agent) {
      // The model is given only source the secret scan read, its flagged lines withheld.
      let a;
      if (secrets) {
        const { files: forAgent, withheld } = withholdSecrets(files, secrets.all, secrets.log);
        a = await runAgentPass({ agent: config.scan.agent, spec, files: forAgent, fetch: deps.agentFetch });
        if (a.summary.status === 'ok') a.summary.withheld = withheld;
      } else {
        a = { summary: { status: 'failed', provider: config.scan.agent.provider, model: config.scan.agent.model, code: 'AGENT_NEEDS_SECRET_SCAN', detail: 'the agent pass runs only on source the secret scan is known to have read' }, findings: [] };
      }
      doc.tools.agent = a.summary;
      found.push(...a.findings);
      if (a.summary.status !== 'ok') failure ??= new BuilderError(a.summary.code, 'the agent pass failed', { step: 'scan' });
    }

    doc.findings = sortFindings(found);
    if (failure) throw failure;
    doc.status = 'ok';
  } catch (err) {
    doc.status = 'error';
    doc.error = { code: err instanceof BuilderError ? err.code : 'SCAN_FAILED', detail: err instanceof BuilderError ? err.detail : String(err?.message ?? err) };
    for (const t of [doc.tools.semgrep, doc.tools.secrets]) if (t.status === 'pending') t.status = 'not_run';
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { status: doc.status, doc };
}

/**
 * Writes the maker's scan into `dir`, which must be new or empty: a folder of its own, never a
 * build's output folder. Owner-only permissions.
 * @returns {string} the file written
 * @throws {BuilderError} SCAN_OUT_NOT_EMPTY
 */
export function writeScan(dir, doc) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new BuilderError('SCAN_OUT_NOT_EMPTY', `${dir} is not empty: the scan's findings go into a folder of their own, never beside a listing's files`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, SCAN_FILE);
  fs.writeFileSync(file, serializeJson(doc), { mode: 0o600, flag: 'wx' });
  return file;
}
