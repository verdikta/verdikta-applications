// Acceptance 4: status [--wait] polls a pending evaluation for up to 15 minutes, on a bounded watch; finalize,
// settle and withdraw are library calls with a `claim` verb.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { closeRpc, readJson, runCli, statePath } from './helpers/cli.js';
import { JUSTIFICATION_CID, ORACLE, SMALL_JURY, makeClaimDir, makeWorld, vectorOf } from './helpers/world.js';

let w;
before(async () => { w = await makeWorld(); });
after(async () => {
  await closeRpc(w);
  await w.close();
});

const revealed = async (over = {}) => {
  const l = await w.listing(over);
  const dir = makeClaimDir();
  const { claimId } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  await w.hunter().reveal({ claimDir: dir, acknowledge: true });
  return { l, dir, claimId, requestId: (await w.sa.getClaim(claimId)).requestId };
};
const script = async (requestId, outcome) => (await w.scriptResult(requestId, vectorOf(outcome), JUSTIFICATION_CID)).wait();

/** A clock and sleep the test owns: `sleep` moves the clock. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms) => { t += ms; } };
}

test('status needs no wallet and says what the claim is and what comes next, at each stage', async () => {
  const l = await w.listing({ stake: { fixWindowDays: 14, disclosureGraceHours: 48 } });
  const dir = makeClaimDir();
  const { claimId } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const reader = w.hunter({ signer: undefined });
  let s = await reader.status({ claimId });
  assert.equal(s.state, 'Committed');
  assert.equal(s.claimId, claimId);
  assert.ok(s.times.revealableAt > 0n);
  assert.match(s.next, /fix window/);
  s = await reader.status({ claimDir: dir });
  assert.equal(s.claimId, claimId);
  await w.increase(15 * 86400);
  s = await reader.status({ claimId });
  assert.equal(s.state, 'Revealable');
  assert.match(s.next, /reveal/);
});

test('--wait: polls until the round can be finalized, however soon, and stops', async () => {
  const { claimId, requestId } = await revealed();
  const clock = fakeClock();
  let polls = 0;
  const sleep = async (ms) => {
    polls += 1;
    if (polls === 3) await script(requestId, 'HIGH');
    await clock.sleep(ms);
  };
  const s = await w.hunter({ signer: undefined, now: clock.now, sleep, pollMs: 15000 }).status({ claimId, wait: true });
  assert.equal(s.pending, false);
  assert.equal(s.timedOut, false);
  assert.equal(s.ready, 'finalize');
  assert.match(s.next, /claim/);
  assert.equal(polls, 3);
});

test('--wait stops once the keeper has finalized too', async () => {
  const { claimId, requestId } = await revealed();
  const clock = fakeClock();
  let polls = 0;
  const sleep = async (ms) => {
    polls += 1;
    if (polls === 2) {
      await script(requestId, 'INVALID');
      await (await w.sa.finalize(claimId)).wait();
    }
    await clock.sleep(ms);
  };
  const s = await w.hunter({ signer: undefined, now: clock.now, sleep, pollMs: 15000 }).status({ claimId, wait: true });
  assert.equal(s.state, 'Judged');
  assert.equal(s.pending, false);
});

test('--wait gives up at 15 minutes on the dot, with no read after that, and says what to do', async () => {
  const { claimId } = await revealed();
  const clock = fakeClock();
  const start = clock.now();
  const reads = [];
  const hunter = w.hunter({ signer: undefined, now: clock.now, sleep: clock.sleep, pollMs: 60000, onRead: () => reads.push(clock.now()) });
  const s = await hunter.status({ claimId, wait: true });
  assert.equal(s.pending, true);
  assert.equal(s.timedOut, true);
  assert.ok(clock.now() - start <= 15 * 60 * 1000);
  assert.ok(reads.every((t) => t - start <= 15 * 60 * 1000));
  assert.match(s.next, /still/);
  assert.equal(await hunter.status({ claimId, wait: true, maxWaitMs: 60 * 60 * 1000 }).then((x) => x.timedOut), true);
  assert.ok(clock.now() - start <= 2 * 15 * 60 * 1000, 'no longer than 15 minutes, whatever is asked');
});

test('a read that hangs does not hold the watch past its time', async () => {
  const { claimId } = await revealed();
  const real = w.provider;
  let hang = false;
  const hanging = new Proxy(real, {
    get(target, prop) {
      if (prop === 'call') return (...a) => (hang ? new Promise(() => {}) : target.call(...a));
      if (prop === 'getBlock') return (...a) => (hang ? new Promise(() => {}) : target.getBlock(...a));
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const hunter = w.hunter({ provider: hanging, signer: undefined, pollMs: 5, readTimeoutMs: 20, maxWaitMs: 200 });
  const first = await hunter.status({ claimId });
  assert.equal(first.pending, true);
  hang = true;
  const t0 = Date.now();
  const s = await hunter.status({ claimId, wait: true, maxWaitMs: 200 }).catch((e) => e);
  assert.ok(Date.now() - t0 < 5000, 'bounded');
  assert.ok(s.timedOut === true || s.code === 'RPC_UNAVAILABLE');
});

test('a watch at its limit stops asking: an abandoned read starts nothing more, and the first read of all is inside the limit too', async () => {
  const { claimId } = await revealed();
  let release = () => {};
  let hold = false;
  const asked = [];
  const slow = new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'getBlock') {
        return async (...a) => {
          asked.push('getBlock');
          if (hold) await new Promise((r) => { release = r; });
          return target.getBlock(...a);
        };
      }
      if (prop === 'call') {
        return (...a) => {
          asked.push('call');
          return target.call(...a);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const hunter = w.hunter({ provider: slow, signer: undefined, pollMs: 5, readTimeoutMs: 40 });
  hold = true;
  const err = await hunter.status({ claimId, wait: true, maxWaitMs: 120 }).catch((e) => e);
  assert.equal(err.code, 'RPC_UNAVAILABLE');
  const before_ = asked.length;
  hold = false;
  release(); // the node answers at last, after the watch gave up
  await new Promise((r) => { setTimeout(r, 100); });
  assert.equal(asked.length, before_, 'a read started after the watch ended');
  const stuck = new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'send') return () => new Promise(() => {});
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const t0 = Date.now();
  await assert.rejects(w.hunter({ provider: stuck, signer: undefined, readTimeoutMs: 60_000 }).status({ claimId, wait: true, maxWaitMs: 100 }), (e) => e.code === 'RPC_UNAVAILABLE');
  assert.ok(Date.now() - t0 < 2000, 'the chain check is inside the limit');
  // A chain id that arrives after the watch gave up: the next read is never asked for.
  const later = [];
  let answer = () => {};
  const late = new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'send') return (...a) => new Promise((r) => { answer = () => r(target.send(...a)); });
      if (prop === 'getCode') {
        return (...a) => {
          later.push('getCode');
          return target.getCode(...a);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  await assert.rejects(w.hunter({ provider: late, signer: undefined, readTimeoutMs: 60_000 }).status({ claimId, wait: true, maxWaitMs: 60 }), (e) => e.code === 'RPC_UNAVAILABLE');
  answer();
  await new Promise((r) => { setTimeout(r, 100); });
  assert.deepEqual(later, []);
});

test('the CLI\'s first look at the chain is inside the time asked for', async () => {
  const http = await import('node:http');
  const server = http.createServer(() => { /* never answers */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  const r = await runCli(w, ['status', '1', '--wait', '--max-wait-ms', '300'], { keyVia: 'none', extra: { VERDIKTA_RPC_URL: `http://127.0.0.1:${server.address().port}` } });
  server.closeAllConnections?.();
  server.close();
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /RPC_UNAVAILABLE/);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('a --wait on a claim with nothing pending returns at once', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const { claimId } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const clock = fakeClock();
  const s = await w.hunter({ signer: undefined, now: clock.now, sleep: clock.sleep }).status({ claimId, wait: true });
  assert.equal(s.pending, false);
  assert.equal(clock.sleeps.length, 0);
});

