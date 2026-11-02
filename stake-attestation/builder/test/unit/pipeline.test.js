// The listing build end to end, with doubles for docker, the registry, the explorer and the
// code-runner. Acceptance 1 (digest, platform and unpackedBytes written into code_review.json;
// the size limits), 2 (a source mismatch stops the listing before validation), 3 (validation's
// baseline, timings and limits; its refusals stop the listing) and 5 (the maker's report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { buildListing } from '../../src/pipeline.js';
import { createExplorer } from '../../src/explorer.js';
import { FIXTURES, fakeDocker, readFixture, recordedExplorer, sha256 } from '../helpers/fakes.js';
import { BASE_COMMIT, abstained, acceptedListing, contractDraft, definitive, draftSpec, refusedListing } from '../helpers/specs.js';

const DIGEST = `sha256:${'2'.repeat(64)}`;
const REPOSITORY = 'ghcr.io/verdikta/stake-env';
const IMAGE = `${REPOSITORY}@${DIGEST}`;
const RUNNER_TOKEN = 'runner-token-0123456789abcdef0123456789';
const EXPLORER_KEY = 'EXPLORERKEY0123456789';

function config(over = {}) {
  return parseConfig({
    registry: { repository: REPOSITORY },
    runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' },
    explorers: { 8453: { apiUrl: 'https://explorer.test/api', apiKeyEnv: 'EXPLORER_KEY' } },
    signing: { key: 'dev' },
    ...over,
  }, { baseDir: '/tmp', env: { CODE_RUNNER_TOKEN: RUNNER_TOKEN, EXPLORER_KEY } });
}

/** Doubles for one build; `over` replaces any of them. */
function harness(over = {}) {
  const calls = { fetch: [], runner: [], collect: [], registry: [] };
  const docker = fakeDocker((args) => {
    if (args[0] === 'push') return { stdout: `digest: ${DIGEST} size: 1234\n` };
    if (args[0] === 'history') return { stdout: `${over.unpacked ?? 700000000}\n100000000\n` };
    return {};
  });
  const deps = {
    docker,
    fetchListedCommit: async (req) => { calls.fetch.push(req); return { gitDir: req.dir }; },
    writeBuildContext: () => ({ dockerfile: 'FROM x' }),
    registry: {
      imageInfo: async (digest, platform) => {
        calls.registry.push([digest, platform]);
        return { digest, manifestDigest: digest, compressedBytes: over.compressed ?? 300000000, platforms: ['linux/amd64'], config: { os: 'linux', architecture: 'amd64' }, volumes: over.volumes ?? [] };
      },
    },
    runner: {
      listingCheck: async (body) => {
        calls.runner.push(body);
        const d = (over.runnerAnswer ?? (() => definitive(IMAGE, acceptedListing())))(body);
        return { status: d.status, json: d.body };
      },
    },
    explorerFor: over.explorerFor,
    collect: over.collect ?? (async (req) => {
      calls.collect.push(req);
      return {
        files: new Map(req.paths.map((p) => [p, fs.readFileSync(path.join(FIXTURES, 'vault', p))])),
        artifacts: [{ file: 'out/Vault.sol/Vault.json', json: readFixture('artifacts', 'Vault.json') }],
        build: { exitCode: 0, log: '' },
      };
    }),
    ...over.deps,
  };
  return { deps, calls, docker };
}

