// Acceptance 1, the keeper (node P4b1, erratum E4): finalize and settle are called when due and
// never before. finalize is due once the aggregator's round is over (a verdict, or a timeout,
// which leaves the claim RoundFailed); settle once the claim is Judged and settleableAt has come
// (at once for INVALID and DUPLICATE and after a dispute, after the dispute window for a valid
// verdict). expire only when SA_KEEPER_EXPIRE=on. The key comes from the environment only.
// Duplicates, retries and restarts: keeper.idempotence.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import {
  chainContext, commit, DAY, dispute, HOUR, increaseTime, keeperTransactions, listing, revealedClaim, siteFor, verdict,
} from './helpers/scenario.js';

const ClaimState = ['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed'];
const stateOf = async (ctx, claimId) => ClaimState[Number((await ctx.sa.getClaim(claimId)).state)];

/** One keeper cycle on fresh indexed state. */
async function cycle(site) {
  await site.sync();
  return site.keep();
}

describe('finalize and settle when due', () => {
  test('a valid verdict: finalize once the round is over, settle after the dispute window', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const site = siteFor(ctx);
    try {
      let r = await cycle(site);
      assert.deepEqual(r.sent, [], 'the round is open: nothing to send');
      assert.equal(await stateOf(ctx, claimId), 'Revealed');

      await verdict(ctx, claimId, 'HIGH');
      r = await cycle(site);
      assert.deepEqual(r.sent.map((s) => [s.action, s.claimId]), [['finalize', String(claimId)]]);
      assert.equal(await stateOf(ctx, claimId), 'Judged');

      r = await cycle(site);
      assert.deepEqual(r.sent, [], 'the dispute window is open');
      await increaseTime(ctx, 72 * HOUR - 60);
      r = await cycle(site);
      assert.deepEqual(r.sent, [], 'still a minute to go');

      const hunter = ctx.hunters[0].address;
      const before = await ctx.hre.ethers.provider.getBalance(hunter);
      await increaseTime(ctx, 61);
      r = await cycle(site);
      assert.deepEqual(r.sent.map((s) => [s.action, s.claimId]), [['settle', String(claimId)]]);
      assert.equal(await stateOf(ctx, claimId), 'Settled');
      const l = await ctx.sa.getListing(listingId);
      assert.equal(await ctx.hre.ethers.provider.getBalance(hunter) - before, l.bondWei + l.awards[2], 'bond back plus the HIGH award');

      r = await cycle(site);
      assert.deepEqual(r.sent, []);
      const txs = await keeperTransactions(ctx);
      assert.deepEqual(txs.map((t) => [t.fn, t.status]), [[`finalize(${claimId})`, 1], [`settle(${claimId})`, 1]]);
    } finally {
      site.close();
    }
  });

  test('INVALID and DUPLICATE settle on the cycle after finalize, with no wait', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const site = siteFor(ctx);
    try {
      const invalid = await revealedClaim(ctx, ctx.hunters[0], listingId);
      await verdict(ctx, invalid, 'INVALID');
      assert.deepEqual((await cycle(site)).sent.map((s) => s.action), ['finalize']);
      assert.deepEqual((await cycle(site)).sent.map((s) => s.action), ['settle']);
      assert.equal(await stateOf(ctx, invalid), 'Settled');

      const duplicate = await revealedClaim(ctx, ctx.hunters[1], listingId);
      await verdict(ctx, duplicate, 'DUPLICATE');
      await cycle(site);
      await cycle(site);
      assert.equal(await stateOf(ctx, duplicate), 'Settled');
    } finally {
      site.close();
    }
  });

  test('a timed-out round is finalized into RoundFailed, and nothing more is sent for it', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const site = siteFor(ctx);
    try {
      assert.deepEqual((await cycle(site)).sent, []);
      await increaseTime(ctx, 301); // the mock aggregator's responseTimeoutSeconds is 300
      assert.deepEqual((await cycle(site)).sent.map((s) => s.action), ['finalize']);
      assert.equal(await stateOf(ctx, claimId), 'RoundFailed');
      assert.deepEqual((await cycle(site)).sent, [], 'a failed round is the hunter\'s to re-trigger');
    } finally {
      site.close();
    }
  });

  test('a dispute: the second finalize when the dispute round is over, then settle at once', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
    const site = siteFor(ctx);
    try {
      await verdict(ctx, claimId, 'MEDIUM');
      await cycle(site);
      assert.equal(await stateOf(ctx, claimId), 'Judged');
      await dispute(ctx, claimId);
      assert.equal(await stateOf(ctx, claimId), 'Disputed');
      assert.deepEqual((await cycle(site)).sent, [], 'the dispute round is open');
      await verdict(ctx, claimId, 'INVALID', { dispute: true });
      assert.deepEqual((await cycle(site)).sent.map((s) => s.action), ['finalize']);
      assert.equal(await stateOf(ctx, claimId), 'Judged');
      assert.deepEqual((await cycle(site)).sent.map((s) => s.action), ['settle'], 'the second verdict is final: no dispute window');
      assert.equal(await stateOf(ctx, claimId), 'Settled');
      assert.equal((await ctx.sa.getClaim(claimId)).outcome, 0n, 'overturned to INVALID');
    } finally {
      site.close();
    }
  });

  test('several claims due in one cycle are all handled, one transaction after another', async () => {
    const ctx = await chainContext();
    const a = await listing(ctx);
    const b = await listing(ctx);
    const site = siteFor(ctx);
    try {
      const c1 = await revealedClaim(ctx, ctx.hunters[0], a.listingId);
      const c2 = await revealedClaim(ctx, ctx.hunters[1], b.listingId);
      await verdict(ctx, c1, 'INVALID');
      await verdict(ctx, c2, 'DUPLICATE');
      const r = await cycle(site);
      assert.deepEqual(r.sent.map((s) => [s.action, s.claimId]), [['finalize', String(c1)], ['finalize', String(c2)]]);
      const nonces = (await keeperTransactions(ctx)).map((t) => t.nonce);
      assert.deepEqual(nonces, [nonces[0], nonces[0] + 1]);
    } finally {
      site.close();
    }
  });
});

