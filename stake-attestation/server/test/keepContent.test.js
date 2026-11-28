// Review 2026-11-27, item 2: the site pins the content of unresolved claims (src/site/keepContent.js),
// so a round after the first cannot be vetoed by taking the claim offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMockPinner, rawCid } from '../src/pinning/index.js';
import { MAX_KEPT_PER_RUN, contentOf, keepClaimContent } from '../src/site/keepContent.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const bytesOf = (s) => Buffer.from(s);
const CT = bytesOf('ciphertext of claim 1');
const ARCHIVE = bytesOf('plaintext archive of claim 1');
const ev = (name, args) => ({ name, args });

function storeOf(events) {
  return { locked: true, state: { events, kept: {} }, transact(fn) { fn(this.state); } };
}

test('contentOf: the ciphertext and claim archive of unresolved claims only', () => {
  const events = [
    ev('Committed', { claimId: '1', listingId: '1' }),
    ev('Disclosed', { claimId: '1', listingId: '1', ciphertextCid: 'ct1' }),
    ev('Revealed', { claimId: '1', listingId: '1', bcid: 'b1' }),
    ev('Disclosed', { claimId: '2', listingId: '1', ciphertextCid: 'ct2' }),
    ev('Expired', { claimId: '2', listingId: '1' }),
    ev('Disclosed', { claimId: '3', listingId: '1', ciphertextCid: 'ct3' }),
    ev('Revealed', { claimId: '3', listingId: '1', bcid: 'b3' }),
    ev('Settled', { claimId: '3', listingId: '1' }),
    ev('Funded', { listingId: '1' }),
  ];
  assert.deepEqual([...contentOf(events)], [['ct1', { claimId: '1', role: 'ciphertext' }], ['b1', { claimId: '1', role: 'claim' }]]);
});

test('what a gateway serves is pinned under the claim\'s own CID, once', async () => {
  const pinner = createMockPinner();
  const served = new Map([[rawCid(CT), CT], [rawCid(ARCHIVE), ARCHIVE]]);
  let fetches = 0;
  const fetchContent = async (cid) => { fetches += 1; return served.get(cid); };
  const store = storeOf([
    ev('Disclosed', { claimId: '1', ciphertextCid: rawCid(CT) }),
    ev('Revealed', { claimId: '1', bcid: rawCid(ARCHIVE) }),
  ]);
  await keepClaimContent({ fetchContent, pinner, store, now: () => 1000, retryMs: 100, logger: quiet });
  assert.equal(store.state.kept[rawCid(CT)].kept, true);
  assert.equal(store.state.kept[rawCid(ARCHIVE)].kept, true);
  assert.deepEqual(pinner.get(rawCid(ARCHIVE)), ARCHIVE);
  await keepClaimContent({ fetchContent, pinner, store, now: () => 2000, retryMs: 100, logger: quiet });
  assert.equal(fetches, 2, 'a kept CID is not fetched again');
});

test('content that is offline is retried with a backoff, and kept once it appears', async () => {
  const pinner = createMockPinner();
  let online = false;
  const fetchContent = async () => { if (!online) throw new Error('no gateway answered'); return ARCHIVE; };
  const cid = rawCid(ARCHIVE);
  const store = storeOf([ev('Revealed', { claimId: '7', bcid: cid })]);
  let t = 1000;
  await keepClaimContent({ fetchContent, pinner, store, now: () => t, retryMs: 100, logger: quiet });
  assert.deepEqual(store.state.kept[cid], { pending: true, attempts: 1, nextAt: 1100 });
  online = true;
  t = 1050;
  await keepClaimContent({ fetchContent, pinner, store, now: () => t, retryMs: 100, logger: quiet });
  assert.equal(store.state.kept[cid].pending, true, 'not before its wait is over');
  t = 1100;
  await keepClaimContent({ fetchContent, pinner, store, now: () => t, retryMs: 100, logger: quiet });
  assert.equal(store.state.kept[cid].kept, true);
});

test('a backend that gives the bytes another CID: stored as not kept, not retried', async () => {
  const pinner = { backend: 'other', pins: 0, async pin() { this.pins += 1; return 'bafyOTHER'; } };
  const store = storeOf([ev('Revealed', { claimId: '1', bcid: 'bafyHUNTERS' })]);
  for (const t of [1, 10 ** 9]) await keepClaimContent({ fetchContent: async () => ARCHIVE, pinner, store, now: () => t, retryMs: 100, logger: quiet });
  assert.equal(store.state.kept.bafyHUNTERS.error, 'KEEP_OTHER_CID');
  assert.equal(pinner.pins, 1);
});

test('a run is bounded, and answers of resolved claims are dropped', async () => {
  const pinner = createMockPinner();
  const blobs = Array.from({ length: MAX_KEPT_PER_RUN + 3 }, (_, i) => bytesOf(`claim ${i}`));
  const events = blobs.map((b, i) => ev('Revealed', { claimId: String(i), bcid: rawCid(b) }));
  const store = storeOf(events);
  const fetchContent = async (cid) => blobs.find((b) => rawCid(b) === cid);
  await keepClaimContent({ fetchContent, pinner, store, now: () => 1, retryMs: 100, logger: quiet });
  assert.equal(Object.keys(store.state.kept).length, MAX_KEPT_PER_RUN);
  store.state.events = [...events, ...blobs.map((_, i) => ev('Settled', { claimId: String(i) }))];
  await keepClaimContent({ fetchContent, pinner, store, now: () => 2, retryMs: 100, logger: quiet });
  assert.deepEqual(store.state.kept, {});
});
