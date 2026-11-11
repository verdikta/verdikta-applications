// Node P18, the hunter's side of the settlement safeguards (design §13.2, errata E7-E9):
// - appeal <claim> reads the live dispute fee from the lens, prints what it costs and asks the same
//   explicit --yes as commit, the other verb that pays; it sends exactly that fee, from the hunter;
// - it re-triggers, once, an appeal whose round settled no verdict, for a fresh full fee;
// - a hunter who settles their own INVALID inside its appeal window waives the appeal: the tool prints
//   that and settles only with --waive-appeal (the library: { waiveAppeal: true });
// - status shows the appeal window, the dispute-panel round's kind, the confirmation's window and a
//   narrow INVALID, all read from the contract (the lens's appealDeadline, confirmWindow,
//   retriggerDeadline and judgeVector).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { closeRpc, runCli } from './helpers/cli.js';
import { JUSTIFICATION_CID, makeClaimDir, makeWorld, vectorOf } from './helpers/world.js';

let w;
before(async () => { w = await makeWorld(); });
after(async () => {
  await closeRpc(w);
  await w.close();
});

const NARROW = [600000n, 0n, 0n, 0n, 400000n, 0n];
const KINDS = ['None', 'Maker', 'Confirmation', 'Appeal'];
const RESULTS = ['None', 'Pending', 'Held', 'Overturned', 'NoVerdict'];

const revealed = async (over = {}) => {
  const l = await w.listing(over);
  const dir = makeClaimDir();
  const { claimId } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  await w.hunter().reveal({ claimDir: dir });
  return { l, dir, claimId };
};
const script = async (claimId, v, { panel = false } = {}) => {
  const c = await w.sa.getClaim(claimId);
  await (await w.aggregator.scriptResult(panel ? c.disputeRequestId : c.requestId, v, JUSTIFICATION_CID)).wait();
};
const judged = async (v = vectorOf('INVALID'), over = {}) => {
  const r = await revealed(over);
  await script(r.claimId, v);
  await (await w.sa.finalize(r.claimId)).wait();
  return r;
};
const owner = (sa) => sa.connect(w.owner);
const gasOf = async (hash) => {
  const rc = await w.provider.getTransactionReceipt(hash);
  return rc.gasUsed * rc.gasPrice;
};
const balance = () => w.provider.getBalance(w.hunterWallet.address);

test('appeal: the live dispute fee from the lens, printed, and nothing sent without --yes', async () => {
  const { dir, claimId, l } = await judged();
  const notices = [];
  const fee = await w.sa.disputeFee(l.listingId);
  await assert.rejects(w.hunter({ onNotice: (t) => notices.push(t) }).appeal({ claimDir: dir }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT' && e.exitCode === 3);
  const text = notices.join('\n');
  assert.match(text, new RegExp(`${w.hre.ethers.formatEther(fee).replace('.', '\\.')} ETH`), 'the cost, in ETH');
  assert.match(text, /dispute panel/);
  assert.match(text, /spent whatever the result/);
  assert.match(text, /comes back/);
  assert.equal(KINDS[Number((await w.sa.getClaim(claimId)).disputeKind)], 'None', 'nothing sent');

  const cli = await runCli(w, ['appeal', dir]);
  assert.equal(cli.code, 3, cli.stderr);
  assert.match(cli.stdout, /dispute panel/);
  assert.match(cli.stderr, /--yes/);
  assert.equal(KINDS[Number((await w.sa.getClaim(claimId)).disputeKind)], 'None');
});

test('appeal --yes: exactly the live fee, from the hunter; the claim goes to the dispute panel as an appeal', async () => {
  const { dir, claimId, l } = await judged();
  const fee = await w.sa.disputeFee(l.listingId);
  const before0 = await balance();
  const r = await w.hunter().appeal({ claimDir: dir, acknowledge: true });
  assert.equal(r.action, 'appeal');
  assert.equal(r.valueWei, fee);
  const tx = await w.provider.getTransaction(r.tx);
  assert.equal(tx.value, fee);
  assert.equal(tx.from, w.hunterWallet.address);
  assert.equal(before0 - (await balance()), fee + await gasOf(r.tx));
  const c = await w.sa.getClaim(claimId);
  assert.equal(KINDS[Number(c.disputeKind)], 'Appeal');
  assert.equal(RESULTS[Number(c.dispute)], 'Pending');
  const s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.state, 'Disputed');
  assert.equal(s.disputeKind, 'Appeal');
  assert.match(s.next, /appeal/i);

  // again: one appeal per claim, refused before anything is sent
  const again = await w.hunter().appeal({ claimDir: dir, acknowledge: true }).catch((e) => e);
  assert.equal(again.code, 'NOT_APPEALABLE');
  assert.equal((await w.sa.getClaim(claimId)).disputeKind, c.disputeKind);
});

test('appeal by claim id through the CLI, and what it refuses: a DUPLICATE, a valid outcome, the window over, another hunter\'s claim', async () => {
  const { claimId } = await judged();
  const cli = await runCli(w, ['appeal', String(claimId), '--yes', '--json']);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).action, 'appeal');
  assert.equal(KINDS[Number((await w.sa.getClaim(claimId)).disputeKind)], 'Appeal');

  const dup = await judged(vectorOf('DUPLICATE'));
  const r1 = await w.hunter().appeal({ claimId: dup.claimId, acknowledge: true }).catch((e) => e);
  assert.equal(r1.code, 'NOT_APPEALABLE');
  assert.match(r1.message, /INVALID/);

  const valid = await judged(vectorOf('HIGH'));
  const r2 = await w.hunter().appeal({ claimId: valid.claimId, acknowledge: true }).catch((e) => e);
  assert.equal(r2.code, 'NOT_APPEALABLE');

  const late = await judged();
  const { disputeWindow } = await w.sa.getListing(late.l.listingId);
  await w.increase(disputeWindow);
  const r3 = await w.hunter().appeal({ claimId: late.claimId, acknowledge: true }).catch((e) => e);
  assert.equal(r3.code, 'NOT_APPEALABLE');
  assert.match(r3.message, /window/);

  const other = await judged();
  const stranger = new w.hre.ethers.Wallet(w.keyOf(7), w.provider);
  const r4 = await w.hunter({ signer: stranger }).appeal({ claimId: other.claimId, acknowledge: true }).catch((e) => e);
  assert.equal(r4.code, 'NOT_YOUR_CLAIM');
  assert.equal(KINDS[Number((await w.sa.getClaim(other.claimId)).disputeKind)], 'None');
});

