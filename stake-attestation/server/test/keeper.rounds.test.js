// The keeper's round actions on the v2 aggregator (SA_KEEPER_ROUNDS, on by default; the other keeper
// tests turn it off and draw their rounds themselves). A request only escrows the prepay; the keeper
// draws the jury through StakeAttestation.drawJury (the round's wallet earns the draw reward, never
// the keeper), closes the commit window after T+ with at least M commits, promotes from the close
// block + 2 (its own reward, withdrawn once it reaches SA_KEEPER_WITHDRAW_MIN_WEI), and finalize
// reads (and settles) a round past its deadline. Every call is simulated before it is sent, and the
// in-flight record names its target and round.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { testConfig } from './helpers/fixtures.js';
import {
  chainContext, increaseTime, keeperTransactions, latestTimestamp, listing, mine, revealedClaim, roundOf, siteFor,
} from './helpers/scenario.js';

const ROUNDS_ON = { SA_KEEPER_ROUNDS: 'on', SA_KEEPER_WITHDRAW_MIN_WEI: '1' };
const actions = (r) => r.sent.map((s) => [s.action, s.claimId === null ? null : String(s.claimId)]);
const ClaimState = ['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed'];

async function cycle(site) {
  await site.sync();
  return site.keep();
}

describe('the v2 round in flight', () => {
  test('draw, closeCommits after T+, promote from C+2 (the keeper\'s reward, withdrawn), then finalize past the deadline', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const c = await ctx.sa.getClaim(claimId);
    const aggId = c.requestId;
    const inflights = [];
    const site = siteFor(ctx, { env: ROUNDS_ON, keeperHooks: { beforeBroadcast: () => inflights.push(structuredClone(site.store.state.keeper.inflight)) } });
    try {
      await mine(ctx, 2); // block B+2: a call at the latest block may draw
      let r = await cycle(site);
      assert.deepEqual(actions(r), [['drawJury', String(claimId)]]);
      assert.equal(inflights.at(-1).to, ctx.address, 'drawJury goes through StakeAttestation');
      let round = await roundOf(ctx, aggId);
      assert.equal(round.phase, 3n, 'commit phase');
      const eff = (await ctx.aggregator.requestParams(aggId)).maxFee;
      assert.equal(await ctx.aggregator.ethOwed(c.evalWallet), 2n * eff, 'the wallet, the requester, earned the draw reward');
      assert.equal(await ctx.aggregator.ethOwed(ctx.keeperAddress), 0n);

      assert.deepEqual((await cycle(site)).sent, [], 'commits are the arbiters\'');
      await (await ctx.aggregator.scriptCommits(aggId, 5)).wait(); // M = 5, M+ = 6: still open
      assert.deepEqual((await cycle(site)).sent, [], 'T+ has not passed');
      const now = BigInt(await latestTimestamp(ctx));
      await increaseTime(ctx, Number(round.windowEnd - now + 1n));
      r = await cycle(site);
      assert.deepEqual(actions(r), [['closeCommits', String(claimId)]]);
      assert.equal(r.sent[0].aggId, aggId);
      assert.deepEqual([inflights.at(-1).to, inflights.at(-1).aggId], [ctx.aggregator.target, aggId], 'the record names the aggregator and the round');
      assert.equal((await roundOf(ctx, aggId)).phase, 4n);

      await mine(ctx, 2);
      r = await cycle(site);
      assert.deepEqual(actions(r), [['promote', String(claimId)], ['withdraw', null]]);
      assert.equal((await roundOf(ctx, aggId)).phase, 5n, 'reveal phase');
      assert.equal(await ctx.aggregator.ethOwed(ctx.keeperAddress), 0n, 'the promote reward was withdrawn');
      assert.equal(site.status().keeper.last.action, 'withdraw');

      round = await roundOf(ctx, aggId);
      await increaseTime(ctx, Number(round.deadline - BigInt(await latestTimestamp(ctx)) + 1n));
      r = await cycle(site);
      assert.deepEqual(actions(r), [['finalize', String(claimId)]], 'finalize settles the dead round itself, before any aggregator settle');
      assert.equal(ClaimState[Number((await ctx.sa.getClaim(claimId)).state)], 'RoundFailed');
      assert.equal((await roundOf(ctx, aggId)).phase, 8n, 'failed at the aggregator');
      assert.deepEqual((await cycle(site)).sent, []);

      // The aggregator's EvaluationFailed(bytes32, uint8) shares its name with StakeAttestation's, and
      // was emitted in the same transaction: the indexer reads the contract's address only.
      const failed = site.store.state.events.filter((e) => e.name === 'EvaluationFailed');
      assert.equal(failed.length, 1);
      assert.equal(failed[0].args.claimId, String(claimId));

      const txs = await keeperTransactions(ctx);
      assert.deepEqual(txs.map((t) => [t.fn, t.status]), [
        [`drawJury(${claimId})`, 1],
        [`aggregator.closeCommits(${aggId})`, 1],
        [`aggregator.promote(${aggId})`, 1],
        ['aggregator.withdrawEth()', 1],
        [`finalize(${claimId})`, 1],
      ]);
    } finally {
      site.close();
    }
  });

  test('a beacon listing\'s round is drawn twice: the stage, then the jury once the quorum is in', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx, { oracle: { ...testConfig().oracle, withBeacons: true } });
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const { requestId } = await ctx.sa.getClaim(claimId);
    const site = siteFor(ctx, { env: ROUNDS_ON });
    try {
      await mine(ctx, 2);
      assert.deepEqual(actions(await cycle(site)), [['drawJury', String(claimId)]]);
      assert.equal((await roundOf(ctx, requestId)).phase, 2n, 'the beacon stage');
      assert.deepEqual((await cycle(site)).sent, [], 'the quorum is not in: a second draw would revert');
      await (await ctx.aggregator.scriptBeacons(requestId, 2, false)).wait();
      assert.deepEqual(actions(await cycle(site)), [['drawJury', String(claimId)]]);
      assert.equal((await roundOf(ctx, requestId)).phase, 3n);
    } finally {
      site.close();
    }
  });

  test('SA_KEEPER_ROUNDS=off sends no round action; a reward below SA_KEEPER_WITHDRAW_MIN_WEI is left', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const off = siteFor(ctx, { env: { SA_KEEPER_ROUNDS: 'off' } });
    try {
      await mine(ctx, 2);
      assert.deepEqual((await cycle(off)).sent, []);
      assert.equal(off.status().keeper.rounds, false);
    } finally {
      off.close();
    }
    const { requestId } = await ctx.sa.getClaim(claimId);
    const site = siteFor(ctx, { env: { SA_KEEPER_ROUNDS: 'on', SA_KEEPER_WITHDRAW_MIN_WEI: (10n ** 18n).toString() } });
    try {
      assert.equal(site.status().keeper.rounds, true);
      assert.deepEqual(actions(await cycle(site)), [['drawJury', String(claimId)]]);
      await (await ctx.aggregator.scriptCommits(requestId, 6)).wait(); // M+: the window closes
      await mine(ctx, 2);
      assert.deepEqual(actions(await cycle(site)), [['promote', String(claimId)]]);
      assert.ok(await ctx.aggregator.ethOwed(ctx.keeperAddress) > 0n, 'below the threshold: kept at the aggregator');
    } finally {
      site.close();
    }
  });

  test('on by default', () => {
    const config = testConfig();
    assert.equal(config.keeper.rounds, true);
    assert.equal(config.keeper.withdrawMinWei, '100000000000000');
    assert.equal(config.oracle.minOracleFee, '0');
    assert.equal(config.oracle.withBeacons, false);
  });
});

