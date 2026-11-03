// The stop flag: what a stopping round relies on to get its main flow back. Each test file is a process of
// its own, so the flag set here is set for this file only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

import { RoundStopped, isStopping, onStop, requestStop, sleep, stopProcessesNaming, throwIfStopping, unlessStopped, waitUntil, within } from '../src/proc.js';

test('within: an answer, a failure, or its own time running out, which names what ran out', async () => {
  assert.equal(await within(Promise.resolve(7), 1000, 'a thing'), 7);
  await assert.rejects(within(Promise.reject(new Error('no')), 1000, 'a thing'), /no/);
  await assert.rejects(within(new Promise(() => {}), 20, 'a closer'), /a closer took more than 20 ms/);
});

test('waitUntil before a stop: it waits, gives the value, and says when it timed out', async () => {
  let n = 0;
  assert.equal(await waitUntil('counting', async () => { n += 1; return n > 2 ? 'done' : null; }, { timeoutMs: 1000, everyMs: 1 }), 'done');
  await assert.rejects(waitUntil('never', async () => false, { timeoutMs: 20, everyMs: 1 }), /timed out after 20 ms never/);
});

test('stopping by name: the process that names the run and its whole group, a docker CLI\'s container read off it first, and not someone\'s tail of the logs', async () => {
  const mark = `mark${crypto.randomBytes(6).toString('hex')}`;
  const alive = (id) => {
    try {
      process.kill(id, 0);
      return true;
    } catch {
      return false;
    }
  };
  // A group leader that names the run, and a child in its group that does not: `sh -c` holds the script, which names the mark.
  const step = spawn('sh', ['-c', `sleep 60 & wait # ${mark} --name vab-0123abcd`], { detached: true, stdio: 'ignore' });
  const tail = spawn('sh', ['-c', `sleep 60 # ${mark}/logs`], { detached: true, stdio: 'ignore' });
  try {
    await sleep(200);
    assert.equal(alive(-step.pid), true);
    const r = await stopProcessesNaming([mark], { except: [`${mark}/logs`], graceMs: 3000 });
    assert.deepEqual(r.groups, [step.pid]);
    assert.deepEqual(r.containers, ['vab-0123abcd']);
    assert.equal(alive(-step.pid), false, 'the whole group is gone');
    assert.equal(alive(tail.pid), true, 'someone\'s tail stays');
  } finally {
    for (const c of [step, tail]) {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch { /* gone */ }
    }
  }
});

test('a stop reaches whatever is waiting: waitUntil at once, even on a read that hangs, and what asked to be told', async () => {
  assert.equal(isStopping(), false);
  let told = 0;
  const off = onStop(() => { told += 1; });
  const offTwice = onStop(() => { told += 10; });
  offTwice();
  const waiting = waitUntil('a read that never ends', () => new Promise(() => {}), { timeoutMs: 60000, everyMs: 1 });
  const raced = unlessStopped(new Promise(() => {}));
  await sleep(5);
  const started = Date.now();
  requestStop();
  requestStop();
  await assert.rejects(waiting, RoundStopped);
  await assert.rejects(raced, RoundStopped);
  assert.ok(Date.now() - started < 1000);
  assert.equal(told, 1, 'once, and not what took itself off');
  off();
  assert.equal(isStopping(), true);
  assert.throws(throwIfStopping, RoundStopped);
  await assert.rejects(waitUntil('after the stop', async () => true, { timeoutMs: 1000 }), RoundStopped);
  await assert.rejects(unlessStopped(Promise.resolve(1)), RoundStopped);
  let late = 0;
  onStop(() => { late += 1; });
  assert.equal(late, 1, 'asking after the stop is told at once');
});
