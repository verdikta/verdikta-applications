// Tester bounty 400 (Verdikta Bounties, 2026-11-21), batch 2. An outside agent committed a claim behind an open one
// and could not reveal it: claims on a listing reveal in commit order (decision D5), and no page said so. The claim
// page told the maker "the hunter may reveal it now" on a release that changed nothing for the hunter, the feed showed
// only how many claims had ever been committed, and the maker review found four gaps on the List page. Each sentence
// added for it is held here to the contract, the builder or the page that says it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { wordingProblems } from '../e2e/support/wording.js';
import { queueRows, queueView, releaseOffer, retriggerRow } from '../src/lib/claimActions.js';
import { SEVERITY_CLASSES, initialForm, notCounted } from '../src/lib/draft.js';
import { listingQueue } from '../src/lib/listingActions.js';
import { STRINGS, fill } from '../src/strings.js';

const APP = new URL('../../', import.meta.url);
const read = (...p) => fs.readFileSync(new URL(p.join('/'), APP), 'utf8');
const component = (name) => read('client', 'src', 'components', name);
const logic = read('onchain', 'contracts', 'libraries', 'ClaimLogic.sol');
const rules = read('onchain', 'contracts', 'libraries', 'ClaimRules.sol');
const lens = read('onchain', 'contracts', 'StakeAttestationLens.sol');
/** One function of a contract source, by name, to its closing brace at the function's indent. */
const fn = (source, name) => {
  const m = new RegExp(`\\n {4}function ${name}\\([\\s\\S]*?\\n {4}\\}`).exec(source);
  assert.ok(m, `function ${name}`);
  return m[0];
};

const NOW = 1_800_000_000n;
const DAY = 86400n;

const HOUR = 3600n;
// a disclosed claim 3 behind claim 2, its disclose window long over, as the page reads it
const BASE = { claimId: 3n, state: 'Committed', disclosedAt: NOW - 100n, headClaim: 2n, discloseDeadline: NOW - 50n, revealDeadline: 0n, now: NOW };

test('queueView: a claim still to be revealed waits for the listing\'s head claim, and only the head has a reveal deadline', () => {
  const waits = { waitsFor: 2n, disclosed: true, undisclosedOver: false, deadline: null };
  // behind claim 2: no deadline, in its fix window and after it, released or not (the lens's Revealable)
  assert.deepEqual(queueView(BASE), waits);
  assert.deepEqual(queueView({ ...BASE, state: 'Revealable' }), waits);
  // first, fix window open: the deadline is the latest it can be
  assert.deepEqual(queueView({ ...BASE, headClaim: 3n, revealDeadline: NOW + 21n * DAY }), { ...waits, waitsFor: null, deadline: { at: NOW + 21n * DAY, firm: false, over: false } });
  // first, fix window over: firm, then over from the deadline itself (expire's `>=`, reveal's `<`)
  const head = { ...BASE, headClaim: 3n, state: 'Revealable', revealDeadline: NOW + 7n * DAY };
  assert.deepEqual(queueView(head).deadline, { at: NOW + 7n * DAY, firm: true, over: false });
  assert.equal(queueView({ ...head, now: NOW + 7n * DAY - 1n }).deadline.over, false);
  assert.equal(queueView({ ...head, now: NOW + 7n * DAY }).deadline.over, true);
  // undisclosed, inside its disclose window: its place is known, its deadline is not
  const fresh = { ...BASE, disclosedAt: 0n, discloseDeadline: NOW + HOUR };
  assert.deepEqual(queueView(fresh), { waitsFor: 2n, disclosed: false, undisclosedOver: false, deadline: null });
  assert.equal(queueView({ ...fresh, headClaim: 3n }).waitsFor, null);
  // undisclosed, from the disclose deadline on (disclose's `<`, expire's `>=`): it can never be revealed
  assert.equal(queueView({ ...fresh, now: NOW + HOUR - 1n }).undisclosedOver, false);
  assert.equal(queueView({ ...fresh, now: NOW + HOUR }).undisclosedOver, true);
  assert.equal(queueView({ ...fresh, headClaim: 3n, now: NOW + HOUR }).undisclosedOver, true, 'first or not');
  // a claim that was revealed, or is settled or expired: nothing to say of its reveal
  for (const state of ['Revealed', 'RoundFailed', 'Judged', 'Disputed', 'Settled', 'Expired']) assert.equal(queueView({ ...BASE, state }), null, state);
});

