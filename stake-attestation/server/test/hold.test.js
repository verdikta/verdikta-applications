// Node P40 (owner decision of 2026-11-23; issue #227): the maker's hold, as the site's server reports it. hold() (node
// P39) stops new commits on a listing at once and leaves its state Open or Depleted: the listing takes late claims
// from then on, until the hold ends in a roll forward or a close. So everywhere the server says whether a listing
// takes claims, it says the hold, in one new field, heldAt: the time of the hold (unix seconds) while the listing is on
// hold, null otherwise, which is what the contract's heldAt view answers (0 for null). What is held here:
//
//   the index      the Held event is stored as the log has it, and the listing carries its time while it is on hold; a
//                  reorg that drops the event restores the listing
//   GET /api/feed  a held listing is no entry, counted or apart, as a lapsed one is not; so pendingClaims and headClaim
//                  describe only listings that take commits, where no late claim is in the queue
//   outside it     a record's labels.listings[<id>], its notCounted.listings and every sameRepository entry carry
//                  heldAt; labels.live is false; `state` stays the chain's, and `record` the lens's, field for field
//   late claims    a held listing's late claims are the record's lateClaims, never its pending
//   the badge      "stake on hold since <day>", never a statement of a live stake
//   no hold        against a contract with no hold (no Held event, no heldAt view) every answer is what it was
//
// The server reads the hold from the indexed event alone and makes no call for it, so nothing new can fail on a
// contract that has no such view: the last describe runs the site behind an endpoint that refuses the view.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ethers } from 'ethers';

import { ENUMS, FEED_EVENTS, stakeAttestation } from '../src/chain/abi.js';
import { badgeDrawn, renderBadge } from '../src/record/badge.js';
import { LABEL_PLACEHOLDERS, listingLabels } from '../src/record/labels.js';
import { project } from '../src/site/projection.js';
import { assertWording } from '../src/wording.js';
import { expectedJson, outputOf } from './helpers/abiJson.js';
import { mergedAbi } from './helpers/chain.js';
import { fakeBuilder } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';
import {
  chainContext, commit, disclose, increaseTime, judgeAndSettle, latestTimestamp, listing, mine, replay, reveal, revealedClaim, rpc,
  siteFor,
} from './helpers/scenario.js';

const ETH = 10n ** 18n;
// a stake with no declared value at risk is "staked" with no price feed; none of these listings proves more than this
const PLAIN = { stake: { valueAtRiskUsd: undefined } };
const PROOF = 'staker named by the repository: yes';
const LIVE = `no finding at or above MEDIUM while staked · ${PROOF}`;
const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const onHold = (t) => `stake on hold since ${dayOf(t)}`;

// what an answer held before this node: only fields are added
const RECORD_KEYS = [
  'artifactHash', 'block', 'record', 'labels', 'history', 'integrity', 'fresh', 'staleReason', 'artifact', 'fork', 'control', 'documents',
  'notCounted', 'badge', 'sameRepository',
];
const FEED_ENTRY_KEYS = [
  'listingId', 'artifactHash', 'artifact', 'maker', 'image', 'scope', 'documents', 'archive', 'awards', 'lowestClassCounted', 'bondWei',
  'windows', 'openedAt', 'fundedUntil', 'daysOpen', 'claimsSoFar', 'escrowRemainingWei', 'owedWei', 'valueAtRiskUsd', 'invited', 'labels',
  'listingCid', 'disputeCid', 'disclosureKey', 'control', 'disclosureRecipient', 'sameRepository', 'pendingClaims', 'headClaim',
];
const LABEL_KEYS_BEFORE = ['stake', 'invited', 'lapsed', 'live', 'topAwardWei', 'valueAtRiskUsd', 'stakeUsd', 'error'];
const RELATED_KEYS_BEFORE = ['listingId', 'artifactHash', 'artifact', 'state', 'lapsed', 'counted', 'page'];
const APART_KEYS_BEFORE = ['listingId', 'maker', 'state', 'lapsed', 'reason', 'detail'];
const sorted = (keys) => [...keys].sort();

/** The maker's hold; returns its time, the block's. */
async function hold(ctx, l, maker = ctx.maker) {
  const rc = await (await ctx.sa.connect(maker).hold(l.listingId)).wait();
  return (await ctx.hre.ethers.provider.getBlock(rc.blockNumber)).timestamp;
}

/** What the contract's own view says of a listing at a block, in the API's form: the time, or null for 0. */
async function viewOf(ctx, listingId, blockTag) {
  const t = await ctx.sa.heldAt(listingId, { blockTag });
  return t === 0n ? null : Number(t);
}

const stateName = async (ctx, listingId, blockTag) => ENUMS.ListingState[Number((await ctx.sa.getListing(listingId, { blockTag })).state)];

/** Every value under the key `heldAt` anywhere in an answer. */
function heldAtValues(value, out = []) {
  if (Array.isArray(value)) for (const v of value) heldAtValues(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // an event's arguments are the log's, not the site's field
      if (k === 'args') continue;
      if (k === 'heldAt') out.push(v);
      else heldAtValues(v, out);
    }
  }
  return out;
}

/** The badge's message, from its SVG, and the lines it is drawn on. */
async function badgeOf(api, hash) {
  const res = await api.get(`/api/records/${hash}/badge.svg`);
  assert.equal(res.status, 200);
  const svg = await res.text();
  const label = /aria-label="([^"]*)"/.exec(svg)[1];
  assert.ok(label.startsWith('verdikta stake: '), label);
  const lines = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).slice(1);
  return { svg, message: label.slice('verdikta stake: '.length), lines };
}

