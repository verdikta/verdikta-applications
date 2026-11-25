// Node P42: on the listing's page a block is its hash, never its number. `snapshot` (src/chain/snapshot.js) holds the
// calls of one read to one block hash, and what the page says of a hold is read through it. How it asks comes from
// where the provider was made, never from what a node answers: the site's read address at the block's hash, a wallet's
// node by the block's number. The first half of this file runs the function against nodes whose blocks are replaced
// under it, that do not agree among themselves, or that refuse the hash; the second holds the page's reads of a hold
// to it, so that one added later without it fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { BrowserProvider } from 'ethers';

import * as snapshots from '../src/chain/snapshot.js';
import { WalletError } from '../src/chain/wallet.js';

const { SNAPSHOT_TRIES, SnapshotError, siteReader } = snapshots;
/** The site's chain in these tests (the build's VITE_SA_CHAIN_ID on a page), and another network a wallet can be on. */
const SITE_CHAIN = 31337;
const OTHER_CHAIN = 8453;
/** `snapshot` as a page of a site on SITE_CHAIN calls it: a test has no build variables, so the chain is given here. */
const snapshot = (provider, read, o = {}) => snapshots.snapshot(provider, read, { chainId: SITE_CHAIN, ...o });

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const hash = (byte) => `0x${byte.repeat(32)}`;
const hex = (n) => `0x${n.toString(16)}`;
/** A failed eth_call as ethers hands it on: every JSON-RPC error on a call is a CALL_EXCEPTION, with the node's own error. */
const callError = (code, message, data = null) => Object.assign(new Error('call failed'), { code: 'CALL_EXCEPTION', data, info: { error: { code, message } } });
const TX = { to: '0x00000000000000000000000000000000000000aa', data: '0x1234' };

/**
 * A node: `blocks` maps a height to its hash and may be changed by a test at any moment, as a node does when it
 * replaces a block. `call(selector, tx)` answers an eth_call, or throws. `asked` records every header asked for,
 * `methods` every request in order, and `chainId` is what it answers eth_chainId with (a function is called for it).
 */
