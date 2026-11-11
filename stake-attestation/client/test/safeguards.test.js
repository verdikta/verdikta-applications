// Node P18: what the claim, listing and record pages say of the settlement safeguards (design
// §13.2, errata E7-E9), each from the contract's own reads: the lens's appealDeadline,
// settleableAt, retriggerDeadline, confirmWindow and judgeVector for a claim; getListing's floor
// and size; recordByHash's counts. The pages state no outcome or bond the contract does not: a
// bond only once settle has moved it, by the rule settle applies.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeguardTerms, safeguardView } from '../src/lib/claimActions.js';
import { recordView } from '../src/lib/record.js';
import { STRINGS, fill } from '../src/strings.js';
import { wordingProblems } from '../e2e/support/wording.js';

const NOW = 1_800_000_000n;
const base = {
  state: 'Judged', outcome: 'INVALID', dispute: 'None', disputeKind: 'None', late: false, now: NOW,
  appealDeadline: 0n, settleableAt: 0n, retriggerDeadline: 0n, confirmOpensAt: 0n, confirmDeadline: 0n,
  narrow: false, awardWei: 0n, confirmAboveWei: 0n,
};
const v = (over) => safeguardView({ ...base, ...over });

test('a claim round\'s INVALID inside its window: the appeal window, and that the hunter\'s own settle waives it', () => {
  const s = v({ appealDeadline: NOW + 3600n, settleableAt: NOW + 3600n });
  assert.deepEqual(s.appeal, { open: true, until: NOW + 3600n });
  assert.equal(s.waiver, true);
  assert.equal(s.roundKind, 'None');
  assert.equal(s.bond, null, 'not settled: no bond is stated');
  assert.equal(s.confirmation, null);
});

test('the window over: no appeal, no waiver', () => {
  const s = v({ appealDeadline: NOW, settleableAt: NOW });
  assert.equal(s.appeal.open, false);
  assert.equal(s.waiver, false);
});

test('an appeal: its kind; with no verdict, the one re-trigger and its window, which the hunter\'s settle also waives', () => {
  assert.equal(v({ state: 'Disputed', dispute: 'Pending', disputeKind: 'Appeal' }).roundKind, 'Appeal');
  const failed = v({ dispute: 'NoVerdict', disputeKind: 'Appeal', retriggerDeadline: NOW + 100n, settleableAt: NOW + 100n });
  assert.deepEqual(failed.appealRetrigger, { until: NOW + 100n });
  assert.equal(failed.waiver, true);
  assert.equal(failed.appeal, null);
  const held = v({ dispute: 'Held', disputeKind: 'Appeal', settleableAt: NOW - 5n });
  assert.equal(held.appealRetrigger, null);
  assert.equal(held.waiver, false);
});

test('a confirmation: awaiting while the dispute window runs, open from its end, pending while its round runs, closed from the deadline', () => {
  const judged = { outcome: 'HIGH', awardWei: 4n, confirmAboveWei: 0n, confirmOpensAt: NOW + 10n, confirmDeadline: NOW + 1000n, settleableAt: NOW + 1000n };
  assert.equal(v(judged).confirmation.state, 'awaiting');
  assert.equal(v({ ...judged, now: NOW + 10n }).confirmation.state, 'open');
  assert.equal(v({ ...judged, now: NOW + 1000n }).confirmation.state, 'closed');
  assert.equal(v({ ...judged, state: 'Disputed', dispute: 'Pending', disputeKind: 'Confirmation' }).confirmation.state, 'pending');
  assert.equal(v({ ...judged, now: NOW + 10n }).confirmation.deadline, NOW + 1000n);
  assert.equal(v(judged).appeal, null, 'a valid outcome has no appeal');
  assert.equal(v(judged).waiver, false);
  // after the panel's verdict the lens reports no window; the claim's fields say how it ended
  assert.equal(v({ outcome: 'HIGH', dispute: 'Held', disputeKind: 'Confirmation', state: 'Settled' }).confirmation.state, 'held');
  assert.equal(v({ outcome: 'MEDIUM', dispute: 'Overturned', disputeKind: 'Confirmation', state: 'Settled' }).confirmation.state, 'overturned');
  // settled from the deadline with no panel verdict: the contract's rule (an award above the size, no verdict)
  assert.equal(v({ outcome: 'HIGH', state: 'Settled', awardWei: 4n, confirmAboveWei: 1n }).confirmation.state, 'noVerdict');
  assert.equal(v({ outcome: 'HIGH', state: 'Settled', awardWei: 4n, confirmAboveWei: 4n }).confirmation, null, 'at or below the size: none');
  assert.equal(v({ outcome: 'HIGH', state: 'Settled', awardWei: 4n, confirmAboveWei: 0n, late: true }).confirmation, null, 'a late claim: none');
});

