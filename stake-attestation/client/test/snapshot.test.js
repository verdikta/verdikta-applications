// Node P42: on the listing's page a block is its hash, never its number. `snapshot` (src/chain/snapshot.js) holds the
// calls of one read to one block hash, and every contract read of the listing's page goes through it. The first half
// of this file runs the function against a node whose blocks are replaced under it; the second holds the page's
// components to it, so that a read added later without it fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SNAPSHOT_TRIES, SnapshotError, snapshot } from '../src/chain/snapshot.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const hash = (byte) => `0x${byte.repeat(32)}`;
const hex = (n) => `0x${n.toString(16)}`;

/**
 * A node: `blocks` maps a height to its hash and may be changed by a test at any moment, as a node does when it
 * replaces a block. `asked` records each header request.
 */
function node(head, blocks) {
  const state = { head, blocks: { ...blocks }, asked: [] };
  const header = (n) => (state.blocks[n] ? { number: hex(n), hash: state.blocks[n], timestamp: hex(1_800_000_000 + n) } : null);
  return {
    state,
    provider: {
      async send(method, params) {
        assert.equal(method, 'eth_getBlockByNumber', 'a snapshot asks the node for headers only; the calls are the read\'s own');
        assert.equal(params[1], false);
        state.asked.push(params[0]);
        return params[0] === 'latest' ? header(state.head) : header(Number(params[0]));
      },
    },
  };
}

test('snapshot: the calls are made at the latest block, and taken when that block still has its hash after them', async () => {
  const { provider, state } = node(90, { 88: hash('88'), 89: hash('89'), 90: hash('AB') });
  const seen = [];
  const got = await snapshot(provider, async (at) => { seen.push(at); return 'the listing'; }, { heights: [89, 90, 91, 89] });
  assert.deepEqual(seen, [{ blockTag: 90 }], 'every call of the read takes the block\'s number, once');
  assert.deepEqual(got, { value: 'the listing', block: 90, blockHash: hash('ab'), time: 1_800_000_090n, hashes: { 89: hash('89'), 90: hash('ab') } });
  // the head, then the heights asked for that are below it, then the block again: its own height from the head, and
  // none above it
  assert.deepEqual(state.asked, ['latest', hex(89), hex(90)]);
});

