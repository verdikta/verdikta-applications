// Node P38: what a maker does before publishing a fix. A fix in the public repository is read by everyone, and a
// listing takes commits until it is closed or rolled forward. A close can come before the push; a roll cannot, since
// its successor is listed first and a version is validated from its public repository. So the roll-forward panel and
// the README state an order: keep the fix private until the listing is closed, when it can be closed; with no claim
// pending, close first; with one pending, a roll before the claims are settled has the fix public first, so push,
// validate, list, fund and roll forward in one sitting. Each sentence is checked here against the contract's source
// (close(), rollForward() and acceptsCommits()), and nothing on the panel may say that a roll makes a public push
// harmless.
//
// Node P42: the maker's hold (StakeAttestation.hold, node P39) closes that gap where the contract has it. Against such
// a contract the panel states the hold's order instead (STRINGS.roll.hold): hold, push the fix, validate it, list and
// fund the fixed version, roll forward, or close when nothing is pending; and the three lines above do not show.
// Against a contract deployed before the hold, which has no hold() and whose heldAt call is refused, the panel says
// what it said, character for character: the three lines stay in strings.js, pinned here as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { wordingProblems } from '../e2e/support/wording.js';
import { STRINGS } from '../src/strings.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const R = STRINGS.roll;
const LINES = ['keep', 'noClaim', 'claimPending'];
const lines = () => LINES.map((k) => [`STRINGS.roll.fix.${k}`, R.fix?.[k]]);
const rollStrings = () => Object.entries(R).flatMap(([k, v]) => (typeof v === 'string' ? [[`STRINGS.roll.${k}`, v]] : Object.entries(v).map(([k2, v2]) => [`STRINGS.roll.${k}.${k2}`, v2])));
// No network, faucet, host or account: the lines are true on any deployment.
const NAMED = Object.freeze([/sepolia/i, /mainnet/i, /testnet/i, /\bbase\b/i, /faucet/i, /https?:/i, /\b0x[0-9a-f]{4,}/i, /github/i, /\.(org|com|io)\b/i, /@/]);

/** The words of `text` in `order` come in that order, each after the one before. */
function inOrder(text, order) {
  let from = 0;
  for (const word of order) {
    const at = text.indexOf(word, from);
    assert.notEqual(at, -1, `"${word}" after position ${from} of: ${text}`);
    from = at + word.length;
  }
}
/** A function's body in the contract's source: from its signature to its closing brace. */
function solidity(name) {
  const source = read('../../onchain/contracts/StakeAttestation.sol');
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf('\n    }\n', start));
}

test('the roll-forward panel has the three lines, each one line of page text', () => {
  assert.deepEqual(Object.keys(R.fix ?? {}), LINES);
  for (const [at, text] of lines()) {
    assert.equal(typeof text, 'string', at);
    assert.ok(text.length > 0, at);
    assert.doesNotMatch(text, /[\n\r\t]/, at);
    assert.equal(text, text.trim(), at);
    assert.doesNotMatch(text, / {2}/, at);
    assert.doesNotMatch(text, /[{}]/, `${at} takes no value`);
  }
});

test('line 1: keep a fix private until the listing is closed, when it can be closed, and why a roll cannot come first', () => {
  const text = R.fix.keep;
  // a rule a maker can keep: it is conditional on a close being possible, and line 3 covers the listing that cannot close
  assert.match(text, /^Keep a fix private until this listing is closed, when it can be closed: the stake has then left this commit before anyone reads the fix\./);
  // why a roll is no way to keep it: a version is validated from its public repository, so the fix is public before it can be listed
  assert.match(text, /A roll forward cannot come before the push: /);
  assert.match(text, /public repository/);
  assert.match(text, /public before it can be listed/);
  assert.match(text, /A hunter who reads the fix can claim the bug here for as long as this listing takes claims\.$/);
  // never the unconditional rule, which a maker with a claim pending could not follow
  assert.doesNotMatch(text, /until the stake has left this commit[.,]/);
  assert.doesNotMatch(text, /by a close or a roll forward/);
});

