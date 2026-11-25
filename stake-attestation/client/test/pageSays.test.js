// Node P42: what a listing's own page says of the listing, and from what (src/lib/pageSays.js; owner decision,
// 2026-11-24). Three parts:
//   1. only a read says what the listing is: "on hold", since when, and what its maker may do because of it come
//      from a read that is one snapshot of one block, never from the receipt of a transaction the page sent;
//   2. off the screen at once, back only from a read: after each transaction the page sends and sees mined, and each
//      time a wallet's read refuses an action, those lines are off, and they return only from a read of that block or
//      a later one;
//   3. never backward: no read of an earlier block is taken after a later one was shown, or told of.
// One function decides what the page says, from one record the page keeps. The table below has a row for each case;
// a review finding in this area is a new row first, and then the fix. Under the table, every short history of a page
// is run against the three parts, and the components are held to the function: they decide nothing of this themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { wordingProblems } from '../e2e/support/wording.js';
import { STAKE_ATTESTATION_ABI } from '../src/chain/abi.js';
import { NO_HOLD } from '../src/lib/hold.js';
import { NOTHING_READ, disagreedAt, floorOf, pageAfter, pageSays } from '../src/lib/pageSays.js';
import { STRINGS, fill } from '../src/strings.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const component = (name) => read(`../src/components/${name}`);

// a read of the listing, as the page makes it: the listing and its hold, of one block
const HELD = Object.freeze({ supported: true, heldAt: 1_800_000_123n, held: true });
const FREE = Object.freeze({ supported: true, heldAt: 0n, held: false });
const listing = (block, hold = FREE) => ({ listing: { state: 1n }, hold, block });
// the things that happen to a page
const loaded = (got) => ({ type: 'loaded', read: got });
const mined = (block) => ({ type: 'mined', block });
const disagreed = (block, shown = true) => ({ type: 'disagreed', block, shown });
const answered = (got) => ({ type: 'read', read: got });
const AGAIN = Object.freeze({ type: 'again' });
const SETTLED = Object.freeze({ type: 'settled' });
const after = (...events) => events.reduce(pageAfter, NOTHING_READ);
/** What the page says: the read on display as it is, and nothing else. */
const SHOWN = Object.freeze({ failed: null, off: false, unread: null, reading: false });

