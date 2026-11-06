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
import { outputsDigest, readOutputs, writeOutputs } from '../../src/outputs.js';
import { buildListing } from '../../src/pipeline.js';
import { createRegistryClient } from '../../src/registry.js';
import { attest, loadSigningKey } from '../../src/signing.js';
import { verifyForSigning } from '../../src/verifyBuild.js';
import { MAKER } from '../helpers/proof.js';
import { PIN, fixtureDraft, fixtureRepo, neverEndingTest, newId, noRouteTest, removeImages, startCodeRunner, startRegistries, testPlatforms } from './helpers.js';

const TIMEOUT = 2400000;
const id = newId();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
const platforms = testPlatforms();
const recipient = codeReview.generateDisclosureKeyPair().recipient;
const PROOF = { '.verdikta/stake-control.json': `${JSON.stringify({ version: 1, maker: MAKER })}\n` };
const STABLE = [
  'test/Routes.t.sol > RoutesTest > test_no_route_out()',
  'test/Vault.t.sol > VaultTest > test_deposit_credits()',
  'test/Vault.t.sol > VaultTest > test_owner_is_deployer()',
];
let regs;
let runner;
let repo;
let config;
let accepted;

/** A builder config for the fixture repository, and any others this file makes (by URL). */
function configFor(mirrors) {
  return parseConfig({
    registry: { repository: `${regs.host}/${id}/env`, apiUrl: regs.apiUrl },
    runner: { url: runner.url, tokenEnv: 'VAB_RUNNER_TOKEN' },
    platforms,
    repoMirrors: mirrors,
    signing: { key: 'dev' },
  }, { baseDir: dir, env: { VAB_RUNNER_TOKEN: runner.token } });
}

test.before(async () => {
  regs = await startRegistries(id);
  repo = fixtureRepo(dir, { ...PROOF, ...noRouteTest() });
  runner = await startCodeRunner({ id, registryHost: regs.host, platform: platforms.run });
  config = configFor({ 'https://github.com/verdikta-test/vault-fixture': repo.mirror });
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
  const r = await buildListing({ draft, knownIssues: null, maker: MAKER, config, workDir: fs.mkdtempSync(path.join(dir, 'w-')) });
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
  // The baseline is the suite's three runs at the listed commit, on plain forge commands; with no route out on any of them.
  const baseline = JSON.parse(r.files.get('baseline.json'));
  assert.equal(baseline.baseCommit, repo.baseCommit);
  assert.deepEqual(baseline.stable, STABLE);
  assert.deepEqual(baseline.unstable, []);
  assert.deepEqual(Object.fromEntries(['build', 'test', 'testFiles', 'testIds'].map((k) => [k, spec.commands[k].split(' ').slice(0, 2).join(' ')])), { build: 'forge build', test: 'forge test', testFiles: 'forge test', testIds: 'forge test' });
  assert.equal(codeReview.validateBaseline(baseline, spec).ok, true);
  // Timings and the defaults derived from them; the draft's cpus and memory are kept.
  const lc = r.report.listingCheck;
  assert.equal(lc.status, 'accepted');
  assert.equal(lc.timings.testSeconds.length, 3);
  assert.ok(lc.limits.runSeconds <= 360 && lc.limits.buildSeconds <= 90);
  assert.deepEqual(spec.limits, { ...lc.limits, cpus: 1, memoryMb: 2048 });
  assert.equal(lc.runner.platform, platforms.run);
  assert.ok(lc.harness.probes.some((p) => p.verdict === 'assertion'), 'the harness proof ran');
  // An official solc release: the setup's forge fetched it, and the runner read its bytes against the list.
  assert.ok(lc.compilers.checked.some((c) => c.release === '0.8.31'), JSON.stringify(lc.compilers));
  // The runner was asked first, and it has the grammar.
  assert.deepEqual(r.report.commands, { checkedBy: 'runner', canary: 'COMMAND_NOT_ALLOWED', issues: [] });
});

// Acceptance 2 at the real runner: one rule for a listing and a claim (verdikta-arbiter code-runner/src/commands.js).
for (const [key, text] of [
  ['build', '[ "$(tail -n +2 /proc/net/route | grep -c .)" = 0 ] && forge build'],
  ['build', 'sleep 40; forge build'],
  ['test', 'true && forge test'],
  ['test', 'FOUNDRY_PROFILE=other forge test'],
]) {
  test(`commands.${key} = ${JSON.stringify(text)} is refused by the runner at the pin, by its code, and nothing is built`, { timeout: 120000 }, async () => {
    const draft = fixtureDraft(repo.baseCommit, recipient);
    draft.commands[key] = text;
    const r = await buildListing({ draft, knownIssues: null, maker: MAKER, config, workDir: fs.mkdtempSync(path.join(dir, 'w-')) });
    assert.equal(r.status, 'refused', show(r));
    assert.deepEqual(r.report.refusals.map((x) => [x.code, x.step]), [['COMMAND_NOT_ALLOWED', 'spec']]);
    assert.match(r.report.refusals[0].detail, new RegExp(`^commands\\.${key}: `));
    assert.deepEqual(r.report.steps.map((s) => s.name), ['spec'], 'no fetch, no build, no setup');
    assert.equal(r.files.size, 0);
    await assert.rejects(attest({ files: { codeReview: Buffer.from('{}'), baseline: Buffer.from('{}'), knownIssues: null }, report: r.report, key: loadSigningKey('dev') }), { code: 'SIGNING_NOT_ACCEPTED' });
  });
}

