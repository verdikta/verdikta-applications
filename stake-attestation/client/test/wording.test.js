// The record states facts only (node P6b's review focus). Every UI string, the record and feed
// pages' included, passes the shared banned-words helper and a guard against judgemental
// phrases; the guard itself is tested here so a pattern that stops matching is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORBIDDEN_WORDS, INTEGRITY_NOTE } from '@verdikta/stake-attestation-shared';

import { JUDGEMENTAL, wordingProblems } from '../e2e/support/wording.js';
import { STRINGS } from '../src/strings.js';

function leaves(value, at = 'STRINGS') {
  if (typeof value === 'string') return [[at, value]];
  return Object.entries(value).flatMap(([k, v]) => leaves(v, `${at}.${k}`));
}

test('no UI string holds a banned word or a judgemental phrase', () => {
  const problems = leaves(STRINGS).flatMap(([at, text]) => wordingProblems(text).map((p) => `${at}: ${p}`));
  assert.deepEqual(problems, []);
});

test('the guard catches each banned word, in any case and inside a longer word', () => {
  for (const word of FORBIDDEN_WORDS) {
    assert.ok(wordingProblems(`This version is ${word}.`).some((p) => p.startsWith('banned word')), word);
    assert.ok(wordingProblems(`un${word.toUpperCase()}`).length > 0, word);
  }
});

test('the guard catches the judgemental phrases it names', () => {
  const samples = [
    'This contract is safe to use.',
    'The code is secure.',
    'Audited by the arbiters.',
    'A bug-free release.',
    'Free of vulnerabilities while staked.',
    'A vetted listing.',
    'Trusted by Verdikta.',
    'Approved version.',
    'Endorsed by the network.',
    'A guaranteed payout.',
    'A risk-free stake.',
    'A certificate of review.',
    'Seal of approval.',
    'Verified safe.',
    'Gold tier.',
    'Silver stake.',
  ];
  for (const s of samples) assert.ok(wordingProblems(s).some((p) => p.startsWith('judgemental')), s);
  assert.equal(JUDGEMENTAL.length >= 15, true);
});

test('the guard leaves factual wording alone', () => {
  const facts = [
    'There are 4 ETH escrowed against this hash, 94 days unclaimed, 37 claims judged, 0 valid.',
    'No finding at or above HIGH while staked.',
    'A $1,000 stake on a contract securing $10M tells every hunter that any real finding is worth more unheld.',
    'It is not a guarantee that the code has no bugs.',
    'Serious agent audits, some humans.',
  ];
  for (const s of facts) assert.deepEqual(wordingProblems(s), [], s);
});

test('the diligence text is the design\'s: the five readings of an unclaimed stake, the labels, the badge as live state', () => {
  const d = STRINGS.diligence;
  assert.equal(d.readings.length, 5);
  assert.match(d.readings.join(' '), /no finding exists at the staked class/);
  assert.match(d.readings.join(' '), /nobody competent looked/);
  assert.match(d.readings.join(' '), /holding it/);
  assert.match(d.readings.join(' '), /wrongly rejected a real finding/);
  assert.match(d.readings.join(' '), /unclaimable/);
  assert.match(d.readingsAfter, /the cost of looking and the value of holding/);
  assert.match(d.facts, /never a security claim/);
  assert.match(d.badge, /The badge is the live state/);
  assert.match(d.amount, /The reader interprets the amount/);
  for (const label of ['scanned', 'staked', 'under-staked', 'invited']) {
    assert.ok(d.labelList.some((l) => l.startsWith(`${label}:`)), label);
  }
  assert.equal(d.table.length, 4);
  assert.match(d.feed, /escrow remaining/);
});

// Node P10 (owner decision Q35, condition 3): the count states what the checks found. It does not
// imply that the maker, or the hunter, caused a failure, and a hunter's own failed run raises it too.
const BLAMING = Object.freeze([
  /\btrap/i, /\bcheat/i, /\bfault/i, /\bblam/i, /\bmalicious/i, /\bsuspicious/i, /\battack/i, /\bgrief/i, /\bdishonest/i, /\bcaught\b/i,
  /\bbad\b/i, /\bguilty\b/i, /\bculprit\b/i, /\bsabotag/i, /\bfraud/i, /\bwrongdoing\b/i, /\bmaker\b/i,
  /\bcaused by\b/i,
]);
const integrityStrings = () => Object.entries(STRINGS.record).filter(([k]) => k.startsWith('integrity')).map(([k, v]) => [`STRINGS.record.${k}`, v]);

test('the words about claims that failed integrity blame neither side, and pass the banned-words and judgemental checks', () => {
  const strings = integrityStrings();
  assert.ok(strings.length >= 6, strings.map(([k]) => k).join());
  for (const [at, text] of strings) {
    assert.deepEqual(wordingProblems(text), [], at);
    for (const re of BLAMING) assert.equal(re.test(text), false, `${at} says ${re}: ${text}`);
  }
});

test('the blaming guard catches what it names, and leaves the note alone', () => {
  for (const s of ['A trapped listing.', 'The maker failed this.', 'Caused by the hunter.', 'A cheat was caught.', 'Griefing.', 'At fault.', 'A malicious run.']) {
    assert.ok(BLAMING.some((re) => re.test(s)), s);
  }
  assert.equal(BLAMING.some((re) => re.test(STRINGS.record.integrityNote)), false);
});

test('the note says what the count means: on-chain a DUPLICATE, a hunter\'s own failed run raises it, it does not say who or what caused it', () => {
  const note = STRINGS.record.integrityNote;
  assert.match(note, /a hunter's own failed run also raises/i);
  assert.match(note, /does not say who or what caused/i);
  assert.match(note, /settled as DUPLICATE on-chain/i);
  assert.match(note, /kept apart from the other duplicates/i);
  assert.equal(note, INTEGRITY_NOTE, 'the API and the page say the same');
});

test('what could not be read is said in words that never call it a failed check', () => {
  assert.match(STRINGS.record.integrityUnreadNote, /plain duplicate/i);
  assert.match(STRINGS.record.integrityUnreadNote, /never as a failed check/i);
});
