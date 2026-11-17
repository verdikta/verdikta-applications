// What a maker can do with a listing once it is listed (src/lib/listingActions.js), held to the contract's
// own rules: a top-up (fund() on a listing that has opened) pays what is owed first and reopens a Depleted
// listing at its top award; renew() takes an Open or Depleted listing and runs from the later of
// fundedUntil and now; close() takes any listing that is not Closed, has no claim pending and owes nothing.
// The rules are read from StakeAttestation.sol and ClaimLogic.sol here, so a change there fails this test
// rather than a transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { LISTING_STATES } from '../src/chain/abi.js';
import { LISTING_PERIOD, closeTerms, renewTerms, topUpEffect, topUpTerms } from '../src/lib/listingActions.js';

const SOURCE = fs.readFileSync(new URL('../../onchain/contracts/StakeAttestation.sol', import.meta.url), 'utf8');
const CLAIM_LOGIC = fs.readFileSync(new URL('../../onchain/contracts/libraries/ClaimLogic.sol', import.meta.url), 'utf8');
const body = (name, source = SOURCE) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start !== -1, name);
  return source.slice(start, source.indexOf('\n    }', start));
};
const TOP = 2n * 10n ** 18n;
const listing = (state, o = {}) => ({ state: BigInt(LISTING_STATES.indexOf(state)), fundedUntil: 0n, pendingClaims: 0n, owedWei: 0n, escrowWei: 0n, awards: [0n, 1n, 2n, TOP], ...o });
const NOW = 1_800_000_000;

test('the paid period is the contract\'s LISTING_PERIOD', () => {
  assert.match(SOURCE, /uint256 public constant LISTING_PERIOD = 30 days;/);
  assert.equal(LISTING_PERIOD, 30 * 86400);
});

test('renew: Open and Depleted listings only, as renew() requires', () => {
  assert.match(body('renew'), /require\(l\.state == ListingState\.Open \|\| l\.state == ListingState\.Depleted, "not renewable"\)/);
  for (const s of LISTING_STATES) {
    assert.equal(renewTerms(listing(s, { fundedUntil: BigInt(NOW + 10) }), NOW).can, s === 'Open' || s === 'Depleted', s);
  }
});

test('renew: 30 days are added to a period that is still paid, and run from now once it has lapsed', () => {
  assert.match(body('renew'), /uint256 from = l\.fundedUntil > block\.timestamp \? l\.fundedUntil : block\.timestamp;/);
  assert.match(body('isLapsed'), /until != 0 && block\.timestamp >= until/);
  const paid = renewTerms(listing('Open', { fundedUntil: BigInt(NOW + 5 * 86400) }), NOW);
  assert.deepEqual(paid, { can: true, lapsed: false, fundedUntil: NOW + 5 * 86400, until: NOW + 35 * 86400 });
  // the second the period ends it has lapsed, and the gap since is not bought
  const atEnd = renewTerms(listing('Open', { fundedUntil: BigInt(NOW) }), NOW);
  assert.equal(atEnd.lapsed, true);
  assert.equal(atEnd.until, NOW + 30 * 86400);
  const late = renewTerms(listing('Depleted', { fundedUntil: BigInt(NOW - 9 * 86400) }), NOW);
  assert.deepEqual(late, { can: true, lapsed: true, fundedUntil: NOW - 9 * 86400, until: NOW + 30 * 86400 });
  // a listing that cannot be renewed is never called lapsed here: its page says its state
  assert.equal(renewTerms(listing('Closed', { fundedUntil: BigInt(NOW - 1) }), NOW).lapsed, false);
});

test('close: not Closed, no claim pending, nothing owed, as close() requires, in that order', () => {
  const src = body('close');
  for (const line of ['require(l.state != ListingState.Closed, "already closed")', 'require(l.pendingClaims == 0, "claims pending")', 'require(l.owedWei == 0, "amount owed")']) {
    assert.ok(src.includes(line), line);
  }
  for (const s of LISTING_STATES) {
    const t = closeTerms(listing(s, { escrowWei: 7n }));
    assert.equal(t.can, s !== 'Closed', s);
    assert.equal(t.why, s === 'Closed' ? 'closed' : null, s);
    assert.equal(t.escrowWei, 7n);
  }
  assert.deepEqual(closeTerms(listing('Open', { pendingClaims: 2n, owedWei: 5n, escrowWei: 9n })), { can: false, why: 'pending', pending: 2n, owedWei: 5n, escrowWei: 9n });
  assert.deepEqual(closeTerms(listing('Depleted', { owedWei: 5n })), { can: false, why: 'owed', pending: 0n, owedWei: 5n, escrowWei: 0n });
  // a Listed listing that was never funded closes too: it is how a maker gives one up and lists the version again
  assert.equal(closeTerms(listing('Listed')).can, true);
});