test('an appeal whose round settled no verdict: appeal re-triggers it once, for a fresh full fee, with --yes; a second round with no verdict leaves nothing to re-trigger', async () => {
  const { dir, claimId, l } = await judged();
  await w.hunter().appeal({ claimDir: dir, acknowledge: true });
  await w.increase(await w.aggregator.responseTimeoutSeconds() + 1n);
  await (await w.sa.finalize(claimId)).wait();
  let s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.state, 'Judged');
  assert.equal(s.disputeKind, 'Appeal');
  assert.equal(s.dispute, 'NoVerdict');
  assert.equal(s.times.retriggerDeadline, await w.sa.retriggerDeadline(claimId));
  assert.ok(s.times.retriggerDeadline > 0n);
  assert.match(s.next, /re-trigger/);

  const notices = [];
  await assert.rejects(w.hunter({ onNotice: (t) => notices.push(t) }).appeal({ claimDir: dir }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
  assert.match(notices.join('\n'), /re-trigger/);
  const fee = await w.sa.retriggerTopUp(claimId);
  assert.equal(fee, await w.sa.disputeFee(l.listingId));
  const r = await w.hunter().appeal({ claimDir: dir, acknowledge: true });
  assert.equal(r.action, 'retrigger');
  assert.equal((await w.provider.getTransaction(r.tx)).value, fee);
  assert.equal((await w.sa.getClaim(claimId)).appealRetriggered, true);
  await w.increase(await w.aggregator.responseTimeoutSeconds() + 1n);
  await (await w.sa.finalize(claimId)).wait();
  const again = await w.hunter().appeal({ claimDir: dir, acknowledge: true }).catch((e) => e);
  assert.equal(again.code, 'NOT_APPEALABLE');
  s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.times.retriggerDeadline, 0n);
  assert.equal(s.times.settleableAt <= s.chainTime, true, 'the INVALID stands, and anyone may settle it now');
});