test('the disputed claim\'s round is a pending evaluation too', async () => {
  const { claimId, requestId } = await revealed();
  await script(requestId, 'HIGH');
  await (await w.sa.finalize(claimId)).wait();
  await (await w.sa.connect(w.maker).dispute(claimId, 'bafkreistatementofthemakerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', { value: await w.sa.disputeFee((await w.sa.getClaim(claimId)).listingId) })).wait();
  const s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.state, 'Disputed');
  assert.equal(s.pending, true);
});

test('the library: finalize, settle and withdraw, each one call with the contract\'s reason on refusal', async () => {
  const { claimId, requestId } = await revealed();
  const hunter = w.hunter();
  await assert.rejects(hunter.finalize(claimId), (e) => e.code === 'NOT_READY' && /evaluation not ready/.test(e.message));
  await script(requestId, 'DUPLICATE');
  const f = await hunter.finalize(claimId);
  assert.equal(f.state, 'Judged');
  const before_ = await w.provider.getBalance(w.hunterWallet.address);
  const s = await hunter.settle(claimId);
  assert.equal(s.state, 'Settled');
  assert.equal(s.outcome, 'DUPLICATE');
  assert.ok(await w.provider.getBalance(w.hunterWallet.address) > before_, 'the bond came back');
  await assert.rejects(hunter.settle(claimId), (e) => e.code === 'NOT_READY');
  await assert.rejects(hunter.withdraw(), (e) => e.code === 'NOTHING_TO_WITHDRAW');
  const { ethers } = await import('ethers');
  const fee = new ethers.Wallet(w.keyOf(3), w.provider);
  assert.equal(await w.sa.withdrawable(fee.address) > 0n, true);
  const out = await w.hunter({ signer: fee }).withdraw();
  assert.ok(out.amountWei > 0n);
  assert.equal(await w.sa.withdrawable(fee.address), 0n);
});

