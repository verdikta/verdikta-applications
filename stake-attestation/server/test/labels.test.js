// Acceptance 4, the labels (design §4.1, §4.2, §13.4; node P4b1): scanned (top award below the
// badge floor), staked, under-staked (a declared value at risk with the stake, priced in USD by
// Chainlink's ETH/USD feed on Base, below a program-set share of it) and invited (an allowlist)
// are computed off-chain from the record. The badge floor and the under-staked share are config,
// with placeholder defaults the owner replaces at G1; the feed's address is config. The tests
// read a mock aggregator on the in-process chain: no live feed, no live RPC.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, loadConfig } from '../src/config.js';
import { LABEL_PLACEHOLDERS, listingLabels } from '../src/record/labels.js';
import { readEthUsd } from '../src/record/price.js';
import { chainContext, increaseTime, latestTimestamp, listing, siteFor } from './helpers/scenario.js';

const ETH = 10n ** 18n;
const PRICE = 2420n * 10n ** 8n; // $2,420, at the feed's 8 decimals
const ctxLabels = (over = {}) => ({
  chainTime: 1_800_000_000,
  price: { answer: PRICE.toString(), decimals: 8 },
  badgeFloorWei: LABEL_PLACEHOLDERS.badgeFloorWei,
  underStakedRatioBps: LABEL_PLACEHOLDERS.underStakedRatioBps,
  ...over,
});
/** A ListingRecord as the record mirror writes it (decimal strings, enum names). */
const record = (over = {}) => ({
  listingId: '1',
  state: 'Open',
  lapsed: false,
  invited: false,
  awards: ['0', (ETH / 10n).toString(), (4n * ETH / 10n).toString(), (2n * ETH).toString()],
  lowestClassCounted: 'MEDIUM',
  escrowWei: (2n * ETH).toString(),
  valueAtRiskUsd: '0',
  ...over,
});

describe('listingLabels', () => {
  test('staked: the top award at or above the floor, no value at risk declared', () => {
    const l = listingLabels(record(), ctxLabels());
    assert.equal(l.stake, 'staked');
    assert.equal(l.invited, false);
    assert.equal(l.live, true);
    assert.equal(l.topAwardWei, (2n * ETH).toString());
    assert.equal(listingLabels(record(), ctxLabels({ price: null })).stake, 'staked', 'no price is needed without a declared value');
  });

  test('scanned: the top award below the badge floor, whatever else is true', () => {
    const floor = 5n * ETH;
    assert.equal(listingLabels(record(), ctxLabels({ badgeFloorWei: floor.toString() })).stake, 'scanned');
    assert.equal(listingLabels(record({ valueAtRiskUsd: '10000000' }), ctxLabels({ badgeFloorWei: floor.toString(), price: null })).stake, 'scanned');
    assert.equal(listingLabels(record(), ctxLabels({ badgeFloorWei: (2n * ETH).toString() })).stake, 'staked', 'exactly the floor is staked');
    assert.equal(listingLabels(record(), ctxLabels({ badgeFloorWei: (2n * ETH + 1n).toString() })).stake, 'scanned');
  });

  test('under-staked: the top award, in USD at the feed\'s price, below the share of the declared value', () => {
    // 2 ETH at $2,420 = $4,840; 10% of $1,250,000 = $125,000
    const l = listingLabels(record({ valueAtRiskUsd: '1250000' }), ctxLabels());
    assert.equal(l.stake, 'under-staked');
    assert.equal(l.stakeUsd, '4840');
    // $4,840 is exactly 10% of $48,400: not below the share
    assert.equal(listingLabels(record({ valueAtRiskUsd: '48400' }), ctxLabels()).stake, 'staked');
    assert.equal(listingLabels(record({ valueAtRiskUsd: '48401' }), ctxLabels()).stake, 'under-staked');
    assert.equal(listingLabels(record({ valueAtRiskUsd: '48401' }), ctxLabels({ underStakedRatioBps: 999 })).stake, 'staked', 'the share is config');
  });

  test('a declared value with no usable price gives no stake label rather than a guess', () => {
    const l = listingLabels(record({ valueAtRiskUsd: '1250000' }), ctxLabels({ price: null }));
    assert.equal(l.stake, null);
    assert.equal(l.error, 'ETH_USD_UNAVAILABLE');
  });

  test('invited: the listing has an allowlist; lapsed and live follow the record', () => {
    assert.equal(listingLabels(record({ invited: true }), ctxLabels()).invited, true);
    const lapsed = listingLabels(record({ lapsed: true }), ctxLabels());
    assert.equal(lapsed.lapsed, true);
    assert.equal(lapsed.live, false, 'a lapsed listing takes no commits');
    for (const state of ['Depleted', 'Rolled', 'Closed']) assert.equal(listingLabels(record({ state }), ctxLabels()).live, false, state);
  });
});

