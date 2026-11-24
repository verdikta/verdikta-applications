// Node P42: on the listing's page a block is its hash, never its number. `snapshot` (src/chain/snapshot.js) holds the
// calls of one read to one block hash, and every contract read of the listing's page goes through it. How it asks
// comes from where the provider was made, never from what a node answers: the site's read address at the block's
// hash, a wallet's node by the block's number. The first half of this file runs the function against nodes whose
// blocks are replaced under it, that do not agree among themselves, or that refuse the hash; the second holds the
// page's components to it, so that a read added later without it fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SNAPSHOT_TRIES, SnapshotError, siteReader, snapshot } from '../src/chain/snapshot.js';

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
  const state = { head, blocks: { ...blocks }, parents: {}, asked: [], calls: [] };
  // `parents[n]`: the parent hash block n names (a node's header always has one; these tests give it where it matters)
  const header = (n) => (state.blocks[n] ? { number: hex(n), hash: state.blocks[n], parentHash: state.parents[n], timestamp: hex(1_800_000_000 + n) } : null);
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
        if (params[0] !== 'latest' && state.failing?.has(Number(params[0]))) throw new Error('the node could not serve that header');
        return params[0] === 'latest' ? header(state.head) : header(Number(params[0]));
      },
    },
  };
}
const pinnedTo = (blockHash) => ({ blockHash, requireCanonical: true });
/** A node behind the site's read address: its provider is made for that address (chain/wallet.js chainReader). */
function site(head, blocks, call) {
  const made = node(head, blocks, call);
  siteReader(made.provider);
  return made;
}
/** A wallet's node: a provider like any other, made for no address of the site's. */
const wallet = node;

test('snapshot, the site\'s read address: every call is made at the latest block\'s hash, and taken when that block still has it after them', async () => {
  const { provider, state } = site(90, { 88: hash('88'), 89: hash('89'), 90: hash('AB') });
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
  for (const made of [site, wallet]) {
    const { provider, state } = made(90, { 89: hash('89'), 90: hash('a1') });
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
  }
});

test('snapshot: after a small fixed number of tries it fails, and nothing of any try is returned', async () => {
  for (const made of [site, wallet]) {
    const { provider, state } = made(90, { 90: hash('00') });
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
  }
  assert.ok(SNAPSHOT_TRIES >= 2 && SNAPSHOT_TRIES <= 5, 'a small fixed number');
});

test('snapshot: a read that failed while its block was replaced is read again; one that failed on a block that stood, fails', async () => {
  const moving = site(90, { 90: hash('a1') });
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

  const standing = site(90, { 90: hash('a1') });
  let calls = 0;
  await assert.rejects(snapshot(standing.provider, async () => { calls += 1; throw new Error('rate limit'); }), /rate limit/);
  assert.equal(calls, 1, 'not tried again: the block did not move, the read failed');
});

test('snapshot, the site\'s read address: a node that does not have the block refuses the call, and nothing of another chain is read', async () => {
  // The headers come from a node on one chain, with the same hash before and after. The calls reach a node that does
  // not have that block (the nodes behind one address are taken to agree; where they do not, this is what happens).
  // Asked by number it would have answered, with its own chain's hold; asked by hash it refuses, and the read fails.
  for (const refusal of ['header not found', 'hash 0xa1a1 is not currently canonical', 'Unknown block', 'invalid input: block is not canonical', 'requested block is unavailable']) {
    const { provider, state } = site(90, { 90: hash('a1') }, (selector) => {
      if (typeof selector === 'string') return '0x00000000000000000000000000000000000000000000000000000000deadbeef'; // the other chain's hold
      throw callError(-32000, refusal);
    });
    await assert.rejects(snapshot(provider, async (at) => at.call(TX)), (err) => err.code === 'CALL_EXCEPTION' && err.info.error.message === refusal, refusal);
    assert.deepEqual(state.calls, [pinnedTo(hash('a1'))], `${refusal}: never asked by number`);
    assert.deepEqual(state.asked, ['latest', hex(90)], 'the header stood: one try, and a failed read');
  }
});

test('snapshot, the site\'s read address: one that refuses the hash form is a failed read, never asked by number, and nothing is learned from its answer', async () => {
  // The address has to take a block's hash on a call (the deploy notes say so). One that does not, whatever words it
  // has for it, gives a failed read every time: the page does not read an error's wording, and has no other way to ask.
  for (const [code, message] of [
    [-32602, 'invalid argument 1: json: cannot unmarshal object into Go value of type string'],
    [-32602, 'Invalid params'],
    [-32602, 'requested block is unavailable'],
    [-32602, 'cannot unmarshal object {"blockHash":"0xa1","requireCanonical":true} into a block number'],
    [-32603, 'blockRef.slice is not a function'],
    [-32005, 'rate limit exceeded'],
  ]) {
    const { provider, state } = site(90, { 90: hash('a1') }, (selector) => {
      if (typeof selector === 'string') return '0x02'; // it would answer by number
      throw callError(code, message);
    });
    for (let read = 0; read < 3; read += 1) {
      state.calls.length = 0;
      await assert.rejects(snapshot(provider, async (at) => at.call(TX)), (err) => err.info.error.message === message, message);
      assert.deepEqual(state.calls, [pinnedTo(hash('a1'))], `${message}, read ${read + 1}: by hash, once, and never by number`);
    }
  }
});

