// Node P42: on the listing's page a block is its hash, never its number. `snapshot` (src/chain/snapshot.js) holds the
// calls of one read to one block hash, and every contract read of the listing's page goes through it. The first half
// of this file runs the function against nodes whose blocks are replaced under it, that do not agree among
// themselves, or that do not take a block hash; the second holds the page's components to it, so that a read added
// later without it fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SNAPSHOT_TRIES, SnapshotError, snapshot } from '../src/chain/snapshot.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const hash = (byte) => `0x${byte.repeat(32)}`;
const hex = (n) => `0x${n.toString(16)}`;
/** A failed eth_call as ethers hands it on: every JSON-RPC error on a call is a CALL_EXCEPTION, with the node's own error. */
const callError = (code, message, data = null) => Object.assign(new Error('call failed'), { code: 'CALL_EXCEPTION', data, info: { error: { code, message } } });
const TX = { to: '0x00000000000000000000000000000000000000aa', data: '0x1234' };

/**
 * A node: `blocks` maps a height to its hash and may be changed by a test at any moment, as a node does when it
 * replaces a block. `call(selector, tx)` answers an eth_call, or throws. `asked` records every request.
 */
function node(head, blocks, call = () => '0x01') {
  const state = { head, blocks: { ...blocks }, asked: [], calls: [] };
  const header = (n) => (state.blocks[n] ? { number: hex(n), hash: state.blocks[n], timestamp: hex(1_800_000_000 + n) } : null);
  return {
    state,
    provider: {
      async send(method, params) {
        if (method === 'eth_call') {
          state.calls.push(params[1]);
          return call(params[1], params[0], state);
        }
        assert.equal(method, 'eth_getBlockByNumber');
        assert.equal(params[1], false);
        state.asked.push(params[0]);
        return params[0] === 'latest' ? header(state.head) : header(Number(params[0]));
      },
    },
  };
}
const pinnedTo = (blockHash) => ({ blockHash, requireCanonical: true });

test('snapshot: every call is made at the latest block\'s hash, and taken when that block still has it after them', async () => {
  const { provider, state } = node(90, { 88: hash('88'), 89: hash('89'), 90: hash('AB') });
  const got = await snapshot(provider, async (at) => [await at.call(TX), await at.call({ ...TX, from: '0x00000000000000000000000000000000000000bb' })], { heights: [89, 90, 91, 89] });
  assert.deepEqual(got, { value: ['0x01', '0x01'], block: 90, blockHash: hash('ab'), time: 1_800_000_090n, hashes: { 89: hash('89'), 90: hash('ab') } });
  // each call names the block by its hash, and asks the node to refuse it if that block is not the chain's
  assert.deepEqual(state.calls, [pinnedTo(hash('ab')), pinnedTo(hash('ab'))]);
  // the head, then the heights asked for that are below it, then the block again: its own height from the head, and
  // none above it
  assert.deepEqual(state.asked, ['latest', hex(89), hex(90)]);
  // the runner the read is handed can only call: a contract made on it reads that block, and can send nothing
  await snapshot(provider, async (at) => assert.deepEqual(Object.keys(at), ['call']));
});

test('snapshot: a block replaced at the same height between the reads is never one read; it is read again', async () => {
  const { provider, state } = node(90, { 89: hash('89'), 90: hash('a1') });
  let tries = 0;
  const got = await snapshot(provider, async (at) => {
    tries += 1;
    await at.call(TX);
    // the node replaces block 90 while the first try's calls are in flight: some of them answered for the old block
    if (tries === 1) {
      state.blocks[90] = hash('b2');
      state.blocks[89] = hash('77');
      return { listing: 'of the new block', hold: 'of the old one' };
    }
    return { listing: 'of the new block', hold: 'of the new block' };
  }, { heights: [89] });
  assert.equal(tries, 2);
  assert.deepEqual(got.value, { listing: 'of the new block', hold: 'of the new block' });
  assert.equal(got.blockHash, hash('b2'));
  assert.deepEqual(got.hashes, { 89: hash('77') }, 'and the hashes it carries are that chain\'s, not what the discarded try saw');
  assert.deepEqual(state.calls, [pinnedTo(hash('a1')), pinnedTo(hash('b2'))]);
});

