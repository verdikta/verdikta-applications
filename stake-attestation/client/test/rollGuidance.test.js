// Node P38: what a maker does before publishing a fix. A fix in the public repository is read by everyone, and a
// listing takes commits until it is closed or rolled forward, so the roll-forward panel and the README state an order:
// keep the fix private until the stake has left the commit; with no claim pending, close first; with one pending,
// push, validate, list, fund and roll forward in one sitting. Each sentence is checked here against the contract's source
// (close() and rollForward()), and nothing on the panel may say that a roll makes a public push harmless.
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
/** The words of `text` in `order` come in that order, each after the one before. */
function inOrder(text, order) {
  let from = 0;
  for (const word of order) {
    const at = text.indexOf(word, from);
    assert.notEqual(at, -1, `"${word}" after position ${from} of: ${text}`);
    from = at + word.length;
  }
}
/** A function's body in the contract's source: from its signature to the next one's doc comment. */
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

test('line 1: keep a fix private until the stake has left the commit, and why', () => {
  const text = R.fix.keep;
  assert.match(text, /^Keep a fix private until the stake has left this commit/);
  // the stake leaves a commit by a close or a roll, and by nothing else the maker sends
  assert.match(text, /\bclose\b/);
  assert.match(text, /\broll forward\b/);
  // why: a version is validated from its public repository, so the fix is public before it can be listed
  assert.match(text, /public repository/);
  assert.match(text, /public before it can be listed/);
  assert.match(text, /a hunter who reads the fix can claim the bug/);
});

test('line 2: with no claim pending, close first, then push the fix and list the fixed commit', () => {
  const text = R.fix.noClaim;
  assert.match(text, /^If no claim /);
  assert.match(text, /\bpending\b/);
  inOrder(text, ['close', 'first', 'push the fix', 'list the fixed commit']);
  // close() as the contract has it: refused while a claim is pending or an award is owed
  const close = solidity('close');
  assert.match(close, /require\(l\.pendingClaims == 0, "claims pending"\);/);
  assert.match(close, /require\(l\.owedWei == 0, "amount owed"\);/);
  assert.match(text, /A close is refused while an award is owed/, 'the other thing close() refuses');
});

test('line 3: with a claim pending, push, validate, list, fund and roll forward in one sitting, and the listing takes claims until the roll', () => {
  const text = R.fix.claimPending;
  assert.match(text, /^If a claim is pending, this listing cannot be closed, so the fix is public before the roll:/);
  inOrder(text, ['push', 'validate', 'list', 'fund', 'roll forward', 'in one sitting']);
  assert.match(text, /[Uu]ntil the roll, this listing takes claims/);
  // rollForward() as the contract has it: the successor is the same maker's own listing, already Open
  const roll = solidity('rollForward');
  assert.match(roll, /s\.maker == msg\.sender && s\.state == ListingState\.Open/);
  // and a commit is taken on an Open listing until then: the roll is what sets it Rolled
  assert.match(roll, /l\.state = ListingState\.Rolled;/);
  assert.match(solidity('acceptsCommits'), /return l\.state == ListingState\.Open/);
});

test('the panel renders the three lines once each, after its intro and before the successor picker', () => {
  const panel = read('../src/components/ListingExtras.jsx');
  for (const k of LINES) assert.equal(panel.split(`RF.fix.${k}`).length, 2, `RF.fix.${k}, once`);
  inOrder(panel, ['<p>{RF.intro}</p>', 'RF.fix.keep', 'RF.fix.noClaim', 'RF.fix.claimPending', '{body}']);
  // the intro keeps the commit-order rule it carries (test/commitOrder.test.js pins it too)
  assert.match(R.intro, /the fix window of every claim disclosed on it ends at once \(each can then be revealed in commit order\)/);
});

// What would tell a maker that a roll makes a public push harmless, or that the order does not matter.
const REASSURING = Object.freeze([
  /\bsafe/i, /\bsecure/i, /\bharmless\b/i, /\bprotect/i, /\bno risk\b/i, /\bwithout risk\b/i, /\brisk[- ]free\b/i, /\bnothing to (lose|fear)\b/i,
  /\bat any time\b/i, /\bwhenever\b/i, /\bin any order\b/i, /\bcannot be claimed\b/i, /\bno (one|hunter) can claim\b/i, /\bno longer be claimed\b/i,
]);

test('nothing on the roll-forward panel calls a roll safe after a public push', () => {
  const all = rollStrings();
  assert.ok(all.length >= 14, all.map(([k]) => k).join());
  for (const [at, text] of all) {
    assert.deepEqual(wordingProblems(text), [], at);
    for (const re of REASSURING) assert.equal(re.test(text), false, `${at} says ${re}: ${text}`);
  }
  // a push is named only by the lines that say when: after a close, or with the listing taking claims until the roll
  const pushes = all.filter(([, text]) => /\bpush/i.test(text)).map(([at]) => at).sort();
  assert.deepEqual(pushes, ['STRINGS.roll.fix.claimPending', 'STRINGS.roll.fix.noClaim', 'STRINGS.roll.none']);
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

// No network, faucet, host or account: the lines are true on any deployment.
const NAMED = Object.freeze([/sepolia/i, /mainnet/i, /testnet/i, /\bbase\b/i, /faucet/i, /https?:/i, /\b0x[0-9a-f]{4,}/i, /github/i, /\.(org|com|io)\b/i, /@/]);

test('the three lines name no network, faucet, host or account', () => {
  for (const [at, text] of lines()) {
    assert.equal(typeof text, 'string', at);
    for (const re of NAMED) assert.equal(re.test(text), false, `${at} names ${re}: ${text}`);
  }
});

test('the README says the same, and why: the builder fetches the fixed commit from the public repository', () => {
  const readme = read('../../README.md');
  const section = readme.slice(readme.indexOf('\n## The contract: listings\n'), readme.indexOf('\n## The contract: claims\n'));
  const start = section.indexOf('- **A fix stays private until the stake has left the old commit.**');
  assert.notEqual(start, -1, 'the bullet, in "The contract: listings"');
  const next = section.indexOf('\n- **', start + 1);
  const bullet = section.slice(start, next === -1 ? undefined : next).replace(/\s+/g, ' ');
  assert.match(bullet, /the builder fetches a listed commit from the public repository, with no credentials, so the fix is public before the roll/);
  assert.match(bullet, /`rollForward` needs a successor that is the same maker's own listing, already Open/);
  inOrder(bullet, ['with no claim pending', '`close` the old listing first', 'push the fix', 'list the fixed commit']);
  assert.match(bullet, /`close` is refused while a claim is pending or an award is owed/);
  inOrder(bullet, ['with a claim pending', 'push', 'validate', 'list', 'fund', 'roll forward', 'in one sitting']);
  assert.match(bullet, /Until the roll, the old listing takes commits as before/);
  assert.match(bullet, /expect the old listing to take commits until the roll/);
  for (const re of [...REASSURING, ...NAMED]) assert.equal(re.test(bullet), false, `the README's bullet says ${re}`);
  assert.deepEqual(wordingProblems(bullet), []);
  // the panel's own description in "The client" points at it
  const client = readme.slice(readme.indexOf('\n## The client\n'), readme.indexOf('\n## The local round\n'));
  assert.match(client.replace(/\s+/g, ' '), /what a maker does before publishing a fix \(`STRINGS\.roll\.fix`; "The contract: listings"\)/);
});
