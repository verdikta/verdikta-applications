// Keeper idempotence (node P4b1, review focus "keeper idempotence"): a second keeper, a retry
// after a timeout, or a restart never sends a transaction that would revert or act twice. The
// keeper reads the claim on-chain and simulates the call before every send; it has at most one
// transaction in flight, at the account's next confirmed nonce, recorded (signed bytes included)
// before it is broadcast; a retry re-sends the same call at the same nonce with higher fees, and
// an in-flight call that is no longer due is replaced by a 0-value transfer to itself. The tests
// turn automine off so that transactions wait in the mempool as they would on Base.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction } from 'ethers';

import {
  automine, chainContext, commit, finalize, HOUR, increaseTime, keeperTransactions, listing, mine,
  pendingKeeperTransactions, revealedClaim, rpc, siteFor, tmpDir, verdict,
} from './helpers/scenario.js';

const FAST = { SA_KEEPER_TX_TIMEOUT_MS: '200', SA_KEEPER_REPLACE_AFTER_MS: '600000' };

async function judgedInvalid(ctx) {
  const { listingId } = await listing(ctx);
  const claimId = await revealedClaim(ctx, ctx.hunters[0], listingId);
  await verdict(ctx, claimId, 'INVALID');
  return claimId;
}

describe('two keepers', () => {
  test('with the same key, at the same time: each call is mined once and nothing reverts', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const a = siteFor(ctx, { env: FAST });
    const b = siteFor(ctx, { env: FAST });
    try {
      await a.sync();
      await b.sync();
      await automine(ctx, false);
      const [ra, rb] = await Promise.all([a.keep(), b.keep()]);
      const pending = await pendingKeeperTransactions(ctx);
      assert.equal(pending.length, 1, 'one finalize waits in the mempool, not two');
      assert.ok(ra.pending || rb.pending);
      await mine(ctx);
      for (let i = 0; i < 4; i += 1) {
        await a.sync();
        await b.sync();
        await Promise.all([a.keep(), b.keep()]);
        assert.ok((await pendingKeeperTransactions(ctx)).length <= 1);
        await mine(ctx);
      }
      await automine(ctx, true);
      const txs = await keeperTransactions(ctx);
      assert.deepEqual(txs.map((t) => [t.fn, t.status]), [[`finalize(${claimId})`, 1], [`settle(${claimId})`, 1]]);
      assert.equal(a.status().keeper.inflight, null);
      assert.equal(b.status().keeper.inflight, null);
    } finally {
      await automine(ctx, true);
      a.close();
      b.close();
    }
  });

  test('with another key, one after the other: the second reads the claim on-chain and sends nothing', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const a = siteFor(ctx);
    const b = siteFor(ctx, { env: { SA_KEEPER_PRIVATE_KEY: ctx.keyOf(10) } });
    try {
      await a.sync();
      await b.sync(); // b's index still says Revealed
      assert.deepEqual((await a.keep()).sent.map((s) => s.action), ['finalize']);
      assert.deepEqual((await a.keep()).sent.map((s) => s.action), ['settle']);
      const rb = await b.keep();
      assert.deepEqual(rb.sent, []);
      assert.equal(rb.pending, null);
      assert.equal((await ctx.sa.getClaim(claimId)).state, 5n, 'Settled');
      assert.deepEqual((await keeperTransactions(ctx)).map((t) => [t.fn, t.status]), [[`finalize(${claimId})`, 1], [`settle(${claimId})`, 1]]);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('another caller acts first', () => {
  test('the keeper reads the claim before sending and skips what is done', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const site = siteFor(ctx);
    try {
      await site.sync(); // indexed: Revealed, due for finalize
      await finalize(ctx, claimId, ctx.hunters[0]);
      await (await ctx.sa.connect(ctx.hunters[0]).settle(claimId)).wait();
      const r = await site.keep();
      assert.deepEqual(r.sent, []);
      assert.deepEqual(await keeperTransactions(ctx), []);
    } finally {
      site.close();
    }
  });
});

describe('a retry after a timeout', () => {
  test('waits for the transaction in flight and sends nothing at a new nonce', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const site = siteFor(ctx, { env: FAST });
    try {
      await site.sync();
      await automine(ctx, false);
      const first = await site.keep();
      assert.deepEqual(first.sent.map((s) => s.action), ['finalize']);
      assert.ok(first.pending, 'the receipt did not come in time');
      const nonce = first.pending.nonce;
      for (let i = 0; i < 3; i += 1) {
        const again = await site.keep();
        assert.deepEqual(again.sent, [], 'no second transaction');
        assert.equal(again.pending.nonce, nonce);
      }
      const mempool = await pendingKeeperTransactions(ctx);
      assert.equal(mempool.length, 1);
      await mine(ctx);
      const after = await site.keep();
      assert.equal(after.pending, null, 'the receipt resolves the transaction in flight');
      assert.deepEqual(after.sent, [], 'one call per claim per cycle');
      assert.equal(site.status().keeper.last.status, 'mined');
      assert.equal(site.status().keeper.last.action, 'finalize');
      await automine(ctx, true);
      await site.sync();
      await site.keep();
      const txs = await keeperTransactions(ctx);
      assert.deepEqual(txs.map((t) => [t.fn, t.status]), [[`finalize(${claimId})`, 1], [`settle(${claimId})`, 1]]);
    } finally {
      await automine(ctx, true);
      site.close();
    }
  });

  test('past SA_KEEPER_REPLACE_AFTER_MS re-sends the same call at the same nonce, with higher fees', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const site = siteFor(ctx, { env: { ...FAST, SA_KEEPER_REPLACE_AFTER_MS: '0' } });
    try {
      await site.sync();
      await automine(ctx, false);
      const first = await site.keep();
      const [tx1] = await pendingKeeperTransactions(ctx);
      const retry = await site.keep();
      assert.deepEqual(retry.sent.map((s) => [s.action, s.claimId, s.nonce, s.replaced]), [['finalize', String(claimId), first.pending.nonce, true]]);
      const pending = await pendingKeeperTransactions(ctx);
      assert.equal(pending.length, 1, 'the replacement took the original\'s place');
      const [tx2] = pending;
      assert.equal(tx2.input, tx1.input);
      assert.equal(tx2.nonce, tx1.nonce);
      assert.ok(BigInt(tx2.maxFeePerGas) > BigInt(tx1.maxFeePerGas));
      assert.ok(BigInt(tx2.maxPriorityFeePerGas) > BigInt(tx1.maxPriorityFeePerGas));
      await mine(ctx);
      await automine(ctx, true);
      await site.keep();
      const txs = await keeperTransactions(ctx);
      assert.deepEqual(txs.map((t) => [t.fn, t.status, t.hash]), [[`finalize(${claimId})`, 1, tx2.hash]]);
    } finally {
      await automine(ctx, true);
      site.close();
    }
  });

  test('a call that stopped being due while it waited is replaced by a transfer to itself, not left to revert', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const site = siteFor(ctx, { env: { ...FAST, SA_KEEPER_REPLACE_AFTER_MS: '0' } });
    try {
      await site.sync();
      await automine(ctx, false);
      await site.keep();
      const [stale] = await pendingKeeperTransactions(ctx);
      // another caller's finalize is mined first while the keeper's waits elsewhere in the network
      await rpc(ctx, 'hardhat_dropTransaction', [stale.hash]);
      const other = await ctx.sa.connect(ctx.hunters[1]).finalize(claimId);
      await mine(ctx);
      assert.equal((await other.wait()).status, 1);
      const raw = site.store.state.keeper.inflight.attempts.at(-1).raw;
      await rpc(ctx, 'eth_sendRawTransaction', [raw]);
      const r = await site.keep();
      assert.deepEqual(r.sent.map((s) => s.action), ['cancel']);
      await mine(ctx);
      await automine(ctx, true);
      await site.keep();
      const txs = await keeperTransactions(ctx);
      assert.deepEqual(txs.map((t) => [t.fn, t.status]), [['cancel', 1]], 'the stale finalize never reached a block');
      assert.equal(site.status().keeper.inflight, null);
    } finally {
      await automine(ctx, true);
      site.close();
    }
  });

  test('call, cancel, call: a call due again after its cancellation vanished is re-sent with the call\'s gas, not 21000', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const site = siteFor(ctx, { env: { ...FAST, SA_KEEPER_REPLACE_AFTER_MS: '0' } });
    const drop = async (hash) => {
      try {
        await rpc(ctx, 'hardhat_dropTransaction', [hash]);
      } catch { /* not there */ }
    };
    try {
      await site.sync();
      await automine(ctx, false);
      const first = await site.keep(); // finalize at n, waiting
      const call = first.pending.attempts.at(-1);
      const snapshot = await rpc(ctx, 'evm_snapshot');
      // another caller's finalize lands first, so the keeper cancels its own
      await drop(call.hash);
      const other = await ctx.sa.connect(ctx.hunters[1]).finalize(claimId, { gasLimit: 1_000_000 });
      await mine(ctx);
      assert.equal((await other.wait()).status, 1);
      await rpc(ctx, 'eth_sendRawTransaction', [call.raw]);
      const cancelled = await site.keep();
      assert.deepEqual(cancelled.sent.map((x) => x.action), ['cancel']);
      // a reorg undoes the other finalize, and the cancellation is gone with it: due again
      assert.equal(await rpc(ctx, 'evm_revert', [snapshot]), true);
      for (const a of site.store.state.keeper.inflight.attempts) await drop(a.hash);
      assert.equal((await ctx.sa.getClaim(claimId)).state, 2n, 'Revealed again');
      const again = await site.keep();
      assert.deepEqual(again.sent.map((x) => [x.action, x.nonce]), [['finalize', first.pending.nonce]]);
      assert.equal(site.store.state.keeper.inflight.attempts.at(-1).gasLimit, call.gasLimit);
      await mine(ctx);
      await automine(ctx, true);
      await site.keep();
      assert.equal((await ctx.sa.getClaim(claimId)).state, 3n, 'Judged');
      for (const t of await keeperTransactions(ctx)) assert.equal(t.status, 1, t.fn);
    } finally {
      await automine(ctx, true);
      site.close();
    }
  });

  test('a transaction the network dropped is re-checked: sent again only if the call is still due', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const site = siteFor(ctx, { env: FAST });
    try {
      await site.sync();
      await automine(ctx, false);
      const first = await site.keep();
      await rpc(ctx, 'hardhat_dropTransaction', [first.pending.attempts.at(-1).hash]);
      const again = await site.keep();
      assert.deepEqual(again.sent.map((s) => [s.action, s.nonce]), [['finalize', first.pending.nonce]]);
      await mine(ctx);
      await automine(ctx, true);
      await site.keep();
      assert.deepEqual((await keeperTransactions(ctx)).map((t) => [t.fn, t.status]), [[`finalize(${claimId})`, 1]]);
    } finally {
      await automine(ctx, true);
      site.close();
    }
  });
});

