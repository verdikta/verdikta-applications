// Acceptance 2, the listing feed (design §15; node P4b1): GET /api/feed lists every listing a
// hunter can commit to now, with its hash, image, scope, award table, bond, windows, days open,
// claims so far and escrow remaining. Only opened listings appear, and only while they take
// commits: an unfunded, depleted, rolled, closed or lapsed listing leaves it. Image and scope come
// from the listing archive (by its CID), checked against what the chain stores; everything else
// is the contract's state at the indexed block. GET /api/feed/events is the contract's events
// (§13.4) in order, with unpublished claims reduced to their ids.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';

import http from 'node:http';

import { codeReview } from '../src/common.js';
import { buildListingArchives } from '../src/listing/archives.js';
import { rawCid } from '../src/pinning/index.js';
import { createGatewayFetcher, readListingArchive } from '../src/site/archives.js';
import { zipStored } from '../src/zip.js';
import { zipDeflated } from './helpers/zipDeflate.js';
import { IMAGE, draftSpec, fakeBuilder } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';
import {
  bcidOf, chainContext, commit, DAY, HOUR, increaseTime, judgeAndSettle, latestTimestamp, listing, revealedClaim,
  siteFor, verdict,
} from './helpers/scenario.js';

const CLASSES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

describe('GET /api/feed', () => {
  let ctx;
  let site;
  let api;
  let open;
  let renewed;
  let contract;
  let successor;
  const gone = {};
  let invalidClaim;
  let pendingClaim;
  let openedAt;

  before(async () => {
    ctx = await chainContext();
    open = await listing(ctx, { allowlist: [] });
    openedAt = await latestTimestamp(ctx);
    invalidClaim = await revealedClaim(ctx, ctx.hunters[0], open.listingId);
    await judgeAndSettle(ctx, invalidClaim, 'INVALID');
    pendingClaim = await commit(ctx, ctx.hunters[1], open.listingId);

    renewed = await listing(ctx, { maker: ctx.other });
    await (await ctx.sa.connect(ctx.other).renew(renewed.listingId, { value: await ctx.sa.listingFeeWei() })).wait();
    contract = await listing(ctx, { spec: { artifact: { kind: 'contract', address: '0x5f2a00000000000000000000000000000000c0de', chainId: 8453 } } });

    gone.unfunded = await listing(ctx, { fund: false });
    gone.closed = await listing(ctx);
    await (await ctx.sa.connect(ctx.maker).close(gone.closed.listingId)).wait();
    gone.rolled = await listing(ctx);
    successor = await listing(ctx);
    await (await ctx.sa.connect(ctx.maker).rollForward(gone.rolled.listingId, successor.listingId)).wait();
    gone.depleted = await listing(ctx);
    const big = await revealedClaim(ctx, ctx.hunters[2], gone.depleted.listingId);
    await judgeAndSettle(ctx, big, 'CRITICAL');

    // three days after `open` opened (judgeAndSettle already waited out a dispute window)
    const now = await latestTimestamp(ctx);
    if (now < openedAt + 3 * DAY + HOUR) await increaseTime(ctx, openedAt + 3 * DAY + HOUR - now);

    site = siteFor(ctx);
    await site.sync();
    await site.archivesIdle();
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  test('lists exactly the listings that take commits now', async () => {
    const res = await api.get('/api/feed');
    assert.equal(res.status, 200);
    const body = await res.json();
    const ids = body.listings.map((l) => l.listingId).sort();
    assert.deepEqual(ids, [open, renewed, contract, successor].map((l) => String(l.listingId)).sort());
    for (const [why, l] of Object.entries(gone)) assert.equal(ids.includes(String(l.listingId)), false, `${why} is not in the feed`);
    for (const id of ids) assert.equal(await ctx.sa.acceptsCommits(id), true);
    assert.equal(body.block.number, site.store.state.cursor.number);
  });

  test('each entry: hash, image, scope, award table, bond, windows, days open, claims so far, escrow remaining', async () => {
    const body = await (await api.get('/api/feed')).json();
    const entry = body.listings.find((l) => l.listingId === String(open.listingId));
    const onchain = await ctx.sa.getListing(open.listingId, { blockTag: body.block.number });

    assert.equal(entry.artifactHash, open.artifactHash);
    assert.deepEqual(entry.artifact, { kind: 'Repo', repo: open.spec.repo, baseCommit: open.spec.baseCommit, chainId: '0', address: '0x0000000000000000000000000000000000000000' });
    assert.equal(entry.maker, ctx.maker.address);
    assert.equal(entry.image, IMAGE);
    assert.equal(entry.image, open.spec.env.image);
    assert.deepEqual(entry.scope, open.spec.stake.scope);
    assert.deepEqual(entry.archive, { ok: true });

    const wei = codeReview.awardsToWei(open.spec.stake.awards);
    assert.deepEqual(entry.awards, Object.fromEntries(CLASSES.map((c) => [c, wei[c].toString()])));
    assert.deepEqual(entry.awards, Object.fromEntries(CLASSES.map((c, i) => [c, onchain.awards[i].toString()])));
    assert.equal(entry.lowestClassCounted, open.spec.stake.lowestClassCounted);
    assert.equal(entry.bondWei, onchain.bondWei.toString());
    assert.equal(entry.bondWei, open.spec.stake.bondWei);
    assert.deepEqual(entry.windows, {
      fixWindow: Number(onchain.fixWindow),
      disputeWindow: Number(onchain.disputeWindow),
      disclosureGrace: Number(onchain.disclosureGrace),
      revealWindow: Number(onchain.revealWindow),
      discloseWindow: Number(await ctx.sa.DISCLOSE_WINDOW()),
    });
    assert.equal(entry.windows.disputeWindow, 72 * HOUR);
    assert.equal(entry.openedAt, Number(onchain.openedAt));
    assert.equal(entry.fundedUntil, Number(onchain.fundedUntil));
    assert.equal(entry.daysOpen, 3);
    assert.equal(entry.claimsSoFar, 2, 'one settled, one pending');
    assert.equal(entry.claimsSoFar, Number(onchain.claimsCommitted));
    assert.equal(entry.escrowRemainingWei, onchain.escrowWei.toString());
    assert.equal(entry.escrowRemainingWei, wei.CRITICAL.toString(), 'an INVALID claim pays nothing from the escrow');
    assert.equal(entry.owedWei, '0');
    assert.equal(entry.valueAtRiskUsd, String(open.spec.stake.valueAtRiskUsd));
    assert.equal(entry.invited, false);
    assert.equal(entry.listingCid, open.listingCid);
    assert.equal(entry.disputeCid, open.disputeCid);
    assert.equal(entry.disclosureKey, onchain.disclosureKey);
  });

  test('a contract listing carries its deployment', async () => {
    const body = await (await api.get('/api/feed')).json();
    const entry = body.listings.find((l) => l.listingId === String(contract.listingId));
    assert.deepEqual(entry.artifact, { kind: 'Contract', repo: contract.spec.repo, baseCommit: contract.spec.baseCommit, chainId: '8453', address: getAddress('0x5f2a00000000000000000000000000000000c0de') });
  });

  test('GET /api/feed/events: the contract\'s events in order; unpublished claims are their ids only', async () => {
    const res = await api.get('/api/feed/events?limit=1000');
    assert.equal(res.status, 200);
    const body = await res.json();
    const order = body.events.map((e) => [e.blockNumber, e.logIndex]);
    assert.deepEqual(order, [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    assert.ok(body.events.some((e) => e.name === 'Opened' && e.args.listingId === String(open.listingId)));
    assert.equal(body.events.some((e) => ['ListingFeeSet', 'FeeRecipientSet', 'OwnershipTransferred'].includes(e.name)), false);

    const about = (id) => body.events.filter((e) => e.claimId === String(id));
    for (const id of [invalidClaim, pendingClaim]) {
      assert.ok(about(id).length > 0);
      for (const e of about(id)) {
        assert.equal(e.redacted, true, `${e.name} of claim ${id}`);
        assert.equal(e.listingId, String(open.listingId));
        assert.ok(Object.keys(e.args).every((k) => k === 'claimId' || k === 'listingId'), `${e.name} keeps its ids only`);
      }
    }
    assert.equal(JSON.stringify(body).includes(bcidOf(invalidClaim)), false, 'an INVALID claim\'s archive is not published');
  });

  test('GET /api/feed/events pages with `after`', async () => {
    const all = (await (await api.get('/api/feed/events?limit=1000')).json()).events;
    const first = await (await api.get('/api/feed/events?limit=3')).json();
    assert.deepEqual(first.events, all.slice(0, 3));
    const second = await (await api.get(`/api/feed/events?limit=3&after=${encodeURIComponent(first.next)}`)).json();
    assert.deepEqual(second.events, all.slice(3, 6));
    assert.equal((await api.get('/api/feed/events?after=nonsense')).status, 400);
    assert.equal((await api.get('/api/feed/events?limit=0')).status, 400);
  });

  test('a listing whose fee period lapses leaves the feed; one renewed stays', async () => {
    const fundedUntil = Number((await ctx.sa.getListing(open.listingId)).fundedUntil);
    const now = await latestTimestamp(ctx);
    await increaseTime(ctx, fundedUntil - now + 1);
    await site.sync();
    const body = await (await api.get('/api/feed')).json();
    const ids = body.listings.map((l) => l.listingId);
    assert.equal(ids.includes(String(open.listingId)), false, 'lapsed');
    assert.equal(await ctx.sa.isLapsed(open.listingId), true);
    assert.ok(ids.includes(String(renewed.listingId)), 'renewed for another 30 days');
    const record = await (await api.get(`/api/records/${open.artifactHash}`)).json();
    assert.equal(record.record.listings[0].lapsed, true, 'the record keeps it, labelled lapsed');
  });
});

describe('the listing archive behind a feed entry', () => {
  test('an archive that cannot be fetched leaves the entry in the feed without image or scope, and is retried', async () => {
    const ctx = await chainContext();
    const l = await listing(ctx);
    let fail = true;
    const site = siteFor(ctx, {
      env: { SA_ARCHIVE_RETRY_MS: '0' },
      fetchArchive: async (cid) => {
        if (fail) throw new Error('gateway timeout');
        return ctx.pinner.get(cid);
      },
    });
    try {
      await site.sync();
      await site.archivesIdle();
      let entry = (await site.feed()).listings.find((e) => e.listingId === String(l.listingId));
      assert.equal(entry.image, null);
      assert.equal(entry.scope, null);
      assert.deepEqual(entry.archive, { ok: false, error: 'ARCHIVE_UNAVAILABLE' });
      fail = false;
      await site.sync();
      await site.archivesIdle();
      entry = (await site.feed()).listings.find((e) => e.listingId === String(l.listingId));
      assert.equal(entry.image, IMAGE);
      assert.deepEqual(entry.archive, { ok: true });
    } finally {
      site.close();
    }
  });

  test('an archive that is not the listing the chain stores is not trusted for image or scope', async () => {
    const ctx = await chainContext();
    const real = await listing(ctx);
    // the same archives listed for another commit: the chain's artifact is not the archive's
    const params = structuredClone(real.params);
    params.artifact.baseCommit = 'f'.repeat(40);
    const rc = await (await ctx.sa.connect(ctx.other).list(params, real.listingCid, real.disputeCid, [])).wait();
    const listingId = rc.logs.map((x) => { try { return ctx.sa.interface.parseLog(x); } catch { return null; } }).find((e) => e?.name === 'Listed').args.listingId;
    const fee = await ctx.sa.feeDue(listingId);
    await (await ctx.sa.connect(ctx.other).fund(listingId, fee, { value: fee + BigInt(params.awards[3]) })).wait();
    const site = siteFor(ctx);
    try {
      await site.sync();
      await site.archivesIdle();
      const entry = (await site.feed()).listings.find((e) => e.listingId === String(listingId));
      assert.equal(entry.image, null);
      assert.equal(entry.scope, null);
      assert.deepEqual(entry.archive, { ok: false, error: 'ARCHIVE_MISMATCH' });
    } finally {
      site.close();
    }
  });
});

describe('archive reads run beside the indexer', () => {
  test('a gateway that never answers holds up neither the cursor nor the keeper', async () => {
    const ctx = await chainContext();
    const l = await listing(ctx);
    let release;
    const stalled = new Promise((r) => { release = r; });
    const fetches = [];
    const site = siteFor(ctx, {
      fetchArchive: async (cid) => {
        fetches.push(cid);
        await stalled;
        return ctx.pinner.get(cid);
      },
    });
    try {
      await site.sync();
      assert.deepEqual(fetches, [l.listingCid], 'the archive read started');
      const claimId = await revealedClaim(ctx, ctx.hunters[0], l.listingId);
      await verdict(ctx, claimId, 'INVALID');
      const before = site.store.state.cursor.number;
      await site.sync();
      assert.ok(site.store.state.cursor.number > before, 'the cursor moved on while the archive read hung');
      assert.equal(fetches.length, 1, 'one archive run at a time');
      assert.deepEqual((await site.keep()).sent.map((x) => [x.action, x.claimId]), [['finalize', String(claimId)]], 'the keeper sees the new claim');
      assert.equal((await site.feed()).listings.find((e) => e.listingId === String(l.listingId)).archive.error, 'ARCHIVE_UNAVAILABLE');
      release();
      await site.archivesIdle();
      assert.equal((await site.feed()).listings.find((e) => e.listingId === String(l.listingId)).image, IMAGE);
    } finally {
      release();
      site.close();
    }
  });

  test('a failed fetch is retried after the backoff counted from when it failed', async () => {
    const ctx = await chainContext();
    await listing(ctx);
    let clock = 1_000_000;
    const site = siteFor(ctx, {
      env: { SA_ARCHIVE_RETRY_MS: '1000' },
      now: () => clock,
      fetchArchive: async () => {
        clock += 5000; // the fetch takes five seconds to fail
        throw new Error('gateway timeout');
      },
    });
    try {
      await site.sync();
      await site.archivesIdle();
      const [known] = Object.values(site.store.state.archives);
      assert.equal(known.retryAt, 1_000_000 + 5000 + 1000);
    } finally {
      site.close();
    }
  });
});

describe('reading a listing archive without extracting it', () => {
  let members;
  before(async () => {
    const draft = draftSpec();
    delete draft.stake.knownIssues;
    const built = await fakeBuilder().build({ draft, knownIssues: null });
    members = buildListingArchives(built.files).listing.members;
  });
  const spec = () => JSON.parse(members.find((m) => m.name === 'code_review.json').bytes);

  test('a stored archive, a deflated one, and one whose files sit in a single folder read the same', () => {
    const want = { ok: true, image: IMAGE, scope: spec().stake.scope };
    for (const bytes of [zipStored(members), zipDeflated(members), zipDeflated(members.map((m) => ({ ...m, name: `listing/${m.name}` })))]) {
      const r = readListingArchive(bytes, 'QmNotARawCidSoNoHashCheckXXXXXXXXXXXXXXXXXXXXXX');
      assert.deepEqual({ ok: r.ok, image: r.image, scope: r.scope }, want);
      assert.equal(r.baseCommit, spec().baseCommit);
    }
  });

  test('a member that inflates past the cap is refused before it is held in memory, whatever size it declares', () => {
    const bomb = Buffer.alloc(64 * 1024 * 1024, 0x20); // 64 MiB of spaces deflates to about 64 KiB
    const withBomb = (declaredSize) => zipDeflated(members.map((m) => (m.name === 'code_review.json' ? { name: m.name, bytes: bomb, declaredSize } : m)));
    assert.deepEqual(readListingArchive(withBomb(), 'QmNotARawCidSoNoHashCheckXXXXXXXXXXXXXXXXXXXXXX'), { ok: false, error: 'ARCHIVE_TOO_LARGE' });
    assert.deepEqual(readListingArchive(withBomb(1000), 'QmNotARawCidSoNoHashCheckXXXXXXXXXXXXXXXXXXXXXX'), { ok: false, error: 'ARCHIVE_TOO_LARGE' }, 'a declared size that lies');
  });

  test('a raw CID must be the archive\'s, and what is not a ZIP is invalid', () => {
    const bytes = zipStored(members);
    assert.equal(readListingArchive(bytes, rawCid(bytes)).ok, true);
    assert.deepEqual(readListingArchive(bytes, rawCid(Buffer.from('other'))), { ok: false, error: 'ARCHIVE_NOT_CID' });
    assert.deepEqual(readListingArchive(Buffer.from('not a zip at all, just text'), 'QmNotARawCidSoNoHashCheckXXXXXXXXXXXXXXXXXXXXXX'), { ok: false, error: 'ARCHIVE_INVALID' });
    assert.deepEqual(readListingArchive(zipStored(members.filter((m) => m.name !== 'code_review.json')), 'QmNotARawCidSoNoHashCheckXXXXXXXXXXXXXXXXXXXXXX'), { ok: false, error: 'ARCHIVE_INVALID' });
  });
});

describe('the gateway fetcher', () => {
  /** fetch that refuses every host but loopback: a test never reaches a real gateway. */
  const loopbackFetch = (url, init) => {
    if (new URL(url).hostname !== '127.0.0.1') return Promise.reject(new Error(`test fetch refused ${new URL(url).origin}`));
    return fetch(url, init);
  };

  test('reads <gateway>/ipfs/<cid> from the operator\'s gateway first, checks a raw CID, and stops at the byte cap', async () => {
    const small = Buffer.from('a listing archive');
    const big = Buffer.alloc(4096, 1);
    const routes = new Map([[rawCid(small), small], [rawCid(big), big], [rawCid(Buffer.from('promised')), Buffer.from('something else')]]);
    const server = http.createServer((req, res) => {
      const body = routes.get(req.url.replace('/ipfs/', ''));
      if (!body) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const gateway = `http://127.0.0.1:${server.address().port}`;
    try {
      const get = createGatewayFetcher({ gateways: [gateway], timeoutMs: 2000, maxBytes: 1024 }, undefined, { fetch: loopbackFetch });
      assert.deepEqual(await get(rawCid(small)), small);
      await assert.rejects(get(rawCid(big)), /larger than 1024 bytes/);
      await assert.rejects(get(rawCid(Buffer.from('promised'))), /refused|not bafkrei/, 'the wrong bytes are not taken; the next gateways are tried');
      await assert.rejects(get(rawCid(Buffer.from('nowhere'))), /refused/);
      await assert.rejects(get('../etc/passwd'), /not a CID/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('without a chain configured', () => {
  test('the feed, record and badge routes answer 503', async () => {
    const api = await startApi({ builder: fakeBuilder() });
    try {
      for (const path of ['/api/feed', '/api/feed/events', `/api/records/0x${'ab'.repeat(32)}`, `/api/records/0x${'ab'.repeat(32)}/badge.svg`, '/api/status']) {
        const res = await api.get(path);
        assert.equal(res.status, 503, path);
        assert.equal((await res.json()).error, 'CHAIN_NOT_CONFIGURED');
      }
    } finally {
      await api.close();
    }
  });
});
