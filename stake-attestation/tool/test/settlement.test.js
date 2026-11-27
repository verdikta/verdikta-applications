// Node P33 (issue #205): on a Settled claim, claim and status say how it settled, from the Settled event: the outcome,
// what the settle paid and left owed in ETH, its transaction and block, and who sent it: this run, the hunter's own
// address in an earlier run, or another address (the site's keeper). A settle this run sends is read from its own
// receipt. Any other is looked for only in the blocks of the claim's settledAt, in pages the RPC's eth_getLogs cap
// takes, and when it is not there the tool says so and names no sender.
//
// This file's chain makes blocks that share a second, as Base does (five a second), and caps eth_getLogs as a public
// RPC does (helpers/chain.js logLimits).
process.env.SA_TOOL_TEST_SHARED_TIMESTAMPS = '1';

const { test, before, after, beforeEach } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { ethers } = await import('ethers');
const { closeRpc, rpcOf, runCli } = await import('./helpers/cli.js');
const { JUSTIFICATION_CID, REPORT, makeClaimDir, makeWorld, vectorOf } = await import('./helpers/world.js');

let w;
let keeper;
before(async () => {
  w = await makeWorld();
  keeper = w.signers[9]; // stands for the site's keeper: an address that is neither the hunter's nor this run's
});
after(async () => {
  await closeRpc(w);
  await w.close();
});
/** From here on eth_getLogs takes at most `maxBlocks` blocks (null: any), and what was asked before is forgotten. */
function capLogs(maxBlocks) {
  w.logLimits.maxBlocks = maxBlocks;
  w.logLimits.calls.length = 0;
  w.logLimits.blockReads = 0;
}
beforeEach(() => capLogs(null));

const eth = (s) => ethers.parseEther(s);
const script = async (claimId, outcome) => (await w.scriptResult((await w.sa.getClaim(claimId)).requestId, vectorOf(outcome), JUSTIFICATION_CID)).wait();

/** A committed claim's folder, revealed and finalized to `outcome`. */
async function judge(dir, claimId, outcome) {
  await w.hunter().reveal({ claimDir: dir, acknowledge: true });
  await script(claimId, outcome);
  await (await w.sa.finalize(claimId)).wait();
}

async function judged(outcome, over = {}) {
  const l = await w.listing(over);
  const dir = makeClaimDir();
  const { claimId } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  await judge(dir, claimId, outcome);
  return { l, dir, claimId };
}

async function settleable(claimId) {
  const wait = (await w.sa.settleableAt(claimId)) - (await w.chainNow());
  if (wait > 0n) await w.increase(wait);
}