describe('a restart with a transaction in flight', () => {
  test('the new process finds it in the store and waits for it instead of sending another', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const dir = tmpDir();
    const first = siteFor(ctx, { dir, env: FAST });
    await first.sync();
    await automine(ctx, false);
    let second;
    try {
      const r = await first.keep();
      assert.ok(r.pending);
      first.close();
      second = siteFor(ctx, { dir, env: FAST });
      assert.equal(second.status().keeper.inflight.nonce, r.pending.nonce);
      const again = await second.keep();
      assert.deepEqual(again.sent, []);
      assert.equal((await pendingKeeperTransactions(ctx)).length, 1);
      await mine(ctx);
      await automine(ctx, true);
      await second.sync();
      await second.keep();
      await second.sync();
      await second.keep();
      assert.deepEqual((await keeperTransactions(ctx)).map((t) => [t.fn, t.status]), [[`finalize(${claimId})`, 1], [`settle(${claimId})`, 1]]);
    } finally {
      await automine(ctx, true);
      second?.close();
    }
  });

  test('a crash after the transaction was recorded but before it was broadcast: it is broadcast on restart if still due', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const dir = tmpDir();
    const crash = () => { throw Object.assign(new Error('the process died here'), { code: 'TEST_CRASH' }); };
    const first = siteFor(ctx, { dir, env: FAST, keeperHooks: { beforeBroadcast: crash } });
    await first.sync();
    await assert.rejects(first.keep(), (e) => e.code === 'TEST_CRASH');
    assert.equal((await keeperTransactions(ctx)).length, 0, 'nothing was broadcast');
    assert.ok(first.store.state.keeper.inflight);
    first.close();
    const second = siteFor(ctx, { dir });
    try {
      const r = await second.keep();
      assert.deepEqual(r.sent.map((s) => s.action), ['finalize']);
      assert.deepEqual((await keeperTransactions(ctx)).map((t) => [t.fn, t.status]), [[`finalize(${claimId})`, 1]]);
    } finally {
      second.close();
    }
  });
});

