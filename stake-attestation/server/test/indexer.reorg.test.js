// Reorg safety (node P4b1, review focus "indexer reorgs and restarts"). The in-process chain is
// reorganised with evm_snapshot / evm_revert: blocks the indexer already read are orphaned and a
// different, longer chain is mined in their place. The indexer must notice (the block at its
// cursor no longer has the hash it stored), roll back to the last block it stored that is still
// on the chain, re-read from there, and end with exactly what a fresh indexer reads from the new
// chain. A chain that changes while a range is being read must not be committed at all.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { chainContext, commit, disclose, listing, mine, rpc, siteFor, tmpDir } from './helpers/scenario.js';

const view = (events) => events.map(({ name, blockNumber, blockHash, logIndex, txHash, args }) => ({ name, blockNumber, blockHash, logIndex, txHash, args }));

/** The events a fresh indexer reads from the chain as it is now. */
async function freshIndex(ctx, env = {}) {
  const site = siteFor(ctx, { env });
  try {
    await site.sync();
    return view(site.store.state.events);
  } finally {
    site.close();
  }
}

describe('a reorg deeper than the confirmation depth', () => {
  test('rolls back the orphaned blocks and re-reads the new chain', async () => {
    const ctx = await chainContext();
    const env = { SA_CONFIRMATIONS: '2' };
    const kept = await listing(ctx);
    await mine(ctx, 3);
    const site = siteFor(ctx, { env });
    try {
      await site.sync();
      const fork = await ctx.hre.ethers.provider.getBlockNumber();
      const snapshot = await rpc(ctx, 'evm_snapshot');

      // the branch the indexer reads, then loses
      const orphan = await listing(ctx);
      const claimId = await commit(ctx, ctx.hunters[0], kept.listingId);
      await disclose(ctx, ctx.hunters[0], claimId);
      await mine(ctx, 4);
      await site.sync();
      const orphanedHash = site.store.state.cursor.hash;
      assert.ok(site.store.state.events.some((e) => e.name === 'Listed' && e.args.listingId === String(orphan.listingId)));
      assert.ok(site.store.state.events.some((e) => e.name === 'Disclosed'));
      assert.ok(site.store.state.cursor.number > fork + 2, 'the orphaned blocks are past the confirmation depth');

      // the canonical chain: another listing in their place, longer than the orphaned branch
      assert.equal(await rpc(ctx, 'evm_revert', [snapshot]), true);
      const replacement = await listing(ctx, { maker: ctx.other });
      await mine(ctx, 12);

      // before the next sync, an answer is still the indexed block's, read by its hash: the
      // orphaned branch's record with its history if the node still has that block, else 503;
      // never the replacement branch's state at the same height mixed with the indexed history
      const pinned = async (hash) => {
        try {
          return await site.record(hash);
        } catch (e) {
          assert.equal(e.code, 'CHAIN_UNAVAILABLE');
          return 'unavailable';
        }
      };
      const before = await pinned(orphan.artifactHash);
      if (before !== 'unavailable') {
        assert.equal(before.block.hash, orphanedHash);
        assert.equal(before.record.listings[0].listingId, String(orphan.listingId));
        assert.ok(before.history.events.some((e) => e.name === 'Listed' && e.listingId === String(orphan.listingId)));
      }
      assert.ok([null, 'unavailable'].includes(await pinned(replacement.artifactHash)), 'the replacement branch is not read under the orphaned block');

      const r = await site.sync();
      assert.ok(r.rolledBack, 'the sync reports the rollback');
      assert.ok(r.rolledBack.to <= fork, `rolled back to a block still on the chain (${r.rolledBack.to} <= ${fork})`);
      assert.notEqual(site.store.state.cursor.hash, orphanedHash);
      assert.equal(site.store.state.cursor.hash, (await ctx.hre.ethers.provider.getBlock(site.store.state.cursor.number)).hash);

      const events = view(site.store.state.events);
      assert.equal(events.some((e) => e.name === 'Disclosed'), false, 'the orphaned disclosure is gone');
      assert.ok(events.some((e) => e.name === 'Listed' && e.args.maker === ctx.other.address && e.args.artifactHash === replacement.artifactHash));
      assert.equal(events.some((e) => e.args.artifactHash === orphan.artifactHash), false, 'the orphaned listing is gone');
      for (const e of events) {
        assert.equal(e.blockHash, (await ctx.hre.ethers.provider.getBlock(e.blockNumber)).hash, 'every stored event is on the chain');
      }
      assert.deepEqual(events, await freshIndex(ctx, env));

      // the feed and the record are the new chain's
      const feed = await site.feed();
      const hashes = feed.listings.map((l) => l.artifactHash);
      assert.ok(hashes.includes(kept.artifactHash));
      assert.ok(hashes.includes(replacement.artifactHash));
      assert.equal(hashes.includes(orphan.artifactHash), false);
      assert.equal(await site.record(orphan.artifactHash), null);
    } finally {
      site.close();
    }
  });

  test('a reorg past the stored window re-reads everything from SA_FROM_BLOCK', async () => {
    const ctx = await chainContext();
    const env = { SA_CONFIRMATIONS: '0', SA_REORG_WINDOW_BLOCKS: '4' };
    await listing(ctx);
    const snapshot = await rpc(ctx, 'evm_snapshot');
    const site = siteFor(ctx, { env });
    try {
      for (let i = 0; i < 4; i += 1) {
        await listing(ctx);
        await mine(ctx, 3);
        await site.sync(); // one checkpoint per sync, so the window fills
      }
      assert.equal(await rpc(ctx, 'evm_revert', [snapshot]), true);
      await listing(ctx, { maker: ctx.other });
      await mine(ctx, 30);
      const r = await site.sync();
      assert.ok(r.rolledBack);
      assert.equal(r.rolledBack.reindexed, true, 'no stored block is on the chain any more: a full re-read');
      assert.deepEqual(view(site.store.state.events), await freshIndex(ctx, env));
    } finally {
      site.close();
    }
  });

  test('only the stored blocks of the window are kept, never more', async () => {
    const ctx = await chainContext();
    const site = siteFor(ctx, { env: { SA_REORG_WINDOW_BLOCKS: '8' } });
    try {
      for (let i = 0; i < 6; i += 1) {
        await mine(ctx, 3);
        await site.sync();
      }
      const { cursor, checkpoints } = site.store.state;
      assert.ok(checkpoints.length > 0);
      assert.ok(checkpoints.every((c) => c.number >= cursor.number - 8 && c.number <= cursor.number));
      assert.deepEqual(checkpoints.at(-1), { number: cursor.number, hash: cursor.hash, timestamp: cursor.timestamp });
    } finally {
      site.close();
    }
  });
});

