// Node P35: what a hunter met in the claim test (items 3 and 4). Two listings of one repository at two commits, with
// nothing that relates them; and the disclosure key as a bytes32 in the feed but an age recipient (age1…) in the
// listing archive, with nothing that says they are one key. So, fields added beside the old ones, every old field as
// it was:
//
//   GET /api/feed            each entry's sameRepository: every other listing the site indexed whose artifact.repo is
//                            the entry's, exactly as the Listed event stored it, that opened, at any commit and in
//                            whatever state it is in now; and its disclosureRecipient, the age recipient of the same
//                            32 bytes as disclosureKey
//   GET /api/records/:hash   sameRepository: the listings of the record's repository that the record does not list,
//                            its other versions (the record's own are its listings, counted or apart)
//
// A listing that never opened is in neither, as it is in no feed or record: anyone can make one for the gas of list().
//
// Each related listing: its id, artifact hash and artifact (the commit), its state and lapsed at the answer's block, as
// getListing has them there, whether it counts (the record's own rule), and its page on the site.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { disclosureBytes32Of } from '@verdikta/stake-attestation-shared/disclosure-key';

import { ENUMS } from '../src/chain/abi.js';
import { codeReview } from '../src/common.js';
import { fakeBuilder } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';
import { chainContext, listing, replay, siteFor } from './helpers/scenario.js';

const AGENTS = fs.readFileSync(new URL('../../client/public/agents.txt', import.meta.url), 'utf8');

// what a feed entry and a record answer held before node P35: none of it changes
const FEED_ENTRY_BEFORE = [
  'listingId', 'artifactHash', 'artifact', 'maker', 'image', 'scope', 'documents', 'archive', 'awards', 'lowestClassCounted', 'bondWei',
  'windows', 'openedAt', 'fundedUntil', 'daysOpen', 'claimsSoFar', 'escrowRemainingWei', 'owedWei', 'valueAtRiskUsd', 'invited', 'labels',
  'listingCid', 'disputeCid', 'disclosureKey', 'control',
];
const RECORD_BEFORE = [
  'artifactHash', 'block', 'record', 'labels', 'history', 'integrity', 'fresh', 'staleReason', 'artifact', 'fork', 'control', 'documents',
  'notCounted', 'badge',
];
// heldAt came with the maker's hold (node P40; test/hold.test.js), added the same way: every field before it as it was
const RELATED_KEYS = ['listingId', 'artifactHash', 'artifact', 'state', 'lapsed', 'heldAt', 'counted', 'page'].sort();

const byId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const hex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;

/** The names agents.txt lists, four spaces in, under the line that starts with `heading`, up to the next "- GET". */
function listedFields(heading) {
  const start = AGENTS.indexOf(heading);
  assert.ok(start >= 0, `agents.txt has "${heading}"`);
  const rest = AGENTS.slice(start + heading.length);
  const block = rest.slice(0, rest.search(/\n- GET /));
  return [...block.matchAll(/^ {4}([a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)?) {2,}\S/gm)].map((m) => m[1]);
}