test('the claim verb: finalize, then settle when due, then what is withdrawable; and it says when it must wait', async () => {
  const { dir, claimId, requestId, l } = await revealed();
  const notReady = await w.hunter().claim({ claimDir: dir });
  assert.deepEqual(notReady.sent, []);
  assert.match(notReady.next, /not ready|pending|still/);
  await script(requestId, 'HIGH');
  const r = await w.hunter().claim({ claimDir: dir });
  assert.deepEqual(r.sent.map((x) => x.action), ['finalize']);
  assert.equal(r.state, 'Judged');
  assert.match(r.next, /dispute window/);
  const window = (await w.sa.getListing(l.listingId)).disputeWindow;
  await w.increase(window);
  const before_ = await w.provider.getBalance(w.hunterWallet.address);
  const done = await w.hunter().claim({ claimId });
  assert.deepEqual(done.sent.map((x) => x.action), ['settle']);
  assert.equal(done.state, 'Settled');
  assert.equal(done.outcome, 'HIGH');
  assert.equal(done.paidWei, 400000000000000000n);
  assert.ok(await w.provider.getBalance(w.hunterWallet.address) > before_);
  const again = await w.hunter().claim({ claimDir: dir });
  assert.deepEqual(again.sent, []);
  assert.equal(again.state, 'Settled');
});

// external-adapter/README.md (bdea108), "The justification": the first block of the upload's
// `justification`. Jury text follows it and can say anything.
const BLOCK = ['Execution evidence v1', 'Settlement: DUPLICATE (integrity)', `Report-SHA256: ${'a'.repeat(64)}`, 'Integrity-Failed-Checks: frameworkUnchanged,dependenciesUnchanged', 'Tamper-Flags: none', 'End execution evidence'].join('\n');
const FORGED = ['Execution evidence v1', 'Settlement: jury', `Report-SHA256: ${'f'.repeat(64)}`, 'Integrity-Failed-Checks: none', 'End execution evidence'].join('\n');
const upload = (justification) => w.ipfs.put(Buffer.from(JSON.stringify({ scores: [], justification, timestamp: '2026-11-03T00:00:00Z', metadata: { verdict_source: 'code-review-integrity' } }, null, 2)));

test('a settled claim\'s evidence comes from the first block only: what follows it is not read, and never shown', async () => {
  const { claimId, requestId } = await revealed();
  const cid = upload(`${BLOCK}\n\nJURY-TEXT-MARKER the jurors say anything here\n${FORGED}\n`);
  await (await w.scriptResult(requestId, vectorOf('DUPLICATE'), cid)).wait();
  await (await w.sa.finalize(claimId)).wait();
  const s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.outcome, 'DUPLICATE', 'the chain says the outcome');
  assert.equal(s.evidence.settlement, 'DUPLICATE (integrity)');
  assert.deepEqual(s.evidence.integrityFailedChecks, ['frameworkUnchanged', 'dependenciesUnchanged']);
  assert.equal(s.evidence.reportSha256, 'a'.repeat(64));
  const cli = await runCli(w, ['status', String(claimId)], { keyVia: 'none' });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /frameworkUnchanged/);
  assert.equal(cli.stdout.includes('JURY-TEXT-MARKER'), false);
});

