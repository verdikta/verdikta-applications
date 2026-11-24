// Node P38: what a maker does before publishing a fix. A fix in the public repository is read by everyone, and a
// listing takes commits until it is closed or rolled forward. A close can come before the push; a roll cannot, since
// its successor is listed first and a version is validated from its public repository. So the roll-forward panel and
// the README state an order: keep the fix private until the listing is closed, when it can be closed; with no claim
// pending, close first; with one pending, a roll before the claims are settled has the fix public first, so push,
// validate, list, fund and roll forward in one sitting. Each sentence is checked here against the contract's source
// (close(), rollForward() and acceptsCommits()), and nothing on the panel may say that a roll makes a public push
// harmless.
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
  assert.match(solidity('acceptsCommits'), /return l\.state == ListingState\.Open\s*&& block\.timestamp < l\.fundedUntil\s*&& l\.escrowWei >= l\.awards\[3\];/);
});

test('the panel renders the three lines once each, after its intro and before the successor picker', () => {
  const panel = read('../src/components/ListingExtras.jsx');
  for (const k of LINES) assert.equal(panel.split(`RF.fix.${k}`).length, 2, `RF.fix.${k}, once`);
  inOrder(panel, ['<p>{RF.intro}</p>', 'RF.fix.keep', 'RF.fix.noClaim', 'RF.fix.claimPending', '{body}']);
  // the intro keeps the commit-order rule it carries (test/commitOrder.test.js pins it too)
  assert.match(R.intro, /the fix window of every claim disclosed on it ends at once \(each can then be revealed in commit order\)/);
});

test('the panel shows from the listing\'s state on-chain: a record that is still read, or cannot be, only leaves the picker out', () => {
  const panel = read('../src/components/ListingExtras.jsx');
  // the listing's page renders the panel whatever the record's read came to
  assert.match(panel, /\n      <RollForward listingId=\{listingId\} listing=\{listing\} record=\{data\} \/>\n/);
  assert.doesNotMatch(panel, /&& <RollForward /);
  assert.equal(panel.split('<RollForward ').length, 2, 'rendered in one place');
  // inside, only the state decides whether there is a panel, and the record only what the picker's place holds
  const body = panel.slice(panel.indexOf('export function RollForward('), panel.indexOf('/** Whether the site offers a commit'));
  assert.match(body, /const identity = record && !record\.failed \? record\.identity : null;/);
  assert.match(body, /if \(!ROLLABLE\.has\(state\)\) return null;/);
  assert.match(body, /if \(!record\) body = <p className="hint">\{RF\.loading\}<\/p>;\s*else if \(record\.failed\) body = <p className="hint" data-testid="roll-record-failed">\{fill\(RF\.recordFailed, \{ reason: record\.failed \}\)\}<\/p>;/);
  assert.match(R.recordFailed, /^This listing's record could not be read, so its successors cannot be found here: \{reason\}$/);
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
  // a push is named only by the lines that say when: after a close, or with the listing taking claims until it has rolled
  const pushes = all.filter(([, text]) => /\bpush/i.test(text)).map(([at]) => at).sort();
  assert.deepEqual(pushes, ['STRINGS.roll.fix.claimPending', 'STRINGS.roll.fix.keep', 'STRINGS.roll.fix.noClaim', 'STRINGS.roll.none']);
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
  const section = readme.slice(readme.indexOf('\n## The contract: listings\n'), readme.indexOf('\n## The contract: claims\n')).replace(/\s+/g, ' ');
  const start = section.indexOf('- **A fix stays private until the old listing is closed, when it can be closed.**');
  assert.notEqual(start, -1, 'the bullet, in "The contract: listings"');
  const next = section.indexOf(' - **', start + 1);
  const bullet = section.slice(start, next === -1 ? undefined : next);
  // why: a close can come before the push and a roll cannot
  assert.match(bullet, /A `close` can come before the push; a roll cannot\./);
  assert.match(bullet, /`rollForward` needs a successor that is the same maker's own listing, already Open/);
  assert.match(bullet, /the builder fetches a listed commit from the public repository, with no credentials, so the fix is public before the roll/);
  // acceptsCommits as the contract has it: the escrow is a lower bound
  assert.match(bullet, /for as long as that listing takes commits \(`acceptsCommits`: Open, its paid period not over, its escrow at least the top award\)/);
  inOrder(bullet, ['with no claim pending', '`close` the old listing first', 'once that is mined', 'push the fix', 'list the fixed commit']);
  assert.match(bullet, /`close` is refused while a claim is pending or an award is owed/);
  inOrder(bullet, ['with a claim pending', '`close` is refused until every pending claim is settled or expired', 'publishes first', 'push', 'validate', 'list', 'fund', 'roll forward', 'in one sitting']);
  assert.match(bullet, /expect the old listing to take commits from the push until the roll is mined/);
  // what a roll does to the claims already there, in the contract's terms
  assert.match(bullet, /those claims still settle against the old listing's escrow/);
  assert.doesNotMatch(bullet, /the stake leaves only by a roll/);
  for (const re of [...REASSURING, ...NAMED]) assert.equal(re.test(bullet), false, `the README's bullet says ${re}`);
  assert.deepEqual(wordingProblems(bullet), []);
  // the panel's own description in "The client" points at it, and says the panel does not wait for the record
  const client = readme.slice(readme.indexOf('\n## The client\n'), readme.indexOf('\n## The local round\n')).replace(/\s+/g, ' ');
  assert.match(client, /what a maker does before publishing a fix \(`STRINGS\.roll\.fix`; "The contract: listings"\)/);
  assert.match(client, /the panel shows for every Open or Depleted listing, also while the site's record is read and when it cannot be: only the picker waits for the record/);
});
