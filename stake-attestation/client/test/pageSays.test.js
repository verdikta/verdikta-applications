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

    // never backward
    ['a trailing read after a later one was shown is not taken', [loaded(listing(103)), AGAIN, answered(listing(102, HELD)), SETTLED], SHOWN, 103],
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
  ]) assert.ok(rows.some(([what]) => what.startsWith(named)), `a row for: ${named}`);
});

test('every short history of a page keeps the three parts of the rule', () => {
  const start = loaded(listing(100, HELD));
  const events = [
    mined(101), mined(103), disagreed(100), disagreed(102), disagreed(104, false),
    answered(listing(99, HELD)), answered(listing(100, HELD)), answered(listing(101)), answered(listing(102, HELD)), answered(listing(104)),
    AGAIN, SETTLED,
  ];
  let histories = 0;
  const walk = (page, told, mustBeOff, depth) => {
    histories += 1;
    const says = pageSays(page);
    // part 2: off from the instant the page was told, until a read is taken
    assert.equal(says.off, mustBeOff, 'the hold\'s lines are off exactly while the page knows its read is behind');
    // while they are off the page says why: it is reading, or it names the block and offers to read again
    if (says.off) assert.equal(says.reading, says.unread === null, 'reading, or the block with Read again: one of the two');
    if (says.unread !== null) assert.equal(says.unread, told, 'the block said is the newest the page was told of');
    assert.equal(floorOf(page), Math.max(told, page.read.block), 'the floor');
    if (depth === 0) return;
    for (const event of events) {
      const next = pageAfter(page, event);
      let nextTold = told;
      let nextOff = mustBeOff;
      if (event.type === 'mined' || event.type === 'disagreed') {
        nextTold = Math.max(told, event.block);
        if (event.type === 'mined' || event.shown) nextOff = true;
      }
      if (event.type === 'read') {
        // a read that is not taken changes nothing: the record is the same one
        const taken = next !== page;
        // part 3: a read is taken exactly when it is of the floor's block or a later one, so never backward
        assert.equal(taken, event.read.block >= Math.max(told, page.read.block), 'taken only from the floor up');
        if (taken) assert.equal(next.read, event.read, 'and it is the read on display');
        // part 2: back only from a read of that block or a later one
        if (taken) nextOff = false;
      }
      assert.ok(next.read.block >= page.read.block, 'the read on display never goes back');
      walk(next, nextTold, nextOff, depth - 1);
    }
  };
  walk(pageAfter(NOTHING_READ, start), 0, false, 4);
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
  assert.equal(fill(STRINGS.fund.behind, { block: 90 }), 'This page has not read the chain at block 90 or later since a change there was sent or seen through the wallet: what it shows of the listing may be from before that change.');
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
  assert.match(component('FundPage.jsx'), /<FundListing listingId=\{BigInt\(listingId\)\} top=\{l\.awards\[3\]\} maker=\{l\.maker\} artifactHash=\{l\.artifactHash\} onMined=\{onChanged\} onOpened=\{\(\) => setOpenedHere\(true\)\} \/>/);
  const sends = (source) => source.split(/stakeAttestation\(signer\)\.[a-zA-Z]+\(/).length - 1;
  assert.equal(sends(actions) + sends(extras) + sends(funding), 7, 'and there is no other transaction on the page');
  // a refusal by the read through the wallet, where it is the listing the wallet has otherwise: handed over with that
  // read's block, never as a bare number (which would say a transaction was mined)
  assert.equal(actions.split('onChanged(disagreedAt(blockTag));').length - 1, 3, 'top-up, renew, close');
  assert.equal(actions.split('onChanged(disagreedAt(block));').length - 1, 1, 'hold');
  assert.equal(extras.split('if (!rollable) onChanged(disagreedAt(block));').length - 1, 1, 'roll forward, when it is this listing that changed');
  for (const source of [actions, extras]) assert.doesNotMatch(source, /onChanged\(\)|onChanged\(block(?:Tag)?\)/);
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
  assert.match(extras, /if \(done\) return <p data-testid="rolled" className="ok">\{fill\(RF\.done, \{ id: done\.id, tx: done\.tx \}\)\}<\/p>;\s*if \(!ROLLABLE\.has\(state\)\) return null;\s*if \(quiet\) return error \? <p className="error" role="alert">\{error\}<\/p> : null;/);
  assert.match(extras, /if \(!data \|\| quiet\) return null;/);
  assert.match(extras, /<CommitOffer data=\{data\} held=\{hold\.held\} quiet=\{quiet\} \/>/);
  assert.match(extras, /<HoldListing listingId=\{listingId\} listing=\{listing\} hold=\{hold\} quiet=\{quiet\} onChanged=\{onChanged\} \/>/);
});

test('the lines of the page\'s other actions for their own transactions are the site\'s as they were: the transaction, and what its receipt said', () => {
  const actions = component('ListingActions.jsx');
  // drawn while the action has its transaction, whatever the page reads after: never under `quiet`, never taken back
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
  assert.equal(STRINGS.withdraw.done, 'Withdrawn (transaction {tx}): {eth} ETH to {account}.');
  assert.equal(STRINGS.roll.done, 'Rolled forward to listing {id} (transaction {tx}).');
  // On the listing's own page the opening's line stays once the page has read the listing as open: `openedHere` keeps
  // the form's place for it. It stands in for nothing: the state on the page is the read's.
  const page = component('FundPage.jsx');
  assert.match(page, /\{\(state === 'Listed' \|\| openedHere\) && <FundListing /);
  assert.equal(page.split(/\bopenedHere\b/).length - 1, 2, 'declared, and used to keep the line: nowhere near the state');
  assert.doesNotMatch(page, /openedHere \? 'Open'/);
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
  assert.match(rule, /No read of an earlier block is taken after a later one was shown, or after the page was told of a later one/);
  assert.match(rule, /Against a contract with no hold there is no line of a hold to take off, and nothing is/);
  const own = between('**The page\'s own transactions**', '**One read is one block, and a block is its hash, never its number**');
  assert.match(own, /it is not checked against a later read and not taken back/);
  // the owner's assumption (2026-11-24), what the page holds all the same, and for which reads
  const reads = between('**The page reads; it does not watch.**', '**How the page knows.**');
  assert.match(reads, /the nodes behind one address are taken to agree on the chain \(owner decision, 2026-11-24\)/);
  assert.match(reads, /where a read address is configured \(`VITE_SA_RPC_URL`\): a hold's state and its next step, as the page shows them, come from one read tied to one block's hash, and a node without that block refuses the read/);
  assert.match(reads, /A wallet's node is asked by the block's number, so none of that is held for it/);
  assert.match(reads, /stand on the assumption alone, that the nodes behind the wallet's address agree on the chain/);
  const config = between('**Config** is Vite\'s build environment', '**Wording.**');
  assert.match(config, /The nodes behind the address are taken to agree on the chain/);
  assert.match(config, /Without a read address the page's reads go through the visitor's wallet, by block number, and what they show of a hold is not tied to a block's hash/);
  const env = read('../../deploy/client.env');
  assert.match(env, /# The nodes behind the address are taken to agree on the chain\./);
  assert.match(env, /Left unset, the page reads through the visitor's wallet, by block number/);
  // and it is so: only a provider made for the read address is asked by hash
  assert.match(read('../src/chain/snapshot.js'), /const selector = SITE_READERS\.has\(provider\) \? \{ blockHash, requireCanonical: true \} : quantity\(block\);/);
});