test('what the page says is one function of what happened to it: a row for each case', () => {
  // [the case, what happened, what the page says, the block of the read on display]
  const rows = [
    ['nothing read yet', [], SHOWN, null],
    ['the first read: a listing on hold is said as on hold', [loaded(listing(100, HELD))], SHOWN, 100],
    ['a read that failed on load: the failed-read state', [loaded({ failed: 'the node did not answer' })], { ...SHOWN, failed: 'the node did not answer' }, null],

    // after a transaction of the page
    ['after an own transaction, at once and before any read answers: the hold\'s lines are off', [loaded(listing(100)), mined(101)], { ...SHOWN, off: true, reading: true }, 100],
    ['an own hold, mined: the page does not say "on hold" by it, and no longer shows the listing as taking claims', [loaded(listing(100, FREE)), mined(101)], { ...SHOWN, off: true, reading: true }, 100],
    ['a mined roll or close: the old hold is off the page at once', [loaded(listing(100, HELD)), mined(101)], { ...SHOWN, off: true, reading: true }, 100],
    ['a trailing read that is not taken: from before the transaction\'s block, it changes nothing', [loaded(listing(100)), mined(101), answered(listing(100, HELD))], { ...SHOWN, off: true, reading: true }, 100],
    ['every read of the refresh failing, or trailing: the block the page has not read, with Read again', [loaded(listing(100, HELD)), mined(101), answered(listing(100, HELD)), SETTLED], { ...SHOWN, off: true, unread: 101 }, 100],
    ['a read that reached the block: the lines are back, as that read has them', [loaded(listing(100)), mined(101), answered(listing(101, HELD)), SETTLED], SHOWN, 101],
    ['a read of a later block does as well', [loaded(listing(100)), mined(101), answered(listing(105, HELD))], { ...SHOWN }, 105],
    ['a second transaction while the first is read for: only a read of the later block is taken', [loaded(listing(100)), mined(101), mined(102), answered(listing(101, HELD)), SETTLED], { ...SHOWN, off: true, unread: 102 }, 100],
    ['Read again: reading, with the lines still off', [loaded(listing(100)), mined(101), SETTLED, AGAIN], { ...SHOWN, off: true, reading: true }, 100],
    ['Read again that reaches no further: the same block is said again', [loaded(listing(100)), mined(101), SETTLED, AGAIN, answered(listing(100)), SETTLED], { ...SHOWN, off: true, unread: 101 }, 100],
    ['Read again that reaches the block', [loaded(listing(100)), mined(101), SETTLED, AGAIN, answered(listing(101, HELD)), SETTLED], SHOWN, 101],
    ['no such listing, as a read of the block has it: that read is taken like any other', [loaded(listing(100, HELD)), mined(101), answered({ missing: true, block: 101 }), SETTLED], SHOWN, 101],

    // a wallet's read that refused an action
    ['a wallet disagreement, at once and before the first retry answers', [loaded(listing(100, HELD)), disagreed(101)], { ...SHOWN, off: true, reading: true }, 100],
    ['a wallet disagreement at the height the page has read: off all the same', [loaded(listing(100, HELD)), disagreed(100)], { ...SHOWN, off: true, reading: true }, 100],
    ['and no read is taken after it: the block is said, with Read again, and the lines stay off', [loaded(listing(100, HELD)), disagreed(100), SETTLED], { ...SHOWN, off: true, unread: 100 }, 100],
    ['a read of that block, taken after the disagreement, brings the lines back as it has them', [loaded(listing(100, HELD)), disagreed(100), answered(listing(100, HELD)), SETTLED], SHOWN, 100],
    ['a read from before the disagreement\'s block is not taken', [loaded(listing(100, HELD)), disagreed(102), answered(listing(101, HELD)), SETTLED], { ...SHOWN, off: true, unread: 102 }, 100],
    ['a disagreement for a listing no longer on display sets the floor and hides nothing of the listing now shown', [loaded(listing(103, HELD)), disagreed(105, false)], { ...SHOWN, reading: true }, 103],
    ['and that floor holds: no read from before it is taken, and its block is said', [loaded(listing(103, HELD)), disagreed(105, false), answered(listing(104)), SETTLED], { ...SHOWN, unread: 105 }, 103],
    ['a disagreement for another listing does not bring back lines a transaction took off', [loaded(listing(100, HELD)), mined(101), disagreed(102, false), SETTLED], { ...SHOWN, off: true, unread: 102 }, 100],

    // R1-F8: the notice names the block the next read has to reach, the floor, and never an earlier block the page
    // was told of: a read of a block between the two was not taken, and the page must not say it has not read that far
    ['shown 110, a refusal at 105: while it reads, the lines are off and it says it is reading', [loaded(listing(110, HELD)), disagreed(105)], { ...SHOWN, off: true, reading: true }, 110],
    ['shown 110, a refusal at 105, reads of 109 not taken: the notice says 110, not 105', [loaded(listing(110, HELD)), disagreed(105), answered(listing(109, HELD)), answered(listing(109, HELD)), answered(listing(109, HELD)), answered(listing(109, HELD)), SETTLED], { ...SHOWN, off: true, unread: 110 }, 110],
    ['and a read of 110 taken after it brings the lines back', [loaded(listing(110, HELD)), disagreed(105), answered(listing(109, HELD)), answered(listing(110, HELD)), SETTLED], SHOWN, 110],
    ['an own transaction mined below the block shown: the same floor is said', [loaded(listing(110, HELD)), mined(108), answered(listing(109)), SETTLED], { ...SHOWN, off: true, unread: 110 }, 110],
    // R1-F8: the late refusal of a replaced listing, at or below the height shown. A read was asked for, so the page
    // says it is reading and ends in Read again when no read was taken, for both listings: the one no longer on
    // display (nothing of the listing now shown is off) and the one on display (its lines are off).
    ['a late refusal at 105 for a listing no longer on display, shown 110: reading, and nothing is off', [loaded(listing(110, HELD)), disagreed(105, false)], { ...SHOWN, reading: true }, 110],
    ['and no read taken: Read again, by the floor, with the listing now shown whole', [loaded(listing(110, HELD)), disagreed(105, false), answered(listing(109)), SETTLED], { ...SHOWN, unread: 110 }, 110],
    ['the same at the height shown', [loaded(listing(110, HELD)), disagreed(110, false), SETTLED], { ...SHOWN, unread: 110 }, 110],
    ['and a read taken ends it', [loaded(listing(110, HELD)), disagreed(105, false), answered(listing(110, HELD)), SETTLED], SHOWN, 110],
    ['the same refusal at 105 for the listing on display, shown 110: reading, with its lines off', [loaded(listing(110, HELD)), disagreed(105, true)], { ...SHOWN, off: true, reading: true }, 110],
    ['and no read taken: Read again, by the floor, with its lines off', [loaded(listing(110, HELD)), disagreed(105, true), answered(listing(109)), SETTLED], { ...SHOWN, off: true, unread: 110 }, 110],
    ['Read again that the visitor asks for is a read asked for: reading, then the floor again', [loaded(listing(110, HELD)), disagreed(105, false), SETTLED, AGAIN], { ...SHOWN, reading: true }, 110],

    // R2-F2: "no such listing" is a read like any other. What the page is told after it (an action that was still out
    // when that read was taken) asks for a read, says it is reading, and ends in the floor with Read again: the
    // "no listing" page draws both, as the listing's page does. Nothing of a hold is on it to take off.
    ['no listing on display, then a transaction of the page is mined: reading', [loaded(listing(100, HELD)), mined(101), answered({ missing: true, block: 101 }), SETTLED, mined(103)], { ...SHOWN, reading: true }, 101],
    ['and a trailing read is not taken: the floor, with Read again, beside "no such listing"', [loaded(listing(100, HELD)), mined(101), answered({ missing: true, block: 101 }), SETTLED, mined(103), answered(listing(102, HELD)), SETTLED], { ...SHOWN, unread: 103 }, 101],
    ['a delayed refusal after it, below the block read: the floor is the block of that read', [loaded(listing(100, HELD)), mined(101), answered({ missing: true, block: 104 }), SETTLED, disagreed(102, false), SETTLED], { ...SHOWN, unread: 104 }, 104],
    ['and Read again that reaches the floor is taken: the listing, as that read has it', [loaded(listing(100, HELD)), mined(101), answered({ missing: true, block: 101 }), SETTLED, mined(103), SETTLED, AGAIN, answered(listing(103, HELD)), SETTLED], SHOWN, 103],

    // never backward
    ['a trailing read after a later one was shown is not taken', [loaded(listing(103)), AGAIN, answered(listing(102, HELD)), SETTLED], { ...SHOWN, unread: 103 }, 103],
    ['nor after a later one was taken in the same reading', [loaded(listing(100)), mined(101), answered(listing(103)), answered(listing(101, HELD)), SETTLED], SHOWN, 103],

    // a contract with no hold: there is no line of a hold to take off; the floor and what it says are the same
    ['against a contract with no hold nothing is taken off', [loaded(listing(100, NO_HOLD)), mined(101)], { ...SHOWN, reading: true }, 100],
    ['and the floor says the block it has not read all the same', [loaded(listing(100, NO_HOLD)), mined(101), answered(listing(100, NO_HOLD)), SETTLED], { ...SHOWN, unread: 101 }, 100],
  ];
  for (const [what, events, says, block] of rows) {
    const page = after(...events);
    assert.deepEqual(pageSays(page), says, what);
    assert.equal(page.read?.block ?? null, block, `${what}: the read on display`);
  }
  // each case the rule names has its row
  for (const named of [
    'after an own transaction, at once and before any read answers',
    'a wallet disagreement, at once and before the first retry answers',
    'every read of the refresh failing',
    'a read that reached the block',
    'a trailing read that is not taken',
    'a disagreement for a listing no longer on display sets the floor and hides nothing',
    'shown 110, a refusal at 105, reads of 109 not taken: the notice says 110, not 105',
    'a late refusal at 105 for a listing no longer on display, shown 110',
    'the same refusal at 105 for the listing on display, shown 110',
    'no listing on display, then a transaction of the page is mined: reading',
    'and a trailing read is not taken: the floor, with Read again, beside "no such listing"',
  ]) assert.ok(rows.some(([what]) => what.startsWith(named)), `a row for: ${named}`);
  // the block said is always the floor: never one below a block the read on display is of
  for (const [what, events] of rows) {
    const page = after(...events);
    const says = pageSays(page);
    if (says.unread !== null) assert.equal(says.unread, floorOf(page), what);
    if (says.unread !== null && page.read?.block) assert.ok(says.unread >= page.read.block, what);
  }
});

