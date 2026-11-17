// Acceptance 4, the badge (design §4.1, §4.2; node P4b1): GET /api/records/:hash/badge.svg is the
// live state of the hash's stake. While a listing of the hash takes commits it reads "no finding
// at or above <class> while staked" (with "under-staked" or "invited" when the labels say so), or
// only "scanned" below the badge floor; a valid finding at or above the class replaces the
// statement; each states the listing's control fact (node P8); and the statement ends when the
// stake does (closed, rolled forward, lapsed or depleted). Every string the server writes passes
// the shared wording helper. The badge is drawn on lines of the message's own parts: what it states,
// then the listing's proof; the title and the aria-label hold the message whole.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { FORBIDDEN_WORDS, findForbiddenWords } from '@verdikta/stake-attestation-shared';
import { renderBadge } from '../src/record/badge.js';
import { WordingError, assertWording } from '../src/wording.js';
import { fakeBuilder } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';
import {
  chainContext, commit, increaseTime, judgeAndSettle, latestTimestamp, listing, revealedClaim, siteFor,
} from './helpers/scenario.js';

const PRICE = 2420n * 10n ** 8n;
// every statement of a live stake also states its control fact; none of these listings proves control
const NO = 'staker named by the repository: yes';

/** The badge's message, from its SVG: the text after the label. */
async function badge(api, hash) {
  const res = await api.get(`/api/records/${hash}/badge.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(res.headers.get('cache-control'), /max-age=\d+/);
  const svg = await res.text();
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /role="img"/);
  assert.deepEqual(findForbiddenWords(svg), []);
  const label = /aria-label="([^"]*)"/.exec(svg)[1];
  assert.equal(/<title>([^<]*)<\/title>/.exec(svg)[1], label);
  assert.ok(label.startsWith('verdikta stake: '), label);
  const [drawnLabel, ...lines] = textsOf(svg);
  assert.equal(drawnLabel, 'verdikta stake');
  // what is drawn is the message, a line break where a " · " was: no word added, none left out
  assert.equal(lines.join(' · '), label.slice('verdikta stake: '.length));
  return { svg, lines, message: label.slice('verdikta stake: '.length) };
}

/** The texts an SVG draws, in order. */
const textsOf = (svg) => [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'"));
const sizeOf = (svg) => /^<svg [^>]*\bwidth="(\d+)" height="(\d+)"/.exec(svg).slice(1).map(Number);

describe('GET /api/records/:hash/badge.svg', () => {
  let ctx;
  let feed;
  let site;
  let api;
  const L = {};

  before(async () => {
    ctx = await chainContext();
    feed = await (await ctx.hre.ethers.getContractFactory('MockEthUsdFeed')).deploy(8, PRICE);
    L.staked = await listing(ctx, { stake: { valueAtRiskUsd: undefined } });
    L.under = await listing(ctx, { stake: { valueAtRiskUsd: 1250000 } });
    L.invited = await listing(ctx, { stake: { valueAtRiskUsd: undefined }, allowlist: [ctx.hunters[0].address] });
    L.scanned = await listing(ctx, { stake: { awards: { LOW: '0', MEDIUM: '0.001 ETH', HIGH: '0.005 ETH', CRITICAL: '0.01 ETH' } } });
    L.high = await listing(ctx, { stake: { valueAtRiskUsd: undefined, lowestClassCounted: 'HIGH', awards: { LOW: '0', MEDIUM: '0', HIGH: '0.4 ETH', CRITICAL: '2 ETH' } }, escrowWei: 5n * 10n ** 18n });
    L.found = await listing(ctx, { stake: { valueAtRiskUsd: undefined }, escrowWei: 5n * 10n ** 18n });
    L.closed = await listing(ctx, { stake: { valueAtRiskUsd: undefined } });
    L.rolled = await listing(ctx, { stake: { valueAtRiskUsd: undefined } });
    L.successor = await listing(ctx, { stake: { valueAtRiskUsd: undefined } });
    L.depleted = await listing(ctx, { stake: { valueAtRiskUsd: undefined } });

    // below the counted class: a MEDIUM finding on a listing that counts HIGH and up
    await judgeAndSettle(ctx, await revealedClaim(ctx, ctx.hunters[1], L.high.listingId), 'MEDIUM');
    await judgeAndSettle(ctx, await revealedClaim(ctx, ctx.hunters[1], L.found.listingId), 'HIGH');
    await judgeAndSettle(ctx, await revealedClaim(ctx, ctx.hunters[2], L.depleted.listingId), 'CRITICAL');
    await commit(ctx, ctx.hunters[3], L.staked.listingId); // a pending claim changes nothing
    await (await ctx.sa.connect(ctx.maker).close(L.closed.listingId)).wait();
    await (await ctx.sa.connect(ctx.maker).rollForward(L.rolled.listingId, L.successor.listingId)).wait();

    await (await feed.set(PRICE, await latestTimestamp(ctx))).wait();
    site = siteFor(ctx, { env: { SA_ETH_USD_FEED: await feed.getAddress() } });
    await site.sync();
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  test('a live stake: "no finding at or above <class> while staked"', async () => {
    const b = await badge(api, L.staked.artifactHash);
    assert.equal(b.message, `no finding at or above MEDIUM while staked · ${NO}`);
    // drawn on two lines, what it states over the listing's proof: narrower than the message on one line would be
    assert.deepEqual(b.lines, ['no finding at or above MEDIUM while staked', NO]);
    const [width, height] = sizeOf(b.svg);
    assert.equal(height, 40);
    assert.ok(width < 450, `two lines keep it under 450 px: ${width}`);
    assert.equal((await badge(api, L.successor.artifactHash)).message, `no finding at or above MEDIUM while staked · ${NO}`, 'the badge moved to the successor');
  });

  test('the class is the listing\'s lowest class counted, and a finding below it does not end the statement', async () => {
    assert.equal((await badge(api, L.high.artifactHash)).message, `no finding at or above HIGH while staked · ${NO}`);
  });

  test('under-staked and invited qualify the statement', async () => {
    const under = await badge(api, L.under.artifactHash);
    assert.equal(under.message, `no finding at or above MEDIUM while staked · under-staked · ${NO}`);
    assert.deepEqual(under.lines, ['no finding at or above MEDIUM while staked · under-staked', NO], 'a qualifier stays on the statement\'s line');
    assert.equal((await badge(api, L.invited.artifactHash)).message, `no finding at or above MEDIUM while staked · invited · ${NO}`);
  });

  test('below the badge floor the badge says only "scanned"', async () => {
    const { message, svg } = await badge(api, L.scanned.artifactHash);
    assert.equal(message, `scanned · ${NO}`);
    assert.equal(svg.includes('no finding'), false);
  });

  test('a valid finding at or above the class replaces the statement', async () => {
    const { message, svg } = await badge(api, L.found.artifactHash);
    assert.equal(message, `1 valid finding at or above MEDIUM · ${NO}`);
    assert.equal(svg.includes('no finding'), false);
  });

  test('the statement ends with the stake: closed, rolled forward, depleted, lapsed', async () => {
    for (const [l, message] of [[L.closed, 'stake closed'], [L.rolled, 'stake rolled forward'], [L.depleted, 'stake depleted']]) {
      const b = await badge(api, l.artifactHash);
      assert.equal(b.message, message);
      assert.deepEqual(b.lines, [message], 'an ended stake states no proof: one line');
      assert.equal(b.svg.includes('no finding'), false);
    }
    const fundedUntil = Number((await ctx.sa.getListing(L.staked.listingId)).fundedUntil);
    await increaseTime(ctx, fundedUntil - (await latestTimestamp(ctx)) + 1);
    await (await feed.set(PRICE, await latestTimestamp(ctx))).wait();
    await site.sync();
    assert.equal((await badge(api, L.staked.artifactHash)).message, 'stake lapsed');
  });

  test('a hash with no stake, and a price the feed cannot give for a declared value', async () => {
    assert.equal((await badge(api, `0x${'ab'.repeat(32)}`)).message, 'no stake');
    const late = await listing(ctx, { stake: { valueAtRiskUsd: 1250000 } });
    await increaseTime(ctx, 2 * 3600);
    await site.sync();
    assert.equal((await badge(api, late.artifactHash)).message, `price unavailable · ${NO}`, 'never a guess at the label');
  });

  test('a malformed hash is 400', async () => {
    assert.equal((await api.get('/api/records/0x12/badge.svg')).status, 400);
  });
});

describe('a stale record states no live stake', () => {
  test('when the last full sync, or the indexed block, is older than SA_MAX_STALENESS_SECONDS', async () => {
    const ctx = await chainContext();
    const l = await listing(ctx, { stake: { valueAtRiskUsd: undefined } });
    let clock = Date.now();
    let down = false;
    const provider = new Proxy(ctx.provider, {
      get(target, prop) {
        if (prop === 'getBlockNumber' && down) return async () => { throw Object.assign(new Error('rpc down'), { code: 'NETWORK_ERROR' }); };
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const site = siteFor(ctx, { provider, env: { SA_MAX_STALENESS_SECONDS: '60' }, now: () => clock });
    try {
      assert.equal((await site.badge(l.artifactHash)).message, 'record unavailable', 'nothing indexed yet');
      await site.sync();
      assert.equal((await site.badge(l.artifactHash)).message, `no finding at or above MEDIUM while staked · ${NO}`);
      assert.equal((await site.record(l.artifactHash)).fresh, true);

      // the RPC goes down: syncs fail, and a minute later the cached record is stale
      down = true;
      clock += 61_000;
      await assert.rejects(site.sync());
      assert.equal((await site.badge(l.artifactHash)).message, 'record unavailable');
      const view = await site.record(l.artifactHash);
      assert.equal(view.fresh, false);
      assert.equal(view.staleReason, 'INDEXER_STALE');
      assert.equal((await site.feed()).fresh, false);
      assert.equal(site.status().indexer.fresh, false);

      down = false;
      await site.sync();
      assert.equal((await site.badge(l.artifactHash)).message, `no finding at or above MEDIUM while staked · ${NO}`);

      // an indexed block far behind the wall clock (a node that stopped producing, or a catch-up)
      clock = (site.store.state.cursor.timestamp + 120) * 1000;
      await site.sync();
      assert.equal((await site.record(l.artifactHash)).staleReason, 'CHAIN_BEHIND');
      assert.equal((await site.badge(l.artifactHash)).message, 'record unavailable');
    } finally {
      site.close();
    }
  });
});

describe('wording', () => {
  test('assertWording refuses either banned word, in any case, and passes the badge\'s own strings', () => {
    for (const word of FORBIDDEN_WORDS) {
      assert.throws(() => assertWording(`a ${word.toUpperCase()} record`), WordingError);
      assert.throws(() => assertWording(`un${word}`), WordingError);
    }
    for (const s of ['no finding at or above CRITICAL while staked · under-staked · invited', 'scanned', 'stake closed', 'verdikta stake']) {
      assert.equal(assertWording(s), s);
    }
  });

  test('renderBadge runs it over everything it writes', () => {
    assert.throws(() => renderBadge({ state: 'live', message: `${FORBIDDEN_WORDS[0]} stake` }), WordingError);
    const svg = renderBadge({ state: 'live', message: 'no finding at or above HIGH while staked' });
    assert.deepEqual(findForbiddenWords(svg), []);
  });

  test('renderBadge draws the lines it is given, up to three, and the message on one line otherwise', () => {
    const message = 'no finding at or above HIGH while staked · staker named by the repository: yes · staker controls the deployment: yes';
    const parts = message.split(' · ');
    const three = renderBadge({ state: 'live', message, lines: parts });
    assert.deepEqual(textsOf(three), ['verdikta stake', ...parts], 'a contract: the repository\'s line, then the deployment\'s');
    assert.equal(sizeOf(three)[1], 54);
    assert.ok(three.includes(`aria-label="verdikta stake: ${message}"`), 'the message whole, for a screen reader');
    const one = renderBadge({ state: 'live', message });
    assert.deepEqual(textsOf(one), ['verdikta stake', message]);
    assert.equal(sizeOf(one)[1], 40);
    assert.ok(sizeOf(three)[0] < sizeOf(one)[0]);
    assert.deepEqual(textsOf(renderBadge({ state: 'live', message, lines: ['a', 'b', 'c', 'd'] })), ['verdikta stake', message], 'more lines than it draws: the message');
    // every colour it fills with carries white text
    for (const state of ['live', 'qualified', 'scanned', 'finding', 'ended', 'none', 'unavailable', 'unknown']) {
      assert.match(renderBadge({ state, message: 'stake closed' }), /<rect [^>]*fill="#[0-9a-f]{6}"/);
    }
  });

  test('renderBadge escapes what it writes', () => {
    const svg = renderBadge({ state: 'none', message: '<a & "b">' });
    assert.equal(svg.includes('<a &'), false);
    assert.ok(svg.includes('&lt;a &amp; &quot;b&quot;&gt;'));
  });
});