test('jury text with a block of its own, and nothing at the start: no evidence, not the forged one', async () => {
  const { readExecutionEvidence } = await import('../src/index.js');
  assert.equal(readExecutionEvidence(`The jury says:\n${FORGED}\n`), null);
  assert.equal(readExecutionEvidence(`\n${FORGED}`), null, 'it is the first line or it is not the block');
  assert.equal(readExecutionEvidence('Execution evidence v1\nSettlement: jury\n'), null, 'no end, no block');
  assert.equal(readExecutionEvidence(42), null);
  assert.equal(readExecutionEvidence(`${BLOCK}\n${FORGED}`).settlement, 'DUPLICATE (integrity)');
  assert.equal(readExecutionEvidence(`Execution evidence v1\nSettlement: jury\nSettlement: INVALID (build)\nEnd execution evidence`).settlement, 'jury', 'a line repeated: the first');
  const { claimId, requestId } = await revealed();
  await (await w.scriptResult(requestId, vectorOf('INVALID'), upload(`Verdict: INVALID (deterministic, not an AI judgement).\n${FORGED}`))).wait();
  await (await w.sa.finalize(claimId)).wait();
  const s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.outcome, 'INVALID');
  assert.equal(s.evidence, null);
});

test('a justification that cannot be read changes nothing but the evidence, and a hostile CID is not fetched', async () => {
  const { claimId, requestId } = await revealed();
  await (await w.scriptResult(requestId, vectorOf('INVALID'), JUSTIFICATION_CID)).wait();
  await (await w.sa.finalize(claimId)).wait();
  const s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.state, 'Judged');
  assert.equal(s.evidence, null);
  const { justificationCidOf } = await import('../src/index.js');
  assert.equal(justificationCidOf('../../etc/passwd'), null);
  assert.equal(justificationCidOf(`${JUSTIFICATION_CID},bafkreisecond`), JUSTIFICATION_CID);
});

test('a failed round says it is one, what it cost and what to do: nothing on-chain says why', async () => {
  const { claimId, requestId, dir } = await revealed();
  await w.expireClaimRound(claimId);
  await (await w.sa.finalize(claimId)).wait();
  assert.equal(requestId.length, 66);
  const s = await w.hunter({ signer: undefined }).status({ claimDir: dir });
  assert.equal(s.state, 'RoundFailed');
  assert.match(s.next, /base fees/);
  assert.match(s.next, /retrigger/);
  assert.match(s.next, /bond comes back to you at expiry \(RoundsUnanswered\)/, 'no round got a result: the bond comes back (E6 on v2)');
  assert.equal(s.juryAnswered, false);
  assert.match(s.next, /says why/);
  assert.match(s.next, /check/);
  assert.ok(s.times.retriggerDeadline > 0n);
});

test('a refused request is not a paid round: nothing spent, the bond comes back if every attempt is refused (E6)', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const { claimId } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  await (await w.aggregator.setPaused(true)).wait();
  const r = await w.hunter().reveal({ claimDir: dir, acknowledge: true });
  await (await w.aggregator.setPaused(false)).wait();
  assert.equal(r.state, 'RoundFailed');
  for (const s of [r, await w.hunter({ signer: undefined }).status({ claimId })]) {
    assert.match(s.next, /refused/);
    assert.match(s.next, /nothing was spent/);
    assert.match(s.next, /bond and the prepay come back/);
    assert.doesNotMatch(s.next, /fresh prepay/);
    assert.doesNotMatch(s.next, /base fees/);
  }
  const { failedRoundNext } = await import('../src/status.js');
  const mixed = failedRoundNext({ deadline: 9n, requestId: `0x${'00'.repeat(32)}`, roundStarted: true });
  assert.match(mixed, /prepay is still held/);
  assert.match(mixed, /bond comes back to you at expiry/);
  const answered = failedRoundNext({ deadline: 9n, requestId: `0x${'00'.repeat(32)}`, roundStarted: true, answered: true });
  assert.match(answered, /bond goes to the maker at expiry \(RoundsFailed\)/);
  const ran = failedRoundNext({ deadline: 9n, requestId: `0x${'11'.repeat(32)}`, roundStarted: true });
  assert.match(ran, /fresh prepay/);
});