test('every short history of a page keeps the three parts of the rule', () => {
  const start = loaded(listing(100, HELD));
  const events = [
    mined(101), mined(103), disagreed(100), disagreed(102), disagreed(104, false),
    answered(listing(99, HELD)), answered(listing(100, HELD)), answered(listing(101)), answered(listing(102, HELD)), answered(listing(104)),
    AGAIN, SETTLED,
  ];
  let histories = 0;
  // `asked`: a read was asked for and none was taken since; `out`: the reads made for it are still out
  const walk = (page, told, mustBeOff, asked, out, depth) => {
    histories += 1;
    const says = pageSays(page);
    const floor = Math.max(told, page.read.block);
    // part 2: off from the instant the page was told, until a read is taken
    assert.equal(says.off, mustBeOff, 'the hold\'s lines are off exactly while the page knows its read is behind');
    // every read that was asked for says so while it is out, and ends in the floor's block with Read again when none
    // was taken: whether or not anything is off the page, and whatever block the page was told of (R1-F8)
    assert.equal(says.reading, asked && out, 'reading, exactly while a read that was asked for is out');
    assert.equal(says.unread, asked && !out ? floor : null, 'the floor with Read again, exactly when its reads are over and none was taken');
    if (says.off) assert.ok(asked, 'never off without saying why');
    assert.equal(floorOf(page), floor, 'the floor');
    if (depth === 0) return;
    for (const event of events) {
      const next = pageAfter(page, event);
      let nextTold = told;
      let nextOff = mustBeOff;
      let nextAsked = asked;
      let nextOut = out;
      if (event.type === 'mined' || event.type === 'disagreed') {
        nextTold = Math.max(told, event.block);
        if (event.type === 'mined' || event.shown) nextOff = true;
      }
      if (event.type === 'mined' || event.type === 'disagreed' || event.type === 'again') {
        nextAsked = true;
        nextOut = true;
      }
      if (event.type === 'settled') nextOut = false;
      if (event.type === 'read') {
        // a read that is not taken changes nothing: the record is the same one
        const taken = next !== page;
        // part 3: a read is taken exactly when it is of the floor's block or a later one, so never backward
        assert.equal(taken, event.read.block >= Math.max(told, page.read.block), 'taken only from the floor up');
        if (taken) assert.equal(next.read, event.read, 'and it is the read on display');
        // part 2: back only from a read of that block or a later one
        if (taken) {
          nextOff = false;
          nextAsked = false;
        }
      }
      assert.ok(next.read.block >= page.read.block, 'the read on display never goes back');
      walk(next, nextTold, nextOff, nextAsked, nextOut, depth - 1);
    }
  };
  walk(pageAfter(NOTHING_READ, start), 0, false, false, false, 4);
  assert.ok(histories > 20_000, `${histories} histories`);
  assert.throws(() => pageAfter(NOTHING_READ, { type: 'receipt' }), /no such event/);
});