describe('a record the keeper cannot act on any more', () => {
  test('after the key changed, the old key\'s call is never sent again while it can still mine, even unseen by this node', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const other = await listing(ctx);
    const otherClaim = await revealedClaim(ctx, ctx.hunters[1], other.listingId);
    await verdict(ctx, otherClaim, 'INVALID');
    const dir = tmpDir();
    const oldKey = siteFor(ctx, { dir, env: FAST });
    await oldKey.sync();
    await automine(ctx, false);
    let newKey;
    try {
      const r = await oldKey.keep();
      assert.deepEqual(r.sent.map((x) => [x.action, x.claimId]), [['finalize', String(claimId)]]);
      const raw = r.pending.attempts.at(-1).raw;
      oldKey.close();
      // the old transaction leaves this node's mempool, but may still be pending elsewhere
      await rpc(ctx, 'hardhat_dropTransaction', [r.pending.attempts.at(-1).hash]);
      await automine(ctx, true);

      newKey = siteFor(ctx, { dir, env: { ...FAST, SA_KEEPER_REPLACE_AFTER_MS: '0', SA_KEEPER_PRIVATE_KEY: ctx.keyOf(10) } });
      const newAddress = ctx.signers[10].address;
      const first = await newKey.keep();
      assert.deepEqual(first.sent.map((x) => [x.action, x.claimId]), [['finalize', String(otherClaim)]], 'the other claim goes on; the old key\'s call is not repeated');
      assert.deepEqual(newKey.status().keeper.foreign, [{ action: 'finalize', claimId: String(claimId), from: ctx.keeperAddress, nonce: r.pending.nonce }]);
      assert.deepEqual((await newKey.keep()).sent.map((x) => [x.action, x.claimId]), [['settle', String(otherClaim)]]);

      // the old transaction turns up and mines after all
      await rpc(ctx, 'eth_sendRawTransaction', [raw]);
      const after = await newKey.keep();
      assert.deepEqual(after.sent.map((x) => [x.action, x.claimId]), [['settle', String(claimId)]]);
      assert.deepEqual(newKey.status().keeper.foreign, []);
      assert.deepEqual((await keeperTransactions(ctx)).map((t) => [t.fn, t.status]), [[`finalize(${claimId})`, 1]]);
      assert.deepEqual((await keeperTransactions(ctx, ctx.fromBlock, newAddress)).map((t) => [t.fn, t.status]), [
        [`finalize(${otherClaim})`, 1], [`settle(${otherClaim})`, 1], [`settle(${claimId})`, 1],
      ]);
    } finally {
      await automine(ctx, true);
      newKey?.close();
    }
  });

  test('a reorg that drops a mined transaction under one still queued: the stale call is cancelled and the gap filled, nothing reverts', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const site = siteFor(ctx, { env: FAST });
    try {
      await site.sync();
      const snapshot = await rpc(ctx, 'evm_snapshot');
      assert.deepEqual((await site.keep()).sent.map((s) => s.action), ['finalize']); // nonce n, mined
      await automine(ctx, false);
      const r = await site.keep(); // settle at n + 1, waiting
      assert.deepEqual(r.sent.map((s) => s.action), ['settle']);
      const queued = r.pending.attempts.at(-1).raw;
      // the block with the finalize at n is orphaned; the settle at n + 1 survives in a mempool,
      // where it would run, and revert, as soon as nonce n is used
      assert.equal(await rpc(ctx, 'evm_revert', [snapshot]), true);
      assert.equal(await ctx.hre.ethers.provider.getTransactionCount(ctx.keeperAddress, 'latest'), r.pending.nonce - 1);
      try {
        await rpc(ctx, 'eth_sendRawTransaction', [queued]);
      } catch { /* the node kept it */ }
      const gap = await site.keep();
      assert.deepEqual(gap.sent.map((s) => [s.action, s.nonce]), [['cancel', r.pending.nonce], ['fill', r.pending.nonce - 1]]);
      await mine(ctx);
      await automine(ctx, true);
      for (let i = 0; i < 3; i += 1) {
        await site.sync();
        await site.keep();
      }
      assert.equal((await ctx.sa.getClaim(claimId)).state, 5n, 'Settled');
      assert.equal(site.status().keeper.inflight, null);
      const txs = await keeperTransactions(ctx);
      for (const t of txs) assert.equal(t.status, 1, t.fn);
      assert.deepEqual(txs.map((t) => t.fn), ['cancel', 'cancel', `finalize(${claimId})`, `settle(${claimId})`]);
    } finally {
      await automine(ctx, true);
      site.close();
    }
  });

  /** The gap of the test above, up to the queued settle surviving the reorg; returns its nonce. */
  async function gapAfterReorg(ctx, site) {
    await site.sync();
    const snapshot = await rpc(ctx, 'evm_snapshot');
    await site.keep(); // finalize at n, mined
    await automine(ctx, false);
    const r = await site.keep(); // settle at n + 1, waiting
    const queued = r.pending.attempts.at(-1).raw;
    assert.equal(await rpc(ctx, 'evm_revert', [snapshot]), true);
    try {
      await rpc(ctx, 'eth_sendRawTransaction', [queued]);
    } catch { /* the node kept it */ }
    return r.pending.nonce;
  }

  async function finishAndCheck(ctx, site, claimId) {
    await mine(ctx);
    await automine(ctx, true);
    for (let i = 0; i < 3; i += 1) {
      await site.sync();
      await site.keep();
    }
    assert.equal((await ctx.sa.getClaim(claimId)).state, 5n, 'Settled');
    const txs = await keeperTransactions(ctx);
    for (const t of txs) assert.equal(t.status, 1, t.fn);
    assert.equal(txs.filter((t) => t.fn === `settle(${claimId})`).length, 1);
  }

  test('a cancellation the node refuses leaves the gap open: no nonce is filled under the stale call', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    let refuse = true;
    const provider = new Proxy(ctx.provider, {
      get(target, prop) {
        if (prop === 'broadcastTransaction') {
          return async (raw) => {
            if (refuse && Transaction.from(raw).to === ctx.keeperAddress) throw Object.assign(new Error('replacement transaction underpriced'), { code: 'REPLACEMENT_UNDERPRICED' });
            return target.broadcastTransaction(raw);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const site = siteFor(ctx, { env: FAST, provider });
    try {
      const nonce = await gapAfterReorg(ctx, site);
      const refused = await site.keep();
      assert.deepEqual(refused.sent, [], 'neither the cancel nor any filler');
      assert.ok(refused.pending);
      await mine(ctx);
      assert.equal(await ctx.hre.ethers.provider.getTransactionCount(ctx.keeperAddress, 'latest'), nonce - 1, 'the gap is still open, so the stale settle cannot run');
      refuse = false;
      const accepted = await site.keep();
      assert.deepEqual(accepted.sent.map((x) => [x.action, x.nonce]), [['cancel', nonce], ['fill', nonce - 1]]);
      await finishAndCheck(ctx, site, claimId);
    } finally {
      await automine(ctx, true);
      site.close();
    }
  });

  test('a cancellation recorded but never broadcast (a crash) is sent on restart before the gap is filled', async () => {
    const ctx = await chainContext();
    const claimId = await judgedInvalid(ctx);
    const dir = tmpDir();
    const crashOnCancel = (attempt) => {
      if (attempt.kind === 'cancel') throw Object.assign(new Error('the process died here'), { code: 'TEST_CRASH' });
    };
    const first = siteFor(ctx, { dir, env: FAST, keeperHooks: { beforeBroadcast: crashOnCancel } });
    let second;
    try {
      const nonce = await gapAfterReorg(ctx, first);
      await assert.rejects(first.keep(), (e) => e.code === 'TEST_CRASH');
      assert.equal(first.store.state.keeper.inflight.attempts.at(-1).kind, 'cancel');
      first.close();
      await mine(ctx);
      assert.equal(await ctx.hre.ethers.provider.getTransactionCount(ctx.keeperAddress, 'latest'), nonce - 1, 'nothing was filled');
      second = siteFor(ctx, { dir, env: FAST });
      const r = await second.keep();
      assert.deepEqual(r.sent.map((x) => [x.action, x.nonce]), [['cancel', nonce], ['fill', nonce - 1]]);
      await finishAndCheck(ctx, second, claimId);
    } finally {
      await automine(ctx, true);
      second?.close();
    }
  });

  test('an expiry recorded with SA_KEEPER_EXPIRE=on is not sent after a restart with it off', async () => {
    const ctx = await chainContext();
    const { listingId } = await listing(ctx);
    const claimId = await commit(ctx, ctx.hunters[0], listingId);
    await increaseTime(ctx, HOUR + 1);
    const dir = tmpDir();
    const crash = () => { throw Object.assign(new Error('the process died here'), { code: 'TEST_CRASH' }); };
    const first = siteFor(ctx, { dir, env: { SA_KEEPER_EXPIRE: 'on' }, keeperHooks: { beforeBroadcast: crash } });
    await first.sync();
    await assert.rejects(first.keep(), (e) => e.code === 'TEST_CRASH');
    assert.equal(first.store.state.keeper.inflight.action, 'expire');
    first.close();
    const second = siteFor(ctx, { dir, env: { SA_KEEPER_EXPIRE: 'off' } });
    try {
      const r = await second.keep();
      assert.deepEqual(r.sent, []);
      assert.equal(r.pending, null);
      assert.equal(second.status().keeper.last.status, 'dropped');
      assert.deepEqual(await keeperTransactions(ctx), []);
      assert.equal((await ctx.sa.getClaim(claimId)).state, 0n, 'still Committed');
    } finally {
      second.close();
    }
  });
});
