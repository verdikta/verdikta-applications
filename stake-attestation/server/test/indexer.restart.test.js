// A restart mid-sync (node P4b1, review focus "indexer reorgs and restarts"). The indexer reads in
// chunks of SA_LOG_CHUNK_BLOCKS and commits each chunk with its cursor in one atomic write, so a
// process that dies part-way leaves a consistent prefix: the next process resumes after the last
// committed chunk, with no gap and no event twice, and ends with what one uninterrupted sync reads.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { tryLock } from '../src/site/store.js';
import { chainContext, commit, disclose, listing, mine, siteFor, tmpDir } from './helpers/scenario.js';

const view = (events) => events.map(({ name, blockNumber, blockHash, logIndex, txHash, args }) => ({ name, blockNumber, blockHash, logIndex, txHash, args }));

/** A provider whose getLogs throws on call `n` (counting from 1): a process killed mid-sync. */
function crashingProvider(ctx, n) {
  let calls = 0;
  return new Proxy(ctx.provider, {
    get(target, prop, receiver) {
      if (prop === 'getLogs') {
        return async (filter) => {
          calls += 1;
          if (calls === n) throw Object.assign(new Error('the process died here'), { code: 'TEST_CRASH' });
          return target.getLogs(filter);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

async function busyChain() {
  const ctx = await chainContext();
  for (let i = 0; i < 4; i += 1) {
    const { listingId } = await listing(ctx);
    const claimId = await commit(ctx, ctx.hunters[i], listingId);
    await disclose(ctx, ctx.hunters[i], claimId);
    await mine(ctx, 3);
  }
  return ctx;
}

describe('a restart mid-sync', () => {
  test('resumes after the last committed chunk with no gap and no event twice', async () => {
    const ctx = await busyChain();
    const env = { SA_LOG_CHUNK_BLOCKS: '4' };
    const reference = siteFor(ctx, { env });
    await reference.sync();
    const expected = view(reference.store.state.events);
    reference.close();
    assert.ok(expected.length > 10);

    const dir = tmpDir();
    const dying = siteFor(ctx, { dir, env, provider: crashingProvider(ctx, 4) });
    await assert.rejects(dying.sync(), (e) => e.code === 'TEST_CRASH');
    const partial = dying.store.state;
    assert.ok(partial.cursor, 'three chunks were committed before the crash');
    assert.equal(partial.cursor.number, ctx.fromBlock + 3 * 4 - 1);
    assert.deepEqual(view(partial.events), expected.filter((e) => e.blockNumber <= partial.cursor.number), 'a consistent prefix');
    dying.close();

    const resumed = siteFor(ctx, { dir, env });
    try {
      const r = await resumed.sync();
      assert.equal(r.from, partial.cursor.number + 1);
      const events = view(resumed.store.state.events);
      assert.deepEqual(events, expected);
      const keys = events.map((e) => `${e.blockHash}:${e.logIndex}`);
      assert.equal(new Set(keys).size, keys.length);
    } finally {
      resumed.close();
    }
  });

  test('a crash in every chunk still converges, one chunk per run', async () => {
    const ctx = await busyChain();
    const env = { SA_LOG_CHUNK_BLOCKS: '5' };
    const reference = siteFor(ctx, { env });
    await reference.sync();
    const expected = view(reference.store.state.events);
    reference.close();

    const dir = tmpDir();
    let runs = 0;
    for (;;) {
      runs += 1;
      const site = siteFor(ctx, { dir, env, provider: crashingProvider(ctx, 2) });
      try {
        await site.sync();
        break;
      } catch (e) {
        assert.equal(e.code, 'TEST_CRASH');
      } finally {
        site.close();
      }
      assert.ok(runs < 100);
    }
    const final = siteFor(ctx, { dir, env });
    try {
      assert.deepEqual(view(final.store.state.events), expected);
    } finally {
      final.close();
    }
  });

  test('a write that never completed leaves the last complete state', async () => {
    const ctx = await chainContext();
    await listing(ctx);
    const dir = tmpDir();
    const site = siteFor(ctx, { dir });
    await site.sync();
    const state = structuredClone(site.store.state);
    site.close();
    // what a process killed between writing the next state and renaming it over the old one leaves
    fs.writeFileSync(path.join(dir, 'state.json.tmp'), '{"version":1,"events":[{"trunc');
    const reopened = siteFor(ctx, { dir });
    try {
      assert.deepEqual(reopened.store.state.cursor, state.cursor);
      assert.deepEqual(reopened.store.state.events, state.events);
      await reopened.sync();
    } finally {
      reopened.close();
    }
  });

  test('a writer that died, or a lock left empty, does not block the next start, and old locks are cleared', async () => {
    const ctx = await chainContext();
    const dir = tmpDir();
    siteFor(ctx, { dir }).close();
    const locks = () => fs.readdirSync(dir).filter((n) => n.startsWith('writer.lock')).sort();
    assert.deepEqual(locks(), [], 'close() removes its own lock');
    fs.writeFileSync(path.join(dir, 'writer.lock.3'), '999999999');
    let site = siteFor(ctx, { dir });
    assert.deepEqual(locks(), ['writer.lock.4']);
    site.close();
    fs.writeFileSync(path.join(dir, 'writer.lock.7'), '');
    fs.writeFileSync(path.join(dir, 'writer.lock.2'), '999999998');
    site = siteFor(ctx, { dir });
    assert.deepEqual(locks(), ['writer.lock.8'], 'every lock below the new one was a dead process\'s');
    site.close();
  });

  test('a live writer keeps the folder, whether it holds the highest lock or took the next one first', async () => {
    const ctx = await chainContext();
    const dir = tmpDir();
    siteFor(ctx, { dir }).close();
    fs.writeFileSync(path.join(dir, 'writer.lock.5'), String(process.pid));
    assert.throws(() => siteFor(ctx, { dir }), (e) => e.code === 'WRITER_ACTIVE');
    // a dead holder at 5, and another process that already took 6
    fs.writeFileSync(path.join(dir, 'writer.lock.5'), '999999999');
    fs.writeFileSync(path.join(dir, 'writer.lock.6'), String(process.pid));
    assert.throws(() => siteFor(ctx, { dir }), (e) => e.code === 'WRITER_ACTIVE');
    assert.equal(fs.readFileSync(path.join(dir, 'writer.lock.6'), 'utf8'), String(process.pid), 'a live lock is never removed');
  });

  test('a process acting on a stale view of the folder backs off from a lock below the live one', () => {
    // A saw an empty folder and paused; B took lock 0 and died; C took lock 1, removed lock 0 and
    // writes. A, resuming, can create lock 0 again, but finds lock 1 above it and gives it up.
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'writer.lock.1'), String(process.pid));
    assert.equal(tryLock(dir, -1), 'lost');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('writer.lock')), ['writer.lock.1']);
    assert.equal(tryLock(dir, 0), 'lost', 'the number is taken');
    assert.equal(tryLock(dir, 1), 'taken', 'the next number, with nothing above it');
  });
});
