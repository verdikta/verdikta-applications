// Acceptance (node P4b2): the listing flow runs the baseline scan (design §8.3) between listing
// and open, and its results are served only to the maker, who proves the address with a wallet
// signature over a one-time challenge; another wallet gets 403. The builder and the scanner are
// stand-ins behind their interfaces (test/helpers/fixtures.js, test/helpers/scan.js).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { createWalletAuth } from '../src/auth/walletAuth.js';
import { fakeBuilder, listingRequest } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';
import { fakeScanner, readScan, settleScan, signedChallenge, wallet } from './helpers/scan.js';

const servers = [];
async function api(opts) {
  const s = await startApi(opts);
  servers.push(s);
  return s;
}
after(() => Promise.all(servers.map((s) => s.close())));

async function list(s, maker, over = {}) {
  const body = { ...listingRequest(), ...(maker ? { maker: maker.address } : {}), ...over };
  const res = await s.submit(body, maker ? { wallet: maker } : {});
  const json = await res.json();
  assert.equal(res.status, 202, JSON.stringify(json));
  return { id: json.id, body, first: json };
}

describe('the baseline scan in the listing flow', () => {
  test('runs on the built spec after the build is accepted and before the archives are pinned; the listing is ready once it has run', async () => {
    const maker = wallet();
    // held a moment, so the listing's id is known before its scan starts
    const builder = fakeBuilder({ delayMs: 200 });
    let pinsAtScan = null;
    let statusAtScan = null;
    let s = null;
    let id = null;
    const scanner = fakeScanner({
      onScan: () => {
        pinsAtScan = s.pinner.pins.length;
        statusAtScan = s.app.listings.get(id).status;
      },
    });
    s = await api({ builder, scanner });
    ({ id } = await list(s, maker));
    const view = await settleScan(s, id);
    assert.equal(view.status, 'ready', JSON.stringify(view.error));
    assert.equal(scanner.calls.length, 1);
    // the staked version's terms: the code_review.json the builder wrote, as the archive holds it
    const built = builder.calls[0];
    assert.equal(scanner.calls[0].spec.repo, built.draft.repo);
    assert.equal(scanner.calls[0].spec.baseCommit, built.draft.baseCommit);
    assert.match(scanner.calls[0].spec.env.image, /@sha256:/, 'the built spec, not the draft');
    assert.equal(pinsAtScan, 0, 'nothing was pinned before the scan');
    assert.equal(statusAtScan, 'scanning');
    assert.equal(s.pinner.pins.length, 2);
    assert.equal(view.maker, maker.address);
    assert.deepEqual(Object.keys(view.scan).sort(), ['finishedAt', 'status']);
    assert.equal(view.scan.status, 'done');
  });

  test('the maker reads the findings with a wallet signature; another wallet gets 403', async () => {
    const maker = wallet();
    const other = wallet();
    const scanner = fakeScanner();
    const s = await api({ builder: fakeBuilder(), scanner });
    const { id } = await list(s, maker);
    await settleScan(s, id);

    const denied = await readScan(s, id, other);
    assert.equal(denied.res.status, 403, JSON.stringify(denied.json));
    assert.equal(denied.json.error, 'NOT_THE_MAKER');
    assert.equal(JSON.stringify(denied.json).includes(scanner.mark), false, 'no finding in the refusal');
    assert.equal(denied.json.scan, undefined);

    const ok = await readScan(s, id, maker);
    assert.equal(ok.res.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.res.headers.get('cache-control'), 'no-store');
    assert.equal(ok.json.id, id);
    assert.equal(ok.json.maker, maker.address);
    assert.equal(ok.json.status, 'done');
    assert.equal(ok.json.scan.kind, 'verdikta-baseline-scan');
    assert.equal(ok.json.scan.audience, 'maker');
    assert.equal(ok.json.scan.findings.length, 3);
    assert.ok(JSON.stringify(ok.json.scan).includes(scanner.mark), 'the maker gets the findings as the builder wrote them');
    assert.equal(ok.json.error, null);
  });

  test('the challenge names the listing, the maker and the action; the maker\'s address in any case is the maker', async () => {
    const maker = wallet();
    const s = await api({ builder: fakeBuilder(), scanner: fakeScanner() });
    const { id } = await list(s, maker, { maker: maker.address.toLowerCase() });
    await settleScan(s, id);
    const { res, challenge } = await signedChallenge(s, id, maker);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(challenge.action, 'read-scan');
    assert.equal(challenge.resource, `listing:${id}`);
    assert.equal(challenge.address, maker.address);
    assert.match(challenge.message, new RegExp(`^Resource: listing:${id}$`, 'm'));
    assert.match(challenge.message, new RegExp(`^Address: ${maker.address}$`, 'm'));
    assert.equal((await readScan(s, id, maker)).res.status, 200);
  });

  test('a signature answers once: the same nonce and signature again is 401 (replay)', async () => {
    const maker = wallet();
    const s = await api({ builder: fakeBuilder(), scanner: fakeScanner() });
    const { id } = await list(s, maker);
    await settleScan(s, id);
    const first = await readScan(s, id, maker);
    assert.equal(first.res.status, 200);
    const replay = await s.post(`/api/listings/${id}/scan`, first.body);
    assert.equal(replay.status, 401);
    const json = await replay.json();
    assert.equal(json.error, 'CHALLENGE_UNKNOWN');
    assert.equal(json.scan, undefined);
  });

  test('a challenge past its expiry is 401, even signed by the maker', async () => {
    const maker = wallet();
    let t = Date.parse('2026-11-02T10:00:00Z');
    const auth = createWalletAuth({ ttlMs: 60000, now: () => t });
    const s = await api({ builder: fakeBuilder(), scanner: fakeScanner(), auth });
    const { id } = await list(s, maker);
    await settleScan(s, id);
    const c = await signedChallenge(s, id, maker);
    t += 60001;
    const res = await s.post(`/api/listings/${id}/scan`, c.body);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'CHALLENGE_EXPIRED');
  });

  test('a challenge for one listing does not open another, even of the same maker', async () => {
    const maker = wallet();
    const s = await api({ builder: fakeBuilder(), scanner: fakeScanner() });
    const a = await list(s, maker);
    const b = await list(s, maker);
    await settleScan(s, a.id);
    await settleScan(s, b.id);
    const c = await signedChallenge(s, a.id, maker);
    const res = await s.post(`/api/listings/${b.id}/scan`, c.body);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'CHALLENGE_MISMATCH');
  });

  test('a body without a nonce and a signature is 400; a forged signature 401', async () => {
    const maker = wallet();
    const s = await api({ builder: fakeBuilder(), scanner: fakeScanner() });
    const { id } = await list(s, maker);
    await settleScan(s, id);
    for (const body of [{}, { nonce: 'x' }, { nonce: 'a'.repeat(32), signature: 'no' }]) {
      const res = await s.post(`/api/listings/${id}/scan`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error, 'AUTH_REQUEST_INVALID');
    }
    const c = await signedChallenge(s, id, maker);
    const res = await s.post(`/api/listings/${id}/scan`, { nonce: c.body.nonce, signature: `0x${'00'.repeat(65)}` });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'SIGNATURE_INVALID');
  });

  test('a malformed signature uses the challenge up: the maker\'s real signature after it is 401 (R1-F2)', async () => {
    const maker = wallet();
    const s = await api({ builder: fakeBuilder(), scanner: fakeScanner() });
    const { id } = await list(s, maker);
    await settleScan(s, id);
    const c = await signedChallenge(s, id, maker);
    const bad = await s.post(`/api/listings/${id}/scan`, { nonce: c.body.nonce, signature: '0x00' });
    assert.equal(bad.status, 400);
    const then = await s.post(`/api/listings/${id}/scan`, c.body);
    assert.equal(then.status, 401);
    const json = await then.json();
    assert.equal(json.error, 'CHALLENGE_UNKNOWN');
    assert.equal(json.scan, undefined);
  });

  test('every answer of both routes is no-store, a body that is not JSON or is over 4 KB included (R1-F1)', async () => {
    const maker = wallet();
    const s = await api({ builder: fakeBuilder(), scanner: fakeScanner() });
    const { id } = await list(s, maker);
    await settleScan(s, id);
    const notJson = await s.post(`/api/listings/${id}/scan`, '{ "nonce": ');
    assert.equal(notJson.status, 400);
    assert.equal((await notJson.json()).error, 'BODY_NOT_JSON');
    assert.equal(notJson.headers.get('cache-control'), 'no-store');
    const big = await s.post(`/api/listings/${id}/scan`, { nonce: 'a'.repeat(32), signature: `0x${'11'.repeat(65)}`, pad: 'x'.repeat(5000) });
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { error: 'BODY_TOO_LARGE', limit: '4kb' });
    assert.equal(big.headers.get('cache-control'), 'no-store');
    const answers = [
      await s.post(`/api/listings/${id}/scan/challenge`, {}),
      await s.post(`/api/listings/${'0'.repeat(32)}/scan/challenge`, {}),
      await s.post(`/api/listings/${'0'.repeat(32)}/scan`, {}),
      await s.post(`/api/listings/${id}/scan`, {}),
      (await readScan(s, id, wallet())).res,
      (await readScan(s, id, maker)).res,
    ];
    assert.deepEqual(answers.map((r) => r.status), [200, 404, 404, 400, 403, 200]);
    for (const r of answers) assert.equal(r.headers.get('cache-control'), 'no-store', String(r.status));
  });

  test('before the scan has finished, the maker is told so without spending a signature', async () => {
    const maker = wallet();
    const scanner = fakeScanner({ delayMs: Infinity });
    const s = await api({ builder: fakeBuilder(), scanner });
    const { id } = await list(s, maker);
    for (let i = 0; i < 200 && scanner.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    const c = await signedChallenge(s, id, maker);
    const early = await s.post(`/api/listings/${id}/scan`, c.body);
    assert.equal(early.status, 409);
    const json = await early.json();
    assert.equal(json.error, 'SCAN_NOT_READY');
    assert.deepEqual(json.scan, { status: 'running' });
    scanner.release();
    await settleScan(s, id);
    const later = await s.post(`/api/listings/${id}/scan`, c.body);
    assert.equal(later.status, 200, 'the same signature is still good: nothing was served');
  });

  test('a scan that fails does not hold the listing back: the maker reads why', async () => {
    const maker = wallet();
    const scanner = fakeScanner({ outcome: 'error' });
    const s = await api({ builder: fakeBuilder(), scanner });
    const { id } = await list(s, maker);
    const view = await settleScan(s, id);
    assert.equal(view.status, 'ready');
    assert.equal(view.scan.status, 'error');
    assert.equal(view.error, null);
    const ok = await readScan(s, id, maker);
    assert.equal(ok.res.status, 200);
    assert.equal(ok.json.status, 'error');
    assert.equal(ok.json.scan.status, 'error');
    assert.equal(ok.json.scan.error.code, 'SCAN_TOOL_FAILED');
  });

  test('a scan step that produced no document is an error the maker reads, with the server\'s code', async () => {
    const maker = wallet();
    const s = await api({ builder: fakeBuilder(), scanner: fakeScanner({ outcome: 'step-error' }) });
    const { id } = await list(s, maker);
    const view = await settleScan(s, id);
    assert.equal(view.status, 'ready');
    assert.equal(view.scan.status, 'error');
    const ok = await readScan(s, id, maker);
    assert.equal(ok.res.status, 200);
    assert.equal(ok.json.scan, null);
    assert.equal(ok.json.error.code, 'SCAN_STEP_FAILED');
  });

  test('a scanner that throws is an error, not a crash, and the listing is still issued', async () => {
    const maker = wallet();
    const s = await api({ builder: fakeBuilder(), scanner: fakeScanner({ outcome: 'throws' }) });
    const { id } = await list(s, maker);
    const view = await settleScan(s, id);
    assert.equal(view.status, 'ready');
    assert.equal(view.scan.status, 'error');
    const ok = await readScan(s, id, maker);
    assert.equal(ok.json.error.code, 'SCAN_FAILED');
  });

  test('a scan the server had to stop keeps its build slot, as a build does', async () => {
    const { testConfig } = await import('./helpers/fixtures.js');
    const maker = wallet();
    const builder = fakeBuilder();
    const s = await api({ builder, scanner: fakeScanner({ outcome: 'step-error', holdSlot: true }), config: testConfig({ SA_MAX_CONCURRENT_BUILDS: '1' }) });
    const first = await list(s, maker);
    assert.equal((await settleScan(s, first.id)).status, 'ready');
    const second = await list(s, maker);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await (await s.get(`/api/listings/${second.id}`)).json()).status, 'queued');
    assert.equal(builder.calls.length, 1);
  });

  test('a refused build is not scanned', async () => {
    const maker = wallet();
    const scanner = fakeScanner();
    const s = await api({ builder: fakeBuilder({ outcome: 'refused-source' }), scanner });
    const { id } = await list(s, maker);
    const view = await settleScan(s, id);
    assert.equal(view.status, 'refused');
    assert.deepEqual(view.scan, { status: 'not_run' });
    assert.equal(scanner.calls.length, 0);
    const c = await signedChallenge(s, id, maker);
    const res = await s.post(`/api/listings/${id}/scan`, c.body);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'SCAN_NOT_READY');
  });

  test('a listing that is not issued is not scanned either', async () => {
    const maker = wallet();
    const scanner = fakeScanner();
    const tamper = ({ files }) => { files.baseline = Buffer.concat([files.baseline, Buffer.from(' ')]); };
    const s = await api({ builder: fakeBuilder({ tamper }), scanner });
    const { id } = await list(s, maker);
    const view = await settleScan(s, id);
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'ARCHIVE_INVALID');
    assert.deepEqual(view.scan, { status: 'not_run' });
    assert.equal(scanner.calls.length, 0);
  });

  test('an unknown listing is 404 for both routes', async () => {
    const s = await api({ builder: fakeBuilder(), scanner: fakeScanner() });
    for (const p of [`/api/listings/${'0'.repeat(32)}/scan/challenge`, `/api/listings/${'0'.repeat(32)}/scan`, '/api/listings/nope/scan']) {
      const res = await s.post(p, { nonce: 'a'.repeat(32), signature: `0x${'11'.repeat(65)}` });
      assert.equal(res.status, 404, p);
      assert.equal((await res.json()).error, 'LISTING_NOT_FOUND');
    }
  });
});

describe('the maker address in the listing request', () => {
  const cases = [
    ['not an address', '0x1234'],
    ['the zero address', '0x0000000000000000000000000000000000000000'],
    ['a number', 42],
    ['an ENS name', 'maker.eth'],
  ];
  for (const [name, maker] of cases) {
    test(`${name} is refused before any build`, async () => {
      const builder = fakeBuilder();
      const s = await api({ builder, scanner: fakeScanner() });
      const res = await s.submit({ ...listingRequest(), maker });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.ok(json.issues.some((i) => i.code === 'MAKER_INVALID' && i.path === '/maker'), JSON.stringify(json.issues));
      assert.equal(builder.calls.length, 0);
    });
  }
});