test('snapshot: a block replaced at the same height between the reads is never one read; it is read again', async () => {
  const { provider, state } = node(90, { 89: hash('89'), 90: hash('a1') });
  let tries = 0;
  const got = await snapshot(provider, async (at) => {
    tries += 1;
    // the node replaces block 90 while the first try's calls are in flight: some of them answered for the old block
    if (tries === 1) {
      state.blocks[90] = hash('b2');
      state.blocks[89] = hash('77');
      return { listing: 'of the new block', hold: 'of the old one', at };
    }
    return { listing: 'of the new block', hold: 'of the new block', at };
  }, { heights: [89] });
  assert.equal(tries, 2);
  assert.deepEqual(got.value, { listing: 'of the new block', hold: 'of the new block', at: { blockTag: 90 } });
  assert.equal(got.blockHash, hash('b2'));
  assert.deepEqual(got.hashes, { 89: hash('77') }, 'and the hashes it carries are that chain\'s, not what the discarded try saw');
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

test('snapshot: a height the node has no block at is null, and a node without a latest block is a failed read', async () => {
  const { provider } = node(90, { 90: hash('a1') });
  assert.deepEqual((await snapshot(provider, async () => 1, { heights: [70] })).hashes, { 70: null });
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
// the contract's views the page reads, and the two helpers that read them (chain/wallet.js listingAt, lib/hold.js readHold)
const READS = /\b(?:getListing|listingCount|acceptsCommits|acceptsLateClaims|feeDue|listingFeeWei|withdrawable|heldAt|claimState|claimTimes|getClaim|commitPrice|isAllowed|listingAt|readHold)\(/g;

test('every contract read of the listing\'s page is made inside a snapshot: none names a block of its own, and none is made without one', () => {
  let reads = 0;
  for (const name of PAGE) {
    const source = codeOf(name);
    // each read takes the snapshot's block as its last argument
    for (const m of source.matchAll(READS)) {
      const inside = args(source, m.index + m[0].length);
      assert.match(inside, /(?:^|,\s*)at$/, `${name}: ${m[0]}${inside}) is read at the block of its snapshot`);
      reads += 1;
    }
    // and that block comes from a snapshot and from nowhere else: every function that takes `at` is a snapshot's read
    const takers = source.split('(at) =>').length - 1;
    const snapshots = [...source.matchAll(/\bsnapshot\((?:provider|p), (?:async )?\(at\) =>/g)].length;
    assert.equal(takers, snapshots, `${name}: ${takers} functions take a block, ${snapshots} of them a snapshot's read`);
    assert.equal(source.split('snapshot(').length - 1, snapshots, `${name}: every snapshot hands its read the block`);
    assert.ok(snapshots > 0, `${name} reads the chain`);
    // no other way to name a block, or to ask the node for one
    assert.doesNotMatch(source, /blockTag|eth_blockNumber|eth_getBlockByNumber|getBlockNumber\(|getBlock\(|chainNow\(|\.send\(/, name);
    // a contract is made for a reader or a wallet, and read only as above: no call on it without parentheses' check
    assert.doesNotMatch(source, /stakeAttestation\([^)]*\)\.(?!fund\(|renew\(|hold\(|close\(|withdraw\(|rollForward\(|feeDue\(|withdrawable\()/, `${name}: a contract made inline is sent to, or read with its snapshot's block`);
  }
  assert.ok(reads >= 14, `${reads} reads checked`);
  // the two helpers pass the block on, and add none
  assert.match(read('../src/chain/wallet.js'), /export async function listingAt\(contract, listingId, at\) \{\s*const id = BigInt\(listingId\);\s*if \(id === 0n \|\| id > BigInt\(await contract\.listingCount\(at\)\)\) return null;\s*return contract\.getListing\(id, at\);/);
  assert.match(read('../src/lib/hold.js'), /return \{ supported: true, heldAt: BigInt\(await sa\.heldAt\(BigInt\(listingId\), overrides\)\) \};/);
  // the snapshot itself: the head's hash before the calls, the same height's hash after them, a fixed number of tries
  const lib = read('../src/chain/snapshot.js');
  assert.match(lib, /const head = await header\(provider, 'latest'\);/);
  assert.match(lib, /value = await read\(\{ blockTag: block \}\);/);
  assert.match(lib, /if \(hashOf\(await header\(provider, block\)\) === blockHash\) \{\s*if \(failure\) throw failure;\s*return \{ value, block, blockHash, time: BigInt\(head\.timestamp\), hashes \};\s*\}/);
  assert.match(lib, /throw new SnapshotError\(tries\);/);
});

test('the page\'s read of the listing is one snapshot, and one that says both "on hold" and "takes commits" is a failed read', () => {
  const page = read('../src/components/FundPage.jsx');
  const fn = page.slice(page.indexOf('async function readListing('), page.indexOf('\n}\n', page.indexOf('async function readListing(')));
  // the count, the listing, the hold and acceptsCommits: one function, one snapshot, with the hashes of the kept blocks
  assert.match(fn, /const \{ value, block, blockHash, hashes \} = await snapshot\(provider, async \(at\) => \{\s*const listing = await listingAt\(sa, listingId, at\);\s*if \(listing === null\) return \{ missing: true \};\s*const \[hold, takesCommits\] = await Promise\.all\(\[readHold\(sa, listingId, at\), sa\.acceptsCommits\(BigInt\(listingId\), at\)\]\);/);
  assert.match(fn, /if \(hold\.heldAt !== 0n && takesCommits\) throw new Error\(STRINGS\.fund\.contradictory\);\s*return \{ listing, hold, takesCommits \};\s*\}, \{ heights \}\);\s*return \{ \.\.\.value, block, blockHash, hashes \};/);
  // it is the page's only read of the listing: the first load, a retry, and every refresh after a transaction
  assert.equal(page.split('readListing(').length - 1, 3, 'its definition, the load and the refresh');
  // a failed read is said as one, with a way to read again; it is never drawn as a listing
  assert.match(page, /if \(loaded\.failed\) \{\s*return \(\s*<>\s*\{header\}\s*<p className="error">\{fill\(F\.readFailed, \{ reason: loaded\.failed \}\)\}<\/p>\s*<button type="button" onClick=\{\(\) => setAttempt\(\(a\) => a \+ 1\)\}>\{F\.retry\}<\/button>/);
  // the contract: a listing on hold takes no commit, whatever else is true of it
  assert.match(read('../../onchain/contracts/StakeAttestation.sol'), /function acceptsCommits\(uint256 listingId\) public view returns \(bool\) \{[\s\S]*?return l\.state == ListingState\.Open\s*&& block\.timestamp < l\.fundedUntil\s*&& l\.escrowWei >= l\.awards\[3\]\s*&& _heldAt\[listingId\] == 0;/);
});
