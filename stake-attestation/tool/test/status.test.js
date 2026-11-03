// Acceptance 4: status [--wait] polls a pending evaluation for up to 15 minutes, on a bounded watch; finalize,
// settle and withdraw are library calls with a `claim` verb.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { closeRpc, readJson, runCli, statePath } from './helpers/cli.js';
import { JUSTIFICATION_CID, makeClaimDir, makeWorld, vectorOf } from './helpers/world.js';

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
  await w.hunter().reveal({ claimDir: dir });
  return { l, dir, claimId, requestId: (await w.sa.getClaim(claimId)).requestId };
};
const script = async (requestId, outcome) => (await w.aggregator.scriptResult(requestId, vectorOf(outcome), JUSTIFICATION_CID)).wait();

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
  await (await w.aggregator.scriptResult(requestId, vectorOf('DUPLICATE'), cid)).wait();
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
  await (await w.aggregator.scriptResult(requestId, vectorOf('INVALID'), upload(`Verdict: INVALID (deterministic, not an AI judgement).\n${FORGED}`))).wait();
  await (await w.sa.finalize(claimId)).wait();
  const s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.outcome, 'INVALID');
  assert.equal(s.evidence, null);
});

test('a justification that cannot be read changes nothing but the evidence, and a hostile CID is not fetched', async () => {
  const { claimId, requestId } = await revealed();
  await (await w.aggregator.scriptResult(requestId, vectorOf('INVALID'), JUSTIFICATION_CID)).wait();
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
  await w.increase(await w.aggregator.responseTimeoutSeconds() + 1n);
  await (await w.sa.finalize(claimId)).wait();
  assert.equal(requestId.length, 66);
  const s = await w.hunter({ signer: undefined }).status({ claimDir: dir });
  assert.equal(s.state, 'RoundFailed');
  assert.match(s.next, /base fees/);
  assert.match(s.next, /retrigger/);
  assert.match(s.next, /bond goes to the maker/);
  assert.match(s.next, /says why/);
  assert.match(s.next, /check/);
  assert.ok(s.times.retriggerDeadline > 0n);
});

test('the CLI: status --wait exits 4 while pending, 0 when done; claim settles; --json is machine readable', async () => {
  const { dir, claimId, requestId } = await revealed();
  const pending = await runCli(w, ['status', dir, '--wait', '--max-wait-ms', '30'], { keyVia: 'none' });
  assert.equal(pending.code, 4, pending.stderr);
  assert.match(pending.stdout, /Revealed/);
  await script(requestId, 'INVALID');
  const ready = await runCli(w, ['status', String(claimId), '--wait', '--json'], { keyVia: 'none' });
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).ready, 'finalize');
  const claimed = await runCli(w, ['claim', dir]);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.match(claimed.stdout, /Settled/);
  assert.match(claimed.stdout, /INVALID/);
  assert.ok(readJson(statePath(dir)).claimId);
});
