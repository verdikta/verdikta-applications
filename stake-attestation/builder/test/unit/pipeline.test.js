// The listing build end to end, with doubles for docker, the registry, the explorer and the
// code-runner. Acceptance 1 (digest, platform and unpackedBytes written into code_review.json;
// the size limits), 2 (a source mismatch stops the listing before validation), 3 (validation's
// baseline, timings and limits; its refusals stop the listing) and 5 (the maker's report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Wallet } from 'ethers';

import { codeReview } from '../../src/common.js';
import { deploymentMessage } from '../../src/listingProof.js';
import { parseConfig } from '../../src/config.js';
import { buildListing } from '../../src/pipeline.js';
import { createExplorer } from '../../src/explorer.js';
import { FIXTURES, fakeDocker, readFixture, recordedExplorer, sha256 } from '../helpers/fakes.js';
import { MAKER, deployment, provenAnswer, stake } from '../helpers/proof.js';
import { BASE_COMMIT, abstained, acceptedListing, cannotRun, commandCheckAnswer, contractDraft, definitive, draftSpec, refusedListing } from '../helpers/specs.js';
import { fetchingFrom, repositoryOf, treePaths } from '../helpers/gitTree.js';

const DIGEST = `sha256:${'2'.repeat(64)}`;
const REPOSITORY = 'ghcr.io/verdikta/stake-env';
const IMAGE = `${REPOSITORY}@${DIGEST}`;
const SIGNER = Wallet.createRandom();
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
  const calls = { fetch: [], runner: [], buildRepo: [], registry: [] };
  const docker = fakeDocker((args) => {
    if (args[0] === 'push') return { stdout: `digest: ${DIGEST} size: 1234\n` };
    if (args[0] === 'history') return { stdout: `${over.unpacked ?? 700000000}\n100000000\n` };
    return {};
  });
  const deps = {
    checkRepositoryControl: provenAnswer(),
    chainFor: () => deployment({ owner: SIGNER.address }),
    docker,
    fetchListedCommit: async (req) => { calls.fetch.push(req); return { gitDir: req.dir }; },
    writeBuildContext: () => ({ dockerfile: 'FROM x' }),
    registry: {
      imageInfo: async (digest, platform) => {
        calls.registry.push([digest, platform]);
        return { digest, manifestDigest: digest, compressedBytes: over.compressed ?? 300000000, platforms: over.platforms ?? ['linux/amd64'], config: { os: 'linux', architecture: 'amd64' }, volumes: over.volumes ?? [] };
      },
    },
    runner: {
      listingCheck: async (body) => {
        if (cannotRun(body)) return commandCheckAnswer(body);
        calls.runner.push(body);
        const d = (over.runnerAnswer ?? (() => definitive(IMAGE, acceptedListing())))(body);
        return { status: d.status, json: d.body };
      },
    },
    explorerFor: over.explorerFor,
    buildRepo: async (req) => {
      calls.buildRepo.push(req);
      return {
        files: new Map(req.paths.map((p) => [p, fs.readFileSync(path.join(FIXTURES, 'vault', p))])),
        config: readFixture('forge', 'config.json'),
        artifact: readFixture('forge', 'Vault.json'),
        build: { exitCode: 0, log: '' },
        skippedSubmodules: [],
        solc: { version: req.version, sha256: 'a'.repeat(64), platform: 'linux/amd64' },
      };
    },
    ...over.deps,
  };
  return { deps, calls, docker };
}

