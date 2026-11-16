// When the claim page offers the maker's actions (design §13.2; the contract's rules in
// ClaimLogic): release inside the fix window of a disclosed claim, dispute of a valid verdict
// inside the dispute window (the lens's disputeDeadline), and which rounds are pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { disputeOffer, pendingRound, releaseOffer, roundOver } from '../src/lib/claimActions.js';

const NOW = 1_800_000_000n;

test('release: a disclosed claim still in its fix window', () => {
  assert.deepEqual(releaseOffer({ disclosedAt: NOW - 10n, state: 'Committed', revealableAt: NOW + 100n, now: NOW }), { offer: true, why: null, until: NOW + 100n });
});

test('release: not before the disclosure, not once the window ended or the claim moved on', () => {
  assert.equal(releaseOffer({ disclosedAt: 0n, state: 'Committed', revealableAt: 0n, now: NOW }).why, 'notDisclosed');
  assert.equal(releaseOffer({ disclosedAt: NOW - 10n, state: 'Committed', revealableAt: NOW, now: NOW }).why, 'windowOver');
  assert.equal(releaseOffer({ disclosedAt: NOW - 10n, state: 'Revealable', revealableAt: NOW - 1n, now: NOW }).why, 'windowOver');
  for (const state of ['Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed']) {
    const r = releaseOffer({ disclosedAt: NOW - 10n, state, revealableAt: NOW + 100n, now: NOW });
    assert.equal(r.offer, false, state);
    assert.equal(r.why, 'windowOver', state);
  }
});

test('dispute: a judged valid outcome, undisputed, before the deadline', () => {
  const claim = { state: 'Judged', outcome: 'MEDIUM', dispute: 'None' };
  assert.deepEqual(disputeOffer({ ...claim, deadline: NOW + 3600n, now: NOW }), { offer: true, why: null, until: NOW + 3600n });
});

test('dispute: why it is not offered', () => {
  assert.equal(disputeOffer({ state: 'Revealed', outcome: 'INVALID', dispute: 'None', deadline: 0n, now: NOW }).why, 'notJudged');
  assert.equal(disputeOffer({ state: 'Judged', outcome: 'INVALID', dispute: 'None', deadline: 0n, now: NOW }).why, 'notValid');
  assert.equal(disputeOffer({ state: 'Judged', outcome: 'DUPLICATE', dispute: 'None', deadline: 0n, now: NOW }).why, 'notValid');
  assert.equal(disputeOffer({ state: 'Disputed', outcome: 'HIGH', dispute: 'Pending', deadline: 0n, now: NOW }).why, 'disputed');
  assert.equal(disputeOffer({ state: 'Judged', outcome: 'HIGH', dispute: 'Held', deadline: 0n, now: NOW }).why, 'disputed');
  assert.equal(disputeOffer({ state: 'Settled', outcome: 'HIGH', dispute: 'None', deadline: 0n, now: NOW }).why, 'notJudged');
  // the lens keeps answering the deadline after it passed: the chain's clock decides
  assert.equal(disputeOffer({ state: 'Judged', outcome: 'HIGH', dispute: 'None', deadline: NOW, now: NOW }).why, 'windowOver');
  assert.equal(disputeOffer({ state: 'Judged', outcome: 'HIGH', dispute: 'None', deadline: NOW - 1n, now: NOW }).offer, false);
});

test('pending: a revealed claim waits for its round, a disputed one for the dispute round', () => {
  assert.equal(pendingRound('Revealed'), 'claim');
  assert.equal(pendingRound('Disputed'), 'dispute');
  for (const s of ['Committed', 'Revealable', 'Judged', 'Settled', 'Expired', 'RoundFailed']) assert.equal(pendingRound(s), null, s);
});

test('roundOver: a claim round ends when the claim leaves Revealed; a dispute round only once the dispute is recorded and over', () => {
  assert.equal(roundOver('claim', { state: 'Revealed', dispute: 'None' }), false);
  for (const s of ['Judged', 'RoundFailed', 'Settled']) assert.equal(roundOver('claim', { state: s, dispute: 'None' }), true, s);
  // a read from before the dispute was mined: still Judged and undisputed, so the watch goes on
  assert.equal(roundOver('dispute', { state: 'Judged', dispute: 'None' }), false);
  assert.equal(roundOver('dispute', { state: 'Disputed', dispute: 'Pending' }), false);
  for (const d of ['Held', 'Overturned', 'NoVerdict']) {
    assert.equal(roundOver('dispute', { state: 'Judged', dispute: d }), true, d);
    assert.equal(roundOver('dispute', { state: 'Settled', dispute: d }), true, d);
  }
});
