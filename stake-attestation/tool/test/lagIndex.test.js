// Fault injection (round-2 security review, faults direction): an RPC whose receipt and log indexes lag
// its state. The commit is mined, so the account's nonce moves, but no receipt and no log say so for
// longer than receiptGraceMs. The tool used to call the commit "gone", set the folder back to prepared,
// and a re-run paid a second bond and prepay for the same claim.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction } from 'ethers';

import { makeClaimDir, makeWorld } from './helpers/world.js';

let w;
before(async () => { w = await makeWorld(); });
after(async () => { await w.close(); });

// Hides the first broadcast transaction (the commit) from receipt and transaction lookups, and every
// log, while lag.on; the account's nonce and the contract's state stay current.
function laggy(provider, lag) {
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === 'broadcastTransaction') {
        return async (raw) => {
          if (!lag.hash) { lag.hash = Transaction.from(raw).hash; lag.on = true; }
          return target.broadcastTransaction(raw);
        };
      }
      if (prop === 'getTransactionReceipt' || prop === 'getTransaction') {
        return async (h) => (lag.on && h === lag.hash ? null : target[prop](h));
      }
      if (prop === 'getLogs') return async (f) => (lag.on ? [] : target.getLogs(f));
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

test('a commit whose receipt and log the node does not show yet is found in the contract\'s state, not paid twice', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const count = await w.claimCount();
  const lag = { on: false, hash: null };
  const provider = laggy(w.provider, lag);
  let first;
  try {
    first = await w.hunter({ provider, receiptGraceMs: 0 }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  } catch (err) {
    first = err;
  }
  // a re-run while the index still lags must not commit again
  let second;
  try {
    second = await w.hunter({ provider, receiptGraceMs: 0 }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  } catch (err) {
    second = err;
  }
  assert.equal(await w.claimCount(), count + 1n, `exactly one claim (first run: ${first?.code ?? first?.stage}, second: ${second?.code ?? second?.stage})`);
  assert.equal(second.stage, 'disclosed');
});