/** The Settled event of a receipt, as the chain wrote it. */
function settledOf(rc) {
  const e = rc.logs.map((l) => { try { return w.sa.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'Settled');
  assert.ok(e, 'the settle emitted Settled');
  return e.args;
}

const tsOf = async (n) => BigInt((await w.provider.getBlock(n)).timestamp);

/** Every eth_getLogs asked for: in the blocks of `settledAt` only, and the ones answered within the cap. */
async function assertBoundedSearch(settledAt, cap) {
  const calls = w.logLimits.calls.filter((c) => c.fromBlock !== undefined);
  assert.ok(calls.length >= 1, 'it looked for the event');
  for (const c of calls) {
    assert.equal(await tsOf(c.fromBlock), settledAt, `block ${c.fromBlock} is one of the settle's second`);
    assert.equal(await tsOf(c.toBlock), settledAt, `block ${c.toBlock} is one of the settle's second`);
    if (!c.refused) assert.ok(c.blocks <= cap, `${c.blocks} blocks within the cap of ${cap}`);
  }
  return calls;
}

test('settled by the keeper: status and claim say another address sent it, with the event\'s outcome, amounts, transaction and block', async () => {
  const { dir, claimId } = await judged('HIGH');
  assert.equal((await w.hunter({ signer: undefined }).status({ claimId })).settlement, null, 'nothing to say before it settles');
  await settleable(claimId);
  const rc = await (await w.sa.connect(keeper).settle(claimId)).wait();
  const ev = settledOf(rc);
  capLogs(3);

  const s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.state, 'Settled');
  assert.deepEqual(
    { found: s.settlement.found, by: s.settlement.by, from: s.settlement.from, tx: s.settlement.tx, block: s.settlement.block },
    { found: true, by: 'other', from: keeper.address, tx: rc.hash, block: rc.blockNumber },
  );
  assert.equal(s.settlement.outcome, 'HIGH');
  assert.equal(s.settlement.paidWei, ev.paidWei);
  assert.equal(s.settlement.owedWei, ev.owedWei);
  assert.equal(s.settlement.paidWei, eth('0.4'));
  assert.equal(s.settlement.paidEth, '0.4');
  assert.equal(s.settlement.owedEth, '0.0');
  await assertBoundedSearch((await w.sa.getClaim(claimId)).settledAt, 3);
  assert.ok(w.logLimits.blockReads <= 64, `the settle's blocks are found in a bounded number of reads (${w.logLimits.blockReads})`);

  // the claim verb has nothing to send, and says the same
  const c = await w.hunter().claim({ claimDir: dir });
  assert.deepEqual(c.sent, []);
  assert.equal(c.settlement.by, 'other');
  assert.equal(c.settlement.tx, rc.hash);

  for (const verb of ['claim', 'status']) {
    const text = await runCli(w, [verb, dir]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`Settle transaction ${rc.hash}, block ${rc.blockNumber}`));
    assert.match(text.stdout, new RegExp(`another address, ${keeper.address}`));
    assert.match(text.stdout, /Settled event: HIGH, paid 0\.4 ETH, owed 0\.0 ETH/);
    assert.doesNotMatch(text.stdout, /this run|you settled|your own|hunter's own address/i, `${verb} never says the hunter settled it`);
    const json = await runCli(w, [verb, dir, '--json']);
    assert.equal(json.code, 0, json.stderr);
    const st = JSON.parse(json.stdout).settlement;
    assert.deepEqual({ found: st.found, by: st.by, from: st.from, tx: st.tx, block: st.block, outcome: st.outcome, paidWei: st.paidWei, owedWei: st.owedWei, paidEth: st.paidEth, owedEth: st.owedEth }, {
      found: true, by: 'other', from: keeper.address, tx: rc.hash, block: rc.blockNumber, outcome: 'HIGH', paidWei: eth('0.4').toString(), owedWei: '0', paidEth: '0.4', owedEth: '0.0',
    });
  }
  const capped = w.logLimits.calls.filter((x) => x.fromBlock !== undefined && !x.refused);
  assert.ok(capped.every((x) => x.blocks <= 3), 'the CLI\'s searches too stay within the cap');
});

test('settled by this run: claim reports it from its own receipt, and later runs say the hunter\'s own address sent it', async () => {
  const { dir, claimId } = await judged('HIGH');
  await settleable(claimId);
  capLogs(3);
  const r = await w.hunter().claim({ claimDir: dir });
  assert.deepEqual(r.sent.map((x) => x.action), ['settle']);
  const sent = r.sent[0];
  const rc = await w.provider.getTransactionReceipt(sent.tx);
  const ev = settledOf(rc);
  const expected = { found: true, by: 'thisRun', from: w.hunterWallet.address, tx: sent.tx, block: rc.blockNumber, outcome: 'HIGH', paidWei: ev.paidWei, owedWei: ev.owedWei, paidEth: '0.4', owedEth: '0.0' };
  const pick = (st) => Object.fromEntries(Object.keys(expected).map((k) => [k, st[k]]));
  assert.deepEqual(pick(sent.settlement), expected);
  assert.deepEqual(pick(r.settlement), expected, 'the claim\'s own report says this run');
  assert.equal(sent.block, rc.blockNumber);
  assert.equal(w.logLimits.calls.length, 0, 'read from its own receipt: no search');

  // a later status, or claim, did not send it: the hunter's own address did, earlier
  for (const later of [await w.hunter({ signer: undefined }).status({ claimId }), await w.hunter().claim({ claimId })]) {
    assert.deepEqual(pick(later.settlement), { ...expected, by: 'hunter' });
  }
  const text = await runCli(w, ['status', dir]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`the hunter's own address, ${w.hunterWallet.address}, in an earlier run`));
  assert.doesNotMatch(text.stdout, /this run|another address/);

  // the CLI's own settle: "this run", in text and in --json
  for (const json of [false, true]) {
    const d = await judged('DUPLICATE');
    const out = await runCli(w, ['claim', d.dir, ...(json ? ['--json'] : [])]);
    assert.equal(out.code, 0, out.stderr);
    if (json) {
      const got = JSON.parse(out.stdout);
      assert.equal(got.settlement.by, 'thisRun');
      assert.equal(got.sent[0].settlement.by, 'thisRun');
      assert.equal(got.settlement.tx, got.sent[0].tx);
      assert.equal(got.settlement.outcome, 'DUPLICATE');
      assert.equal(got.settlement.paidEth, '0.0');
    } else {
      const tx = /Sent settle: (0x[0-9a-f]{64})/.exec(out.stdout)?.[1];
      assert.ok(tx, out.stdout);
      assert.match(out.stdout, new RegExp(`Settle transaction ${tx}, block \\d+, sent by this run`));
      assert.match(out.stdout, /Settled event: DUPLICATE, paid 0\.0 ETH, owed 0\.0 ETH/);
      assert.doesNotMatch(out.stdout, /another address|earlier run/);
    }
  }
});