test('the CLI: status --wait exits 4 while pending, 0 when done; claim settles; --json is machine readable', async () => {
  const { dir, claimId, requestId } = await revealed();
  const pending = await runCli(w, ['status', dir, '--wait', '--max-wait-ms', '3000'], { keyVia: 'none' });
  assert.equal(pending.code, 4, pending.stderr);
  assert.match(pending.stdout, /Revealed/);
  await script(requestId, 'INVALID');
  const ready = await runCli(w, ['status', String(claimId), '--wait', '--json'], { keyVia: 'none' });
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).ready, 'finalize');
  // A claim round's INVALID waits out its appeal window (erratum E7, node P16): claim finalizes
  // it now and settles it once the window has passed (the tool's own appeal is node P18's).
  const judged = await runCli(w, ['claim', dir]);
  assert.equal(judged.code, 0, judged.stderr);
  assert.match(judged.stdout, /Judged INVALID/);
  assert.doesNotMatch(judged.stdout, /Settled/);
  await w.increase((await w.sa.settleableAt(claimId)) - (await w.chainNow()));
  const claimed = await runCli(w, ['claim', dir]);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.match(claimed.stdout, /Settled/);
  assert.match(claimed.stdout, /INVALID/);
  assert.ok(readJson(statePath(dir)).claimId);
});

// ---------------------------------------------------------------------------------------------------- node P32
// A fresh agent's claim on testnet (Q84 item 3): a round that ended with no verdict read "The round is over: run
// claim to record it." with exit 0, and only status --json said RoundFailed, after the keeper's finalize.

const timeOut = (claimId) => w.expireClaimRound(claimId);

test('P32: a round with no verdict reads as failed from the moment the aggregator\'s timeout fails it, before finalize and after', async () => {
  const { l, dir, claimId } = await revealed();
  await timeOut(claimId); // the aggregator's own rule: drawn and past its deadline with too few commits, the round has failed
  const early = await w.hunter({ signer: undefined }).status({ claimDir: dir });
  assert.equal(early.state, 'Revealed', 'nobody has finalized it');
  assert.equal(early.ready, 'finalize');
  assert.equal(early.roundResult, 'noVerdict');
  assert.equal(early.roundFailed, true);
  assert.equal(early.failedRound.recorded, false);
  assert.equal(early.failedRound.retriggerDeadline, null, 'the lens has none before finalize');
  assert.equal(early.failedRound.retriggerWindow, BigInt((await w.sa.getListing(l.listingId)).revealWindow));
  assert.equal(early.failedRound.retriggerWei, (await w.sa.commitPrice(l.listingId)) - l.params.bondWei, 'a fresh prepay in full, read from the chain');
  assert.match(early.next, /no verdict/);
  assert.match(early.next, /\bcheck\b/);
  assert.match(early.next, /--retrigger/);
  assert.doesNotMatch(early.next, /The round is over: run claim to record it/);

  const waited = await runCli(w, ['status', dir, '--wait', '--max-wait-ms', '5000'], { keyVia: 'none' });
  assert.equal(waited.code, 5, `status --wait has an exit of its own for a round with no verdict: ${waited.stderr}`);
  assert.match(waited.stdout, /no verdict/);
  assert.match(waited.stdout, /--retrigger/);
  const asJson = await runCli(w, ['status', dir, '--wait', '--json'], { keyVia: 'none' });
  assert.equal(asJson.code, 5, asJson.stderr);
  assert.equal(JSON.parse(asJson.stdout).roundFailed, true);

  await (await w.sa.finalize(claimId)).wait();
  const late = await w.hunter({ signer: undefined }).status({ claimDir: dir });
  assert.equal(late.state, 'RoundFailed');
  assert.equal(late.roundFailed, true);
  assert.equal(late.failedRound.recorded, true);
  assert.equal(late.failedRound.retriggerDeadline, await w.sa.retriggerDeadline(claimId));
  assert.equal(late.failedRound.retriggerWei, await w.sa.retriggerTopUp(claimId));
  assert.match(late.next, /no verdict/);
  const after = await runCli(w, ['status', dir, '--wait'], { keyVia: 'none' });
  assert.equal(after.code, 5, after.stderr);
  assert.match(after.stdout, new RegExp(String(late.failedRound.retriggerDeadline)), 'the re-trigger deadline');
  const plain = await runCli(w, ['status', dir], { keyVia: 'none' });
  assert.equal(plain.code, 0, 'a plain status is a read, and exits 0');
});

