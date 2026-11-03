// Node P11: the listing flow and the size rule. The builder refuses a listing too large for the
// code-runner's request (builder/test/unit/requestSize.test.js); here the refusal reaches the maker with
// the size and the bound, is counted by reason on /api/status like the other refusals, and a builder that
// let one through is not taken on its word. A listing at the bound still goes through, and the readers of
// the site take its archives.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSignedListing, wordingProblems } from '@verdikta/stake-attestation-shared';
import {
  LISTING_REQUEST_MAX_BYTES,
  LISTING_REQUEST_TOO_LARGE,
  listingParts,
  listingRequestSize,
} from '@verdikta/stake-attestation-shared/listing-request-size';

import { baselineOfBytes } from '../../shared/test/helpers/baselineOfBytes.js';
import { createCliBuilder } from '../src/builder/cli.js';
import { codeReview } from '../src/common.js';
import { BASE_COMMIT, MAKER, draftSpec, fakeBuilder, knownIssues, listingRequest, serialize } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';

const servers = [];
async function api(opts) {
  const s = await startApi(opts);
  servers.push(s);
  return s;
}
after(() => Promise.all(servers.map((s) => s.close())));

const FAKE_CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'fake-builder-cli.js');
const kiBytes = () => serialize(knownIssues());

/** What the stand-in builder's listing takes beside its baseline, in the request. */
async function besideTheBaseline() {
  const r = await fakeBuilder().build({ draft: draftSpec(), knownIssues: kiBytes(), maker: MAKER });
  const { parts } = listingRequestSize(listingParts(r.files));
  return parts.spec + parts.attestation + parts.knownIssues;
}
const baselineFor = async (extra, o) => baselineOfBytes(LISTING_REQUEST_MAX_BYTES + extra - await besideTheBaseline(), BASE_COMMIT, o);

const refused = async (s) => {
  const res = await s.submit(listingRequest());
  assert.equal(res.status, 202, await res.clone().text());
  return s.settle((await res.json()).id);
};

/** /api/status's counts: with no deployment it answers them in its 503. */
const counted = async (s) => (await (await s.get('/api/status')).json()).listings.refused;

function assertNoProjectIn(counts) {
  const text = JSON.stringify(counts);
  assert.equal(/0x[0-9a-fA-F]{40}/.test(text), false, text);
  assert.equal(text.includes('github'), false, text);
  assert.equal(text.includes('acme'), false, text);
}

test('the builder\'s refusal reaches the maker with the size and the bound, nothing is pinned, and it is counted by reason', async () => {
  const s = await api({ builder: fakeBuilder({ outcome: 'refused-too-large' }) });
  const view = await refused(s);
  assert.equal(view.status, 'refused');
  const [refusal] = view.validationReport.refusals;
  assert.equal(refusal.code, LISTING_REQUEST_TOO_LARGE);
  assert.match(refusal.detail, new RegExp(`${LISTING_REQUEST_MAX_BYTES + 1} bytes`));
  assert.match(refusal.detail, new RegExp(`at most ${LISTING_REQUEST_MAX_BYTES}\\b`));
  assert.deepEqual(wordingProblems(refusal.detail), []);
  assert.equal(view.archives, null);
  assert.equal(view.list, null);
  assert.equal(s.pinner.pins.length, 0);
  const counts = await counted(s);
  assert.equal(counts.total, 1);
  assert.deepEqual(counts.byReason, { [LISTING_REQUEST_TOO_LARGE]: 1 });
  assertNoProjectIn(counts);
});

test('a builder that accepted a listing over the bound is not taken on its word: the same refusal, by the server', async () => {
  const baseline = await baselineFor(1);
  const s = await api({ builder: fakeBuilder({ baseline }) });
  const view = await refused(s);
  assert.equal(view.status, 'refused', JSON.stringify(view.error));
  assert.equal(view.refusal.code, LISTING_REQUEST_TOO_LARGE);
  assert.match(view.refusal.detail, new RegExp(`${LISTING_REQUEST_MAX_BYTES + 1} bytes`));
  assert.match(view.refusal.detail, new RegExp(`at most ${LISTING_REQUEST_MAX_BYTES}\\b`));
  assert.deepEqual(wordingProblems(view.refusal.detail), []);
  assert.equal(s.pinner.pins.length, 0, 'nothing was pinned');
  assert.equal(view.archives, null);
  assert.equal(view.scan.status, 'not_run', 'the scan never read it');
  const counts = await counted(s);
  assert.deepEqual(counts.byReason, { [LISTING_REQUEST_TOO_LARGE]: 1 });
  assertNoProjectIn(counts);
});

for (const [name, idLength] of [['long test ids', 1000], ['short test ids, the most a pretty-printed file adds', 40]]) {
  test(`a listing at the bound (${name}) is issued, and the site reads its archives as signed`, async () => {
    const baseline = await baselineFor(0, { idLength });
    const builder = fakeBuilder({ baseline });
    const s = await api({ builder });
    const res = await s.submit(listingRequest());
    const view = await s.settle((await res.json()).id, 60000);
    assert.equal(view.status, 'ready', JSON.stringify(view.error ?? view.refusal));
    const archive = s.pinner.get(view.archives.listing.cid);
    assert.ok(archive.length <= s.app.locals?.archivesMaxBytes ?? 8 * 1024 * 1024, String(archive.length));
    assert.ok(archive.length <= 8 * 1024 * 1024, `the site reads at most 8 MiB of a listing archive: ${archive.length}`);
    const read = readSignedListing(archive, { codeReview, devKeys: builder.devTrust().keys });
    assert.equal(read.signed, true, read.reason);
    const counts = await counted(s);
    assert.equal(counts.total, 0);
  });
}

test('the builder\'s command line: a sign step that refuses (exit 2) comes back as a refusal, with its report', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-size-'));
  try {
    const config = path.join(dir, 'builder.json');
    const record = path.join(dir, 'record.json');
    fs.writeFileSync(config, JSON.stringify({ mode: 'sign-too-large', record }));
    const builder = createCliBuilder({ bin: FAKE_CLI, config, workDir: dir, buildEnv: [], signEnv: [], timeoutMs: 60000 }, { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    const r = await builder.build({ draft: draftSpec(), knownIssues: kiBytes(), maker: MAKER });
    assert.equal(r.status, 'refused', JSON.stringify(r.error));
    assert.equal(r.files, null);
    assert.equal(r.report.refusals[0].code, LISTING_REQUEST_TOO_LARGE);
    assert.equal(r.report.refusals[0].step, 'sign');
    assert.match(r.report.refusals[0].detail, new RegExp(`at most ${LISTING_REQUEST_MAX_BYTES}\\b`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
