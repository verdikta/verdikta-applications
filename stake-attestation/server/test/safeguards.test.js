// Node P18: the site's side of the settlement safeguards (design §13.2, errata E7, E8 and E9).
// - E9: the keeper calls confirm(claimId) on a Judged claim that awaits its confirmation while the
//   lens's confirmWindow is open, read first and simulated first, one transaction in flight; again
//   after a round with no verdict, until the deadline; on by default, SA_KEEPER_CONFIRM=off turns it off.
// - E7: the keeper finalizes every dispute-panel round (the maker's, a confirmation, an appeal) and
//   settles from the lens's settleableAt, so it never settles an INVALID inside its appeal window,
//   whoever its key is.
// - The indexer stores the new events, and the projection folds each claim's round kind, appeal
//   window, confirmation state and deadline, a narrow INVALID with its bond, and each listing's
//   floor and size (read once from the chain at its Listed block, and the program values from the
//   owner's setter events).
// - The record mirror shows the appeals, the confirmations and the narrow INVALIDs by result, from
//   the contract's recordByHash.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { project } from '../src/site/projection.js';
import {
  chainContext, commit, disclose, dispute, finalize, HOUR, increaseTime, JUSTIFICATION, keeperTransactions, latestTimestamp, listing,
  reveal, revealedClaim, settle, siteFor, tmpDir, verdict,
} from './helpers/scenario.js';

const ClaimState = ['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed'];
const DisputeKind = ['None', 'Maker', 'Confirmation', 'Appeal'];
const DisputeResult = ['None', 'Pending', 'Held', 'Overturned', 'NoVerdict'];
const stateOf = async (ctx, claimId) => ClaimState[Number((await ctx.sa.getClaim(claimId)).state)];
const THRESHOLD = 500_001n;
const FLOOR = 250_000n;
// 40 points of valid mass on HIGH: INVALID, and inside a band whose floor is 25 points
const NARROW = [600_000n, 0n, 0n, 0n, 400_000n, 0n];
const DEEP = [900_000n, 0n, 0n, 0n, 100_000n, 0n];
const APPEAL_GAS = 12_000_000;

async function cycle(site) {
  await site.sync();
  return site.keep();
}
const actions = (r) => r.sent.map((s) => [s.action, s.claimId]);

/** The owner sets the program values the next list() copies. */
async function program(ctx, { size, floor } = {}) {
  if (size !== undefined) await (await ctx.sa.connect(ctx.owner).setConfirmAboveWei(size)).wait();
  if (floor !== undefined) await (await ctx.sa.connect(ctx.owner).setNarrowInvalidFloor(floor)).wait();
}

/** A listing whose every counted award waits for a confirmation (the contract's default size, 0). */
async function confirmedListing(ctx, opts = {}) {
  await program(ctx, { size: 0n });
  const l = await listing(ctx, opts);
  await program(ctx, { size: 2n ** 256n - 1n }); // the next listing, of another test, is as before
  return l;
}

/** The (mock) aggregator's answer for the claim's open round: any vector. */
async function scriptVector(ctx, claimId, v, { dispute: panel = false } = {}) {
  const c = await ctx.sa.getClaim(claimId);
  await (await ctx.aggregator.scriptResult(panel ? c.disputeRequestId : c.requestId, v, JUSTIFICATION)).wait();
}

async function appeal(ctx, claimId, hunter) {
  const { listingId } = await ctx.sa.getClaim(claimId);
  const fee = await ctx.sa.disputeFee(listingId);
  await (await ctx.sa.connect(hunter).appeal(claimId, { value: fee, gasLimit: APPEAL_GAS })).wait();
}

async function untilAt(ctx, at) {
  const now = BigInt(await latestTimestamp(ctx));
  if (now < BigInt(at)) await increaseTime(ctx, Number(BigInt(at) - now));
}