test('queueRows: which sentence the claim page says in each state, and that it names the head claim', () => {
  const rows = (o, rollable = true) => queueRows(queueView({ ...BASE, ...o }), { rollable });
  const C = STRINGS.claim;
  // three claims open, this one last: it is told the head, and that every claim between counts too
  assert.deepEqual(rows({ claimId: 4n }), { order: { key: 'queueWaits', head: 2n }, reveal: { key: 'revealUnset' } });
  assert.match(fill(C.queueWaits, { head: 2 }), /only once claim 2, and any claim between the two, is settled or expired$/);
  assert.deepEqual(rows({ state: 'Revealable' }), { order: { key: 'queueWaits', head: 2n }, reveal: { key: 'revealUnset' } }, 'a release changes neither row');
  // first on its listing: the deadline's three wordings, and the one for a listing that can no longer roll forward
  const first = { headClaim: 3n, revealDeadline: NOW + 7n * DAY };
  assert.deepEqual(rows(first), { order: { key: 'queueFirst' }, reveal: { key: 'revealLatest', at: NOW + 7n * DAY } });
  assert.deepEqual(rows(first, false).reveal, { key: 'revealLatestRelease', at: NOW + 7n * DAY });
  assert.deepEqual(rows({ ...first, state: 'Revealable' }).reveal, { key: 'revealFirm', at: NOW + 7n * DAY });
  assert.deepEqual(rows({ ...first, state: 'Revealable' }, false).reveal, { key: 'revealFirm', at: NOW + 7n * DAY });
  assert.deepEqual(rows({ ...first, state: 'Revealable', now: NOW + 7n * DAY }).reveal, { key: 'revealOver', at: NOW + 7n * DAY });
  // undisclosed: its place and no deadline row, until its disclose window is over
  assert.deepEqual(rows({ disclosedAt: 0n, discloseDeadline: NOW + HOUR }), { order: { key: 'queueWaits', head: 2n }, reveal: null });
  assert.deepEqual(rows({ disclosedAt: 0n, discloseDeadline: NOW }), { order: { key: 'queueUndisclosedOver' }, reveal: null });
  assert.deepEqual(rows({ disclosedAt: 0n, discloseDeadline: NOW, headClaim: 3n }), { order: { key: 'queueUndisclosedOver' }, reveal: null });
  // revealed or beyond: no row
  assert.deepEqual(queueRows(null, { rollable: true }), { order: null, reveal: null });
  // every key is a sentence of the page, and the roll-forward is named only where one can happen
  for (const key of ['queueFirst', 'queueWaits', 'queueUndisclosedOver', 'revealUnset', 'revealFirm', 'revealLatest', 'revealLatestRelease', 'revealOver']) assert.equal(typeof C[key], 'string', key);
  assert.match(C.revealLatest, /a release or a roll-forward ends the fix window sooner/);
  assert.match(C.revealLatestRelease, /a release ends the fix window sooner/);
  assert.doesNotMatch(C.revealLatestRelease, /roll/);
  assert.match(read('onchain', 'contracts', 'StakeAttestation.sol'), /require\(l\.state == ListingState\.Open \|\| l\.state == ListingState\.Depleted, "not rollable"\);/);
  assert.match(component('ClaimPage.jsx'), /const ROLLABLE = new Set\(\['Open', 'Depleted'\]\);/);
  assert.match(component('ClaimPage.jsx'), /queueRows\(q, \{ rollable: ROLLABLE\.has\(LISTING_STATES\[Number\(d\.listing\.state\)\]\) \}\)/);
  // Node P42: a listing on hold stays Open or Depleted (hold writes no state), and rollForward takes it as any other,
  // so a claim on it gets the wording that names the roll-forward. A late claim taken there is disclosed before any
  // roll, so the roll ends its fix window too; one disclosed after the roll keeps a window of its own.
  const hold = fn(logic, 'hold');
  assert.match(hold, /require\(s == StakeAttestation\.ListingState\.Open \|\| s == StakeAttestation\.ListingState\.Depleted, "not rollable"\);/);
  assert.doesNotMatch(hold.replace(/\/\/.*$/gm, ''), /l\.state = /);
  assert.doesNotMatch(fn(read('onchain', 'contracts', 'StakeAttestation.sol'), 'rollForward').replace(/\/\/.*$/gm, ''), /_heldAt/);
  assert.match(fn(logic, 'disclose'), /if \(l\.rolledAt != 0\) c\.disclosedAfterRoll = true;/);
  assert.doesNotMatch(fn(rules, 'revealableAt'), /late/, 'the roll ends a late claim\'s window as any other\'s');
  // so the first claim on a listing on hold, late or not, with its fix window open: the wording that names the roll
  assert.deepEqual(rows(first).reveal, { key: 'revealLatest', at: NOW + 7n * DAY });
});

