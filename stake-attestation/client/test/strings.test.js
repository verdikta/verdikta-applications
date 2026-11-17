// UI strings live in src/strings.js so the wording rule can be checked in one place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findForbiddenWords } from '@verdikta/stake-attestation-shared';

import { STRINGS, fill } from '../src/strings.js';

function leaves(value, at = 'STRINGS') {
  if (typeof value === 'string') return [[at, value]];
  return Object.entries(value).flatMap(([k, v]) => leaves(v, `${at}.${k}`));
}

test('the UI strings name the app and describe the record honestly', () => {
  // the site's name, as "Verdikta Bounties" is the bounty site's; what it is stays under it in the header
  assert.equal(STRINGS.appName, 'Verdikta Verifiers');
  assert.equal(STRINGS.tagline, 'Stake attestation');
  assert.ok(STRINGS.home.lead.length > 0);
  assert.match(STRINGS.home.recordNote, /not a guarantee/);
});

// The home page's steps repeat the site's own sentences wherever one fits, so a step never says more than the
// page it leads to. A sentence edited in one place and not the other fails here.
test('the home page\'s steps that repeat another string are that string', () => {
  const { makers, hunters } = STRINGS.home.how;
  assert.equal(makers.steps.length, 4);
  assert.equal(hunters.steps.length, 4);
  assert.equal(makers.steps[0].title, STRINGS.nav.list);
  assert.equal(makers.steps[1].title, STRINGS.chain.fund);
  assert.equal(`${makers.steps[0].text} ${makers.steps[1].text}`, STRINGS.listing.intro);
  assert.equal(makers.steps[2].text, STRINGS.badge.intro);
  assert.ok(STRINGS.diligence.feed.startsWith(`${hunters.steps[0].text} `), 'the feed\'s own sentence');
  assert.ok(STRINGS.diligence.hunters.endsWith(` ${hunters.steps[3].text}`), 'the diligence text\'s own sentence');
  assert.ok(hunters.note.endsWith(STRINGS.diligence.hunters.slice(0, STRINGS.diligence.hunters.indexOf('.') + 1)), 'the diligence text\'s welcome');
});

test('no UI string holds a banned word', () => {
  for (const [at, text] of leaves(STRINGS)) {
    assert.deepEqual(findForbiddenWords(text), [], at);
  }
});

test('every UI string is a string, and placeholders are {name}', () => {
  const all = leaves(STRINGS);
  assert.ok(all.length > 100);
  for (const [at, text] of all) {
    assert.equal(typeof text, 'string', at);
    assert.doesNotMatch(text.replace(/\{\w+\}/g, '').replace(/\$\{?[A-Z_]+\}?/g, ''), /[{}]/, at);
  }
});

test('fill puts values into placeholders and leaves unknown ones', () => {
  assert.equal(fill('Listing {id} is open until {until}', { id: 7, until: 'then' }), 'Listing 7 is open until then');
  assert.equal(fill('{a} {b}', { a: 1 }), '1 {b}');
  assert.equal(fill('{toString}', {}), '{toString}');
});

test('the wording about the private key says it stays with the maker', () => {
  assert.match(STRINGS.key.shownOnce, /never sent/);
  assert.match(STRINGS.check.intro, /never sent anywhere/);
});