describe('the keeper calls confirm (erratum E9)', () => {
  test('a counted award above the listing\'s size: nothing inside the dispute window, confirm at its end, the panel\'s round finalized, settled at once', async () => {
    const ctx = await confirmedListingContext();
    const { listingId } = await confirmedListing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const site = siteFor(ctx);
    try {
      await verdict(ctx, claimId, 'HIGH');
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(claimId)]]);
      assert.deepEqual((await cycle(site)).sent, [], 'the dispute window is open: the maker\'s dispute would be the confirmation');
      const [opensAt, deadline] = await ctx.sa.confirmWindow(claimId);
      const { disputeWindow, revealWindow, escrowWei } = await ctx.sa.getListing(listingId);
      assert.equal(deadline - opensAt, revealWindow);
      assert.equal(await ctx.sa.settleableAt(claimId), deadline, 'settle waits for the confirmation');
      await increaseTime(ctx, Number(disputeWindow) - 60);
      assert.deepEqual((await cycle(site)).sent, [], 'a minute to go');
      await untilAt(ctx, opensAt);

      const fee = await ctx.sa.disputeFee(listingId);
      assert.deepEqual(actions(await cycle(site)), [['confirm', String(claimId)]]);
      const c = await ctx.sa.getClaim(claimId);
      assert.equal(ClaimState[Number(c.state)], 'Disputed');
      assert.equal(DisputeKind[Number(c.disputeKind)], 'Confirmation');
      assert.equal((await ctx.sa.getListing(listingId)).escrowWei, escrowWei - fee, 'the escrow paid the round');
      assert.deepEqual((await cycle(site)).sent, [], 'the confirmation round is open');

      await verdict(ctx, claimId, 'HIGH', { dispute: true });
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(claimId)]]);
      assert.equal(DisputeResult[Number((await ctx.sa.getClaim(claimId)).dispute)], 'Held');
      assert.deepEqual(actions(await cycle(site)), [['settle', String(claimId)]], 'the panel\'s verdict is final: settled at once');
      assert.equal(await stateOf(ctx, claimId), 'Settled');
      assert.deepEqual((await cycle(site)).sent, []);
      const txs = await keeperTransactions(ctx);
      assert.deepEqual(txs.map((t) => [t.fn, t.status]), [[`finalize(${claimId})`, 1], [`confirm(${claimId})`, 1], [`finalize(${claimId})`, 1], [`settle(${claimId})`, 1]], 'nothing the keeper sent reverted');
    } finally {
      site.close();
    }
  });

  test('a confirmation round with no verdict: confirm again until the deadline; from the deadline, with no round open, settle pays the first verdict', async () => {
    const ctx = await confirmedListingContext();
    const { listingId } = await confirmedListing(ctx, { escrowWei: 10n ** 19n });
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const site = siteFor(ctx);
    try {
      await verdict(ctx, claimId, 'MEDIUM');
      await cycle(site);
      const [opensAt, deadline] = await ctx.sa.confirmWindow(claimId);
      await untilAt(ctx, opensAt);
      assert.deepEqual(actions(await cycle(site)), [['confirm', String(claimId)]]);
      await increaseTime(ctx, 301); // the mock aggregator's responseTimeoutSeconds is 300
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(claimId)]]);
      const failed = await ctx.sa.getClaim(claimId);
      assert.equal(DisputeResult[Number(failed.dispute)], 'NoVerdict');
      assert.equal(ClaimState[Number(failed.state)], 'Judged');
      assert.deepEqual(actions(await cycle(site)), [['confirm', String(claimId)]], 'again, while the window is open');
      assert.equal((await ctx.sa.getListing(listingId)).confirmationRounds, 2n);
      await increaseTime(ctx, 301);
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(claimId)]]);

      // the window closes: confirm would revert, so it is never sent; settle waits for the deadline
      await untilAt(ctx, deadline - 30n);
      const r = await cycle(site);
      assert.deepEqual(actions(r), [['confirm', String(claimId)]], 'a round may still start before the deadline');
      await increaseTime(ctx, 301);
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(claimId)]]);
      assert.ok(BigInt(await latestTimestamp(ctx)) >= deadline);
      const hunter = ctx.hunters[0].address;
      const before = await ctx.hre.ethers.provider.getBalance(hunter);
      assert.deepEqual(actions(await cycle(site)), [['settle', String(claimId)]], 'from the deadline the first verdict pays');
      const l = await ctx.sa.getListing(listingId);
      assert.equal(await ctx.hre.ethers.provider.getBalance(hunter) - before, l.bondWei + l.awards[1], 'bond back plus the MEDIUM award');
      assert.equal(l.confirmationsNoVerdict, 1n);
      assert.ok((await keeperTransactions(ctx)).every((t) => t.status === 1), 'nothing the keeper sent reverted');
    } finally {
      site.close();
    }
  });

  test('SA_KEEPER_CONFIRM=off: no confirm is sent, and the claim settles from the confirmation deadline', async () => {
    const ctx = await confirmedListingContext();
    const { listingId } = await confirmedListing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const site = siteFor(ctx, { env: { SA_KEEPER_CONFIRM: 'off' } });
    try {
      assert.equal(site.status().keeper.confirm, false);
      await verdict(ctx, claimId, 'HIGH');
      await cycle(site);
      const [opensAt, deadline] = await ctx.sa.confirmWindow(claimId);
      await untilAt(ctx, opensAt);
      assert.deepEqual((await cycle(site)).sent, [], 'confirm is off');
      await untilAt(ctx, deadline);
      assert.deepEqual(actions(await cycle(site)), [['settle', String(claimId)]]);
      assert.equal((await ctx.sa.getListing(listingId)).confirmationsNoVerdict, 1n);
    } finally {
      site.close();
    }
    const on = siteFor(ctx);
    try {
      assert.equal(on.status().keeper.confirm, true, 'on by default');
    } finally {
      on.close();
    }
  });

  test('a maker\'s dispute inside the window is the confirmation: the keeper finalizes it and settles, and confirms nothing', async () => {
    const ctx = await confirmedListingContext();
    const { listingId } = await confirmedListing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const site = siteFor(ctx);
    try {
      await verdict(ctx, claimId, 'HIGH');
      await cycle(site);
      await dispute(ctx, claimId);
      assert.equal(DisputeKind[Number((await ctx.sa.getClaim(claimId)).disputeKind)], 'Maker');
      await verdict(ctx, claimId, 'HIGH', { dispute: true });
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(claimId)]]);
      assert.deepEqual(actions(await cycle(site)), [['settle', String(claimId)]]);
      const [, deadline] = await ctx.sa.confirmWindow(claimId);
      assert.equal(deadline, 0n);
      assert.equal((await ctx.sa.getListing(listingId)).confirmationRounds, 0n);
    } finally {
      site.close();
    }
  });

  test('an escrow below the fee: confirm would revert, so none is sent; the first verdict pays from the deadline, owed', async () => {
    const ctx = await confirmedListingContext();
    // the escrow holds exactly the top award: a CRITICAL settled first empties it
    const { listingId } = await confirmedListing(ctx);
    const [h1, h2] = ctx.hunters;
    const first = await commit(ctx, h1, listingId);
    const second = await commit(ctx, h2, listingId); // while the listing is Open
    await disclose(ctx, h1, first);
    await disclose(ctx, h2, second);
    await reveal(ctx, h1, first);
    const site = siteFor(ctx);
    try {
      await verdict(ctx, first, 'CRITICAL');
      await cycle(site);
      await dispute(ctx, first); // the maker's dispute is the confirmation: held, the escrow pays it all
      await verdict(ctx, first, 'CRITICAL', { dispute: true });
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(first)]]);
      assert.deepEqual(actions(await cycle(site)), [['settle', String(first)]]);
      const drained = await ctx.sa.getListing(listingId);
      assert.ok(drained.escrowWei < await ctx.sa.disputeFee(listingId), `escrow ${drained.escrowWei}`);

      await reveal(ctx, h2, second);
      await verdict(ctx, second, 'HIGH');
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(second)]]);
      const [opensAt, deadline] = await ctx.sa.confirmWindow(second);
      assert.ok(deadline > 0n, 'it awaits a confirmation');
      await untilAt(ctx, opensAt);
      await assert.rejects(ctx.sa.connect(ctx.other).confirm.staticCall(second), /escrow below fee/);
      assert.deepEqual((await cycle(site)).sent, [], 'confirm would revert: not sent');
      await untilAt(ctx, deadline);
      assert.deepEqual(actions(await cycle(site)), [['settle', String(second)]]);
      const c = await ctx.sa.getClaim(second);
      assert.equal(c.owedWei, (await ctx.sa.getListing(listingId)).awards[2], 'the whole award owed');
      assert.ok((await keeperTransactions(ctx)).every((t) => t.status === 1), 'nothing the keeper sent reverted');
    } finally {
      site.close();
    }
  });
});