test('what closes pays back is the listing\'s escrow, to its maker, and a wallet it cannot pay is credited', () => {
  const src = body('close');
  assert.ok(src.includes('uint256 amount = l.escrowWei;'));
  assert.ok(src.includes('_payOrCredit(maker, amount);'));
  assert.match(body('_payOrCredit'), /withdrawable\[to\] \+= amount;\s*emit PaymentDeferred\(to, amount\);/);
  assert.match(body('withdraw'), /uint256 amt = withdrawable\[msg\.sender\];/);
});

test('top-up: a listing that has opened and is not Closed, as fund() takes it, with no fee', () => {
  const src = body('fund');
  assert.ok(src.includes('require(s != ListingState.Closed, "not fundable");'));
  // Listed is the opening fund, which charges the listing fee: only then is the fee not 0
  assert.ok(src.includes('uint256 fee = s == ListingState.Listed ? listingFeeWei : 0;'));
  assert.ok(src.includes('require(expectedFeeWei == fee, "fee changed");'));
  assert.ok(src.includes('require(msg.value > 0, "no value");'));
  for (const s of LISTING_STATES) assert.equal(topUpTerms(listing(s)).can, ['Open', 'Depleted', 'Rolled'].includes(s), s);
});

test('top-up: what is owed is paid first and the rest is escrowed; a Depleted listing reopens at its top award with nothing owed', () => {
  const src = body('topUp', CLAIM_LOGIC);
  assert.ok(src.includes('rest = l.owedWei != 0 ? payOwed(claims, l, owedQ, withdrawable, listingId, amount) : amount;'));
  assert.ok(src.includes('uint256 escrow = l.escrowWei + rest;'));
  assert.ok(src.includes('if (l.state == StakeAttestation.ListingState.Depleted && escrow >= l.awards[3] && l.owedWei == 0) {'));

  const eth = (n) => BigInt(Math.round(n * 1000)) * 10n ** 15n;
  // open, nothing owed: all of it is escrow, and nothing is said about reopening
  const open = listing('Open', { escrowWei: eth(2) });
  assert.deepEqual(topUpTerms(open), { can: true, state: 'Open', escrowWei: eth(2), owedWei: 0n, topWei: TOP, toReopenWei: null });
  assert.deepEqual(topUpEffect(open, eth(0.5)), { toOwedWei: 0n, toEscrowWei: eth(0.5), escrowAfterWei: eth(2.5), reopens: false });

  // depleted with an award owed: what reopens it is the debt plus what the escrow is short of the top award
  const depleted = listing('Depleted', { escrowWei: eth(0.3), owedWei: eth(0.4) });
  assert.equal(topUpTerms(depleted).toReopenWei, eth(0.4) + eth(1.7));
  // less than the debt: all of it goes to hunters, none to the escrow
  assert.deepEqual(topUpEffect(depleted, eth(0.1)), { toOwedWei: eth(0.1), toEscrowWei: 0n, escrowAfterWei: eth(0.3), reopens: false });
  // the debt and some escrow, still short of the top award
  assert.deepEqual(topUpEffect(depleted, eth(1)), { toOwedWei: eth(0.4), toEscrowWei: eth(0.6), escrowAfterWei: eth(0.9), reopens: false });
  // one wei short of reopening, then exactly enough
  assert.equal(topUpEffect(depleted, eth(2.1) - 1n).reopens, false);
  assert.deepEqual(topUpEffect(depleted, eth(2.1)), { toOwedWei: eth(0.4), toEscrowWei: eth(1.7), escrowAfterWei: TOP, reopens: true });

  // a Rolled listing takes a top-up and never reopens
  const rolled = listing('Rolled', { escrowWei: 0n, owedWei: eth(0.4) });
  assert.equal(topUpTerms(rolled).toReopenWei, null);
  assert.equal(topUpEffect(rolled, eth(5)).reopens, false);
  assert.equal(topUpEffect(rolled, eth(5)).escrowAfterWei, eth(4.6));
});