describe('the thresholds are config, with marked placeholders', () => {
  test('defaults are the placeholders, and the config says so', () => {
    const c = loadConfig({});
    assert.equal(c.labels.badgeFloorWei, LABEL_PLACEHOLDERS.badgeFloorWei);
    assert.equal(c.labels.underStakedRatioBps, LABEL_PLACEHOLDERS.underStakedRatioBps);
    assert.deepEqual(c.labels.placeholders, ['SA_BADGE_FLOOR_WEI', 'SA_UNDER_STAKED_RATIO_BPS']);
    assert.equal(c.labels.ethUsdFeed, null);
  });

  test('set values replace them; bad ones are refused', () => {
    const c = loadConfig({ SA_BADGE_FLOOR_WEI: '50000000000000000', SA_UNDER_STAKED_RATIO_BPS: '500', SA_ETH_USD_FEED: '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70', SA_ETH_USD_MAX_AGE_SECONDS: '7200' });
    assert.equal(c.labels.badgeFloorWei, '50000000000000000');
    assert.equal(c.labels.underStakedRatioBps, 500);
    assert.deepEqual(c.labels.placeholders, []);
    assert.equal(c.labels.ethUsdFeed, '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70');
    assert.equal(c.labels.ethUsdMaxAgeSeconds, 7200);
    for (const env of [
      { SA_BADGE_FLOOR_WEI: '-1' }, { SA_BADGE_FLOOR_WEI: '1e18' }, { SA_UNDER_STAKED_RATIO_BPS: '10001' },
      { SA_UNDER_STAKED_RATIO_BPS: 'ten' }, { SA_ETH_USD_FEED: '0x1234' }, { SA_ETH_USD_MAX_AGE_SECONDS: '0' },
    ]) assert.throws(() => loadConfig(env), ConfigError, JSON.stringify(env));
  });
});