function node(head, blocks, call = () => '0x01') {
  const state = { head, blocks: { ...blocks }, parents: {}, asked: [], calls: [], methods: [], chainId: hex(SITE_CHAIN) };
  // `parents[n]`: the parent hash block n names (a node's header always has one; these tests give it where it matters)
  const header = (n) => (state.blocks[n] ? { number: hex(n), hash: state.blocks[n], parentHash: state.parents[n], timestamp: hex(1_800_000_000 + n) } : null);
  return {
    state,
    provider: {
      async send(method, params) {
        state.methods.push(method);
        if (method === 'eth_call') {
          state.calls.push(params[1]);
          return call(params[1], params[0], state);
        }
        if (method === 'eth_chainId') return typeof state.chainId === 'function' ? state.chainId() : state.chainId;
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
  const got = await snapshot(provider, async (at) => [await at.call(TX), await at.call({ ...TX, from: '0x00000000000000000000000000000000000000bb' })]);
  assert.deepEqual(got, { value: ['0x01', '0x01'], block: 90, blockHash: hash('ab') });
  // each call names the block by its hash, and asks the node to refuse it if that block is not the chain's
  assert.deepEqual(state.calls, [pinnedTo(hash('ab')), pinnedTo(hash('ab'))]);
  // the head, then the block at that number again after the calls: two header reads, and no other
  assert.deepEqual(state.asked, ['latest', hex(90)]);
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
        return { listing: 'of the new block', hold: 'of the old one' };
      }
      return { listing: 'of the new block', hold: 'of the new block' };
    });
    assert.equal(tries, 2);
    assert.deepEqual(got.value, { listing: 'of the new block', hold: 'of the new block' });
    assert.equal(got.blockHash, hash('b2'));
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
  const got = await snapshot(provider, async (at) => [await at.call(TX), await at.call(TX)]);
  assert.deepEqual(got, { value: ['0x01', '0x01'], block: 90, blockHash: hash('a1') });
  // a wallet's node is never sent the hash form: what a wallet does with a block parameter it does not know is its own
  assert.deepEqual(state.calls, [hex(90), hex(90)]);
  assert.ok(state.calls.every((selector) => typeof selector === 'string'), 'no blockHash selector');
  assert.deepEqual(state.asked, ['latest', hex(90)]);
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

// ---------------------------------------------------------------- a wallet's node is held to the site's chain
// A wallet can change network at any moment, and its provider goes with it: the next request is answered by the other
// network. A read made through it is of the site's chain or it is no read (PR 242, R5-F2): another network can have a
// contract at the same address, with a listing under the same id.
/** A wallet between networks: each request goes to the node of the network it is on when the request is made. */
function between(networks, on) {
  const state = { on };
  return { to: (name) => { state.on = name; }, provider: { send: (method, params) => networks[state.on].provider.send(method, params) } };
}
const wrongChain = (actual, expected = SITE_CHAIN) => (err) => err instanceof WalletError && err.code === 'wrongChain'
  && Object.is(err.vars.actual, actual) && err.vars.expected === expected;

test('snapshot, a wallet\'s node: a wallet that changes network during a read fails the read, and no try is made on the other network (R5-F2)', async () => {
  // The other network has its own block at the height, and a contract at the address that answers every call. The
  // hashes disagree, so the try is not one block's; made again, the read would be the other network's from end to end.
  for (const [when, before] of [['before the calls of the first try', true], ['after them', false]]) {
    const here = wallet(90, { 90: hash('a1') }, () => '0x01');
    const there = wallet(90, { 90: hash('b2') }, () => '0x02');
    there.state.chainId = hex(OTHER_CHAIN);
    const w = between({ here, there }, 'here');
    let tries = 0;
    await assert.rejects(
      snapshot(w.provider, async (at) => {
        tries += 1;
        if (before) w.to('there');
        const answer = await at.call(TX);
        w.to('there');
        return answer;
      }),
      wrongChain(OTHER_CHAIN),
      when,
    );
    assert.equal(tries, 1, `${when}: the read is not made again on the other network`);
    // all the other network was asked after the switch: the closing header and its chain. No latest block of its own.
    assert.deepEqual(there.state.asked, [hex(90)], when);
    assert.deepEqual(there.state.methods, [...(before ? ['eth_call'] : []), 'eth_getBlockByNumber', 'eth_chainId'], when);
  }
  // A network that has the very block at that height (a fork of the site's chain under another chain id): the hashes
  // agree, and the read is not taken all the same.
  const site90 = wallet(90, { 90: hash('a1') }, () => '0x01');
  const fork = wallet(90, { 90: hash('a1') }, () => '0x02');
  fork.state.chainId = hex(OTHER_CHAIN);
  const w = between({ site90, fork }, 'site90');
  await assert.rejects(snapshot(w.provider, async (at) => { w.to('fork'); return at.call(TX); }), wrongChain(OTHER_CHAIN));
  // The same when the read itself failed on the other network: what is said is the network, not that failure.
  const refusing = wallet(90, { 90: hash('a1') }, () => { throw callError(3, 'execution reverted'); });
  refusing.state.chainId = hex(OTHER_CHAIN);
  const w2 = between({ site90, refusing }, 'site90');
  await assert.rejects(snapshot(w2.provider, async (at) => { w2.to('refusing'); return at.call(TX); }), wrongChain(OTHER_CHAIN));
});

test('snapshot, a wallet\'s node: it is asked its chain after the calls of every try, and anything but the site\'s chain is a failed read', async () => {
  // a wallet that stays on the site's chain reads as before: the header, the calls, the header again, and then its chain
  const { provider, state } = wallet(90, { 90: hash('a1') });
  assert.deepEqual(await snapshot(provider, async (at) => [await at.call(TX), await at.call(TX)]), { value: ['0x01', '0x01'], block: 90, blockHash: hash('a1') });
  assert.deepEqual(state.methods, ['eth_getBlockByNumber', 'eth_call', 'eth_call', 'eth_getBlockByNumber', 'eth_chainId']);
  // in every try: a block replaced under the first try is read again, on the same chain
  const moving = wallet(90, { 90: hash('a1') });
  let tries = 0;
  await snapshot(moving.provider, async (at) => {
    tries += 1;
    if (tries === 1) moving.state.blocks[90] = hash('a2');
    return at.call(TX);
  });
  assert.deepEqual(moving.state.methods.filter((m) => m !== 'eth_call'), ['eth_getBlockByNumber', 'eth_getBlockByNumber', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber', 'eth_chainId']);
  // on another network from the start, or one that says anything else of its chain: no read, whatever its blocks say
  for (const [said, actual] of [[hex(OTHER_CHAIN), OTHER_CHAIN], ['0x1', 1], ['0x', NaN], ['', 0], [null, 0], [undefined, NaN], ['base', NaN]]) {
    const elsewhere = wallet(90, { 90: hash('a1') });
    elsewhere.state.chainId = said;
    await assert.rejects(snapshot(elsewhere.provider, async (at) => at.call(TX)), wrongChain(actual), JSON.stringify(said));
  }
  // a wallet that does not answer for its chain: a failed read, with the wallet's own failure
  const silent = wallet(90, { 90: hash('a1') });
  silent.state.chainId = () => { throw new Error('the wallet is locked'); };
  await assert.rejects(snapshot(silent.provider, async (at) => at.call(TX)), /the wallet is locked/);
  // a site whose chain is not configured holds a wallet to no chain: nothing is read through one
  const unconfigured = wallet(90, { 90: hash('a1') });
  await assert.rejects(snapshot(unconfigured.provider, async (at) => at.call(TX), { chainId: null }), wrongChain(SITE_CHAIN, null));
  // The site's read address is not asked: it is one chain's by how it was made (chain/wallet.js chainReader).
  const address = site(90, { 90: hash('a1') });
  await snapshot(address.provider, async (at) => at.call(TX));
  assert.deepEqual(address.state.methods, ['eth_getBlockByNumber', 'eth_call', 'eth_getBlockByNumber']);
});

test('snapshot through ethers\' own BrowserProvider, as a page has a wallet: its chain is what the wallet answers each time, never an answer ethers kept (R5-F2)', async () => {
  const here = wallet(90, { 90: hash('a1') }, () => '0x01');
  const there = wallet(90, { 90: hash('b2') }, () => '0x02');
  there.state.chainId = hex(OTHER_CHAIN);
  const w = between({ here, there }, 'here');
  // an injected EIP-1193 provider, with ethers' provider in front, made as chain/wallet.js makes it
  const provider = new BrowserProvider({ request: ({ method, params }) => w.provider.send(method, params ?? []) }, undefined, { pollingInterval: 5000 });
  try {
    assert.deepEqual(await snapshot(provider, async (at) => at.call(TX)), { value: '0x01', block: 90, blockHash: hash('a1') });
    // ethers has asked this wallet its chain by now, and has the site's. The wallet changes network during the next read.
    await assert.rejects(
      snapshot(provider, async (at) => {
        const answer = await at.call(TX);
        w.to('there');
        return answer;
      }),
      wrongChain(OTHER_CHAIN),
    );
    assert.deepEqual(there.state.calls, [], 'no call of a second try reached the other network');
    // still there when the next read starts: no read; and back on the site's chain, it reads again
    await assert.rejects(snapshot(provider, async (at) => at.call(TX)), wrongChain(OTHER_CHAIN));
    w.to('here');
    assert.equal((await snapshot(provider, async (at) => at.call(TX))).value, '0x01');
  } finally {
    provider.destroy();
  }
});

test('snapshot, a wallet\'s node: a try the wallet said it changed network during is not taken, though it is back on the site\'s chain when asked (R5-F2)', async () => {
  assert.equal(typeof snapshots.walletSwitched, 'function', 'chain/snapshot.js is told of the wallet\'s network changes');
  const networks = () => {
    const here = wallet(90, { 90: hash('a1') }, () => '0x01');
    const there = wallet(90, { 90: hash('b2') }, () => '0x02');
    there.state.chainId = hex(OTHER_CHAIN);
    return between({ here, there }, 'here');
  };
  // as chain/wallet.js does when the wallet emits chainChanged
  const announced = (w, name) => { w.to(name); snapshots.walletSwitched(); };
  // away for the calls and back before the closing header: both headers are the site's block, and so is the chain
  // when it is asked. The answers are the other network's. The try is not taken, and the read is made again.
  const once = networks();
  let tries = 0;
  const got = await snapshot(once.provider, async (at) => {
    tries += 1;
    if (tries > 1) return at.call(TX);
    announced(once, 'there');
    const answer = await at.call(TX);
    announced(once, 'here');
    return answer;
  });
  assert.deepEqual(got, { value: '0x01', block: 90, blockHash: hash('a1') });
  assert.equal(tries, 2);
  // a wallet that does so during every try: after the fixed number of tries the read fails, and nothing is returned
  const always = networks();
  tries = 0;
  await assert.rejects(
    snapshot(always.provider, async (at) => {
      tries += 1;
      announced(always, 'there');
      const answer = await at.call(TX);
      announced(always, 'here');
      return answer;
    }),
    (err) => err instanceof SnapshotError,
  );
  assert.equal(tries, SNAPSHOT_TRIES);
  // a change reported between two reads is no part of either
  snapshots.walletSwitched();
  const calm = wallet(90, { 90: hash('a1') });
  assert.equal((await snapshot(calm.provider, async (at) => at.call(TX))).value, '0x01');
  assert.deepEqual(calm.state.asked, ['latest', hex(90)]);
  // the site's read address is not the wallet's: a wallet's change of network is nothing to a read made there
  const address = site(90, { 90: hash('a1') });
  assert.equal((await snapshot(address.provider, async (at) => { snapshots.walletSwitched(); return at.call(TX); })).value, '0x01');
  assert.deepEqual(address.state.asked, ['latest', hex(90)]);
  // chain/wallet.js hears the wallet where a wallet's provider is made, by one listener per wallet
  const made = read('../src/chain/wallet.js');
  assert.match(made, /function hearWallet\(\) \{\s*if \(heard === window\.ethereum\) return;\s*heard = window\.ethereum;\s*heard\.on\?\.\('chainChanged', walletSwitched\);\s*\}/);
  assert.equal(made.split('hearWallet();').length - 1, 2, 'on connecting, and for the reader of a site with no read address');
  assert.match(made, /if \(!hasWallet\(\)\) throw new WalletError\('none'\);\s*hearWallet\(\);/);
  assert.match(made, /else if \(hasWallet\(\)\) \{\s*hearWallet\(\);/);
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
  assert.match(code, /\/\^0x\[0-9a-f\]\{64\}\$\/i\.test\(block\.hash\)/);
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

test('snapshot: without the latest block\'s header, or with one whose hash is not 32 bytes of hex, there is no read', async () => {
  const empty = node(90, {});
  await assert.rejects(snapshot(empty.provider, async () => 1), /did not answer with its latest block/);
  for (const malformed of ['0x', '0x1234', `${hash('70')}00`, 'not a hash']) {
    const broken = node(90, { 90: malformed });
    await assert.rejects(snapshot(broken.provider, async () => 1), /did not answer with its latest block/, JSON.stringify(malformed));
  }
});

// ---------------------------------------------------------------- what the page says of a hold is read through it
/** A component's code without its comments: what it does, not what it says it does. */
const codeOf = (name) => read(`../src/components/${name}`)
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '');

test('the page\'s read of the listing is one snapshot: the count, the listing and its hold are one block\'s', () => {
  const page = codeOf('FundPage.jsx');
  const fn = page.slice(page.indexOf('async function readListing('), page.indexOf('\n}\n', page.indexOf('async function readListing(')));
  assert.match(fn, /const \{ value, block \} = await snapshot\(await chainReader\(\), async \(at\) => \{\s*const view = stakeAttestation\(at\);\s*const listing = await listingAt\(view, listingId\);\s*return listing === null \? \{ missing: true \} : \{ listing, hold: await readHold\(view, listingId\) \};\s*\}\);\s*return \{ \.\.\.value, block \};/);
  // it is the page's only read of the listing: the first load, and every read after a transaction or a disagreement
  assert.equal(page.split('readListing(').length - 1, 3, 'its definition, the load and the refresh');
  // and the page reads the chain no other way: no contract of its own, no block named, no call of a node
  assert.equal(page.split('stakeAttestation(').length - 1, 1, 'the one contract is the snapshot\'s');
  assert.doesNotMatch(page, /blockTag|eth_blockNumber|eth_call|getBlockNumber\(|getBlock\(|\.send\(|\.heldAt\(|\.getListing\(/);
  // the two helpers read the contract they are given, and name no block
  assert.match(read('../src/chain/wallet.js'), /export async function listingAt\(contract, listingId\) \{\s*const id = BigInt\(listingId\);\s*if \(id === 0n \|\| id > BigInt\(await contract\.listingCount\(\)\)\) return null;\s*return contract\.getListing\(id\);/);
  assert.match(read('../src/lib/hold.js'), /export async function readHold\(sa, listingId\) \{\s*try \{\s*const heldAt = BigInt\(await sa\.heldAt\(BigInt\(listingId\)\)\);/);
});

test('every read of a hold on the listing\'s page is made on a snapshot\'s contract, with the listing it is the hold of', () => {
  // readHold is the one reader of the heldAt view, and it is called nowhere but inside a snapshot's read
  let reads = 0;
  for (const name of ['FundPage.jsx', 'FundListing.jsx', 'ListingActions.jsx', 'ListingExtras.jsx']) {
    const source = codeOf(name);
    assert.doesNotMatch(source, /\.heldAt\(/, `${name}: the view is read through readHold`);
    for (const m of source.matchAll(/\breadHold\(([^,]+), /g)) {
      assert.match(m[1], /^(?:view|sa)$/, `${name}: readHold(${m[1]}, …)`);
      // the contract it reads is made on a snapshot's runner, in the snapshot's read it is called in
      const before = source.slice(0, m.index);
      const opened = before.lastIndexOf('snapshot(');
      assert.ok(opened > -1, `${name}: readHold inside a snapshot`);
      const inside = source.slice(opened, m.index);
      assert.match(inside, /\(at\) => \{\s*const (?:view|sa) = stakeAttestation\(at\);/, `${name}: on the snapshot's own contract`);
      assert.match(inside, /(?:listingAt\((?:view|sa), |\.getListing\(BigInt\()/, `${name}: with the listing, in the same read`);
      reads += 1;
    }
  }
  assert.equal(reads, 4, 'the page\'s read; the hold\'s read before sending; the successors; the roll\'s read before sending');
  // the snapshot itself: the head, the calls at its hash, the same height's hash after them, a fixed number of tries
  const lib = read('../src/chain/snapshot.js');
  assert.match(lib, /const head = await header\(provider, 'latest'\);/);
  assert.match(lib, /call: \(tx\) => provider\.send\('eth_call', \[\{ to: tx\.to, data: tx\.data \?\? '0x', \.\.\.\(tx\.from \? \{ from: tx\.from \} : \{\}\) \}, selector\]\),/);
  assert.match(lib, /if \(hashOf\(await header\(provider, block\)\) === blockHash\) \{[\s\S]*?if \(failure\) throw failure;\s*return \{ value, block, blockHash \};\s*\}/);
  assert.match(lib, /throw new SnapshotError\(tries\);/);
  // nothing of a kept receipt is left in it: no heights asked for, no hashes carried
  assert.doesNotMatch(lib, /heights|hashes|parentHash/);
});
