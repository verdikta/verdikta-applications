// Roll forward picks a funded successor of the same artifact (design §7.1, §13.2): the maker's
// own open listing of the same repository at another commit, without a predecessor yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { confirmSuccessor, successorCandidates } from '../src/lib/successors.js';

const MAKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const REPO = 'https://github.com/acme/vault';

const entry = (id, over = {}) => ({
  listingId: String(id),
  maker: MAKER,
  artifactHash: `0x${String(id).padStart(64, '0')}`,
  artifact: { kind: 'Repo', repo: REPO, baseCommit: `${id}`.padEnd(40, 'a'), chainId: '0', address: '0x0000000000000000000000000000000000000000' },
  escrowRemainingWei: '2000000000000000000',
  openedAt: 1_800_000_000,
  ...over,
});

test('the maker\'s other open listings of the same repository and kind', () => {
  const feed = [
    entry(4),
    entry(5, { maker: OTHER.toLowerCase() }),
    entry(6, { artifact: { ...entry(6).artifact, repo: 'https://github.com/acme/other' } }),
    entry(7, { artifact: { ...entry(7).artifact, kind: 'Contract' } }),
    entry(8, { maker: MAKER.toLowerCase() }),
    entry(3),
  ];
  const got = successorCandidates(feed, { listingId: 3n, maker: MAKER, kind: 'Repo', repo: REPO });
  assert.deepEqual(got.map((e) => e.listingId), ['4', '8']);
});

test('nothing when the listing\'s identity is unknown', () => {
  assert.deepEqual(successorCandidates([entry(4)], { listingId: 3n, maker: MAKER, kind: 'Repo', repo: null }), []);
});

test('confirmSuccessor: open, the maker\'s, no predecessor, not the listing itself', () => {
  const ok = { state: 1n, maker: MAKER, predecessor: 0n };
  assert.equal(confirmSuccessor(ok, { successorId: 4n, listingId: 3n, account: MAKER.toLowerCase() }), true);
  assert.equal(confirmSuccessor({ ...ok, state: 0n }, { successorId: 4n, listingId: 3n, account: MAKER }), false, 'Listed');
  assert.equal(confirmSuccessor({ ...ok, state: 2n }, { successorId: 4n, listingId: 3n, account: MAKER }), false, 'Depleted');
  assert.equal(confirmSuccessor({ ...ok, predecessor: 2n }, { successorId: 4n, listingId: 3n, account: MAKER }), false, 'already a successor');
  assert.equal(confirmSuccessor({ ...ok, maker: OTHER }, { successorId: 4n, listingId: 3n, account: MAKER }), false, 'another maker');
  assert.equal(confirmSuccessor(ok, { successorId: 3n, listingId: 3n, account: MAKER }), false, 'itself');
});