describe('Chainlink ETH/USD (a mock aggregator on the in-process chain)', () => {
  let ctx;
  let feed;
  before(async () => {
    ctx = await chainContext();
    feed = await (await ctx.hre.ethers.getContractFactory('MockEthUsdFeed')).deploy(8, PRICE);
    await feed.waitForDeployment();
  });

  const read = async (over = {}) => {
    const block = await ctx.provider.getBlock('latest');
    return readEthUsd({ provider: ctx.provider, feed: await feed.getAddress(), blockHash: block.hash, at: block.timestamp, maxAgeSeconds: 3600, ...over });
  };

  test('a fresh answer is read with its decimals', async () => {
    await (await feed.set(PRICE, await latestTimestamp(ctx))).wait();
    const p = await read();
    assert.equal(p.answer, PRICE.toString());
    assert.equal(p.decimals, 8);
    assert.ok(p.updatedAt > 0);
  });

  test('an answer older than SA_ETH_USD_MAX_AGE_SECONDS is refused', async () => {
    const now = await latestTimestamp(ctx);
    await (await feed.set(PRICE, now - 3601)).wait();
    await assert.rejects(read(), (e) => e.code === 'ETH_USD_STALE');
    await (await feed.set(PRICE, await latestTimestamp(ctx))).wait();
    await increaseTime(ctx, 3700);
    await assert.rejects(read(), (e) => e.code === 'ETH_USD_STALE');
  });

  test('a zero or negative answer is refused', async () => {
    for (const answer of [0n, -1n]) {
      await (await feed.set(answer, await latestTimestamp(ctx))).wait();
      await assert.rejects(read(), (e) => e.code === 'ETH_USD_INVALID');
    }
  });

  test('no feed configured, or no feed at the address', async () => {
    await assert.rejects(read({ feed: null }), (e) => e.code === 'ETH_USD_NOT_CONFIGURED');
    await assert.rejects(read({ feed: '0x000000000000000000000000000000000000dEaD' }), (e) => e.code === 'ETH_USD_UNREADABLE');
    await assert.rejects(read({ feed: ctx.address }), (e) => e.code === 'ETH_USD_UNREADABLE', 'a contract that is not a feed');
  });

  describe('labels on the record, priced by the feed in SA_ETH_USD_FEED', () => {
    let site;
    let ids;
    after(() => site?.close());
    before(async () => {
      await (await feed.set(PRICE, await latestTimestamp(ctx))).wait();
      const under = await listing(ctx, { stake: { valueAtRiskUsd: 1250000 } });
      const staked = await listing(ctx, { stake: { valueAtRiskUsd: 10000 } });
      const undeclared = await listing(ctx, { stake: { valueAtRiskUsd: undefined } });
      const scanned = await listing(ctx, { stake: { awards: { LOW: '0', MEDIUM: '0.001 ETH', HIGH: '0.005 ETH', CRITICAL: '0.01 ETH' }, valueAtRiskUsd: 1250000 } });
      const invited = await listing(ctx, { stake: { valueAtRiskUsd: undefined }, allowlist: [ctx.hunters[0].address] });
      ids = { under, staked, undeclared, scanned, invited };
      await (await feed.set(PRICE, await latestTimestamp(ctx))).wait();
      site = siteFor(ctx, { env: { SA_ETH_USD_FEED: await feed.getAddress() } });
      await site.sync();
    });

    const labelsOf = async (l) => (await site.record(l.artifactHash)).labels.listings[String(l.listingId)];

    test('scanned, staked, under-staked and invited, each where it applies', async () => {
      assert.equal((await labelsOf(ids.under)).stake, 'under-staked');
      assert.equal((await labelsOf(ids.staked)).stake, 'staked');
      assert.equal((await labelsOf(ids.undeclared)).stake, 'staked');
      assert.equal((await labelsOf(ids.scanned)).stake, 'scanned');
      const invited = await labelsOf(ids.invited);
      assert.equal(invited.invited, true);
      assert.equal(invited.stake, 'staked');
    });

    test('the price used is reported with the labels', async () => {
      const { labels } = await site.record(ids.under.artifactHash);
      assert.equal(labels.price.answer, PRICE.toString());
      assert.equal(labels.price.decimals, 8);
      assert.equal(labels.price.feed, await feed.getAddress());
    });

    test('the feed entries carry the same labels', async () => {
      const entries = (await site.feed()).listings;
      assert.equal(entries.find((e) => e.listingId === String(ids.under.listingId)).labels.stake, 'under-staked');
      assert.equal(entries.find((e) => e.listingId === String(ids.scanned.listingId)).labels.stake, 'scanned');
    });

    test('a stale price leaves a declared value unlabelled, and an undeclared one staked', async () => {
      await increaseTime(ctx, 2 * 3600);
      await site.sync();
      const under = await labelsOf(ids.under);
      assert.equal(under.stake, null);
      assert.equal(under.error, 'ETH_USD_UNAVAILABLE');
      assert.equal((await labelsOf(ids.undeclared)).stake, 'staked');
      assert.equal((await site.record(ids.under.artifactHash)).labels.priceError, 'ETH_USD_STALE');
    });
  });
});
