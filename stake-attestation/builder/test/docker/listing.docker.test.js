// Acceptance 3, 4 and 5 end to end: the fixture's env image is built and pushed to registry:2,
// validated by the code-runner's listing check (verdikta-arbiter at the commit in
// code-runner.pin.json, run as a sidecar on loopback with its own token and environment),
// code_review.json and baseline.json are written, attestation.json is signed with a per-run dev
// key, and the maker's validation report is written. A listing too heavy for v1 is stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { readOutputs, writeOutputs } from '../../src/outputs.js';
import { buildListing } from '../../src/pipeline.js';
import { attest, loadSigningKey } from '../../src/signing.js';
import { PIN, fixtureDraft, fixtureRepo, newId, removeImages, startCodeRunner, startRegistries, testPlatforms } from './helpers.js';

const TIMEOUT = 2400000;
const id = newId();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
const platforms = testPlatforms();
const recipient = codeReview.generateDisclosureKeyPair().recipient;
let regs;
let runner;
let repo;
let config;
let accepted;

test.before(async () => {
  regs = await startRegistries(id);
  repo = fixtureRepo(dir);
  runner = await startCodeRunner({ id, registryHost: regs.host, platform: platforms.run });
  config = parseConfig({
    registry: { repository: `${regs.host}/${id}/env`, apiUrl: regs.apiUrl },
    runner: { url: runner.url, tokenEnv: 'VAB_RUNNER_TOKEN' },
    platforms,
    repoMirrors: { 'https://github.com/verdikta-test/vault-fixture': repo.mirror },
    signing: { key: 'dev' },
  }, { baseDir: dir, env: { VAB_RUNNER_TOKEN: runner.token } });
});

test.after(async () => {
  await runner?.stop();
  if (regs) removeImages(`${regs.host}/${id}/env`);
  regs?.remove();
  fs.rmSync(dir, { recursive: true, force: true });
});

function show(r) {
  return JSON.stringify({ status: r.status, refusals: r.report.refusals, error: r.report.error, steps: r.report.steps, runner: runner.log().slice(-4000) }, null, 1);
}

test('the code-runner sidecar is verdikta-arbiter at the pinned commit', () => {
  assert.equal(runner.commit, PIN.commit);
  assert.equal(runner.health.service, 'verdikta-code-runner');
});

test('validated by the code-runner\'s listing check: code_review.json gets digest, platform and unpackedBytes; baseline.json, timings and default limits', { timeout: TIMEOUT }, async () => {
  const draft = fixtureDraft(repo.baseCommit, recipient);
  const r = await buildListing({ draft, knownIssues: null, config, workDir: fs.mkdtempSync(path.join(dir, 'w-')) });
  assert.equal(r.status, 'accepted', show(r));
  accepted = r;
  const spec = JSON.parse(r.files.get('code_review.json'));
  assert.equal(spec.env.image, r.report.image.ref);
  assert.match(spec.env.image, /@sha256:[0-9a-f]{64}$/);
  assert.equal(spec.env.platform, 'linux/amd64');
  assert.equal(spec.env.from, 'foundry');
  assert.equal(spec.env.unpackedBytes, r.report.image.unpackedBytes.attested);
  assert.ok(spec.env.unpackedBytes >= r.report.image.unpackedBytes.runner);
  assert.equal(codeReview.validateCodeReviewSpec(spec).ok, true);
  // The baseline is the suite's three runs at the listed commit; the build ran with loopback only.
  const baseline = JSON.parse(r.files.get('baseline.json'));
  assert.equal(baseline.baseCommit, repo.baseCommit);
  assert.deepEqual(baseline.stable, ['test/Vault.t.sol > VaultTest > test_deposit_credits()', 'test/Vault.t.sol > VaultTest > test_owner_is_deployer()']);
  assert.equal(codeReview.validateBaseline(baseline, spec).ok, true);
  // Timings and the defaults derived from them; the draft's cpus and memory are kept.
  const lc = r.report.listingCheck;
  assert.equal(lc.status, 'accepted');
  assert.equal(lc.timings.testSeconds.length, 3);
  assert.ok(lc.limits.runSeconds <= 360 && lc.limits.buildSeconds <= 90);
  assert.deepEqual(spec.limits, { ...lc.limits, cpus: 1, memoryMb: 2048 });
  assert.equal(lc.runner.platform, platforms.run);
  assert.ok(lc.harness.probes.some((p) => p.verdict === 'assertion'), 'the harness proof ran');
});

