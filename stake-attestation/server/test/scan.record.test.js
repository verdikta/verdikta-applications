// The baseline scan's findings stay out of the record mirror and the feed (design §8.3; node
// P4b2, over node P4b1's site). A listing goes through the listing flow with the scan's stand-in
// (every finding marked with a canary made per run), its list() arguments are sent and funded on
// the in-process chain from the maker's wallet, and the site indexes it from the same mock store
// the flow pinned to. Every public answer of the chain side (the feed, its events, the record, the
// badge, the status) and every line the site logs is searched for the canary.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { fakeBuilder, listingRequest } from './helpers/fixtures.js';
import { quietLogger, startApi } from './helpers/http.js';
import { chainContext, siteFor } from './helpers/scenario.js';
import { fakeScanner, readScan, settleScan } from './helpers/scan.js';

describe('the scan never reaches the record mirror or the feed', () => {
  let ctx;
  let site;
  let api;
  let scanner;
  let view;
  const apiLog = quietLogger();

  before(async () => {
    ctx = await chainContext();
    scanner = fakeScanner();
    site = siteFor(ctx);
    api = await startApi({ builder: fakeBuilder(), scanner, pinner: ctx.pinner, site, logger: apiLog });
    const res = await api.submit({ ...listingRequest(), maker: ctx.maker.address }, { wallet: ctx.maker });
    assert.equal(res.status, 202);
    view = await settleScan(api, (await res.json()).id);
    assert.equal(view.status, 'ready', JSON.stringify(view.error));
    assert.equal(view.scan.status, 'done');
    // the maker lists and funds with the server's arguments, as the client does
    const { params, listingCid, disputeCid, knownIssueIds } = view.list;
    const rc = await (await ctx.sa.connect(ctx.maker).list(params, listingCid, disputeCid, knownIssueIds)).wait();
    const listed = rc.logs.map((l) => ctx.sa.interface.parseLog(l)).find((e) => e?.name === 'Listed');
    const { listingId } = listed.args;
    ctx.proofs.set(`${params.artifact.repo}@${params.artifact.baseCommit}`, ctx.maker.address);
    const fee = await ctx.sa.feeDue(listingId);
    await (await ctx.sa.connect(ctx.maker).fund(listingId, fee, { value: fee + BigInt(params.awards[3]) })).wait();
    await site.sync();
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  test('the maker can still read the findings (the canary is there to find)', async () => {
    const r = await readScan(api, view.id, ctx.maker);
    assert.equal(r.res.status, 200);
    assert.ok(JSON.stringify(r.json.scan).includes(scanner.mark));
  });

  test('not in the feed or its events', async () => {
    const feed = await (await api.get('/api/feed')).json();
    assert.equal(feed.listings.length, 1, 'the listing is in the feed');
    assert.equal(feed.listings[0].listingCid, view.list.listingCid);
    const events = await (await api.get('/api/feed/events')).json();
    assert.ok(events.events.length > 0);
    for (const body of [feed, events]) {
      const text = JSON.stringify(body);
      assert.equal(text.includes(scanner.mark), false);
      assert.equal(text.includes('scan-findings'), false);
      assert.equal(text.includes('verdikta-baseline-scan'), false);
    }
  });

  test('not in the record mirror, its badge or the status', async () => {
    const res = await api.get(`/api/records/${view.artifactHash}`);
    assert.equal(res.status, 200);
    const record = await res.json();
    const badge = await (await api.get(`/api/records/${view.artifactHash}/badge.svg`)).text();
    const status = await (await api.get('/api/status')).json();
    for (const text of [JSON.stringify(record), badge, JSON.stringify(status)]) {
      assert.equal(text.includes(scanner.mark), false);
      assert.equal(text.includes('scan-findings'), false);
      assert.equal(text.includes('verdikta-baseline-scan'), false);
    }
  });

  test('not in anything the site or the API logged', () => {
    for (const line of [...site.logger.lines, ...apiLog.lines]) assert.equal(line.includes(scanner.mark), false, line);
  });
});