describe('the keeper and the hunter\'s appeal (erratum E7)', () => {
  test('an appeal\'s round is finalized, and its verdict settles at once', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const [h] = ctx.hunters;
    const claimId = await revealedClaim(ctx, h, listingId);
    const site = siteFor(ctx);
    try {
      await verdict(ctx, claimId, 'INVALID');
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(claimId)]]);
      assert.deepEqual((await cycle(site)).sent, [], 'inside the appeal window');
      await appeal(ctx, claimId, h);
      assert.equal(await stateOf(ctx, claimId), 'Disputed');
      assert.deepEqual((await cycle(site)).sent, [], 'the appeal\'s round is open');
      await verdict(ctx, claimId, 'MEDIUM', { dispute: true });
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(claimId)]]);
      const c = await ctx.sa.getClaim(claimId);
      assert.equal(DisputeResult[Number(c.dispute)], 'Overturned');
      assert.equal(DisputeKind[Number(c.disputeKind)], 'Appeal');
      assert.deepEqual(actions(await cycle(site)), [['settle', String(claimId)]], 'overturned: the panel\'s outcome settles at once, with no confirmation');
      assert.equal(await stateOf(ctx, claimId), 'Settled');
      assert.equal((await ctx.sa.getListing(listingId)).appealsOverturned, 1n);
    } finally {
      site.close();
    }
  });

  test('an appeal\'s round with no verdict: finalized, then settle waits for the re-trigger window, never sooner', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const [h] = ctx.hunters;
    const claimId = await revealedClaim(ctx, h, listingId);
    const site = siteFor(ctx);
    try {
      await verdict(ctx, claimId, 'INVALID');
      await cycle(site);
      await appeal(ctx, claimId, h);
      await increaseTime(ctx, 301);
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(claimId)]]);
      const deadline = await ctx.sa.retriggerDeadline(claimId);
      assert.ok(deadline > 0n);
      assert.equal(await ctx.sa.settleableAt(claimId), deadline);
      const { disputeWindow } = await ctx.sa.getListing(listingId);
      await increaseTime(ctx, Number(disputeWindow) + HOUR); // past the appeal window: the re-trigger's still runs
      assert.deepEqual((await cycle(site)).sent, [], 'the hunter may still re-trigger the appeal');
      await untilAt(ctx, deadline);
      assert.deepEqual(actions(await cycle(site)), [['settle', String(claimId)]]);
      assert.equal((await ctx.sa.getListing(listingId)).appealsNoVerdict, 1n);
    } finally {
      site.close();
    }
  });

  test('a keeper whose key is the claim\'s hunter still settles only from settleableAt: it never waives the appeal', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const h = ctx.hunters[0];
    const claimId = await revealedClaim(ctx, h, listingId);
    const site = siteFor(ctx, { env: { SA_KEEPER_PRIVATE_KEY: ctx.keyOf(5) } });
    try {
      assert.equal(site.status().keeper.address, h.address);
      await verdict(ctx, claimId, 'INVALID');
      assert.deepEqual(actions(await cycle(site)), [['finalize', String(claimId)]]);
      // the hunter's own settle would pass now, and waive the appeal: the keeper does not send it
      await ctx.sa.connect(h).settle.staticCall(claimId);
      assert.deepEqual((await cycle(site)).sent, []);
      assert.deepEqual((await cycle(site)).sent, []);
      assert.equal(await stateOf(ctx, claimId), 'Judged');
      await untilAt(ctx, await ctx.sa.settleableAt(claimId));
      assert.deepEqual(actions(await cycle(site)), [['settle', String(claimId)]]);
    } finally {
      site.close();
    }
  });
});

