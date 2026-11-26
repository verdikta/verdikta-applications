// Chain reads (src/chain/wallet.js) are checked to come from the site's chain before anything
// read is shown or funded.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WalletError, listingAt, minedReceipt, verifyChain } from '../src/chain/wallet.js';

test('reads are checked to come from the site\'s chain', async () => {
  const provider = (id) => ({ send: async (m) => { assert.equal(m, 'eth_chainId'); return id; } });
  await verifyChain(provider('0x7a69'), 31337);
  await assert.rejects(verifyChain(provider('0x1'), 31337), (e) => e instanceof WalletError && e.code === 'wrongChain' && e.vars.actual === 1 && e.vars.expected === 31337);
});

// A wallet can send a pending transaction again at a higher fee. The same call is then mined under another hash, and
// ethers rejects wait() with TRANSACTION_REPLACED and that transaction's receipt (its `reason`: repriced). The call
// succeeded: a page that said "the transaction failed" would be wrong, and after a hold it would offer the hold again.
test('minedReceipt: the receipt, also of the same call sent again at a higher fee; never of a cancellation, another call or a revert', async () => {
  const receipt = { hash: '0xmined', status: 1, blockNumber: 90, logs: [] };
  assert.equal(await minedReceipt({ wait: async () => receipt }), receipt);
  const replaced = (o) => ({ wait: async () => { throw Object.assign(new Error('transaction was replaced'), { code: 'TRANSACTION_REPLACED', ...o }); } });
  const repriced = { hash: '0xrepriced', status: 1, blockNumber: 91, logs: [] };
  assert.equal(await minedReceipt(replaced({ reason: 'repriced', cancelled: false, receipt: repriced })), repriced, 'the replacement\'s receipt, with its own hash');
  // the wallet cancelled it, or sent something else at that nonce: not this call
  for (const o of [{ reason: 'cancelled', cancelled: true, receipt: repriced }, { reason: 'replaced', cancelled: true, receipt: repriced }]) {
    await assert.rejects(minedReceipt(replaced(o)), (err) => err.code === 'TRANSACTION_REPLACED', o.reason);
  }
  // repriced, and it reverted: no success to report
  await assert.rejects(minedReceipt(replaced({ reason: 'repriced', cancelled: false, receipt: { ...repriced, status: 0 } })), (err) => err.code === 'TRANSACTION_REPLACED');
  await assert.rejects(minedReceipt(replaced({ reason: 'repriced', cancelled: false, receipt: null })), (err) => err.code === 'TRANSACTION_REPLACED');
  // anything else a wait rejects with is passed on as it is
  const reverted = Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
  await assert.rejects(minedReceipt({ wait: async () => { throw reverted; } }), (err) => err === reverted);
});

// Node P42: a listing's page knows its read is behind after each transaction it sends and sees mined, on every path
// that sends. So whatever was mined, its block is handed over first: the receipt's, a replacement's of any kind, and
// that of a transaction that reverted. Only a wait that rejects with no receipt at all (never mined) tells nothing.
test('minedReceipt: the block of whatever was mined is told first, on every path: mined, sent again, replaced, cancelled, reverted', async () => {
  const told = [];
  const onMined = (block) => told.push(block);
  const replaced = (o) => ({ wait: async () => { throw Object.assign(new Error('transaction was replaced'), { code: 'TRANSACTION_REPLACED', ...o }); } });
  const receipt = (blockNumber, status = 1) => ({ hash: '0xmined', status, blockNumber, logs: [] });
  assert.equal((await minedReceipt({ wait: async () => receipt(90) }, onMined)).blockNumber, 90);
  assert.equal((await minedReceipt(replaced({ reason: 'repriced', cancelled: false, receipt: receipt(91) }), onMined)).blockNumber, 91);
  await assert.rejects(minedReceipt(replaced({ reason: 'cancelled', cancelled: true, receipt: receipt(92) }), onMined));
  await assert.rejects(minedReceipt(replaced({ reason: 'replaced', cancelled: true, receipt: receipt(93) }), onMined));
  await assert.rejects(minedReceipt(replaced({ reason: 'repriced', cancelled: false, receipt: receipt(94, 0) }), onMined));
  await assert.rejects(minedReceipt({ wait: async () => { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', receipt: receipt(95, 0) }); } }, onMined));
  assert.deepEqual(told, [90, 91, 92, 93, 94, 95]);
  // never mined: the wallet dropped it, or the wait itself failed
  await assert.rejects(minedReceipt({ wait: async () => { throw new Error('timeout'); } }, onMined));
  await assert.rejects(minedReceipt(replaced({ reason: 'repriced', cancelled: false, receipt: null }), onMined));
  assert.equal(told.length, 6);
  // it is told before the caller has the receipt: nothing the caller does next can keep the page from knowing
  const order = [];
  await minedReceipt({ wait: async () => receipt(96) }, () => order.push('told')).then(() => order.push('returned'));
  assert.deepEqual(order, ['told', 'returned']);
});

test('listingAt: the listing of a snapshot\'s contract, or null when it has none of that id, and never a getListing the contract would revert', async () => {
  const asked = [];
  // a contract made on a snapshot's runner: its calls are that block's, and take no block of their own
  const contract = (count) => ({
    listingCount: async (...more) => { asked.push(['listingCount', ...more]); return count; },
    getListing: async (id, ...more) => { asked.push(['getListing', id, ...more]); return { id }; },
  });
  assert.deepEqual(await listingAt(contract(5n), '5'), { id: 5n });
  assert.deepEqual(asked, [['listingCount'], ['getListing', 5n]], 'the count first, then the listing, on the same contract');
  asked.length = 0;
  // one past the count (its block was dropped), and 0: no listing, and getListing is not called
  assert.equal(await listingAt(contract(4n), 5), null);
  assert.equal(await listingAt(contract(4n), 0), null);
  assert.deepEqual(asked, [['listingCount']]);
  // a count that is a number (another client of the same ABI) compares the same
  assert.deepEqual(await listingAt(contract(5), 5n), { id: 5n });
  // a read that fails rejects: it is never "no listing"
  await assert.rejects(listingAt({ listingCount: async () => { throw new Error('rate limit'); } }, 5), /rate limit/);
});