test('the page draws what it says from that function alone, and is told by every action', () => {
  const page = component('FundPage.jsx');
  // one record, moved on in one place, and one function that reads it
  assert.match(page, /const record = useRef\(NOTHING_READ\);/);
  assert.match(page, /const happened = useCallback\(\(event\) => \{\s*record\.current = pageAfter\(record\.current, event\);\s*redraw\(\(n\) => n \+ 1\);\s*\}, \[\]\);/);
  assert.equal(page.split('record.current =').length - 1, 1, 'the record is written in one place');
  assert.match(page, /const loaded = record\.current\.read;[^\n]*\n\s*const says = pageSays\(record\.current\);/);
  assert.doesNotMatch(page, /setLoaded|useState\(null\)/, 'no second copy of the read');
  // the refresh: told at once, before any read; then reads from the floor, and hands over only a read that reached it
  const refresh = page.slice(page.indexOf('const refresh = useCallback('), page.indexOf('const onChanged = useCallback('));
  assert.match(refresh, /if \(told === null\) happened\(\{ type: 'again' \}\);\s*else if \(typeof told === 'number'\) happened\(\{ type: 'mined', block: told \}\);\s*else happened\(\{ type: 'disagreed', block: told\.block, shown: of === onDisplay\.current \}\);/);
  assert.ok(refresh.indexOf('happened({ type: \'mined\'') < refresh.indexOf('readFrom('), 'told before the first read is asked for');
  assert.match(refresh, /readFrom\(\(\) => readListing\(listingId\), floorOf\(record\.current\), \{ live: wanted \}\)\.then\(\(\{ read, reached \}\) => \{\s*if \(!wanted\(\)\) return;\s*if \(reached\) happened\(\{ type: 'read', read \}\);\s*happened\(\{ type: 'settled' \}\);\s*\}\);/);
  assert.equal(page.split('type: \'read\'').length - 1, 1, 'a read is taken in one place');
  // a disagreement is with the listing the action was drawn for: each callback carries that listing
  assert.match(page, /const identity = loaded\?\.listing \? `\$\{loaded\.listing\.maker\}:\$\{loaded\.listing\.artifactHash\}`\.toLowerCase\(\) : null;\s*const onDisplay = useRef\(null\);\s*onDisplay\.current = identity;/);
  assert.match(page, /const onChanged = useCallback\(\(told\) => refresh\(told, identity\), \[refresh, identity\]\);/);
  assert.deepEqual(disagreedAt(7), { disagreed: true, block: 7 });
  // what the page says of the hold, and of what the listing takes, is under `quiet`: the function's `off`
  assert.match(page, /const \{ hold \} = loaded;\s*const quiet = says\.off;/);
  for (const line of ['data-testid="listing-state"', 'data-testid="listing-held-since"', 'data-testid="listing-open-until"', 'data-testid="listing-held"', 'F.notFundable']) {
    const at = page.indexOf(line);
    assert.ok(at > -1, line);
    assert.ok(page.slice(page.lastIndexOf('\n', at), at).includes('{!quiet && '), `${line} is drawn only while the page may say its read`);
  }
  assert.match(page, /<ListingMore listingId=\{listingId\} listing=\{l\} hold=\{hold\} quiet=\{quiet\} onChanged=\{onChanged\} \/>/);
  assert.match(page, /<CloseListing listingId=\{listingId\} listing=\{l\} quiet=\{quiet\} onChanged=\{onChanged\} \/>/);
  assert.match(page, /<Withdraw version=\{version\} onChanged=\{onChanged\} \/>/);
  // what it says of the block it has not read
  assert.match(page, /\{says\.reading && <p className="hint" role="status" data-testid="listing-reading">\{F\.reading\}<\/p>\}/);
  assert.match(page, /\{says\.unread !== null && \(\s*<>\s*<p className="warning" role="status" data-testid="listing-behind">\{fill\(F\.behind, \{ block: says\.unread \}\)\}<\/p>\s*<button type="button" className="secondary" data-testid="listing-read-again" onClick=\{\(\) => refresh\(\)\}>\{F\.retry\}<\/button>/);
  // R2-F2: one piece of the page says it, drawn wherever a read was taken: under a listing, and on the "no such
  // listing" page, where an action that was still out when that read was taken can ask for another
  assert.match(page, /const notice = \(\s*<>\s*\{says\.reading && /);
  assert.equal(page.split('says.reading').length - 1, 1, 'said in one place');
  assert.equal(page.split('says.unread').length - 1, 2, 'said in one place');
  assert.match(page, /if \(loaded\.missing\) return <>\{header\}<p className="error">\{fill\(F\.notFound, \{ id: listingId \}\)\}<\/p>\{notice\}\{lookupForm\}<\/>;/);
  assert.equal(page.split('{notice}').length - 1, 2, 'on the "no such listing" page and under a listing');
  assert.ok(page.indexOf('const notice = (') < page.indexOf('if (loaded.missing) return'), 'made before either is drawn');
  assert.equal(fill(STRINGS.fund.behind, { block: 90 }), 'This page has not read the chain at block 90 or later since a change was sent or seen through the wallet: what it shows of the listing may be from before that change.');
  // R1-F8: the block is the floor's, so the sentence is true of every read the page did not take; it names no block
  // "there", since the change may have been seen at an earlier one
  assert.doesNotMatch(STRINGS.fund.behind, /a change there/);
  for (const text of [STRINGS.fund.behind, STRINGS.fund.reading]) {
    assert.doesNotMatch(text, /[\n\r\t]| {2}/);
    assert.deepEqual(wordingProblems(text), []);
    // said against a contract with no hold too: it names none
    assert.doesNotMatch(text, /hold/i);
  }
  // the failed-read state is the page's own, as it was: nothing of a listing is drawn with it
  assert.match(page, /if \(says\.failed !== null\) \{\s*return \(\s*<>\s*\{header\}\s*<p className="error">\{fill\(F\.readFailed, \{ reason: says\.failed \}\)\}<\/p>\s*<button type="button" onClick=\{\(\) => setAttempt\(\(a\) => a \+ 1\)\}>\{F\.retry\}<\/button>/);
  assert.ok(page.indexOf('if (says.failed !== null)') < page.indexOf('const l = loaded.listing;'), 'before anything of a listing is computed');
});

test('every action tells the page: the block its transaction was mined in, on every path that sends, and each refusal of its read through the wallet', () => {
  const actions = component('ListingActions.jsx');
  const extras = component('ListingExtras.jsx');
  const funding = component('FundListing.jsx');
  // every transaction of the page takes its receipt through minedReceipt, which tells the page before it returns or
  // throws (test/wallet.test.js): a call sent again at a higher fee, a replacement and a revert included
  for (const [name, source] of [['ListingActions.jsx', actions], ['ListingExtras.jsx', extras], ['FundListing.jsx', funding], ['FundPage.jsx', component('FundPage.jsx')]]) {
    assert.doesNotMatch(source, /\.wait\(\)/, `${name}: no receipt is taken past minedReceipt`);
  }
  assert.equal(actions.split('await minedReceipt(tx, onChanged);').length - 1, 5, 'top-up, renew, hold, close, withdraw');
  assert.equal(extras.split('await minedReceipt(tx, onChanged);').length - 1, 1, 'roll forward');
  assert.equal(funding.split('await minedReceipt(tx, onMined);').length - 1, 1, 'the opening');
  assert.match(component('FundPage.jsx'), /\n\s*<FundListing listingId=\{BigInt\(listingId\)\} top=\{l\.awards\[3\]\} maker=\{l\.maker\} artifactHash=\{l\.artifactHash\} listed=\{state === 'Listed'\} quiet=\{quiet\} onMined=\{onChanged\} \/>/);
  const sends = (source) => source.split(/stakeAttestation\(signer\)\.[a-zA-Z]+\(/).length - 1;
  assert.equal(sends(actions) + sends(extras) + sends(funding), 7, 'and there is no other transaction on the page');
  // a refusal by the read through the wallet, where it is the listing the wallet has otherwise: handed over with that
  // read's block, never as a bare number (which would say a transaction was mined)
  assert.equal(actions.split('onChanged(disagreedAt(block));').length - 1, 4, 'top-up, renew, hold, close');
  assert.equal(extras.split('onChanged(disagreedAt(block));').length - 1, 1, 'roll forward, when it is this listing that changed');
  for (const source of [actions, extras]) assert.doesNotMatch(source, /onChanged\(\)|onChanged\(block(?:Tag)?\)/);
  // R1-F4: that read is one snapshot through the wallet with the count asked first, so a listing the wallet's node
  // does not have at that block is an answer (null) and a disagreement like any other. getListing alone reverts for
  // such an id, which would end in the action's failure and tell the page nothing.
  assert.equal(actions.split('await snapshot(provider, (at) => listingAt(stakeAttestation(at), listingId));').length - 1, 2, 'top-up, close');
  assert.equal(actions.split('if (mine === null || !').length - 1, 2, 'top-up, close: no listing is a refusal, with the others');
  // R1-F4, round 2: where an action reads something besides the listing (the renewal its fee, the hold the hold's
  // time), the listing is read first, and the other only when the listing alone does not rule the action out. What
  // the wallet has of this listing is never lost to a failure of the other read: no Promise.all over the two.
  assert.match(actions, /const renewable = \(l\) => l !== null && renewTerms\(l, 0\)\.can && same\(l\.maker, account\);\s*const \{ value: \[mine, due\], block \} = await snapshot\(provider, async \(at\) => \{\s*const view = stakeAttestation\(at\);\s*const source = await listingAt\(view, listingId\);\s*return \[source, renewable\(source\) \? await view\.listingFeeWei\(\) : null\];\s*\}\);\s*if \(!renewable\(mine\)\) \{/);
  assert.match(actions, /const \{ value: \[mine, now\], block \} = await snapshot\(provider, async \(at\) => \{\s*const view = stakeAttestation\(at\);\s*const source = await listingAt\(view, listingId\);\s*return \[source, holdable\(source\) \? await readHold\(view, listingId\) : NO_HOLD\];\s*\}\);\s*(?:\/\/[^\n]*\n\s*)*if \(!holdable\(mine\) \|\| !holdTerms\(mine, now\)\.can\) \{/);
  assert.match(actions, /const holdable = \(l\) => sameListing\(l, asking\) && holdTerms\(l, NOT_ON_HOLD\)\.can;/);
  for (const source of [actions, extras]) assert.doesNotMatch(source, /Promise\.all\(\[listingAt\(/, 'the listing is never read beside another read that can fail it');
  assert.doesNotMatch(actions, /\.getListing\(BigInt\(listingId\), \{ blockTag/, 'no read before sending asks getListing for an id the contract may not have');
  assert.match(actions, /const stateWords = \(l\) => \(l === null \? STRINGS\.fund\.missing : /);
  // The refusal says what the page does next, not that it has done it: the alert is drawn before any read answers,
  // and can stand beside "has not read the chain at block N or later".
  assert.equal(fill(STRINGS.topUp.changed, { id: 7, state: STRINGS.fund.missing }), 'Nothing was sent: listing 7 can no longer be topped up (it is not on the chain as your wallet reads it). This page reads it again.');
  assert.equal(fill(STRINGS.renew.changed, { id: 7, state: 'closed' }), 'Nothing was sent: listing 7 can no longer be renewed (it is closed). This page reads it again.');
  assert.equal(fill(STRINGS.close.changed, { id: 7 }), 'Nothing was sent: listing 7 changed on-chain since this page read it. This page reads it again.');
  for (const key of ['topUp', 'renew', 'close', 'hold']) assert.doesNotMatch(STRINGS[key].changed, /has been read/, key);
  // The roll reads this listing first, and the successor only when this one can still roll: what the wallet has of
  // this listing is never lost to a failure of the successor's read (no Promise.all over the two).
  assert.match(extras, /const \{ value: \[mine, successor, successorHold\], block \} = await snapshot\(provider, async \(at\) => \{\s*const sa = stakeAttestation\(at\);\s*const source = await listingAt\(sa, listingId\);\s*if \(!canRoll\(source\)\) return \[source, null, NO_HOLD\];\s*return \[source, await listingAt\(sa, pick\), hold\.supported \? await readHold\(sa, pick\) : NO_HOLD\];\s*\}\);\s*if \(!canRoll\(mine\)\) \{\s*(?:\/\/[^\n]*\n\s*)?onChanged\(disagreedAt\(block\)\);\s*return setError\(fill\(RF\.changed, \{ id: pick \}\)\);\s*\}/);
  assert.match(extras, /const canRoll = \(l\) => l !== null && ROLLABLE\.has\(LISTING_STATES\[Number\(l\.state\)\]\) && same\(l\.maker, account\);/);
  // a read that failed on the way is the action's failure: it is thrown past the refusal, and tells the page nothing
  for (const source of [actions, extras]) assert.doesNotMatch(source, /catch \([^)]*\) \{[^}]*onChanged\(/);
  assert.match(read('../src/chain/wallet.js'), /if \(id === 0n \|\| id > BigInt\(await contract\.listingCount\(\)\)\) return null;/);
  // and nothing of identity in those four: the listing's maker and artifact are held to the page's only by the hold
  assert.equal(actions.split('sameListing(').length - 1, 2, 'the hold\'s first step and its read, and no other action');
  assert.equal(actions.slice(actions.indexOf('export function HoldListing('), actions.indexOf('export function CloseListing(')).split('sameListing(').length - 1, 2, 'both in the hold');
  assert.doesNotMatch(extras, /sameListing/);
  assert.equal(STRINGS.fund.replaced, undefined);
});

test('while the page knows its read is behind, a section draws its own transaction\'s line and its own error, and nothing of the read', () => {
  const actions = component('ListingActions.jsx');
  const part = (name, next) => actions.slice(actions.indexOf(`export function ${name}(`), next ? actions.indexOf(`export function ${next}(`) : undefined);
  const topUp = part('TopUpEscrow', 'RenewListing');
  assert.match(topUp, /if \(!terms\.can && !done\) return null;\s*if \(quiet && !done && !error\) return null;\s*const shown = terms\.can && !quiet;/);
  assert.equal(topUp.split('{shown && (').length - 1, 2, 'what the listing holds, and the form');
  assert.doesNotMatch(topUp, /\{terms\.can && /);
  const renew = part('RenewListing', 'HoldListing');
  assert.match(renew, /if \(!terms\.can && !done\) return null;\s*if \(quiet && !done && !error\) return null;\s*const shown = terms\.can && !quiet;/);
  assert.equal(renew.split('{shown && ').length - 1, 3, 'the paid period, the line of a listing on hold, and the form');
  assert.doesNotMatch(renew, /\{terms\.can && /);
  const hold = part('HoldListing', 'CloseListing');
  assert.match(hold, /const off = quiet \|\| terms\.why === 'state';\s*if \(off && !done && !error\) return null;/);
  assert.match(hold, /let body = null;\s*if \(!off && hold\.held\) \{/);
  assert.match(hold, /\} else if \(!off\) \{/);
  assert.match(hold, /\{!off && <p>\{H\.intro\}<\/p>\}/);
  const close = part('CloseListing', 'Withdraw');
  assert.match(close, /if \(terms\.why === 'closed' && !done\) return null;\s*if \(quiet && !done && !error\) return null;/);
  assert.match(close, /if \(done\) \{[\s\S]*?\} else if \(quiet\) \{\s*body = null;\s*\} else if \(terms\.why === 'pending'\) \{/);
  const extras = component('ListingExtras.jsx');
  // R1-F5: the roll panel's own error is drawn where the panel is not: while the page knows its read is behind, and
  // once a read has the listing neither Open nor Depleted. A roll that was mined and failed stays said.
  assert.match(extras, /if \(done\) return <p data-testid="rolled" className="ok">\{fill\(RF\.done, \{ id: done\.id, tx: done\.tx \}\)\}<\/p>;\s*(?:\/\/[^\n]*\n\s*)*if \(quiet \|\| !ROLLABLE\.has\(state\)\) return error \? <p className="error" role="alert">\{error\}<\/p> : null;/);
  assert.match(extras, /\} catch \(err\) \{\s*setError\(fill\(STRINGS\.claim\.failed, \{ reason: walletMessage\(err\) \}\)\);/);
  // One of the roll panel's refusals says that a successor is on hold. It is kept apart from the panel's own error,
  // and so is not drawn while the page knows its read is behind: nothing on the page says "on hold" then.
  assert.match(extras, /if \(successorHold\.held\) \{\s*setAgain\(\(n\) => n \+ 1\);\s*return setHeldSuccessor\(pick\);\s*\}/);
  assert.match(extras, /\{\(error \?\? heldSuccessor\) && <p className="error" role="alert">\{error \?\? fill\(RF\.successorOnHold, \{ id: heldSuccessor \}\)\}<\/p>\}/);
  assert.equal(extras.split('RF.successorOnHold').length - 1, 1, 'said in one place, which `quiet` never reaches');
  // no error that stays while the page is behind says the listing is on hold, or what to do because of it
  for (const [at, text] of [['roll.changed', STRINGS.roll.changed], ['hold.changed', STRINGS.hold.changed], ['hold.mined', STRINGS.hold.mined], ['topUp.changed', STRINGS.topUp.changed], ['renew.changed', STRINGS.renew.changed], ['renew.feeChanged', STRINGS.renew.feeChanged], ['close.changed', STRINGS.close.changed], ['claim.failed', STRINGS.claim.failed], ['claim.notMaker', STRINGS.claim.notMaker]]) {
    assert.doesNotMatch(text, /on hold|push the fix/i, at);
  }
  assert.match(extras, /if \(!data \|\| quiet\) return null;/);
  assert.match(extras, /<CommitOffer data=\{data\} held=\{hold\.held\} quiet=\{quiet\} \/>/);
  assert.match(extras, /<HoldListing listingId=\{listingId\} listing=\{listing\} hold=\{hold\} quiet=\{quiet\} onChanged=\{onChanged\} \/>/);
});

test('the lines of the page\'s other actions for their own transactions are the site\'s as they were: the transaction, and the values drawn with it', () => {
  const actions = component('ListingActions.jsx');
  // drawn while the action has its transaction and its listing is on the page, through every re-read of it: never
  // under `quiet`, never checked against a later read
  assert.match(actions, /\{done && \(\s*<p className="ok" data-testid="topped-up">\s*\{done\.toOwed > 0n\s*\? fill\(T\.doneOwed, \{ tx: done\.tx, owed: formatEth\(done\.toOwed\), eth: formatEth\(done\.escrow\) \}\)\s*: fill\(T\.done, \{ tx: done\.tx, eth: formatEth\(done\.escrow\) \}\)\}\s*\{done\.reopened \? ` \$\{T\.reopened\}` : ''\}\s*<\/p>\s*\)\}/);
  assert.match(actions, /\{done && <p className="ok" data-testid="renewed">\{fill\(R\.done, \{ tx: done\.tx, until: formatTime\(done\.until\) \}\)\}<\/p>\}/);
  assert.match(actions, /if \(done\) \{\s*body = \(\s*<p className="ok" data-testid="closed">\s*\{fill\(done\.deferred \? C\.doneDeferred : C\.done, \{ id: listingId, tx: done\.tx, eth: formatEth\(done\.amount\), account: done\.account \}\)\}\s*<\/p>\s*\);/);
  assert.match(actions, /\{done && <p className="ok" data-testid="withdrawn">\{fill\(W\.done, \{ tx: done\.tx, eth: formatEth\(done\.amount\), account: done\.account \}\)\}<\/p>\}/);
  const funding = component('FundListing.jsx');
  assert.match(funding, /if \(opened\) \{\s*return \(\s*<p data-testid="opened" className="ok">\s*\{opened\.until\s*\? fill\(C\.opened, \{ id: String\(listingId\), until: formatTime\(opened\.until\), tx: opened\.tx \}\)\s*: fill\(C\.openedNoTime, \{ id: String\(listingId\), tx: opened\.tx \}\)\}\s*<\/p>\s*\);\s*\}/);
  // and their words
  assert.equal(STRINGS.chain.opened, 'Listing {id} is open until {until} (transaction {tx}).');
  assert.equal(STRINGS.chain.openedNoTime, 'Listing {id} is open (transaction {tx}). Its page shows until when.');
  assert.equal(STRINGS.topUp.done, 'Topped up (transaction {tx}). The escrow now holds {eth} ETH.');
  assert.equal(STRINGS.topUp.doneOwed, 'Topped up (transaction {tx}). {owed} ETH went to hunters who were owed it, and the escrow now holds {eth} ETH.');
  assert.equal(STRINGS.topUp.reopened, 'The listing is open again.');
  assert.equal(STRINGS.renew.done, 'Renewed (transaction {tx}). The listing fee is paid until {until}.');
  assert.equal(STRINGS.close.done, 'Listing {id} is closed (transaction {tx}). {eth} ETH of escrow went back to {account}.');
  assert.equal(STRINGS.close.doneDeferred, 'Listing {id} is closed (transaction {tx}). The contract could not send the {eth} ETH of escrow to {account}, so it holds the amount for that wallet: withdraw it below.');
  assert.equal(STRINGS.withdraw.done, 'Withdrawn (transaction {tx}): {eth} ETH to {account}.');
  assert.equal(STRINGS.roll.done, 'Rolled forward to listing {id} (transaction {tx}).');
  // On the listing's own page one FundListing is on the page for as long as its listing is, whatever the listing's
  // state (R7-F1): it is drawn under a listing with no condition, so an opening's receipt that arrives after the page
  // read the listing as Open still has the instance that sent it, and its line. The page keeps no flag for it.
  const page = component('FundPage.jsx');
  assert.equal(page.split('<FundListing ').length - 1, 1);
  assert.doesNotMatch(page, /&& <FundListing /);
  assert.doesNotMatch(page, /openedHere|setOpenedHere|onOpened/);
  // The opening's form is the read's (R5-F4): FundListing draws the escrow field and the button only while the listing
  // on display is Listed, and reads no fee for a listing that is not. So a listing read again as Open after "no such
  // listing" has no opening form, whenever the opening's receipt arrived.
  const opening = component('FundListing.jsx');
  assert.match(opening, /useEffect\(\(\) => \{\s*if \(!listed\) return undefined;\s*let live = true;\s*chainReader\(\)\.then\(\(p\) => stakeAttestation\(p\)\.feeDue\(listingId\)\)[^\n]*\n\s*return \(\) => \{ live = false; \};\s*\}, \[listingId, listed\]\);/);
  assert.equal(opening.split('useEffect(').length - 1, 1, 'its one read outside a click');
  // While the page knows its read is behind, the form is off as the forms of top-up, renewal and close are: the
  // opening's own line first, then its own error if it has one, and nothing else. `quiet` is not folded into `listed`:
  // the error of an opening that failed stays while the reader trails.
  assert.match(opening, /export function FundListing\(\{ listingId, top, maker, artifactHash, listed = true, quiet = false, onMined = \(\) => \{\}, onOpened = \(\) => \{\} \}\) \{/);
  assert.doesNotMatch(opening, /listed && !quiet|!listed \|\| quiet/);
  const drawn = opening.slice(opening.indexOf('  if (opened) {'));
  assert.match(drawn, /^ {2}if \(opened\) \{\s*return \(\s*<p data-testid="opened" className="ok">[\s\S]*?\);\s*\}\s*(?:\/\/[^\n]*\n\s*)*if \(!listed\) return null;\s*(?:\/\/[^\n]*\n\s*)*if \(quiet\) return error \? <p className="error" role="alert">\{error\}<\/p> : null;\s*return \(\s*<>\s*\{fee !== null/);
  // the listing flow has just listed the listing it funds, and says nothing of `listed`
  assert.match(component('ListAndFund.jsx'), /<FundListing listingId=\{listed\.listingId\} top=\{BigInt\(params\.awards\[3\]\)\} maker=\{listed\.maker\} artifactHash=\{view\.artifactHash\} onOpened=\{\(\) => setOpened\(true\)\} \/>/);
});

test('the page keeps no receipt to check against later reads: nothing of that mechanism is left in the client', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir));
      else if (/\.(js|jsx|css)$/.test(entry.name)) files.push(new URL(entry.name, dir));
    }
  };
  walk(new URL('../src/', import.meta.url));
  assert.ok(files.length > 40, `${files.length} files`);
  const GONE = [/\bkept\(/, /\bisKept\b/, /\basKept\b/, /\breceiptVerdict\b/, /\breceiptStands\b/, /\bafterRead\b/, /\bkeptBlocks\b/, /\bKeptBlocks\b/, /\bhasHashAt\b/, /\bhashAt\b/, /\brefreshHeights\b/, /\buseSeenMined\b/, /seenMined/, /\bheldHere\b/, /\bopeningStands\b/, /\bunchecked\b/, /could not check/, /\.dropped\b/, /"listing-read"|\.listing-read\b/];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const re of GONE) assert.doesNotMatch(source, re, `${file.pathname.split('/src/')[1]}: ${re}`);
  }
  for (const name of ['lib/seenMined.js', 'components/seenMined.js']) assert.equal(fs.existsSync(new URL(`../src/${name}`, import.meta.url)), false, name);
  // a snapshot carries its block and nothing of other heights
  assert.doesNotMatch(read('../src/chain/snapshot.js'), /heights|hashes/);
  // and the client's ABI has no event that was there only for a receipt's line
  for (const event of ['Renewed', 'Withdrawn']) assert.equal(STAKE_ATTESTATION_ABI.some((f) => f.startsWith(`event ${event}(`)), false, event);
  // no string says a transaction of the page is not on the chain, or that the page could not check one
  const strings = read('../src/strings.js');
  assert.doesNotMatch(strings, /is not on the chain as this page now reads it|could not check the block/);
});

test('the README and the deploy notes say the rule, and what the page assumes of the chain', () => {
  const readme = read('../../README.md').replace(/\s+/g, ' ');
  const between = (from, to) => {
    assert.ok(readme.includes(from) && readme.includes(to), `${from} … ${to}`);
    return readme.slice(readme.indexOf(from), readme.indexOf(to));
  };
  const rule = between('**What the page says, and from what**', '**The page\'s own transactions**');
  assert.match(rule, /no receipt of a transaction the page sent stands in for a read, not the hold's and not the opening's/);
  assert.match(rule, /From that instant, before any new read answers, the page shows nothing that says the listing is on hold or what its maker may do because of it, and nothing that shows it as taking claims/);
  assert.match(rule, /everything comes back from that read alone/);
  // what is off names the opening's form too, and what stays is said as it is drawn: not every value of a line is its receipt's
  assert.match(rule, /the forms of the opening, top-up, renew and close are off\. Each action's line for its own transaction stays as it was drawn/);
  assert.doesNotMatch(readme, /worded by its receipt|what its receipt said/);
  assert.match(readme, /A close's refund and a top-up's amounts are taken from the receipt's events \(each with a fallback only for a receipt without its event\); an opening's and a renewal's date are a read through the wallet after the receipt; a withdrawal's amount is the one read through the wallet before it was sent\./);
  assert.match(rule, /walks every sequence of up to four events drawn from twelve fixed ones, from one start \(a held listing read at one block\), against the three parts/);
  assert.doesNotMatch(readme, /runs every short history/);
  // R6-F1: an action's own error is said as it is, where its section is drawn; the rest is issue 240's
  assert.doesNotMatch(readme, /and its own error, stay/);
  assert.match(rule, /Its own error is shown where its section is drawn, and no further\. As before this node, the opening, top up, renewal and close draw no section for a listing the page's read rules the action out on, and a withdrawal none for a wallet that is held nothing, unless that action's own transaction line is there: an error of theirs that arrives then is not shown \(verdikta-applications issue 240\)\./);
  assert.match(rule, /The hold and the roll forward draw theirs while the listing is on the page and has opened \(one refusal apart, the roll's "that successor is on hold", which is drawn only with the panel\)\./);
  // R7-F2: a re-read through a wallet on another network is a re-read that reached no block; the network is not named there
  assert.match(rule, /A re-read through a wallet that is on another network is such a read: the page does not name the network there \(verdikta-applications issue 247\)\./);
  assert.match(rule, /No read of an earlier block is taken after a later one was shown, or after the page was told of a later one/);
  assert.match(rule, /Against a contract with no hold there is no line of a hold to take off, and nothing is/);
  const own = between('**The page\'s own transactions**', '**One read is one block, and a block is its hash, never its number**');
  // R1-F6: what is so of an action's own line, and no more: kept while its listing is on the page
  assert.match(own, /Such a line is kept while its listing is on the page, through every re-read of it, and is not checked against a later read\./);
  assert.match(own, /A read that says the listing is gone takes the page with its actions, and one that says it has not opened takes the hold's and the roll's, whose panel is an opened listing's\./);
  assert.match(own, /The opening's form \(the escrow field and its button\) is the read's all along: it is drawn only while the listing on display is Listed/);
  assert.doesNotMatch(readme, /for the visit/);
  assert.match(rule, /it names the block its next read has to reach, with "Read again"/);
  assert.match(rule, /so a listing the wallet's node does not have at that block is an answer, and a disagreement like any other/);
  // the owner's assumption (2026-11-24), what the page holds all the same, and for which reads
  const reads = between('**The page reads; it does not watch.**', '**How the page knows.**');
  assert.match(reads, /the nodes behind one address are taken to agree on the chain \(owner decision, 2026-11-24\)/);
  assert.match(reads, /where a read address is configured \(`VITE_SA_RPC_URL`\): a hold's state and its next step, as the page shows them, come from one read tied to one block's hash, and a node without that block refuses the read/);
  assert.match(reads, /A wallet's node is asked by the block's number, so none of that is held for it/);
  assert.match(reads, /stand on the assumption alone, that the nodes behind the wallet's address agree on the chain/);
  // R5-F2: a wallet's node is held to the site's chain in every read, and R5-F1: a listing's id has one form
  const oneBlock = between('**One read is one block, and a block is its hash, never its number**', '**The page reads; it does not watch.**');
  assert.match(oneBlock, /A wallet can change network at any moment, so a read through one is also held to the site's chain \(`VITE_SA_CHAIN_ID`\): in every try, once the closing header has answered, the wallet is asked its chain, and any other chain fails the read there, with no further try of it\./);
  // R9-F1, recorded as issue 248: said as the code is, and no more
  assert.match(oneBlock, /When the closing header request itself is rejected, as the node of another network may reject it, the read fails with that node's error: the chain is not asked, the reported change is not looked at, and no further try is made \(verdikta-applications issue 248\)\./);
  assert.doesNotMatch(readme, /the wallet is asked its chain after the calls of every try/);
  assert.match(oneBlock, /The page's first read and an action's read say that failure with the wallet's wrong-network message; a re-read of the page does not name the network/);
  assert.doesNotMatch(readme, /never made again on that network/);
  assert.match(oneBlock, /A try during which the wallet reported a change of network \(its `chainChanged` event\) is not taken either/);
  assert.match(reads, /Such a read is held to the site's chain all the same/);
  assert.match(readme, /The id in the address is read once and has one form from there on, the decimal number with no leading zeros: `#\/fund\/001` is the page of listing 1/);
  const config = between('**Config** is Vite\'s build environment', '**Wording.**');
  assert.match(config, /The nodes behind the address are taken to agree on the chain/);
  // R2-F1: how the page knows a contract has no hold, said as it is: the revert's data, or the contract's one reason
  // under code 3 where a provider leaves the data out. No deployment is asked for revert data.
  assert.match(config, /Against a contract from before the hold, the page knows there is no hold from the contract's own refusal of `heldAt`: the revert's data where the node hands it over, and where it does not, the node's error of code 3 whose message is exactly `execution reverted: unknown function`/);
  assert.match(config, /Any other failure of that call is a failed read of the page, never a listing on hold shown as one that is not/);
  assert.doesNotMatch(readme, /has to hand over a revert's data|drops the data/);
  const deployNote = read('../../deploy/client.env');
  assert.match(deployNote, /# Against a contract from before the hold, the page knows there is no hold from the contract's own refusal of heldAt/);
  assert.doesNotMatch(deployNote, /has to hand over a revert's data|drops it gives/);
  const knows = between('**How the page knows.**', 'The same page carries the rest of a listing\'s life');
  assert.match(knows, /the reader goes by the contract's own refusal and not by that code: the revert's data, or, with no data, the node's error of code 3 whose message is exactly `execution reverted: unknown function`/);
  assert.match(config, /Without a read address the page's reads go through the visitor's wallet, by block number, and what they show of a hold is not tied to a block's hash/);
  const env = read('../../deploy/client.env');
  assert.match(env, /# The nodes behind the address are taken to agree on the chain\./);
  assert.match(env, /Left unset, the page reads through the visitor's wallet, by block number/);
  // and it is so: only a provider made for the read address is asked by hash
  assert.match(read('../src/chain/snapshot.js'), /const selector = SITE_READERS\.has\(provider\) \? \{ blockHash, requireCanonical: true \} : quantity\(block\);/);
});