test('settling your own INVALID inside its window waives the appeal: a warning, and only with --waive-appeal', async () => {
  const { dir, claimId } = await judged();
  const notices = [];
  // the library: settle refuses, the claim stays Judged
  const refused = await w.hunter({ onNotice: (t) => notices.push(t) }).settle(claimId).catch((e) => e);
  assert.equal(refused.code, 'NEEDS_WAIVER');
  assert.equal(refused.exitCode, 3);
  assert.match(notices.join('\n'), /waives/);
  assert.equal(Number((await w.sa.getClaim(claimId)).state), 3, 'still Judged');

  // the verb: claim prints the warning, sends nothing, and says how
  const plain = await runCli(w, ['claim', dir]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /waives the appeal/);
  assert.match(plain.stdout, /--waive-appeal/);
  assert.doesNotMatch(plain.stdout, /Sent settle/);
  assert.equal(Number((await w.sa.getClaim(claimId)).state), 3);

  const waived = await runCli(w, ['claim', dir, '--waive-appeal']);
  assert.equal(waived.code, 0, waived.stderr);
  assert.match(waived.stdout, /waives the appeal/);
  assert.match(waived.stdout, /Sent settle/);
  assert.equal(Number((await w.sa.getClaim(claimId)).state), 5, 'Settled');
});

test('after the window, settling needs no waiver: nothing is waived', async () => {
  const { claimId } = await judged();
  await w.increase((await w.sa.settleableAt(claimId)) - (await w.chainNow()));
  const r = await w.hunter().settle(claimId);
  assert.equal(r.state, 'Settled');
});

test('status: the appeal window, the round kind, a narrow INVALID with its bond, and a confirmation\'s window, from the lens', async () => {
  // a band from 25 points and a confirmation of every counted award, for listings made from now
  await (await owner(w.sa).setNarrowInvalidFloor(250000n)).wait();
  await (await owner(w.sa).setConfirmAboveWei(0n)).wait();
  try {
    const narrow = await judged(NARROW);
    let s = await w.hunter({ signer: undefined }).status({ claimId: narrow.claimId });
    assert.equal(s.outcome, 'INVALID');
    assert.equal(s.narrow, true);
    assert.equal(s.times.appealDeadline, await w.sa.appealDeadline(narrow.claimId));
    assert.ok(s.times.appealDeadline > s.chainTime);
    assert.equal(s.disputeKind, 'None');
    assert.match(s.next, /appeal/);
    assert.match(s.next, /bond comes back/);
    const cli = await runCli(w, ['status', String(narrow.claimId)], { keyVia: 'none' });
    assert.equal(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /Appeal before/);
    assert.match(cli.stdout, /narrow INVALID/);
    await w.increase(s.times.appealDeadline - s.chainTime);
    await (await w.sa.settle(narrow.claimId)).wait();
    s = await w.hunter({ signer: undefined }).status({ claimId: narrow.claimId });
    assert.equal(s.state, 'Settled');
    assert.equal(s.narrow, true);
    assert.equal(s.bond, 'returned');
    assert.match(s.next, /bond came back/);

    const deep = await judged();
    await w.increase((await w.sa.settleableAt(deep.claimId)) - (await w.chainNow()));
    await (await w.sa.settle(deep.claimId)).wait();
    s = await w.hunter({ signer: undefined }).status({ claimId: deep.claimId });
    assert.equal(s.narrow, false);
    assert.equal(s.bond, 'forfeited');

    const high = await judged(vectorOf('HIGH'));
    s = await w.hunter({ signer: undefined }).status({ claimId: high.claimId });
    const [opensAt, deadline] = await w.sa.confirmWindow(high.claimId);
    assert.equal(s.times.confirmOpensAt, opensAt);
    assert.equal(s.times.confirmDeadline, deadline);
    assert.ok(deadline > 0n);
    assert.equal(s.narrow, null);
    assert.equal(s.times.appealDeadline, 0n);
    assert.match(s.next, /confirm/);
    const cliHigh = await runCli(w, ['status', String(high.claimId)], { keyVia: 'none' });
    assert.match(cliHigh.stdout, /Confirmation/);
    await w.increase(opensAt - (await w.chainNow()));
    await (await w.sa.confirm(high.claimId, { gasLimit: 12_000_000 })).wait();
    s = await w.hunter({ signer: undefined }).status({ claimId: high.claimId });
    assert.equal(s.state, 'Disputed');
    assert.equal(s.disputeKind, 'Confirmation');
    assert.match(s.next, /confirmation/);
    const cliKind = await runCli(w, ['status', String(high.claimId)], { keyVia: 'none' });
    assert.match(cliKind.stdout, /Round kind: Confirmation/);
  } finally {
    await (await owner(w.sa).setConfirmAboveWei(w.hre.ethers.MaxUint256)).wait();
    await (await owner(w.sa).setNarrowInvalidFloor(500001n)).wait();
  }
});
