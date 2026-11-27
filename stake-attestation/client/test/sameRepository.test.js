// Node P35 (claim test, item 3): a listing's page shows the other listings of its repository, as the feed does. The
// feed entry says them (sameRepository); a listing's own page reads its record, whose sameRepository holds the other
// versions and whose listings, counted or apart, hold the others of its own version. One list either way: each other
// listing once, its id, commit, state, whether it counts and its page, oldest first, never the listing itself.
// Node P42: and since when its maker has it on hold (the API's heldAt, node P40), or null: a listing on hold is Open or
// Depleted on-chain and takes no commit, so its state alone does not say it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { otherListingsOfFeedEntry, otherListingsOfRecord } from '../src/lib/sameRepository.js';
import { STRINGS, fill } from '../src/strings.js';

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
  heldAt: null,
  counted: true,
  page: `/#/fund/${id}`,
  ...over,
});
const HELD_AT = 1_800_000_123;

test('a feed entry\'s list, as the server gives it, oldest first', () => {
  const e = { listingId: '5', sameRepository: [related(9, 2, { state: 'Closed' }), related(2, 1, { counted: false })] };
  assert.deepEqual(otherListingsOfFeedEntry(e), [
    { listingId: '2', baseCommit: commitOf(1), state: 'Open', lapsed: false, heldAt: null, counted: false, page: '#/fund/2' },
    { listingId: '9', baseCommit: commitOf(2), state: 'Closed', lapsed: false, heldAt: null, counted: true, page: '#/fund/9' },
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
    { listingId: '1', baseCommit: commitOf(1), state: 'Rolled', lapsed: false, heldAt: null, counted: true, page: '#/fund/1' },
    { listingId: '7', baseCommit: commitOf(3), state: 'Depleted', lapsed: true, heldAt: null, counted: true, page: '#/fund/7' },
    { listingId: '8', baseCommit: commitOf(3), state: 'Open', lapsed: false, heldAt: null, counted: false, page: '#/fund/8' },
    { listingId: '10', baseCommit: commitOf(2), state: 'Listed', lapsed: false, heldAt: null, counted: false, page: '#/fund/10' },
  ]);
  assert.deepEqual(otherListingsOfRecord(answer, '8').map((x) => x.listingId), ['1', '4', '7', '10']);
  // a server before the field, or no record at all: what the record itself says, or nothing
  assert.deepEqual(otherListingsOfRecord({ ...answer, sameRepository: undefined }, '4').map((x) => x.listingId), ['7', '8']);
  assert.deepEqual(otherListingsOfRecord(null, '4'), []);
});

test('a listing on hold is said to be, with its time, wherever the server says it: a feed entry\'s list, and a record\'s three', () => {
  // a feed entry's other listings: the server's heldAt, as it is
  const e = { listingId: '5', sameRepository: [related(2, 1, { heldAt: HELD_AT }), related(9, 2, { state: 'Depleted', heldAt: HELD_AT + 5 }), related(11, 4)] };
  assert.deepEqual(otherListingsOfFeedEntry(e).map((x) => [x.listingId, x.state, x.heldAt]), [['2', 'Open', HELD_AT], ['9', 'Depleted', HELD_AT + 5], ['11', 'Open', null]]);
  // a record: the other versions carry it themselves; a listing of this version that counts has it in its labels (the
  // record is the lens's answer and has no such field); one that does not count carries it in its own row
  const answer = {
    artifact: { kind: 'Repo', repo: REPO, baseCommit: commitOf(3), chainId: '0', address: ZERO },
    record: { listings: [{ listingId: '4', state: 'Open', lapsed: false }, { listingId: '7', state: 'Open', lapsed: false }] },
    labels: { listings: { 4: { stake: 'staked', lapsed: false, heldAt: null, live: true }, 7: { stake: 'staked', lapsed: false, heldAt: HELD_AT, live: false } } },
    notCounted: { listings: [{ listingId: '8', state: 'Depleted', lapsed: false, heldAt: HELD_AT + 1, reason: 'PROOF_NAMES_ANOTHER_MAKER' }] },
    sameRepository: [related(1, 1, { heldAt: HELD_AT + 2 }), related(10, 2)],
  };
  assert.deepEqual(otherListingsOfRecord(answer, '4'), [
    { listingId: '1', baseCommit: commitOf(1), state: 'Open', lapsed: false, heldAt: HELD_AT + 2, counted: true, page: '#/fund/1' },
    { listingId: '7', baseCommit: commitOf(3), state: 'Open', lapsed: false, heldAt: HELD_AT, counted: true, page: '#/fund/7' },
    { listingId: '8', baseCommit: commitOf(3), state: 'Depleted', lapsed: false, heldAt: HELD_AT + 1, counted: false, page: '#/fund/8' },
    { listingId: '10', baseCommit: commitOf(2), state: 'Open', lapsed: false, heldAt: null, counted: true, page: '#/fund/10' },
  ]);
  // an answer from a server before the field, or with no labels: not on hold, never a failure
  assert.deepEqual(otherListingsOfRecord({ ...answer, labels: undefined, notCounted: { listings: [{ listingId: '8', state: 'Open', lapsed: false }] }, sameRepository: [{ ...related(1, 1), heldAt: undefined }] }, '4').map((x) => x.heldAt), [null, null, null]);
  // the list says it in a hint with the time, as it says a lapsed fee, and the pill is green only for a listing that
  // takes claims here: never for one on hold
  const S = STRINGS.sameRepository;
  assert.equal(fill(S.held, { time: 'T' }), 'on hold since T');
  const list = fs.readFileSync(new URL('../src/components/SameRepository.jsx', import.meta.url), 'utf8');
  assert.match(list, /<StatePill key="state" state=\{x\.lapsed \|\| !x\.counted \|\| x\.heldAt !== null \? null : x\.state\} text=\{p\.value\} \/>/);
  assert.match(list, /\{x\.heldAt !== null && <span className="hint" data-testid=\{`same-repository-\$\{x\.listingId\}-held`\}> \(\{fill\(S\.held, \{ time: formatTime\(x\.heldAt\) \}\)\}\)<\/span>\}/);
});

test('the page shows them under a heading of their own, and says what they are', () => {
  const S = STRINGS.sameRepository;
  for (const k of ['title', 'intro', 'none', 'line', 'notCounted', 'lapsed', 'held', 'unavailable']) assert.equal(typeof S[k], 'string', k);
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