async function build(draft, { cfg = config(), knownIssues = null, ...over } = {}) {
  const h = harness(over);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-pipeline-'));
  try {
    const contract = draft.artifact?.kind === 'contract';
    const deploymentProof = contract ? { signer: SIGNER.address, signature: await SIGNER.signMessage(deploymentMessage({ spec: draft, maker: MAKER, stake })), stakeChainId: stake.chainId, stakeContract: stake.address } : null;
    const out = await buildListing({ draft, knownIssues, maker: MAKER, deploymentProof, config: cfg, deps: h.deps, workDir });
    assert.deepEqual(fs.readdirSync(workDir), [], 'the build removed its temporary folder');
    return { ...out, ...h };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
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
  const { baseline: _omitted, ...noBaseline } = draftSpec();
  for (const draft of [
    // The attestation would take the default baseline's name (and overwrite it at signing).
    { ...noBaseline, attestation: 'baseline.json' },
    draftSpec({ attestation: 'code_review.json' }),
    draftSpec({ baseline: '../baseline.json' }),
    draftSpec({ env: { from: 'node22' } }),
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
  // What the commands must be is the runner's to say, by its code, as early (test/unit/commands.test.js).
  const { status, report, docker, calls } = await build(draftSpec({ commands: { framework: 'forge', test: 'forge test' } }));
  assert.equal(status, 'refused');
  assert.deepEqual(report.refusals.map((r) => r.code), ['COMMAND_MISSING', 'COMMAND_MISSING', 'COMMAND_MISSING']);
  assert.equal(docker.calls.length, 0);
  assert.equal(calls.fetch.length, 0);
});

// Node P20: the documents step. After the fetch and before the build, the builder picks the listing's documents as the
// runner does, with common's selectDocuments over the listed commit's own entries (git ls-tree -r at baseCommit, from
// the objects it fetched by id), with no affected paths, and reports what the tier would read, what is past the cap
// and what is skipped, and why. A glob that matches nothing is a warning; matching that costs past common's step meter
// is refused by its own code, before anything is built or signed.
const { selectDocuments, STAKE_DOCUMENT_LIMITS } = codeReview;
const MAX = STAKE_DOCUMENT_LIMITS.maxFileBytes;
const DOCUMENT_FILES = {
  'README.md': '# Vault\nA deposit credits exactly the amount it receives.\n',
  'docs/a.md': 'A\n',
  'docs/b.md': 'B\n',
  'docs/big.md': 'b'.repeat(MAX + 1),
  'docs/bin.dat': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  'docs/latin1.md': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
  'docs/link.md': { link: '../README.md' },
  'docs/run.sh': { exec: '#!/bin/sh\necho run\n' },
  'docs/sub': { gitlink: 'f'.repeat(40) },
  'foundry.toml': '[profile.default]\n',
  'src/Other.sol': 'contract Other {}\n',
  'src/Vault.sol': 'contract Vault {}\n',
};

async function documentsBuild(files, documents, { later = null } = {}) {
  const repo = repositoryOf(files);
  const base = repo.commit;
  if (later) repo.commitOn(later);
  const fetches = [];
  const draft = draftSpec({ baseCommit: base, stake: { ...draftSpec().stake, documents } });
  try {
    const out = await build(draft, { deps: { fetchListedCommit: fetchingFrom(repo, fetches) }, runnerAnswer: () => definitive(IMAGE, acceptedListing(base)) });
    return { ...out, repo, base, draft, fetches, paths: treePaths(repo, base) };
  } finally {
    repo.cleanup();
  }
}

test('a draft naming stake.documents: common\'s selection over the listed commit\'s own tree, read, past the cap and skipped, before the build', async () => {
  const documents = ['README.md', 'docs/**', 'SPEC/**', 'src/Other.sol'];
  // a later commit on the branch, with other files: only the listed commit's own entries are candidates
  const { status, report, files, draft, paths, fetches } = await documentsBuild(DOCUMENT_FILES, documents, { later: { 'README.md': 'later\n', 'docs/later.md': 'L\n' } });
  assert.equal(status, 'accepted', JSON.stringify(report.refusals ?? report.error));
  assert.equal(fetches.length, 1);
  assert.deepEqual(report.steps.map((x) => [x.name, x.status]).slice(0, 5), [['spec', 'ok'], ['control', 'ok'], ['fetch', 'ok'], ['documents', 'ok'], ['build', 'ok']]);
  const selection = selectDocuments(paths, draft.stake, []);
  assert.deepEqual(selection.paths, ['README.md', 'docs/a.md', 'docs/b.md', 'docs/big.md', 'docs/bin.dat', 'docs/latin1.md', 'docs/link.md', 'docs/run.sh', 'docs/sub', 'src/Other.sol']);
  assert.deepEqual(report.documents, {
    globs: documents,
    candidates: paths.length,
    read: [
      { path: 'README.md', bytes: Buffer.byteLength(DOCUMENT_FILES['README.md']) },
      { path: 'docs/a.md', bytes: 2 },
      { path: 'docs/b.md', bytes: 2 },
      { path: 'docs/run.sh', bytes: Buffer.byteLength(DOCUMENT_FILES['docs/run.sh'].exec) },
      { path: 'src/Other.sol', bytes: Buffer.byteLength(DOCUMENT_FILES['src/Other.sol']) },
    ],
    pastCap: [],
    skipped: [
      { path: 'docs/big.md', reason: 'tooLarge', bytes: MAX + 1 },
      { path: 'docs/bin.dat', reason: 'notText', bytes: 6 },
      { path: 'docs/latin1.md', reason: 'notText', bytes: 5 },
      { path: 'docs/link.md', reason: 'symlink' },
      { path: 'docs/sub', reason: 'submodule' },
    ],
    unmatched: [{ index: 2, glob: 'SPEC/**' }],
  });
  assert.ok(!JSON.stringify(report.documents).includes('docs/later.md'), 'the later commit\'s file is no candidate');
  // the warning, for the maker: no refusal
  const warning = report.warnings.find((x) => x.code === 'STAKE_DOCUMENT_MATCHES_NOTHING');
  assert.equal(warning.path, '/stake/documents/2');
  assert.match(warning.detail, /SPEC\/\*\*/);
  assert.equal(report.refusals.length, 0);
  // the field is kept as the maker wrote it
  assert.deepEqual(JSON.parse(files.get('code_review.json')).stake.documents, documents);
});

test('past common\'s 32 files the rest are past the cap, by name, in the selection\'s order', async () => {
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`docs/f${String(i).padStart(2, '0')}.md`, `doc ${i}\n`]));
  const { status, report } = await documentsBuild({ ...many, 'src/Vault.sol': 'contract Vault {}\n' }, ['docs/**']);
  assert.equal(status, 'accepted', JSON.stringify(report.refusals));
  assert.equal(report.documents.read.length, STAKE_DOCUMENT_LIMITS.maxFiles);
  assert.equal(report.documents.read.at(-1).path, 'docs/f31.md');
  assert.deepEqual(report.documents.pastCap, Array.from({ length: 8 }, (_, i) => `docs/f${32 + i}.md`));
  assert.deepEqual(report.documents.unmatched, []);
});

