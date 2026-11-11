// The baseline scan (design §8.3; node P3b acceptance 1): Semgrep with Verdikta's pinned Solidity
// rules and a pinned secret scanner, over the listing's in-scope paths only, each in a sandbox
// with no network, fed on stdin; the findings JSON is the maker's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { SCAN_FILE, scanListing, writeScan } from '../../src/scan.js';
import { RULES_DIR, SCAN_TOOLS, SEMGREP_MAX_BYTES, loadRules, parseGitleaks, parseSemgrep } from '../../src/scanTools.js';
import { decodeInput, gitleaksResult, scanDeps, semgrepAnswer, semgrepResult } from '../helpers/scan.js';
import { draftSpec } from '../helpers/specs.js';

const FILES = {
  'src/Vault.sol': 'contract Vault {}',
  'src/lib/Math.sol': 'library Math {}',
  'src/mocks/MockToken.sol': 'contract MockToken {}',
  'test/Vault.t.sol': 'contract VaultTest {}',
  'script/Deploy.s.sol': 'contract Deploy {}',
  'foundry.toml': '[profile.default]',
  'src/Link.sol': { mode: '120000', text: 'Vault.sol' },
};
const SCOPE = { include: ['src/**'], exclude: ['src/mocks/**'] };

function config(over = {}) {
  return parseConfig({
    registry: { repository: 'ghcr.io/verdikta/stake-env' },
    runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' },
    ...over,
  }, { baseDir: '/tmp', env: {} });
}

function spec() {
  return draftSpec({ stake: { ...draftSpec().stake, scope: SCOPE } });
}

async function scan(files = FILES, over = {}) {
  const h = scanDeps(files, over);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-scan-'));
  try {
    const out = await scanListing({ spec: over.spec ?? spec(), config: over.config ?? config(), deps: h.deps, workDir, agent: over.agent ?? false });
    assert.deepEqual(fs.readdirSync(workDir), [], 'the scan removed its temporary folder');
    return { ...out, ...h };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test('Semgrep, its Solidity rules and the secret scanner are pinned by version and digest', () => {
  for (const tool of [SCAN_TOOLS.semgrep, SCAN_TOOLS.gitleaks]) {
    assert.match(tool.image, /^docker\.io\/[a-z0-9-]+\/[a-z0-9-]+@sha256:[0-9a-f]{64}$/, 'pulled and run by digest only');
    assert.match(tool.version, /^v?[0-9]+\.[0-9]+\.[0-9]+$/, 'an exact release');
  }
  assert.equal(SCAN_TOOLS.semgrep.version, '1.181.0');
  assert.equal(SCAN_TOOLS.gitleaks.version, 'v8.30.1');
  // The rule set is Verdikta's: the version common pins, and this file's exact bytes.
  assert.equal(SCAN_TOOLS.rules.version, codeReview.SEMGREP_RULES_VERSION);
  const bytes = fs.readFileSync(path.join(RULES_DIR, SCAN_TOOLS.rules.file));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), SCAN_TOOLS.rules.sha256, 'a rule change needs a new pin');
  const rules = parseYaml(bytes.toString('utf8')).rules;
  assert.ok(rules.length >= 6);
  for (const r of rules) {
    assert.match(r.id, /^verdikta\.solidity\.[a-z0-9-]+$/);
    assert.deepEqual(r.languages, ['solidity']);
    assert.ok(['ERROR', 'WARNING'].includes(r.severity));
  }
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  // A message naming a metavariable would carry source text into a finding.
  for (const r of rules) assert.doesNotMatch(r.message, /\$/, `${r.id}'s message names no metavariable`);
});

