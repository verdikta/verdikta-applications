// The baseline scan with the real pinned Semgrep, Verdikta's rules and the pinned secret scanner,
// each in a sandbox with no network, over the fixture repository's in-scope paths (node P3b
// acceptance 1). The fixture's planted bugs and a secret written at run time (so no
// secret-looking string is committed) are found; the same bugs outside the scope are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { createDocker } from '../../src/docker.js';
import { scanListing } from '../../src/scan.js';
import { SCAN_TOOLS } from '../../src/scanTools.js';
import { FIXTURES, fixtureDraft, fixtureRepo, newId, testPlatforms } from './helpers.js';

const id = newId();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
const LEAKY = fs.readFileSync(path.join(FIXTURES, 'scan', 'Leaky.sol'), 'utf8');
const SECRET = crypto.randomBytes(30).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const SD = (body) => `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract C {\n    function k(address payable a) external {\n${body}\n    }\n}\n`;
/** Past Semgrep's limit of 10,000 matches of one rule in one file, under its 2 MB per file. */
const CAPPED = SD('        selfdestruct(a);\n'.repeat(10500));
const RULE = 'verdikta.solidity.selfdestruct';

async function scanFiles(extra, { runtime = null } = {}) {
  const sub = fs.mkdtempSync(path.join(dir, 'files-'));
  const repo = fixtureRepo(sub, extra);
  const config = parseConfig({
    registry: { repository: 'ghcr.io/verdikta/stake-env' },
    runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'UNUSED_RUNNER_TOKEN' },
    platforms: testPlatforms(),
    repoMirrors: { 'https://github.com/verdikta-test/vault-fixture': repo.mirror },
  }, { baseDir: dir, env: {} });
  const real = createDocker();
  // The runtime is the daemon's choice in production: here, this test's.
  const docker = { run: (args, opts) => real.run(args[0] === 'run' && runtime ? ['run', '--runtime', runtime, ...args.slice(1)] : args, opts) };
  const spec = fixtureDraft(repo.baseCommit, codeReview.generateDisclosureKeyPair().recipient);
  return scanListing({ spec, config, deps: { docker }, workDir: dir });
}

/** What A3c measured of Semgrep 1.181.0, on the real tool, as a maker's scan meets it. */
async function assertScanIsWhole(runtime) {
  // An answer far past 64 KiB, with a finding on the last line: all of it arrived, whatever the runtime does to stdout.
  const lines = 2500;
  const { status, doc } = await scanFiles({ 'src/Many.sol': SD('        selfdestruct(a);\n'.repeat(lines)) }, { runtime });
  assert.equal(status, 'ok', JSON.stringify(doc.error ?? doc.tools.semgrep));
  assert.equal(doc.tools.semgrep.truncated, true, 'past the findings the file keeps, and it says so');
  assert.equal(doc.findings.filter((f) => f.tool === 'semgrep' && f.path === 'src/Many.sol').length, 500);
  assert.deepEqual(doc.tools.semgrep.notScanned, []);
  assert.deepEqual(doc.tools.semgrep.errors, []);
  // The match cap: every result of the file dropped, exit 0. It is stated, by the rule, and the file is not counted.
  const cap = await scanFiles({ 'src/Capped.sol': CAPPED }, { runtime });
  assert.equal(cap.status, 'ok', JSON.stringify(cap.doc.error ?? cap.doc.tools.semgrep));
  assert.equal(cap.doc.findings.some((f) => f.path === 'src/Capped.sol'), false, 'Semgrep dropped them');
  assert.deepEqual(cap.doc.tools.semgrep.notScanned, [{ path: 'src/Capped.sol', detail: `past Semgrep's limit of matches of one rule in one file (${RULE}), it drops every result for the file: not analysed` }]);
  assert.equal(cap.doc.tools.semgrep.analysed, 1, 'the fixture\'s Vault.sol, and not the capped file');
}

test('real Semgrep: a whole answer past 64 KiB, and a match cap stated by the rule', { timeout: 1200000 }, () => assertScanIsWhole(null));

test('real Semgrep under gVisor, where its stdout can be cut at 64 KiB with exit 0: the same', {
  timeout: 1200000,
  skip: process.env.SA_BUILDER_TEST_RUNSC === '1' ? false : 'needs a daemon with runsc registered: CI\'s builder-docker job sets SA_BUILDER_TEST_RUNSC=1',
}, () => assertScanIsWhole('runsc'));

test('real Semgrep: // nosemgrep in the maker\'s source does not take a finding out of the scan', { timeout: 600000 }, async () => {
  const { status, doc } = await scanFiles({
    'src/Hidden.sol': SD('        selfdestruct(a); // nosemgrep\n'),
    'src/Named.sol': SD('        // nosemgrep: verdikta.solidity.selfdestruct\n        selfdestruct(a);\n'),
  });
  assert.equal(status, 'ok', JSON.stringify(doc.error ?? doc.tools.semgrep));
  for (const p of ['src/Hidden.sol', 'src/Named.sol']) assert.ok(doc.findings.some((f) => f.path === p && f.rule === RULE), p);
});