test('P32: a vector that is no verdict reads as failed before finalize too; a verdict reads as one, exit 0', async () => {
  const bad = await revealed();
  await (await w.scriptResult(bad.requestId, [1000000n, 0n], JUSTIFICATION_CID)).wait(); // two scores, not six
  const s = await w.hunter({ signer: undefined }).status({ claimId: bad.claimId });
  assert.equal(s.state, 'Revealed');
  assert.equal(s.roundResult, 'noVerdict');
  assert.equal(s.roundFailed, true);
  assert.equal(s.roundAnswered, true, 'the jury answered, with no verdict');
  assert.match(s.next, /bond goes to the maker at expiry \(RoundsFailed\)/);
  await (await w.sa.finalize(bad.claimId)).wait();
  const after = await w.hunter({ signer: undefined }).status({ claimId: bad.claimId });
  assert.equal(after.juryAnswered, true);
  assert.match(after.next, /bond goes to the maker at expiry \(RoundsFailed\)/);
  const good = await revealed();
  await script(good.requestId, 'HIGH');
  const g = await w.hunter({ signer: undefined }).status({ claimId: good.claimId });
  assert.equal(g.roundResult, 'verdict');
  assert.equal(g.roundFailed, false);
  assert.equal(g.failedRound, null);
  const cli = await runCli(w, ['status', String(good.claimId), '--wait'], { keyVia: 'none' });
  assert.equal(cli.code, 0, cli.stderr);
});

test('P32: a slow round still open is never read as failed, however long the watch has run', async () => {
  // the listing's own jury sets the round's timeout (one aggregator serves every jury): an hour from the draw
  const { dir } = await revealed({ oracle: { ...ORACLE, jury: { ...SMALL_JURY, timeout: 3600 } } });
  await w.draw((await w.sa.getClaim((await w.hunter({ signer: undefined }).status({ claimDir: dir })).claimId)).requestId);
  await w.increase(20 * 60); // past the watch's 15 minutes, inside the listing's jury timeout from the draw
  const s = await w.hunter({ signer: undefined }).status({ claimDir: dir });
  assert.equal(s.state, 'Revealed');
  assert.equal(s.pending, true);
  assert.equal(s.ready, null);
  assert.equal(s.roundResult, null);
  assert.equal(s.roundFailed, false);
  assert.equal(s.failedRound, null);
  assert.match(s.next, /drawn and open/);
  const cli = await runCli(w, ['status', dir, '--wait', '--max-wait-ms', '400'], { keyVia: 'none' });
  assert.equal(cli.code, 4, `out of time, not failed: ${cli.stderr}`);
  assert.doesNotMatch(cli.stdout, /no verdict/);
});

test('P32: a failed round of a larger jury reports that round\'s own jury (getJury): its timeout, and its M for where the rest goes', async () => {
  const LARGE = { K: 21, M: 16, N: 13, P: 10, timeout: 900 };
  const t = await revealed({ oracle: { ...ORACLE, jury: LARGE } });
  const j = await w.aggregator.getJury(t.requestId);
  assert.deepEqual([j.K, j.M, j.N, j.P, j.timeout].map(Number), [21, 16, 13, 10, 900], 'the request carried the listing\'s jury');
  await w.draw(t.requestId);
  // 15 commits: at least Small's M (5), below this round's M (16), so the rest comes back to the hunter
  await (await w.aggregator.scriptCommits(t.requestId, 15)).wait();
  await timeOut(t.claimId);
  const s = await w.hunter({ signer: undefined }).status({ claimDir: t.dir });
  assert.equal(s.roundFailed, true);
  assert.deepEqual(s.failedRound.jury, { K: 21, M: 16, N: 13, P: 10, timeout: 900n });
  assert.equal(s.failedRound.refundTo, 'hunter', 'fewer commits than the round\'s M');
  assert.match(s.next, /the listing's jury timeout, 900 s/);
  // the commit notice names the listing's jury before anything is paid
  const dry = await runCli(w, ['commit', makeClaimDir(), '--listing', String(t.l.listingId)]);
  assert.match(dry.stdout + dry.stderr, /Jury: 21 arbiters drawn, 16 promoted to reveal, the first 13 reveals counted and the closest 10 averaged; a round has 900 s from the draw\./);
});

test('P32: a committed, disclosed claim says it is disclosed and in its fix window, in the text and in --json', async () => {
  const l = await w.listing({ stake: { fixWindowDays: 14, disclosureGraceHours: 48 } });
  const dir = makeClaimDir();
  await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const s = await w.hunter({ signer: undefined }).status({ claimDir: dir });
  assert.equal(s.state, 'Committed');
  assert.equal(s.disclosed, true);
  assert.equal(s.inFixWindow, true);
  const text = await runCli(w, ['status', dir], { keyVia: 'none' });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /: Committed, disclosed, in its fix window/);
  const json = JSON.parse((await runCli(w, ['status', dir, '--json'], { keyVia: 'none' })).stdout);
  assert.equal(json.disclosed, true);
  assert.equal(json.inFixWindow, true);
  // committed, not disclosed: says so
  const undisclosed = makeClaimDir();
  await w.hunter({ onStep: (x) => { if (x === 'commit:saved') throw new Error('stop'); } }).commit({ claimDir: undisclosed, listingId: l.listingId, acknowledge: true }).catch(() => {});
  const u = await w.hunter({ signer: undefined }).status({ claimDir: undisclosed });
  assert.equal(u.disclosed, false);
  assert.equal(u.inFixWindow, false);
  assert.match((await runCli(w, ['status', undisclosed], { keyVia: 'none' })).stdout, /: Committed, not disclosed/);
});

