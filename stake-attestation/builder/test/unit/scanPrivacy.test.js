// Scan findings are the maker's alone (design §8.3: "nothing from it enters the record, the jury
// or the known-issues list unless the maker puts it there"). One test per place they could leak:
// the listing folder and its archive files, the record (the validation report and the
// attestation), the jury's inputs, known_issues.json, the command's output (CI logs) and a public
// artifact of the reusable workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { codeReview } from '../../src/common.js';
import { main } from '../../src/cli.js';
import { SCAN_FILE } from '../../src/scan.js';
import { KNOWN_ISSUES, writeAcceptedBuild } from '../helpers/build.js';
import { gitleaksResult, scanDeps, semgrepAnswer, semgrepResult } from '../helpers/scan.js';
import { draftSpec } from '../helpers/specs.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
// Strings that exist only in the scan's findings: a rule id, a message, a path and a secret.
const MARK = {
  rule: 'verdikta.solidity.marker-rule-5e1f',
  message: 'MARKER-finding-message-5e1f',
  path: 'src/MarkerOnly5e1f.sol',
  secret: 'MarkerSecret5e1fQ8LrT0pVb3NcX7mHs2KdW9fJy',
  title: 'MARKER-agent-title-5e1f',
};
const FILES = { 'src/Vault.sol': 'contract Vault {}', [MARK.path]: 'contract M {}' };

function io() {
  let out = '';
  let err = '';
  return { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, get out() { return out; }, get err() { return err; } };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vab-privacy-'));
}