test('Semgrep and the secret scanner find the planted bugs and the secret in scope, and nothing out of it, with no network', { timeout: 1800000 }, async () => {
  const repo = fixtureRepo(dir, {
    'src/Leaky.sol': LEAKY,
    'src/Settings.sol': `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Settings {\n    string constant apiKey = "${SECRET}";\n}\n`,
    'script/Leaky.s.sol': LEAKY,
    // In scope, where Semgrep's default exclusions (test/) and the secret scanner's allowlist
    // (node_modules) would otherwise hide them.
    'src/test/Planted.sol': '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Planted {\n    function kill() external { selfdestruct(payable(msg.sender)); }\n}\n',
    'src/node_modules/x/Key.sol': `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Key {\n    string constant apiKey = "${SECRET}";\n}\n`,
  });
  const config = parseConfig({
    registry: { repository: 'ghcr.io/verdikta/stake-env' },
    runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'UNUSED_RUNNER_TOKEN' },
    platforms: testPlatforms(),
    repoMirrors: { 'https://github.com/verdikta-test/vault-fixture': repo.mirror },
  }, { baseDir: dir, env: {} });
  const real = createDocker();
  const calls = [];
  const docker = { run: (args, opts) => { calls.push(args); return real.run(args, opts); } };
  const spec = fixtureDraft(repo.baseCommit, codeReview.generateDisclosureKeyPair().recipient);
  const { status, doc } = await scanListing({ spec, config, deps: { docker }, workDir: dir });
  assert.equal(status, 'ok', JSON.stringify(doc.error ?? doc.tools));

  // Run by digest, in sandboxes without network.
  const runsOf = calls.filter((a) => a[0] === 'run');
  assert.deepEqual(runsOf.map((a) => a.find((x) => x.includes('@sha256:'))), [SCAN_TOOLS.semgrep.image, SCAN_TOOLS.gitleaks.image]);
  for (const a of runsOf) assert.equal(a[a.indexOf('--network') + 1], 'none');

  assert.ok(doc.files.inScope.includes('src/Leaky.sol') && doc.files.inScope.includes('src/Vault.sol'));
  assert.ok(!doc.files.inScope.some((p) => !p.startsWith('src/')), 'in scope only');
  // Semgrep's default exclusions are off: a file under test/ that the scope includes is analysed.
  assert.ok(doc.findings.some((f) => f.path === 'src/test/Planted.sol' && f.rule === 'verdikta.solidity.selfdestruct'));
  assert.deepEqual(doc.tools.semgrep.notScanned, []);
  assert.equal(doc.tools.semgrep.analysed, doc.files.inScope.filter((p) => p.endsWith('.sol')).length);
  // What the secret scanner skips, it says.
  assert.deepEqual(doc.tools.secrets.notScanned, [{ path: 'src/node_modules', detail: 'the secret scanner: skipping directory: global allowlist' }]);
  const rules = new Set(doc.findings.filter((f) => f.tool === 'semgrep').map((f) => f.rule));
  for (const r of [
    'verdikta.solidity.tx-origin-auth', 'verdikta.solidity.value-call-before-state-write', 'verdikta.solidity.unchecked-low-level-call',
    'verdikta.solidity.unchecked-erc20-transfer', 'verdikta.solidity.arbitrary-transfer-from', 'verdikta.solidity.delegatecall-to-parameter',
    'verdikta.solidity.predictable-randomness', 'verdikta.solidity.selfdestruct',
  ]) assert.ok(rules.has(r), `${r} fired`);
  assert.equal(doc.findings.some((f) => f.path.startsWith('script/')), false, 'nothing outside the scope');
  // The fixture's own Vault and the checked calls in Leaky.sol raise nothing.
  assert.equal(doc.findings.some((f) => f.path === 'src/Vault.sol'), false);
  const checked = LEAKY.split('\n').findIndex((l) => l.includes('contract Checked')) + 1;
  assert.equal(doc.findings.some((f) => f.tool === 'semgrep' && f.path === 'src/Leaky.sol' && f.line > checked), false, 'no false positive on checked calls');
  assert.deepEqual(doc.tools.semgrep.errors, []);

  const secrets = doc.findings.filter((f) => f.tool === 'gitleaks');
  assert.deepEqual(secrets.map((f) => [f.path, f.line]), [['src/Settings.sol', 4]]);
  assert.equal(JSON.stringify(doc).includes(SECRET), false, 'the secret is not copied into the findings');

  // The agent pass, with a stub for the provider, gets what the real scanner's log says it read,
  // with the flagged line withheld; never the secret, never the file it skipped.
  const agentConfig = parseConfig({
    registry: { repository: 'ghcr.io/verdikta/stake-env' },
    runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'UNUSED_RUNNER_TOKEN' },
    platforms: testPlatforms(),
    repoMirrors: { 'https://github.com/verdikta-test/vault-fixture': repo.mirror },
    scan: { agent: { provider: 'openrouter', model: 'qwen/qwen3-coder', apiUrl: 'https://provider.invalid/v1/chat/completions', apiKeyEnv: 'STUB_PROVIDER_TOKEN' } },
  }, { baseDir: dir, env: { STUB_PROVIDER_TOKEN: 'stub-bearer-for-tests' } });
  const prompts = [];
  const agentFetch = async (url, init) => {
    prompts.push(JSON.parse(init.body).messages.map((m) => m.content).join('\n'));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }), { status: 200 });
  };
  const withAgent = await scanListing({ spec, config: agentConfig, deps: { docker, agentFetch }, workDir: dir, agent: true });
  assert.equal(withAgent.status, 'ok', JSON.stringify(withAgent.doc.error ?? withAgent.doc.tools));
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes('contract Checked'), 'the in-scope source the scanner read');
  assert.ok(!prompts[0].includes(SECRET));
  assert.ok(prompts[0].includes('[line withheld from the agent pass: the secret scan flagged it]'));
  assert.deepEqual(withAgent.doc.tools.agent.withheld, { lines: 1, files: ['src/node_modules/x/Key.sol'] });
});