// What A2c and A2d refuse (owner decisions Q35 and Q40), end to end on a real image: the code reaches the maker.
for (const [code, setup] of [
  ['SOLC_NOT_OFFICIAL', 'forge build; printf "\\n" >> "$XDG_DATA_HOME/svm/0.8.31/solc-0.8.31"'],
  ['VYPER_NOT_SUPPORTED', 'forge build; printf "#!/bin/sh\\nexit 1\\n" > "$VERDIKTA_TOOLS/bin/vyper"; chmod 0755 "$VERDIKTA_TOOLS/bin/vyper"'],
]) {
  test(`an image that holds what the listing check refuses is refused by name: ${code}, and nothing can be signed`, { timeout: TIMEOUT }, async () => {
    const draft = fixtureDraft(repo.baseCommit, recipient);
    draft.commands.setup = setup;
    const r = await buildListing({ draft, knownIssues: null, maker: MAKER, config, workDir: fs.mkdtempSync(path.join(dir, 'w-')) });
    assert.equal(r.status, 'refused', show(r));
    assert.deepEqual(r.report.refusals.map((x) => [x.code, x.step]), [[code, 'listingCheck']]);
    assert.equal(r.report.listingCheck.status, 'refused');
    assert.equal(r.files.has('baseline.json'), false);
    await assert.rejects(attest({ files: { codeReview: Buffer.from('{}'), baseline: Buffer.from('{}'), knownIssues: null }, report: r.report, key: loadSigningKey('dev') }), { code: 'SIGNING_NOT_ACCEPTED' });
  });
}

test('the sign step\'s checks pass on a real build\'s outputs: the pushed image is the one measured, FROM the pinned base, labelled with the commit', { timeout: TIMEOUT }, async () => {
  assert.ok(accepted, 'the listing was accepted');
  const out = path.join(dir, 'out-verify');
  writeOutputs(out, accepted);
  const { files, report } = readOutputs(out);
  // The env image is read where this test's registry serves it; the base from its own registry.
  const registryFor = (repository) => createRegistryClient({ repository, apiUrl: repository === config.registry.repository ? regs.apiUrl : null });
  const v = await verifyForSigning({ files, report, dir: out, expectOutputs: outputsDigest(out), checkRegistry: true, registryFor });
  for (const c of ['FILES_MATCH_REPORT', 'STEPS_COMPLETE', 'COMMANDS_CHECKED', 'OUTPUTS_MATCH_BUILD', 'IMAGE_PUBLISHED', 'IMAGE_MATCHES_MEASUREMENTS', 'IMAGE_FROM_PINNED_BASE', 'IMAGE_LABELLED_WITH_COMMIT']) {
    assert.ok(v.checks.includes(c), c);
  }
  assert.deepEqual(v.trusts.map((x) => x.code), ['LISTING_CHECK_RESULTS', 'UNPACKED_SIZE', 'BUILD_JOB']);
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
  assert.deepEqual(report.baseline, { tests: 3, stable: 3, unstable: [] });
  // the fixture repository's real suite, far inside the share of the code-runner's request a listing may take
  assert.ok(report.listingRequest.parts.baseline < 1024, JSON.stringify(report.listingRequest));
  assert.ok(report.listingRequest.bytes < report.listingRequest.maxBytes, JSON.stringify(report.listingRequest));
  assert.ok(!JSON.stringify(report).includes(runner.token), 'the runner token is not in the report');
  if (platforms.run !== 'linux/amd64') assert.ok(report.devOnly.some((d) => d.code === 'VALIDATED_ON_OTHER_PLATFORM'));
});

test('too heavy for v1: a suite past the check\'s budget stops the listing on plain forge commands, and nothing can be signed', { timeout: TIMEOUT }, async () => {
  const name = 'https://github.com/verdikta-test/vault-too-heavy';
  const heavy = fixtureRepo(fs.mkdtempSync(path.join(dir, 'heavy-')), { ...PROOF, ...neverEndingTest() });
  const draft = fixtureDraft(heavy.baseCommit, recipient, { repo: name });
  const r = await buildListing({ draft, knownIssues: null, maker: MAKER, config: configFor({ [name]: heavy.mirror }), workDir: fs.mkdtempSync(path.join(dir, 'w-')) });
  assert.equal(r.status, 'refused', show(r));
  assert.deepEqual(r.report.refusals.map((x) => x.code), ['LISTING_TOO_HEAVY']);
  assert.equal(r.files.has('baseline.json'), false);
  await assert.rejects(attest({ files: { codeReview: r.files.get('code_review.json') ?? Buffer.from('{}'), baseline: Buffer.from('{}'), knownIssues: null }, report: r.report, key: loadSigningKey('dev') }), { code: 'SIGNING_NOT_ACCEPTED' });
});