test('rules that are not the pinned bytes are refused before anything runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-rules-'));
  fs.writeFileSync(path.join(dir, SCAN_TOOLS.rules.file), 'rules: []\n');
  assert.throws(() => loadRules(dir), (err) => err.code === 'SCAN_RULES_MODIFIED');
  const { status, doc, docker } = await scan(FILES, { deps: { rulesDir: dir } });
  assert.equal(status, 'error');
  assert.equal(doc.error.code, 'SCAN_RULES_MODIFIED');
  assert.equal(docker.calls.filter((c) => c.args[0] === 'run').length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Node P21: the scan refuses what the build refuses, by the same code: stake.documents is not offered yet.
test('a spec naming stake.documents is not scanned: documents are not offered yet', async () => {
  const { status, doc, docker } = await scan(FILES, { spec: draftSpec({ stake: { ...spec().stake, documents: ['README.md'] } }) });
  assert.equal(status, 'error');
  assert.equal(doc.error.code, 'STAKE_DOCUMENTS_NOT_OFFERED');
  assert.match(doc.error.detail, /documents are not offered yet/i);
  assert.equal(docker.calls.length, 0);
});

test('both scanners run in a sandbox with no network, a read-only root and uid 10001, from the pinned digests, never pulling at run time', async () => {
  const { status, runs, docker } = await scan(FILES, { present: false });
  assert.equal(status, 'ok');
  assert.deepEqual(runs.map((r) => r.image), [SCAN_TOOLS.semgrep.image, SCAN_TOOLS.gitleaks.image]);
  for (const { args } of runs) {
    const flag = (name) => args[args.indexOf(name) + 1];
    assert.equal(flag('--network'), 'none');
    assert.equal(flag('--pull'), 'never');
    assert.equal(flag('--user'), '10001:10001');
    assert.ok(args.includes('--read-only'));
    assert.equal(flag('--cap-drop'), 'ALL');
    assert.equal(flag('--security-opt'), 'no-new-privileges');
    // Nothing of the host is mounted: the files arrive on stdin.
    assert.ok(!args.some((a) => a === '-v' || a === '--volume' || a === '--mount' || a.startsWith('--volume=') || a.startsWith('--mount=')));
    assert.ok(args.includes('--interactive'));
    assert.equal(flag('--log-driver'), 'none', 'what a scanner prints is never kept by the daemon');
  }
  // The images are pulled by digest (the daemon checks every byte) before the sandboxes start.
  const pulls = docker.calls.filter((c) => c.args[0] === 'pull').map((c) => c.args.at(-1));
  assert.deepEqual(pulls.sort(), [SCAN_TOOLS.gitleaks.image, SCAN_TOOLS.semgrep.image].sort());
});

test('only the in-scope paths are scanned: scope.include less scope.exclude, no symbolic link followed', async () => {
  const { doc, runs } = await scan();
  assert.deepEqual(doc.files.inScope, ['src/Vault.sol', 'src/lib/Math.sol']);
  assert.deepEqual(doc.files.skipped, [{ path: 'src/Link.sol', detail: 'a symbolic link: not followed' }]);
  for (const r of runs) {
    const fed = decodeInput(r.stdin);
    const src = [...fed.keys()].filter((p) => p.startsWith('src/')).map((p) => p.slice(4));
    assert.deepEqual(src.sort(), ['src/Vault.sol', 'src/lib/Math.sol'].sort());
    assert.equal(fed.get('src/src/Vault.sol'), 'contract Vault {}');
  }
  // Semgrep gets the pinned rules with the files; the secret scanner gets only the files.
  assert.ok(decodeInput(runs[0].stdin).get(`rules/${SCAN_TOOLS.rules.file}`).includes('verdikta.solidity.'));
  assert.equal([...decodeInput(runs[1].stdin).keys()].some((p) => p.startsWith('rules/')), false);
});

test('a listing whose scope matches no file is scanned as empty, not refused', async () => {
  const { status, doc } = await scan({ 'contracts/A.sol': 'contract A {}' });
  assert.equal(status, 'ok');
  assert.deepEqual(doc.files.inScope, []);
  assert.deepEqual(doc.findings, []);
});

test('the findings JSON: Semgrep results and secrets, repository paths, sorted, no secret value kept', async () => {
  const secret = 'Zq8LrT0pVb3NcX7mHs2KdW9fJy4GaE6uRo1iQtPz';
  const { status, doc } = await scan(FILES, {
    semgrep: { stdout: semgrepAnswer([
      semgrepResult({ rule: 'verdikta.solidity.unchecked-low-level-call', path: 'src/lib/Math.sol', line: 9, severity: 'WARNING', message: 'ignored result' }),
      semgrepResult({ rule: 'verdikta.solidity.tx-origin-auth', path: 'src/Vault.sol', line: 4, message: 'tx.origin auth' }),
    ]) },
    gitleaks: { stdout: JSON.stringify([gitleaksResult({ path: 'src/Vault.sol', line: 2, secret })]) },
  });
  assert.equal(status, 'ok');
  assert.equal(doc.kind, 'verdikta-baseline-scan');
  assert.equal(doc.audience, 'maker');
  assert.deepEqual(doc.findings, [
    { tool: 'semgrep', rule: 'verdikta.solidity.tx-origin-auth', severity: 'error', path: 'src/Vault.sol', line: 4, endLine: 4, message: 'tx.origin auth' },
    { tool: 'semgrep', rule: 'verdikta.solidity.unchecked-low-level-call', severity: 'warning', path: 'src/lib/Math.sol', line: 9, endLine: 9, message: 'ignored result' },
    { tool: 'gitleaks', rule: 'generic-api-key', severity: 'error', path: 'src/Vault.sol', line: 2, endLine: 2, message: 'Detected a Generic API Key' },
  ]);
  assert.ok(!JSON.stringify(doc).includes(secret), 'the secret itself is never copied into the findings');
  assert.deepEqual(doc.tools.semgrep, { version: SCAN_TOOLS.semgrep.version, image: SCAN_TOOLS.semgrep.image, rules: { version: SCAN_TOOLS.rules.version, sha256: SCAN_TOOLS.rules.sha256 }, status: 'ok', analysed: 2, notScanned: [], errors: [] });
  assert.deepEqual(doc.tools.secrets, { tool: 'gitleaks', version: SCAN_TOOLS.gitleaks.version, image: SCAN_TOOLS.gitleaks.image, status: 'ok', notScanned: [] });
  assert.deepEqual(doc.tools.agent, { status: 'off' });
  assert.deepEqual(doc.listing, { repo: spec().repo, baseCommit: spec().baseCommit, artifact: { kind: 'repo' }, lowestClassCounted: 'MEDIUM', scope: SCOPE });
});

test('parsers keep only what the maker needs: rule, path, lines, message; never a source line or a secret', () => {
  // An error's message can quote the source (a secret literal in a file Semgrep could not parse):
  // only its kind, level and place are kept.
  const secret = 'Zq8LrT0pVb3NcX7mHs2KdW9fJy4GaE6uRo1iQtPz';
  const sem = parseSemgrep(Buffer.from(semgrepAnswer(
    [semgrepResult({ rule: 'work.rules.verdikta.solidity.selfdestruct', path: 'src/A.sol', line: 3, severity: 'WARNING' })],
    [
      { type: 'Syntax error', level: 'warn', message: `unexpected token "${secret}"`, path: '/work/src/src/B.sol', spans: [{ start: { line: 7, col: 1 } }] },
      { type: ['PartialParsing', [{ path: '/work/src/src/C.sol' }]], level: 'warn', message: secret, path: '/work/src/src/C.sol' },
    ],
    ['src/A.sol', 'src/B.sol'],
  )));
  assert.deepEqual(sem.findings, [{ tool: 'semgrep', rule: 'verdikta.solidity.selfdestruct', severity: 'warning', path: 'src/A.sol', line: 3, endLine: 3, message: 'a finding' }]);
  assert.deepEqual(sem.errors, [{ type: 'Syntax error', level: 'warn', path: 'src/B.sol', line: 7 }, { type: 'PartialParsing', level: 'warn', path: 'src/C.sol' }]);
  assert.ok(!JSON.stringify(sem).includes(secret));
  assert.deepEqual(sem.scanned, ['src/A.sol', 'src/B.sol']);
  assert.throws(() => parseSemgrep(Buffer.from(JSON.stringify({ results: [], errors: [] }))), (err) => err.code === 'SCAN_TOOL_FAILED', 'an answer that does not say what it analysed');
  const leaks = parseGitleaks(Buffer.from(JSON.stringify([gitleaksResult({ path: 'src/A.sol', line: 1, secret: 'abc' })])));
  assert.deepEqual(Object.keys(leaks.findings[0]).sort(), ['endLine', 'line', 'message', 'path', 'rule', 'severity', 'tool']);
  assert.throws(() => parseSemgrep(Buffer.from('not json')), (err) => err.code === 'SCAN_TOOL_FAILED');
  assert.throws(() => parseGitleaks(Buffer.from('{}')), (err) => err.code === 'SCAN_TOOL_FAILED');
});

test('a scanner that fails makes the scan an error, recorded in the maker\'s file', async () => {
  const { status, doc } = await scan(FILES, { semgrep: { exitCode: 2, stdout: semgrepAnswer([], [{ type: 'Rule parse error', level: 'error', message: 'bad rule' }]), stderr: 'boom' } });
  assert.equal(status, 'error');
  assert.equal(doc.status, 'error');
  assert.equal(doc.error.code, 'SCAN_TOOL_FAILED');
  assert.equal(doc.tools.semgrep.status, 'failed');
  assert.equal(doc.tools.secrets.status, 'ok', 'the secret scan still ran');
});

test('the findings file is written for the maker alone: a new folder, owner-only permissions', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vab-scanout-')), 'maker');
  const file = writeScan(dir, { kind: 'verdikta-baseline-scan', findings: [] });
  assert.equal(file, path.join(dir, SCAN_FILE));
  assert.deepEqual(fs.readdirSync(dir), [SCAN_FILE]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('nothing in scope goes unscanned unsaid: Semgrep\'s default exclusions are off, and each tool names what it did not read', async () => {
  const big = { mode: '100644', text: `// ${'x'.repeat(SEMGREP_MAX_BYTES)}` };
  const files = {
    'src/Vault.sol': 'contract Vault {}',
    'src/test/Helper.sol': 'contract H {}',
    'src/vendor/Lib.sol': 'library L {}',
    'src/Huge.sol': big,
    'src/Missed.sol': 'contract M {}',
    'src/package-lock.json': '{}',
    'src/node_modules/x/K.sol': 'contract K {}',
    // The scanner's own configuration at the root of what it reads: it would replace its rules.
    '.gitleaks.toml': '[allowlist]\npaths = [".*"]\n',
  };
  const s = spec();
  s.stake.scope = { include: ['src/**', '.gitleaks.toml'] };
  const { doc, runs } = await scan(files, {
    spec: s,
    semgrep: (args, opts) => ({ stdout: semgrepAnswer([], [], [...decodeInput(opts.stdin).keys()].filter((p) => p.startsWith('src/') && p !== 'src/src/Missed.sol').map((p) => p.slice(4))) }),
    gitleaks: { stdout: '[]', stderr: '9:29AM DBG skipping directory: global allowlist path=/work/src/src/node_modules\n9:29AM DBG skipping file: global allowlist path=/work/src/src/package-lock.json\n' },
  });
  // Semgrep runs where an empty .semgrepignore replaces its defaults (test/, vendor/, ...).
  const script = runs[0].args.at(-2);
  assert.match(script, /cd \/work\/src\n: > \/work\/src\/\.semgrepignore\n/);
  const toSemgrep = [...decodeInput(runs[0].stdin).keys()].filter((p) => p.startsWith('src/')).map((p) => p.slice(4)).sort();
  assert.deepEqual(toSemgrep, ['src/Missed.sol', 'src/Vault.sol', 'src/node_modules/x/K.sol', 'src/test/Helper.sol', 'src/vendor/Lib.sol'], 'every in-scope .sol file within its limit');
  assert.deepEqual(doc.tools.semgrep.notScanned, [
    { path: 'src/Huge.sol', detail: `over Semgrep's per-file limit of ${SEMGREP_MAX_BYTES} bytes: not analysed` },
    { path: 'src/Missed.sol', detail: 'Semgrep did not analyse it' },
  ]);
  assert.equal(doc.tools.semgrep.analysed, 4);
  // The secret scanner gets every file but its own configuration, and its skips are named.
  assert.equal(decodeInput(runs[1].stdin).has('src/.gitleaks.toml'), false);
  assert.ok(decodeInput(runs[1].stdin).has('src/src/package-lock.json'), 'everything else in scope');
  assert.deepEqual(doc.tools.secrets.notScanned, [
    { path: '.gitleaks.toml', detail: 'the secret scanner\'s own configuration file: not given to it, so it cannot change the scan' },
    { path: 'src/node_modules', detail: 'the secret scanner: skipping directory: global allowlist' },
    { path: 'src/package-lock.json', detail: 'the secret scanner: skipping file: global allowlist' },
  ]);
});

// From A3c's measurements of Semgrep 1.181.0 (verdikta-arbiter code-runner/README.md, "What the runner
// forces"), where they apply to a maker's scan. Real Semgrep: test/docker/scan.docker.test.js.
test('Semgrep\'s answer comes from a file: its own stdout goes elsewhere, since gVisor can cut it at 64 KiB with exit 0', async () => {
  const { runs } = await scan();
  const script = runs[0].args.at(-2);
  assert.match(script, /semgrep scan [^\n]*--output \/work\/semgrep\.json/);
  assert.match(script, /--disable-nosem/, 'a // nosemgrep in the maker\'s source does not shrink the scan');
  // Semgrep shares no descriptor with what carries the answer: it may leave a pipe non-blocking for what comes after.
  assert.match(script, /semgrep scan [^\n]* > \/dev\/null 2>&1/);
  assert.match(script, /\[ ! -e \/work\/semgrep\.json \] \|\| cat \/work\/semgrep\.json\n/);
  assert.match(script, /\nexit "\$rc"\n?$/, 'the tool\'s exit code is still the scan\'s');
});

test('a cut answer is a failed scan, never a smaller one', async () => {
  const whole = semgrepAnswer([semgrepResult({ rule: 'verdikta.solidity.selfdestruct', path: 'src/Vault.sol', line: 1 })]);
  for (const at of [1, Math.floor(whole.length / 2), whole.length - 1]) {
    const { status, doc } = await scan(FILES, { semgrep: { stdout: whole.slice(0, at) } });
    assert.equal(status, 'error', `cut at ${at}`);
    assert.equal(doc.error.code, 'SCAN_TOOL_FAILED');
    assert.equal(doc.tools.semgrep.status, 'failed');
  }
});

test('a skipped rule fails the scan: it found nothing, and says so only in skipped_rules', async () => {
  const answer = (skipped) => JSON.stringify({ ...JSON.parse(semgrepAnswer([], [], ['src/Vault.sol', 'src/lib/Math.sol'])), skipped_rules: skipped });
  const ok = await scan(FILES, { semgrep: { stdout: answer([]) } });
  assert.equal(ok.status, 'ok');
  const skipped = await scan(FILES, { semgrep: { stdout: answer([{ rule_id: 'verdikta.solidity.selfdestruct', details: 'x', position: {} }]) } });
  assert.equal(skipped.status, 'error');
  assert.equal(skipped.doc.error.code, 'SCAN_TOOL_FAILED');
  assert.match(skipped.doc.error.detail, /skipped/);
  const missing = JSON.parse(answer([]));
  delete missing.skipped_rules;
  assert.equal((await scan(FILES, { semgrep: { stdout: JSON.stringify(missing) } })).status, 'error', 'an answer that does not say');
});

test('an answer from another release of Semgrep than the pin is not read', async () => {
  const other = { ...JSON.parse(semgrepAnswer([], [], ['src/Vault.sol', 'src/lib/Math.sol'])), version: '1.2.3' };
  const { status, doc } = await scan(FILES, { semgrep: { stdout: JSON.stringify(other) } });
  assert.equal(status, 'error');
  assert.match(doc.error.detail, /1\.2\.3/);
});

test('a match cap is stated: the file\'s results were dropped, so it is named as not analysed, with the rule; it is not counted as analysed', async () => {
  const rule = 'verdikta.solidity.tx-origin-auth';
  const { status, doc } = await scan(FILES, {
    semgrep: { stdout: semgrepAnswer(
      [semgrepResult({ rule, path: 'src/lib/Math.sol', line: 3 })],
      [{ type: 'Too many matches', rule_id: rule, level: 'warn', path: '/work/src/src/Vault.sol', message: 'a line of the source' }],
      ['src/Vault.sol', 'src/lib/Math.sol'],
    ) },
  });
  assert.equal(status, 'ok');
  assert.equal(doc.tools.semgrep.analysed, 1);
  assert.deepEqual(doc.tools.semgrep.notScanned, [{ path: 'src/Vault.sol', detail: `past Semgrep's limit of matches of one rule in one file (${rule}), it drops every result for the file: not analysed` }]);
  assert.deepEqual(doc.tools.semgrep.errors, [{ type: 'Too many matches', level: 'warn', path: 'src/Vault.sol' }]);
  assert.ok(!JSON.stringify(doc).includes('a line of the source'), 'the message can quote the source');
  // The other ways a file is not read as a clean one is: in fixed words, and not in what was analysed.
  for (const [type, words] of [
    ['Timeout', /time limit[^:]*: not wholly analysed/],
    ['Out of memory', /out of memory[^:]*: not wholly analysed/],
    ['Syntax error', /could not parse it: not analysed/],
    [['PartialParsing', []], /could not parse part of it: not wholly analysed/],
    ['A kind this release has not seen', /reports an error on it: not wholly analysed/],
  ]) {
    const one = await scan(FILES, { semgrep: { stdout: semgrepAnswer([], [{ type, rule_id: rule, level: 'warn', path: '/work/src/src/Vault.sol', message: 'a line of the source' }], ['src/Vault.sol', 'src/lib/Math.sol']) } });
    assert.equal(one.status, 'ok');
    assert.equal(one.doc.tools.semgrep.analysed, 1, String(type));
    assert.equal(one.doc.tools.semgrep.notScanned.length, 1, String(type));
    assert.match(one.doc.tools.semgrep.notScanned[0].detail, words);
    assert.ok(!JSON.stringify(one.doc).includes('a line of the source'));
  }
  // Whichever cap comes first: a report of more errors than are kept says so, and no capped file is lost with them.
  const many = Array.from({ length: 60 }, (_, i) => ({ type: 'Syntax error', level: 'warn', path: `/work/src/src/E${i}.sol` }));
  const capped = await scan(FILES, { semgrep: { stdout: semgrepAnswer([], [...many, { type: 'Too many matches', rule_id: rule, level: 'warn', path: '/work/src/src/Vault.sol' }], ['src/Vault.sol', 'src/lib/Math.sol']) } });
  assert.equal(capped.doc.tools.semgrep.errorsTruncated, true);
  assert.ok(capped.doc.tools.semgrep.notScanned.some((n) => n.path === 'src/Vault.sol'));
});
