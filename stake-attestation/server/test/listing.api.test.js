// Acceptance 1 (node P4a): the listing API. The maker submits the spec (with its stake block and
// disclosure key), the known issues and an allowlist; the server runs the environment builder
// (build, verified-source check, validation on the code-runner, then signing; node P3a, stubbed
// here behind the builder interface) and returns the validation report. No archive is built or
// pinned unless the build was accepted, and never when the verified-source check failed.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { codeReview } from '../src/common.js';
import { contractDraft, draftSpec, fakeBuilder, knownIssues, listingRequest, disclosureKeyPair } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';

const servers = [];
async function api(opts) {
  const s = await startApi(opts);
  servers.push(s);
  return s;
}
after(() => Promise.all(servers.map((s) => s.close())));

async function submit(s, body) {
  const res = await s.post('/api/listings', body);
  const json = await res.json();
  return { res, json };
}

describe('POST /api/listings, then GET /api/listings/:id', () => {
  test('an accepted build returns the validation report, both CIDs and the list() arguments', async () => {
    const builder = fakeBuilder();
    const s = await api({ builder });
    const body = listingRequest({ spec: contractDraft() });
    const { res, json } = await submit(s, body);
    assert.equal(res.status, 202);
    assert.match(json.id, /^[0-9a-f]{32}$/);
    assert.equal(res.headers.get('location'), `/api/listings/${json.id}`);
    assert.ok(['queued', 'building'].includes(json.status));

    const view = await s.settle(json.id);
    assert.equal(view.status, 'ready', JSON.stringify(view.error));
    // the builder got the maker's draft and the exact known-issues bytes the archive will hold
    assert.equal(builder.calls.length, 1);
    assert.deepEqual(builder.calls[0].draft, body.spec);
    assert.deepEqual(JSON.parse(builder.calls[0].knownIssues.toString('utf8')), body.knownIssues);
    // the validation report is the builder's, with the verified-source comparison
    assert.equal(view.validationReport.kind, 'verdikta-listing-validation');
    assert.equal(view.validationReport.status, 'accepted');
    assert.equal(view.validationReport.verifiedSource.status, 'match');
    assert.deepEqual(view.validationReport.steps.map((x) => x.name), ['spec', 'fetch', 'build', 'size', 'push', 'registry', 'verifiedSource', 'listingCheck', 'finalSpec']);
    // two archives pinned, their CIDs returned with everything list() takes
    assert.equal(s.pinner.pins.length, 2);
    assert.deepEqual(s.pinner.pins.map((p) => p.cid), [view.archives.listing.cid, view.archives.dispute.cid]);
    assert.equal(view.list.listingCid, view.archives.listing.cid);
    assert.equal(view.list.disputeCid, view.archives.dispute.cid);
    assert.deepEqual(view.list.knownIssueIds, body.knownIssues.map((k) => `0x${k.id.slice('sha256:'.length)}`).sort());
    const recipientBytes = Buffer.from(codeReview.parseDisclosureKey(body.spec.stake.disclosureKey)).toString('hex');
    assert.equal(view.list.params.disclosureKey, `0x${recipientBytes}`);
    assert.deepEqual(view.disclosureKey, { recipient: body.spec.stake.disclosureKey, bytes32: `0x${recipientBytes}` });
    assert.deepEqual(Object.keys(view.list.params.oracle).sort(), ['alpha', 'disputeMaxOracleFee', 'estimatedBaseCost', 'maxFeeBasedScaling', 'maxOracleFee', 'requestedClass']);
    assert.equal(view.list.params.oracle.requestedClass, String(codeReview.CODE_CLASSES['code-standard'].classId));
    assert.match(view.artifactHash, /^0x[0-9a-f]{64}$/);
    assert.equal(view.trust, 'dev');
  });

  test('no archive is issued when the verified-source check fails: the report says why', async () => {
    const s = await api({ builder: fakeBuilder({ outcome: 'refused-source' }) });
    const { json } = await submit(s, listingRequest({ spec: contractDraft() }));
    const view = await s.settle(json.id);
    assert.equal(view.status, 'refused');
    assert.equal(view.validationReport.status, 'refused');
    assert.equal(view.validationReport.verifiedSource.status, 'mismatch');
    assert.deepEqual(view.validationReport.refusals.map((r) => [r.step, r.code]), [['verifiedSource', 'BYTECODE_MISMATCH']]);
    assert.equal(view.archives, null);
    assert.equal(view.list, null);
    assert.equal(s.pinner.pins.length, 0, 'nothing is pinned');
  });

  test('no archive is issued when a build reports accepted but its source check did not match', async () => {
    const tamper = ({ report }) => {
      report.verifiedSource = { status: 'mismatch', issues: [{ code: 'BYTECODE_MISMATCH', detail: 'x' }], warnings: [] };
    };
    const s = await api({ builder: fakeBuilder({ tamper }) });
    const { json } = await submit(s, listingRequest({ spec: contractDraft() }));
    const view = await s.settle(json.id);
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'BUILD_REPORT_INCONSISTENT');
    assert.equal(view.archives, null);
    assert.equal(s.pinner.pins.length, 0);
  });

  test('no archive is issued when a contract build skipped its source check', async () => {
    const tamper = ({ report }) => {
      report.verifiedSource = null;
      report.steps.find((x) => x.name === 'verifiedSource').status = 'skipped';
    };
    const s = await api({ builder: fakeBuilder({ tamper }) });
    const { json } = await submit(s, listingRequest({ spec: contractDraft() }));
    const view = await s.settle(json.id);
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'BUILD_REPORT_INCONSISTENT');
    assert.equal(s.pinner.pins.length, 0);
  });

  test('a refusal elsewhere and a builder error also issue nothing, with the report', async () => {
    for (const [outcome, status] of [['refused', 'refused'], ['error', 'error']]) {
      const s = await api({ builder: fakeBuilder({ outcome }) });
      const { json } = await submit(s, listingRequest());
      const view = await s.settle(json.id);
      assert.equal(view.status, status, outcome);
      assert.equal(view.validationReport.status, outcome);
      assert.equal(view.archives, null);
      assert.equal(s.pinner.pins.length, 0);
    }
  });

  test('a build whose code_review.json changed the maker\'s terms is not issued', async () => {
    const other = disclosureKeyPair().recipient;
    const s = await api({ builder: fakeBuilder({ alterSpec: (spec) => { spec.stake.disclosureKey = other; } }) });
    const { json } = await submit(s, listingRequest());
    const view = await s.settle(json.id);
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'BUILD_CHANGED_SPEC');
    assert.equal(s.pinner.pins.length, 0);
  });

  test('a build whose attestation does not verify over its files is not issued', async () => {
    const tamper = ({ files }) => {
      files.baseline = Buffer.concat([files.baseline, Buffer.from(' ')]);
    };
    const s = await api({ builder: fakeBuilder({ tamper }) });
    const { json } = await submit(s, listingRequest());
    const view = await s.settle(json.id);
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'ARCHIVE_INVALID');
    assert.equal(s.pinner.pins.length, 0);
  });

  test('a dev-signed build is not issued when the server requires production trust', async () => {
    const { testConfig } = await import('./helpers/fixtures.js');
    const s = await api({ builder: fakeBuilder(), config: testConfig({ SA_ATTESTATION_TRUST: 'production' }) });
    const { json } = await submit(s, listingRequest());
    const view = await s.settle(json.id);
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'ARCHIVE_INVALID');
    assert.match(view.error.detail, /ATTESTATION/);
    assert.equal(s.pinner.pins.length, 0);
  });

  test('a pinning failure is an error with no CIDs', async () => {
    const pinner = { backend: 'mock', pins: [], pin: async () => { throw new Error('pinning service unreachable'); } };
    const s = await api({ builder: fakeBuilder(), pinner });
    const { json } = await submit(s, listingRequest());
    const view = await s.settle(json.id);
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'PIN_FAILED');
    assert.equal(view.archives, null);
    assert.equal(view.list, null);
  });

  test('an unknown listing is 404', async () => {
    const s = await api({ builder: fakeBuilder() });
    const res = await s.get(`/api/listings/${'0'.repeat(32)}`);
    assert.equal(res.status, 404);
    assert.equal((await s.get('/api/listings/not-an-id')).status, 404);
  });
});

