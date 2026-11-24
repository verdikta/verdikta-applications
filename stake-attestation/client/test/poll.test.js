// Pending evaluations are polled for up to 15 minutes (node P6b): watchUntil reads until the
// claim leaves its pending state, or until 15 minutes have passed, and then says which.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AFTER_TX_READS, AFTER_TX_WAIT_MS, POLL_MS, READ_TIMEOUT_MS, WATCH_MS, readFrom, watchUntil, withTimeout } from '../src/lib/poll.js';

/** A fake clock: sleep moves it, nothing waits. */
function clock() {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    advance: (ms) => { t += ms; },
    sleeps,
  };
}

test('the watch is 15 minutes, read every few seconds', () => {
  assert.equal(WATCH_MS, 15 * 60 * 1000);
  assert.ok(POLL_MS >= 1000 && POLL_MS <= 15000);
});

test('it reads until the value is no longer pending', async () => {
  const c = clock();
  const states = ['Revealed', 'Revealed', 'Revealed', 'Judged'];
  const seen = [];
  const r = await watchUntil({ read: async () => states.shift(), done: (s) => s !== 'Revealed', onValue: (s) => seen.push(s), now: c.now, sleep: c.sleep });
  assert.deepEqual(r, { outcome: 'done', value: 'Judged' });
  assert.deepEqual(seen, ['Revealed', 'Revealed', 'Revealed', 'Judged']);
  assert.deepEqual(c.sleeps, [POLL_MS, POLL_MS, POLL_MS]);
});

test('it stops at 15 minutes, starts no read then, and says it timed out', async () => {
  const c = clock();
  let reads = 0;
  const at = [];
  const r = await watchUntil({ read: async () => { reads += 1; at.push(c.now() - 1_000_000); return 'Revealed'; }, done: () => false, now: c.now, sleep: c.sleep });
  assert.deepEqual(r, { outcome: 'timeout', value: 'Revealed' });
  assert.equal(c.sleeps.reduce((a, b) => a + b, 0), WATCH_MS, 'it waits exactly the watch');
  assert.equal(reads, WATCH_MS / POLL_MS);
  assert.ok(at.every((t) => t < WATCH_MS));
});

test('a read that fails is reported and the watch goes on', async () => {
  const c = clock();
  const errors = [];
  let n = 0;
  const r = await watchUntil({
    read: async () => { n += 1; if (n < 3) throw new Error('rpc down'); return 'Settled'; },
    done: (s) => s !== 'Disputed',
    onError: (e) => errors.push(e.message),
    now: c.now,
    sleep: c.sleep,
  });
  assert.deepEqual(r, { outcome: 'done', value: 'Settled' });
  assert.deepEqual(errors, ['rpc down', 'rpc down']);
});

test('a watch whose reads all fail times out with no value', async () => {
  const c = clock();
  const r = await watchUntil({ read: async () => { throw new Error('down'); }, done: () => true, now: c.now, sleep: c.sleep, maxMs: 20000, intervalMs: 5000 });
  assert.deepEqual(r, { outcome: 'timeout', value: undefined });
});

test('an aborted watch ends without a verdict either way', async () => {
  const c = clock();
  const ac = new AbortController();
  let reads = 0;
  const r = await watchUntil({
    read: async () => { reads += 1; if (reads === 2) ac.abort(); return 'Revealed'; },
    done: () => false,
    signal: ac.signal,
    now: c.now,
    sleep: c.sleep,
  });
  assert.deepEqual(r, { outcome: 'aborted' });
  assert.equal(reads, 2);
});

test('the default sleep wakes early when the watch is aborted', async () => {
  const ac = new AbortController();
  const started = Date.now();
  const p = watchUntil({ read: async () => 'Revealed', done: () => false, signal: ac.signal, intervalMs: 60_000 });
  setTimeout(() => ac.abort(), 20);
  assert.deepEqual(await p, { outcome: 'aborted' });
  assert.ok(Date.now() - started < 5000);
});

/**
 * A pending read's limit on the fake clock: it fires a few real ms later, moving the clock by its
 * length, unless the read answered first (the watch then aborts it, and the clock stays).
 */
const fakeDeadline = (c) => (ms, s) => new Promise((resolve) => {
  const t = setTimeout(() => { c.advance(ms); resolve(); }, 5);
  s.addEventListener('abort', () => clearTimeout(t), { once: true });
});
const never = () => new Promise(() => {});

test('a read that never answers ends the watch at its limit, with the time-out', async () => {
  const c = clock();
  const r = await watchUntil({ read: never, done: () => true, now: c.now, sleep: c.sleep, deadline: fakeDeadline(c), maxMs: 20_000 });
  assert.deepEqual(r, { outcome: 'timeout', value: undefined });
  assert.equal(c.now() - 1_000_000, 20_000);
});