describe('a held listing, as the site reports it', () => {
  let ctx;
  let site;
  let api;
  const L = {};
  const T = {};
  const claims = {};

  before(async () => {
    ctx = await chainContext();
    const [h0, h1, h2] = ctx.hunters;
    // one repository, a commit each
    L.open = await listing(ctx, PLAIN);
    L.held = await listing(ctx, { ...PLAIN, escrowWei: 5n * ETH });
    L.depleted = await listing(ctx, PLAIN);
    L.rolled = await listing(ctx, PLAIN);
    L.successor = await listing(ctx, PLAIN);
    L.closed = await listing(ctx, PLAIN);
    // the same versions listed again from another wallet: the project names ctx.maker, so these do not count
    L.apart = { ...L.open, ...(await replay(ctx, L.open, { from: ctx.other })) };
    L.apartOpen = { ...L.successor, ...(await replay(ctx, L.successor, { from: ctx.other })) };

    // a CRITICAL payout empties this one's escrow: Depleted, and then held
    await judgeAndSettle(ctx, await revealedClaim(ctx, h2, L.depleted.listingId), 'CRITICAL');
    T.depleted = await hold(ctx, L.depleted);

    // a claim open before the hold, then the hold, then a late claim behind it
    claims.before = await revealedClaim(ctx, h0, L.held.listingId);
    T.held = await hold(ctx, L.held);
    claims.late = await commit(ctx, h1, L.held.listingId, { late: true });
    await disclose(ctx, h1, claims.late);

    // a hold that ended: in a roll forward, and in a close
    T.rolled = await hold(ctx, L.rolled);
    await (await ctx.sa.connect(ctx.maker).rollForward(L.rolled.listingId, L.successor.listingId)).wait();
    T.closed = await hold(ctx, L.closed);
    await (await ctx.sa.connect(ctx.maker).close(L.closed.listingId)).wait();
    T.apart = await hold(ctx, L.apart, ctx.other);

    site = siteFor(ctx);
    await site.sync();
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  const id = (l) => String(l.listingId);
  const feed = async () => (await api.get('/api/feed')).json();
  const record = async (l) => {
    const res = await api.get(`/api/records/${l.artifactHash}`);
    assert.equal(res.status, 200);
    return res.json();
  };
  const cursor = () => site.store.state.cursor.number;

  test('the scenario: a held listing is Open or Depleted on-chain, takes no commit and takes late claims', async () => {
    assert.equal(await stateName(ctx, L.held.listingId), 'Open');
    assert.equal(await stateName(ctx, L.apart.listingId), 'Open');
    assert.equal(await stateName(ctx, L.depleted.listingId), 'Depleted');
    for (const l of [L.held, L.apart, L.depleted]) {
      assert.equal(await ctx.sa.acceptsCommits(l.listingId), false);
      assert.equal(await ctx.sa.acceptsLateClaims(l.listingId), true);
    }
    // but for the hold, this one is what the feed lists: Open, its paid period not over, its escrow at least the top award
    const held = await ctx.sa.getListing(L.held.listingId);
    assert.equal(await ctx.sa.isLapsed(L.held.listingId), false);
    assert.ok(held.escrowWei >= held.awards[3]);
    assert.equal(await stateName(ctx, L.rolled.listingId), 'Rolled');
    assert.equal(await stateName(ctx, L.closed.listingId), 'Closed');
  });

  test('the indexer stores Held as the log has it, and the listing carries the time while it is on hold', async () => {
    const provider = ctx.hre.ethers.provider;
    const raw = await provider.getLogs({ address: ctx.address, fromBlock: ctx.fromBlock, toBlock: cursor() });
    const expected = [];
    for (const log of raw) {
      const parsed = ctx.sa.interface.parseLog(log);
      if (parsed?.name !== 'Held') continue;
      expected.push({
        name: 'Held',
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        logIndex: log.index,
        txHash: log.transactionHash,
        timestamp: (await provider.getBlock(log.blockNumber)).timestamp,
        args: { listingId: parsed.args.listingId.toString(), heldAt: parsed.args.heldAt.toString() },
      });
    }
    assert.equal(expected.length, 5, 'five holds were sent');
    assert.deepEqual(site.store.state.events.filter((e) => e.name === 'Held'), expected);
    assert.ok(FEED_EVENTS.includes('Held'), 'a listing\'s event: the events route carries it');

    const { listings } = project(site.store.state.events);
    // the time while on hold; null before a hold and once it has ended: what the contract's view answers at that block
    for (const [name, l] of Object.entries(L)) {
      assert.equal(listings.get(id(l)).heldAt, await viewOf(ctx, l.listingId, cursor()), name);
    }
    assert.deepEqual(
      Object.fromEntries(Object.keys(L).map((name) => [name, listings.get(id(L[name])).heldAt])),
      { open: null, held: T.held, depleted: T.depleted, rolled: null, successor: null, closed: null, apart: T.apart, apartOpen: null },
    );
    assert.equal(typeof listings.get(id(L.held)).heldAt, 'number', 'unix seconds, as the feed gives a listing\'s other times');
    // the log keeps the time after the hold has ended
    for (const [l, t, end] of [[L.rolled, T.rolled, 'RolledForward'], [L.closed, T.closed, 'Closed']]) {
      const names = site.store.state.events.filter((e) => e.args.listingId === id(l)).map((e) => e.name);
      assert.ok(names.indexOf('Held') >= 0 && names.indexOf('Held') < names.indexOf(end), `${end} after Held`);
      assert.equal(site.store.state.events.find((e) => e.name === 'Held' && e.args.listingId === id(l)).args.heldAt, String(t));
    }
  });

  test('GET /api/feed: a held listing is no entry, counted or apart; every entry takes commits and no late claim', async () => {
    const body = await feed();
    const blockTag = body.block.number;
    assert.deepEqual(body.listings.map((e) => e.listingId).sort(), [id(L.open), id(L.successor)].sort());
    // apart: the open replay, never the held one
    assert.deepEqual(body.notCounted.map((e) => e.listingId), [id(L.apartOpen)]);
    for (const l of [L.held, L.depleted, L.apart, L.rolled, L.closed]) {
      assert.equal(JSON.stringify([body.listings.map((e) => e.listingId), body.notCounted.map((e) => e.listingId)]).includes(`"${id(l)}"`), false);
    }
    for (const e of [...body.listings, ...body.notCounted]) {
      assert.equal(await ctx.sa.acceptsCommits(e.listingId, { blockTag }), true, `listing ${e.listingId} takes commits`);
      assert.equal(await ctx.sa.acceptsLateClaims(e.listingId, { blockTag }), false, `listing ${e.listingId} takes no late claim`);
      assert.equal(await viewOf(ctx, e.listingId, blockTag), null);
    }
    // an entry is as it was: no field is added to it, and its labels say it is live and not held
    for (const e of body.listings) {
      assert.deepEqual(sorted(Object.keys(e)), sorted(FEED_ENTRY_KEYS));
      assert.deepEqual(sorted(Object.keys(e.labels)), sorted([...LABEL_KEYS_BEFORE, 'heldAt']));
      assert.equal(e.labels.live, true);
      assert.equal(e.labels.heldAt, null);
    }
  });

  test('GET /api/records/:hash: the hold\'s time beside the listing\'s labels, labels.live false, and `record` still the lens\'s', async () => {
    const body = await record(L.held);
    assert.deepEqual(sorted(Object.keys(body)), sorted(RECORD_KEYS), 'no field is added to the answer itself');
    const labels = body.labels.listings[id(L.held)];
    assert.deepEqual(sorted(Object.keys(labels)), sorted([...LABEL_KEYS_BEFORE, 'heldAt']));
    assert.equal(labels.heldAt, T.held);
    assert.equal(labels.heldAt, await viewOf(ctx, L.held.listingId, body.block.number), 'what the view answers at the answer\'s block');
    assert.equal(labels.live, false, 'a held stake is never called live');
    assert.equal(labels.lapsed, false);
    assert.equal(labels.stake, 'staked', 'the stake\'s label is as it was');

    // the mirror is the chain's, field for field: the state it gives a held listing is Open, and it has no new field
    const onchain = await ctx.sa.recordByHash(L.held.artifactHash, { blockTag: body.block.number });
    assert.deepEqual(body.record, expectedJson(onchain, outputOf(mergedAbi(ctx.hre), 'recordByHash')));
    assert.equal(body.record.listings[0].state, 'Open');
    assert.equal(Object.hasOwn(body.record.listings[0], 'heldAt'), false);

    // the listing's history keeps the event
    const event = body.history.events.find((e) => e.name === 'Held');
    assert.deepEqual(event.args, { listingId: id(L.held), heldAt: String(T.held) });
    assert.equal(event.timestamp, T.held);
  });

  test('a Depleted listing on hold reads Depleted and held; a hold that ended reads null, with the event in its history', async () => {
    const depleted = await record(L.depleted);
    assert.equal(depleted.record.listings[0].state, 'Depleted');
    assert.equal(depleted.labels.listings[id(L.depleted)].heldAt, T.depleted);
    assert.equal(depleted.labels.listings[id(L.depleted)].live, false);
    for (const [l, t, state] of [[L.rolled, T.rolled, 'Rolled'], [L.closed, T.closed, 'Closed']]) {
      const body = await record(l);
      assert.equal(body.record.listings[0].state, state);
      assert.equal(body.labels.listings[id(l)].heldAt, null, `${state}: the hold has ended`);
      assert.equal(body.labels.listings[id(l)].live, false);
      assert.equal(await viewOf(ctx, l.listingId, body.block.number), null);
      assert.equal(body.history.events.find((e) => e.name === 'Held').args.heldAt, String(t), 'the history keeps the time');
    }
    const open = await record(L.open);
    assert.equal(open.labels.listings[id(L.open)].heldAt, null);
    assert.equal(open.labels.listings[id(L.open)].live, true);
  });

  test('a listing shown apart on a record carries heldAt too', async () => {
    const body = await record(L.open);
    assert.deepEqual(body.record.listings.map((l) => l.listingId), [id(L.open)]);
    assert.equal(body.notCounted.listings.length, 1);
    const apart = body.notCounted.listings[0];
    assert.deepEqual(sorted(Object.keys(apart)), sorted([...APART_KEYS_BEFORE, 'heldAt']));
    assert.equal(apart.listingId, id(L.apart));
    assert.equal(apart.state, 'Open');
    assert.equal(apart.lapsed, false);
    assert.equal(apart.heldAt, T.apart);
    // one that is not held: null
    const other = await record(L.successor);
    assert.deepEqual(other.notCounted.listings.map((x) => [x.listingId, x.heldAt]), [[id(L.apartOpen), null]]);
    // and a hold on a listing that does not count never reaches the badge of the hash
    assert.equal(body.badge.message, LIVE);
  });

  test('the other listings of a repository: each with heldAt, its state the chain\'s', async () => {
    const body = await feed();
    const blockTag = body.block.number;
    const entry = body.listings.find((e) => e.listingId === id(L.open));
    const rec = await record(L.open);
    assert.ok(entry.sameRepository.length >= 6);
    for (const [where, list] of [['the feed entry', entry.sameRepository], ['the record', rec.sameRepository]]) {
      for (const x of list) {
        assert.deepEqual(sorted(Object.keys(x)), sorted([...RELATED_KEYS_BEFORE, 'heldAt']), where);
        assert.equal(x.heldAt, await viewOf(ctx, x.listingId, blockTag), `${where}: listing ${x.listingId}`);
        assert.equal(x.state, await stateName(ctx, x.listingId, blockTag), `${where}: the state is the chain's, never a value of the site's`);
      }
      const of = (l) => list.find((x) => x.listingId === id(l));
      assert.deepEqual([of(L.held).state, of(L.held).heldAt], ['Open', T.held], where);
      assert.deepEqual([of(L.depleted).state, of(L.depleted).heldAt], ['Depleted', T.depleted], where);
      assert.deepEqual([of(L.rolled).state, of(L.rolled).heldAt], ['Rolled', null], where);
      assert.deepEqual([of(L.closed).state, of(L.closed).heldAt], ['Closed', null], where);
      assert.deepEqual([of(L.successor).state, of(L.successor).heldAt], ['Open', null], where);
    }
    // the feed's own list also names the held replay of the entry's version
    assert.deepEqual([entry.sameRepository.find((x) => x.listingId === id(L.apart)).state, entry.sameRepository.find((x) => x.listingId === id(L.apart)).heldAt], ['Open', T.apart]);
  });

  test('the badge of a held listing says it is on hold, and since when: never a live stake', async () => {
    for (const [l, t] of [[L.held, T.held], [L.depleted, T.depleted]]) {
      const b = await badgeOf(api, l.artifactHash);
      assert.equal(b.message, onHold(t));
      assert.deepEqual(b.lines, [onHold(t)], 'one line: no proof is stated of a stake that takes no commit');
      assert.equal(/while staked|no finding/.test(b.svg), false);
      assert.deepEqual((await record(l)).badge, { state: 'ended', message: onHold(t), listingId: id(l), class: null });
    }
    assert.match(onHold(T.held), /^stake on hold since \d{4}-\d{2}-\d{2}$/);
    // a hold that ended: how the stake ended, as before
    assert.equal((await badgeOf(api, L.rolled.artifactHash)).message, 'stake rolled forward');
    assert.equal((await badgeOf(api, L.closed.artifactHash)).message, 'stake closed');
    assert.equal((await badgeOf(api, L.successor.artifactHash)).message, LIVE);
  });

  test('GET /api/feed/events carries each Held event, with whether its listing counts', async () => {
    const body = await (await api.get('/api/feed/events?limit=1000')).json();
    const held = body.events.filter((e) => e.name === 'Held');
    assert.deepEqual(
      held.map((e) => [e.listingId, e.claimId, e.args, e.counted]).sort((a, b) => Number(BigInt(a[0]) - BigInt(b[0]))),
      [[L.held, T.held, true], [L.depleted, T.depleted, true], [L.rolled, T.rolled, true], [L.closed, T.closed, true], [L.apart, T.apart, false]]
        .map(([l, t, counted]) => [id(l), null, { listingId: id(l), heldAt: String(t) }, counted])
        .sort((a, b) => Number(BigInt(a[0]) - BigInt(b[0]))),
    );
  });

  // From here on the tests move the chain.
  test('a held listing\'s late claims are late claims on the record, never pending; the claim open before the hold stays pending and is paid', async () => {
    const [, h1, , h3] = ctx.hunters;
    const key = id(L.held);
    let body = await record(L.held);
    assert.equal(body.record.history.pending, '1', 'the claim committed before the hold');
    assert.equal(body.record.history.claims, '1');
    assert.equal(body.record.history.lateClaims, '1');
    const { claims: indexed } = project(site.store.state.events);
    assert.equal(indexed.get(String(claims.before)).late, false);
    assert.equal(indexed.get(String(claims.late)).late, true);
    assert.deepEqual(body.history.events.filter((e) => e.claimId === String(claims.late)).map((e) => e.name), ['LateClaim', 'Disclosed']);

    // the claim open before the hold keeps its path: judged, and paid from the held listing's escrow
    await judgeAndSettle(ctx, claims.before, 'MEDIUM');
    // then the late claim, behind it in commit order: judged, recorded as a late finding, no award
    await reveal(ctx, h1, claims.late);
    await judgeAndSettle(ctx, claims.late, 'LOW');
    claims.late2 = await commit(ctx, h3, L.held.listingId, { late: true });
    await site.sync();

    body = await record(L.held);
    const onchain = await ctx.sa.getListing(L.held.listingId, { blockTag: body.block.number });
    assert.equal(body.record.history.pending, '0', 'no late claim is ever pending');
    assert.equal(body.record.history.claims, '1');
    assert.equal(body.record.history.lateClaims, '2');
    assert.equal(body.record.history.outcomes[ENUMS.Outcome.indexOf('MEDIUM')], '1');
    assert.equal(body.record.history.lateOutcomes[ENUMS.Outcome.indexOf('LOW')], '1');
    assert.deepEqual(body.record.findings.map((f) => [f.claimId, f.outcome, f.late, f.paidWei !== '0']), [
      [String(claims.before), 'MEDIUM', false, true],
      [String(claims.late), 'LOW', true, false],
    ]);
    assert.equal(project(site.store.state.events).claims.get(String(claims.late2)).late, true);
    // still Open, still held, still no entry: here the queue's head is a late claim while pendingClaims is 0, which is
    // what an entry would have said of it
    assert.equal(body.record.listings[0].state, 'Open');
    assert.equal(body.labels.listings[key].heldAt, T.held);
    assert.equal(body.labels.listings[key].live, false);
    assert.equal(onchain.pendingClaims, 0n);
    assert.equal(onchain.headClaim, claims.late2);
    assert.ok(onchain.escrowWei >= onchain.awards[3]);
    const f = await feed();
    assert.equal([...f.listings, ...f.notCounted].some((e) => e.listingId === key), false);
    for (const e of f.listings) assert.equal(await ctx.sa.acceptsLateClaims(e.listingId, { blockTag: f.block.number }), false);
    assert.equal((await badgeOf(api, L.held.artifactHash)).message, onHold(T.held), 'a finding on a held listing does not bring a statement back');
  });

  test('a top-up reopens a held Depleted listing and does not end the hold: Open, funded, and still no entry', async () => {
    await (await ctx.sa.connect(ctx.maker).fund(L.depleted.listingId, 0, { value: 2n * ETH })).wait();
    await site.sync();
    const body = await record(L.depleted);
    const onchain = await ctx.sa.getListing(L.depleted.listingId, { blockTag: body.block.number });
    assert.equal(body.record.listings[0].state, 'Open');
    assert.ok(onchain.escrowWei >= onchain.awards[3]);
    assert.equal(await ctx.sa.isLapsed(L.depleted.listingId, { blockTag: body.block.number }), false);
    assert.equal(await ctx.sa.acceptsCommits(L.depleted.listingId, { blockTag: body.block.number }), false);
    assert.equal(body.labels.listings[id(L.depleted)].heldAt, T.depleted);
    assert.equal(body.labels.listings[id(L.depleted)].live, false);
    const f = await feed();
    assert.equal([...f.listings, ...f.notCounted].some((e) => e.listingId === id(L.depleted)), false);
    assert.equal((await badgeOf(api, L.depleted.artifactHash)).message, onHold(T.depleted));
  });
});

describe('a reorg that drops a hold', () => {
  const view = (events) => events.map(({ name, blockNumber, blockHash, logIndex, txHash, args }) => ({ name, blockNumber, blockHash, logIndex, txHash, args }));

  test('the Held event goes with its block, and the listing is as it was: in the feed, live, not held', async () => {
    const ctx = await chainContext();
    const env = { SA_CONFIRMATIONS: '2' };
    const l = await listing(ctx, PLAIN);
    const other = await listing(ctx, PLAIN);
    await mine(ctx, 3);
    const site = siteFor(ctx, { env });
    const key = String(l.listingId);
    const related = async () => (await site.feed()).listings.find((e) => e.listingId === String(other.listingId)).sameRepository.find((x) => x.listingId === key);
    try {
      await site.sync();
      const fork = await ctx.hre.ethers.provider.getBlockNumber();
      assert.ok((await site.feed()).listings.some((e) => e.listingId === key));
      const snapshot = await rpc(ctx, 'evm_snapshot');

      // the branch the indexer reads, then loses: the maker holds the listing
      const t = await hold(ctx, l);
      await mine(ctx, 4);
      await site.sync();
      const orphanedHash = site.store.state.cursor.hash;
      assert.ok(site.store.state.cursor.number > fork + 2, 'the hold is past the confirmation depth');
      assert.ok(site.store.state.events.some((e) => e.name === 'Held' && e.args.listingId === key));
      assert.equal(project(site.store.state.events).listings.get(key).heldAt, t);
      assert.equal((await site.feed()).listings.some((e) => e.listingId === key), false, 'held: not in the feed');
      let rec = await site.record(l.artifactHash);
      assert.equal(rec.labels.listings[key].heldAt, t);
      assert.equal(rec.labels.listings[key].live, false);
      assert.equal(rec.badge.message, onHold(t));
      assert.equal((await related()).heldAt, t);

      // the canonical chain: no hold; a hunter commits on the listing instead, as it takes commits there
      assert.equal(await rpc(ctx, 'evm_revert', [snapshot]), true);
      const claimId = await commit(ctx, ctx.hunters[0], l.listingId);
      await mine(ctx, 12);
      assert.equal(await ctx.sa.heldAt(l.listingId), 0n);

      const r = await site.sync();
      assert.ok(r.rolledBack, 'the sync reports the rollback');
      assert.ok(r.rolledBack.to <= fork);
      assert.notEqual(site.store.state.cursor.hash, orphanedHash);
      assert.equal(site.store.state.events.some((e) => e.name === 'Held'), false, 'the orphaned hold is gone');
      assert.ok(site.store.state.events.some((e) => e.name === 'Committed' && e.args.claimId === String(claimId)));
      const fresh = siteFor(ctx, { env });
      try {
        await fresh.sync();
        assert.deepEqual(view(site.store.state.events), view(fresh.store.state.events), 'exactly what a fresh indexer reads from the new chain');
      } finally {
        fresh.close();
      }

      // the listing is restored everywhere the hold showed
      assert.equal(project(site.store.state.events).listings.get(key).heldAt, null);
      const entry = (await site.feed()).listings.find((e) => e.listingId === key);
      assert.ok(entry, 'back in the feed');
      assert.equal(entry.labels.live, true);
      assert.equal(entry.pendingClaims, 1);
      rec = await site.record(l.artifactHash);
      assert.equal(rec.labels.listings[key].heldAt, null);
      assert.equal(rec.labels.listings[key].live, true);
      assert.equal(rec.badge.message, LIVE);
      assert.equal(rec.history.events.some((e) => e.name === 'Held'), false);
      assert.equal((await related()).heldAt, null);
    } finally {
      site.close();
    }
  });
});

describe('listingLabels and the badge, of a listing on hold', () => {
  const ctxLabels = { price: null, badgeFloorWei: LABEL_PLACEHOLDERS.badgeFloorWei, underStakedRatioBps: LABEL_PLACEHOLDERS.underStakedRatioBps };
  const HELD_AT = 1_795_000_000; // 2026-11-18
  /** A ListingRecord as the record mirror writes it; `heldAt` is the site's own, beside it. */
  const listed = (over = {}) => ({
    listingId: '1',
    state: 'Open',
    lapsed: false,
    invited: false,
    awards: ['0', (ETH / 10n).toString(), (4n * ETH / 10n).toString(), (2n * ETH).toString()],
    lowestClassCounted: 'MEDIUM',
    valueAtRiskUsd: '0',
    ...over,
  });
  /** A record answer, as far as the badge reads it. */
  const viewOfListings = (listings, findings = []) => ({
    record: { listings, findings },
    labels: { listings: Object.fromEntries(listings.map((l) => [l.listingId, listingLabels(l, ctxLabels)])) },
    control: Object.fromEntries(listings.map((l) => [l.listingId, { proof: 'yes', statement: PROOF }])),
  });

  test('labels: heldAt is the hold\'s time, and a listing on hold is never live, whatever its state', () => {
    for (const state of ENUMS.ListingState) {
      for (const lapsed of [false, true]) {
        const l = listingLabels(listed({ state, lapsed, heldAt: HELD_AT }), ctxLabels);
        assert.equal(l.heldAt, HELD_AT);
        assert.equal(l.live, false, `${state}, lapsed ${lapsed}`);
      }
    }
    // the rest of a held listing's labels is as it was
    const { heldAt, live, ...rest } = listingLabels(listed({ heldAt: HELD_AT }), ctxLabels);
    const { heldAt: none, live: wasLive, ...before } = listingLabels(listed(), ctxLabels);
    assert.deepEqual(rest, before);
    assert.deepEqual([heldAt, live, none, wasLive], [HELD_AT, false, null, true]);
  });

  test('labels: with no hold every label is what it was, and heldAt is null', () => {
    for (const state of ENUMS.ListingState) {
      for (const lapsed of [false, true]) {
        for (const none of [{}, { heldAt: null }, { heldAt: undefined }]) {
          const l = listingLabels(listed({ state, lapsed, ...none }), ctxLabels);
          assert.deepEqual(l, {
            stake: 'staked',
            invited: false,
            lapsed,
            heldAt: null,
            live: state === 'Open' && !lapsed,
            topAwardWei: (2n * ETH).toString(),
            valueAtRiskUsd: '0',
            stakeUsd: null,
            error: null,
          }, `${state}, lapsed ${lapsed}`);
        }
      }
    }
  });

  test('the badge: a listing on hold reads "stake on hold since <day>", before lapsed or depleted', () => {
    const said = `stake on hold since ${dayOf(HELD_AT)}`;
    assert.equal(said, 'stake on hold since 2026-11-18');
    for (const over of [{}, { lapsed: true }, { state: 'Depleted' }, { state: 'Depleted', lapsed: true }]) {
      const drawn = badgeDrawn(viewOfListings([listed({ heldAt: HELD_AT, ...over })]));
      assert.deepEqual(drawn, { badge: { state: 'ended', message: said, listingId: '1', class: null }, lines: [said] }, JSON.stringify(over));
      assert.equal(/while staked|no finding|valid finding/.test(renderBadge({ ...drawn.badge, lines: drawn.lines })), false);
    }
    // a finding on it changes nothing: no statement is made of a held stake
    const found = badgeDrawn(viewOfListings([listed({ heldAt: HELD_AT })], [{ listingId: '1', outcome: 'HIGH' }]));
    assert.equal(found.badge.message, said);
    assert.equal(assertWording(said), said);
  });

  test('the badge: of a hash\'s listings, one on hold is said before one that ended, and a live one before both', () => {
    const said = `stake on hold since ${dayOf(HELD_AT)}`;
    // an older listing on hold, a newer one closed: the stake that is there is on hold
    const held = listed({ listingId: '3', heldAt: HELD_AT });
    const closed = listed({ listingId: '9', state: 'Closed' });
    assert.deepEqual(badgeDrawn(viewOfListings([held, closed])).badge, { state: 'ended', message: said, listingId: '3', class: null });
    // two on hold: the later listing's
    const later = listed({ listingId: '5', heldAt: HELD_AT + 86400 });
    assert.deepEqual(badgeDrawn(viewOfListings([held, later, closed])).badge, { state: 'ended', message: `stake on hold since ${dayOf(HELD_AT + 86400)}`, listingId: '5', class: null });
    // a listing of the hash that takes commits is the hash's live stake, and the badge names it
    const live = listed({ listingId: '7' });
    const b = badgeDrawn(viewOfListings([held, live, closed])).badge;
    assert.deepEqual(b, { state: 'live', message: LIVE, listingId: '7', class: 'MEDIUM' });
  });

  test('the badge: with no hold it says what it said', () => {
    const cases = [
      [listed(), 'live', LIVE],
      [listed({ lapsed: true }), 'ended', 'stake lapsed'],
      [listed({ state: 'Depleted' }), 'ended', 'stake depleted'],
      [listed({ state: 'Rolled' }), 'ended', 'stake rolled forward'],
      [listed({ state: 'Closed' }), 'ended', 'stake closed'],
      [listed({ state: 'Listed' }), 'ended', 'stake not open'],
    ];
    for (const [l, state, message] of cases) {
      const { badge } = badgeDrawn(viewOfListings([l]));
      assert.deepEqual([badge.state, badge.message], [state, message]);
    }
  });
});

describe('against a contract with no hold', () => {
  // What a server sees of a contract is what its endpoint answers. A contract from before the hold has no Held
  // event in its logs, and a call of heldAt or hold reaches no function there and reverts. So: the site over an
  // endpoint that refuses both selectors, on a chain where no hold was ever sent.
  const SELECTORS = ['heldAt', 'hold'].map((name) => stakeAttestation.getFunction(name).selector);
  const HELD_TOPIC = stakeAttestation.getEvent('Held').topicHash;
  let ctx;
  let site;
  let api;
  const L = {};
  const asked = [];
  let heldLogs = 0;

  before(async () => {
    ctx = await chainContext();
    const [h0, h1] = ctx.hunters;
    L.lapsed = await listing(ctx, PLAIN);
    const fundedUntil = Number((await ctx.sa.getListing(L.lapsed.listingId)).fundedUntil);
    await increaseTime(ctx, fundedUntil - (await latestTimestamp(ctx)) + 1);
    L.open = await listing(ctx, PLAIN);
    L.depleted = await listing(ctx, PLAIN);
    L.rolled = await listing(ctx, PLAIN);
    L.successor = await listing(ctx, PLAIN);
    L.closed = await listing(ctx, PLAIN);
    L.apart = { ...L.open, ...(await replay(ctx, L.open, { from: ctx.other })) };
    await judgeAndSettle(ctx, await revealedClaim(ctx, h0, L.depleted.listingId), 'CRITICAL');
    await (await ctx.sa.connect(ctx.maker).rollForward(L.rolled.listingId, L.successor.listingId)).wait();
    await (await ctx.sa.connect(ctx.maker).close(L.closed.listingId)).wait();
    // a late claim where one was always taken, and a claim open on the listing in the feed
    await commit(ctx, h1, L.closed.listingId, { late: true });
    await commit(ctx, h1, L.open.listingId);

    const inner = ctx.hre.network.provider;
    const endpoint = {
      async request({ method, params }) {
        const data = String(params?.[0]?.data ?? params?.[0]?.input ?? '');
        if ((method === 'eth_call' || method === 'eth_estimateGas') && SELECTORS.some((s) => data.startsWith(s))) {
          asked.push(data.slice(0, 10));
          throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
        }
        const result = await inner.request({ method, params });
        if (method === 'eth_getLogs') heldLogs += result.filter((log) => log.topics[0] === HELD_TOPIC).length;
        return result;
      },
    };
    const provider = new ethers.BrowserProvider(endpoint, 31337, { cacheTimeout: -1, staticNetwork: true });
    site = siteFor(ctx, { provider });
    await site.sync();
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  const id = (l) => String(l.listingId);
  const answers = async () => {
    const out = { feed: await (await api.get('/api/feed')).json(), events: await (await api.get('/api/feed/events?limit=1000')).json(), records: {}, badges: {} };
    for (const [name, l] of Object.entries(L)) {
      const res = await api.get(`/api/records/${l.artifactHash}`);
      assert.equal(res.status, 200, name);
      out.records[name] = await res.json();
      out.badges[name] = (await badgeOf(api, l.artifactHash)).message;
    }
    return out;
  };

  test('the endpoint refuses the hold\'s view, as a contract without it does', async () => {
    const reader = new ethers.Contract(ctx.address, stakeAttestation, site.provider);
    await assert.rejects(reader.heldAt(L.open.listingId), (e) => e.code === 'CALL_EXCEPTION');
    assert.equal(asked.length, 1);
    asked.length = 0;
    // while every view the site reads still answers
    assert.equal(await reader.acceptsCommits(L.open.listingId), true);
  });

  test('every route answers, the server never asks the contract for the hold, and no Held event is read', async () => {
    const a = await answers();
    assert.equal(a.feed.fresh, true);
    assert.deepEqual(asked, [], 'no call of heldAt or hold: nothing new can fail on a contract that has neither');
    assert.equal(heldLogs, 0);
    assert.equal(site.store.state.events.some((e) => e.name === 'Held'), false);
    assert.equal(a.events.events.some((e) => e.name === 'Held'), false);
    assert.ok(a.events.events.length > 10);
  });

  test('the new field is there and null, everywhere', async () => {
    const a = await answers();
    const all = heldAtValues(a);
    assert.ok(all.length >= 15, `the answers hold the field (${all.length} places)`);
    assert.ok(all.every((v) => v === null));
    // in each place it has: an entry's labels and related listings, a record's labels, apart listings and related listings
    const entry = a.feed.listings.find((e) => e.listingId === id(L.open));
    assert.equal(entry.labels.heldAt, null);
    assert.ok(entry.sameRepository.length > 0 && entry.sameRepository.every((x) => x.heldAt === null));
    const rec = a.records.open;
    assert.equal(rec.labels.listings[id(L.open)].heldAt, null);
    assert.deepEqual(rec.notCounted.listings.map((x) => [x.listingId, x.heldAt]), [[id(L.apart), null]]);
    assert.ok(rec.sameRepository.length > 0 && rec.sameRepository.every((x) => x.heldAt === null));
  });

  test('every existing field has the value it had: the feed', async () => {
    const { feed } = await answers();
    const blockTag = feed.block.number;
    // the entries are the listings that take commits, as before
    assert.deepEqual(feed.listings.map((e) => e.listingId).sort(), [id(L.open), id(L.successor)].sort());
    assert.deepEqual(feed.notCounted.map((e) => e.listingId), [id(L.apart)]);
    for (const e of feed.notCounted) assert.deepEqual(sorted(Object.keys(e)), sorted(['listingId', 'artifactHash', 'artifact', 'maker', 'reason', 'detail']));
    for (const e of feed.listings) {
      assert.deepEqual(sorted(Object.keys(e)), sorted(FEED_ENTRY_KEYS));
      const { heldAt, ...labels } = e.labels;
      assert.deepEqual(labels, { stake: 'staked', invited: false, lapsed: false, live: true, topAwardWei: (2n * ETH).toString(), valueAtRiskUsd: '0', stakeUsd: null, error: null });
      const onchain = await ctx.sa.getListing(e.listingId, { blockTag });
      assert.deepEqual([e.pendingClaims, e.headClaim, e.claimsSoFar], [Number(onchain.pendingClaims), onchain.headClaim === 0n ? null : onchain.headClaim.toString(), Number(onchain.claimsCommitted)]);
      for (const x of e.sameRepository) {
        const { heldAt: none, ...before } = x;
        assert.deepEqual(sorted(Object.keys(before)), sorted(RELATED_KEYS_BEFORE));
        assert.equal(x.state, await stateName(ctx, x.listingId, blockTag));
        assert.equal(x.lapsed, await ctx.sa.isLapsed(x.listingId, { blockTag }));
      }
    }
    assert.equal(feed.listings.find((e) => e.listingId === id(L.open)).pendingClaims, 1);
  });

  test('every existing field has the value it had: the records, their labels and the badges', async () => {
    const a = await answers();
    const lensRecord = outputOf(mergedAbi(ctx.hre), 'recordByHash');
    const expectLive = { lapsed: false, open: true, depleted: false, rolled: false, successor: true, closed: false };
    for (const [name, l] of Object.entries(L)) {
      if (name === 'apart') continue; // the open listing's version, read above
      const rec = a.records[name];
      assert.deepEqual(sorted(Object.keys(rec)), sorted(RECORD_KEYS), name);
      const onchain = expectedJson(await ctx.sa.recordByHash(l.artifactHash, { blockTag: rec.block.number }), lensRecord);
      const mine2 = rec.record.listings[0];
      assert.deepEqual(mine2, onchain.listings.find((x) => x.listingId === id(l)), `${name}: the lens's listing, field for field`);
      const { heldAt, ...labels } = rec.labels.listings[id(l)];
      assert.deepEqual(labels, {
        stake: 'staked', invited: false, lapsed: mine2.lapsed, live: mine2.state === 'Open' && !mine2.lapsed, topAwardWei: (2n * ETH).toString(), valueAtRiskUsd: '0', stakeUsd: null, error: null,
      }, name);
      assert.equal(labels.live, expectLive[name], name);
      for (const x of rec.notCounted.listings) {
        const { heldAt: none, ...before } = x;
        assert.deepEqual(sorted(Object.keys(before)), sorted(APART_KEYS_BEFORE));
      }
    }
    assert.deepEqual(a.badges, {
      lapsed: 'stake lapsed',
      open: LIVE,
      depleted: 'stake depleted',
      rolled: 'stake rolled forward',
      successor: LIVE,
      closed: 'stake closed',
      apart: LIVE,
    });
    // a late claim on a closed listing is a late claim, as it was
    assert.equal(a.records.closed.record.history.lateClaims, '1');
    assert.equal(a.records.closed.record.history.pending, '0');
  });
});

describe('the hold, where it is written down', () => {
  const flat = (s) => s.replace(/\s+/g, ' ');

  test('feed.js\'s header says why a held listing is no entry, and why no entry\'s queue holds a late claim', () => {
    const source = fs.readFileSync(new URL('../src/site/feed.js', import.meta.url), 'utf8');
    const header = flat(source.slice(0, source.indexOf('\nimport ')).replace(/^\/\/ ?/gm, ''));
    assert.match(header, /A held listing[^.]*takes no commit[^.]*takes late claims/);
    assert.match(header, /so it is not an entry, as a lapsed one is not/);
    assert.match(header, /A late claim is taken only on a Rolled, a Closed or a held listing, and none of the three is ever an entry again/);
    assert.match(header, /a hold has no resume/);
    assert.match(header, /every claim in its queue is one of pendingClaims/);
    assert.doesNotMatch(header, /a late claim is only taken on a Rolled or Closed one/, 'the statement from before the hold is gone');
    // and the code does it from the indexed event, with no read of the chain for it
    assert.match(source, /l\.opened && !l\.rolled && !l\.closed && l\.heldAt === null/);
    assert.doesNotMatch(source, /read\('heldAt'/);
  });

  test('the README\'s API section documents heldAt', () => {
    const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const start = readme.indexOf('\n## The feed, the record and the badge\n');
    assert.ok(start >= 0);
    const section = flat(readme.slice(start, readme.indexOf('\n## ', start + 1)));
    assert.match(section, /`heldAt`: the time of the hold in unix seconds/);
    assert.match(section, /`null` otherwise: never held, or the hold has ended in a roll forward or a close/);
    for (const where of ['`labels.listings[<id>]`', '`notCounted.listings`', '`sameRepository`']) assert.ok(section.includes(where), where);
    assert.match(section, /A held listing is not in `\/api\/feed`/);
    assert.match(section, /`state` is the chain's/);
    assert.match(section, /`labels\.live`[^.]*is false while `heldAt` is set/);
    assert.match(section, /"stake on hold since \*date\*"/);
    assert.match(section, /against a contract with no hold \(no `Held` event, no `heldAt` view\) every answer is as before/);
    assert.match(section, /lapsed and held listings are not in it/);
  });
});