describe('confirm keeps the keeper\'s idempotence', () => {
  async function dueForConfirm(ctx) {
    const { listingId } = await confirmedListing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    await verdict(ctx, claimId, 'HIGH');
    await finalize(ctx, claimId);
    const [opensAt] = await ctx.sa.confirmWindow(claimId);
    await untilAt(ctx, opensAt);
    return { listingId, claimId };
  }
  const crash = () => { throw Object.assign(new Error('the process died here'), { code: 'TEST_CRASH' }); };

  test('another caller confirms first: the keeper reads the claim on-chain and sends nothing', async () => {
    const ctx = await confirmedListingContext();
    const { claimId } = await dueForConfirm(ctx);
    const site = siteFor(ctx);
    try {
      await site.sync();
      await (await ctx.sa.connect(ctx.other).confirm(claimId, { gasLimit: APPEAL_GAS })).wait();
      const r = await site.keep();
      assert.deepEqual(r.sent, []);
      assert.deepEqual(await keeperTransactions(ctx), []);
    } finally {
      site.close();
    }
  });

  test('a crash after the confirm was recorded, before it was broadcast: it is broadcast on restart, once', async () => {
    const ctx = await confirmedListingContext();
    const { claimId, listingId } = await dueForConfirm(ctx);
    const dir = tmpDir();
    const first = siteFor(ctx, { dir, env: { SA_KEEPER_TX_TIMEOUT_MS: '200' }, keeperHooks: { beforeBroadcast: crash } });
    await first.sync();
    await assert.rejects(first.keep(), (e) => e.code === 'TEST_CRASH');
    assert.equal(first.store.state.keeper.inflight.action, 'confirm');
    first.close();
    const second = siteFor(ctx, { dir });
    try {
      const r = await second.keep();
      assert.deepEqual(r.sent.map((s) => [s.action, s.replaced]), [['confirm', true]]);
      assert.equal(await stateOf(ctx, claimId), 'Disputed');
      await second.keep();
      const txs = await keeperTransactions(ctx);
      assert.deepEqual(txs.map((t) => [t.fn, t.status]), [[`confirm(${claimId})`, 1]], 'one confirm, mined');
      assert.equal((await ctx.sa.getListing(listingId)).confirmationRounds, 1n);
    } finally {
      second.close();
    }
  });

  test('a confirm recorded with SA_KEEPER_CONFIRM on is not sent after a restart with it off', async () => {
    const ctx = await confirmedListingContext();
    const { claimId } = await dueForConfirm(ctx);
    const dir = tmpDir();
    const first = siteFor(ctx, { dir, keeperHooks: { beforeBroadcast: crash } });
    await first.sync();
    await assert.rejects(first.keep(), (e) => e.code === 'TEST_CRASH');
    first.close();
    const second = siteFor(ctx, { dir, env: { SA_KEEPER_CONFIRM: 'off' } });
    try {
      const r = await second.keep();
      assert.deepEqual(r.sent, []);
      assert.equal(second.status().keeper.last.status, 'dropped');
      assert.deepEqual(await keeperTransactions(ctx), []);
      assert.equal(await stateOf(ctx, claimId), 'Judged');
    } finally {
      second.close();
    }
  });
});

