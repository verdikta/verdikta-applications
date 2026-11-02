// Acceptance 4, the badge (design §4.1, §4.2; node P4b1): GET /api/records/:hash/badge.svg is the
// live state of the hash's stake. While a listing of the hash takes commits it reads "no finding
// at or above <class> while staked" (with "under-staked" or "invited" when the labels say so), or
// only "scanned" below the badge floor; a valid finding at or above the class replaces the
// statement; and the statement ends when the stake does (closed, rolled forward, lapsed or
// depleted). Every string the server writes passes the shared banned-words helper.
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
  return { svg, message: label.slice('verdikta stake: '.length) };
}

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
    assert.equal((await badge(api, L.staked.artifactHash)).message, 'no finding at or above MEDIUM while staked');
    assert.equal((await badge(api, L.successor.artifactHash)).message, 'no finding at or above MEDIUM while staked', 'the badge moved to the successor');
  });

  test('the class is the listing\'s lowest class counted, and a finding below it does not end the statement', async () => {
    assert.equal((await badge(api, L.high.artifactHash)).message, 'no finding at or above HIGH while staked');
  });

  test('under-staked and invited qualify the statement', async () => {
    assert.equal((await badge(api, L.under.artifactHash)).message, 'no finding at or above MEDIUM while staked · under-staked');
    assert.equal((await badge(api, L.invited.artifactHash)).message, 'no finding at or above MEDIUM while staked · invited');
  });

  test('below the badge floor the badge says only "scanned"', async () => {
    const { message, svg } = await badge(api, L.scanned.artifactHash);
    assert.equal(message, 'scanned');
    assert.equal(svg.includes('no finding'), false);
  });

  test('a valid finding at or above the class replaces the statement', async () => {
    const { message, svg } = await badge(api, L.found.artifactHash);
    assert.equal(message, '1 valid finding at or above MEDIUM');
    assert.equal(svg.includes('no finding'), false);
  });

  test('the statement ends with the stake: closed, rolled forward, depleted, lapsed', async () => {
    for (const [l, message] of [[L.closed, 'stake closed'], [L.rolled, 'stake rolled forward'], [L.depleted, 'stake depleted']]) {
      const b = await badge(api, l.artifactHash);
      assert.equal(b.message, message);
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
    assert.equal((await badge(api, late.artifactHash)).message, 'price unavailable', 'never a guess at the label');
  });

  test('a malformed hash is 400', async () => {
    assert.equal((await api.get('/api/records/0x12/badge.svg')).status, 400);
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

  test('renderBadge escapes what it writes', () => {
    const svg = renderBadge({ state: 'none', message: '<a & "b">' });
    assert.equal(svg.includes('<a &'), false);
    assert.ok(svg.includes('&lt;a &amp; &quot;b&quot;&gt;'));
  });
});