test('snapshot, a wallet\'s node: every call is made by the block\'s number, never at a hash, and held to the hash before and after', async () => {
  const { provider, state } = wallet(90, { 89: hash('89'), 90: hash('a1') });
  const got = await snapshot(provider, async (at) => [await at.call(TX), await at.call(TX)], { heights: [89] });
  assert.deepEqual(got, { value: ['0x01', '0x01'], block: 90, blockHash: hash('a1'), time: 1_800_000_090n, hashes: { 89: hash('89') } });
  // a wallet's node is never sent the hash form: what a wallet does with a block parameter it does not know is its own
  assert.deepEqual(state.calls, [hex(90), hex(90)]);
  assert.ok(state.calls.every((selector) => typeof selector === 'string'), 'no blockHash selector');
  assert.deepEqual(state.asked, ['latest', hex(89), hex(90)]);
  // the hash at that number changed between the two header reads: the answers are not one block's, and are not taken
  const moved = wallet(90, { 90: hash('a1') });
  let tries = 0;
  await assert.rejects(
    snapshot(moved.provider, async (at) => {
      tries += 1;
      const answer = await at.call(TX);
      moved.state.blocks[90] = hash(String(tries).padStart(2, '0'));
      return answer;
    }),
    (err) => err instanceof SnapshotError,
  );
  assert.equal(tries, SNAPSHOT_TRIES);
  assert.ok(moved.state.calls.every((selector) => typeof selector === 'string'));
  // and a wallet's node that fails a call is a failed read: it is not asked another way either
  const failing = wallet(90, { 90: hash('a1') }, () => { throw callError(-32603, 'Internal error'); });
  await assert.rejects(snapshot(failing.provider, async (at) => at.call(TX)), (err) => err.info.error.message === 'Internal error');
  assert.deepEqual(failing.state.calls, [hex(90)]);
});

test('snapshot: how a provider is asked is where it was made, and no answer changes it', async () => {
  // the same node, behind a provider made for the site's address and behind one that is a wallet's
  const calls = [];
  const answer = (selector) => { calls.push(selector); return '0x01'; };
  const asSite = site(90, { 90: hash('a1') }, answer);
  const asWallet = wallet(90, { 90: hash('a1') }, answer);
  for (let i = 0; i < 2; i += 1) {
    await snapshot(asSite.provider, async (at) => at.call(TX));
    await snapshot(asWallet.provider, async (at) => at.call(TX));
  }
  assert.deepEqual(calls, [pinnedTo(hash('a1')), hex(90), pinnedTo(hash('a1')), hex(90)]);
  // the module reads no error's wording, and keeps nothing it learned from a node
  const lib = read('../src/chain/snapshot.js');
  for (const gone of ['takesHash', 'FORM_WORDS', 'ABOUT_THE_BLOCK', 'INVALID_PARAMS', 'refusesTheForm', 'saysBlockUnknown', 'refusedByContract', 'textsOf', 'callsAt']) {
    assert.equal(lib.includes(gone), false, `${gone} is gone from snapshot.js`);
  }
  const code = lib.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\berr\??\.[a-zA-Z]|\.info\b|\.message\b|\.shortMessage\b/, 'no field of an error is read');
  assert.equal(code.split('.test(').length - 1, 1, 'the one text matched is a block hash\'s 32 bytes of hex');
  assert.match(code, /\/\^0x\[0-9a-f\]\{64\}\$\/i\.test\(value\)/);
  assert.match(lib, /const SITE_READERS = new WeakSet\(\);/);
  assert.match(lib, /export function siteReader\(provider\) \{\s*SITE_READERS\.add\(provider\);\s*return provider;\s*\}/);
  assert.match(lib, /const selector = SITE_READERS\.has\(provider\) \? \{ blockHash, requireCanonical: true \} : quantity\(block\);/);
  // the one provider made for the site's address is marked where it is made; a wallet's provider never is
  const made = read('../src/chain/wallet.js');
  assert.match(made, /if \(CONFIG\.rpcUrl\) reader = siteReader\(new JsonRpcProvider\(CONFIG\.rpcUrl, CONFIG\.chainId, \{ staticNetwork: true, pollingInterval: POLL_MS \}\)\);/);
  assert.equal(made.split('siteReader(').length - 1, 1, 'marked in one place');
  assert.equal(made.split('new BrowserProvider(').length - 1, 3, 'the wallet\'s providers: made plain');
  assert.doesNotMatch(made, /siteReader\(new BrowserProvider/);
});