describe('the indexer and the projection', () => {
  test('store the new events, and fold the round kinds, the windows, the confirmations, a narrow INVALID with its bond and each listing\'s floor and size', async () => {
    const ctx = await chainContext();
    const [h1, h2, h3, h4] = ctx.hunters;
    const site = siteFor(ctx);
    try {
      // the program values: a band from 25 points, and every counted award confirmed
      await program(ctx, { size: 0n, floor: FLOOR });
      const banded = await listing(ctx, { escrowWei: 10n ** 19n });
      await program(ctx, { size: 2n ** 256n - 1n });
      const plain = await listing(ctx);

      // banded: a confirmed HIGH, an appealed INVALID that is held narrow, a deep INVALID the hunter waives
      const confirmed = await revealedClaim(ctx, h1, banded.listingId);
      await verdict(ctx, confirmed, 'HIGH');
      await finalize(ctx, confirmed);
      const [opensAt, deadline] = await ctx.sa.confirmWindow(confirmed);
      await site.sync();
      let p = project(site.store.state.events);
      const awaiting = p.claims.get(String(confirmed));
      assert.equal(awaiting.disputeKind, 'None');
      assert.deepEqual(awaiting.confirmation, { status: 'Awaiting', rounds: 0, opensAt: Number(opensAt), deadline: Number(deadline) });
      assert.equal(awaiting.appealDeadline, null, 'a valid outcome has no appeal window');
      await untilAt(ctx, opensAt);
      await (await ctx.sa.connect(ctx.other).confirm(confirmed, { gasLimit: APPEAL_GAS })).wait();
      await verdict(ctx, confirmed, 'HIGH', { dispute: true });
      await finalize(ctx, confirmed);
      await settle(ctx, confirmed);

      const narrow = await revealedClaim(ctx, h2, banded.listingId);
      await scriptVector(ctx, narrow, NARROW);
      await finalize(ctx, narrow);
      const judgedAt = Number((await ctx.sa.getClaim(narrow)).judgedAt);
      await site.sync();
      p = project(site.store.state.events);
      const { disputeWindow, revealWindow } = await ctx.sa.getListing(banded.listingId);
      assert.equal(p.claims.get(String(narrow)).appealDeadline, judgedAt + Number(disputeWindow));
      assert.equal(p.claims.get(String(narrow)).appealDeadline, Number(await ctx.sa.appealDeadline(narrow)), 'the lens\'s appeal window');
      assert.equal(p.claims.get(String(narrow)).confirmation, null);
      await appeal(ctx, narrow, h2);
      await increaseTime(ctx, 301);
      await finalize(ctx, narrow); // no verdict: the appeal's one re-trigger
      await site.sync();
      p = project(site.store.state.events);
      const failedAppeal = p.claims.get(String(narrow));
      assert.equal(failedAppeal.disputeKind, 'Appeal');
      assert.deepEqual(failedAppeal.appeal, { rounds: 1, result: 'NoVerdict', retriggerDeadline: Number(await ctx.sa.retriggerDeadline(narrow)) });
      assert.equal(failedAppeal.appealDeadline, null, 'appealed: the window is spent');
      await (await ctx.sa.connect(h2).retrigger(narrow, { value: await ctx.sa.retriggerTopUp(narrow), gasLimit: APPEAL_GAS })).wait();
      await scriptVector(ctx, narrow, NARROW, { dispute: true });
      await finalize(ctx, narrow);
      await settle(ctx, narrow);

      const deep = await revealedClaim(ctx, h3, banded.listingId);
      await scriptVector(ctx, deep, DEEP);
      await finalize(ctx, deep);
      await settle(ctx, deep, h3); // the hunter's own settle: the appeal waived

      // plain: an empty band, and no confirmation
      const plainInvalid = await revealedClaim(ctx, h4, plain.listingId);
      await scriptVector(ctx, plainInvalid, NARROW);
      await finalize(ctx, plainInvalid);
      await settle(ctx, plainInvalid, h4);
      await site.sync();

      const names = new Set(site.store.state.events.map((e) => e.name));
      for (const n of ['Appealed', 'ConfirmationRequested', 'ConfirmationRefunded', 'NarrowInvalid', 'NarrowInvalidFloorSet', 'ConfirmAboveWeiSet', 'Retriggered', 'DisputeFailed']) assert.ok(names.has(n), n);
      p = project(site.store.state.events);

      // each listing's floor and size: read once from the chain at its Listed block, and the owner's values then
      for (const l of [banded, plain]) {
        const onchain = await ctx.sa.getListing(l.listingId);
        const pl = p.listings.get(String(l.listingId));
        assert.equal(pl.narrowInvalidFloor, String(onchain.narrowInvalidFloor));
        assert.equal(pl.confirmAboveWei, String(onchain.confirmAboveWei));
        assert.equal(pl.terms.disputeWindow, Number(onchain.disputeWindow));
      }
      assert.equal(p.listings.get(String(banded.listingId)).narrowInvalidFloor, String(FLOOR));
      assert.equal(p.listings.get(String(banded.listingId)).confirmAboveWei, '0');
      assert.equal(p.listings.get(String(plain.listingId)).narrowInvalidFloor, String(FLOOR), 'the floor set before it');
      assert.equal(p.listings.get(String(plain.listingId)).confirmAboveWei, String(2n ** 256n - 1n));
      assert.deepEqual(p.program, { narrowInvalidFloor: String(FLOOR), confirmAboveWei: String(2n ** 256n - 1n) }, 'the values the next listing gets, from the setter events');

      const c1 = p.claims.get(String(confirmed));
      assert.equal(c1.disputeKind, 'Confirmation');
      assert.equal(c1.dispute, 'Held');
      assert.deepEqual(c1.confirmation, { status: 'Held', rounds: 1, opensAt: Number(opensAt), deadline: Number(deadline) });
      assert.equal(c1.bond, 'returned');
      const refunded = site.store.state.events.filter((e) => e.name === 'ConfirmationRefunded' && e.args.claimId === String(confirmed));
      assert.deepEqual(c1.confirmationRefunds, refunded.map((e) => ({ toOwedWei: e.args.toOwedWei, toEscrowWei: e.args.toEscrowWei, toMakerWei: e.args.toMakerWei })));

      const c2 = p.claims.get(String(narrow));
      assert.equal(c2.outcome, 'INVALID');
      assert.equal(c2.disputeKind, 'Appeal');
      assert.deepEqual(c2.appeal, { rounds: 2, result: 'Held', retriggerDeadline: null });
      assert.deepEqual(c2.narrowInvalid, { validMass: '400000' });
      assert.equal(c2.bond, 'returned', 'a narrow INVALID gets its bond back');
      assert.equal(c2.published, false, 'an INVALID is not published, narrow or not');

      const c3 = p.claims.get(String(deep));
      assert.equal(c3.narrowInvalid, null);
      assert.equal(c3.bond, 'forfeited');
      assert.equal(c3.appeal, null);
      assert.equal(c3.appealDeadline, null, 'settled: no window any more');

      const c4 = p.claims.get(String(plainInvalid));
      assert.equal(c4.narrowInvalid, null, 'the same vector under an empty band');
      assert.equal(c4.bond, 'forfeited');
      assert.equal(p.listings.get(String(plain.listingId)).narrowInvalidFloor === String(THRESHOLD), false);

      // the feed's events of an INVALID keep only its ids, the new ones too
      const feed = site.events({ limit: 1000 }).events;
      const narrowEvents = feed.filter((e) => e.claimId === String(narrow));
      assert.ok(narrowEvents.some((e) => e.name === 'NarrowInvalid' && e.redacted && e.args.validMass === undefined));
      assert.ok(narrowEvents.some((e) => e.name === 'Appealed' && e.redacted && e.args.wallet === undefined));
    } finally {
      site.close();
    }
  });

  test('a listing whose Listed block the indexer read has its terms; the projection is the same after a restart', async () => {
    const ctx = await chainContext();
    const dir = tmpDir();
    const l = await listing(ctx);
    const first = siteFor(ctx, { dir });
    await first.sync();
    const listed = first.store.state.events.find((e) => e.name === 'Listed' && e.args.listingId === String(l.listingId));
    assert.equal(listed.terms.revealWindow, Number((await ctx.sa.getListing(l.listingId)).revealWindow));
    const before = project(first.store.state.events).listings.get(String(l.listingId));
    first.close();
    const second = siteFor(ctx, { dir });
    try {
      await second.sync();
      assert.deepEqual(project(second.store.state.events).listings.get(String(l.listingId)), before);
      assert.equal(second.status().program.confirmAboveWei, null, 'the setter events came before SA_FROM_BLOCK: not known here');
    } finally {
      second.close();
    }
  });
});

