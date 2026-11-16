// Node P35 (claim test, item 3): a listing's page shows the other listings of its repository, as the feed does. The
// feed entry says them (sameRepository); a listing's own page reads its record, whose sameRepository holds the other
// versions and whose listings, counted or apart, hold the others of its own version. One list either way: each other
// listing once, its id, commit, state, whether it counts and its page, oldest first, never the listing itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { otherListingsOfFeedEntry, otherListingsOfRecord } from '../src/lib/sameRepository.js';
import { STRINGS } from '../src/strings.js';

const REPO = 'https://github.com/acme/vault';
const ZERO = '0x0000000000000000000000000000000000000000';
const commitOf = (n) => String(n).repeat(40).slice(0, 40);
const hashOf = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
const related = (id, n, over = {}) => ({
  listingId: String(id),
  artifactHash: hashOf(n),
  artifact: { kind: 'Repo', repo: REPO, baseCommit: commitOf(n), chainId: '0', address: ZERO },
  state: 'Open',
  lapsed: false,
  counted: true,
  page: `/#/fund/${id}`,
  ...over,
});

test('a feed entry\'s list, as the server gives it, oldest first', () => {
  const e = { listingId: '5', sameRepository: [related(9, 2, { state: 'Closed' }), related(2, 1, { counted: false })] };
  assert.deepEqual(otherListingsOfFeedEntry(e), [
    { listingId: '2', baseCommit: commitOf(1), state: 'Open', lapsed: false, counted: false, page: '#/fund/2' },
    { listingId: '9', baseCommit: commitOf(2), state: 'Closed', lapsed: false, counted: true, page: '#/fund/9' },
  ]);
  // an answer from a server before the field: nothing to show, never a failure
  assert.deepEqual(otherListingsOfFeedEntry({ listingId: '5' }), []);
});

test('a record: its other versions, and the others of its own version, counted or apart; never the listing itself', () => {
  const answer = {
    artifact: { kind: 'Repo', repo: REPO, baseCommit: commitOf(3), chainId: '0', address: ZERO },
    record: { listings: [{ listingId: '4', state: 'Open', lapsed: false }, { listingId: '7', state: 'Depleted', lapsed: true }] },
    notCounted: { listings: [{ listingId: '8', state: 'Open', lapsed: false, reason: 'PROOF_NAMES_ANOTHER_MAKER' }] },
    sameRepository: [related(1, 1, { state: 'Rolled' }), related(10, 2, { state: 'Listed', counted: false })],
  };
  assert.deepEqual(otherListingsOfRecord(answer, '4'), [
    { listingId: '1', baseCommit: commitOf(1), state: 'Rolled', lapsed: false, counted: true, page: '#/fund/1' },
    { listingId: '7', baseCommit: commitOf(3), state: 'Depleted', lapsed: true, counted: true, page: '#/fund/7' },
    { listingId: '8', baseCommit: commitOf(3), state: 'Open', lapsed: false, counted: false, page: '#/fund/8' },
    { listingId: '10', baseCommit: commitOf(2), state: 'Listed', lapsed: false, counted: false, page: '#/fund/10' },
  ]);
  assert.deepEqual(otherListingsOfRecord(answer, '8').map((x) => x.listingId), ['1', '4', '7', '10']);
  // a server before the field, or no record at all: what the record itself says, or nothing
  assert.deepEqual(otherListingsOfRecord({ ...answer, sameRepository: undefined }, '4').map((x) => x.listingId), ['7', '8']);
  assert.deepEqual(otherListingsOfRecord(null, '4'), []);
});

test('the page shows them under a heading of their own, and says what they are', () => {
  const S = STRINGS.sameRepository;
  for (const k of ['title', 'intro', 'none', 'line', 'notCounted', 'lapsed', 'unavailable']) assert.equal(typeof S[k], 'string', k);
  assert.match(S.intro, /repository/);
  assert.match(S.intro, /own terms/);
  // R1-F1: listings of one artifact hash share the version's record (a deployed contract's hash holds its chain and
  // address too); no listing has a record of its own
  assert.match(S.intro, /listings with the same artifact hash share it/);
  assert.match(S.intro, /chain and address/);
  assert.doesNotMatch(S.intro, /one commit share/);
  assert.doesNotMatch(S.intro, /own [^.]*record/);
  assert.match(S.line, /\{id\}/);
  assert.match(S.line, /\{commit\}/);
  assert.match(S.line, /\{state\}/);
});