describe('related listings and the two encodings of the disclosure key', () => {
  let ctx;
  let site;
  let api;
  const l = {};
  const REPO = 'https://github.com/acme/vault';

  before(async () => {
    ctx = await chainContext();
    l.a = await listing(ctx);
    l.b = await listing(ctx);
    l.listed = await listing(ctx, { fund: false });
    l.closed = await listing(ctx);
    await (await ctx.sa.connect(ctx.maker).close(l.closed.listingId)).wait();
    // the same version listed again from another wallet: the project names ctx.maker, so it does not count
    l.replayed = { ...l.a, ...(await replay(ctx, l.a, { from: ctx.other })) };
    // and listed once more, never funded: it takes no claims and has no record, so it is in no list
    const rc = await (await ctx.sa.connect(ctx.hunters[0]).list(l.a.params, l.a.listingCid, l.a.disputeCid, l.a.knownIssueIds)).wait();
    l.unopened = { ...l.a, listingId: rc.logs.map((x) => ctx.sa.interface.parseLog(x)).find((e) => e?.name === 'Listed').args.listingId };
    l.otherRepo = await listing(ctx, { spec: { repo: 'https://github.com/acme/other' } });
    // grouped exactly as stored: another spelling of the URL is another repository here
    l.spelled = await listing(ctx, { spec: { repo: `${REPO}.git` } });
    for (const x of [l.a, l.b, l.listed, l.closed, l.replayed, l.unopened]) assert.equal(x.spec.repo, REPO);

    site = siteFor(ctx);
    await site.sync();
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  const feed = async () => (await api.get('/api/feed')).json();
  const entryOf = (body, x) => body.listings.find((e) => e.listingId === String(x.listingId));
  const ids = (list) => list.map((x) => x.listingId);

  test('a feed entry names every other listing of its repository that opened, at any commit and in any state, oldest first', async () => {
    const body = await feed();
    const a = entryOf(body, l.a);
    assert.ok(a, 'listing a is in the feed');
    assert.deepEqual(ids(a.sameRepository), [l.b, l.closed, l.replayed].map((x) => String(x.listingId)).sort(byId));
    assert.deepEqual(ids(entryOf(body, l.b).sameRepository), [l.a, l.closed, l.replayed].map((x) => String(x.listingId)).sort(byId));
    // never opened: in no list, whatever its repository
    for (const e of body.listings) for (const x of [l.listed, l.unopened]) assert.equal(ids(e.sameRepository).includes(String(x.listingId)), false);
    assert.equal((await ctx.sa.getListing(l.unopened.listingId)).state, 0n, 'Listed');
    // another repository, and another spelling of this one, have none of these
    assert.deepEqual(entryOf(body, l.otherRepo).sameRepository, []);
    for (const e of body.listings) assert.equal(ids(e.sameRepository).includes(String(l.otherRepo.listingId)), false, `listing ${e.listingId}`);
    for (const e of body.listings) assert.equal(ids(e.sameRepository).includes(String(l.spelled.listingId)), false, `listing ${e.listingId}`);
    for (const e of body.listings) assert.equal(ids(e.sameRepository).includes(e.listingId), false, 'never itself');
  });

  test('each related listing: its id, hash, commit, state and lapsed as getListing has them at the answer\'s block, whether it counts, its page', async () => {
    const body = await feed();
    const a = entryOf(body, l.a);
    const blockTag = body.block.number;
    const states = {};
    for (const x of a.sameRepository) {
      assert.deepEqual(Object.keys(x).sort(), RELATED_KEYS);
      const onchain = await ctx.sa.getListing(x.listingId, { blockTag });
      assert.equal(x.state, ENUMS.ListingState[Number(onchain.state)]);
      assert.equal(x.lapsed, await ctx.sa.isLapsed(x.listingId, { blockTag }));
      assert.equal(x.artifactHash, onchain.artifactHash);
      assert.equal(x.artifact.repo, REPO);
      assert.equal(x.page, `/#/fund/${x.listingId}`);
      states[x.listingId] = x.state;
      // counted as the record of its hash counts it
      const res = await api.get(`/api/records/${x.artifactHash}`);
      const rec = res.status === 200 ? await res.json() : null;
      assert.equal(x.counted, Boolean(rec?.record.listings.some((r) => String(r.listingId) === x.listingId)), `listing ${x.listingId}`);
    }
    assert.equal(states[l.b.listingId], 'Open');
    assert.equal(states[l.closed.listingId], 'Closed');
    assert.equal(states[l.replayed.listingId], 'Open');
    const of = (x) => a.sameRepository.find((r) => r.listingId === String(x.listingId));
    assert.equal(of(l.b).artifact.baseCommit, l.b.spec.baseCommit);
    assert.equal(of(l.closed).artifact.baseCommit, l.closed.spec.baseCommit);
    assert.equal(of(l.replayed).artifact.baseCommit, l.a.spec.baseCommit, 'the same version, listed again');
    assert.equal(of(l.replayed).artifactHash, a.artifactHash);
    assert.deepEqual(of(l.b).artifact, entryOf(body, l.b).artifact, 'the artifact as the feed shows it');
    assert.equal(of(l.b).counted, true);
    assert.equal(of(l.replayed).counted, false, 'the project names another wallet');
  });

  test('a feed entry adds disclosureRecipient: the same 32 bytes as disclosureKey, as the age recipient the archive names', async () => {
    const body = await feed();
    for (const x of [l.a, l.b, l.otherRepo]) {
      const e = entryOf(body, x);
      const onchain = await ctx.sa.getListing(x.listingId, { blockTag: body.block.number });
      assert.equal(e.disclosureKey, onchain.disclosureKey, 'the old field, as it was');
      assert.equal(e.disclosureRecipient, x.spec.stake.disclosureKey, 'the archive\'s age recipient');
      assert.equal(disclosureBytes32Of(e.disclosureRecipient), e.disclosureKey.toLowerCase());
      assert.equal(hex(codeReview.parseDisclosureKey(e.disclosureRecipient)), e.disclosureKey.toLowerCase(), '@verdikta/common reads it as the same key');
    }
  });

  test('only fields are added: a feed entry and a record answer keep every field they had', async () => {
    const body = await feed();
    // pendingClaims and headClaim came later (tester bounty 400), added the same way
    for (const e of body.listings) assert.deepEqual(Object.keys(e).sort(), [...FEED_ENTRY_BEFORE, 'disclosureRecipient', 'sameRepository', 'pendingClaims', 'headClaim'].sort());
    const rec = await (await api.get(`/api/records/${l.a.artifactHash}`)).json();
    assert.deepEqual(Object.keys(rec).sort(), [...RECORD_BEFORE, 'sameRepository'].sort());
    // the feed's apart entries are as they were
    for (const e of body.notCounted) assert.deepEqual(Object.keys(e).sort(), ['listingId', 'artifactHash', 'artifact', 'maker', 'reason', 'detail'].sort());
  });

  test('a record names the listings of its repository that it does not list: its other versions', async () => {
    const rec = await (await api.get(`/api/records/${l.a.artifactHash}`)).json();
    assert.deepEqual(ids(rec.sameRepository), [l.b, l.closed].map((x) => String(x.listingId)).sort(byId));
    const own = [...rec.record.listings, ...rec.notCounted.listings].map((x) => String(x.listingId)).sort(byId);
    assert.deepEqual(own, [l.a, l.replayed].map((x) => String(x.listingId)).sort(byId));
    const body = await feed();
    // the same items the feed gives for listing a, but those on the record
    assert.deepEqual(rec.sameRepository, entryOf(body, l.a).sameRepository.filter((x) => !own.includes(x.listingId)));
    const other = await (await api.get(`/api/records/${l.otherRepo.artifactHash}`)).json();
    assert.deepEqual(other.sameRepository, []);
  });

  test('agents.txt lists the new fields, and every field it lists for a feed entry or a record is one the API answers with', async () => {
    const body = await feed();
    const entryFields = listedFields('Each entry of `listings`:');
    for (const name of ['disclosureKey', 'disclosureRecipient', 'sameRepository']) assert.ok(entryFields.includes(name), `agents.txt lists ${name}`);
    const keys = new Set(body.listings.flatMap((e) => Object.keys(e)));
    for (const name of entryFields) assert.ok(keys.has(name), `${name} is a field of a feed entry`);
    const rec = await (await api.get(`/api/records/${l.a.artifactHash}`)).json();
    const recordFields = listedFields('- GET https://verifiers.verdikta.org/api/records/<artifactHash>');
    assert.ok(recordFields.includes('sameRepository'), 'agents.txt lists the record\'s sameRepository');
    for (const name of recordFields) {
      const [top, inner] = name.split('.');
      assert.ok(Object.hasOwn(rec, top), `${top} is a field of a record answer`);
      if (inner) assert.ok(Object.hasOwn(rec[top], inner), `${name} is a field of a record answer`);
    }
  });
});