describe('a chain that changes while a range is being read', () => {
  test('is not committed: the sync fails, the cursor stays, and the next sync reads the new chain', async () => {
    const ctx = await chainContext();
    await listing(ctx);
    await mine(ctx, 2);
    const dir = tmpDir();
    const base = siteFor(ctx, { dir });
    await base.sync();
    const cursor = base.store.state.cursor;
    base.close();

    const snapshot = await rpc(ctx, 'evm_snapshot');
    const orphan = await listing(ctx);
    await mine(ctx, 2);
    // a provider whose first getLogs answers from the branch that is about to be orphaned, and
    // then the chain reorganises under it before the indexer checks the range
    let reorged = false;
    const provider = new Proxy(ctx.provider, {
      get(target, prop, receiver) {
        if (prop === 'getLogs') {
          return async (filter) => {
            const logs = await target.getLogs(filter);
            if (!reorged) {
              reorged = true;
              await rpc(ctx, 'evm_revert', [snapshot]);
              await listing(ctx, { maker: ctx.other });
              await mine(ctx, 6);
            }
            return logs;
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const site = siteFor(ctx, { dir, provider });
    try {
      await assert.rejects(site.sync(), (e) => e.code === 'REORG_RETRY');
      assert.deepEqual(site.store.state.cursor, cursor, 'nothing from the changed range was committed');
      assert.equal(site.store.state.events.some((e) => e.args.artifactHash === orphan.artifactHash), false);
      await site.sync();
      assert.equal(site.store.state.events.some((e) => e.args.artifactHash === orphan.artifactHash), false);
      assert.deepEqual(view(site.store.state.events), await freshIndex(ctx));
    } finally {
      site.close();
    }
  });
});