test('settled with an amount owed: the event\'s paid and owed, not the claim\'s record once the maker has paid the rest', async () => {
  const l = await w.listing();
  const first = makeClaimDir();
  // a different finding: a second valid claim of the SAME archive would settle DUPLICATE (review #9)
  const second = makeClaimDir({ report: `${REPORT}\nA second, distinct finding.\n` });
  const a = await w.hunter().commit({ claimDir: first, listingId: l.listingId, acknowledge: true });
  const b = await w.hunter().commit({ claimDir: second, listingId: l.listingId, acknowledge: true });
  // the first award (HIGH) leaves the escrow short of the second's (CRITICAL)
  await judge(first, a.claimId, 'HIGH');
  await settleable(a.claimId);
  await (await w.sa.connect(keeper).settle(a.claimId)).wait();
  await judge(second, b.claimId, 'CRITICAL');
  await settleable(b.claimId);
  const r = await w.hunter().claim({ claimDir: second });
  assert.deepEqual(r.sent.map((x) => x.action), ['settle']);
  const ev = settledOf(await w.provider.getTransactionReceipt(r.sent[0].tx));
  assert.equal(ev.owedWei, eth('0.4'), 'the fixture: 2 ETH awarded, 1.6 ETH in escrow');
  for (const st of [r.sent[0].settlement, r.settlement]) {
    assert.equal(st.by, 'thisRun');
    assert.equal(st.paidWei, eth('1.6'));
    assert.equal(st.owedWei, eth('0.4'));
    assert.equal(st.paidEth, '1.6');
    assert.equal(st.owedEth, '0.4');
  }
  assert.equal(r.paidWei, eth('1.6'));
  assert.equal(r.owedWei, eth('0.4'));

  // the maker's next fund pays what was owed: the claim's record moves on, and the settle's event says what it was
  await (await w.sa.connect(w.maker).fund(l.listingId, 0n, { value: eth('1') })).wait();
  const record = await w.sa.getClaim(b.claimId);
  assert.equal(record.owedWei, 0n);
  assert.equal(record.paidWei, eth('2'));
  capLogs(2);
  const s = await w.hunter({ signer: undefined }).status({ claimId: b.claimId });
  assert.equal(s.paidWei, eth('2'), 'the claim\'s record');
  assert.equal(s.settlement.by, 'hunter');
  assert.equal(s.settlement.paidWei, eth('1.6'), 'the event\'s amount, not computed from the record');
  assert.equal(s.settlement.owedWei, eth('0.4'));
  await assertBoundedSearch(record.settledAt, 2);
  const text = await runCli(w, ['status', String(b.claimId)], { keyVia: 'none' });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Settled event: CRITICAL, paid 1\.6 ETH, owed 0\.4 ETH/);
});

test('an event outside a capped page: the settle\'s second is read in pages the cap takes, past the first, and nowhere else', async () => {
  const { claimId } = await judged('DUPLICATE');
  // a second no block has yet: six blocks in it before the settle and one after, as Base fills a second
  const second = Number(await w.chainNow()) + 30;
  for (let i = 0; i < 6; i += 1) await w.rpc('evm_mine', [second]);
  await w.rpc('evm_setNextBlockTimestamp', [second]);
  const rc = await (await w.sa.connect(keeper).settle(claimId)).wait();
  await w.rpc('evm_mine', [second]);
  await w.increase(5); // the next block is in a later second

  assert.equal(await tsOf(rc.blockNumber), BigInt(second));
  capLogs(2);

  const s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.settlement.found, true);
  assert.equal(s.settlement.tx, rc.hash);
  assert.equal(s.settlement.by, 'other');
  const calls = await assertBoundedSearch(BigInt(second), 2);
  const answered = calls.filter((c) => !c.refused);
  assert.ok(calls.some((c) => c.refused), 'a page over the cap is refused, and the tool asks for less');
  assert.ok(answered.length >= 3, `the event is past the first two pages of two blocks (${answered.length})`);
  assert.ok(answered.every((c) => c.fromBlock >= rc.blockNumber - 6 && c.toBlock <= rc.blockNumber + 1), 'only that second\'s eight blocks');
});