test('a read pending at the 15-minute mark does not hold the watch open past it', async () => {
  const c = clock();
  let n = 0;
  const r = await watchUntil({
    read: () => { n += 1; return n < 3 ? Promise.resolve('Revealed') : never(); },
    done: () => false,
    now: c.now,
    sleep: c.sleep,
    deadline: fakeDeadline(c),
  });
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.value, 'Revealed');
  // two reads answer; the reads after them hang, each given at most READ_TIMEOUT_MS and never
  // past the watch: it ends at 15 minutes exactly
  assert.equal(c.now() - 1_000_000, WATCH_MS);
});

test('a slow read counts as failed and the watch reads again', async () => {
  const c = clock();
  const errors = [];
  let n = 0;
  const r = await watchUntil({
    read: () => { n += 1; return n === 1 ? never() : Promise.resolve('Judged'); },
    done: (s) => s === 'Judged',
    onError: (e) => errors.push(e.message),
    now: c.now,
    sleep: c.sleep,
    deadline: fakeDeadline(c),
  });
  assert.deepEqual(r, { outcome: 'done', value: 'Judged' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /longer than/);
  assert.deepEqual(c.sleeps, [POLL_MS]);
});

test('a read is never given more than the time left', async () => {
  const c = clock();
  const limits = [];
  const deadline = (ms, s) => { limits.push(ms); return fakeDeadline(c)(ms, s); };
  const r = await watchUntil({ read: never, done: () => true, now: c.now, sleep: c.sleep, deadline, maxMs: 42_000 });
  assert.equal(r.outcome, 'timeout');
  assert.deepEqual(limits, [READ_TIMEOUT_MS, 42_000 - READ_TIMEOUT_MS - POLL_MS]);
  assert.equal(c.now() - 1_000_000, 42_000);
});

test('withTimeout rejects a promise that does not answer in time and passes one that does', async () => {
  await assert.rejects(withTimeout(never(), 10, 'the claim read'), /the claim read took longer than 10 ms/);
  assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
});

test('an abort ends the watch while a read is pending', async () => {
  const ac = new AbortController();
  const p = watchUntil({ read: never, done: () => true, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  assert.deepEqual(await p, { outcome: 'aborted' });
});

// After a transaction sent from a page is mined, the page reads what it changed again. The site's reader may be a
// block behind the wallet's node: a read from before the transaction's block shows things as they were, and must not
// be taken for the new state (a listing that still reads on hold after it rolled forward, or not on hold after a hold).
test('readFrom: reads until a read is of the transaction\'s block or later, and takes no earlier read for it', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const reads = (blocks) => {
    const left = [...blocks];
    return async () => {
      const b = left.shift();
      if (b instanceof Error) throw b;
      return b === null ? null : { block: b };
    };
  };
  // the first read is already of that block
  assert.deepEqual(await readFrom(reads([90]), 90, { sleep }), { read: { block: 90 }, reached: true });
  assert.deepEqual(sleeps, [], 'no wait before the first read');
  // a reader one block behind catches up on the third read
  assert.deepEqual(await readFrom(reads([89, 89, 91]), 90, { sleep }), { read: { block: 91 }, reached: true });
  assert.deepEqual(sleeps, [AFTER_TX_WAIT_MS, AFTER_TX_WAIT_MS]);
  // it never does: the caller gets the newest read from before the block, marked as not reaching it
  assert.deepEqual(await readFrom(reads([88, 89, 89, 89, 95]), 90, { sleep }), { read: { block: 89 }, reached: false }, `${AFTER_TX_READS} reads, and no more`);
  // a read that fails is tried again, and so is one that takes too long
  assert.deepEqual(await readFrom(reads([new Error('rate limit'), 90]), 90, { sleep }), { read: { block: 90 }, reached: true });
  const slow = [() => new Promise(() => {}), async () => ({ block: 90 })];
  assert.deepEqual(await readFrom(() => slow.shift()(), 90, { sleep, readTimeoutMs: 5 }), { read: { block: 90 }, reached: true });
  assert.deepEqual(await readFrom(reads([new Error('a'), new Error('b'), new Error('c'), new Error('d')]), 90, { sleep }), { read: null, reached: false });
  // with no block to reach (a read after an action that sent nothing), the first read that answers is the one
  assert.deepEqual(await readFrom(reads([7]), 0, { sleep }), { read: { block: 7 }, reached: true });
  // "nothing there" is an answer of a block as any other: one from before the block is not taken, one of it is
  const none = (block) => ({ missing: true, block });
  const answers = [none(89), none(90)];
  assert.deepEqual(await readFrom(async () => answers.shift(), 90, { sleep }), { read: none(90), reached: true });
  // once the answer is no longer wanted, no further read starts
  let asked = 0;
  const r = await readFrom(async () => { asked += 1; return { block: 1 }; }, 90, { sleep, live: () => asked < 2 });
  assert.equal(asked, 2);
  assert.equal(r.reached, false);
  assert.ok(AFTER_TX_READS >= 3 && AFTER_TX_WAIT_MS >= 1000);
});
