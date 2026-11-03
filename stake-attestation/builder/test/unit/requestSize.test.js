// Node P11: a listing can't make every claim abstain by size. The External Adapter sends the
// code-runner one JSON body per claim, and the runner answers 413 above 16 MiB; the listing's files are
// in that body every time. So the builder measures the listing as the body holds it and refuses to sign
// one that leaves a claim and its prior findings no room (LISTING_REQUEST_TOO_LARGE). The request here is
// this repository's copy of the EA's: e2e/test/requestSize.test.js holds it to the arbiter's real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { wordingProblems } from '@verdikta/stake-attestation-shared';
import {
  LISTING_REQUEST_MAX_BYTES,
  LISTING_REQUEST_TOO_LARGE,
  RUNNER_MAX_BODY_BYTES,
  RUNNER_MAX_DEADLINE_MS,
  claimSideBytes,
  listingParts,
  listingRequestBound,
  listingRequestRefusal,
  listingRequestSize,
  requestBytes,
  runRequestBody,
  worstClaimContext,
} from '@verdikta/stake-attestation-shared/listing-request-size';

import { baselineOfBytes } from '../../../shared/test/helpers/baselineOfBytes.js';
import { main } from '../../src/cli.js';
import { codeReview } from '../../src/common.js';
import { Refusal } from '../../src/errors.js';
import { writeOutputs } from '../../src/outputs.js';
import { attest, loadSigningKey } from '../../src/signing.js';
import { doubledBuild, REPOSITORY } from '../helpers/build.js';
import { FIXTURES, sha256 } from '../helpers/fakes.js';
import { MAKER, provenAnswer } from '../helpers/proof.js';
import { BASE_COMMIT, draftSpec } from '../helpers/specs.js';

const CLASSES = Object.keys(codeReview.CODE_CLASSES);
const withKnownIssues = () => draftSpec({ stake: { ...draftSpec().stake, knownIssues: 'known_issues.json' } });

function knownIssueList(count = 1, description = 'Withdrawals round down by at most one wei; accepted.') {
  return Array.from({ length: count }, (_, i) => {
    const body = { title: `Accepted issue ${i}`, class: 'LOW', paths: ['src/Vault.sol'], description };
    return { id: codeReview.knownIssueId(body), ...body };
  });
}
const pretty = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** The files of an accepted build, by role. */
function filesOf(result, draft) {
  return {
    codeReview: result.files.get('code_review.json'),
    baseline: result.files.get(draft.baseline),
    knownIssues: draft.stake.knownIssues ? result.files.get(draft.stake.knownIssues) : null,
  };
}

/** A build whose listing takes `extra` bytes more than the bound (0: exactly the bound). */
async function buildAround(extra, { draft = draftSpec(), knownIssues = null, idLength } = {}) {
  const small = await doubledBuild({ draft, knownIssues });
  assert.equal(small.status, 'accepted', JSON.stringify(small.report.refusals));
  const { parts } = small.report.listingRequest;
  const baseline = baselineOfBytes(LISTING_REQUEST_MAX_BYTES + extra - parts.spec - parts.attestation - parts.knownIssues, draft.baseCommit, { idLength });
  return { result: await doubledBuild({ draft, knownIssues, baseline }), baseline };
}

// Acceptance 1, and the arithmetic of the review focus.