function writeConfig(dir) {
  const file = path.join(dir, 'builder.json');
  fs.writeFileSync(file, JSON.stringify({ registry: { repository: 'ghcr.io/verdikta/stake-env' }, runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' }, workDir: dir }));
  return file;
}

/** Scan deps whose tools find every marker. */
function markedDeps(over = {}) {
  return scanDeps(FILES, {
    semgrep: { stdout: semgrepAnswer([semgrepResult({ rule: MARK.rule, path: MARK.path, line: 7, message: MARK.message })]) },
    gitleaks: { stdout: JSON.stringify([gitleaksResult({ path: MARK.path, line: 3, secret: MARK.secret })]) },
    ...over,
  });
}

function leaks(text) {
  return Object.values(MARK).filter((m) => text.includes(m));
}

/** Every file under `dir`, as text. */
function allText(dir) {
  return fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'latin1')).join('\n');
}

async function runScan(dir, { spec = draftSpec(), out = path.join(dir, 'maker-scan'), deps = markedDeps().deps } = {}) {
  const specFile = path.join(dir, 'scan-spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const t = io();
  const code = await main(['scan', '--config', writeConfig(dir), '--spec', specFile, '--out', out], { env: {}, ...t, deps });
  return { code, t, out };
}

test('the scan writes its findings only into the maker\'s own new folder, never into a listing folder', async () => {
  const dir = tmp();
  const listing = path.join(dir, 'listing');
  fs.mkdirSync(listing);
  await writeAcceptedBuild(listing, { knownIssues: KNOWN_ISSUES });
  const before = new Map(fs.readdirSync(listing).map((f) => [f, fs.readFileSync(path.join(listing, f))]));
  const into = await runScan(dir, { out: listing });
  assert.equal(into.code, 1);
  assert.match(into.t.err, /SCAN_OUT_NOT_EMPTY/);
  assert.deepEqual(fs.readdirSync(listing).sort(), [...before.keys()].sort(), 'nothing added to the listing folder');
  for (const [f, bytes] of before) assert.ok(fs.readFileSync(path.join(listing, f)).equals(bytes), `${f} untouched`);

  const own = await runScan(dir);
  assert.equal(own.code, 0, own.t.err);
  assert.deepEqual(fs.readdirSync(own.out), [SCAN_FILE]);
  const doc = JSON.parse(fs.readFileSync(path.join(own.out, SCAN_FILE), 'utf8'));
  assert.deepEqual(leaks(JSON.stringify(doc)).sort(), [MARK.message, MARK.path, MARK.rule].sort(), 'the maker gets the findings, never the secret');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sign refuses a listing folder that holds scan findings: they are never attested or shipped with the listing', async () => {
  const dir = tmp();
  const listing = path.join(dir, 'listing');
  fs.mkdirSync(listing);
  await writeAcceptedBuild(listing);
  const scan = await runScan(dir);
  fs.copyFileSync(path.join(scan.out, SCAN_FILE), path.join(listing, SCAN_FILE));
  const t = io();
  assert.equal(await main(['sign', '--config', writeConfig(dir), '--dir', listing], { env: {}, ...t }), 1);
  assert.match(t.err, /SCAN_RESULTS_IN_LISTING_DIR/);
  assert.equal(fs.existsSync(path.join(listing, 'attestation.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the listing archive, the record and known_issues.json carry nothing from the scan', async () => {
  const dir = tmp();
  const listing = path.join(dir, 'listing');
  fs.mkdirSync(listing);
  const { ki } = await writeAcceptedBuild(listing, { knownIssues: KNOWN_ISSUES });
  const scan = await runScan(dir, { spec: JSON.parse(fs.readFileSync(path.join(listing, 'code_review.json'), 'utf8')) });
  assert.equal(scan.code, 0, scan.t.err);
  const t = io();
  assert.equal(await main(['sign', '--config', writeConfig(dir), '--dir', listing], { env: {}, ...t }), 0, t.err);
  // The archive's files (code_review.json, the baseline, known_issues.json, attestation.json) and
  // the record's source (validation-report.json, the attestation) hold no finding.
  assert.deepEqual(fs.readdirSync(listing).sort(), ['attestation.json', 'baseline.json', 'code_review.json', 'dev-trust.json', 'known_issues.json', 'validation-report.json']);
  assert.deepEqual(leaks(allText(listing)), []);
  // known_issues.json is the maker's file, byte for byte: the scan never adds to it.
  assert.ok(fs.readFileSync(path.join(listing, 'known_issues.json')).equals(ki));
  assert.ok(ki.equals(KNOWN_ISSUES));
  // The attestation covers exactly the listing's three files: the scan has no place in it.
  const att = JSON.parse(fs.readFileSync(path.join(listing, 'attestation.json'), 'utf8'));
  assert.deepEqual(Object.keys(att.sha256).sort(), ['baseline', 'codeReview', 'knownIssues']);
  const report = JSON.parse(fs.readFileSync(path.join(listing, 'validation-report.json'), 'utf8'));
  assert.equal(Object.keys(report).some((k) => /scan/i.test(k)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the jury\'s inputs carry nothing from the scan: the claim query is a function of code_review.json alone', async () => {
  const dir = tmp();
  const listing = path.join(dir, 'listing');
  fs.mkdirSync(listing);
  await writeAcceptedBuild(listing, { knownIssues: KNOWN_ISSUES });
  const spec = JSON.parse(fs.readFileSync(path.join(listing, 'code_review.json'), 'utf8'));
  const before = codeReview.buildClaimQuery(spec);
  const scan = await runScan(dir, { spec });
  assert.equal(scan.code, 0, scan.t.err);
  const after = JSON.parse(fs.readFileSync(path.join(listing, 'code_review.json'), 'utf8'));
  assert.equal(codeReview.buildClaimQuery(after), before);
  assert.deepEqual(leaks(before), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the command\'s output (a CI log) names the file and nothing found: no rule, path, message, secret or count', async () => {
  const dir = tmp();
  const ok = await runScan(dir);
  assert.equal(ok.code, 0);
  for (const text of [ok.t.out, ok.t.err]) {
    assert.deepEqual(leaks(text), []);
    assert.doesNotMatch(text, /\b[0-9]+ (finding|result|secret|issue)s?\b/i, 'no count of findings');
    assert.doesNotMatch(text, /verdikta\.solidity\./);
  }
  assert.ok(ok.t.out.includes(path.join(ok.out, SCAN_FILE)));
  // A failing scanner whose own output carries a finding: still nothing but a code on the log.
  const failing = markedDeps({ semgrep: { exitCode: 2, stdout: semgrepAnswer([], [{ type: 'Syntax error', level: 'error', message: MARK.message, path: `/work/src/${MARK.path}` }]), stderr: `${MARK.rule} ${MARK.path}` } });
  const bad = await runScan(dir, { out: path.join(dir, 'maker-scan-2'), deps: failing.deps });
  assert.equal(bad.code, 1);
  assert.match(bad.t.err, /SCAN_TOOL_FAILED/);
  assert.deepEqual(leaks(`${bad.t.out}${bad.t.err}`), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the agent pass\'s candidates reach the maker\'s file only', async () => {
  const dir = tmp();
  const cfg = path.join(dir, 'builder-agent.json');
  fs.writeFileSync(cfg, JSON.stringify({
    registry: { repository: 'ghcr.io/verdikta/stake-env' },
    runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' },
    workDir: dir,
    scan: { agent: { provider: 'openrouter', model: 'qwen/qwen3-coder', apiUrl: 'https://provider.invalid/v1/chat/completions', apiKeyEnv: 'STUB_PROVIDER_TOKEN' } },
  }));
  const content = JSON.stringify({ findings: [{ class: 'HIGH', title: MARK.title, paths: ['src/Vault.sol'], rootCause: MARK.message, demonstration: 'a test' }] });
  const h = markedDeps({ deps: { agentFetch: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }) } });
  const specFile = path.join(dir, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(draftSpec()));
  const t = io();
  const out = path.join(dir, 'maker-scan');
  const code = await main(['scan', '--config', cfg, '--spec', specFile, '--out', out, '--agent'], { env: { STUB_PROVIDER_TOKEN: 'stub-bearer-for-tests' }, ...t, deps: h.deps });
  assert.equal(code, 0, t.err);
  assert.ok(fs.readFileSync(path.join(out, SCAN_FILE), 'utf8').includes(MARK.title));
  assert.deepEqual(leaks(`${t.out}${t.err}`), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no public artifact: the reusable builder workflow never runs the scan, and uploads only the listing folder and the image', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'stake-attestation-builder.yml'), 'utf8');
  assert.doesNotMatch(text, /verdikta-build-env(\.js)?"?\s+scan\b/);
  assert.equal(text.includes(SCAN_FILE), false);
  const wf = parseYaml(text);
  const uploads = Object.values(wf.jobs).flatMap((j) => j.steps).filter((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.ok(uploads.length >= 2);
  for (const u of uploads) assert.ok(['${{ env.VAB_OUT }}', '${{ env.VAB_IMAGE }}'].includes(u.with.path), `an upload of ${u.with.path}`);
});