test('the bond, only once settled, by settle\'s rule: a narrow INVALID\'s comes back, another INVALID\'s goes to the maker', () => {
  assert.equal(v({ state: 'Settled', narrow: true }).bond, 'returnedNarrow');
  assert.equal(v({ state: 'Settled', narrow: false }).bond, 'forfeited');
  assert.equal(v({ state: 'Settled', outcome: 'DUPLICATE' }).bond, 'returned');
  assert.equal(v({ state: 'Settled', outcome: 'HIGH', awardWei: 4n, confirmAboveWei: 9n }).bond, 'returned');
  assert.equal(v({ narrow: true }).bond, null);
  assert.equal(v({ narrow: true }).narrow, true, 'what judgeVector says of the vector, before settle');
  assert.equal(v({ state: 'Expired', narrow: false }).bond, null, 'an expiry is not settle');
});

test('a listing\'s floor and size: the band and the confirmation, in words and figures', () => {
  assert.deepEqual(safeguardTerms({ narrowInvalidFloor: 500001n, confirmAboveWei: 0n }), { band: { empty: true, floor: 500001n, points: null }, size: { all: true, wei: 0n } });
  assert.deepEqual(safeguardTerms({ narrowInvalidFloor: 250000n, confirmAboveWei: 10n ** 17n }), { band: { empty: false, floor: 250000n, points: '25' }, size: { all: false, wei: 10n ** 17n } });
  assert.equal(safeguardTerms({ narrowInvalidFloor: 355000n, confirmAboveWei: 0n }).band.points, '35.5');
});