describe('expire', () => {
  test('is left alone by default', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const claimId = await commit(ctx, ctx.hunters[0], listingId);
    await increaseTime(ctx, HOUR + 1);
    const site = siteFor(ctx);
    try {
      assert.deepEqual((await cycle(site)).sent, []);
      assert.equal(await stateOf(ctx, claimId), 'Committed');
    } finally {
      site.close();
    }
  });

  test('with SA_KEEPER_EXPIRE=on, an undisclosed claim is expired once the disclose window is over', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const claimId = await commit(ctx, ctx.hunters[0], listingId);
    const site = siteFor(ctx, { env: { SA_KEEPER_EXPIRE: 'on' } });
    try {
      assert.deepEqual((await cycle(site)).sent, [], 'the disclose window is open');
      await increaseTime(ctx, HOUR + 1);
      assert.deepEqual((await cycle(site)).sent.map((s) => [s.action, s.claimId]), [['expire', String(claimId)]]);
      assert.equal(await stateOf(ctx, claimId), 'Expired');
      await increaseTime(ctx, DAY);
      assert.deepEqual((await cycle(site)).sent, []);
    } finally {
      site.close();
    }
  });
});

describe('the keeper\'s key', () => {
  test('comes from the environment only: no key, no keeper; the config and the logs never hold it', async () => {
    const ctx = await chainContext();
    await listing(ctx);
    const noKey = siteFor(ctx, { env: { SA_KEEPER_PRIVATE_KEY: '' } });
    try {
      assert.equal(noKey.keeper, null);
      assert.equal(noKey.status().keeper.enabled, false);
      assert.equal(noKey.status().keeper.error, 'KEEPER_KEY_MISSING');
    } finally {
      noKey.close();
    }

    const off = siteFor(ctx, { env: { SA_KEEPER: 'off' } });
    try {
      assert.equal(off.keeper, null);
    } finally {
      off.close();
    }

    const site = siteFor(ctx);
    try {
      assert.equal(site.status().keeper.address, ctx.keeperAddress);
      await site.sync();
      await site.keep();
      const config = loadConfig({ SA_CONTRACT_ADDRESS: ctx.address, SA_CHAIN_ID: '31337', SA_KEEPER_PRIVATE_KEY: ctx.keeperKey });
      const secret = ctx.keeperKey.slice(2);
      assert.equal(JSON.stringify(config).includes(secret), false);
      assert.equal(config.keeper.keyEnv, 'SA_KEEPER_PRIVATE_KEY');
      assert.equal(JSON.stringify(site.status()).includes(secret), false);
      assert.equal(site.logger.lines.join('\n').includes(secret), false);
    } finally {
      site.close();
    }
  });

  test('a key that is not a private key is refused without echoing it', async () => {
    const ctx = await chainContext();
    const bad = `0x${'zz'.repeat(32)}`;
    const site = siteFor(ctx, { env: { SA_KEEPER_PRIVATE_KEY: bad } });
    try {
      assert.equal(site.keeper, null);
      assert.equal(site.status().keeper.error, 'KEEPER_KEY_INVALID');
      assert.equal(JSON.stringify(site.status()).includes('zzzz'), false);
      assert.equal(site.logger.lines.join('\n').includes('zzzz'), false);
    } finally {
      site.close();
    }
  });
});