test('snapshot: after a small fixed number of tries it fails, and nothing of any try is returned', async () => {
  const { provider, state } = node(90, { 90: hash('00') });
  let tries = 0;
  await assert.rejects(
    snapshot(provider, async () => {
      tries += 1;
      state.blocks[90] = hash(String(tries).padStart(2, '0'));
      return 'two chains between them';
    }),
    (err) => err instanceof SnapshotError && err.code === 'SNAPSHOT_MOVED' && /the chain changed while it was read/.test(err.message),
  );
  assert.equal(tries, SNAPSHOT_TRIES);
  assert.ok(SNAPSHOT_TRIES >= 2 && SNAPSHOT_TRIES <= 5, 'a small fixed number');
});

test('snapshot: a read that failed while its block was replaced is read again; one that failed on a block that stood, fails', async () => {
  const moving = node(90, { 90: hash('a1') });
  let tries = 0;
  const got = await snapshot(moving.provider, async () => {
    tries += 1;
    if (tries === 1) {
      moving.state.blocks[90] = hash('b2');
      throw new Error('header not found');
    }
    return 'read';
  });
  assert.equal(got.value, 'read');
  assert.equal(tries, 2);

  const standing = node(90, { 90: hash('a1') });
  let calls = 0;
  await assert.rejects(snapshot(standing.provider, async () => { calls += 1; throw new Error('rate limit'); }), /rate limit/);
  assert.equal(calls, 1, 'not tried again: the block did not move, the read failed');
});

test('snapshot: two nodes behind one endpoint that do not agree on the block: the calls are refused, and nothing of the other chain is read', async () => {
  // The headers come from a node on one chain, with the same hash before and after. The calls reach a node on
  // another chain at that height, which answers truthfully too: it does not have that block. Asked by number it
  // would have answered, with its own chain's hold; asked by hash it refuses, and the read fails.
  for (const refusal of ['header not found', 'hash 0xa1a1 is not currently canonical', 'Unknown block', 'block 0xa1 not found', `Received invalid block tag ${hash('a1')}. Latest block number is 90`]) {
    const { provider, state } = node(90, { 90: hash('a1') }, (selector) => {
      if (typeof selector === 'string') return '0x00000000000000000000000000000000000000000000000000000000deadbeef'; // the other chain's hold
      throw callError(-32000, refusal);
    });
    await assert.rejects(snapshot(provider, async (at) => at.call(TX)), (err) => err.code === 'CALL_EXCEPTION' && err.info.error.message === refusal, refusal);
    assert.deepEqual(state.calls, [pinnedTo(hash('a1'))], `${refusal}: never asked by number`);
    assert.deepEqual(state.asked, ['latest', hex(90)], 'the header stood: one try, and a failed read');
  }
});

test('snapshot: a node that does not take a block hash is asked by number, and held to the hash before and after', async () => {
  // it refuses the hash as a parameter it cannot read, as nodes and wallets that do not know the form do
  for (const refusal of [[-32602, 'invalid argument 1: json: cannot unmarshal object into Go value of type string'], [-32603, 'blockRef.slice is not a function'], [-32602, 'Invalid params']]) {
    const { provider, state } = node(90, { 90: hash('a1') }, (selector) => {
      if (typeof selector !== 'string') throw callError(...refusal);
      return '0x02';
    });
    const first = await snapshot(provider, async (at) => at.call(TX));
    assert.deepEqual({ value: first.value, block: first.block, blockHash: first.blockHash }, { value: '0x02', block: 90, blockHash: hash('a1') });
    assert.deepEqual(state.calls, [pinnedTo(hash('a1')), hex(90)], 'by hash first, then by the number of that block');
    // known from then on: the next read of that node asks by number at once
    state.calls.length = 0;
    await snapshot(provider, async (at) => at.call(TX));
    assert.deepEqual(state.calls, [hex(90)]);
    // and by number the hash before and after is all that binds it: a block replaced between them is read again
    let tries = 0;
    const again = await snapshot(provider, async (at) => {
      tries += 1;
      if (tries === 1) state.blocks[90] = hash('b2');
      return at.call(TX);
    });
    assert.equal(tries, 2);
    assert.equal(again.blockHash, hash('b2'));
  }
});