test('the worst claim is one the front gates let through: every part at its cap, at 6 bytes a character', () => {
  for (const codeClass of CLASSES) {
    const context = worstClaimContext({ spec: {}, attestation: {}, baseline: {}, knownIssues: [] }, { codeReview, codeClass });
    const { claim, priorFindings } = context;
    assert.deepEqual(codeReview.validateFinding(claim.finding).issues, []);
    assert.equal(priorFindings.length, codeReview.MAX_PRIOR_FINDINGS);
    assert.equal(new Set([claim.bcid, ...priorFindings.map((p) => p.bcid)]).size, codeReview.MAX_PRIOR_FINDINGS + 1, 'no CID appears twice in a request');
    for (const prior of priorFindings) assert.deepEqual(codeReview.validateFinding(prior.finding).issues, []);
    const f = codeReview.schemas.finding;
    assert.equal(claim.finding.title.length, f.properties.title.maxLength);
    assert.equal(claim.finding.rootCause.length, f.properties.rootCause.maxLength);
    assert.equal(claim.finding.poc.command.length, f.properties.poc.properties.command.maxLength);
    assert.equal(claim.finding.poc.observable.length, f.properties.poc.properties.observable.maxLength);
    assert.equal(claim.finding.affectedPaths.length, f.properties.affectedPaths.maxItems);
    for (const p of claim.finding.affectedPaths) assert.equal(p.length, f.definitions.RepoPath.maxLength);
    assert.equal(claim.pocPatch.length, codeReview.SPEC_LIMIT_MAXIMA.maxPatchBytes);
    assert.equal(claim.fixPatch.length, codeReview.SPEC_LIMIT_MAXIMA.maxPatchBytes);
    // every text costs JSON's most: 6 bytes per UTF-16 unit
    const wide = (text) => assert.equal(Buffer.byteLength(JSON.stringify(text)), text.length * 6 + 2);
    for (const text of [claim.finding.title, claim.finding.rootCause, claim.finding.poc.command, claim.finding.poc.observable, ...claim.finding.affectedPaths]) wide(text);
    const body = runRequestBody(context, RUNNER_MAX_DEADLINE_MS, { codeReview });
    wide(body.report);
    assert.equal(body.report.length, codeReview.getCodeClass(codeClass).envelope.contextPackTokens * 4, 'report.md goes as far as the whole pack could hold');
    for (const prior of body.priorFindings) {
      wide(prior.report);
      assert.equal(prior.report.length, 4096);
    }
  }
});

test('the bound: a claim and its priors at their caps leave at least it in the runner\'s limit, at every class', () => {
  assert.equal(RUNNER_MAX_BODY_BYTES, 16 * 1024 * 1024);
  assert.equal(LISTING_REQUEST_MAX_BYTES, 2 * 1024 * 1024);
  const empty = { spec: {}, attestation: {}, baseline: {}, knownIssues: [] };
  const seen = {};
  for (const codeClass of CLASSES) {
    const whole = requestBytes(runRequestBody(worstClaimContext(empty, { codeReview, codeClass }), RUNNER_MAX_DEADLINE_MS, { codeReview }));
    // the empty parts are 8 bytes of it
    assert.ok(whole - 8 + LISTING_REQUEST_MAX_BYTES <= RUNNER_MAX_BODY_BYTES, `${codeClass}: ${whole}`);
    seen[codeClass] = whole;
  }
  // The figures the PR states. A change here is a change to what the bound rests on: read it again.
  assert.deepEqual(seen, { 'code-standard': 12784423, 'code-premium': 14224422 });
  assert.equal(claimSideBytes({ codeReview }), 14224422 - 8, 'the largest class');
  assert.equal(RUNNER_MAX_BODY_BYTES - claimSideBytes({ codeReview }), 2552802);
  assert.equal(listingRequestBound({ codeReview }), LISTING_REQUEST_MAX_BYTES);
});

test('a common release that raised a cap lowers the bound: a claim still fits', () => {
  const raised = { ...codeReview, SPEC_LIMIT_MAXIMA: { ...codeReview.SPEC_LIMIT_MAXIMA, maxPatchBytes: 3000000 } };
  const bound = listingRequestBound({ codeReview: raised });
  assert.ok(bound < LISTING_REQUEST_MAX_BYTES, String(bound));
  assert.equal(bound, RUNNER_MAX_BODY_BYTES - claimSideBytes({ codeReview: raised }));
  const padded = { spec: {}, attestation: {}, knownIssues: [], baseline: baselineOfBytes(bound - 6, BASE_COMMIT) };
  assert.equal(listingRequestSize(padded).bytes, bound);
  assert.equal(listingRequestRefusal(padded, { codeReview: raised }), null);
  assert.equal(listingRequestRefusal({ ...padded, baseline: baselineOfBytes(bound - 5, BASE_COMMIT) }, { codeReview: raised }).code, LISTING_REQUEST_TOO_LARGE);
});