test('a claim whose round ended with no verdict keeps its place until the re-trigger window ends, then anyone may expire it', () => {
  assert.equal(retriggerRow({ state: 'RoundFailed', retriggerDeadline: NOW + DAY, now: NOW }).key, 'retriggerUntil');
  assert.deepEqual(retriggerRow({ state: 'RoundFailed', retriggerDeadline: NOW, now: NOW }), { key: 'retriggerOver', at: NOW }, 'retrigger\'s `<`, expire\'s `>=`');
  // the lens answers a retriggerDeadline for a judged appeal too: that row is the appeal's, not this one
  for (const state of ['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired']) assert.equal(retriggerRow({ state, retriggerDeadline: NOW + DAY, now: NOW }), null, state);
  assert.equal(retriggerRow({ state: 'RoundFailed', retriggerDeadline: 0n, now: NOW }), null);
  assert.match(fn(lens, 'retriggerDeadline'), /if \(c\.state == StakeAttestation\.ClaimState\.RoundFailed\) return ClaimRules\.retriggerDeadline\(c\.failedAt, window\);/);
  assert.match(fn(logic, 'retrigger'), /require\(block\.timestamp < ClaimRules\.retriggerDeadline\(c\.failedAt, l\.revealWindow\), "retrigger window over"\);/);
  assert.match(fn(logic, 'expire'), /if \(c\.state == StakeAttestation\.ClaimState\.RoundFailed\) \{[\s\S]*?block\.timestamp >= ClaimRules\.retriggerDeadline\(c\.failedAt, l\.revealWindow\), "retrigger window open"/);
  assert.equal(fill(STRINGS.claim.retriggerOver, { time: 'T' }), 'the time to send the round again ended at T: anyone may expire the claim, which takes it out of commit order');
  assert.match(component('ClaimPage.jsx'), /retriggerRow\(\{ state: d\.state, retriggerDeadline: d\.safeguards\.retriggerDeadline, now: d\.now \}\)/);
});

test('the queue rule is the contract\'s: reveal and expire need the head, the lens dates only the head, and release ends the fix window alone', () => {
  const deadline = fn(logic, 'revealDeadline');
  assert.match(deadline, /require\(block\.timestamp >= revealable, "fix window open"\);\s*require\(l\.headClaim == claimId, "earlier claim unresolved"\);/);
  assert.match(fn(logic, 'reveal'), /require\(block\.timestamp < revealDeadline\(c, l, claimId\), "reveal window over"\);/, 'no reveal from the deadline on');
  assert.match(fn(lens, 'claimTimes'), /if \(l\.headClaim == claimId\) \{\s*revealDeadline = ClaimRules\.revealDeadline\(revealableAt, l\.headSince, l\.revealWindow\);/);
  assert.match(fn(rules, 'revealDeadline'), /return \(revealable > headSince \? revealable : headSince\) \+ revealWindow;/, 'the later of the fix window\'s end and becoming first, plus the reveal window');
  // release: the maker's, and it moves the fix window's end to now. Nothing in it touches the queue.
  const release = fn(logic, 'release');
  assert.match(release, /c\.released = true;\s*c\.fixWindowEnd = uint64\(block\.timestamp\);/);
  assert.doesNotMatch(release, /headClaim|headSince|resolve\(/);
  // an unrevealed claim past its deadline: anyone may expire it, and the bond goes to the maker
  const expire = fn(logic, 'expire');
  assert.match(expire, /bondTo = l\.maker;/);
  assert.match(expire, /require\(block\.timestamp >= revealDeadline\(c, l, claimId\), "reveal window open"\);\s*why = StakeAttestation\.Expiry\.Unrevealed;/);
  assert.doesNotMatch(expire, /msg\.sender/, 'expire asks nothing of its caller');
  assert.match(expire, /resolve\(claims, c, l\);/, 'and the next claim becomes first');

  // an undisclosed claim: no disclosure from the deadline on, and its expiry asks nothing of the order (erratum E5)
  assert.match(fn(logic, 'disclose'), /require\(block\.timestamp < uint256\(c\.committedAt\) \+ ClaimRules\.DISCLOSE_WINDOW, "disclose window over"\);/);
  const undisclosed = /if \(c\.disclosedAt == 0\) \{([\s\S]*?)\} else \{/.exec(expire)[1];
  assert.match(undisclosed, /block\.timestamp >= uint256\(c\.committedAt\) \+ ClaimRules\.DISCLOSE_WINDOW, "disclose window open"/);
  assert.doesNotMatch(undisclosed, /revealDeadline|headClaim/, 'not held back by earlier claims');
  assert.match(fn(lens, 'claimTimes'), /discloseDeadline = uint256\(c\.committedAt\) \+ ClaimRules\.DISCLOSE_WINDOW;/);

  const C = STRINGS.claim;
  assert.equal(fill(C.queueWaits, { head: 2 }), 'waits for claim 2: claims on a listing reveal in the order they were committed, so this one can be revealed only once claim 2, and any claim between the two, is settled or expired');
  assert.equal(C.revealUnset, 'not set: the reveal window starts once this claim is first in commit order and its fix window is over');
  assert.equal(fill(C.revealOver, { time: 'T' }), 'T, which has passed: the hunter can no longer reveal it, and anyone may expire it. That sends its bond to the maker and makes the next claim on the listing first');
  assert.equal(C.queueUndisclosedOver, 'never disclosed, and its time to disclose is over: it can no longer be revealed, and anyone may expire it, whatever its place in commit order. That sends its bond to the maker and takes it out of the order');
  // a roll-forward ends the window of a claim disclosed before it, as the string says
  assert.match(fn(rules, 'revealableAt'), /if \(rolledAt != 0 && !disclosedAfterRoll && rolledAt < fixWindowEnd\) return rolledAt;/);
});

test('the Release panel no longer says "may reveal it now" of a claim that waits: it names the claim that comes first, before and after the release', () => {
  const R = STRINGS.release;
  assert.match(R.intro, /the hunter may reveal it now/, 'said of the first claim only');
  const waits = fill(R.introWaits, { head: 2 });
  assert.doesNotMatch(waits, /may reveal it now|revealable now/);
  assert.match(waits, /The hunter still cannot reveal it then: claims on a listing reveal in the order they were committed, and claim 2 comes first\. This one can be revealed once claim 2, and any claim between the two, is settled or expired\.$/);
  // with three claims open, settling the head makes the next one first, not this one: the line after a release says so
  assert.equal(
    fill(R.doneWaits, { tx: '0xabc', head: 2 }),
    'Released (transaction 0xabc). The fix window is over, and the claim still waits for claim 2, which is first in commit order: the hunter can reveal it once claim 2, and any claim between the two, is settled or expired.',
  );
  assert.match(/function resolve\([\s\S]*?\n {4}\}/.exec(logic)[0], /if \(prev == 0\) \{\s*l\.headClaim = next;/, 'the head passes to the next claim in order');
  assert.equal(fill(R.doneBare, { tx: '0xabc' }), 'Released (transaction 0xabc).');
  // what a release does do is said of a claim the record counts: never of a late claim
  assert.equal(R.counted, 'The record counts the claim as released.');
  for (const text of [R.intro, R.introWaits]) assert.doesNotMatch(text, /record counts/);
  assert.match(fn(logic, 'release'), /if \(!c\.late\) l\.releasedClaims \+= 1;/);
  // a claim behind another is still offered the release: it shortens nothing now, and the record counts it
  assert.equal(releaseOffer({ disclosedAt: NOW - 10n, state: 'Committed', revealableAt: NOW + 100n, now: NOW }).offer, true);

  const page = component('ClaimPage.jsx');
  assert.match(page, /headClaim: d\.listing\.headClaim,\s*discloseDeadline: d\.times\.discloseDeadline,\s*revealDeadline: d\.times\.revealDeadline,/, 'the page reads the listing\'s head and the lens\'s deadlines at the claim\'s own block');
  assert.match(page, /\{waitsFor === null \? STRINGS\.release\.intro : fill\(STRINGS\.release\.introWaits, \{ head: waitsFor \}\)\}\s*\{data\.claim\.late \? null : ` \$\{STRINGS\.release\.counted\}`\}/);
  // nothing is sent under an intro that stopped being true: the claim it waits for is read again first
  assert.match(page, /if \(!releaseOffer\(releaseArgs\(fresh\)\)\.offer \|\| waitsForOf\(claimId, fresh\) !== waitsFor\) \{\s*onData\(fresh\);\s*return setError\(C\.changed\);/);
  // after the release: "revealable now" only of a claim that waits for none, and nothing of one already revealed
  assert.match(page, /if \(!q\) return fill\(STRINGS\.release\.doneBare, [^)]*\);\s*const head = q\.waitsFor;\s*return head === null \? fill\(STRINGS\.release\.done, [^)]*\) : fill\(STRINGS\.release\.doneWaits,/);
  assert.equal(page.split('STRINGS.release.done,').length, 2, 'the "revealable now" line is said in one place');
  assert.match(page, /rows\.order \? \{ id: 'claim-queue', label: C\.queue, value: said\(rows\.order\) \} : null,/);
  assert.match(page, /rows\.reveal \? \{ id: 'claim-reveal-before', label: C\.revealBefore, value: said\(rows\.reveal\) \} : null,/);
  assert.match(page, /href=\{`#\/claim\/\$\{rows\.order\.head\}`\}/, 'a link to the claim that comes first');
  // the roll-forward panel said every disclosed claim "is revealable at once": the roll ends fix windows, not the order
  assert.doesNotMatch(STRINGS.roll.intro, /revealable at once/);
  assert.match(STRINGS.roll.intro, /the fix window of every claim disclosed on it ends at once \(each can then be revealed in commit order\)/);
});

test('the feed and the listing page show the open claims from the contract\'s own count and head', () => {
  const feed = component('FeedPage.jsx');
  assert.match(feed, /const hasQueue = Number\.isInteger\(e\.pendingClaims\);/, 'an answer without the fields shows no row, never a guess');
  assert.match(feed, /hasQueue \? \{ id: f\('open-claims'\), label: F\.openClaims, value: String\(e\.pendingClaims\) \} : null/);
  assert.match(feed, /e\.headClaim == null \? F\.orderNone : fill\(F\.orderHead, \{ head: e\.headClaim \}\)/);
  assert.match(read('server', 'src', 'site', 'feed.js'), /pendingClaims: Number\(onchain\.pendingClaims\),\s*headClaim: onchain\.headClaim === '0' \? null : onchain\.headClaim,/);
  assert.match(fill(STRINGS.feed.orderHead, { head: 2 }), /^claim 2 is first: .* a claim committed now can be revealed only once every claim open before it is settled or expired$/);
});

test('the listing page counts every open claim, late ones among them, from the listing as the chain has it', () => {
  const listing = (o) => ({ headClaim: 0n, pendingClaims: 0n, lateClaims: 0n, lateExpired: 0n, lateOutcomeCounts: [0n, 0n, 0n, 0n, 0n, 0n], ...o });
  assert.equal(listingQueue(listing({})), null, 'no open claim');
  assert.deepEqual(listingQueue(listing({ headClaim: 2n, pendingClaims: 2n })), { head: 2n, open: 2n, late: 0n });
  // a listing that rolled forward with claim 5 still open, then took late claims 7 and 9: three are open, not one
  assert.deepEqual(listingQueue(listing({ headClaim: 5n, pendingClaims: 1n, lateClaims: 2n })), { head: 5n, open: 3n, late: 2n });
  // late claims only (the one case a Closed listing can be in)
  assert.deepEqual(listingQueue(listing({ headClaim: 7n, lateClaims: 2n })), { head: 7n, open: 2n, late: 2n });
  // Node P42: a listing on hold counts as a Rolled one does. Open on-chain, claim 5 pending from before the hold, late
  // claims 7 and 9 taken since: three are open. The count never read the state, and a hold changes none of its fields.
  assert.deepEqual(listingQueue(listing({ state: 1n, headClaim: 5n, pendingClaims: 1n, lateClaims: 2n })), { head: 5n, open: 3n, late: 2n });
  assert.deepEqual(listingQueue(listing({ state: 2n, headClaim: 7n, lateClaims: 1n })), { head: 7n, open: 1n, late: 1n }, 'Depleted and on hold, a late claim alone');
  assert.doesNotMatch(read('client', 'src', 'lib', 'listingActions.js').split('export function listingQueue')[1].split('\nexport ')[0], /state/);
  // the contract: lateClaim takes a claim on a listing its maker holds, at the tail of the same queue
  assert.match(fn(logic, 'commit'), /if \(late\) \{[\s\S]*?\|\| listingHeld,\s*"not accepting late claims"/);
  assert.match(fn(read('onchain', 'contracts', 'StakeAttestation.sol'), 'lateClaim'), /msg\.value, true, _heldAt\[listingId\] != 0/);
  assert.match(read('client', 'src', 'lib', 'listingActions.js'), /A late claim \(taken once the listing is Rolled or Closed, or while its maker has it on hold\)/);
  // a late claim that expired and one that settled DUPLICATE are no longer open
  assert.deepEqual(listingQueue(listing({ headClaim: 9n, lateClaims: 3n, lateExpired: 1n, lateOutcomeCounts: [0n, 1n, 0n, 0n, 0n, 0n] })), { head: 9n, open: 1n, late: 1n });
  // the contract: a late claim joins the queue and never pendingClaims, and leaves through exactly one of two counters
  assert.match(logic, /if \(late\) \{[\s\S]*?c\.late = true;\s*l\.lateClaims \+= 1;[\s\S]*?\} else \{\s*l\.pendingClaims \+= 1;/);
  assert.match(fn(logic, 'expire'), /if \(c\.late\) l\.lateExpired \+= 1;\s*else if /, 'every expiry of a late claim, whatever its kind');
  assert.match(fn(logic, 'settle'), /resolve\(claims, c, l\);\s*bool late = c\.late;\s*if \(late\) l\.lateOutcomeCounts\[outcome\] \+= 1;\s*else l\.outcomeCounts\[outcome\] \+= 1;/);
  assert.equal(logic.split('l.lateClaims += 1').length - 1, 1);
  assert.equal(logic.split('l.lateExpired += 1').length - 1, 1);
  assert.equal(logic.split('l.lateOutcomeCounts[outcome] += 1').length - 1, 1);
  // the page says it with these, and never "no claim" over a queue the chain already holds
  const extras = component('ListingExtras.jsx');
  assert.match(extras, /const q = listing \? listingQueue\(listing\) : null;/);
  assert.match(extras, /q\.late > 0n \? fill\(L\.openLate, \{ count: q\.open, late: q\.late \}\) : fill\(L\.open, \{ count: q\.open \}\)/);
  assert.match(extras, /else if \(!data\.claims\.length\) body = q \? null : <p>\{L\.none\}<\/p>;/);
  assert.match(extras, /<ListingClaims artifactHash=\{listing\.artifactHash\} data=\{data\} listing=\{listing\} \/>/);
  const L = STRINGS.claims;
  assert.equal(fill(L.openLate, { count: 3, late: 2 }), 'Open now, neither settled nor expired: 3, of which late claims: 2.');
  assert.equal(fill(L.order, { head: 5 }), 'Claims reveal in the order they were committed, and claim 5 is first: each later claim can be revealed only once every claim committed before it is settled or expired.');
});

test('the List page: a public repository, what a class below the lowest counted pays, what each window controls, and where an open listing is managed', () => {
  const H = STRINGS.listing.hints;
  const form = component('ListingForm.jsx');

  // C1: the builder fetches over https with no credential helper and no prompt, and refuses a URL that carries any
  assert.equal(H.repo, 'The https address of a public repository, in the form https://host/owner/name, on a git host this site reads: a listing on another host is refused. The site reads the listed commit with no credentials, and hunters clone it to work.');
  assert.match(read('shared', 'src', 'controlProof.js'), /REPO_HOST_NOT_CHECKED: 'The site does not read repositories on this host\.'/);
  assert.match(read('server', 'src', 'listing', 'request.js'), /repoUrlCheck\(draft\.repo, gitHosts\)/, 'the server refuses a host it does not read');
  const git = read('builder', 'src', 'git.js');
  assert.match(git, /GIT_TERMINAL_PROMPT: '0'/);
  assert.match(git, /'-c', 'credential\.helper=',/);
  assert.match(git, /'-c', 'protocol\.allow=never',\s*'-c', 'protocol\.https\.allow=always',/);
  assert.match(read('builder', 'src', 'spec.js'), /code: 'REPO_URL_CREDENTIALS'/);
  assert.match(read('shared', 'src', 'controlProof.js'), /REPO_URL_FORM: 'The site reads repository URLs of the form https:\/\/host\/owner\/name only/);
  assert.match(read('client', 'public', 'agents.txt'), /git clone -c core\.autocrlf=false <artifact\.repo>/, 'a hunter clones it');
  assert.match(form, /<TextField label=\{F\.repo\} [^>]*hint=\{L\.hints\.repo\}/);

  // C2: awardFor pays 0 below the lowest class counted, whatever the table holds; the form says so at each such field
  assert.match(fn(rules, 'awardFor'), /if \(outcome < LOW \|\| outcome < lowestCounted\) return 0;/);
  assert.match(H.awardNotCounted, /pays nothing, whatever is entered here/);
  assert.match(H.awards, /A valid finding below the lowest class counted is published on the record and gets its bond back, with no award\./);
  assert.match(form, /hint=\{notCounted\(c, form\.lowestClassCounted\) \? L\.hints\.awardNotCounted : null\}/);
  const below = (lowest) => SEVERITY_CLASSES.filter((c) => notCounted(c, lowest));
  assert.deepEqual(below(initialForm().lowestClassCounted), ['LOW'], 'a fresh form counts from MEDIUM, so the hint shows at LOW');
  assert.deepEqual(below('LOW'), []);
  assert.deepEqual(below('CRITICAL'), ['LOW', 'MEDIUM', 'HIGH']);

  // C3: a line for each of the four window fields, each the contract's own rule
  const W = H.windowLines;
  assert.deepEqual(Object.keys(W), ['fixWindowDays', 'disputeWindowHours', 'disclosureGraceHours', 'revealWindowDays']);
  for (const k of Object.keys(W)) assert.equal(typeof STRINGS.listing.fields[k], 'string', `${k} is a field of the form`);
  assert.match(form, /WINDOW_FIELDS\.map\(\(k\) => <li key=\{k\}>\{L\.hints\.windowLines\[k\]\}<\/li>\)/);
  assert.match(fn(logic, 'disclose'), /uint64 end = uint64\(block\.timestamp \+ l\.fixWindow\);/);
  assert.equal(W.fixWindowDays, 'Fix window: from the moment a hunter discloses a claim to you, your time to fix before the hunter may reveal it. You can release a claim sooner.');
  assert.match(fn(lens, 'disputeDeadline'), /return uint256\(c\.judgedAt\) \+ host\.getListing\(c\.listingId\)\.disputeWindow;/);
  assert.match(fn(lens, 'appealDeadline'), /return uint256\(c\.judgedAt\) \+ host\.getListing\(c\.listingId\)\.disputeWindow;/);
  // and what else waits for its end: an undisputed valid verdict's settle, anyone but the hunter settling an INVALID,
  // and the start of a confirmation round
  const settle = fn(logic, 'settle');
  assert.match(settle, /if \(outcome >= ClaimRules\.LOW && d == StakeAttestation\.DisputeResult\.None\) \{\s*require\(block\.timestamp >= uint256\(c\.judgedAt\) \+ l\.disputeWindow, "dispute window open"\);/);
  assert.match(settle, /if \(outcome == ClaimRules\.INVALID && msg\.sender != hunter\) \{[\s\S]*?if \(d == StakeAttestation\.DisputeResult\.None\) \{\s*require\(block\.timestamp >= uint256\(c\.judgedAt\) \+ l\.disputeWindow, "appeal window open"\);/);
  assert.match(fn(logic, 'confirm'), /uint256 opensAt = uint256\(c\.judgedAt\) \+ l\.disputeWindow;\s*require\(block\.timestamp >= opensAt, "dispute window open"\);/);
  assert.equal(W.disputeWindowHours, 'Dispute window: from a verdict, your time to dispute a valid one, and the hunter\'s time to appeal an INVALID. Until it ends a valid verdict you have not disputed does not pay, only the hunter can settle an INVALID that is not appealed, and no confirmation round starts.');
  const flag = fn(logic, 'flagBadDisclosure');
  assert.match(flag, /require\(msg\.sender == l\.maker, "not maker"\);/);
  assert.match(flag, /require\(block\.timestamp < disclosedAt \+ l\.disclosureGrace, "grace over"\);/);
  assert.equal(W.disclosureGraceHours, 'Disclosure grace: from a disclosure, your time to flag it as bad, when it cannot be fetched or is not the committed archive. The record shows the flag.');
  // the reveal window is also the re-trigger window, and the length of a confirmation's wait past the dispute window
  assert.match(fn(rules, 'retriggerDeadline'), /return uint256\(failedAt\) \+ revealWindow;/);
  assert.match(fn(rules, 'confirmDeadline'), /return uint256\(judgedAt\) \+ disputeWindow \+ revealWindow;/);
  assert.equal(W.revealWindowDays, 'Reveal window: once a claim may be revealed, its fix window over and every earlier claim on the listing settled or expired, the hunter\'s time to reveal it. After that anyone may expire it, and its bond goes to you. It is also the hunter\'s time to send a round again after one that ended with no verdict, and, from the end of the dispute window, how long an award that awaits a confirmation waits for one.');

  // C4: once this page saw the listing open, it points to the listing's own page, which holds what the line names
  const flow = component('ListAndFund.jsx');
  assert.match(flow, /\{!opened && <p className="hint">\{C\.fundLater\} \{fundLink\(listed\.listingId\)\}<\/p>\}/, 'the "before funding" line goes once it is funded');
  assert.match(flow, /onOpened=\{\(\) => setOpened\(true\)\}/);
  assert.match(flow, /\{opened && <p data-testid="manage-listing">\{C\.managePage\} \{fundLink\(listed\.listingId\)\}<\/p>\}/);
  assert.match(STRINGS.chain.managePage, /where its claims appear and you top up the escrow, renew, roll forward or close:$/);
  const own = component('FundPage.jsx');
  for (const part of ['<ListingMore ', '<TopUpEscrow ', '<RenewListing ', '<CloseListing ']) assert.ok(own.includes(part), `the listing's page has ${part}`);
  const more = component('ListingExtras.jsx');
  for (const part of ['<ListingClaims ', '<RollForward ']) assert.ok(more.includes(part), `the listing's page has ${part}`);
});

test('every sentence added here states what happens, with no judgement of the code', () => {
  const C = STRINGS.claim;
  const added = [
    C.queue, C.queueFirst, C.queueWaits, C.queueLink, C.queueUndisclosedOver, C.revealBefore, C.revealLatest, C.revealLatestRelease, C.revealOver, C.revealUnset,
    C.retrigger, C.retriggerUntil, C.retriggerOver,
    STRINGS.release.intro, STRINGS.release.introWaits, STRINGS.release.counted, STRINGS.release.doneWaits, STRINGS.release.doneBare, STRINGS.roll.intro,
    STRINGS.feed.openClaims, STRINGS.feed.order, STRINGS.feed.orderNone, STRINGS.feed.orderHead,
    STRINGS.claims.open, STRINGS.claims.openLate, STRINGS.claims.order, STRINGS.claims.allResolved,
    STRINGS.listing.hints.repo, STRINGS.listing.hints.awards, STRINGS.listing.hints.awardNotCounted, ...Object.values(STRINGS.listing.hints.windowLines),
    STRINGS.chain.managePage,
  ];
  for (const s of added) {
    assert.equal(typeof s, 'string');
    assert.deepEqual(wordingProblems(s), [], s);
  }
});
