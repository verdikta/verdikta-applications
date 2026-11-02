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
import { RULES_DIR, SCAN_TOOLS, loadRules, parseGitleaks, parseSemgrep } from '../../src/scanTools.js';
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
  }
  // The images are pulled by digest (the daemon checks every byte) before the sandboxes start.
  const pulls = docker.calls.filter((c) => c.args[0] === 'pull').map((c) => c.args.at(-1));
  assert.deepEqual(pulls.sort(), [SCAN_TOOLS.gitleaks.image, SCAN_TOOLS.semgrep.image].sort());
});

test('only the in-scope paths are scanned: scope.include less scope.exclude, no symbolic link followed', async () => {
  const { doc, runs } = await scan();
  assert.deepEqual(doc.files.scanned, ['src/Vault.sol', 'src/lib/Math.sol']);
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
  assert.deepEqual(doc.files.scanned, []);
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
  assert.deepEqual(doc.tools.semgrep, { version: SCAN_TOOLS.semgrep.version, image: SCAN_TOOLS.semgrep.image, rules: { version: SCAN_TOOLS.rules.version, sha256: SCAN_TOOLS.rules.sha256 }, status: 'ok', errors: [] });
  assert.deepEqual(doc.tools.secrets, { tool: 'gitleaks', version: SCAN_TOOLS.gitleaks.version, image: SCAN_TOOLS.gitleaks.image, status: 'ok' });
  assert.deepEqual(doc.tools.agent, { status: 'off' });
  assert.deepEqual(doc.listing, { repo: spec().repo, baseCommit: spec().baseCommit, artifact: { kind: 'repo' }, lowestClassCounted: 'MEDIUM', scope: SCOPE });
});

test('parsers keep only what the maker needs: rule, path, lines, message; never a source line or a secret', () => {
  const sem = parseSemgrep(Buffer.from(semgrepAnswer(
    [semgrepResult({ rule: 'verdikta.solidity.selfdestruct', path: 'src/A.sol', line: 3, severity: 'WARNING' })],
    [{ type: 'Syntax error', level: 'warn', message: 'could not parse', path: '/work/src/src/B.sol' }],
  )));
  assert.deepEqual(sem.findings, [{ tool: 'semgrep', rule: 'verdikta.solidity.selfdestruct', severity: 'warning', path: 'src/A.sol', line: 3, endLine: 3, message: 'a finding' }]);
  assert.deepEqual(sem.errors, [{ type: 'Syntax error', level: 'warn', path: 'src/B.sol', message: 'could not parse' }]);
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