async function build(draft, { cfg = config(), knownIssues = null, ...over } = {}) {
  const h = harness(over);
  const out = await buildListing({ draft, knownIssues, config: cfg, deps: h.deps, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vab-pipeline-')) });
  return { ...out, ...h };
}

test('accepted: code_review.json gets the image digest, linux/amd64, the unpacked size and the default limits', async () => {
  const { status, files, report, calls } = await build(draftSpec());
  assert.equal(status, 'accepted', JSON.stringify(report.refusals));
  const spec = JSON.parse(files.get('code_review.json'));
  assert.deepEqual(spec.env, { image: IMAGE, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 812000000 });
  assert.deepEqual(spec.limits, acceptedListing().limits);
  assert.equal(spec.baseline, 'baseline.json');
  assert.equal(spec.attestation, 'attestation.json');
  assert.equal(codeReview.validateCodeReviewSpec(spec).ok, true);
  assert.equal(files.get('code_review.json').toString(), `${JSON.stringify(spec, null, 2)}\n`);
  // baseline.json is the runner's, checked by common.
  const baseline = JSON.parse(files.get('baseline.json'));
  assert.deepEqual(baseline, acceptedListing().baseline);
  assert.equal(codeReview.validateBaseline(baseline, spec).ok, true);
  // The listing check ran on the pushed digest with the draft's commands; it attests nothing yet.
  assert.equal(calls.runner.length, 1);
  assert.equal(calls.runner[0].image, IMAGE);
  assert.equal(calls.runner[0].spec.env.image, IMAGE);
  assert.equal(calls.runner[0].spec.env.unpackedBytes, undefined, 'a draft size is never declared to the runner');
  assert.equal(files.has('attestation.json'), false);
  assert.equal(report.files['code_review.json'], sha256(files.get('code_review.json')));
});

test('the larger of the builder\'s and the runner\'s unpacked measurements is attested', async () => {
  const { files } = await build(draftSpec(), { unpacked: 900000000 });
  assert.equal(JSON.parse(files.get('code_review.json')).env.unpackedBytes, 1000000000);
});

test('limits the draft declares above the defaults are kept; the rest are the defaults', async () => {
  const { files } = await build(draftSpec({ limits: { runSeconds: 300, cpus: 1 } }));
  assert.deepEqual(JSON.parse(files.get('code_review.json')).limits, { ...acceptedListing().limits, runSeconds: 300, cpus: 1 });
});

test('a draft common rejects, or one the MVP builder cannot host, is refused before anything is fetched or built', async () => {
  for (const draft of [
    draftSpec({ env: { from: 'node22' } }),
    draftSpec({ commands: { framework: 'forge', test: 'forge test' } }),
    draftSpec({ repo: 'http://github.com/acme/vault' }),
    draftSpec({ stake: { ...draftSpec().stake, lowestClassCounted: 'LOW' } }),
  ]) {
    const { status, report, docker, calls } = await build(draft);
    assert.equal(status, 'refused', JSON.stringify(draft));
    assert.equal(report.refusals[0].code, 'SPEC_INVALID');
    assert.ok(report.refusals[0].issues.length > 0);
    assert.equal(docker.calls.length, 0);
    assert.equal(calls.fetch.length, 0);
  }
});

test('above 6 GB unpacked: refused before the push', async () => {
  const { status, report, docker } = await build(draftSpec(), { unpacked: 6000000000 });
  assert.equal(status, 'refused');
  assert.deepEqual(report.refusals.map((r) => r.code), ['IMAGE_UNPACKED_TOO_LARGE']);
  assert.ok(!docker.calls.some((c) => c.args[0] === 'push'));
});

test('above 2 GB compressed: refused after the push, before validation, with the pushed reference', async () => {
  const { status, report, calls } = await build(draftSpec(), { compressed: 2000000001 });
  assert.equal(status, 'refused');
  assert.deepEqual(report.refusals.map((r) => r.code), ['IMAGE_COMPRESSED_TOO_LARGE']);
  assert.equal(report.image.ref, IMAGE);
  assert.equal(calls.runner.length, 0);
});

test('an image that declares volumes is refused', async () => {
  const { status, report } = await build(draftSpec(), { volumes: ['/data'] });
  assert.equal(status, 'refused');
  assert.deepEqual(report.refusals.map((r) => r.code), ['IMAGE_DECLARES_VOLUMES']);
});

function explorerWith(routes) {
  const rec = recordedExplorer(routes);
  return { rec, explorerFor: (chainId, cfg) => createExplorer({ apiUrl: rec.apiUrl, apiKey: cfg.apiKey(), chainId, fetch: rec.fetch, timeoutMs: 5000 }) };
}

test('a contract listing whose verified source matches goes on to validation; the report records the comparison', async () => {
  const { explorerFor } = explorerWith({ getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault.json' });
  const { status, report, calls } = await build(contractDraft(), { explorerFor });
  assert.equal(status, 'accepted', JSON.stringify(report.refusals));
  assert.equal(report.verifiedSource.status, 'match');
  assert.equal(report.verifiedSource.contract.name, 'Vault');
  assert.equal(calls.collect[0].baseCommit, BASE_COMMIT);
  assert.equal(calls.collect[0].image, IMAGE, 'compiled in the pushed image');
  assert.equal(calls.runner.length, 1);
});

test('a contract listing whose verified source differs stops before validation', async () => {
  const { explorerFor } = explorerWith({ getsourcecode: 'getsourcecode-vault-edited.json', getcode: 'getcode-vault.json' });
  const { status, report, calls } = await build(contractDraft(), { explorerFor });
  assert.equal(status, 'refused');
  assert.ok(report.refusals.map((r) => r.code).includes('SOURCE_FILE_MISMATCH'));
  assert.equal(report.verifiedSource.status, 'mismatch');
  assert.equal(calls.runner.length, 0, 'the listing check never ran');
});

test('a contract listing on a chain with no explorer configured is a configuration error', async () => {
  const { status, report } = await build(contractDraft({ artifact: { kind: 'contract', address: '0x5f2A00000000000000000000000000000000C0dE', chainId: 1 } }));
  assert.equal(status, 'error');
  assert.equal(report.error.code, 'EXPLORER_NOT_CONFIGURED');
});

for (const code of ['LISTING_TOO_HEAVY', 'LIMITS_BELOW_DEFAULTS', 'LEGACY_ASSERTIONS']) {
  test(`validation refuses ${code}: the listing stops, no baseline.json`, async () => {
    const { status, report, files } = await build(draftSpec(), { runnerAnswer: () => definitive(IMAGE, refusedListing(code, 'why')) });
    assert.equal(status, 'refused');
    assert.deepEqual(report.refusals, [{ code, detail: 'why', step: 'listingCheck' }]);
    assert.equal(files.has('baseline.json'), false);
  });
}

test('an abstaining runner fails the build to be retried; the maker\'s listing is not refused', async () => {
  const { status, report } = await build(draftSpec(), { runnerAnswer: () => abstained('admission_refused') });
  assert.equal(status, 'error');
  assert.equal(report.error.code, 'LISTING_CHECK_ABSTAINED');
  assert.match(report.error.detail, /admission_refused/);
});

test('known_issues.json: validated, copied byte for byte, hashed in the report', async () => {
  const list = Buffer.from(`${JSON.stringify([{ id: 'sha256:x', title: 'Rounding', class: 'LOW', paths: ['src/Vault.sol'], description: 'Rounding favours the vault.' }])}\n`);
  const fixed = JSON.parse(list);
  fixed[0].id = codeReview.knownIssueId(fixed[0]);
  const bytes = Buffer.from(`${JSON.stringify(fixed, null, 2)}\n`);
  const draft = draftSpec({ stake: { ...draftSpec().stake, knownIssues: 'known_issues.json' } });
  const ok = await build(draft, { knownIssues: bytes });
  assert.equal(ok.status, 'accepted', JSON.stringify(ok.report.refusals));
  assert.ok(ok.files.get('known_issues.json').equals(bytes));
  assert.equal(ok.report.files['known_issues.json'], sha256(bytes));
  assert.equal((await build(draft)).report.refusals[0].code, 'KNOWN_ISSUES_MISSING');
  assert.equal((await build(draft, { knownIssues: list })).report.refusals[0].code, 'KNOWN_ISSUES_INVALID');
});

test('the validation report for the maker: steps, image, sizes, validation, refusals; no secret in it', async () => {
  const { report } = await build(draftSpec());
  assert.equal(report.kind, 'verdikta-listing-validation');
  assert.equal(report.version, 1);
  assert.equal(report.status, 'accepted');
  assert.deepEqual(report.listing, { repo: draftSpec().repo, baseCommit: BASE_COMMIT, artifact: { kind: 'repo' } });
  assert.deepEqual(report.steps.map((s) => [s.name, s.status]), [
    ['spec', 'ok'], ['fetch', 'ok'], ['build', 'ok'], ['size', 'ok'], ['push', 'ok'], ['registry', 'ok'], ['verifiedSource', 'skipped'], ['listingCheck', 'ok'], ['finalSpec', 'ok'],
  ]);
  assert.equal(report.image.ref, IMAGE);
  assert.equal(report.image.platform, 'linux/amd64');
  assert.equal(report.image.base, codeReview.BASE_IMAGE_PINS.foundry.reference);
  assert.deepEqual(report.image.limits, { imageCompressedBytes: 2000000000, imageUnpackedBytes: 6000000000 });
  assert.equal(report.image.compressedBytes, 300000000);
  assert.deepEqual(report.image.unpackedBytes, { builder: 800000000, runner: 812000000, attested: 812000000 });
  assert.equal(report.listingCheck.status, 'accepted');
  assert.deepEqual(report.listingCheck.timings, acceptedListing().timings);
  assert.deepEqual(report.listingCheck.limits, acceptedListing().limits);
  assert.deepEqual(report.baseline, { tests: 2, stable: 2, unstable: [] });
  assert.deepEqual(report.devOnly, []);
  assert.equal(report.attestation, null);
  const text = JSON.stringify(report);
  for (const secret of [RUNNER_TOKEN, EXPLORER_KEY]) assert.ok(!text.includes(secret), 'no secret in the report');
});

test('a build on another platform than the class\'s is recorded as dev-only', async () => {
  const cfg = config({ platforms: { setup: 'linux/arm64', run: 'linux/arm64', extra: ['linux/arm64'] } });
  const { report } = await build(draftSpec(), {
    cfg,
    runnerAnswer: () => definitive(IMAGE, acceptedListing(), { version: '0.1.0', runtime: 'runc', platform: 'linux/arm64' }),
  });
  assert.equal(report.status, 'accepted');
  assert.deepEqual(report.devOnly.map((d) => d.code).sort(), ['EXTRA_PLATFORMS', 'SETUP_ON_OTHER_PLATFORM', 'VALIDATED_ON_OTHER_PLATFORM', 'VALIDATED_WITHOUT_GVISOR'].sort());
});