test('line 2: with no claim pending, close first; once it is closed, push the fix and list the fixed commit', () => {
  const text = R.fix.noClaim;
  assert.match(text, /^If no claim /);
  assert.match(text, /\bpending\b/);
  inOrder(text, ['close it first', 'Once it is closed', 'push the fix', 'list the fixed commit']);
  // close() as the contract has it: refused while a claim is pending or an award is owed
  const close = solidity('close');
  assert.match(close, /require\(l\.pendingClaims == 0, "claims pending"\);/);
  assert.match(close, /require\(l\.owedWei == 0, "amount owed"\);/);
  assert.match(text, /A close is refused while an award is owed/, 'the other thing close() refuses');
});

test('line 3: with a claim pending, a roll before the claims are settled has the fix public first, in one sitting, the listing taking claims until it has rolled', () => {
  const text = R.fix.claimPending;
  assert.match(text, /^If a claim is pending, this listing cannot be closed until every pending claim is settled or expired\./);
  // the exception to line 1, said as one: the push comes before the roll
  assert.match(text, /To roll forward before then, the fix has to be public first: push it/);
  inOrder(text, ['public first', 'push', 'validate', 'list', 'fund', 'roll forward', 'in one sitting']);
  // how long the listing is exposed: from the push until the roll is on-chain
  assert.match(text, /From the push until this listing has rolled forward, it takes claims as before\.$/);
  // rollForward() as the contract has it: the successor is the same maker's own listing, already Open
  const roll = solidity('rollForward');
  assert.match(roll, /s\.maker == msg\.sender && s\.state == ListingState\.Open/);
  // and a commit is taken on an Open listing until then: the roll is what sets it Rolled
  assert.match(roll, /l\.state = ListingState\.Rolled;/);
  // (since the maker's hold, node P39, acceptsCommits has a fourth condition: the maker has not held the listing)
  assert.match(solidity('acceptsCommits'), /return l\.state == ListingState\.Open\s*&& block\.timestamp < l\.fundedUntil\s*&& l\.escrowWei >= l\.awards\[3\]\s*&& _heldAt\[listingId\] == 0;/);
});

