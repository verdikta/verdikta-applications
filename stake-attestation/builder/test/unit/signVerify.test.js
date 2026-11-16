// The sign step, as the reusable workflow's separate signing job runs it (design §20 decision 3):
// it receives only the build's outputs, so before it signs it checks everything it can without
// re-running the build (the files against the report, the report against itself and against the
// pins, the outputs against the digest the build job published, the image the listing names
// against its registry) and records what it could not check and therefore trusts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { main } from '../../src/cli.js';
import { outputsDigest } from '../../src/outputs.js';
import { createRegistryClient } from '../../src/registry.js';
import { DIGEST, MANIFEST_DIGEST, REPOSITORY, writeAcceptedBuild } from '../helpers/build.js';
import { fakeRegistry, registryImage } from '../helpers/fakes.js';
import { MAKER, provenAnswer } from '../helpers/proof.js';
import { contractDraft, draftSpec } from '../helpers/specs.js';
import { fetchingFrom, repositoryOf } from '../helpers/gitTree.js';

const BASE = codeReview.BASE_IMAGE_PINS.foundry;
const BASE_DIFF_IDS = [`sha256:${'b1'.repeat(32)}`, `sha256:${'b2'.repeat(32)}`];
const ENV_DIFF_IDS = [...BASE_DIFF_IDS, `sha256:${'e1'.repeat(32)}`, `sha256:${'e2'.repeat(32)}`];

function io() {
  let out = '';
  let err = '';
  return { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, get out() { return out; }, get err() { return err; } };
}