test('the record: appeals, confirmations and narrow INVALIDs by result, each listing\'s floor and size, a finding\'s round kind', () => {
  const zero6 = ['0', '0', '0', '0', '0', '0'];
  const history = {
    claims: '6', pending: '0', outcomes: ['3', '0', '0', '1', '1', '0'], released: '0', undisclosed: '0', unrevealed: '0', noVerdict: '0',
    disputes: '0', disputesHeld: '0', disputesOverturned: '0', disputesNoVerdict: '0', lateClaims: '1', lateOutcomes: ['1', '0', '0', '0', '0', '0'], lateExpired: '0',
    narrowInvalid: '2', confirmationRounds: '3', confirmationsHeld: '1', confirmationsOverturned: '1', confirmationsNoVerdict: '0', lateNarrowInvalid: '1',
    appeals: '2', appealsHeld: '1', appealsOverturned: '0', appealsNoVerdict: '1', lateAppeals: '1', lateAppealsHeld: '1', lateAppealsOverturned: '0', lateAppealsNoVerdict: '0',
  };
  const listing = {
    listingId: '3', maker: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', state: 'Open', lapsed: false, invited: false, artifactChainId: '0',
    artifactAddress: '0x0000000000000000000000000000000000000000', listedAt: '1', openedAt: '2', fundedUntil: '3', rolledAt: '0', closedAt: '0',
    awards: ['0', '1', '2', '3'], lowestClassCounted: 'MEDIUM', bondWei: '1', escrowWei: '3', owedWei: '0', valueAtRiskUsd: '0',
    predecessor: '0', predecessorHash: `0x${'0'.repeat(64)}`, successor: '0', successorHash: `0x${'0'.repeat(64)}`, history, narrowInvalidFloor: '250000', confirmAboveWei: '0',
  };
  const finding = { claimId: '9', listingId: '3', hunter: listing.maker, outcome: 'HIGH', late: false, dispute: 'Held', paidWei: '2', owedWei: '0', revealedAt: '5', settledAt: '6', bcid: 'bafkreiexample', disputeKind: 'Confirmation' };
  const r = recordView({
    artifactHash: `0x${'a'.repeat(64)}`, artifact: null, block: { number: 1, hash: `0x${'b'.repeat(64)}`, timestamp: 10 }, fresh: true, staleReason: null,
    record: { artifactHash: `0x${'a'.repeat(64)}`, kind: 'Repo', listingCount: '1', active: ['3'], listings: [listing], history, findingCount: '1', findings: [finding], flagCount: '0', flags: [] },
    labels: { listings: { 3: { stake: 'staked' } }, placeholders: [] },
    history: { events: [], publishedClaims: ['9'], lastValidFindingAt: 6, daysSinceLastValidFinding: 0 },
  });
  assert.deepEqual(r.history.appeals, { filed: '2', held: '1', overturned: '0', noVerdict: '1' });
  assert.deepEqual(r.history.confirmations, { rounds: '3', held: '1', overturned: '1', noVerdict: '0' });
  assert.equal(r.history.narrowInvalid, '2');
  assert.deepEqual(r.later.appeals, { filed: '1', held: '1', overturned: '0', noVerdict: '0' });
  assert.equal(r.later.narrowInvalid, '1');
  assert.equal(r.listings[0].narrowInvalidFloor, '250000');
  assert.equal(r.listings[0].confirmAboveWei, '0');
  assert.equal(r.findings[0].disputeKind, 'Confirmation');
  assert.deepEqual(zero6.length, 6);
  // a record from before the safeguards (no such fields): zeros, not a failure
  const old = recordView({
    artifactHash: `0x${'a'.repeat(64)}`, artifact: null, block: { number: 1, hash: `0x${'b'.repeat(64)}`, timestamp: 10 }, fresh: true, staleReason: null,
    record: { artifactHash: `0x${'a'.repeat(64)}`, kind: 'Repo', listingCount: '0', active: [], listings: [], history: { ...history, appeals: undefined, narrowInvalid: undefined, confirmationRounds: undefined }, findingCount: '0', findings: [], flagCount: '0', flags: [] },
    labels: { listings: {}, placeholders: [] },
    history: { events: [], publishedClaims: [], lastValidFindingAt: null, daysSinceLastValidFinding: null },
  });
  assert.equal(old.history.appeals.filed, '0');
  assert.equal(old.history.narrowInvalid, '0');
});

test('the strings the safeguards add: neutral, and each names what the contract does', () => {
  const C = STRINGS.claim;
  for (const key of ['roundKind', 'appealUntil', 'appealOver', 'appealRetrigger', 'waiver', 'confirmation', 'bond', 'narrow']) assert.equal(typeof C[key], 'string', key);
  for (const k of ['None', 'Maker', 'Confirmation', 'Appeal']) assert.equal(typeof STRINGS.enums.disputeKinds[k], 'string', k);
  for (const k of ['awaiting', 'open', 'pending', 'held', 'overturned', 'closed', 'noVerdict']) assert.equal(typeof C.confirmationStates[k], 'string', k);
  for (const k of ['returned', 'returnedNarrow', 'forfeited']) assert.equal(typeof C.bonds[k], 'string', k);
  assert.match(C.waiver, /waive/);
  assert.match(fill(C.appealUntil, { time: 'T' }), /T/);
  for (const key of ['bandEmpty', 'band', 'sizeAll', 'size']) assert.equal(typeof STRINGS.chain[key], 'string', key);
  for (const key of ['appeals', 'appealResults', 'confirmations', 'confirmationResults', 'narrowInvalid', 'lateAppeals', 'lateNarrowInvalid', 'narrowFloor', 'confirmSize']) assert.equal(typeof STRINGS.record[key], 'string', key);
  const all = [C.roundKind, C.appealUntil, C.appealOver, C.appealRetrigger, C.waiver, C.confirmation, C.bond, C.narrow, ...Object.values(C.confirmationStates), ...Object.values(C.bonds), STRINGS.chain.band, STRINGS.chain.bandEmpty, STRINGS.chain.size, STRINGS.chain.sizeAll];
  for (const s of all) assert.deepEqual(wordingProblems(s), [], s);
});
