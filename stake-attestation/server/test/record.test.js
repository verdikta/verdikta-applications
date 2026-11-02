// Acceptance 3, the record mirror (design §4.1, §13.4, §14; node P4b1): GET /api/records/:hash
// answers the contract's recordByHash for the hash at the indexed block, field for field, read
// through the lens with the merged ABI (paged with recordPage when it is long), plus the indexed
// history of the record's listings. Only valid findings are published: every event of a claim
// that is not a valid finding (INVALID, DUPLICATE, pending, expired) is reduced to its ids, so
// its archive, keys, ciphertext, hunter and verdict appear nowhere in the answer.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { expectedJson, outputOf } from './helpers/abiJson.js';
import { mergedAbi } from './helpers/chain.js';
import { partitionRecord } from '../src/record/record.js';
import { fakeBuilder } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';
import {
  bcidOf, chainContext, ciphertextCidOf, commit, DAY, disclose, dispute, finalize, freshCommit, HOUR, increaseTime,
  judgeAndSettle, JUSTIFICATION, listing, reveal, revealedClaim, settle, siteFor, verdict,
} from './helpers/scenario.js';

describe('GET /api/records/:hash', () => {
  let ctx;
  let site;
  let api;
  let hash;
  let lateHash;
  let l1;
  let l2;
  let flagging;
  let flaggedClaim;
  let flaggedPending;
  const valid = {};
  const unpublished = {};

  before(async () => {
    ctx = await chainContext();
    const [h1, h2, h3, h4] = ctx.hunters;
    const baseCommit = freshCommit();
    // one artifact, two stakes on it: the project's, and another wallet's, which does not count
    l1 = await listing(ctx, { spec: { baseCommit }, escrowWei: 5n * 10n ** 18n });
    l2 = await listing(ctx, { maker: ctx.other, proof: ctx.maker.address, spec: { baseCommit }, stake: { fixWindowDays: 1, disclosureGraceHours: 24 } });
    assert.equal(l1.artifactHash, l2.artifactHash);
    hash = l1.artifactHash;

    valid.high = await revealedClaim(ctx, h1, l1.listingId);
    await judgeAndSettle(ctx, valid.high, 'HIGH');
    unpublished.invalid = await revealedClaim(ctx, h2, l1.listingId);
    await judgeAndSettle(ctx, unpublished.invalid, 'INVALID');
    unpublished.duplicate = await revealedClaim(ctx, h3, l1.listingId);
    await judgeAndSettle(ctx, unpublished.duplicate, 'DUPLICATE');
    // a dispute that overturns MEDIUM to HIGH
    valid.disputed = await revealedClaim(ctx, h4, l1.listingId);
    await verdict(ctx, valid.disputed, 'MEDIUM');
    await finalize(ctx, valid.disputed);
    await dispute(ctx, valid.disputed);
    await verdict(ctx, valid.disputed, 'HIGH', { dispute: true });
    await finalize(ctx, valid.disputed);
    await settle(ctx, valid.disputed);
    unpublished.undisclosed = await commit(ctx, h1, l1.listingId);
    await increaseTime(ctx, HOUR + 1);
    await (await ctx.sa.connect(ctx.other).expire(unpublished.undisclosed)).wait();
    unpublished.pending = await revealedClaim(ctx, h2, l1.listingId);

    // on the stake that does not count: a claim, shown apart
    unpublished.apart = await commit(ctx, h3, l2.listingId);

    // a stake of its own: a flagged claim the maker released, judged INVALID; a flagged pending one
    flagging = await listing(ctx, { stake: { fixWindowDays: 1, disclosureGraceHours: 24 } });
    flaggedClaim = await commit(ctx, h3, flagging.listingId);
    await disclose(ctx, h3, flaggedClaim);
    await (await ctx.sa.connect(ctx.maker).flagBadDisclosure(flaggedClaim)).wait();
    await (await ctx.sa.connect(ctx.maker).release(flaggedClaim)).wait();
    await reveal(ctx, h3, flaggedClaim);
    await judgeAndSettle(ctx, flaggedClaim, 'INVALID');
    flaggedPending = await commit(ctx, h4, flagging.listingId);
    await disclose(ctx, h4, flaggedPending);
    await (await ctx.sa.connect(ctx.maker).flagBadDisclosure(flaggedPending)).wait();

    // another artifact: a late finding after its stake closed
    const closed = await listing(ctx);
    lateHash = closed.artifactHash;
    await (await ctx.sa.connect(ctx.maker).close(closed.listingId)).wait();
    valid.late = await revealedClaim(ctx, h4, closed.listingId, { late: true });
    await judgeAndSettle(ctx, valid.late, 'LOW');

    site = siteFor(ctx);
    await site.sync();
    // a commit after the indexed block: the mirror is the indexed block's, not the latest
    await commit(ctx, h1, l1.listingId);
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  const get = async (h) => (await api.get(`/api/records/${h}`)).json();

  test('mirrors recordByHash at the indexed block, field for field', async () => {
    const body = await get(hash);
    const block = site.store.state.cursor.number;
    assert.deepEqual(body.block, { number: block, hash: site.store.state.cursor.hash, timestamp: site.store.state.cursor.timestamp });
    const onchain = await ctx.sa.recordByHash(hash, { blockTag: block });
    // field for field, of what counts: recordByHash combines every listing of the hash
    const json = expectedJson(onchain, outputOf(mergedAbi(ctx.hre), 'recordByHash'));
    assert.equal(json.listingCount, '2');
    assert.deepEqual(body.record, partitionRecord(json, new Set([String(l1.listingId)])).record);
    assert.equal(body.artifactHash, hash);
    // and the record is the indexed block's: one more claim is on-chain now
    const latest = await ctx.sa.recordByHash(hash);
    assert.equal(latest.history.claims, onchain.history.claims + 1n);
  });

  test('the record says what the scenario did', async () => {
    const { record, notCounted } = await get(hash);
    assert.equal(record.listingCount, '1');
    assert.deepEqual(record.active, [String(l1.listingId)]);
    assert.deepEqual(notCounted.listings.map((x) => [x.listingId, x.maker, x.reason]), [[String(l2.listingId), ctx.other.address, 'PROOF_NAMES_ANOTHER_ADDRESS']]);
    assert.deepEqual(record.findings.map((f) => f.claimId), [String(valid.high), String(valid.disputed)]);
    assert.deepEqual(record.findings.map((f) => f.outcome), ['HIGH', 'HIGH']);
    assert.equal(record.findings[1].dispute, 'Overturned');
    assert.equal(record.findings[0].bcid, bcidOf(valid.high));
    assert.equal(record.history.claims, '6');
    assert.equal(record.history.undisclosed, '1');
    assert.equal(record.history.disputes, '1');
    const flagged = (await get(flagging.artifactHash)).record;
    assert.deepEqual(flagged.flags.map((f) => [f.claimId, f.outcome, f.state]), [
      [String(flaggedClaim), 'INVALID', 'Settled'],
      [String(flaggedPending), 'INVALID', 'Committed'],
    ]);
    assert.equal(flagged.history.released, '1');
    assert.equal(record.history.disputesOverturned, '1');
  });

  test('a long record is read in pages and assembled to the same answer', async () => {
    const paged = siteFor(ctx, { env: { SA_RECORD_LISTING_PAGE: '1', SA_RECORD_ITEM_PAGE: '1' } });
    try {
      await paged.sync();
      const block = paged.store.state.cursor.number;
      const full = (await site.record(hash, { blockTag: block })).record;
      const pages = (await paged.record(hash)).record;
      assert.deepEqual(pages, full);
      assert.equal(pages.findings.length, 2);
      assert.equal((await paged.record(flagging.artifactHash)).record.flags.length, 2);
    } finally {
      paged.close();
    }
  });

  test('the indexed history: every event of the record\'s listings, in order, each placed by its listing', async () => {
    const { history } = await get(hash);
    const ids = new Set([String(l1.listingId)]);
    const stored = site.store.state.events;
    const listingOfClaim = new Map(stored.filter((e) => e.name === 'Committed' || e.name === 'LateClaim').map((e) => [e.args.claimId, e.args.listingId]));
    const place = (e) => e.args.listingId ?? listingOfClaim.get(e.args.claimId);
    const expected = stored.filter((e) => ids.has(place(e)));
    assert.deepEqual(history.events.map((e) => [e.blockNumber, e.logIndex, e.name, e.listingId]), expected.map((e) => [e.blockNumber, e.logIndex, e.name, place(e)]));
    assert.ok(history.events.some((e) => e.name === 'Opened' && e.listingId === String(l1.listingId)));
    assert.equal(history.events.some((e) => e.listingId === String(l2.listingId)), false);
    assert.ok((await get(hash)).notCounted.events.some((e) => e.name === 'Opened' && e.listingId === String(l2.listingId)), 'the listing that does not count has its events apart');
    assert.ok(history.events.some((e) => e.name === 'EvaluationRequested' && e.claimId === String(valid.high)), 'events with only a claim id are placed by it');
    assert.deepEqual(history.publishedClaims, [String(valid.high), String(valid.disputed)]);
    const lastSettled = Math.max(...(await get(hash)).record.findings.map((f) => Number(f.settledAt)));
    assert.equal(history.lastValidFindingAt, lastSettled);
    assert.equal(history.daysSinceLastValidFinding, Math.floor((site.store.state.cursor.timestamp - lastSettled) / DAY));
  });

  test('only valid findings are published: a valid finding\'s events in full, every other claim\'s as ids only', async () => {
    const body = await get(hash);
    const text = JSON.stringify(body);
    const events = [...body.history.events, ...body.notCounted.events];
    const of = (id) => events.filter((e) => e.claimId === String(id));

    const revealed = of(valid.high).find((e) => e.name === 'Revealed');
    assert.equal(revealed.args.bcid, bcidOf(valid.high));
    assert.equal(of(valid.high).find((e) => e.name === 'Judged').args.justificationCid, JUSTIFICATION);
    assert.equal(of(valid.high).find((e) => e.name === 'Disclosed').args.ciphertextCid, ciphertextCidOf(valid.high));
    assert.equal(of(valid.high).find((e) => e.name === 'Committed').args.hunter, ctx.hunters[0].address);

    for (const [why, id] of Object.entries(unpublished)) {
      assert.ok(of(id).length > 0, why);
      for (const e of of(id)) {
        assert.equal(e.redacted, true, `${why}: ${e.name}`);
        assert.ok(Object.keys(e.args).every((k) => k === 'claimId' || k === 'listingId'), `${why}: ${e.name} keeps its ids only`);
      }
      assert.equal(text.includes(bcidOf(id)), false, `${why}: no archive`);
      assert.equal(text.includes(ciphertextCidOf(id)), false, `${why}: no ciphertext`);
    }
    assert.equal(text.includes(ctx.hunters[1].address), false, 'the hunter of only unpublished claims is not named');
  });

  test('a late finding is published under `later`', async () => {
    const body = await get(lateHash);
    assert.equal(body.record.findings.length, 1);
    assert.equal(body.record.findings[0].late, true);
    assert.equal(body.record.findings[0].outcome, 'LOW');
    assert.equal(body.record.history.lateClaims, '1');
    assert.deepEqual(body.history.publishedClaims, [String(valid.late)]);
    assert.ok(body.history.events.some((e) => e.name === 'LateClaim' && e.claimId === String(valid.late) && e.args.hunter === ctx.hunters[3].address));
    const onchain = await ctx.sa.recordByHash(lateHash, { blockTag: body.block.number });
    assert.deepEqual(body.record, expectedJson(onchain, outputOf(mergedAbi(ctx.hre), 'recordByHash')));
  });

  test('labels per listing ride along (computed off-chain)', async () => {
    const body = await get(hash);
    assert.deepEqual(Object.keys(body.labels.listings), [String(l1.listingId)]);
    assert.equal(body.labels.listings[String(l1.listingId)].invited, false);
  });

  test('an unknown hash is 404, a malformed one 400', async () => {
    const unknown = await api.get(`/api/records/0x${'ab'.repeat(32)}`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'RECORD_NOT_FOUND');
    for (const bad of ['0x1234', `0x${'zz'.repeat(32)}`, 'abc']) {
      const res = await api.get(`/api/records/${bad}`);
      assert.equal(res.status, 400, bad);
      assert.equal((await res.json()).error, 'BAD_HASH');
    }
  });

  test('a hash whose only listing was never funded has no record', async () => {
    const unfunded = await listing(ctx, { fund: false });
    await site.sync();
    assert.equal((await api.get(`/api/records/${unfunded.artifactHash}`)).status, 404);
  });
});