test('snapshot: a node that took a hash once is never asked by number, whatever fails later; and a failure that settles nothing settles nothing', async () => {
  // it answered a call at a hash: it takes one. A later call that fails for another reason is a failed read.
  let fail = false;
  const { provider, state } = node(90, { 90: hash('a1') }, () => {
    if (fail) throw callError(429, 'Too Many Requests');
    return '0x01';
  });
  await snapshot(provider, async (at) => at.call(TX));
  fail = true;
  state.calls.length = 0;
  await assert.rejects(snapshot(provider, async (at) => at.call(TX)), (err) => err.info.error.message === 'Too Many Requests');
  assert.deepEqual(state.calls, [pinnedTo(hash('a1'))]);
  // a contract's revert is an answer of that block too: the node ran the call at the hash
  const reverting = node(90, { 90: hash('a1') }, (selector) => {
    if (typeof selector === 'string') return '0x02';
    throw callError(3, 'execution reverted', '0x');
  });
  const got = await snapshot(reverting.provider, async (at) => at.call(TX).catch((err) => `refused: ${err.info.error.message}`));
  assert.equal(got.value, 'refused: execution reverted');
  assert.deepEqual(reverting.state.calls, [pinnedTo(hash('a1'))], 'not asked again by number');
  // A node that fails a call at a hash for a reason that says nothing of hashes (a limit, a timeout) has not shown
  // that it does not take one: the read fails, nothing is read by number in its place, even though this node would
  // have answered by number, and the next read asks by hash again.
  for (const [code, message] of [[-32005, 'rate limit exceeded'], [429, 'Too Many Requests'], [-32000, 'execution timeout'], [-32603, 'Internal error']]) {
    let limited = true;
    const busy = node(90, { 90: hash('a1') }, (selector) => {
      if (typeof selector !== 'string' && limited) throw callError(code, message);
      return '0x05';
    });
    await assert.rejects(snapshot(busy.provider, async (at) => at.call(TX)), (err) => err.info.error.message === message, message);
    assert.deepEqual(busy.state.calls, [pinnedTo(hash('a1'))], `${message}: never asked by number`);
    limited = false;
    busy.state.calls.length = 0;
    assert.equal((await snapshot(busy.provider, async (at) => at.call(TX))).value, '0x05');
    assert.deepEqual(busy.state.calls, [pinnedTo(hash('a1'))], 'and by hash again at the next read');
  }
  // a node that refuses the form and does not answer by number either has shown nothing: the read fails, and the
  // next one asks by hash again
  const down = node(90, { 90: hash('a1') }, (selector) => { throw callError(typeof selector === 'string' ? -32005 : -32602, 'invalid params or busy'); });
  await assert.rejects(snapshot(down.provider, async (at) => at.call(TX)));
  assert.deepEqual(down.state.calls, [pinnedTo(hash('a1')), hex(90)]);
  down.state.calls.length = 0;
  await assert.rejects(snapshot(down.provider, async (at) => at.call(TX)));
  assert.deepEqual(down.state.calls[0], pinnedTo(hash('a1')));
});

test('snapshot: a header the node does not give says nothing of that height, and a node without a latest block is a failed read', async () => {
  const { provider, state } = node(90, { 90: hash('a1') });
  // height 70: no header now. It is left out, not answered as "another block", so nothing kept there is dropped on it
  assert.deepEqual((await snapshot(provider, async () => 1, { heights: [70] })).hashes, {});
  state.blocks[70] = hash('70');
  assert.deepEqual((await snapshot(provider, async () => 1, { heights: [70] })).hashes, { 70: hash('70') });
  const empty = node(90, {});
  await assert.rejects(snapshot(empty.provider, async () => 1), /did not answer with its latest block/);
});

// ---------------------------------------------------------------- the listing's page reads through it, and only through it
const PAGE = ['FundPage.jsx', 'FundListing.jsx', 'ListingActions.jsx', 'ListingExtras.jsx'];
/** A component's code without its comments: what it does, not what it says it does. */
const codeOf = (name) => read(`../src/components/${name}`)
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '');
/** The text between a call's parentheses, from the index just after its "(". */
function args(source, from) {
  let depth = 1;
  let i = from;
  for (; i < source.length && depth > 0; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') depth -= 1;
  }
  return source.slice(from, i - 1);
}
// the contract's views, and the two helpers that read them (chain/wallet.js listingAt, lib/hold.js readHold)
const VIEWS = ['getListing', 'listingCount', 'acceptsCommits', 'acceptsLateClaims', 'feeDue', 'listingFeeWei', 'withdrawable', 'heldAt', 'claimState', 'claimTimes', 'getClaim', 'commitPrice', 'isAllowed', 'claimCount', 'disputeFee', 'disputeDeadline'];
const SENDS = ['fund', 'renew', 'hold', 'close', 'withdraw', 'rollForward'];