describe('the record', () => {
  test('shows the appeals, the confirmations and the narrow INVALIDs by result, from the contract\'s record, and each listing\'s floor and size', async () => {
    const ctx = await chainContext();
    const [h1, h2, h3] = ctx.hunters;
    await program(ctx, { size: 0n, floor: FLOOR });
    const l = await listing(ctx, { escrowWei: 10n ** 19n });
    await program(ctx, { size: 2n ** 256n - 1n });
    const site = siteFor(ctx);
    try {
      const confirmed = await revealedClaim(ctx, h1, l.listingId);
      await verdict(ctx, confirmed, 'HIGH');
      await finalize(ctx, confirmed);
      await untilAt(ctx, (await ctx.sa.confirmWindow(confirmed))[0]);
      await (await ctx.sa.connect(ctx.other).confirm(confirmed, { gasLimit: APPEAL_GAS })).wait();
      await verdict(ctx, confirmed, 'MEDIUM', { dispute: true });
      await finalize(ctx, confirmed);
      await settle(ctx, confirmed);

      const appealed = await revealedClaim(ctx, h2, l.listingId);
      await scriptVector(ctx, appealed, NARROW);
      await finalize(ctx, appealed);
      await appeal(ctx, appealed, h2);
      await scriptVector(ctx, appealed, NARROW, { dispute: true });
      await finalize(ctx, appealed);
      await settle(ctx, appealed);

      const waived = await revealedClaim(ctx, h3, l.listingId);
      await scriptVector(ctx, waived, NARROW);
      await finalize(ctx, waived);
      await settle(ctx, waived, h3);

      await site.sync();
      const view = await site.record(l.artifactHash);
      const lens = await ctx.sa.recordByHash(l.artifactHash);
      const h = view.record.history;
      assert.equal(h.confirmationRounds, '1');
      assert.equal(h.confirmationsOverturned, '1');
      assert.equal(h.confirmationsHeld, '0');
      assert.equal(h.appeals, '1');
      assert.equal(h.appealsHeld, '1');
      assert.equal(h.narrowInvalid, '2');
      assert.deepEqual(h.outcomes, ['2', '0', '0', '1', '0', '0']);
      for (const k of ['confirmationRounds', 'confirmationsHeld', 'confirmationsOverturned', 'confirmationsNoVerdict', 'narrowInvalid', 'appeals', 'appealsHeld', 'appealsOverturned', 'appealsNoVerdict']) {
        assert.equal(h[k], String(lens.history[k]), `${k} is the contract's`);
      }
      const listed = view.record.listings[0];
      assert.equal(listed.narrowInvalidFloor, String(FLOOR));
      assert.equal(listed.confirmAboveWei, '0');
      assert.equal(view.record.findings[0].disputeKind, 'Confirmation');
      assert.equal(view.record.findings[0].dispute, 'Overturned');
    } finally {
      site.close();
    }
  });
});

/** A fresh deployment for a test that changes the program values. */
async function confirmedListingContext() {
  return chainContext();
}