describe('a node that answers a revert with its data, not an error', () => {
  // Hardhat with throwOnCallFailures off (the local round's chain did), or a proxy that flattens JSON-RPC
  // errors, answers eth_call on a reverting call with the revert's Error(string) bytes. Every call the
  // keeper simulates returns nothing, so only "0x" passes: a finalize that would revert "evaluation not
  // ready" is not due, and the draw behind it is sent.
  test('reads Error(string) data as a revert, so an undrawn round is drawn, not finalized forever', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const flattening = new Proxy(ctx.provider, {
      get(target, prop) {
        if (prop !== 'call') {
          const v = Reflect.get(target, prop, target);
          return typeof v === 'function' ? v.bind(target) : v;
        }
        return async (req) => {
          try {
            return await target.call(req);
          } catch (err) {
            if (typeof err?.data === 'string' && err.data.startsWith('0x') && err.data.length > 2) return err.data;
            throw err;
          }
        };
      },
    });
    // the wrapper really answers a revert with data
    const finalizeData = ctx.sa.interface.encodeFunctionData('finalize', [claimId]);
    assert.match(await flattening.call({ to: ctx.address, data: finalizeData }), /^0x08c379a0/);
    const site = siteFor(ctx, { env: ROUNDS_ON, provider: flattening });
    try {
      await mine(ctx, 2);
      const r = await cycle(site);
      assert.deepEqual(actions(r), [['drawJury', String(claimId)]]);
      assert.equal((await roundOf(ctx, (await ctx.sa.getClaim(claimId)).requestId)).phase, 3n, 'drawn: the commit phase');
    } finally {
      await site.close?.();
    }
  });
});