test('the number is what the listing adds to the request: every part the EA sends counts, and nothing else', () => {
  const parts = {
    spec: { repo: 'https://github.com/acme/vault', x: '\u0001' },
    attestation: { trust: 'dev' },
    baseline: { tests: ['a"b'] },
    knownIssues: [{ id: 'k\\' }],
  };
  const empty = { spec: {}, attestation: {}, baseline: {}, knownIssues: [] };
  const added = (listing) => requestBytes(runRequestBody(worstClaimContext(listing, { codeReview, codeClass: 'code-standard' }), RUNNER_MAX_DEADLINE_MS, { codeReview }));
  const { bytes } = listingRequestSize(parts);
  assert.equal(added(parts) - added(empty), bytes - 8);
  // whichever part grows
  for (const key of Object.keys(parts)) {
    const grown = structuredClone(parts);
    if (Array.isArray(grown[key])) grown[key].push(1);
    else grown[key].more = 1;
    assert.equal(added(grown) - added(parts), listingRequestSize(grown).bytes - bytes, key);
  }
});

test('the measure is the bytes JSON writes in the request, not the bytes of the file', () => {
  const files = (baselineText) => ({
    codeReview: Buffer.from('{ "repo":   "x" }\n'),
    attestation: Buffer.from('{}'),
    baseline: Buffer.from(baselineText),
    knownIssues: null,
  });
  const bytes = (text) => listingRequestSize(listingParts(files(text))).parts.baseline;
  // whitespace and a letter written as an escape are gone
  assert.equal(bytes('{ "a" :  "\\u0041" }'), Buffer.byteLength('{"a":"A"}'));
  // a control character takes JSON's 6 bytes, a lone surrogate too, however the file wrote them
  assert.equal(bytes('{"a":"\\u0001"}'), Buffer.byteLength('{"a":"\\u0001"}'));
  assert.equal(bytes('{"a":"\\ud800"}'), Buffer.byteLength('{"a":"\\ud800"}'));
  // a number written short goes long
  assert.equal(bytes('{"a":1e20}'), Buffer.byteLength('{"a":100000000000000000000}'));
  // and code_review.json with no known issues is [], as the EA sends it
  const parts = listingParts(files('{}'));
  assert.deepEqual(parts.knownIssues, []);
  assert.equal(listingRequestSize(parts).parts.knownIssues, 2);
});

// Acceptance 2.

test('a listing at the bound, with a claim and 8 prior findings at their caps: the request fits. One byte over is refused', async () => {
  const draft = withKnownIssues();
  const knownIssues = pretty(knownIssueList(3));
  const { result, baseline } = await buildAround(0, { draft, knownIssues });
  assert.equal(result.status, 'accepted', JSON.stringify(result.report.refusals));
  assert.equal(result.report.listingRequest.bytes, LISTING_REQUEST_MAX_BYTES);
  assert.equal(result.report.listingRequest.maxBytes, LISTING_REQUEST_MAX_BYTES);

  // signed, and measured again from the files as the EA reads them
  const files = filesOf(result, draft);
  const { bytes: attestation } = await attest({ files, report: result.report, key: loadSigningKey('dev') });
  const parts = listingParts({ ...files, attestation });
  assert.equal(listingRequestSize(parts).bytes, LISTING_REQUEST_MAX_BYTES, 'what build measured is what is signed');
  for (const codeClass of CLASSES) {
    const body = runRequestBody(worstClaimContext(parts, { codeReview, codeClass }), RUNNER_MAX_DEADLINE_MS, { codeReview });
    assert.equal(body.priorFindings.length, 8);
    const size = requestBytes(body);
    assert.ok(size <= RUNNER_MAX_BODY_BYTES, `${codeClass}: ${size}`);
  }

  const { result: over } = await buildAround(1, { draft, knownIssues });
  assert.equal(over.status, 'refused');
  assert.equal(over.report.refusals[0].code, LISTING_REQUEST_TOO_LARGE);
  assert.equal(over.report.refusals[0].step, 'finalSpec');
  assert.equal(over.files.size, 0, 'nothing is left to sign');
  assert.equal(over.report.listingRequest.bytes, LISTING_REQUEST_MAX_BYTES + 1);
  // the baseline the size came from is as long as the runner sent it
  assert.ok(baseline.tests.length > 0);
});