test('the panel renders the three lines once each, after its intro and before the successor picker', () => {
  const panel = read('../src/components/ListingExtras.jsx');
  for (const k of LINES) assert.equal(panel.split(`RF.fix.${k}`).length, 2, `RF.fix.${k}, once`);
  inOrder(panel, ['<p>{RF.intro}</p>', 'RF.fix.keep', 'RF.fix.noClaim', 'RF.fix.claimPending', '{body}']);
  // node P42: they are what a maker does against a contract with no hold, and they show there and nowhere else
  const body = panel.slice(panel.indexOf('export function RollForward('), panel.indexOf('/** Whether the site offers a commit'));
  assert.match(body, /\{hold\.supported \? \(\s*<>[\s\S]*?<\/>\s*\) : \(\s*<>\s*<p className="warning" data-testid="roll-fix-keep">\{RF\.fix\.keep\}<\/p>\s*<ul data-testid="roll-fix-order">\s*<li>\{RF\.fix\.noClaim\}<\/li>\s*<li>\{RF\.fix\.claimPending\}<\/li>\s*<\/ul>\s*<\/>\s*\)\}\s*\{body\}/);
  const withHold = /\{hold\.supported \? \(\s*<>([\s\S]*?)<\/>\s*\) : \(/.exec(body)[1];
  assert.doesNotMatch(withHold, /RF\.fix\./, 'none of the three lines against a contract with the hold');
  // the intro keeps the commit-order rule it carries (test/commitOrder.test.js pins it too)
  assert.match(R.intro, /the fix window of every claim disclosed on it ends at once \(each can then be revealed in commit order\)/);
});

test('the panel shows from the listing\'s state on-chain: a record that is still read, or cannot be, only leaves the picker out', () => {
  const panel = read('../src/components/ListingExtras.jsx');
  // the listing's page renders the panel whatever the record's read came to
  assert.match(panel, /\n      <RollForward listingId=\{listingId\} listing=\{listing\} record=\{data\} hold=\{hold\} \/>\n/);
  assert.doesNotMatch(panel, /&& <RollForward /);
  assert.equal(panel.split('<RollForward ').length, 2, 'rendered in one place');
  // inside, only the state decides whether there is a panel, and the record only what the picker's place holds
  const body = panel.slice(panel.indexOf('export function RollForward('), panel.indexOf('/** Whether the site offers a commit'));
  assert.match(body, /const identity = record && !record\.failed \? record\.identity : null;/);
  assert.match(body, /if \(!ROLLABLE\.has\(state\)\) return null;/);
  assert.match(body, /if \(!record\) body = <p className="hint">\{RF\.loading\}<\/p>;\s*else if \(record\.failed\) body = <p className="hint" data-testid="roll-record-failed">\{fill\(RF\.recordFailed, \{ reason: record\.failed \}\)\}<\/p>;/);
  assert.match(R.recordFailed, /^This listing's record could not be read, so its successors cannot be found here: \{reason\}$/);
});

// ---------------------------------------------------------------- node P42: the order with a hold
const HOLD_LINES = ['first', 'order', 'held', 'close'];
const holdLines = () => HOLD_LINES.map((k) => [`STRINGS.roll.hold.${k}`, R.hold?.[k]]);
const logic = () => read('../../onchain/contracts/libraries/ClaimLogic.sol');

test('with a hold the panel has four lines of its own, each one line of page text', () => {
  assert.deepEqual(Object.keys(R.hold ?? {}), HOLD_LINES);
  for (const [at, text] of holdLines()) {
    assert.equal(typeof text, 'string', at);
    assert.ok(text.length > 0, at);
    assert.doesNotMatch(text, /[\n\r\t]/, at);
    assert.equal(text, text.trim(), at);
    assert.doesNotMatch(text, / {2}/, at);
    for (const re of NAMED) assert.equal(re.test(text), false, `${at} names ${re}: ${text}`);
  }
  // only the line of a listing already on hold takes a value: since when
  for (const k of ['first', 'order', 'close']) assert.doesNotMatch(R.hold[k], /[{}]/, `${k} takes no value`);
  assert.deepEqual(R.hold.held.match(/\{\w+\}/g), ['{time}']);
});

test('hold line 1: hold before the push, and why the fix is public before a roll; a hold stops new commits at once', () => {
  const text = R.hold.first;
  assert.match(text, /^Hold this listing before you push a fix\./);
  // why a roll alone does not do: a version is validated from its public repository, so the fix is public first
  assert.match(text, /public repository/);
  assert.match(text, /public before it can be listed/);
  assert.match(text, /a hunter who reads the fix can claim the bug here for as long as this listing takes commits\./);
  assert.match(text, /A hold stops new commits at once\.$/);
  // hold() as the contract has it: the maker's, on an Open or a Depleted listing, once; and acceptsCommits' fourth
  // condition is that the listing is not held
  const hold = /\n {4}function hold\([\s\S]*?\n {4}\}/.exec(logic())[0];
  assert.match(hold, /require\(msg\.sender == l\.maker, "not maker"\);/);
  assert.match(hold, /require\(s == StakeAttestation\.ListingState\.Open \|\| s == StakeAttestation\.ListingState\.Depleted, "not rollable"\);/);
  assert.match(hold, /heldAt\[listingId\] = uint64\(block\.timestamp\);/);
  assert.match(solidity('acceptsCommits'), /&& _heldAt\[listingId\] == 0;/);
  assert.match(solidity('commit'), /require\(acceptsCommits\(listingId\), "not accepting commits"\);/);
});

test('hold line 2: the order. Hold; once it is mined, push; validate, list and fund the fixed commit; roll forward', () => {
  const text = R.hold.order;
  inOrder(text, ['hold this listing', 'once the hold is mined', 'push the fix', 'validate the fixed commit', 'list it', 'fund it', 'roll forward']);
  // a listing on hold rolls forward as any other: rollForward asks for an Open or a Depleted listing, which it still
  // is, and a successor that is the same maker's own listing, already Open
  const roll = solidity('rollForward');
  assert.match(roll, /require\(l\.state == ListingState\.Open \|\| l\.state == ListingState\.Depleted, "not rollable"\);/);
  assert.match(roll, /s\.maker == msg\.sender && s\.state == ListingState\.Open/);
  assert.doesNotMatch(roll.replace(/\/\/.*$/gm, ''), /_heldAt/, 'rollForward reads no hold');
  // and hold leaves the state as it is
  const hold = /\n {4}function hold\([\s\S]*?\n {4}\}/.exec(logic())[0];
  assert.doesNotMatch(hold.replace(/\/\/.*$/gm, ''), /l\.state = /);
});

test('hold line 3: a listing already on hold says since when, and what is left of the order', () => {
  const text = R.hold.held;
  assert.match(text, /^This listing is on hold since \{time\} and takes no new commits\./);
  inOrder(text, ['What is left of the order', 'push the fix', 'validate the fixed commit', 'list it', 'fund it', 'roll forward']);
  assert.doesNotMatch(text, /hold this listing/i, 'the step that is done is not asked again');
  // the same steps as the order's, after its first
  assert.ok(R.hold.order.endsWith(text.slice(text.indexOf('push the fix'))), 'the rest of the order, word for word');
});

test('hold line 4: or close, once on hold, when no claim is pending and no award is owed', () => {
  const text = R.hold.close;
  assert.match(text, /^If no claim on this listing is pending and no award is owed, you can close it /);
  assert.match(text, /instead of rolling forward\./);
  assert.match(text, /A close is refused while a claim is pending or an award is owed/);
  // close() as the contract has it, on hold or not: it reads no hold
  const close = solidity('close');
  assert.match(close, /require\(l\.pendingClaims == 0, "claims pending"\);/);
  assert.match(close, /require\(l\.owedWei == 0, "amount owed"\);/);
  assert.doesNotMatch(close.replace(/\/\/.*$/gm, ''), /_heldAt/);
});

test('with a hold the panel renders its own lines after the intro and before the picker: the first two until the hold, then the line of a listing on hold', () => {
  const panel = read('../src/components/ListingExtras.jsx');
  const body = panel.slice(panel.indexOf('export function RollForward('), panel.indexOf('/** Whether the site offers a commit'));
  const withHold = /\{hold\.supported \? \(\s*<>([\s\S]*?)<\/>\s*\) : \(/.exec(body)[1];
  assert.match(withHold, /<p className="warning" data-testid="roll-hold-first">\{hold\.held \? fill\(RF\.hold\.held, \{ time: formatTime\(hold\.heldAt\) \}\) : RF\.hold\.first\}<\/p>/);
  assert.match(withHold, /<ul data-testid="roll-hold-order">\s*\{!hold\.held && <li>\{RF\.hold\.order\}<\/li>\}\s*<li>\{RF\.hold\.close\}<\/li>\s*<\/ul>/);
  for (const k of HOLD_LINES) assert.equal(body.split(`RF.hold.${k}`).length, 2, `RF.hold.${k}, once`);
  inOrder(body, ['<p>{RF.intro}</p>', 'RF.hold.held', 'RF.hold.first', 'RF.hold.order', 'RF.hold.close', 'RF.fix.keep', '{body}']);
});

// What would tell a maker that a roll makes a public push harmless, or that the order does not matter.
const REASSURING = Object.freeze([
  /\bsafe/i, /\bsecure/i, /\bharmless\b/i, /\bprotect/i, /\bno risk\b/i, /\bwithout risk\b/i, /\brisk[- ]free\b/i, /\bnothing to (lose|fear)\b/i,
  /\bat any time\b/i, /\bwhenever\b/i, /\bin any order\b/i, /\bcannot be claimed\b/i, /\bno (one|hunter) can claim\b/i, /\bno longer be claimed\b/i,
]);

test('nothing on the roll-forward panel calls a roll safe after a public push', () => {
  const all = rollStrings();
  assert.ok(all.length >= 15, all.map(([k]) => k).join());
  for (const [at, text] of all) {
    assert.deepEqual(wordingProblems(text), [], at);
    for (const re of REASSURING) assert.equal(re.test(text), false, `${at} says ${re}: ${text}`);
  }
  // a push is named only by the lines that say when: after a close, or with the listing taking claims until it has
  // rolled; and, with a hold (node P42), after the hold
  const pushes = all.filter(([, text]) => /\bpush/i.test(text)).map(([at]) => at).sort();
  assert.deepEqual(pushes, ['STRINGS.roll.fix.claimPending', 'STRINGS.roll.fix.keep', 'STRINGS.roll.fix.noClaim', 'STRINGS.roll.hold.first', 'STRINGS.roll.hold.held', 'STRINGS.roll.hold.order', 'STRINGS.roll.none']);
  assert.match(R.none, /read the order above before you push it/);
});

test('the guard catches what it names', () => {
  const samples = [
    'A roll is safe once the fix is pushed.',
    'Push the fix, then roll forward at any time.',
    'Once rolled, the bug cannot be claimed.',
    'Rolling forward protects the stake.',
    'Push and roll in any order.',
    'There is no risk in pushing first.',
  ];
  for (const s of samples) assert.ok(REASSURING.some((re) => re.test(s)), s);
});

test('the three lines, and the hold\'s four, name no network, faucet, host or account', () => {
  for (const [at, text] of [...lines(), ...holdLines()]) {
    assert.equal(typeof text, 'string', at);
    for (const re of NAMED) assert.equal(re.test(text), false, `${at} names ${re}: ${text}`);
  }
});

test('the README says the hold, and why: the builder fetches the fixed commit from the public repository', () => {
  const readme = read('../../README.md');
  const section = readme.slice(readme.indexOf('\n## The contract: listings\n'), readme.indexOf('\n## The contract: claims\n')).replace(/\s+/g, ' ');
  // node P42: the README describes the contract in this repository, which has the hold. The bullet that said a fix
  // stays private until the old listing is closed now says the hold, and what a maker does without one is its last
  // sentence
  const start = section.indexOf('- **A maker holds a listing before publishing a fix**');
  assert.notEqual(start, -1, 'the bullet, in "The contract: listings"');
  assert.equal(section.indexOf('- **A fix stays private until the old listing is closed'), -1, 'replaced, not kept beside it');
  // the section's last bullet: it runs to the section's end
  const bullet = section.slice(start);
  // why: a roll cannot come before the push
  assert.match(bullet, /A roll cannot come before the push: `rollForward` needs a successor that is the same maker's own listing, already Open/);
  assert.match(bullet, /the builder fetches a listed commit from the public repository, with no credentials, so the fix is public before the roll/);
  // acceptsCommits as the contract has it: the escrow is a lower bound, and the fourth condition is the maker's hold
  assert.match(bullet, /for as long as that listing takes commits \(`acceptsCommits`: Open, its paid period not over, its escrow at least the top award, and not held by its maker with `hold`\)/);

  // who can call it and when: ClaimLogic.hold's three refusals
  assert.match(bullet, /who and when: the listing's maker, once, on an Open or a Depleted listing \(`hold` is refused with "not maker", "not rollable" or "already held"\)/);
  const hold = /\n {4}function hold\([\s\S]*?\n {4}\}/.exec(logic())[0];
  for (const refusal of ['"not maker"', '"not rollable"', '"already held"']) assert.ok(hold.includes(refusal), refusal);
  assert.match(bullet, /neither a pending claim nor an owed award holds it back/);
  assert.doesNotMatch(hold.replace(/\/\/.*$/gm, ''), /pendingClaims|owedWei|msg\.value/);
  // what it stops: commits, from its own block; and it opens late claims
  assert.match(bullet, /what it stops: from the hold's block the listing takes no commit \(`acceptsCommits` is false\)\. It takes late claims from then on, as a Rolled listing does \(`lateClaim`\): judged, recorded under the record's `later`, with no award/);
  assert.match(solidity('lateClaim'), /_heldAt\[listingId\] != 0/);
  // what it leaves alone
  assert.match(bullet, /what it leaves alone: everything else\. The state stays Open or Depleted \(`heldAt\(listingId\)` says since when, and `Held` is in the log\)/);
  assert.match(bullet, /Every claim committed before the hold keeps its fix window, its place in commit order, its rounds, its dispute or appeal, and its award from the escrow/);
  assert.match(bullet, /Neither a top-up that brings a Depleted listing back to Open nor a renewal makes a held listing take commits again/);
  // no resume, and what ends it
  assert.match(bullet, /no resume: a hold ends in `rollForward` or in `close`, whose conditions are what they were, and `heldAt` answers 0 from then on/);
  assert.match(solidity('heldAt'), /return s == ListingState\.Open \|\| s == ListingState\.Depleted \? _heldAt\[listingId\] : 0;/);
  // the order, and the close in its place
  inOrder(bullet, ['the order', '`hold`', 'once that is mined', 'push the fix', 'validate, list and fund the fixed commit', '`rollForward`']);
  // what a roll does to the claims already there, in the contract's terms
  assert.match(bullet, /those claims still settle against the old listing's escrow/);
  assert.match(bullet, /With no claim pending and no award owed, a maker can `close` the held listing instead/);
  assert.match(bullet, /`close` is refused while a claim is pending or an award is owed/);
  assert.doesNotMatch(bullet, /the stake leaves only by a roll/);
  assert.doesNotMatch(bullet, /expect the old listing to take commits/);

  // one sentence for a deployment that has no hold: what the bullet said before the hold
  const without = bullet.slice(bullet.indexOf('Against a deployment that has no hold'));
  assert.ok(without.startsWith('Against a deployment that has no hold'), 'the sentence');
  assert.equal(without.trim().split(/\.(?:\s|$)/).filter(Boolean).length, 1, `one sentence: ${without}`);
  assert.match(without, /a contract from before it has neither `hold` nor `heldAt`, and a reader takes the refused call as not held/);
  assert.match(without, /a maker keeps the fix private until the old listing is closed, when it can be closed/);
  inOrder(without, ['with no claim pending', '`close` the old listing first', 'once that is mined', 'push the fix', 'list the fixed commit']);
  inOrder(without, ['with a claim pending', '`close` is refused until every pending claim is settled or expired', 'publishes first', 'push', 'validate', 'list', 'fund', 'roll forward', 'in one sitting']);
  // the exposure there, as the contract decides it: commits are taken only while acceptsCommits' conditions are met
  assert.match(without, /the old listing taking commits as before until the roll is mined, for as long as it meets the conditions of `acceptsCommits`\.$/);
  for (const re of [...REASSURING, ...NAMED]) assert.equal(re.test(bullet), false, `the README's bullet says ${re}`);
  assert.deepEqual(wordingProblems(bullet), []);

  // the panel's own description in "The client" points at it, says the panel does not wait for the record, and says
  // what the page does against a contract with no hold
  const client = readme.slice(readme.indexOf('\n## The client\n'), readme.indexOf('\n## The local round\n')).replace(/\s+/g, ' ');
  assert.match(client, /what a maker does before publishing a fix \(`STRINGS\.roll\.hold`; "The contract: listings"\)/);
  assert.match(client, /the panel shows for every Open or Depleted listing, also while the site's record is read and when it cannot be: only the picker waits for the record/);
  assert.match(client, /A call the contract refuses means a contract from before the hold: the page then draws no hold section, and the roll-forward panel says what it said before the hold existed, character for character \(`STRINGS\.roll\.fix`/);
  assert.match(client, /the listing taking claims as before until it has rolled \(none while it is Depleted or its paid period is over\)/);
  assert.match(client, /A read that fails any other way is a failed read of the page, never "not on hold"/);
});
