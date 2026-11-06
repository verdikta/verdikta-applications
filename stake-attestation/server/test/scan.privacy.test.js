// The baseline scan's findings are the maker's alone (design §8.3; node P4b2): they reach the
// maker through the signed read and nowhere else. Every finding and error text of the stand-in
// scanner carries a canary made per run; these tests look for it everywhere else the scan could
// leak: the public listing view, the listing and dispute archives as pinned, known_issues.json,
// the arguments of list(), every server log line and every refusal and error message. The
// archives are stored ZIPs (no compression), so a byte search over them finds any member's text.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { fakeBuilder, listingRequest, serialize } from './helpers/fixtures.js';
import { quietLogger, startApi } from './helpers/http.js';
import { fakeScanner, readScan, settleScan, signedChallenge, wallet } from './helpers/scan.js';

const servers = [];
async function api(opts) {
  const s = await startApi(opts);
  servers.push(s);
  return s;
}
after(() => Promise.all(servers.map((s) => s.close())));

const has = (value, mark) => (Buffer.isBuffer(value) ? value.includes(Buffer.from(mark)) : JSON.stringify(value).includes(mark));

/** A listing through the flow with `scanner`, every public answer collected on the way. */
async function scanned({ outcome = 'ok', pinner } = {}) {
  const maker = wallet();
  const logger = quietLogger();
  const scanner = fakeScanner({ outcome, delayMs: 50 });
  const s = await api({ builder: fakeBuilder(), scanner, logger, ...(pinner ? { pinner } : {}) });
  const body = { ...listingRequest(), maker: maker.address };
  const res = await s.submit(body, { wallet: maker });
  const answers = [await res.json()];
  const { id } = answers[0];
  // the public view at every step the poll sees: queued, building, scanning, pinning, ready
  const until = Date.now() + 20000;
  for (;;) {
    const view = await (await s.get(`/api/listings/${id}`)).json();
    answers.push(view);
    if (['ready', 'refused', 'error'].includes(view.status) && ['done', 'error', 'not_run'].includes(view.scan.status)) break;
    if (Date.now() > until) throw new Error(`listing ${id} did not settle`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return { s, id, maker, scanner, logger, body, answers, view: answers.at(-1) };
}

describe('the findings never leave the maker-only read', () => {
  test('the maker\'s read is where they are (the canary is reachable at all)', async () => {
    const { s, id, maker, scanner } = await scanned();
    const r = await readScan(s, id, maker);
    assert.equal(r.res.status, 200);
    assert.ok(has(r.json.scan, scanner.mark));
  });

  test('not in the public listing view, at any status: only the scan\'s status and when it finished', async () => {
    const { answers, scanner, view } = await scanned();
    assert.ok(answers.some((a) => a.status === 'scanning'), 'the poll saw the scan running');
    for (const a of answers) {
      assert.equal(has(a, scanner.mark), false, `the ${a.status} view`);
      assert.equal(has(a, 'findings'), false);
      assert.equal(has(a, 'verdikta-baseline-scan'), false);
      if (a.scan) assert.ok(Object.keys(a.scan).every((k) => ['status', 'finishedAt', 'reason'].includes(k)), JSON.stringify(a.scan));
    }
    assert.equal(view.status, 'ready');
  });

  test('not in the listing or dispute archive as pinned, nor among their members', async () => {
    const { s, scanner, view } = await scanned();
    assert.equal(s.pinner.pins.length, 2);
    for (const p of s.pinner.pins) {
      assert.equal(has(p.bytes, scanner.mark), false, p.name);
      assert.equal(has(p.bytes, 'scan-findings.json'), false, p.name);
      assert.equal(has(p.bytes, 'verdikta-baseline-scan'), false, p.name);
    }
    for (const role of ['listing', 'dispute']) {
      assert.deepEqual(Object.keys(view.archives[role].members).sort(), ['attestation.json', 'baseline.json', 'code_review.json', 'known_issues.json', 'manifest.json', 'primary_query.json']);
    }
  });

  test('not in known_issues.json: the archive holds the maker\'s own list, byte for byte', async () => {
    const { s, body, scanner, view } = await scanned();
    const pinned = s.pinner.get(view.archives.listing.cid);
    const ki = serialize(body.knownIssues);
    assert.ok(pinned.includes(ki), 'the maker\'s known issues, as sent');
    assert.equal(view.archives.listing.members['known_issues.json'], (await import('node:crypto')).createHash('sha256').update(ki).digest('hex'));
    assert.equal(has(view.list.knownIssueIds, scanner.mark), false);
  });

  test('not in the arguments of list()', async () => {
    const { scanner, view } = await scanned();
    assert.equal(has(view.list, scanner.mark), false);
  });

  for (const outcome of ['ok', 'error', 'step-error', 'throws']) {
    test(`not in any server log line (scan ${outcome})`, async () => {
      const { s, id, maker, scanner, logger } = await scanned({ outcome });
      await readScan(s, id, maker);
      await readScan(s, id, wallet());
      assert.ok(logger.lines.length > 0);
      for (const line of logger.lines) assert.equal(line.includes(scanner.mark), false, line);
      assert.ok(logger.lines.some((l) => l.includes(`listing ${id}`) && /scan/.test(l)), 'the log says the scan ran, in its own words');
    });
  }

  test('not in a refusal or an error: 403, 401, 400, 409 and 404 answers', async () => {
    const { s, id, maker, scanner } = await scanned({ outcome: 'error' });
    const bodies = [];
    const other = await readScan(s, id, wallet());
    bodies.push(other.json);
    const first = await readScan(s, id, maker);
    bodies.push((await (await s.post(`/api/listings/${id}/scan`, first.body)).json()));
    bodies.push((await (await s.post(`/api/listings/${id}/scan`, {})).json()));
    bodies.push((await (await s.post(`/api/listings/${'0'.repeat(32)}/scan`, first.body)).json()));
    const c = await signedChallenge(s, id, maker);
    bodies.push(c.challenge);
    for (const b of bodies) assert.equal(has(b, scanner.mark), false, JSON.stringify(b));
  });

  test('not in the listing\'s error when a step after the scan fails', async () => {
    const pinner = { backend: 'mock', pins: [], pin: async () => { throw new Error('pinning service unreachable'); } };
    const { view, scanner, logger } = await scanned({ pinner });
    assert.equal(view.status, 'error');
    assert.equal(view.error.code, 'PIN_FAILED');
    assert.equal(view.scan.status, 'done', 'the maker can still read the scan');
    assert.equal(has(view, scanner.mark), false);
    for (const line of logger.lines) assert.equal(line.includes(scanner.mark), false, line);
  });

  test('a draft cannot give a listing file the scan\'s file name', async () => {
    for (const edit of [
      (b) => { b.spec.baseline = 'scan-findings.json'; },
      (b) => { b.spec.attestation = 'scan-findings.json'; },
      (b) => { b.spec.stake.knownIssues = 'scan-findings.json'; },
    ]) {
      const builder = fakeBuilder();
      const s = await api({ builder, scanner: fakeScanner() });
      const body = listingRequest();
      edit(body);
      const res = await s.submit(body);
      assert.equal(res.status, 400);
      assert.ok((await res.json()).issues.some((i) => i.code === 'FILE_NAME_RESERVED'));
      assert.equal(builder.calls.length, 0);
    }
  });
});