describe('requests refused before any build (400)', () => {
  const cases = [
    ['an unreadable disclosure key (common parseDisclosureKey)', (b) => { b.spec.stake.disclosureKey = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'; }, 'DISCLOSURE_KEY_INVALID'],
    ['a disclosure key that is not an age recipient', (b) => { b.spec.stake.disclosureKey = '0x' + 'ab'.repeat(32); }, 'DISCLOSURE_KEY_INVALID'],
    ['no stake block', (b) => { delete b.spec.stake; }, 'DISCLOSURE_KEY_INVALID'],
    ['a spec common refuses', (b) => { b.spec.kind = 'feature'; }, 'SPEC_INVALID'],
    ['an allowlist entry that is not an address', (b) => { b.allowlist = ['0x1234']; }, 'ALLOWLIST_INVALID'],
    ['the zero address on the allowlist', (b) => { b.allowlist = ['0x0000000000000000000000000000000000000000']; }, 'ALLOWLIST_INVALID'],
    ['an address twice on the allowlist', (b) => { b.allowlist = ['0x5f2a00000000000000000000000000000000c0de', '0x5F2A00000000000000000000000000000000C0DE']; }, 'ALLOWLIST_INVALID'],
    ['more than 64 invited hunters', (b) => { b.allowlist = Array.from({ length: 65 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`); }, 'ALLOWLIST_INVALID'],
    ['known issues the spec does not name', (b) => { delete b.spec.stake.knownIssues; }, 'KNOWN_ISSUES_NOT_NAMED'],
    ['a spec naming known issues that are not given', (b) => { delete b.knownIssues; }, 'KNOWN_ISSUES_MISSING'],
    ['a known issue whose id does not hash its body', (b) => { b.knownIssues[0].title = 'edited'; }, 'KNOWN_ISSUES_INVALID'],
    ['a baseline named like the manifest', (b) => { b.spec.baseline = 'manifest.json'; }, 'FILE_NAME_RESERVED'],
    ['an attestation named like the primary query', (b) => { b.spec.attestation = 'primary_query.json'; }, 'FILE_NAME_RESERVED'],
    ['a fix window list() refuses (over 90 days)', (b) => { b.spec.stake.fixWindowDays = 120; }, 'LIST_BOUNDS'],
    ['a reveal window list() refuses (under 72 hours)', (b) => { b.spec.stake.revealWindowDays = 2; }, 'LIST_BOUNDS'],
    ['a dispute window list() refuses (under 24 hours)', (b) => { b.spec.stake.disputeWindowHours = 12; }, 'LIST_BOUNDS'],
    ['a disclosure grace longer than the fix window', (b) => { b.spec.stake.fixWindowDays = 1; b.spec.stake.disclosureGraceHours = 48; }, 'LIST_BOUNDS'],
    ['a value at risk that is not whole dollars', (b) => { b.spec.stake.valueAtRiskUsd = 10.5; }, 'LIST_BOUNDS'],
    ['an unknown request field', (b) => { b.owner = '0x5f2a00000000000000000000000000000000c0de'; }, 'REQUEST_INVALID'],
    // R1-F2: amounts list() could not encode
    ['an award beyond uint256', (b) => { b.spec.stake.awards.CRITICAL = (1n << 256n).toString(); }, 'LIST_BOUNDS'],
    ['a bond beyond uint256', (b) => { b.spec.stake.bondWei = (1n << 256n).toString(); }, 'LIST_BOUNDS'],
    // R1-F3: StakeAttestation._isValidRepo takes printable ASCII only, at most 512 bytes
    ['a repository URL list() refuses (not ASCII)', (b) => { b.spec.repo = 'https://github.com/acme/va\u00fclt'; }, 'LIST_BOUNDS'],
    ['a repository URL over 512 bytes once encoded', (b) => { b.spec.repo = `https://example.com/${'\u00e9'.repeat(250)}`; }, 'LIST_BOUNDS'],
    // R1-F4: the listing's own files need distinct names, and none the builder writes
    ['an attestation and a baseline with one name', (b) => { b.spec.attestation = 'baseline.json'; }, 'FILE_NAME_COLLISION'],
    ['known issues named like the builder\'s report', (b) => { b.spec.stake.knownIssues = 'validation-report.json'; }, 'FILE_NAME_RESERVED'],
  ];
  for (const [name, edit, code] of cases) {
    test(name, async () => {
      const builder = fakeBuilder();
      const s = await api({ builder });
      const body = listingRequest();
      edit(body);
      const { res, json } = await submit(s, body);
      assert.equal(res.status, 400, JSON.stringify(json));
      assert.equal(json.error, 'LISTING_REQUEST_INVALID');
      assert.ok(json.issues.some((i) => i.code === code), `${code} in ${JSON.stringify(json.issues)}`);
      assert.equal(builder.calls.length, 0, 'no build was started');
    });
  }

  test('a body that is not JSON is 400, a body over the limit 413', async () => {
    const s = await api({ builder: fakeBuilder() });
    const bad = await s.post('/api/listings', '{ not json');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'BODY_NOT_JSON');
    const big = await s.post('/api/listings', { spec: draftSpec(), knownIssues: knownIssues(), pad: 'x'.repeat(2_000_000) });
    assert.equal(big.status, 413);
  });

  test('a build the builder could not stop keeps its slot: nothing more runs beyond the limit (R1-F1)', async () => {
    const { testConfig } = await import('./helpers/fixtures.js');
    const calls = [];
    const builder = {
      calls,
      async build(input) {
        calls.push(input);
        return { status: 'error', report: null, files: null, devTrust: null, error: { code: 'BUILDER_TIMEOUT', detail: 'stopped' }, holdSlot: true };
      },
    };
    const s = await api({ builder, config: testConfig({ SA_MAX_CONCURRENT_BUILDS: '1', SA_MAX_QUEUED_BUILDS: '2' }) });
    const first = await submit(s, listingRequest());
    assert.equal((await s.settle(first.json.id)).error.code, 'BUILDER_TIMEOUT');
    const second = await submit(s, listingRequest());
    assert.equal(second.res.status, 202);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await (await s.get(`/api/listings/${second.json.id}`)).json()).status, 'queued');
    assert.equal(calls.length, 1, 'the second build never started');
  });

  test('a full build queue is 429 and starts nothing more', async () => {
    const { testConfig } = await import('./helpers/fixtures.js');
    const builder = fakeBuilder({ delayMs: Infinity });
    const s = await api({ builder, config: testConfig({ SA_MAX_CONCURRENT_BUILDS: '1', SA_MAX_QUEUED_BUILDS: '1' }) });
    const first = await submit(s, listingRequest());
    const second = await submit(s, listingRequest());
    assert.equal(first.res.status, 202);
    assert.equal(second.res.status, 202);
    const third = await submit(s, listingRequest());
    assert.equal(third.res.status, 429);
    assert.equal(third.json.error, 'BUILD_QUEUE_FULL');
    builder.release();
    assert.equal((await s.settle(first.json.id)).status, 'ready');
    assert.equal((await s.settle(second.json.id)).status, 'ready');
    assert.equal(builder.calls.length, 2);
  });
});