test('attestation.json, signed with a per-run dev key, passes validateAttestation in dev trust and fails it in production trust', { timeout: TIMEOUT }, async () => {
  assert.ok(accepted, 'the listing was accepted');
  const out = path.join(dir, 'out');
  writeOutputs(out, accepted);
  const { files, report } = readOutputs(out);
  const key = loadSigningKey('dev');
  const { attestation, bytes } = await attest({ files, report, key });
  fs.writeFileSync(path.join(out, 'attestation.json'), bytes);
  const listed = { codeReview: fs.readFileSync(path.join(out, 'code_review.json')), baseline: fs.readFileSync(path.join(out, 'baseline.json')) };
  const dev = codeReview.validateAttestation(JSON.parse(fs.readFileSync(path.join(out, 'attestation.json'))), { files: listed, trust: key.devTrust() });
  assert.equal(dev.ok, true, JSON.stringify(dev.issues));
  const prod = codeReview.validateAttestation(attestation, { files: listed });
  assert.equal(prod.ok, false);
  assert.ok(prod.issues.some((i) => i.code === 'ATTESTATION_UNTRUSTED_KEY'));
  assert.equal(attestation.env.image, JSON.parse(listed.codeReview).env.image);
  assert.equal(attestation.tools.runner, report.listingCheck.runner.version);
  // No private key anywhere in what was written.
  for (const f of fs.readdirSync(out)) assert.ok(!/PRIVATE KEY/.test(fs.readFileSync(path.join(out, f), 'latin1')), f);
});

test('the maker\'s validation report: every step, the image, validation, and what is dev-only', { timeout: TIMEOUT }, async () => {
  assert.ok(accepted, 'the listing was accepted');
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'validation-report.json')));
  assert.equal(report.kind, 'verdikta-listing-validation');
  assert.equal(report.status, 'accepted');
  assert.deepEqual(report.steps.map((s) => s.status), report.steps.map((s) => (s.name === 'verifiedSource' ? 'skipped' : 'ok')));
  assert.equal(report.listingCheck.checkId.length > 0, true);
  assert.deepEqual(report.baseline, { tests: 2, stable: 2, unstable: [] });
  assert.ok(!JSON.stringify(report).includes(runner.token), 'the runner token is not in the report');
  if (platforms.run !== 'linux/amd64') assert.ok(report.devOnly.some((d) => d.code === 'VALIDATED_ON_OTHER_PLATFORM'));
});

test('too heavy for v1: a build past the check\'s 30 s budget stops the listing, and nothing can be signed', { timeout: TIMEOUT }, async () => {
  const draft = fixtureDraft(repo.baseCommit, recipient);
  draft.commands.build = 'sleep 40; forge build';
  const r = await buildListing({ draft, knownIssues: null, config, workDir: fs.mkdtempSync(path.join(dir, 'w-')) });
  assert.equal(r.status, 'refused', show(r));
  assert.deepEqual(r.report.refusals.map((x) => x.code), ['LISTING_TOO_HEAVY']);
  assert.equal(r.files.has('baseline.json'), false);
  await assert.rejects(attest({ files: { codeReview: r.files.get('code_review.json') ?? Buffer.from('{}'), baseline: Buffer.from('{}'), knownIssues: null }, report: r.report, key: loadSigningKey('dev') }), { code: 'SIGNING_NOT_ACCEPTED' });
});