async function listing(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-signv-'));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const files = await writeAcceptedBuild(out, opts);
  const config = path.join(dir, 'builder.json');
  fs.writeFileSync(config, JSON.stringify({ registry: { repository: REPOSITORY }, runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' } }));
  const edit = (name, fn) => {
    const p = path.join(out, name);
    fs.writeFileSync(p, `${JSON.stringify(fn(JSON.parse(fs.readFileSync(p, 'utf8'))), null, 2)}\n`);
  };
  return { dir, out, config, edit, ...files, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function sign(l, extra = [], deps, maker = MAKER) {
  const t = io();
  const code = await main(['sign', '--config', l.config, '--dir', l.out, ...(maker ? ['--maker', maker] : []), ...extra], { env: {}, ...t, deps: { checkRepositoryControl: provenAnswer(), ...deps } });
  return { code, t, attested: fs.existsSync(path.join(l.out, 'attestation.json')) };
}

/** Registry doubles: the env image as the build reported it, the pinned base, and `over` on the env image. */
function registries(baseCommit, over = {}) {
  const seen = [];
  const registryFor = (repository) => ({
    async imageInfo(digest, platform) {
      seen.push({ repository, digest, platform });
      if (repository === BASE.repository && digest === BASE.digest) {
        return { digest, manifestDigest: digest, compressedBytes: 1, platforms: ['linux/amd64'], volumes: [], diffIds: BASE_DIFF_IDS, labels: {} };
      }
      if (repository === REPOSITORY && digest === DIGEST) {
        if (over.unreadable) throw Object.assign(new Error('HTTP 401'), { code: 'REGISTRY_UNAVAILABLE', detail: 'manifests: HTTP 401' });
        return {
          digest, manifestDigest: MANIFEST_DIGEST, compressedBytes: 300000000, platforms: ['linux/amd64'], volumes: [],
          diffIds: ENV_DIFF_IDS, labels: { 'io.verdikta.listing.base-commit': baseCommit, 'io.verdikta.builder.version': '0.1.0' }, ...over.info,
        };
      }
      throw Object.assign(new Error('unknown'), { code: 'REGISTRY_UNAVAILABLE', detail: `${repository}@${digest}` });
    },
  });
  return { registryFor, seen };
}

test('sign checks the build\'s outputs before signing and records what it checked and what it trusts', async () => {
  const l = await listing();
  const { code, t, attested } = await sign(l);
  assert.equal(code, 0, t.err);
  assert.ok(attested);
  const report = JSON.parse(fs.readFileSync(path.join(l.out, 'validation-report.json'), 'utf8'));
  assert.deepEqual(report.signing.checks, [
    'REPORT_ACCEPTED', 'FILES_MATCH_REPORT', 'SPEC_VALID', 'BASELINE_VALID', 'LISTING_MATCHES_REPORT',
    'STEPS_COMPLETE', 'COMMANDS_CHECKED', 'IMAGE_MATCHES_REPORT', 'SIZES_WITHIN_LIMITS', 'BASE_PINNED', 'PROJECT_PROOF_STANDS', 'LISTING_REQUEST_WITHIN_BOUND',
  ]);
  assert.deepEqual(report.signing.trusts.map((x) => x.code), ['LISTING_CHECK_RESULTS', 'UNPACKED_SIZE', 'BUILD_JOB', 'OUTPUTS_IN_TRANSIT', 'IMAGE_PUBLISHED']);
  for (const x of report.signing.trusts) assert.ok(x.detail.length > 20, x.code);
  l.cleanup();
});

test('a contract listing also trusts the verified-source comparison it cannot repeat', async () => {
  const l = await listing({ draft: contractDraft() });
  const { code, t } = await sign(l);
  assert.equal(code, 0, t.err);
  const report = JSON.parse(fs.readFileSync(path.join(l.out, 'validation-report.json'), 'utf8'));
  assert.ok(report.signing.checks.includes('STEPS_COMPLETE'));
  assert.deepEqual(report.signing.trusts.map((x) => x.code), ['LISTING_CHECK_RESULTS', 'VERIFIED_SOURCE', 'DEPLOYMENT_ROLE', 'UNPACKED_SIZE', 'BUILD_JOB', 'OUTPUTS_IN_TRANSIT', 'IMAGE_PUBLISHED']);
  l.cleanup();
  // One whose report names another deployment, or whose verified source was another address or
  // chain, is not signed.
  for (const tamper of [
    (r) => ({ ...r, listing: { ...r.listing, artifact: { ...r.listing.artifact, address: '0x0000000000000000000000000000000000000001' } } }),
    (r) => ({ ...r, listing: { ...r.listing, artifact: { ...r.listing.artifact, chainId: 1 } } }),
    (r) => ({ ...r, verifiedSource: { ...r.verifiedSource, explorer: { ...r.verifiedSource.explorer, address: '0x0000000000000000000000000000000000000001' } } }),
    (r) => ({ ...r, verifiedSource: { ...r.verifiedSource, explorer: { ...r.verifiedSource.explorer, chainId: 1 } } }),
  ]) {
    const lx = await listing({ draft: contractDraft() });
    lx.edit('validation-report.json', tamper);
    const r = await sign(lx);
    assert.equal(r.code, 1);
    assert.match(r.t.err, /LISTING_MISMATCH/);
    assert.equal(r.attested, false);
    lx.cleanup();
  }
  // One whose report does not say the source matched is not signed.
  const l2 = await listing({ draft: contractDraft() });
  l2.edit('validation-report.json', (r) => ({ ...r, verifiedSource: { ...r.verifiedSource, status: 'mismatch' } }));
  const bad = await sign(l2);
  assert.equal(bad.code, 1);
  assert.match(bad.t.err, /STEPS_INCOMPLETE/);
  assert.equal(bad.attested, false);
  l2.cleanup();
});

test('a report that disagrees with the files or with itself is not signed', async () => {
  const cases = [
    ['IMAGE_NOT_THE_REPORTS', (l) => l.edit('validation-report.json', (r) => ({ ...r, image: { ...r.image, ref: `${REPOSITORY}@sha256:${'9'.repeat(64)}` } }))],
    ['IMAGE_NOT_THE_REPORTS', (l) => l.edit('validation-report.json', (r) => ({ ...r, image: { ...r.image, digest: `sha256:${'9'.repeat(64)}` } }))],
    ['SIZE_MISMATCH', (l) => l.edit('validation-report.json', (r) => ({ ...r, image: { ...r.image, unpackedBytes: { ...r.image.unpackedBytes, runner: r.image.unpackedBytes.attested + 1 } } }))],
    ['SIZE_MISMATCH', (l) => l.edit('validation-report.json', (r) => ({ ...r, image: { ...r.image, compressedBytes: codeReview.CLASS_HARD_LIMITS.imageCompressedBytes + 1 } }))],
    ['LISTING_MISMATCH', (l) => l.edit('validation-report.json', (r) => ({ ...r, listing: { ...r.listing, baseCommit: 'e'.repeat(40) } }))],
    ['LISTING_MISMATCH', (l) => l.edit('validation-report.json', (r) => ({ ...r, listing: { ...r.listing, artifact: { kind: 'contract', address: '0x5f2A00000000000000000000000000000000C0dE', chainId: 8453 } } }))],
    ['STEPS_INCOMPLETE', (l) => l.edit('validation-report.json', (r) => ({ ...r, steps: r.steps.filter((s) => s.name !== 'listingCheck') }))],
    ['STEPS_INCOMPLETE', (l) => l.edit('validation-report.json', (r) => ({ ...r, listingCheck: { ...r.listingCheck, status: 'refused' } }))],
    // The command check (src/runner.js): a report that does not record it, or records a runner without the grammar.
    ['COMMANDS_NOT_CHECKED', (l) => l.edit('validation-report.json', (r) => { const { commands, ...rest } = r; return rest; })],
    ['COMMANDS_NOT_CHECKED', (l) => l.edit('validation-report.json', (r) => ({ ...r, commands: { ...r.commands, canary: null } }))],
    ['COMMANDS_NOT_CHECKED', (l) => l.edit('validation-report.json', (r) => ({ ...r, commands: { ...r.commands, issues: [{ code: 'COMMAND_NOT_ALLOWED' }] } }))],
    ['BASE_NOT_PINNED', (l) => l.edit('validation-report.json', (r) => ({ ...r, image: { ...r.image, base: 'ghcr.io/foundry-rs/foundry:latest' } }))],
    ['SIGNING_NOT_ACCEPTED', (l) => l.edit('validation-report.json', (r) => ({ ...r, status: 'error' }))],
    ['SIGNING_REPORT_MISMATCH', (l) => l.edit('baseline.json', (b) => ({ ...b, unstable: [b.stable[0]] }))],
  ];
  for (const [codeName, tamper] of cases) {
    const l = await listing();
    tamper(l);
    const { code, t, attested } = await sign(l);
    assert.equal(code, 1, codeName);
    assert.match(t.err, new RegExp(codeName), t.err);
    assert.equal(attested, false, `${codeName}: nothing written`);
    l.cleanup();
  }
});

test('a baseline that the report vouches for but common rejects is not signed', async () => {
  const l = await listing();
  // Consistent hashes, broken content: the report is rewritten to vouch for the edited baseline.
  l.edit('baseline.json', (b) => ({ ...b, runs: 2 }));
  const bytes = fs.readFileSync(path.join(l.out, 'baseline.json'));
  l.edit('validation-report.json', (r) => ({ ...r, files: { ...r.files, 'baseline.json': sha256hex(bytes) } }));
  const { code, t, attested } = await sign(l);
  assert.equal(code, 1);
  assert.match(t.err, /BASELINE_INVALID/);
  assert.equal(attested, false);
  l.cleanup();
});

function sha256hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Node P20: a listing that names documents is built with them (test/unit/pipeline.test.js), and sign repeats their
// selection before it signs: it fetches the listed commit again, by id, runs common's selectDocuments over its own
// entries, refuses DOCUMENTS_MATCH_TOO_COSTLY by that code, and signs only what the report records. A listing without
// documents fetches nothing more and records no more checks (test/unit/noDocuments.test.js).
const DOC_FILES = { 'README.md': '# Vault\n', 'docs/spec.md': 'spec\n', 'src/Vault.sol': 'contract Vault {}\n' };
async function documentsListing(documents = ['README.md', 'docs/**'], files = DOC_FILES) {
  const repo = repositoryOf(files);
  const draft = draftSpec({ baseCommit: repo.commit, stake: { ...draftSpec().stake, documents } });
  const l = await listing({ draft, deps: { fetchListedCommit: fetchingFrom(repo) } });
  return { l, repo, draft };
}

test('a listing naming stake.documents is signed after sign repeats the selection over the listed commit, fetched again by id', async () => {
  const { l, repo } = await documentsListing();
  const fetches = [];
  const { code, t, attested } = await sign(l, [], { fetchListedCommit: fetchingFrom(repo, fetches) });
  assert.equal(code, 0, t.err);
  assert.ok(attested);
  assert.equal(fetches.length, 1, 'sign fetched the listed commit');
  assert.equal(fetches[0].baseCommit, repo.commit);
  const report = JSON.parse(fs.readFileSync(path.join(l.out, 'validation-report.json'), 'utf8'));
  assert.deepEqual(report.signing.checks.slice(-4), ['BASE_PINNED', 'DOCUMENTS_SELECTED', 'PROJECT_PROOF_STANDS', 'LISTING_REQUEST_WITHIN_BOUND']);
  assert.deepEqual(report.documents.read.map((d) => d.path), ['README.md', 'docs/spec.md']);
  l.cleanup();
  repo.cleanup();
});

test('sign repeats DOCUMENTS_MATCH_TOO_COSTLY: globs too costly to match are not signed, however the folder was made', async () => {
  const deep = Array(14).fill('a'.repeat(200)).join('/');
  const files = { ...DOC_FILES, ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`${deep}/a${i}b`, 'x\n'])) };
  const { l, repo } = await documentsListing(['README.md'], files);
  // the folder is edited to name costly globs, and its report to vouch for them
  const costly = ['README.md', `a${'**a'.repeat(150)}**b`];
  l.edit('code_review.json', (s) => ({ ...s, stake: { ...s.stake, documents: costly } }));
  const bytes = fs.readFileSync(path.join(l.out, 'code_review.json'));
  l.edit('validation-report.json', (r) => ({ ...r, files: { ...r.files, 'code_review.json': sha256hex(bytes) }, documents: { ...r.documents, globs: costly } }));
  const { code, t, attested } = await sign(l, [], { fetchListedCommit: fetchingFrom(repo) });
  assert.equal(code, 1);
  assert.match(t.err, /DOCUMENTS_MATCH_TOO_COSTLY/);
  assert.equal(attested, false);
  l.cleanup();
  repo.cleanup();
});

test('sign refuses a documents record that is not what the selection gives, or a report without the documents step', async () => {
  const cases = [
    ['SIGNING_REPORT_MISMATCH', (r) => ({ ...r, documents: { ...r.documents, read: r.documents.read.slice(1) } })],
    ['SIGNING_REPORT_MISMATCH', (r) => ({ ...r, documents: { ...r.documents, skipped: [{ path: 'README.md', reason: 'notText', bytes: 8 }] } })],
    ['SIGNING_REPORT_MISMATCH', (r) => ({ ...r, documents: { ...r.documents, globs: ['README.md'] } })],
    ['SIGNING_REPORT_MISMATCH', (r) => { const { documents, ...rest } = r; return rest; }],
    ['STEPS_INCOMPLETE', (r) => ({ ...r, steps: r.steps.filter((s) => s.name !== 'documents') })],
    ['STEPS_INCOMPLETE', (r) => ({ ...r, steps: r.steps.map((s) => (s.name === 'documents' ? { ...s, status: 'failed' } : s)) })],
  ];
  for (const [codeName, tamper] of cases) {
    const { l, repo } = await documentsListing();
    l.edit('validation-report.json', tamper);
    const { code, t, attested } = await sign(l, [], { fetchListedCommit: fetchingFrom(repo) });
    assert.equal(code, 1, codeName);
    assert.match(t.err, new RegExp(codeName), t.err);
    assert.equal(attested, false);
    l.cleanup();
    repo.cleanup();
  }
  // and a listing without documents whose report has a documents step or section is not one this builder made
  for (const tamper of [
    (r) => ({ ...r, steps: [...r.steps.slice(0, 3), { name: 'documents', status: 'ok', durationMs: 1 }, ...r.steps.slice(3)] }),
    (r) => ({ ...r, documents: { globs: [], candidates: 0, read: [], pastCap: [], skipped: [], unmatched: [] } }),
  ]) {
    const l = await listing();
    l.edit('validation-report.json', tamper);
    const { code, attested } = await sign(l);
    assert.equal(code, 1);
    assert.equal(attested, false);
    l.cleanup();
  }
});

test('--expect-outputs: the folder must be the one the build job digested; any change in transit refuses', async () => {
  const l = await listing();
  const t0 = io();
  assert.equal(await main(['digest', '--dir', l.out], { env: {}, ...t0 }), 0);
  const digest = t0.out.trim();
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, outputsDigest(l.out));
  // One byte of the report changes after the digest was taken.
  fs.appendFileSync(path.join(l.out, 'validation-report.json'), ' ');
  const bad = await sign(l, ['--expect-outputs', digest]);
  assert.equal(bad.code, 1);
  assert.match(bad.t.err, /OUTPUTS_CHANGED/);
  assert.equal(bad.attested, false);
  // A file the listing does not have is refused whether or not a digest is expected.
  const l2 = await listing();
  const d2 = outputsDigest(l2.out);
  fs.writeFileSync(path.join(l2.out, 'extra.json'), '{}');
  assert.match((await sign(l2, ['--expect-outputs', d2])).t.err, /OUTPUT_INVALID: .* also holds extra\.json/);
  assert.match((await sign(l2)).t.err, /OUTPUT_INVALID/);
  fs.rmSync(path.join(l2.out, 'extra.json'));
  const good = await sign(l2, ['--expect-outputs', d2]);
  assert.equal(good.code, 0, good.t.err);
  const report = JSON.parse(fs.readFileSync(path.join(l2.out, 'validation-report.json'), 'utf8'));
  assert.ok(report.signing.checks.includes('OUTPUTS_MATCH_BUILD'));
  assert.ok(!report.signing.trusts.some((x) => x.code === 'OUTPUTS_IN_TRANSIT'));
  assert.equal((await sign(l2, ['--expect-outputs', 'xyz'])).code, 64);
  l.cleanup();
  l2.cleanup();
});

test('--check-registry: the published image is the one the build measured, FROM the pinned base, labelled with the commit', async () => {
  const l = await listing();
  const spec = JSON.parse(l.cr.toString('utf8'));
  const r = registries(spec.baseCommit);
  const { code, t } = await sign(l, ['--check-registry'], { registryFor: r.registryFor });
  assert.equal(code, 0, t.err);
  assert.deepEqual(r.seen.map((s) => `${s.repository}@${s.digest} ${s.platform}`).sort(), [
    `${BASE.repository}@${BASE.digest} linux/amd64`,
    `${REPOSITORY}@${DIGEST} linux/amd64`,
  ].sort());
  const report = JSON.parse(fs.readFileSync(path.join(l.out, 'validation-report.json'), 'utf8'));
  for (const c of ['IMAGE_PUBLISHED', 'IMAGE_MATCHES_MEASUREMENTS', 'IMAGE_FROM_PINNED_BASE', 'IMAGE_LABELLED_WITH_COMMIT']) assert.ok(report.signing.checks.includes(c), c);
  assert.ok(!report.signing.trusts.some((x) => x.code === 'IMAGE_PUBLISHED'));
  l.cleanup();
});

test('--check-registry refuses an image arbiters could not pull, or one that is not what the build measured', async () => {
  const cases = [
    ['IMAGE_NOT_PUBLISHED', { unreadable: true }],
    ['IMAGE_DIFFERS_FROM_REPORT', { info: { manifestDigest: `sha256:${'4'.repeat(64)}` } }],
    ['IMAGE_DIFFERS_FROM_REPORT', { info: { compressedBytes: 300000001 } }],
    ['IMAGE_DIFFERS_FROM_REPORT', { info: { volumes: ['/data'] } }],
    ['IMAGE_NOT_FROM_PINNED_BASE', { info: { diffIds: [`sha256:${'c1'.repeat(32)}`, ...ENV_DIFF_IDS.slice(1)] } }],
    ['IMAGE_LABEL_MISMATCH', { info: { labels: { 'io.verdikta.listing.base-commit': 'f'.repeat(40) } } }],
  ];
  for (const [codeName, over] of cases) {
    const l = await listing();
    const spec = JSON.parse(l.cr.toString('utf8'));
    const { code, t, attested } = await sign(l, ['--check-registry'], { registryFor: registries(spec.baseCommit, over).registryFor });
    assert.equal(code, 1, codeName);
    assert.match(t.err, new RegExp(codeName), t.err);
    assert.equal(attested, false);
    l.cleanup();
  }
});

test('the registry client reports an image\'s layer diff ids and labels from its config', async () => {
  const image = registryImage({ diffIds: ENV_DIFF_IDS, labels: { 'io.verdikta.listing.base-commit': 'a'.repeat(40) } });
  const srv = await fakeRegistry({ name: 'verdikta/stake-env', image });
  try {
    const client = createRegistryClient({ repository: `127.0.0.1:${srv.port}/verdikta/stake-env` });
    const info = await client.imageInfo(image.digest, 'linux/amd64');
    assert.deepEqual(info.diffIds, ENV_DIFF_IDS);
    assert.deepEqual(info.labels, { 'io.verdikta.listing.base-commit': 'a'.repeat(40) });
  } finally {
    await srv.close();
  }
});

// node P9: nothing is signed without the project's proof
test('sign repeats the project\'s proof: another maker, no maker, or a proof that no longer stands is not signed', async () => {
  const OTHER = '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2';
  const cases = [
    [[], {}, OTHER, 'SIGNING_MAKER_MISMATCH'],
    [[], {}, null, 'SIGNING_MAKER_REQUIRED'],
    [[], { checkRepositoryControl: provenAnswer(OTHER) }, MAKER, 'PROOF_NAMES_ANOTHER_ADDRESS'],
    [[], { checkRepositoryControl: async () => ({ reachable: false, ref: null, file: null }) }, MAKER, 'COMMIT_NOT_ON_OWN_REFS'],
    [[], { checkRepositoryControl: async () => ({ reachable: true, ref: 'refs/heads/main', file: null }) }, MAKER, 'NO_PROOF_FILE'],
  ];
  for (const [extra, deps, maker, code] of cases) {
    const l = await listing();
    const r = await sign(l, extra, deps, maker);
    assert.equal(r.code, 1, code);
    assert.match(r.t.err, new RegExp(code));
    assert.equal(r.attested, false, code);
    l.cleanup();
  }
});

test('a report that records no proof, or one for another commit, is not signed', async () => {
  for (const fn of [(report) => { report.control = null; }, (report) => { report.control.commit = 'f'.repeat(40); }, (report) => { report.steps = report.steps.filter((s) => s.name !== 'control'); }]) {
    const l = await listing();
    l.edit('validation-report.json', (r) => { fn(r); return r; });
    const { code, attested } = await sign(l);
    assert.equal(code, 1);
    assert.equal(attested, false);
    l.cleanup();
  }
});

test('a contract\'s signature in the report that does not recover to its signer is not signed', async () => {
  const l = await listing({ draft: contractDraft() });
  l.edit('validation-report.json', (r) => { r.control.deployment.signature = `0x${'11'.repeat(65)}`; return r; });
  const { code, t, attested } = await sign(l);
  assert.equal(code, 1);
  assert.match(t.err, /SIGNING_MAKER_MISMATCH/);
  assert.equal(attested, false);
  l.cleanup();
});