test('P32: status reads the reveal deadline from the chain and says when a release moved it earlier than the tool said', async () => {
  const l = await w.listing({ stake: { fixWindowDays: 14, disclosureGraceHours: 48 } });
  const dir = makeClaimDir();
  const printed = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes']);
  assert.equal(printed.code, 0, printed.stderr);
  const { claimId } = readJson(statePath(dir));
  const told = (await w.sa.claimTimes(claimId)).revealDeadline;
  assert.ok(told > 0n);
  assert.ok(printed.stdout.includes(`Reveal before ${told}`), 'commit printed the reveal deadline');
  assert.equal(readJson(statePath(dir)).told.revealDeadline, String(told), 'and recorded it');
  const before_ = await w.hunter({ signer: undefined }).status({ claimDir: dir });
  assert.equal(before_.revealDeadlineMoved, null);

  await (await w.sa.connect(w.maker).release(claimId)).wait();
  const now = (await w.sa.claimTimes(claimId)).revealDeadline;
  assert.ok(now < told, 'the release ended the fix window, and the deadline came with it');
  const s = await w.hunter({ signer: undefined }).status({ claimDir: dir });
  assert.equal(s.times.revealDeadline, now, 'the chain\'s');
  assert.deepEqual(s.revealDeadlineMoved, { from: told, to: now, cause: 'release' });
  const cli = await runCli(w, ['status', dir], { keyVia: 'none' });
  assert.match(cli.stdout, new RegExp(`Reveal before ${now}`));
  assert.match(cli.stdout, new RegExp(`moved earlier[^\\n]*${told}`));
  assert.match(cli.stdout, /released/);
  // by its id there is no record of what the hunter was told: the chain's facts, and no claim that it moved
  const byId = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(byId.revealDeadlineMoved, null);
  assert.equal(byId.released, true);
  const idText = await runCli(w, ['status', String(claimId)], { keyVia: 'none' });
  assert.match(idText.stdout, /released/);
  assert.doesNotMatch(idText.stdout, /moved/);
});

test('P32: a failed round\'s cost is its own numbers in ETH (getRoundInfo), with where the rest went and no dollar figure', async () => {
  const { ABSTAIN_COSTS, ABSTAIN_BY_CLAIM, ABSTAIN_BY_HOST, retriggerNotice } = await import('../src/index.js');
  for (const text of [ABSTAIN_COSTS, ABSTAIN_BY_CLAIM, ABSTAIN_BY_HOST, retriggerNotice({ claimId: 1n, valueWei: 1n, deadline: 2n })]) assert.doesNotMatch(text, /\$/, text);
  // the listing's oracle fee is 0.00012 ETH; the v2 mock escrows 18 of it (K + B x P + the draw and promote rewards).
  // Drawn by a stranger within 30 s (no reward), the six jurors' base fees take 0.00072 ETH, and with too few commits
  // the other 0.00144 ETH comes back to the hunter.
  const { dir, claimId } = await revealed();
  assert.equal((await w.sa.getClaim(claimId)).prepayWei, 2160000000000000n);
  await timeOut(claimId);
  for (const finalized of [false, true]) {
    if (finalized) await (await w.sa.finalize(claimId)).wait();
    const s = await w.hunter({ signer: undefined }).status({ claimDir: dir });
    assert.equal(s.state, finalized ? 'RoundFailed' : 'Revealed');
    assert.equal(s.failedRound.prepayWei, 2160000000000000n);
    assert.equal(s.failedRound.spentWei, 720000000000000n);
    assert.equal(s.failedRound.refundWei, 1440000000000000n);
    assert.equal(s.failedRound.refundTo, 'hunter');
    for (const amount of ['0.00072 ETH', '0.00216 ETH', '0.00144 ETH']) assert.ok(s.next.includes(amount), `${amount}: ${s.next}`);
    assert.doesNotMatch(s.next, /treasury, not back to you/);
    assert.match(s.next, /bond comes back to you at expiry/);
    assert.doesNotMatch(s.next, /\$/);
  }
  // M commits that nobody promoted: the aggregator sends the rest to its treasury, before finalize and after
  const t = await revealed();
  await w.draw(t.requestId);
  await (await w.aggregator.scriptCommits(t.requestId, 5)).wait();
  await timeOut(t.claimId);
  for (const finalized of [false, true]) {
    if (finalized) await (await w.sa.finalize(t.claimId)).wait();
    const s = await w.hunter({ signer: undefined }).status({ claimId: t.claimId });
    assert.equal(s.failedRound.refundTo, 'treasury');
    assert.match(s.next, /to its treasury, not back to you/);
  }
});

