// Pending evaluations are polled for up to 15 minutes (node P6b): watchUntil reads until the
// claim leaves its pending state, or until 15 minutes have passed, and then says which.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POLL_MS, WATCH_MS, watchUntil } from '../src/lib/poll.js';

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

test('it stops after 15 minutes, with a last read at the end, and says it timed out', async () => {
  const c = clock();
  let reads = 0;
  const r = await watchUntil({ read: async () => { reads += 1; return 'Revealed'; }, done: () => false, now: c.now, sleep: c.sleep });
  assert.deepEqual(r, { outcome: 'timeout', value: 'Revealed' });
  assert.equal(c.sleeps.reduce((a, b) => a + b, 0), WATCH_MS, 'it waits exactly the watch, the last sleep cut short');
  assert.equal(reads, Math.ceil(WATCH_MS / POLL_MS) + 1);
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