test('globs too costly to match are refused as DOCUMENTS_MATCH_TOO_COSTLY at the documents step, before anything is built or signed', async () => {
  const deep = Array(14).fill('a'.repeat(200)).join('/');
  const files = { 'src/Vault.sol': 'contract Vault {}\n', ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`${deep}/a${i}b`, 'x\n'])) };
  let asked = 0;
  const repo = repositoryOf(files);
  try {
    const draft = draftSpec({ baseCommit: repo.commit, stake: { ...draftSpec().stake, documents: ['README.md', `a${'**a'.repeat(150)}**b`] } });
    assert.equal(codeReview.validateCodeReviewSpec({ ...draft, env: { from: 'foundry', image: IMAGE, platform: 'linux/amd64', unpackedBytes: 1 } }).ok, true, 'common takes the globs');
    assert.throws(() => selectDocuments(treePaths(repo, repo.commit), draft.stake, []), (e) => e instanceof RangeError && e.code === 'DOCUMENTS_MATCH_TOO_COSTLY');
    const runner = { listingCheck: async (body) => { if (cannotRun(body)) return commandCheckAnswer(body); asked += 1; throw new Error('the listing check was asked'); } };
    const { status, report, docker, files: out } = await build(draft, { deps: { fetchListedCommit: fetchingFrom(repo), runner } });
    assert.equal(status, 'refused', JSON.stringify(report.error));
    assert.deepEqual(report.refusals.map((r) => [r.step, r.code]), [['documents', 'DOCUMENTS_MATCH_TOO_COSTLY']]);
    assert.match(report.refusals[0].detail, /DOCUMENTS_MATCH_TOO_COSTLY/);
    assert.deepEqual(report.steps.map((x) => [x.name, x.status]), [['spec', 'ok'], ['control', 'ok'], ['fetch', 'ok'], ['documents', 'failed']]);
    assert.equal(asked, 0, 'no listing check');
    assert.equal(docker.calls.filter((c) => c.args[0] !== 'image').length, 0, 'nothing built');
    assert.equal(out.size, 0);
    assert.equal(Object.hasOwn(report, 'documents'), false);
  } finally {
    repo.cleanup();
  }
});