test('a long chain after the settle: the settle\'s blocks are found by their times, with no scan', async () => {
  const { claimId } = await judged('DUPLICATE');
  const rc = await (await w.sa.connect(keeper).settle(claimId)).wait();
  await w.rpc('hardhat_mine', ['0x30d40', '0x1']); // 200,000 blocks, a second apart
  capLogs(5);
  const s = await w.hunter({ signer: undefined }).status({ claimId });
  assert.equal(s.settlement.found, true);
  assert.equal(s.settlement.tx, rc.hash);
  assert.equal(s.settlement.block, rc.blockNumber);
  await assertBoundedSearch((await w.sa.getClaim(claimId)).settledAt, 5);
  assert.ok(w.logLimits.blockReads <= 64, `a bounded number of block reads (${w.logLimits.blockReads})`);
});

test('when the event is not in the settle\'s blocks, or cannot be read, it says so plainly and names no sender', async () => {
  const { dir, claimId } = await judged('DUPLICATE');
  const rc = await (await w.sa.connect(keeper).settle(claimId)).wait();
  const { settlementLines } = await import('../src/settlement.js');
  const wrapped = (getLogs) => new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'getLogs') return getLogs;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  // an RPC that answers with no logs: the blocks were searched, and the event is not in them
  const missing = (await w.hunter({ provider: wrapped(async () => []), signer: undefined }).status({ claimId })).settlement;
  assert.equal(missing.found, false);
  assert.equal(missing.reason, 'notInBlocks');
  assert.ok(missing.searched.fromBlock <= rc.blockNumber && rc.blockNumber <= missing.searched.toBlock, 'the blocks of its settledAt');
  assert.equal(missing.settledAt, (await w.sa.getClaim(claimId)).settledAt);
  for (const k of ['by', 'from', 'tx', 'block', 'paidWei', 'owedWei']) assert.equal(missing[k], undefined, `no ${k} is guessed`);
  const text = settlementLines(missing).join('\n');
  assert.match(text, new RegExp(`not found in blocks ${missing.searched.fromBlock} to ${missing.searched.toBlock}`));
  assert.match(text, /does not say who sent the settle or what it paid/);
  assert.doesNotMatch(text, /sent by|another address|this run|hunter's own/);

  // an RPC that refuses every eth_getLogs: not read, said so
  const refused = (await w.hunter({ provider: wrapped(async () => { throw new Error('limit exceeded'); }), signer: undefined }).status({ claimId })).settlement;
  assert.equal(refused.found, false);
  assert.equal(refused.reason, 'unread');
  assert.match(settlementLines(refused).join('\n'), /could not be read[^\n]*does not say who sent the settle or what it paid/);

  // over HTTP, as the CLI runs: an RPC whose every eth_getLogs fails
  const rpc = await rpcOf(w);
  rpc.options.echoOnly = ['eth_getLogs'];
  try {
    const out = await runCli(w, ['status', dir], { keyVia: 'none' });
    assert.equal(out.code, 0, `the claim's state is read all the same: ${out.stderr}`);
    assert.match(out.stdout, /Settled DUPLICATE/);
    assert.match(out.stdout, /could not be read/);
    assert.doesNotMatch(out.stdout, /sent by|rejected:/);
    const json = await runCli(w, ['status', dir, '--json'], { keyVia: 'none' });
    assert.deepEqual(JSON.parse(json.stdout).settlement.found, false);
  } finally {
    rpc.options.echoOnly = null;
  }
});

test('withdrawals report their transaction and amount, as they did', async () => {
  // the fee recipient's listing fees wait in withdrawable: claim, run with its key, withdraws them
  const feeKey = w.keyOf(3);
  const fee = new ethers.Wallet(feeKey, w.provider);
  const { claimId } = await judged('DUPLICATE');
  await (await w.sa.connect(keeper).settle(claimId)).wait();
  const due = await w.sa.withdrawable(fee.address);
  assert.ok(due > 0n);
  const out = await runCli(w, ['claim', String(claimId)], { keyVia: 'none', extra: { VERDIKTA_WALLET_KEY: feeKey } });
  assert.equal(out.code, 0, out.stderr);
  const m = /Sent withdraw: (0x[0-9a-f]{64}), ([0-9.]+) ETH/.exec(out.stdout);
  assert.ok(m, out.stdout);
  assert.equal(ethers.parseEther(m[2]), due);
  assert.equal((await w.provider.getTransaction(m[1])).from, fee.address);
  assert.equal(await w.sa.withdrawable(fee.address), 0n);
});