test('the refusal says the size and the bound, passes the wording rule and names no project', async () => {
  const { result } = await buildAround(1);
  const { detail } = result.report.refusals[0];
  assert.match(detail, new RegExp(`\\b${LISTING_REQUEST_MAX_BYTES + 1} bytes`));
  assert.match(detail, new RegExp(`at most ${LISTING_REQUEST_MAX_BYTES}\\b`));
  assert.deepEqual(wordingProblems(detail), []);
  assert.equal(detail.includes('acme'), false, detail);
  assert.equal(/0x[0-9a-fA-F]{40}/.test(detail), false, detail);
});

test('every part counts: one byte more in code_review.json or in the known issues is refused too', async () => {
  const draft = withKnownIssues();
  const knownIssues = pretty(knownIssueList(1));
  const { baseline } = await buildAround(0, { draft, knownIssues });
  const refused = (r) => {
    assert.equal(r.status, 'refused', JSON.stringify(r.report.refusals));
    assert.equal(r.report.refusals[0].code, LISTING_REQUEST_TOO_LARGE);
  };
  const longerSpec = { ...draft, commands: { ...draft.commands, setup: `${draft.commands.setup} ` } };
  refused(await doubledBuild({ draft: longerSpec, knownIssues, baseline }));
  const longerIssues = pretty(knownIssueList(1, 'Withdrawals round down by at most one wei; accepted!!'));
  refused(await doubledBuild({ draft, knownIssues: longerIssues, baseline }));
});

test('known issues too large on their own are refused in the spec step, before anything is fetched or built', async () => {
  const draft = withKnownIssues();
  // the schema's own caps allow far more than the bound, at 256 entries
  const description = 'd'.repeat(2000);
  const paths = Array.from({ length: 50 }, (_, i) => `src/${String(i).padStart(2, '0')}/${'p'.repeat(500)}.sol`);
  const list = Array.from({ length: 256 }, (_, i) => {
    const body = { title: `Accepted issue ${i}`, class: 'LOW', paths, description };
    return { id: codeReview.knownIssueId(body), ...body };
  });
  assert.deepEqual(codeReview.validateKnownIssues(list).issues, []);
  const r = await doubledBuild({ draft, knownIssues: pretty(list) });
  assert.equal(r.status, 'refused');
  assert.equal(r.report.refusals[0].code, LISTING_REQUEST_TOO_LARGE);
  assert.equal(r.report.refusals[0].step, 'spec');
  assert.equal(r.fetches.length, 0, 'nothing was fetched');
  assert.equal(r.runs.length, 0, 'the code-runner was not called');
  assert.equal(r.report.steps.some((s) => s.name === 'build'), false);
});

// The review focus: a listing that passes signing and still makes every claim abstain.

test('known_issues.json padded with whitespace: its file size counts, since its bytes are attested as given', async () => {
  const draft = withKnownIssues();
  const list = knownIssueList(1);
  const padded = Buffer.concat([pretty(list), Buffer.alloc(LISTING_REQUEST_MAX_BYTES, 0x20)]);
  const r = await doubledBuild({ draft, knownIssues: padded });
  assert.equal(r.status, 'refused', JSON.stringify(r.report.refusals));
  assert.equal(r.report.refusals[0].code, LISTING_REQUEST_TOO_LARGE);
  // unpadded it passes
  assert.equal((await doubledBuild({ draft, knownIssues: pretty(list) })).status, 'accepted');
});