test('a draft without documents, or with an empty list, has no documents step and no documents section', async () => {
  for (const draft of [draftSpec(), draftSpec({ stake: { ...draftSpec().stake, documents: [] } })]) {
    const { status, report, files } = await build(draft);
    assert.equal(status, 'accepted', JSON.stringify(report.refusals));
    assert.deepEqual(report.steps.map((x) => x.name), ['spec', 'control', 'fetch', 'build', 'size', 'push', 'registry', 'verifiedSource', 'listingCheck', 'finalSpec']);
    assert.equal(Object.hasOwn(report, 'documents'), false);
    assert.equal(report.warnings.some((x) => /DOCUMENT/.test(x.code)), false);
    assert.deepEqual(JSON.parse(files.get('code_review.json')).stake.documents, draft.stake.documents);
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
  assert.equal(calls.buildRepo[0].baseCommit, BASE_COMMIT, 'built at the listed commit');
  assert.equal(calls.buildRepo[0].image, IMAGE, 'in the pushed image, for its forge and installed dependencies');
  assert.equal(calls.buildRepo[0].version, '0.8.31+commit.fd3a2265', 'with the compiler the explorer names');
  assert.equal(report.verifiedSource.summary.bytecode, 'match');
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
  const { status, report } = await build(contractDraft({ artifact: { kind: 'contract', address: '0x5f2A00000000000000000000000000000000C0dE', chainId: 1 } }), { deps: { chainFor: undefined } });
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
    ['spec', 'ok'], ['control', 'ok'], ['fetch', 'ok'], ['build', 'ok'], ['size', 'ok'], ['push', 'ok'], ['registry', 'ok'], ['verifiedSource', 'skipped'], ['listingCheck', 'ok'], ['finalSpec', 'ok'],
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

test('an index without a configured platform is an error; a build on another platform than the class\'s is recorded as dev-only', async () => {
  const missing = await build(draftSpec(), { cfg: config({ platforms: { extra: ['linux/arm64'] } }) });
  assert.equal(missing.status, 'error');
  assert.equal(missing.report.error.code, 'IMAGE_PLATFORM_MISSING');
  const cfg = config({ platforms: { setup: 'linux/arm64', run: 'linux/arm64', extra: ['linux/arm64'] } });
  const { report } = await build(draftSpec(), {
    cfg,
    platforms: ['linux/amd64', 'linux/arm64'],
    runnerAnswer: () => definitive(IMAGE, acceptedListing(), { version: '0.1.0', runtime: 'runc', platform: 'linux/arm64' }),
  });
  assert.equal(report.status, 'accepted', JSON.stringify(report.error));
  assert.deepEqual(report.devOnly.map((d) => d.code).sort(), ['EXTRA_PLATFORMS', 'RUN_ON_OTHER_PLATFORM', 'SETUP_ON_OTHER_PLATFORM', 'VALIDATED_ON_OTHER_PLATFORM', 'VALIDATED_WITHOUT_GVISOR'].sort());
});

test('registry.publishAs: the build pushes to and validates from a staging registry; code_review.json names the published repository at the same digest', async () => {
  const staging = '127.0.0.1:5000/stake-env';
  const cfg = config({ registry: { repository: staging, publishAs: REPOSITORY } });
  const staged = `${staging}@${DIGEST}`;
  const { status, files, report, calls, docker } = await build(draftSpec(), {
    cfg,
    runnerAnswer: (body) => definitive(body.image, acceptedListing()),
  });
  assert.equal(status, 'accepted', JSON.stringify(report.error ?? report.refusals));
  // Pushed, read and checked where the build can reach it, with no credential.
  assert.ok(docker.calls.some((c) => c.args[0] === 'push' && c.args[1].startsWith(`${staging}:`)));
  assert.deepEqual(calls.registry, [[DIGEST, 'linux/amd64']]);
  assert.equal(calls.runner[0].image, staged);
  assert.equal(calls.runner[0].spec.env.image, staged);
  // What arbiters pull: the published repository, by the digest validated.
  assert.equal(JSON.parse(files.get('code_review.json')).env.image, IMAGE);
  assert.equal(report.image.ref, IMAGE);
  assert.equal(report.image.stagedRef, staged);
  assert.throws(() => config({ registry: { repository: staging, publishAs: 'ghcr.io/verdikta/stake-env:latest' } }), /publishAs/);
});