// Claims on a listing reveal in commit order (decision D5; ClaimLogic.revealDeadline). A hunter whose claim sat behind
// another's read "in its fix window" and then a reveal deadline of 0, with nothing to say why (tester bounty 400).
test('claims reveal in commit order: status names the earlier claim yours waits for, before and after a release, and no longer once it is settled', async () => {
  const l = await w.listing({ stake: { fixWindowDays: 14, disclosureGraceHours: 48 } });
  const first = makeClaimDir();
  const second = makeClaimDir();
  const a = await w.hunter().commit({ claimDir: first, listingId: l.listingId, acknowledge: true });
  const b = await w.hunter().commit({ claimDir: second, listingId: l.listingId, acknowledge: true });
  const read = (claimDir) => w.hunter({ signer: undefined }).status({ claimDir });
  // the first claim heads the queue: it waits for none, and its text is as before
  const head = await read(first);
  assert.equal(head.waitsFor, null);
  assert.doesNotMatch(head.next, /commit order/);
  // the second, in its fix window: it waits for the first, and status says so
  const inWindow = await read(second);
  assert.equal(inWindow.state, 'Committed');
  assert.equal(inWindow.waitsFor, a.claimId);
  assert.match(inWindow.next, new RegExp(`Claim ${a.claimId} was committed on this listing before yours and is neither settled nor expired`));
  assert.match(inWindow.next, /claims reveal in commit order/);
  // released by the maker: past its fix window, and it still cannot be revealed. No deadline, and why
  await (await w.sa.connect(w.maker).release(b.claimId)).wait();
  const released = await read(second);
  assert.equal(released.state, 'Revealable');
  assert.equal(released.times.revealDeadline, 0n, 'the chain sets no deadline behind an earlier claim');
  assert.equal(released.waitsFor, a.claimId);
  assert.match(released.next, /The fix window is over, and the claim still waits\./);
  assert.match(released.next, new RegExp(`Claim ${a.claimId} was committed on this listing before yours`));
  assert.match(released.next, /until then it reads 0/);
  assert.match(released.next, /If that claim is abandoned, it leaves the queue only when someone calls expire on it after its own deadline: anyone may/);
  await assert.rejects(w.hunter().reveal({ claimDir: second, acknowledge: true }), (e) => e.code === 'OUT_OF_ORDER');
  const cli = await runCli(w, ['status', second], { keyVia: 'none' });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`Claim ${a.claimId} was committed on this listing before yours`));
  assert.doesNotMatch(cli.stdout, /Reveal before/, 'no deadline is printed while the chain has none');
  const json = JSON.parse((await runCli(w, ['status', second, '--json'], { keyVia: 'none' })).stdout);
  assert.equal(json.waitsFor, String(a.claimId));
  assert.equal(json.times.revealDeadline, '0');
  // the first claim settles: the second heads the queue, has its deadline, and waits for none
  await (await w.sa.connect(w.maker).release(a.claimId)).wait();
  await w.hunter().reveal({ claimDir: first, acknowledge: true });
  await script((await w.sa.getClaim(a.claimId)).requestId, 'DUPLICATE');
  await w.hunter().finalize(a.claimId);
  await w.hunter().settle(a.claimId);
  const freed = await read(second);
  assert.equal(freed.waitsFor, null);
  assert.ok(freed.times.revealDeadline > 0n);
  assert.match(freed.next, new RegExp(`Run reveal before ${freed.times.revealDeadline}`));
  assert.doesNotMatch(freed.next, /commit order/);
});