test('known_issues.json that is not UTF-8 is refused: the EA decodes strictly and would refuse every claim', async () => {
  const draft = withKnownIssues();
  const description = `Accepted, with a byte no decoder takes: �${'.'.repeat(10)}`;
  const body = { title: 'Accepted issue', class: 'LOW', paths: ['src/Vault.sol'], description };
  // the id of the text a lossy decoder would read, so only the strict decode tells them apart
  const text = pretty([{ id: codeReview.knownIssueId(body), ...body }]);
  const at = text.indexOf(Buffer.from('�'));
  const broken = Buffer.concat([text.subarray(0, at), Buffer.from([0xff]), text.subarray(at + 3)]);
  assert.deepEqual(codeReview.validateKnownIssues(JSON.parse(broken.toString('utf8'))).issues, [], 'a lossy read passes');
  const r = await doubledBuild({ draft, knownIssues: broken });
  assert.equal(r.status, 'refused');
  assert.equal(r.report.refusals[0].code, 'KNOWN_ISSUES_INVALID');
  assert.match(r.report.refusals[0].detail, /UTF-8/);
});

test('nothing over the bound is signed: attest refuses before the key is asked, whatever build said', async () => {
  const draft = draftSpec();
  const { result, baseline } = await buildAround(0, { draft });
  assert.equal(result.status, 'accepted');
  const files = filesOf(result, draft);
  const over = { ...files, baseline: pretty({ ...baseline, timings: { ...baseline.timings, buildSeconds: 4.255 } }) };
  const report = { ...result.report, files: { ...result.report.files, [draft.baseline]: sha256(over.baseline) } };
  const real = loadSigningKey('dev');
  const asked = [];
  const key = { ...real, sign: async (bytes) => { asked.push(bytes); return real.sign(bytes); } };
  await assert.rejects(attest({ files: over, report, key }), (err) => {
    assert.ok(err instanceof Refusal, String(err));
    assert.equal(err.code, LISTING_REQUEST_TOO_LARGE);
    assert.match(err.detail, new RegExp(`at most ${LISTING_REQUEST_MAX_BYTES}\\b`));
    return true;
  });
  assert.equal(asked.length, 0, 'no signature was made');
});