test('every contract read of the listing\'s page is made on a snapshot\'s contract: none names a block, and none is made without one', () => {
  let reads = 0;
  let snapshots = 0;
  for (const name of PAGE) {
    const source = codeOf(name);
    // a contract is made for a wallet's signer, to send, or for a snapshot, to read: there is no third
    for (const m of source.matchAll(/stakeAttestation\(([^)]*)\)/g)) assert.match(m[1], /^(?:signer|at)$/, `${name}: stakeAttestation(${m[1]})`);
    // `at` is the runner a snapshot hands its read, and nothing else: every function that takes it is a snapshot's read
    const takers = source.split('(at) =>').length - 1;
    const made = [...source.matchAll(/\bsnapshot\((?:provider|p), (?:async )?\(at\) =>/g)].length;
    assert.equal(takers, made, `${name}: ${takers} functions take a snapshot's runner, ${made} of them a snapshot's read`);
    assert.equal(source.split('snapshot(').length - 1, made, `${name}: every snapshot hands its read the runner`);
    assert.ok(made > 0, `${name} reads the chain`);
    assert.equal(source.split(/\bat\b/).length - 1 - made, source.split('stakeAttestation(at)').length - 1, `${name}: the runner is used to make a contract, and for nothing else`);
    snapshots += made;
    // every view is called on a snapshot's contract: `view`, or one made inline
    for (const m of source.matchAll(new RegExp(`([A-Za-z_.()]*)\\.(${VIEWS.join('|')})\\(`, 'g'))) {
      assert.match(m[1], /^(?:view|stakeAttestation\(at\))$/, `${name}: ${m[0]} is read on a snapshot's contract`);
      reads += 1;
    }
    for (const m of source.matchAll(/\b(?:listingAt|readHold)\(/g)) {
      const first = args(source, m.index + m[0].length).split(',')[0].trim();
      assert.match(first, /^(?:view|stakeAttestation\(at\))$/, `${name}: ${m[0]}${first}, …) reads a snapshot's contract`);
      assert.equal(args(source, m.index + m[0].length).split(',').length, 2, `${name}: ${m[0]}…) names no block of its own`);
      reads += 1;
    }
    // `view` is always a snapshot's contract
    for (const m of source.matchAll(/const view = ([^;]*);/g)) assert.equal(m[1], 'stakeAttestation(at)', `${name}: const view = ${m[1]}`);
    // the wallet's contract sends, and gives its address and its ABI to read a receipt: it reads nothing
    for (const m of source.matchAll(/const sa = ([^;]*);/g)) assert.equal(m[1], 'stakeAttestation(signer)', `${name}: const sa = ${m[1]}`);
    for (const m of source.matchAll(/\bsa\.([A-Za-z]+)/g)) assert.ok([...SENDS, 'interface'].includes(m[1]), `${name}: sa.${m[1]}`);
    for (const m of source.matchAll(/stakeAttestation\(signer\)\.([A-Za-z]+)/g)) assert.ok(SENDS.includes(m[1]), `${name}: stakeAttestation(signer).${m[1]}`);
    // no other way to name a block, or to ask the node for one
    assert.doesNotMatch(source, /blockTag|requireCanonical|eth_blockNumber|eth_getBlockByNumber|eth_call|getBlockNumber\(|getBlock\(|chainNow\(|\.send\(/, name);
  }
  assert.ok(reads >= 18, `${reads} reads checked`);
  assert.equal(snapshots, 12, 'the page\'s read; the opening\'s fee and its read before sending; the renewal\'s fee; the reads before a top-up, a renewal, a hold, a close and a roll; the successors; the balance, shown and before a withdrawal');
  // the two helpers read the contract they are given, and name no block
  assert.match(read('../src/chain/wallet.js'), /export async function listingAt\(contract, listingId\) \{\s*const id = BigInt\(listingId\);\s*if \(id === 0n \|\| id > BigInt\(await contract\.listingCount\(\)\)\) return null;\s*return contract\.getListing\(id\);/);
  assert.match(read('../src/lib/hold.js'), /return \{ supported: true, heldAt: BigInt\(await sa\.heldAt\(BigInt\(listingId\), overrides\)\) \};/);
  // the snapshot itself: the head, the calls at its hash, the same height's hash after them, a fixed number of tries
  const lib = read('../src/chain/snapshot.js');
  assert.match(lib, /const head = await header\(provider, 'latest'\);/);
  assert.match(lib, /got = await callsAt\(provider, read, \{ blockHash, requireCanonical: true \}\);/);
  assert.match(lib, /const result = await provider\.send\('eth_call', \[\{ to: tx\.to, data: tx\.data \?\? '0x', \.\.\.\(tx\.from \? \{ from: tx\.from \} : \{\}\) \}, selector\]\);/);
  assert.match(lib, /if \(hashOf\(await header\(provider, block\)\) === blockHash\) \{[\s\S]*?if \(got\.failure\) throw got\.failure;\s*return \{ value: got\.value, block, blockHash, time: BigInt\(head\.timestamp\), hashes \};\s*\}/);
  assert.match(lib, /throw new SnapshotError\(tries\);/);
});

test('the page\'s read of the listing is one snapshot, and one that says both "on hold" and "takes commits" is a failed read of its block', () => {
  const page = read('../src/components/FundPage.jsx');
  const fn = page.slice(page.indexOf('async function readListing('), page.indexOf('\n}\n', page.indexOf('async function readListing(')));
  // the count, the listing, the hold and acceptsCommits: one function, one snapshot, with the hashes of the kept blocks
  assert.match(fn, /const \{ value, block, blockHash, hashes \} = await snapshot\(provider, async \(at\) => \{\s*const view = stakeAttestation\(at\);\s*const listing = await listingAt\(view, listingId\);\s*if \(listing === null\) return \{ missing: true \};\s*const \[hold, takesCommits\] = await Promise\.all\(\[readHold\(view, listingId\), view\.acceptsCommits\(BigInt\(listingId\)\)\]\);/);
  // It is an answer of its block, not a thrown error: a page waiting for that block after a transaction takes it,
  // and stops showing what it showed (the hold by its receipt, the order that is left), where a thrown error would
  // only be tried again and leave the page as it was.
  assert.match(fn, /if \(hold\.heldAt !== 0n && takesCommits\) return \{ failed: STRINGS\.fund\.contradictory \};\s*return \{ listing, hold, takesCommits \};\s*\}, \{ heights \}\);\s*return \{ \.\.\.value, block, blockHash, hashes \};/);
  // it is the page's only read of the listing: the first load, a retry, and every refresh after a transaction
  assert.equal(page.split('readListing(').length - 1, 3, 'its definition, the load and the refresh');
  // a failed read is said as one, and nothing of the listing with it; reading again never takes a read from before
  // the newest block the page was told of
  const failed = page.slice(page.indexOf('if (loaded.failed) {'), page.indexOf('const l = loaded.listing;'));
  assert.match(failed, /const again = \(\) => \(needed\.current > 0 \? refresh\(needed\.current\) : setAttempt\(\(a\) => a \+ 1\)\);/);
  assert.match(failed, /<p className="error" role="alert" data-testid="listing-unread">\{fill\(F\.readFailed, \{ reason: loaded\.failed \}\)\}<\/p>/);
  assert.match(failed, /<button type="button" data-testid="listing-read-again" onClick=\{again\}>\{F\.retry\}<\/button>/);
  assert.doesNotMatch(failed, /ListingMore|HoldListing|listing-held|FundListing/, 'no hold, no order, no action');
  assert.ok(page.indexOf('if (loaded.failed) {') < page.indexOf('const hold = holdView('), 'before the hold is drawn, by a read or by a receipt');
  // the contract: a listing on hold takes no commit, whatever else is true of it
  assert.match(read('../../onchain/contracts/StakeAttestation.sol'), /function acceptsCommits\(uint256 listingId\) public view returns \(bool\) \{[\s\S]*?return l\.state == ListingState\.Open\s*&& block\.timestamp < l\.fundedUntil\s*&& l\.escrowWei >= l\.awards\[3\]\s*&& _heldAt\[listingId\] == 0;/);
});