test('snapshot: a header the node does not give, gives malformed or fails to give says nothing of that height, and the read stands without it', async () => {
  const { provider, state } = site(90, { 90: hash('a1') });
  // height 70: no header now. It is left out, not answered as "another block", so nothing kept there is dropped on it
  assert.deepEqual((await snapshot(provider, async () => 1, { heights: [70] })).hashes, {});
  // a header whose hash is not 32 bytes of hex is no hash: compared with a receipt's it would read as another block
  for (const malformed of ['0x', '0x1234', '', `${hash('70')}00`, 'not a hash']) {
    state.blocks[70] = malformed;
    assert.deepEqual((await snapshot(provider, async () => 1, { heights: [70] })).hashes, {}, JSON.stringify(malformed));
  }
  // a lookup that fails takes nothing from the read of the listing: its value is returned, without that height
  state.blocks[70] = hash('70');
  state.failing = new Set([70]);
  const got = await snapshot(provider, async (at) => at.call(TX), { heights: [70] });
  assert.deepEqual({ value: got.value, block: got.block, hashes: got.hashes }, { value: '0x01', block: 90, hashes: {} });
  // and the next read asks again: the matching header, when the node gives it
  state.failing = new Set();
  assert.deepEqual((await snapshot(provider, async () => 1, { heights: [70] })).hashes, { 70: hash('70') });
  // the block itself is another matter: without its header, or with a malformed one, there is no read
  const empty = node(90, {});
  await assert.rejects(snapshot(empty.provider, async () => 1), /did not answer with its latest block/);
  const broken = node(90, { 90: '0x' });
  await assert.rejects(snapshot(broken.provider, async () => 1), /did not answer with its latest block/);
});

test('snapshot: the hash of the block just below is the block\'s own parent hash, not what a node says of that height', async () => {
  // the head names its parent; asked by number for that height, another node behind the endpoint would name the
  // block it has there, on another chain
  const { provider, state } = site(90, { 89: hash('0f'), 90: hash('a1') });
  state.parents[90] = hash('B9');
  const got = await snapshot(provider, async () => 1, { heights: [89, 90] });
  assert.deepEqual(got.hashes, { 89: hash('b9'), 90: hash('a1') });
  assert.deepEqual(state.asked, ['latest', hex(90)], 'height 89 was not asked by number');
  // a head that names no usable parent is asked by number, as for any older height
  state.parents[90] = '0x';
  state.asked.length = 0;
  assert.deepEqual((await snapshot(provider, async () => 1, { heights: [89] })).hashes, { 89: hash('0f') });
  assert.deepEqual(state.asked, ['latest', hex(89), hex(90)]);
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
  assert.match(lib, /call: \(tx\) => provider\.send\('eth_call', \[\{ to: tx\.to, data: tx\.data \?\? '0x', \.\.\.\(tx\.from \? \{ from: tx\.from \} : \{\}\) \}, selector\]\),/);
  assert.match(lib, /if \(hashOf\(await header\(provider, block\)\) === blockHash\) \{[\s\S]*?if \(failure\) throw failure;\s*return \{ value, block, blockHash, time: BigInt\(head\.timestamp\), hashes \};\s*\}/);
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
  const failed = page.slice(page.indexOf('const failed = loaded.failed ?? null;'), page.indexOf('const l = current.listing;'));
  assert.match(failed, /const again = \(\) => \(needed\.current > 0 \|\| shownRead\.current !== null \? refresh\(needed\.current\) : setAttempt\(\(a\) => a \+ 1\)\);/);
  assert.match(failed, /<p className="error" role="alert" data-testid="listing-unread">\{fill\(F\.readFailed, \{ reason: failed \}\)\}<\/p>/);
  assert.match(failed, /<button type="button" data-testid="listing-read-again" onClick=\{again\}>\{F\.retry\}<\/button>/);
  // nothing of the listing is shown with it: every part of the listing is in the one element a failed read hides
  assert.match(page, /<div className="listing-read" hidden=\{failed !== null\} data-testid="listing-read">/);
  assert.ok(page.indexOf('<div className="listing-read"') < page.indexOf('data-testid="listing-summary"'), 'the summary, and all after it, inside');
  // the contract: a listing on hold takes no commit, whatever else is true of it
  assert.match(read('../../onchain/contracts/StakeAttestation.sol'), /function acceptsCommits\(uint256 listingId\) public view returns \(bool\) \{[\s\S]*?return l\.state == ListingState\.Open\s*&& block\.timestamp < l\.fundedUntil\s*&& l\.escrowWei >= l\.awards\[3\]\s*&& _heldAt\[listingId\] == 0;/);
});