test('sign on a folder over the bound exits 2, writes no attestation and says why in the report', async () => {
  const draft = draftSpec();
  const { result, baseline } = await buildAround(0, { draft });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-size-'));
  try {
    const out = path.join(dir, 'out');
    writeOutputs(out, result);
    // what a build job could hand over: the report's hash agrees, the bytes are too many
    const grown = pretty({ ...baseline, timings: { ...baseline.timings, buildSeconds: 4.255 } });
    fs.writeFileSync(path.join(out, draft.baseline), grown);
    const reportFile = path.join(out, 'validation-report.json');
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    report.files[draft.baseline] = sha256(grown);
    fs.writeFileSync(reportFile, JSON.stringify(report));
    const config = path.join(dir, 'builder.json');
    fs.writeFileSync(config, JSON.stringify({ registry: { repository: REPOSITORY }, runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' } }));
    const printed = { out: '', err: '' };
    const code = await main(['sign', '--config', config, '--dir', out, '--maker', MAKER], {
      env: {},
      stdout: { write: (s) => { printed.out += s; } },
      stderr: { write: (s) => { printed.err += s; } },
      deps: { checkRepositoryControl: provenAnswer() },
    });
    assert.equal(code, 2, printed.err);
    assert.equal(fs.existsSync(path.join(out, 'attestation.json')), false);
    const after = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(after.status, 'refused');
    assert.equal(after.refusals[0].code, LISTING_REQUEST_TOO_LARGE);
    assert.equal(after.refusals[0].step, 'sign');
    assert.match(after.refusals[0].detail, new RegExp(`at most ${LISTING_REQUEST_MAX_BYTES}\\b`));
    assert.match(printed.out, new RegExp(LISTING_REQUEST_TOO_LARGE));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a build\'s report records what it measured, and sign records the check', async () => {
  const draft = draftSpec();
  const r = await doubledBuild({ draft });
  assert.equal(r.status, 'accepted');
  const { bytes, maxBytes, parts } = r.report.listingRequest;
  assert.equal(maxBytes, LISTING_REQUEST_MAX_BYTES);
  assert.equal(bytes, parts.spec + parts.attestation + parts.baseline + parts.knownIssues);
  assert.equal(parts.knownIssues, 2);
  // what it measured for the attestation is the signed one's size, to the byte
  const files = filesOf(r, draft);
  const { attestation } = await attest({ files, report: r.report, key: loadSigningKey('dev') });
  assert.equal(parts.attestation, requestBytes(attestation));
});

// Acceptance 4.

test('no false refusal: the fixture repository\'s suite, as forge names it, passes', async () => {
  const dir = path.join(FIXTURES, 'vault', 'test');
  const ids = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.t.sol'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const contract = /contract\s+(\w+)/.exec(source)[1];
    for (const m of source.matchAll(/function\s+(test\w*)\s*\(/g)) ids.push(`test/${file} > ${contract} > ${m[1]}()`);
  }
  assert.ok(ids.length >= 2);
  const baseline = {
    version: 1, baseCommit: BASE_COMMIT, framework: 'forge', runs: 3,
    tests: ids.map((id) => ({ id, results: ['pass', 'pass', 'pass'] })), stable: ids, unstable: [],
    timings: { buildSeconds: 4.2, testSeconds: [1.5, 1.4, 1.6] },
  };
  const r = await doubledBuild({ baseline });
  assert.equal(r.status, 'accepted', JSON.stringify(r.report.refusals));
  assert.ok(r.report.listingRequest.parts.baseline < 1024, String(r.report.listingRequest.parts.baseline));
});

test('no false refusal: a big ordinary project passes, 5,000 tests of 120 characters and a full list of known issues', async () => {
  const draft = withKnownIssues();
  const ids = Array.from({ length: 5000 }, (_, i) => `test/core/Vault${i % 40}.t.sol > Vault${i % 40}Test > test_${String(i).padStart(5, '0')}_${'x'.repeat(60)}(uint256)`.padEnd(120, 'x'));
  const baseline = {
    version: 1, baseCommit: draft.baseCommit, framework: 'forge', runs: 3,
    tests: ids.map((id) => ({ id, results: ['pass', 'pass', 'pass'] })), stable: ids, unstable: [],
    timings: { buildSeconds: 44.2, testSeconds: [31.5, 31.4, 31.6] },
  };
  const r = await doubledBuild({ draft, knownIssues: pretty(knownIssueList(256, 'A paragraph on what the behaviour is and why the project accepts it. '.repeat(8))), baseline });
  assert.equal(r.status, 'accepted', JSON.stringify(r.report.refusals));
  assert.ok(r.report.listingRequest.bytes < LISTING_REQUEST_MAX_BYTES, String(r.report.listingRequest.bytes));
});

test('a draft at every cap of its schema is under the bound on its own: the spec alone can\'t be refused', () => {
  const wide = (n, c = '\u0001') => c.repeat(n);
  const globs = (tag) => Array.from({ length: 64 }, (_, i) => `${tag}${String(i).padStart(2, '0')}${wide(509)}`);
  const command = wide(2000);
  const draft = draftSpec();
  const spec = {
    ...draft,
    repo: `https://${wide(504)}`,
    env: { image: `${'r'.repeat(445)}@sha256:${'a'.repeat(64)}`, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 6000000000 },
    commands: { framework: 'forge', setup: command, build: command, test: command, testFiles: command, testIds: command, lint: command },
    paths: { tests: globs('t'), protected: globs('p') },
    limits: { cpus: 2, memoryMb: 4096, buildSeconds: 90, testSeconds: 360, runSeconds: 360, maxPatchBytes: 2000000 },
    stake: { ...draft.stake, scope: { include: globs('i'), exclude: globs('e') } },
  };
  assert.deepEqual(codeReview.validateCodeReviewSpec(spec).issues, []);
  const bytes = requestBytes(spec);
  assert.ok(bytes > 800000 && bytes < LISTING_REQUEST_MAX_BYTES, String(bytes));
});
