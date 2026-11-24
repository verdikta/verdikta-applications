// Node P42: the maker's hold on a listing's page (StakeAttestation.hold, node P39). A hold stops new commits on a
// listing at once, before the fix it rolls forward to is public; it leaves every pending claim alone, and it has no
// resume. What the page says of it is held here to the contract's source, statement by statement, and the reader of
// the contract's heldAt view is held to the one rule that keeps the site true against a contract deployed before the
// hold: a call the contract REFUSES means "no hold here", and a call that fails any other way is a failed read, never
// "not on hold".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Contract, Interface, JsonRpcApiProvider, Network } from 'ethers';

import { wordingProblems } from '../e2e/support/wording.js';
import { LISTING_STATES, STAKE_ATTESTATION_ABI } from '../src/chain/abi.js';
import { NO_HOLD, holdTerms, holdView, readHold, refusedByContract } from '../src/lib/hold.js';
import { sameListing } from '../src/lib/listingActions.js';
import { SAYS_NOTHING, afterRead, asKept, contradictedAt, hasHashAt, hashAt, isContradiction, isKept, kept, keptBlocks, pageSays, receiptStands, receiptVerdict, refreshHeights } from '../src/lib/seenMined.js';
import { STRINGS, fill } from '../src/strings.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const SOURCE = read('../../onchain/contracts/StakeAttestation.sol');
const LOGIC = read('../../onchain/contracts/libraries/ClaimLogic.sol');
const LENS = read('../../onchain/contracts/StakeAttestationLens.sol');
/** One function of a contract source, by name, to its closing brace at the function's indent. */
const fn = (source, name) => {
  const m = new RegExp(`\\n {4}function ${name}\\([\\s\\S]*?\\n {4}\\}`).exec(source);
  assert.ok(m, `function ${name}`);
  return m[0];
};
/** The source with its comments taken out: what the contract does, not what it says it does. */
const code = (source) => source.replace(/\/\/.*$/gm, '');
const component = (name) => read(`../src/components/${name}`);

const ADDRESS = '0x00000000000000000000000000000000000000aa';
const HELD_AT = 1_800_000_123n;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;

/**
 * A node that answers each eth_call with `answer(payload)`: { result } or { error }, as a JSON-RPC node does, or a
 * throw, as a connection that fails does. Everything between it and the reader is ethers' own: the request it
 * builds, and the error it makes of what the node said.
 */
class StubNode extends JsonRpcApiProvider {
  constructor(answer) {
    super(31337, { staticNetwork: Network.from(31337), batchMaxCount: 1, cacheTimeout: -1 });
    this.answer = answer;
    this.calls = [];
    this._start();
  }

  async _send(payload) {
    const list = Array.isArray(payload) ? payload : [payload];
    return Promise.all(list.map(async (p) => {
      this.calls.push(p);
      return { jsonrpc: '2.0', id: p.id, ...(await this.answer(p)) };
    }));
  }
}
async function withNode(answer, run) {
  const node = new StubNode(answer);
  try {
    return await run(new Contract(ADDRESS, STAKE_ATTESTATION_ABI, node), node);
  } finally {
    node.destroy();
  }
}

// What nodes say of a call to a function the contract does not have. StakeAttestation hands a selector it does not
// implement to its lens, whose own fallback reverts with Error("unknown function"): that is what a contract deployed
// before the hold answers for heldAt, and what the first two shapes carry. The others are a contract with no fallback
// at all (the EVM reverts with no data) and the ways nodes and wallets word a revert.
const UNKNOWN_FUNCTION = new Interface(['error Error(string)']).encodeErrorResult('Error', ['unknown function']);
const LOCAL_UNKNOWN_FUNCTION = "Error: VM Exception while processing transaction: reverted with reason string 'unknown function'";
const NO_SUCH_FUNCTION = "Error: Transaction reverted: function selector was not recognized and there's no fallback function";
const REFUSALS = Object.freeze({
  // the deployed contract that has no hold, asked over a public node (measured 2026-11-24): the lens's revert, as data
  'the deployed contract with no hold, over a public node': { code: 3, message: 'execution reverted: unknown function', data: UNKNOWN_FUNCTION },
  // the same refusal as the local development node words it (the Playwright stack's, measured)
  'the same refusal on the local development node': { code: -32603, message: LOCAL_UNKNOWN_FUNCTION, data: { message: LOCAL_UNKNOWN_FUNCTION, data: UNKNOWN_FUNCTION } },
  // a contract with no fallback, on the local development node
  'a development node, no fallback': { code: -32603, message: NO_SUCH_FUNCTION, data: { message: NO_SUCH_FUNCTION, data: '0x' } },
  'a node that returns the empty revert data': { code: 3, message: 'execution reverted', data: '0x' },
  'a node that returns no data for an empty revert': { code: -32000, message: 'execution reverted' },
  'a wallet that wraps its node\'s answer': { code: -32603, message: 'Internal JSON-RPC error.', data: { code: -32000, message: 'execution reverted' } },
  'a node that says it in its data, in words': { code: -32015, message: 'VM execution error.', data: 'Reverted 0x' },
  'a revert with a reason': { code: 3, message: 'execution reverted: no such view', data: '0x08c379a0' + '0'.repeat(62) + '20' + '0'.repeat(62) + '0c' + Buffer.from('no such view').toString('hex').padEnd(64, '0') },
});
// What is not a refusal: the node, or the way to it, failed. ethers reports every JSON-RPC error on an eth_call as
// CALL_EXCEPTION, so the code alone does not tell these from the refusals above.
const FAILURES = Object.freeze({
  'a rate limit': { code: -32005, message: 'rate limit exceeded' },
  'a block the node does not have': { code: -32000, message: 'header not found' },
  'a block tag it refuses': { code: -32000, message: 'Received invalid block tag 99999999. Latest block number is 5', data: { message: 'Received invalid block tag 99999999. Latest block number is 5', data: null } },
  'an internal error': { code: -32603, message: 'Internal error' },
  'a state it has pruned': { code: -32000, message: 'missing trie node 0f (path ) state is not available' },
});

test('the contract has the view the page reads, and it never reverts there: 0 for no hold, the time while the listing is on hold', () => {
  const view = fn(SOURCE, 'heldAt');
  assert.match(view, /function heldAt\(uint256 listingId\) external view returns \(uint64\)/);
  // no require and no _mustListing: an id that is no listing answers 0 too
  assert.doesNotMatch(code(view), /require\(|_mustListing/);
  assert.match(view, /return s == ListingState\.Open \|\| s == ListingState\.Depleted \? _heldAt\[listingId\] : 0;/);
  const fragment = new Interface(STAKE_ATTESTATION_ABI).getFunction('heldAt');
  assert.equal(fragment.format('full'), 'function heldAt(uint256 listingId) view returns (uint64)');
  assert.equal(new Interface(STAKE_ATTESTATION_ABI).getFunction('hold').format('full'), 'function hold(uint256 listingId)');
  assert.equal(new Interface(STAKE_ATTESTATION_ABI).getEvent('Held').format('full'), 'event Held(uint256 indexed listingId, uint64 heldAt)');
});

test('readHold: the view\'s answer, at the block it is asked for', async () => {
  await withNode(() => ({ result: word(0) }), async (sa, node) => {
    assert.deepEqual(await readHold(sa, 7n, { blockTag: 41 }), { supported: true, heldAt: 0n });
    // one eth_call, of heldAt(7), at block 41: the block the page read the listing at
    assert.equal(node.calls.length, 1);
    assert.equal(node.calls[0].method, 'eth_call');
    assert.equal(node.calls[0].params[0].data, sa.interface.encodeFunctionData('heldAt', [7n]));
    assert.equal(node.calls[0].params[1], '0x29');
  });
  await withNode(() => ({ result: word(HELD_AT) }), async (sa) => {
    assert.deepEqual(await readHold(sa, '7'), { supported: true, heldAt: HELD_AT });
  });
});

test('readHold: a call the contract refuses means a contract with no hold, whatever shape the node gives the revert', async () => {
  for (const [name, error] of Object.entries(REFUSALS)) {
    await withNode(() => ({ error }), async (sa) => {
      assert.deepEqual(await readHold(sa, 7n, { blockTag: 41 }), { supported: false, heldAt: 0n }, name);
    });
  }
  // why a contract from before the hold refuses: a selector StakeAttestation does not implement goes to the lens, whose
  // fallback reverts with these words
  assert.match(SOURCE, /fallback\(\) external \{\s*\(bool ok, bytes memory ret\) = address\(this\)\.staticcall\(\s*abi\.encodeWithSelector\(this\.lensDelegate\.selector, msg\.data\)/);
  assert.match(LENS, /fallback\(\) external \{[^}]*revert\("unknown function"\);/);
  assert.equal(new Interface(['error Error(string)']).decodeErrorResult('Error', UNKNOWN_FUNCTION)[0], 'unknown function');
  assert.deepEqual(NO_HOLD, { supported: false, heldAt: 0n });
  assert.ok(Object.isFrozen(NO_HOLD));
});

test('readHold: a read that fails another way is a failed read, never "not on hold"', async () => {
  for (const [name, error] of Object.entries(FAILURES)) {
    await withNode(() => ({ error }), async (sa) => {
      await assert.rejects(readHold(sa, 7n, { blockTag: 41 }), (err) => {
        // ethers calls it a CALL_EXCEPTION all the same: the code is not what the reader goes by
        assert.equal(err.code, 'CALL_EXCEPTION', name);
        assert.equal(refusedByContract(err), false, name);
        return true;
      }, name);
    });
  }
  // the connection fails, or the wait for it ends
  for (const thrown of [new TypeError('Failed to fetch'), Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }), Object.assign(new Error('server error'), { code: 'SERVER_ERROR' })]) {
    await withNode(() => { throw thrown; }, async (sa) => {
      await assert.rejects(readHold(sa, 7n), (err) => err === thrown && refusedByContract(err) === false, thrown.message);
    });
  }
  // an address with no contract answers with no data: a site set up wrong, which every read of the page says
  await withNode(() => ({ result: '0x' }), async (sa) => {
    await assert.rejects(readHold(sa, 7n), (err) => err.code === 'BAD_DATA' && refusedByContract(err) === false);
  });
});

test('refusedByContract: only a revert the node reports, by its data or in its own words', () => {
  assert.equal(refusedByContract(null), false);
  assert.equal(refusedByContract(new Error('execution reverted')), false, 'not ethers\' CALL_EXCEPTION');
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION', data: '0x' }), true, 'the revert\'s data, empty');
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION', data: null, info: { error: { code: -32000, message: 'execution reverted' } } }), true);
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION', data: null, info: { error: { code: -32000, message: 'header not found' } } }), false);
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION', data: null }), false, 'no word from the node: not a refusal');
  assert.equal(refusedByContract({ code: 'NETWORK_ERROR', data: '0x' }), false);
});

const listing = (state, o = {}) => ({ state: BigInt(LISTING_STATES.indexOf(state)), maker: ADDRESS, pendingClaims: 0n, owedWei: 0n, ...o });

test('holdView: a listing is on hold exactly while it is Open or Depleted and the view says a time', () => {
  for (const s of LISTING_STATES) {
    const rollable = s === 'Open' || s === 'Depleted';
    assert.deepEqual(holdView(listing(s), { supported: true, heldAt: 0n }), { supported: true, heldAt: 0n, held: false }, s);
    assert.deepEqual(holdView(listing(s), { supported: true, heldAt: HELD_AT }), { supported: true, heldAt: rollable ? HELD_AT : 0n, held: rollable }, s);
    // a contract with no hold: never on hold, whatever the state
    assert.deepEqual(holdView(listing(s), NO_HOLD), { supported: false, heldAt: 0n, held: false }, s);
  }
  // A hold this page sent and saw mined (the Held event's time, its receipt's block 90), over a read by a node that
  // has not reached that block: the page does not go back to offering it.
  const seen = { heldAt: HELD_AT, block: 90 };
  assert.deepEqual(holdView(listing('Open'), { supported: true, heldAt: 0n }, seen, 89), { supported: true, heldAt: HELD_AT, held: true });
  assert.deepEqual(holdView(listing('Depleted'), { supported: true, heldAt: 0n }, seen, 89), { supported: true, heldAt: HELD_AT, held: true });
  // From the receipt's block on the read decides, and it alone. It has the hold: the chain's own time.
  assert.deepEqual(holdView(listing('Open'), { supported: true, heldAt: HELD_AT + 1n }, seen, 90), { supported: true, heldAt: HELD_AT + 1n, held: true });
  // It has none: the hold's block was dropped, and the page must not say on hold, at that block or any later one.
  for (const readBlock of [90, 91, 500]) {
    assert.deepEqual(holdView(listing('Open'), { supported: true, heldAt: 0n }, seen, readBlock), { supported: true, heldAt: 0n, held: false }, `read at ${readBlock}`);
  }
  // a read whose block is not known never lets the receipt stand in
  assert.deepEqual(holdView(listing('Open'), { supported: true, heldAt: 0n }, seen), { supported: true, heldAt: 0n, held: false });
  // and a roll forward or a close ends the hold, whatever the page saw mined
  assert.deepEqual(holdView(listing('Rolled'), { supported: true, heldAt: 0n }, seen, 89), { supported: true, heldAt: 0n, held: false });
  assert.deepEqual(holdView(listing('Closed'), { supported: true, heldAt: 0n }, seen, 89), { supported: true, heldAt: 0n, held: false });
  // as the contract's view: Open or Depleted, else 0
  assert.match(fn(SOURCE, 'heldAt'), /s == ListingState\.Open \|\| s == ListingState\.Depleted \? _heldAt\[listingId\] : 0/);
});

test('holdTerms: the hold is taken once, on an Open or a Depleted listing, as ClaimLogic.hold requires', () => {
  const hold = fn(LOGIC, 'hold');
  assert.match(hold, /require\(msg\.sender == l\.maker, "not maker"\);/);
  assert.match(hold, /require\(s == StakeAttestation\.ListingState\.Open \|\| s == StakeAttestation\.ListingState\.Depleted, "not rollable"\);/);
  assert.match(hold, /require\(heldAt\[listingId\] == 0, "already held"\);/);
  assert.match(fn(SOURCE, 'hold'), /ClaimLogic\.hold\(_mustListing\(listingId\), _heldAt, listingId\);/);
  const on = { supported: true, heldAt: 0n };
  for (const s of LISTING_STATES) {
    const rollable = s === 'Open' || s === 'Depleted';
    assert.deepEqual(holdTerms(listing(s), on), { can: rollable, why: rollable ? null : 'state' }, s);
    // a contract with no hold offers none, whatever the state
    assert.deepEqual(holdTerms(listing(s), NO_HOLD), { can: false, why: 'unsupported' }, s);
  }
  assert.deepEqual(holdTerms(listing('Open'), { supported: true, heldAt: HELD_AT }), { can: false, why: 'held' });
  assert.deepEqual(holdTerms(listing('Depleted'), { supported: true, heldAt: HELD_AT }), { can: false, why: 'held' });
  // pending claims and an owed award hold back a close, never a hold
  assert.deepEqual(holdTerms(listing('Open', { pendingClaims: 3n, owedWei: 5n }), on), { can: true, why: null });
  assert.doesNotMatch(code(hold), /pendingClaims|owedWei|escrowWei|fundedUntil/);
});

// ---------------------------------------------------------------- the warning's three statements
const H = STRINGS.hold;
const WARNING = ['stops', 'pending', 'oneWay'];
const oneLine = (at, text) => {
  assert.equal(typeof text, 'string', at);
  assert.ok(text.length > 0, at);
  assert.doesNotMatch(text, /[\n\r\t]/, at);
  assert.equal(text, text.trim(), at);
  assert.doesNotMatch(text, / {2}/, at);
};

test('the warning has three statements, each one line of page text that takes no value', () => {
  assert.deepEqual(Object.keys(H.warning ?? {}), WARNING);
  for (const k of WARNING) {
    oneLine(`STRINGS.hold.warning.${k}`, H.warning[k]);
    assert.doesNotMatch(H.warning[k], /[{}]/, `${k} takes no value`);
    assert.deepEqual(wordingProblems(H.warning[k]), [], k);
  }
});

test('statement 1: it stops new claims at once. From the hold\'s block, commit is refused, and nothing delays it', () => {
  assert.match(H.warning.stops, /^A hold stops new claims at once: /);
  assert.match(H.warning.stops, /this listing takes no commit\.$/);
  // commit() takes a claim only while acceptsCommits, whose fourth condition is that the maker has not held the listing
  assert.match(fn(SOURCE, 'commit'), /require\(acceptsCommits\(listingId\), "not accepting commits"\);/);
  assert.match(fn(SOURCE, 'acceptsCommits'), /return l\.state == ListingState\.Open\s*&& block\.timestamp < l\.fundedUntil\s*&& l\.escrowWei >= l\.awards\[3\]\s*&& _heldAt\[listingId\] == 0;/);
  // at once: hold writes the time of its own block, and no other time, delay or window is in it
  const hold = fn(LOGIC, 'hold');
  assert.match(hold, /heldAt\[listingId\] = uint64\(block\.timestamp\);\s*emit StakeAttestation\.Held\(listingId, uint64\(block\.timestamp\)\);/);
  assert.doesNotMatch(code(hold), /\+|Window|DELAY|delay/);
});

test('statement 2: it does not touch pending claims. hold writes its own time and nothing else, and no claim\'s path reads it', () => {
  assert.match(H.warning.pending, /^It does not touch pending claims: /);
  for (const kept of ['its fix window', 'its place in commit order', 'its judging', 'its dispute or appeal', 'its award from this listing\'s escrow']) assert.ok(H.warning.pending.includes(kept), kept);
  // the whole of hold: three requires, one write (its own mapping), one event. No claim, no listing field.
  const hold = code(fn(LOGIC, 'hold'));
  const statements = hold.slice(hold.indexOf('{') + 1, hold.lastIndexOf('}')).split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 6, statements.join(' | '));
  assert.equal(statements.filter((s) => s.startsWith('require(')).length, 3);
  assert.equal(statements.filter((s) => /=[^=]/.test(s) && !s.startsWith('require(')).map((s) => s.split('=')[0].trim()).join(), 'StakeAttestation.ListingState s,heldAt[listingId]');
  assert.doesNotMatch(hold, /claims\[|\bl\.\w+\s*(\+|-)?=[^=]/, 'no claim and no field of the listing is written');
  // who reads the hold: acceptsCommits (a new commit), the heldAt view, and lateClaim (which a hold opens). Nothing
  // else in the contract or in the claim library's other functions: reveal, finalize, dispute, appeal, settle, expire.
  const readers = [...code(SOURCE).matchAll(/_heldAt\b/g)].length;
  assert.equal(readers, 5, 'the declaration, hold, lateClaim, acceptsCommits and heldAt');
  for (const name of ['hold', 'lateClaim', 'acceptsCommits', 'heldAt']) assert.match(fn(SOURCE, name), /_heldAt/, name);
  for (const name of ['disclose', 'flagBadDisclosure', 'release', 'reveal', 'retrigger', 'finalize', 'dispute', 'appeal', 'confirm', 'settle', 'expire', 'topUp']) {
    assert.doesNotMatch(code(fn(LOGIC, name)), /heldAt|listingHeld/, `ClaimLogic.${name} reads no hold`);
  }
  // the one place the library reads it: a late claim's check, which a hold opens
  assert.match(fn(LOGIC, 'commit'), /if \(late\) \{[\s\S]*?\|\| listingHeld,\s*"not accepting late claims"/);
});

test('statement 3: it cannot be undone. The time is written once and never cleared, and only a roll forward or a close ends the hold', () => {
  assert.match(H.warning.oneWay, /^It cannot be undone: /);
  assert.match(H.warning.oneWay, /no resume/);
  assert.match(H.warning.oneWay, /it ends only when this listing is rolled forward or closed\.$/);
  // written in one place, once ("already held"), and nowhere cleared
  const all = code(SOURCE) + code(LOGIC);
  assert.equal([...all.matchAll(/heldAt\[listingId\] = /g)].length, 1, 'one write of the hold\'s time');
  assert.doesNotMatch(all, /delete _?heldAt|heldAt\[[^\]]*\] = 0\b/);
  assert.match(fn(LOGIC, 'hold'), /require\(heldAt\[listingId\] == 0, "already held"\);/);
  for (const resume of ['resume', 'unhold', 'release' + 'Hold', 'endHold', 'liftHold']) assert.doesNotMatch(all, new RegExp(`function ${resume}\\(`), resume);
  // the view answers 0 once the listing is neither Open nor Depleted, and a listing leaves those two for good only by
  // rollForward (Rolled) and close (Closed)
  assert.equal([...all.matchAll(/\.state = (StakeAttestation\.)?ListingState\.Rolled;/g)].length, 1);
  assert.equal([...all.matchAll(/\.state = (StakeAttestation\.)?ListingState\.Closed;/g)].length, 1);
  assert.match(fn(SOURCE, 'rollForward'), /l\.state = ListingState\.Rolled;/);
  assert.match(fn(SOURCE, 'close'), /l\.state = ListingState\.Closed;/);
  // and both are open to a listing on hold as to any other: neither reads the hold
  assert.match(fn(SOURCE, 'rollForward'), /require\(l\.state == ListingState\.Open \|\| l\.state == ListingState\.Depleted, "not rollable"\);/);
  for (const name of ['rollForward', 'close']) assert.doesNotMatch(code(fn(SOURCE, name)), /_heldAt/, name);
});

test('the page may say a finding can still be filed as a late claim, with no award: lateClaim\'s own rule', () => {
  oneLine('STRINGS.hold.late', H.late);
  assert.match(H.late, /late claim/);
  assert.match(H.late, /judged and recorded/);
  assert.match(H.late, /no award/);
  assert.match(fn(SOURCE, 'lateClaim'), /ClaimLogic\.commit\(\s*_claims, l, verdikta, listingId, claimId, archiveHash, ciphertextSha256, msg\.value, true, _heldAt\[listingId\] != 0\s*\);/);
  assert.match(fn(LENS, 'acceptsLateClaims'), /\|\| host\.heldAt\(listingId\) != 0;/);
  // a late claim is never one of pendingClaims, and settle pays a late claim no award
  assert.match(LOGIC, /if \(late\) \{[\s\S]*?c\.late = true;\s*l\.lateClaims \+= 1;[\s\S]*?\} else \{\s*l\.pendingClaims \+= 1;/);
});

// ---------------------------------------------------------------- what the page saw mined, against what it reads
test('a hold the page saw mined stands only until a read reaches its block: then the chain decides, and a dropped hold is said', () => {
  const page = component('FundPage.jsx');
  // the page keeps the hold's receipt (its time, its block), and holdView is given the block each read is of
  assert.match(page, /const onHeld = useCallback\(\(seen\) => \{\s*const here = identity === shownIdentity\.current;\s*if \(here\) setHeldHere\(asKept\(seen\)\);\s*refresh\(here \? seen : seen\.block\);/);
  assert.match(page, /const hold = holdView\(l, current\.hold, heldHere, current\.block\);/);
  // a read of that block or later replaces the receipt for good: a later read from a node behind cannot bring it back
  assert.match(page, /setHeldHere\(\(seen\) => \(seen && got\.block >= seen\.block \? null : seen\)\);/);
  // the hold's own section: its line of a mined hold shows only while the listing reads on hold; otherwise the page
  // says the hold is not on the chain, in an alert, and offers the action again
  const actions = component('ListingActions.jsx');
  const body = actions.slice(actions.indexOf('export function HoldListing('), actions.indexOf('\n}\n', actions.indexOf('export function HoldListing(')));
  assert.match(body, /const \[done, setDone, mine\] = useSeenMined\(read, \(d\) => hold\.held && hold\.heldAt === BigInt\(d\.heldAt\)\);/);
  assert.match(body, /if \(hold\.held\) \{[\s\S]*?body = \(\s*<>\s*\{mine/);
  assert.doesNotMatch(body, /if \(done \|\| /, 'a mined hold alone never draws the listing as on hold');
  // one answer for when the hold began: the time the page states (the chain's, once a read has it), in the section as
  // in the summary. The receipt's transaction is named with it only while the hold read is that receipt's.
  assert.match(body, /\{mine\s*\? <p className="ok" data-testid="held">\{fill\(H\.done, \{ id: listingId, time: formatTime\(hold\.heldAt\), tx: done\.tx \}\)\}<\/p>\s*: <p data-testid="hold-since">\{fill\(H\.since, \{ time: formatTime\(hold\.heldAt\) \}\)\}<\/p>\}/);
  assert.doesNotMatch(body, /formatTime\(done\.heldAt\)/, 'the receipt\'s time is never drawn beside the chain\'s');
  assert.match(body, /\{done\?\.dropped && <p className="error" role="alert" data-testid="hold-dropped">\{fill\(H\.dropped, \{ tx: done\.tx \}\)\}<\/p>\}/);
  // it says the hold is not there, and nothing of whether the listing takes claims: a depleted or lapsed one takes
  // none, hold or no hold, and the commit offer's own line says which
  assert.match(H.dropped, /is not on the chain as this page now reads it: this listing is not on hold\. Do not publish/);
  assert.doesNotMatch(H.dropped, /takes claims|takes commits/);
  assert.match(H.dropped, /Do not publish a fix on the strength of it/);
});

test('after a transaction the page reads from the block it was mined in, and says so when no read reached it', () => {
  const page = component('FundPage.jsx');
  // the newest block any action named is kept for the page's life: a later refresh that names none (or an earlier
  // one) still reads from it, so it can neither take a read from before a mined roll nor clear the warning of one
  assert.match(page, /const needed = useRef\(0\);/);
  assert.match(page, /const minBlock = typeof told === 'number' \? told : told\.block;[\s\S]*?needed\.current = Math\.max\(needed\.current, minBlock\);\s*const from = needed\.current;/);
  assert.match(page, /readFrom\(\(\) => readListing\(listingId, heights\(\)\), Math\.max\(from, shownRead\.current\?\.block \?\? 0\), \{ live: wanted, onRead: show, complete: checked \}\)\.then\(\(\) => \{\s*if \(wanted\(\)\) setReading\(false\);\s*\}\);/);
  assert.doesNotMatch(page, /readFrom\([^)]*minBlock/, 'never from the one refresh\'s own block alone');
  // a read of that block or a later one is shown at once, whatever it could not check of the receipts
  assert.match(page, /const show = \(got\) => \{[\s\S]*?setLoaded\(got\.missing && lastListing\.current !== null \? \{ \.\.\.got, gone: true \} : got\);/);
  // what the page then says (the block it has not read) is drawn from what is on it: lib/seenMined.js pageSays
  assert.match(page, /const \{ behind, unchecked \} = says;/);
  // the page is keyed by its listing (App.jsx), so the kept block is one listing's
  assert.match(read('../src/App.jsx'), /<FundPage key=\{r\.listingId \?\? 'none'\} listingId=\{r\.listingId\} \/>/);
  assert.match(page, /\{failed === null && behind !== null && \(\s*<>\s*<p className="warning" role="status" data-testid="listing-behind">\{fill\(F\.behind, \{ block: behind \}\)\}<\/p>\s*<button type="button" className="secondary" data-testid="listing-read-again" onClick=\{\(\) => refresh\(behind\)\}>\{F\.retry\}<\/button>/);
  assert.equal(fill(STRINGS.fund.behind, { block: 90 }), 'This page has not read the chain as of block 90 yet, which the wallet\'s node has reached: what it shows of the listing may be from before the last change sent or seen through the wallet.');
  // every action of the page hands the refresh its receipt's block: the hold, the roll, the close, the top-up, the renewal, the opening
  const actions = component('ListingActions.jsx');
  assert.equal(actions.split('onChanged(seen);').length - 1, 4, 'top-up, renew, close, withdraw: the receipt the page keeps, which it reads from');
  assert.equal(actions.split('onChanged(receipt.blockNumber);').length - 1, 1, 'a mined hold() with no Held event: nothing is kept, and the page reads from its block');
  // and an action that sends nothing because the wallet's read found the listing changed hands over that read's block
  assert.equal(actions.split('onChanged(contradictedAt(block));').length - 1, 8, 'top-up, renew, hold, close: each for a listing that changed, and for one that is another or gone');
  assert.equal(actions.split('onChanged(block);').length - 1, 0, 'a refusal is never handed over as a bare block');
  assert.doesNotMatch(actions, /onChanged\(\)/, 'no refresh without a block from an action that read one');
  assert.match(actions, /const seen = kept\(receipt, \{ heldAt: held\.args\.heldAt \}\);\s*setDone\(seen\);\s*onHeld\(seen\);/);
  const extras = component('ListingExtras.jsx');
  assert.match(extras, /const receipt = await minedReceipt\(tx\);\s*const seen = kept\(receipt, \{ id: pick \}\);\s*setDone\(seen\);\s*onChanged\(seen\);/);
  assert.match(component('FundListing.jsx'), /const receipt = await minedReceipt\(tx\);[\s\S]*?const seen = kept\(receipt, [^\n]*\n\s*setOpened\(seen\);\s*onOpened\(seen\);/);
  // a listing opened from its own page: its line stays, and the page follows the listing, so the hold is there without a reload
  assert.match(page, /const onOpened = useCallback\(\(seen\) => \{\s*const here = identity === shownIdentity\.current;\s*if \(here\) setOpenedHere\(seen\);\s*refresh\(here \? seen : seen\.block\);/);
  assert.match(page, /\{\(state === 'Listed' \|\| openedHere !== null\) && <FundListing /);
});

test('a listing that is gone as of a later block is an answer of that block: the page says so, and drops the hold it saw mined', () => {
  const page = component('FundPage.jsx');
  // the count is read at the block of the rest, and "no such listing" carries that block: readFrom takes it once it
  // reaches the block waited for, where a bare null would be tried again for ever
  assert.match(page, /const listing = await listingAt\(view, listingId\);\s*if \(listing === null\) return \{ missing: true \};/);
  assert.match(page, /return \{ \.\.\.value, block, blockHash, hashes \};/);
  assert.doesNotMatch(page, /listingCount\(/, 'the count is asked by listingAt, at the block of the rest');
  // the hold seen mined is dropped by any read of its block or later, the missing one included
  assert.match(page, /setHeldHere\(\(seen\) => \(seen && got\.block >= seen\.block \? null : seen\)\);/);
  assert.match(page, /\{loaded\.gone && <p className="error" role="alert" data-testid="listing-gone">\{fill\(F\.gone, \{ id: listingId \}\)\}<\/p>\}/);
  assert.match(STRINGS.fund.gone, /^Listing \{id\} was on this page a moment ago and is not on the chain as this page now reads it\./);
  assert.match(STRINGS.fund.gone, /Nothing sent from this page for it stands, a hold included: do not publish a fix on the strength of it\./);
  oneLine('STRINGS.fund.gone', STRINGS.fund.gone);
  assert.deepEqual(wordingProblems(STRINGS.fund.gone), []);
});

test('the opening\'s line on the listing\'s own page keeps its transaction and never says what the listing is now', () => {
  const page = component('FundPage.jsx');
  const funding = component('FundListing.jsx');
  // from the page's first read that has the opening, the line is the past-tense one, and "is open until" is the page's
  // own line, of the listing and its hold as last read: so it goes when the listing is put on hold, rolled or closed
  assert.match(page, /<FundListing listingId=\{BigInt\(listingId\)\} top=\{l\.awards\[3\]\} maker=\{l\.maker\} artifactHash=\{l\.artifactHash\} listed=\{state === 'Listed'\} stands=\{openingStands\} followed=\{state !== 'Listed'\} dropped=\{openingDropped\} onOpened=\{onOpened\} \/>/);
  assert.match(page, /\{state === 'Open' && !hold\.held && <p className="ok" data-testid="listing-open-until">\{fill\(F\.alreadyOpen, \{ id: listingId, until: formatTime\(l\.fundedUntil\) \}\)\}<\/p>\}/);
  assert.match(funding, /let text = fill\(C\.openedNoTime, \{ id: String\(listingId\), tx: opened\.tx \}\);\s*if \(followed\) text = fill\(C\.openedHere, \{ id: String\(listingId\), tx: opened\.tx \}\);\s*else if \(opened\.until\) text = fill\(C\.opened,/);
  assert.equal(fill(STRINGS.chain.openedHere, { id: 7, tx: '0xabc' }), 'This page opened listing 7 (transaction 0xabc).');
  assert.doesNotMatch(STRINGS.chain.openedHere, /is open|until/);
  // the list flow's own page has no later action under the line: there it says open, and until when, as before
  assert.match(component('ListAndFund.jsx'), /<FundListing listingId=\{listed\.listingId\} top=\{BigInt\(params\.awards\[3\]\)\} maker=\{listed\.maker\} artifactHash=\{view\.artifactHash\} onOpened=\{\(\) => setOpened\(true\)\} \/>/);
  assert.equal(fill(STRINGS.chain.opened, { id: 7, until: 'T', tx: '0xabc' }), 'Listing 7 is open until T (transaction 0xabc).');
});

test('the commit offer follows the contract: offered only while the listing takes a commit, and never once it has rolled forward or closed', () => {
  assert.match(fn(SOURCE, 'commit'), /require\(acceptsCommits\(listingId\), "not accepting commits"\);/);
  assert.equal(new Interface(STAKE_ATTESTATION_ABI).getFunction('acceptsCommits').format('full'), 'function acceptsCommits(uint256 listingId) view returns (bool)');
  const extras = component('ListingExtras.jsx');
  const offer = extras.slice(extras.indexOf('function CommitOffer('), extras.indexOf('\n}\n', extras.indexOf('function CommitOffer(')));
  assert.match(offer, /let text = O\.yes;\s*if \(held\) text = O\.held;\s*else if \(!takesCommits\) text = O\.notTaking;/);
  assert.match(offer, /data-offered=\{String\(Boolean\(data\.counted\) && !held && takesCommits\)\}/);
  assert.match(extras, /<CommitOffer data=\{data\} held=\{hold\.held\} takesCommits=\{takesCommits\} \/>/);
  assert.match(component('FundPage.jsx'), /takesCommits=\{current\.takesCommits\}/);
  assert.equal(STRINGS.offer.notTaking, 'This listing counts, and it takes no commits now, so the site does not offer it to hunters.');
  assert.match(STRINGS.offer.yes, /the site offers it to hunters\.$/);
});

test('a successor is never a listing on hold: the picker leaves it out, the read before sending refuses it, and the panel looks again when asked', () => {
  // the contract would take it: rollForward asks for an Open listing of the maker's with no predecessor, and reads no hold
  const roll = fn(SOURCE, 'rollForward');
  assert.match(roll, /successorListingId != listingId && s\.maker == msg\.sender && s\.state == ListingState\.Open\s*&& s\.predecessor == 0,/);
  assert.doesNotMatch(code(roll), /_heldAt|acceptsCommits/);
  const extras = component('ListingExtras.jsx');
  const panel = extras.slice(extras.indexOf('export function RollForward('), extras.indexOf('/**\n * Whether the site offers a commit'));
  assert.match(panel, /const \[s, onHold\] = await Promise\.all\(\[listingAt\(view, id\), hold\.supported \? readHold\(view, id\) : NO_HOLD\]\);[\s\S]*?if \(s !== null && same\(e\.artifactHash, s\.artifactHash\) && onHold\.heldAt === 0n\s*&& confirmSuccessor\(/);
  assert.match(panel, /hold\.supported \? readHold\(view, pick\) : NO_HOLD\]\);/);
  assert.match(panel, /if \(successorHold\.heldAt !== 0n\) \{\s*setAgain\(\(n\) => n \+ 1\);\s*return setError\(fill\(RF\.successorOnHold, \{ id: pick \}\)\);\s*\}\s*const tx = await stakeAttestation\(signer\)\.rollForward\(/);
  assert.equal(fill(STRINGS.roll.successorOnHold, { id: 9 }), 'Nothing was sent: listing 9 is on hold and takes no commits, so this listing is not rolled forward to it. Choose another listing.');
  // looked for again when asked, where the contract has the hold; against one without, the panel is what it was
  assert.match(panel, /\{hold\.supported && record && !recordReading && \(!identity \|\| options !== null\) && \(\s*<button type="button" className="secondary" data-testid="roll-look-again" onClick=\{lookAgain\}/);
  // a record that did not have this listing yet (the site's mirror trailed its opening), or whose read failed, is
  // read again first; the successors are then looked for by the identity it brings
  assert.match(panel, /const lookAgain = \(\) => \{\s*setError\(null\);\s*if \(!identity\) return onRecordAgain\(\);\s*setOptions\(null\);\s*return setAgain\(\(n\) => n \+ 1\);\s*\};/);
  assert.match(extras, /export function useListingRecord\(listingId, artifactHash, opened, again = 0\) \{/);
  assert.match(extras, /\}, \[listingId, artifactHash, opened, again\]\);/);
  assert.match(extras, /const data = useListingRecord\(listingId, listing\.artifactHash, opened, again\);\s*const reading = data !== null && data\.again !== again;\s*const recordAgain = \(\) => setAgain\(\(n\) => n \+ 1\);/);
  assert.match(panel, /\}, \[listingId, listing\.maker, state, identity, hold\.supported, again\]\);/);
  assert.equal(STRINGS.roll.again, 'Look again for listings to roll to');
});

test('every action is sent for the listing the page shows: another listing under its id, or none, sends nothing and reads the page again', () => {
  // the rule
  const shown = { maker: '0xAbC0000000000000000000000000000000000001', artifactHash: `0x${'ab'.repeat(32)}` };
  assert.equal(sameListing({ maker: shown.maker.toLowerCase(), artifactHash: shown.artifactHash.toUpperCase().replace('0X', '0x') }, shown), true);
  assert.equal(sameListing({ ...shown, artifactHash: `0x${'cd'.repeat(32)}` }, shown), false, 'another artifact under the id');
  assert.equal(sameListing({ ...shown, maker: '0xAbC0000000000000000000000000000000000002' }, shown), false, 'another maker\'s');
  assert.equal(sameListing(null, shown), false, 'no listing under the id');
  // the wallet's read: the count first, at the block of the rest, since getListing reverts for an id the contract has not
  const wallet = read('../src/chain/wallet.js');
  assert.match(wallet, /export async function listingAt\(contract, listingId\) \{\s*const id = BigInt\(listingId\);\s*if \(id === 0n \|\| id > BigInt\(await contract\.listingCount\(\)\)\) return null;\s*return contract\.getListing\(id\);/);
  assert.match(fn(SOURCE, 'getListing'), /return _mustListing\(listingId\);/);
  assert.match(SOURCE, /function _mustListing\(uint256 listingId\) internal view returns \(Listing storage\) \{\s*require\(listingId != 0 && listingId <= listingCount, "bad listingId"\);/);
  // the four actions of the page, and the roll forward: each reads through listingAt and stops on sameListing
  const actions = component('ListingActions.jsx');
  assert.equal(actions.split('if (!sameListing(mine, listing)) {').length - 1, 4, 'top-up, renew, hold, close');
  assert.equal(actions.split('setError(fill(STRINGS.fund.replaced, { id: listingId }));').length - 1, 4);
  assert.doesNotMatch(actions, /\.getListing\(/, 'no read before sending reads the listing past listingAt');
  const extras = component('ListingExtras.jsx');
  const panel = extras.slice(extras.indexOf('export function RollForward('), extras.indexOf('/**\n * Whether the site offers a commit'));
  assert.match(panel, /return Promise\.all\(\[listingAt\(view, listingId\), listingAt\(view, pick\), /);
  assert.match(panel, /if \(!sameListing\(mine, listing\)\) \{\s*setError\(fill\(STRINGS\.fund\.replaced, \{ id: listingId \}\)\);\s*onChanged\(contradictedAt\(block\)\);\s*return undefined;\s*\}/);
  // and the successor is the version the picker showed under that id
  assert.match(panel, /found\.push\(\{ id: e\.listingId, commit: e\.artifact\.baseCommit, artifactHash: s\.artifactHash,/);
  assert.match(panel, /const chosen = options\.find\(\(o\) => o\.id === pick\);\s*if \(successor === null \|\| !chosen \|\| !same\(successor\.artifactHash, chosen\.artifactHash\)/);
  // this listing itself rolled or closed elsewhere (another tab): nothing is sent, and the page reads it from the
  // block the wallet saw that at, so its state, its hold and the panel follow; an invalid successor has the panel look again
  assert.match(panel, /if \(!ROLLABLE\.has\(LISTING_STATES\[Number\(mine\.state\)\]\)\) \{\s*setError\(fill\(RF\.sourceChanged, [^\n]*\n\s*onChanged\(contradictedAt\(block\)\);\s*return undefined;\s*\}/);
  assert.match(panel, /setAgain\(\(n\) => n \+ 1\);\s*return setError\(fill\(RF\.changed, \{ id: pick \}\)\);/);
  assert.equal(fill(STRINGS.roll.sourceChanged, { state: 'closed' }), 'Nothing was sent: this listing can no longer roll forward (it is closed). It has been read again.');
  assert.equal(fill(STRINGS.fund.replaced, { id: 7 }), 'Nothing was sent: on the chain as your wallet reads it now, listing 7 is not the listing this page shows, or there is no such listing. This page reads it again.');
});

// A block is its hash, never its number (the two rules of chain/snapshot.js and lib/seenMined.js).
const HASH_A = `0x${'a1'.repeat(32)}`;
const HASH_B = `0x${'b2'.repeat(32)}`;
const HASH_C = `0x${'c3'.repeat(32)}`;
const receiptAt = (block, blockHash = HASH_A) => ({ hash: '0xabc', blockNumber: block, blockHash });
/** A snapshot the page's read is of: its block, that block's hash, and the hash its chain has at other heights. */
const readOf = (block, blockHash, hashes = {}) => ({ block, blockHash, hashes });

test('a receipt is kept with its transaction and the number and hash of its block, or it is not kept', () => {
  const seen = kept(receiptAt(90, HASH_A.toUpperCase().replace('0X', '0x')), { until: 7n });
  assert.deepEqual(seen, { until: 7n, tx: '0xabc', block: 90, blockHash: HASH_A });
  assert.ok(Object.isFrozen(seen));
  assert.equal(isKept(seen), true);
  // without the block's hash, its number, or the transaction: nothing is kept, and what is said of a transaction
  // can never be less than that
  for (const receipt of [{ hash: '0xabc', blockNumber: 90 }, { hash: '0xabc', blockNumber: 90, blockHash: '0x1234' }, { hash: '0xabc', blockHash: HASH_A }, { blockNumber: 90, blockHash: HASH_A }, null, undefined]) {
    assert.throws(() => kept(receipt, {}), TypeError, JSON.stringify(receipt));
  }
  for (const not of [{ tx: '0xabc', block: 90 }, { tx: '0xabc', heldAt: 5n, block: 90, blockHash: null }, { block: 90, blockHash: HASH_A }, {}]) {
    assert.equal(isKept(not), false);
    assert.throws(() => asKept(not), TypeError);
  }
  assert.equal(asKept(null), null);
  assert.equal(asKept(seen), seen);
  // what a transaction reported never overrides where it was mined
  assert.deepEqual(kept(receiptAt(90), { tx: 'other', block: 1, blockHash: HASH_B }), { tx: '0xabc', block: 90, blockHash: HASH_A });
});

test('a kept receipt stands while the read is of an earlier block; from its block on, only while that block is the chain\'s and the read shows what it did; and never again once a read said otherwise', () => {
  const seen = kept(receiptAt(90, HASH_A));
  // the read is of a block before the receipt's, or nothing is read yet: the receipt stands, whatever the read shows
  assert.equal(receiptVerdict(seen, readOf(89, HASH_C), false), 'stands');
  assert.equal(receiptVerdict(seen, null, false), 'stands');
  // a read of the receipt's own block: that block must be the one the receipt was in, and the read must show the effect
  assert.equal(receiptVerdict(seen, readOf(90, HASH_A), true), 'stands');
  assert.equal(receiptVerdict(seen, readOf(90, HASH_A), false), 'dropped', 'its block, and the transaction\'s effect is not there');
  assert.equal(receiptVerdict(seen, readOf(90, HASH_B), true), 'dropped', 'another block at that height: the effect read is another transaction\'s');
  // a read of a later block: the chain it is of must have the receipt's block at that height
  assert.equal(receiptVerdict(seen, readOf(400, HASH_C, { 90: HASH_A }), true), 'stands');
  assert.equal(receiptVerdict(seen, readOf(400, HASH_C, { 90: HASH_A }), false), 'dropped');
  assert.equal(receiptVerdict(seen, readOf(400, HASH_C, { 90: HASH_B }), true), 'dropped', 'closed already on the chain that replaced it, with another refund');
  // a height the node gave no header for says nothing of that block: the receipt is not dropped on it, and is held
  // to the next read that has the hash
  assert.equal(receiptVerdict(seen, readOf(400, HASH_C, { 90: null }), true), 'unread');
  assert.equal(afterRead(seen, readOf(400, HASH_C, { 90: null }), true), seen, 'a header that could not be had drops nothing');
  assert.equal(receiptVerdict(afterRead(seen, readOf(400, HASH_C, { 90: null }), true), readOf(401, HASH_C, { 90: HASH_A }), true), 'stands', 'and the matching hash, when it comes, lets it stand');
  // a later read that did not ask for that height (it was made before the page kept the receipt) decides nothing:
  // the receipt neither stands nor is dropped until the read it asked for is there
  assert.equal(receiptVerdict(seen, readOf(400, HASH_C, {}), true), 'unread');
  assert.equal(receiptVerdict(seen, readOf(400, HASH_C), true), 'unread');
  assert.equal(receiptStands(seen, readOf(400, HASH_C, {}), true), false);
  assert.equal(afterRead(seen, readOf(400, HASH_C, {}), true), seen, 'and nothing is dropped by it');
  assert.equal(receiptVerdict(null, readOf(90, HASH_A), true), null, 'nothing was seen mined');
  assert.equal(receiptStands(null, readOf(90, HASH_A), true), false);
  // what a read contradicted is dropped for good: a later read that shows the same effect is another transaction's
  assert.equal(afterRead(seen, readOf(89, HASH_C), false), seen, 'a read of an earlier block drops nothing');
  assert.equal(afterRead(seen, readOf(90, HASH_A), true), seen);
  const dropped = afterRead(seen, readOf(90, HASH_B), true);
  assert.deepEqual(dropped, { tx: '0xabc', block: 90, blockHash: HASH_A, dropped: true });
  assert.equal(receiptVerdict(dropped, readOf(91, HASH_C, { 90: HASH_A }), true), 'dropped', 'not even when a later read has that very block again');
  assert.equal(receiptStands(dropped, readOf(80, HASH_C), true), false, 'nor by a later read from a node behind');
  assert.equal(afterRead(dropped, readOf(91, HASH_C, { 90: HASH_A }), true), dropped);
  assert.equal(afterRead(null, readOf(91, HASH_C), true), null);
  assert.equal(isKept(dropped), true, 'a dropped receipt is still a kept one: its alert names the transaction');
  // the hook keeps the receipt, takes nothing that is not a kept one, says whether it stands, and marks it dropped
  const hook = read('../src/components/seenMined.js');
  assert.match(hook, /const setSeen = useCallback\(\(next\) => set\(asKept\(next\)\), \[\]\);/);
  assert.match(hook, /const shown = seen !== null && !seen\.dropped && Boolean\(shows\(seen\)\);\s*const verdict = receiptVerdict\(seen, read, shown\);/);
  assert.match(hook, /useEffect\(\(\) => \{\s*const next = afterRead\(seen, read, shown\);\s*if \(next !== seen\) set\(next\);[\s\S]*?\}, \[seen, verdict\]\);[\s\S]*?return \[seen, setSeen, verdict === 'stands'\];/);
});

test('every receipt the listing\'s page speaks from is a kept one: none is made without its block\'s hash', () => {
  // The seven transactions of the page (the opening, a top-up, a renewal, the hold, a roll forward, a close, a
  // withdrawal) each keep their receipt through kept(), and hold it in useSeenMined, whose setter takes nothing else.
  const actions = component('ListingActions.jsx');
  const extras = component('ListingExtras.jsx');
  const funding = component('FundListing.jsx');
  const page = component('FundPage.jsx');
  // no line of a transaction is kept in plain state: every `done` of these components comes from the hook
  for (const [name, source] of [['ListingActions.jsx', actions], ['ListingExtras.jsx', extras]]) {
    assert.doesNotMatch(source, /const \[done, setDone\] = useState/, `${name}: a transaction's line is held by useSeenMined`);
    const sets = [...source.matchAll(/setDone\(([^\n]*)\);/g)].map((m) => m[1]);
    assert.ok(sets.length > 0, name);
    for (const arg of sets) assert.equal(arg, 'seen', `${name}: setDone(${arg})`);
    // and each `seen` is made by kept(), from the receipt, on a line of its own just before
    assert.equal(source.split('const seen = kept(receipt, ').length - 1, sets.length, `${name}: one kept receipt for each line set`);
  }
  assert.equal(actions.split('useSeenMined(read, ').length - 1, 5, 'top-up, renew, hold, close, withdraw');
  assert.equal(extras.split('useSeenMined(read, ').length - 1, 1, 'roll forward');
  assert.equal(actions.split('kept(receipt, ').length - 1, 5);
  assert.equal(extras.split('kept(receipt, ').length - 1, 1);
  // the hold's `seen` is the kept receipt, made on the line before
  assert.match(actions, /const seen = kept\(receipt, \{ heldAt: held\.args\.heldAt \}\);\s*setDone\(seen\);\s*onHeld\(seen\);/);
  // the opening: FundListing keeps the receipt and hands the same one to the page
  assert.match(funding, /const seen = kept\(receipt, \{ until: openedEvent \? openedEvent\.args\.fundedUntil : null \}\);\s*setOpened\(seen\);\s*onOpened\(seen\);/);
  assert.equal(funding.split('setOpened(').length - 1, 1, 'the opening is set in one place');
  // the page's own two: the opening goes into useSeenMined (its setter refuses anything else), the hold through asKept
  assert.match(page, /const \[openedHere, setOpenedHere, openingStands\] = useSeenMined\(/);
  for (const set of [...page.matchAll(/setOpenedHere\(([^)]*)\)/g)].map((m) => m[1])) assert.match(set, /^(?:seen|null)$/, `setOpenedHere(${set})`);
  for (const set of [...page.matchAll(/setHeldHere\(([^\n]*)\);/g)].map((m) => m[1])) {
    assert.match(set, /^(?:asKept\(seen\)|null|\(seen\) => \(seen && got\.block >= seen\.block \? null : seen\))$/, `setHeldHere(${set})`);
  }
  // nothing on the page builds a receipt by hand: no object with a block number, and no receipt's hash or block
  // number read outside kept() except to tell the page which block to read from
  for (const [name, source] of [['ListingActions.jsx', actions], ['ListingExtras.jsx', extras], ['FundListing.jsx', funding], ['FundPage.jsx', page]]) {
    assert.doesNotMatch(source, /block: receipt\.blockNumber|blockHash: receipt|tx: tx\.hash/, name);
    // the two uses left: the block the page is told to read from, and the hash in the message of a hold() that was
    // mined with no Held event, of which nothing is kept
    for (const use of [...source.matchAll(/receipt\.(blockNumber|blockHash|hash)[^\n]*/g)].map((m) => m[0])) {
      assert.equal(name, 'ListingActions.jsx', `${name}: ${use}`);
      assert.match(use, /^receipt\.blockNumber\);$|^receipt\.hash \}\)\);$/, `${name}: ${use}`);
    }
    assert.ok(source.split('tx: receipt.hash').length - 1 <= (name === 'ListingActions.jsx' ? 1 : 0), `${name}: a transaction's hash is said from its kept receipt`);
  }
  // each is said only while it stands, and its alert only once it is dropped
  assert.match(actions, /\{toppedUp && \(\s*<p className="ok" data-testid="topped-up">/);
  assert.match(actions, /\{renewedHere && \(\s*<p className="ok" data-testid="renewed">/);
  assert.match(actions, /\{withdrawn && \(\s*<p className="ok" data-testid="withdrawn">/);
  for (const id of ['top-up-dropped', 'renew-dropped', 'withdraw-dropped']) assert.ok(actions.includes(`{droppedLine(done, '${id}')}`), id);
  assert.match(actions, /const droppedLine = \(seen, testId\) => \(seen\?\.dropped\s*\? <p className="error" role="alert" data-testid=\{testId\}>\{fill\(STRINGS\.fund\.txDropped, \{ tx: seen\.tx \}\)\}<\/p>\s*: null\);/);
  // It says what the page knows: the block it saw the transaction in is not the chain's. Whether the transaction was
  // mined again in another block the page does not know, and it does not say that it was not.
  assert.equal(fill(STRINGS.fund.txDropped, { tx: '0xabc' }), 'The block this page saw transaction 0xabc mined in is not on the chain as this page now reads it. The transaction may have been mined again in another block: look it up before sending it again.');
  assert.doesNotMatch(STRINGS.fund.txDropped, /^Transaction \{tx\}[^.]* is not on the chain/, 'never that the transaction is not on the chain');
});

test('an opening, a roll, a close and a hold the page saw mined are each held to that rule, by what the read shows of them', () => {
  const page = component('FundPage.jsx');
  // the read every receipt is held against: the snapshot the listing was last read at
  assert.match(page, /const read = useMemo\(\s*\(\) => \(current\?\.blockHash \? \{ block: current\.block, blockHash: current\.blockHash, hashes: current\.hashes \} : null\),\s*\[current\],\s*\);/);
  // The opening: the read has the listing opened (openedAt set, whatever its state since). Shown as open by its
  // receipt while the read is of an earlier block; a read that says it never opened is the state shown, the opening
  // is said not to be there while the listing is still Listed, and the funding form is back. A listing closed without
  // opening is never said to have been opened here.
  assert.match(page, /const \[openedHere, setOpenedHere, openingStands\] = useSeenMined\(\s*read,\s*\(\) => !current\?\.listing \|\| BigInt\(current\.listing\.openedAt\) !== 0n,\s*kept\.current,\s*\);/);
  assert.match(page, /const openingAhead = openingStands && state === 'Listed';\s*const openingDropped = openedHere\?\.dropped === true;\s*const shown = openingAhead \? 'Open' : state;/);
  assert.match(page, /\{\(state === 'Listed' \|\| openedHere !== null\) && <FundListing [^\n]* listed=\{state === 'Listed'\} stands=\{openingStands\} followed=\{state !== 'Listed'\} dropped=\{openingDropped\} onOpened=\{onOpened\} \/>\}/);
  // openedAt is set by the opening fund() alone, and close() takes a listing that never opened
  assert.match(fn(SOURCE, 'fund'), /if \(s == ListingState\.Listed\) \{[\s\S]*?l\.state = ListingState\.Open;\s*l\.openedAt = uint64\(block\.timestamp\);/);
  assert.equal(SOURCE.split('openedAt = ').length - 1, 1, 'nowhere else in the contract');
  // FundListing draws the line while the opening stands, the form only for a listing that reads Listed, and nothing
  // for an opening whose block is not read yet or that was dropped on a listing no longer Listed
  const funding = component('FundListing.jsx');
  assert.match(funding, /if \(opened && stands\) \{/);
  assert.match(funding, /if \(!listed \|\| \(opened && !dropped\)\) return null;\s*return \(\s*<>\s*\{opened && dropped && <p className="error" role="alert" data-testid="opening-dropped">\{fill\(C\.openingDropped, \{ id: String\(listingId\), tx: opened\.tx \}\)\}<\/p>\}/);
  assert.equal(fill(STRINGS.chain.openingDropped, { id: 7, tx: '0xabc' }), 'The opening sent from this page (transaction 0xabc) is not on the chain as this page now reads it: listing 7 is listed and not funded. Look the transaction up, and fund the listing again if it is gone.');
  // The roll: the read's successor is the listing this roll named. Not "the listing is no longer Open or Depleted":
  // a listing closed, or rolled to another listing, after a roll that was dropped is not this roll's doing.
  const extras = component('ListingExtras.jsx');
  assert.match(extras, /const \[done, setDone, rolledHere\] = useSeenMined\(read, \(d\) => BigInt\(listing\.successor\) === BigInt\(d\.id\)\);/);
  assert.match(extras, /if \(rolledHere\) return <p data-testid="rolled" className="ok">[^\n]*\n\s*if \(!ROLLABLE\.has\(state\)\) return null;/);
  assert.match(extras, /\{done\?\.dropped && <p className="error" role="alert" data-testid="roll-dropped">\{fill\(RF\.dropped, \{ tx: done\.tx \}\)\}<\/p>\}/);
  assert.match(page, /<ListingMore listingId=\{listingId\} listing=\{l\} hold=\{hold\} takesCommits=\{current\.takesCommits\} read=\{read\} /);
  assert.match(fn(SOURCE, 'rollForward'), /l\.successor = successorListingId;/);
  // The close: the read says closed. A close that was dropped says nothing when the listing is closed later, by
  // another transaction or by the same one in another block: the section is not drawn, as on a visit that sent no close.
  const actions = component('ListingActions.jsx');
  assert.match(actions, /const \[done, setDone, closedHere\] = useSeenMined\(read, \(\) => terms\.why === 'closed'\);\s*if \(terms\.why === 'closed' && !closedHere\) return null;/);
  assert.match(actions, /let body;\s*if \(closedHere\) \{\s*body = \(\s*<p className="ok" data-testid="closed">/);
  assert.match(actions, /\{done\?\.dropped && <p className="error" role="alert" data-testid="close-dropped">\{fill\(C\.dropped, \{ id: listingId, tx: done\.tx \}\)\}<\/p>\}/);
  assert.match(page, /<CloseListing listingId=\{listingId\} listing=\{l\} read=\{read\} onChanged=\{refresh\} \/>/);
  assert.match(page, /<Withdraw read=\{read\} onChanged=\{refresh\} \/>/);
  // The hold: the read has a hold of the receipt's own time.
  assert.match(actions, /const \[done, setDone, mine\] = useSeenMined\(read, \(d\) => hold\.held && hold\.heldAt === BigInt\(d\.heldAt\)\);/);
  assert.match(extras, /<HoldListing listingId=\{listingId\} listing=\{listing\} hold=\{hold\} read=\{read\} onHeld=\{onHeld\} onChanged=\{onChanged\} \/>/);
  // every read of the page asks which hash its chain has at the block of each receipt the page still holds (the
  // registry, below), so none of those is left without an answer
  assert.match(page, /const \{ heights, checked \} = refreshHeights\(kept\.current, told\);/);
  assert.match(page, /readListing\(listingId, kept\.current\.blocks\(\)\)\s*\.then\(\(got\) => \{\s*if \(!live\) return;[\s\S]*?setLoaded\(got\);\s*\}\)/);
  assert.doesNotMatch(page, /keptAt/, 'no list of its own beside the registry');
  assert.match(page, /\}, \{ heights \}\);\s*return \{ \.\.\.value, block, blockHash, hashes \};/);
  oneLine('fund.contradictory', STRINGS.fund.contradictory);
  assert.deepEqual(wordingProblems(fill(STRINGS.fund.readFailed, { reason: STRINGS.fund.contradictory })), []);
  for (const [at, text] of [['roll.dropped', STRINGS.roll.dropped], ['close.dropped', STRINGS.close.dropped], ['chain.openingDropped', STRINGS.chain.openingDropped], ['fund.replaced', STRINGS.fund.replaced], ['fund.txDropped', STRINGS.fund.txDropped]]) {
    oneLine(at, text);
    assert.deepEqual(wordingProblems(text), [], at);
    assert.match(text, at === 'fund.replaced' ? /^Nothing was sent/ : /is not on the chain as this page now reads it/, at);
  }
});

test('a receipt whose block a read could not check is asked for again, and the page says so with a way to read again', () => {
  const page = component('FundPage.jsx');
  // every receipt the page keeps has a hash at its block in the read, unless that block is above the read
  assert.match(read('../src/lib/seenMined.js'), /const all = hasHashAt\(got, heights\(\)\);/);
  assert.match(read('../src/lib/seenMined.js'), /return blocks\.every\(\(height\) => height > read\.block \|\| typeof hashAt\(read, height\) === 'string'\);/);
  // The listing as that read has it is shown at once (above); the read is not the last one while a receipt is
  // unchecked: readFrom goes on, its bounded number of times, and the page then says what it could not check.
  assert.match(page, /\{ live: wanted, onRead: show, complete: checked \}/);
  assert.match(page, /const \{ behind, unchecked \} = says;/);
  assert.match(page, /\{failed === null && behind === null && unchecked && \(\s*<>\s*<p className="warning" role="status" data-testid="listing-unchecked">\{F\.unchecked\}<\/p>\s*<button type="button" className="secondary" data-testid="listing-read-again" onClick=\{again\}>\{F\.retry\}<\/button>/);
  assert.equal(STRINGS.fund.unchecked, 'This page could not check the block of a transaction sent from it: the node did not give that block. What the transaction did is not said here until the page can check it.');
  oneLine('fund.unchecked', STRINGS.fund.unchecked);
  assert.deepEqual(wordingProblems(STRINGS.fund.unchecked), []);
  // until then the receipt neither stands nor is dropped (the rule above), so nothing is said on the strength of it
  const seen = kept(receiptAt(90, HASH_A));
  assert.equal(receiptVerdict(seen, readOf(95, HASH_C, {}), true), 'unread');
});

test('a read is shown only once it has answered within its time, and never after a later one (R8-F1)', () => {
  const page = component('FundPage.jsx');
  // the page shows a read through readFrom's onRead, which readFrom calls only for a read that won its time; the read
  // function itself shows nothing, so a read that timed out and answers later has nowhere to put its answer
  const refresh = page.slice(page.indexOf('const refresh = useCallback('), page.indexOf('// The listing this page shows, by maker and artifact.'));
  assert.match(refresh, /readFrom\(\(\) => readListing\(listingId, heights\(\)\), Math\.max\(from, shownRead\.current\?\.block \?\? 0\), \{ live: wanted, onRead: show, complete: checked \}\)\.then\(\(\) => \{\s*if \(wanted\(\)\) setReading\(false\);\s*\}\);/);
  const reader = /readFrom\(\(\) => readListing\(listingId, heights\(\)\)/.exec(refresh);
  assert.ok(reader, 'the read is the snapshot alone');
  assert.equal(refresh.split('setLoaded(').length - 1, 1, 'the listing is set in one place');
  assert.ok(refresh.indexOf('const show = (got) => {') < refresh.indexOf('setLoaded(') && refresh.indexOf('setLoaded(') < refresh.indexOf('readFrom('), 'inside show, which is handed to readFrom');
  assert.doesNotMatch(refresh, /setBehind|setUnchecked/, 'what the page says is not fixed at the instant a refresh ends');
  const poll = read('../src/lib/poll.js');
  assert.match(poll, /const got = await withTimeout\(Promise\.resolve\(\)\.then\(read\), readTimeoutMs\);[\s\S]*?if \(got\.block >= floor && live\(\)\) \{\s*seen = true;\s*floor = got\.block;\s*onRead\(got\);\s*if \(complete\(got\)\) return \{ read: got, reached: true, seen \};/);
  assert.match(poll, /let floor = minBlock;/);
});

test('the page asks for the hash at the blocks of the receipts it still holds: one that was replaced, dropped or gone with its listing is asked for no more (R8-F3)', () => {
  // the registry: each holder keeps its receipt's block while it holds the receipt, and lets go of it once
  const blocks = keptBlocks();
  assert.deepEqual(blocks.blocks(), []);
  const first = blocks.keep(90);
  const again = blocks.keep(90); // the same block, held twice (the hold: its section and the page)
  const second = blocks.keep(95);
  assert.deepEqual(blocks.blocks().sort(), [90, 95]);
  first();
  first(); // letting go twice lets go once
  assert.deepEqual(blocks.blocks().sort(), [90, 95], 'still held by the other');
  again();
  assert.deepEqual(blocks.blocks(), [95], 'a block no receipt is kept at is not asked for');
  second();
  assert.deepEqual(blocks.blocks(), []);
  // the hook keeps its receipt's block while the receipt is one it could still speak from, and lets go when the
  // receipt is replaced by another, dropped for good, or the part is gone with its listing
  const hook = read('../src/components/seenMined.js');
  assert.match(hook, /const block = seen !== null && !seen\.dropped \? seen\.block : null;\s*useLayoutEffect\(\(\) => \(block === null \|\| !blocks \? undefined : blocks\.keep\(block\)\), \[block, blocks\]\);/);
  assert.match(hook, /export function useSeenMined\(read, shows, held = null\) \{/);
  assert.match(hook, /const blocks = useContext\(KeptBlocks\) \?\? held;/);
  // the page: its parts find the registry in context, its own two receipts (the opening, the hold) hold it directly,
  // and every read asks for the registry's blocks, with the block of a receipt handed to it this moment
  const page = component('FundPage.jsx');
  assert.match(page, /<KeptBlocks\.Provider value=\{kept\.current\}>/);
  assert.match(page, /useSeenMined\(\s*read,\s*\(\) => !current\?\.listing \|\| BigInt\(current\.listing\.openedAt\) !== 0n,\s*kept\.current,\s*\);/);
  assert.match(page, /useLayoutEffect\(\(\) => \(heldHere \? kept\.current\.keep\(heldHere\.block\) : undefined\), \[heldHere\]\);/);
  assert.match(page, /const \{ heights, checked \} = refreshHeights\(kept\.current, told\);/);
  assert.doesNotMatch(page, /keptAt/, 'no list that only grows');
});

test('a receipt handed to a refresh is asked for until the first read that is taken; from then on only what the page holds is (R8-F3)', () => {
  const HASH = `0x${'a'.repeat(64)}`;
  const seen = kept({ hash: '0xabc', blockNumber: 90, blockHash: HASH }, {});
  // its part holds the receipt only from its next render on, so the refresh asks for its block itself, at first
  const held = keptBlocks();
  let r = refreshHeights(held, seen);
  assert.deepEqual(r.heights(), [90]);
  // a read from before the block waited for is never held to it (readFrom does not ask whether it is complete)
  assert.deepEqual(r.heights(), [90], 'still asked for');
  // the first read that is taken could not check that block: it is not the last one
  assert.equal(r.checked({ block: 95, hashes: {} }), false);
  // By now the part holds the receipt or nothing does. Here nothing does (the page came to show another listing
  // under the id, and the receipt was not kept): the next read asks for no block, and is complete.
  assert.deepEqual(r.heights(), [], 'a receipt nothing on the page holds is asked for once, and no more');
  assert.equal(r.checked({ block: 96, hashes: {} }), true);
  // where its part did take the receipt, the registry has its block and every read goes on asking for it
  r = refreshHeights(held, seen);
  const letGo = held.keep(90);
  assert.equal(r.checked({ block: 95, hashes: {} }), false);
  assert.deepEqual(r.heights(), [90]);
  assert.equal(r.checked({ block: 96, hashes: {} }), false, 'held, and still not checked');
  assert.equal(r.checked({ block: 97, hashes: { 90: HASH } }), true);
  assert.equal(r.checked({ block: 89, hashes: {} }), true, 'a block above the read is not the read\'s to check');
  letGo();
  assert.deepEqual(r.heights(), []);
  // a refresh told only of a block (a read through the wallet, or a receipt the page did not keep) asks for the registry's alone
  r = refreshHeights(held, 90);
  assert.deepEqual(r.heights(), []);
  const other = held.keep(80);
  assert.deepEqual(refreshHeights(held, seen).heights().sort(), [80, 90]);
  other();
  // the page: a hold or an opening whose receipt it does not keep (another listing is under the id by then) is read
  // from its block, and its block is not asked for
  const page = component('FundPage.jsx');
  assert.match(page, /const onHeld = useCallback\(\(seen\) => \{\s*const here = identity === shownIdentity\.current;\s*if \(here\) setHeldHere\(asKept\(seen\)\);\s*refresh\(here \? seen : seen\.block\);/);
  assert.match(page, /const onOpened = useCallback\(\(seen\) => \{\s*const here = identity === shownIdentity\.current;\s*if \(here\) setOpenedHere\(seen\);\s*refresh\(here \? seen : seen\.block\);/);
});

test('the page never takes a read of a block before the newest one it has shown (R9-F1, R10-F2)', () => {
  const page = component('FundPage.jsx');
  // the newest read the page has shown that is of a block, on load or after, a failed one included: no later read
  // from before its block is taken, within one refresh (readFrom's floor) or in a later one (Read again)
  assert.match(page, /const shownRead = useRef\(null\);/);
  assert.match(page, /\.then\(\(got\) => \{\s*if \(!live\) return;\s*if \(Number\.isSafeInteger\(got\.block\)\) shownRead\.current = got;\s*setLoaded\(got\);\s*\}\)/);
  const refresh = page.slice(page.indexOf('const refresh = useCallback('), page.indexOf('// The listing this page shows, by maker and artifact.'));
  assert.match(refresh, /const show = \(got\) => \{\s*shownRead\.current = got;/);
  assert.match(refresh, /readFrom\(\(\) => readListing\(listingId, heights\(\)\), Math\.max\(from, shownRead\.current\?\.block \?\? 0\), \{ live: wanted, onRead: show, complete: checked \}\)\.then\(\(\) => \{\s*if \(wanted\(\)\) setReading\(false\);\s*\}\);/);
  // R10-F2: reading again goes through that refresh whenever the page has shown a read of a block, also one that
  // failed on load before any transaction: a read that contradicted itself at block 102 is not followed by the
  // listing as a trailing node has it at 101. Only a read that failed with no block at all is made afresh.
  assert.match(page, /const again = \(\) => \(needed\.current > 0 \|\| shownRead\.current !== null \? refresh\(needed\.current\) : setAttempt\(\(a\) => a \+ 1\)\);/);
  assert.equal(page.split('setAttempt(').length - 1, 1, 'the load is made afresh from one place');
});

test('what the page says is one function of what is on it when it is drawn: a row for each case of rounds 8 to 11', () => {
  const H = `0x${'b'.repeat(64)}`;
  const listingAt = (block, hashes = {}) => ({ listing: {}, block, blockHash: H, hashes });
  const failedAt = (block) => ({ failed: 'the chain answered two things of one block', block, blockHash: H, hashes: {} });
  const receipt = (block) => kept({ hash: '0xabc', blockNumber: block, blockHash: H }, {});
  const says = (hidden, behind, unchecked) => ({ hidden, behind, unchecked });
  assert.deepEqual(SAYS_NOTHING, says(null, null, false));
  // [finding, the case, what is on the page (or what makes it), what the page says]
  const rows = [
    ['base', 'nothing read yet', {}, SAYS_NOTHING],
    ['base', 'a read of a transaction\'s own block, its receipt checked by that block\'s hash', { read: listingAt(100), needed: 100, blocks: [100] }, SAYS_NOTHING],
    ['base', 'a later read that has the hash at the receipt\'s block', { read: listingAt(104, { 100: H }), needed: 100, blocks: [100] }, SAYS_NOTHING],
    ['base', 'the reader trails the wallet: no read of the block the page was told of', { read: listingAt(99), needed: 100, blocks: [100] }, says(null, 100, false)],
    ['base', 'while the refresh for that block still reads, nothing is said yet', { read: listingAt(99), needed: 100, blocks: [100], reading: true }, SAYS_NOTHING],
    ['base', 'what was said before Read again stays said while it reads', { read: listingAt(99), needed: 100, blocks: [100], reading: true, said: says(null, 100, false) }, says(null, 100, false)],
    ['base', 'and goes the moment a read of that block is on the page, still reading or not', { read: listingAt(100), needed: 100, blocks: [100], reading: true, said: says(null, 100, false) }, SAYS_NOTHING],
    ['base', 'a header the node did not give for a receipt the page holds', { read: listingAt(102, { 100: null }), needed: 100, blocks: [100] }, says(null, null, true)],
    ['base', 'the block not read is said alone: what could not be checked waits for a read of it', { read: listingAt(99), needed: 100, blocks: [90, 100] }, says(null, 100, false)],
    ['base', 'a read that failed is off the page at once, also while a refresh reads', { read: failedAt(102), needed: 100, blocks: [100], reading: true }, says('failed', null, false)],
    ['base', 'a read that failed with no block at all (the node did not answer on load)', { read: { failed: 'no answer' } }, says('failed', null, false)],
    ['base', 'no such listing as of a block: nothing more is said of it here', { read: { missing: true, block: 102, blockHash: H, hashes: {} }, needed: 100 }, SAYS_NOTHING],
    // R8-F3, in each form it took
    ['R8-F3 (round 8)', 'a receipt a later one replaced is held no more, so its block is not checked', () => {
      const held = keptBlocks();
      const first = held.keep(100);
      held.keep(105);
      first();
      return { read: listingAt(110, { 105: H }), needed: 105, blocks: held.blocks() };
    }, SAYS_NOTHING],
    ['R8-F3 (round 9)', 'a receipt handed over that the page did not keep, another listing being under the id', { read: listingAt(95), needed: 90, blocks: [] }, SAYS_NOTHING],
    ['R8-F3 (round 10)', 'the last read allowed was the first of its block, and was held to a receipt nothing holds', () => {
      const held = keptBlocks();
      const r = refreshHeights(held, receipt(90));
      const last = listingAt(95);
      assert.equal(r.checked(last), false, 'the retry loop held the read to the receipt handed over, and found it incomplete');
      return { read: last, needed: 90, blocks: held.blocks() };
    }, SAYS_NOTHING],
    ['R8-F3 (round 11)', 'the last read replaces the listing: once the outgoing parts let go, nothing is unchecked', () => {
      const held = keptBlocks();
      const letGo = held.keep(90);
      assert.deepEqual(pageSays({ read: listingAt(95), needed: 90, blocks: held.blocks() }), says(null, null, true), 'while a part holds it');
      letGo();
      return { read: listingAt(95), needed: 90, blocks: held.blocks() };
    }, SAYS_NOTHING],
    // R9-F1
    ['R9-F1', 'block 102 is on display with a receipt of 100 unchecked, and the reader trails at 101: never "has not read block 100"', { read: listingAt(102), needed: 100, blocks: [100] }, says(null, null, true)],
    ['R9-F1', 'through Read again of a reader that still trails, the same', { read: listingAt(102), needed: 100, blocks: [100], reading: true, said: says(null, null, true) }, says(null, null, true)],
    // R10-F1
    ['R10-F1', 'a receipt of block 100 arrives after block 103 was read, and no read can be taken', { read: listingAt(103), needed: 103, blocks: [103, 100] }, says(null, null, true)],
    ['R10-F1', 'not while the refresh that receipt asked for still reads', { read: listingAt(103), needed: 103, blocks: [103, 100], reading: true }, SAYS_NOTHING],
    // R10-F2
    ['R10-F2', 'a read that contradicted itself on load at 102; Read again of a reader that trails at 101 takes no read', { read: failedAt(102) }, says('failed', null, false)],
    ['R10-F2', 'and while that Read again reads', { read: failedAt(102), reading: true, said: says('failed', null, false) }, says('failed', null, false)],
    // R11-F1
    ['R11-F1', 'the wallet\'s read contradicts the listing on display, at the height the page has read, and no read is taken', { read: listingAt(100), needed: 100, contradicted: true }, says('contradicted', null, false)],
    ['R11-F1', 'not while the refresh it asked for still reads', { read: listingAt(100), needed: 100, contradicted: true, reading: true }, SAYS_NOTHING],
    ['R11-F1', 'it stays through Read again, until a read is taken', { read: listingAt(100), needed: 100, contradicted: true, reading: true, said: says('contradicted', null, false) }, says('contradicted', null, false)],
    ['R11-F1', 'at a height the page has not read: hidden, and the block said with it', { read: listingAt(100), needed: 101, contradicted: true }, says('contradicted', 101, false)],
    ['R11-F1', 'whatever receipts the page holds, nothing else is said of a listing that is hidden', { read: listingAt(100), needed: 100, contradicted: true, blocks: [90] }, says('contradicted', null, false)],
    ['R11-F1', 'once a read is taken, the listing is shown as that read has it', { read: listingAt(100), needed: 100, contradicted: false }, SAYS_NOTHING],
    ['R11-F1', 'a read that failed, taken while the contradiction\'s refresh reads, is off the page at once', { read: failedAt(100), needed: 100, contradicted: true, reading: true }, says('failed', null, false)],
    // R11-F2
    ['R11-F2', 'a receipt that arrives after its own block was read: the map is empty, the block\'s hash is the read\'s', { read: listingAt(103, {}), needed: 103, blocks: [103] }, SAYS_NOTHING],
  ];
  for (const [finding, what, on, expected] of rows) {
    const input = typeof on === 'function' ? on() : on;
    assert.deepEqual(pageSays(input), expected, `${finding}: ${what}`);
  }
  for (const finding of ['R8-F3 (round 8)', 'R8-F3 (round 9)', 'R8-F3 (round 10)', 'R8-F3 (round 11)', 'R9-F1', 'R10-F1', 'R10-F2', 'R11-F1', 'R11-F2']) {
    assert.ok(rows.some((r) => r[0] === finding), `a row for ${finding}`);
  }
  // "has not read block N" is never said of a block the read on display is of, or of an earlier one
  for (const [, what, on] of rows) {
    const input = typeof on === 'function' ? on() : on;
    const out = pageSays(input);
    if (out.behind !== null) assert.ok(out.behind > (input.read?.block ?? 0), what);
    if (out.unchecked) assert.ok(out.hidden === null && out.behind === null, `${what}: said only of a listing that is shown and read`);
  }
});

test('the hash a read has at a height is one lookup, for a receipt\'s verdict and for what the page could not check (R11-F2)', () => {
  const H = `0x${'b'.repeat(64)}`;
  const OTHER = `0x${'c'.repeat(64)}`;
  // its own block's hash at its block, whatever the map of older hashes holds; the map below it
  assert.equal(hashAt({ block: 103, blockHash: H, hashes: {} }, 103), H);
  assert.equal(hashAt({ block: 103, blockHash: H, hashes: { 103: OTHER } }, 103), H, 'the read\'s own hash, not a second answer for the same block');
  assert.equal(hashAt({ block: 103, blockHash: H, hashes: { 100: OTHER } }, 100), OTHER);
  assert.equal(hashAt({ block: 103, blockHash: H, hashes: {} }, 100), undefined);
  // a late receipt at the displayed height, with an empty map: it stands, and nothing is left unchecked
  const late = kept({ hash: '0xabc', blockNumber: 103, blockHash: H }, {});
  const onDisplay = { block: 103, blockHash: H, hashes: {} };
  assert.equal(receiptVerdict(late, onDisplay, true), 'stands');
  assert.equal(hasHashAt(onDisplay, [103]), true);
  assert.equal(pageSays({ read: onDisplay, needed: 103, blocks: [103] }).unchecked, false);
  // and the two agree where the block was replaced: dropped, and checked (it is a hash, of another block)
  assert.equal(receiptVerdict(kept({ hash: '0xabc', blockNumber: 103, blockHash: OTHER }, {}), onDisplay, true), 'dropped');
  const source = read('../src/lib/seenMined.js');
  assert.match(source, /const hash = hashAt\(read, seen\.block\);/);
  assert.match(source, /return blocks\.every\(\(height\) => height > read\.block \|\| typeof hashAt\(read, height\) === 'string'\);/);
  assert.equal(source.split('read.hashes?.[').length - 1, 1, 'the map is read in one place');
  // the older checks of hasHashAt stand
  assert.equal(hasHashAt({ block: 103, blockHash: H, hashes: { 100: H } }, [103, 100]), true);
  assert.equal(hasHashAt({ block: 103, blockHash: H, hashes: {} }, [103, 100]), false);
  assert.equal(hasHashAt({ block: 103, blockHash: H, hashes: { 100: null } }, [100]), false, 'a header the node did not give');
  assert.equal(hasHashAt({ block: 99, blockHash: H, hashes: {} }, [100]), true, 'a block above the read is not its to check');
  assert.equal(hasHashAt(null, []), true);
  assert.equal(hasHashAt(null, [100]), false, 'no read checked anything');
  assert.equal(hasHashAt({ failed: 'no answer' }, [100]), false, 'nor did a read that is of no block');
});

test('the page draws what it says from that function alone, again whenever a read, a receipt holder or a refresh changes (R8-F3, R11-F1)', () => {
  const page = component('FundPage.jsx');
  assert.match(page, /const says = pageSays\(\{ read: loaded, needed: needed\.current, contradicted: contradicted\.current, blocks: kept\.current\.blocks\(\), reading, said: said\.current \}\);/);
  assert.match(page, /useEffect\(\(\) => \{\s*if \(!reading\) said\.current = says;\s*\}\);/);
  assert.match(page, /const \{ behind, unchecked \} = says;/);
  assert.match(page, /const failed = says\.hidden === 'contradicted' \? fill\(F\.contradicted, \{ id: listingId \}\) : says\.hidden === 'failed' \? loaded\.failed : null;/);
  assert.doesNotMatch(page, /setBehind|setUnchecked|refreshNotices/, 'no notice is set at the instant a refresh ends');
  assert.doesNotMatch(read('../src/lib/seenMined.js'), /refreshNotices/, 'and no second place decides');
  // a holder that keeps or lets go draws the page again: the registry tells the page
  assert.match(page, /if \(kept\.current === null\) kept\.current = keptBlocks\(\(\) => redraw\(\(n\) => n \+ 1\)\);/);
  const changes = [];
  const held = keptBlocks(() => changes.push(held.blocks().join(',')));
  const letGo = held.keep(90);
  letGo();
  letGo();
  assert.deepEqual(changes, ['90', ''], 'told of each change, once');
  // holders keep and let go, and the page clears its own for another listing, before the browser paints: what an
  // outgoing listing's parts held is never painted against the listing that replaced it
  assert.match(read('../src/components/seenMined.js'), /useLayoutEffect\(\(\) => \(block === null \|\| !blocks \? undefined : blocks\.keep\(block\)\), \[block, blocks\]\);/);
  assert.match(page, /useLayoutEffect\(\(\) => \(heldHere \? kept\.current\.keep\(heldHere\.block\) : undefined\), \[heldHere\]\);/);
  assert.match(page, /useLayoutEffect\(\(\) => \{\s*if \(shownIdentity\.current !== null && identity !== null && identity !== shownIdentity\.current\) \{\s*setHeldHere\(null\);\s*setOpenedHere\(null\);\s*\}/);
  // The refresh: reading from its start to its end. A refusal by a read through the wallet is noted at its start,
  // and is gone with the first read taken; the page says it only once the reading is over (the function, above).
  const refresh = page.slice(page.indexOf('const refresh = useCallback('), page.indexOf('// The listing this page shows, by maker and artifact.'));
  assert.match(refresh, /if \(isContradiction\(told\)\) contradicted\.current = true;\s*setReading\(true\);/);
  assert.match(refresh, /const show = \(got\) => \{\s*shownRead\.current = got;\s*contradicted\.current = false;/);
  assert.match(refresh, /\.then\(\(\) => \{\s*if \(wanted\(\)\) setReading\(false\);\s*\}\);/);
  // every refusal by a read through the wallet is handed over as one: the two of each action, and the roll's two
  assert.deepEqual(contradictedAt(7), { contradicted: true, block: 7 });
  assert.equal(isContradiction(contradictedAt(7)), true);
  for (const not of [7, null, undefined, kept({ hash: '0xabc', blockNumber: 7, blockHash: `0x${'b'.repeat(64)}` }, {})]) assert.equal(isContradiction(not), false);
  assert.equal(component('ListingActions.jsx').split('onChanged(contradictedAt(block));').length - 1, 8);
  assert.equal(component('ListingExtras.jsx').split('onChanged(contradictedAt(block));').length - 1, 2);
  for (const file of ['ListingActions.jsx', 'ListingExtras.jsx']) assert.doesNotMatch(component(file), /onChanged\(block\);/, file);
  // a hold() mined with no Held event is a transaction, not a refusal: the page reads from its block
  assert.equal(component('ListingActions.jsx').split('onChanged(receipt.blockNumber);').length - 1, 1);
  // the words: one line, nothing judged, and that nothing was sent
  const text = fill(STRINGS.fund.readFailed, { reason: fill(STRINGS.fund.contradicted, { id: 7 }) });
  assert.equal(text, 'The listing could not be read: the chain as your wallet reads it has listing 7 otherwise than this page showed it, or has no such listing; nothing was sent, and this page has taken no read of the chain since');
  oneLine('fund.contradicted', STRINGS.fund.contradicted);
  assert.deepEqual(wordingProblems(text), []);
});

test('a listing that is gone after a failed read is still said as gone: the page showed it (R8-F4)', () => {
  const page = component('FundPage.jsx');
  // whether the page showed the listing is what it kept of its last read with the listing, not what the read before
  // this one was: a failed read in between does not make the page forget that it showed a hold
  assert.match(page, /setLoaded\(got\.missing && lastListing\.current !== null \? \{ \.\.\.got, gone: true \} : got\);/);
  assert.doesNotMatch(page, /was\.failed|was\.gone/, 'not from the state the failed read left');
});

test('while a read has failed the listing is hidden as a whole, and what its parts keep of the page\'s transactions is held against the next read', () => {
  const page = component('FundPage.jsx');
  // the parts are drawn from the latest read that has the listing, and held against that read's snapshot
  assert.match(page, /const lastListing = useRef\(null\);\s*if \(loaded\?\.listing\) lastListing\.current = loaded;\s*const current = loaded\?\.failed \? lastListing\.current : loaded\?\.listing \? loaded : null;/);
  // one place in the page for every part of the listing, shown or not: a failed read hides it, and unmounts nothing
  assert.match(page, /\{unread\}\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="listing-read" hidden=\{failed !== null\} data-testid="listing-read">/);
  const inside = page.slice(page.indexOf('<div className="listing-read"'), page.lastIndexOf('</div>'));
  for (const part of ['data-testid="listing-summary"', '<FundListing ', '<ListingMore ', '<TopUpEscrow ', '<RenewListing ', '<CloseListing ', '<Withdraw ', 'data-testid="listing-held"']) assert.ok(inside.includes(part), `${part} is inside it`);
  assert.match(read('../src/styles.css'), /\.listing-read \{\s*display: contents;\s*\}\s*\.listing-read\[hidden\] \{\s*display: none;\s*\}/);
  // a read that failed before any read had the listing draws the failure alone
  assert.match(page, /if \(current === null\) return <>\{header\}\{unread\}<\/>;/);
  assert.ok(page.indexOf('if (current === null) return') < page.indexOf('const hold = holdView('), 'before anything of a listing is computed');
});

test('what the page kept for a listing goes when another listing is under its id: every part is keyed by the listing shown', () => {
  const page = component('FundPage.jsx');
  assert.match(page, /const identity = current\?\.listing \? `\$\{current\.listing\.maker\}:\$\{current\.listing\.artifactHash\}`\.toLowerCase\(\) : null;/);
  // the hold and the opening the page saw mined were the first listing's
  assert.match(page, /if \(shownIdentity\.current !== null && identity !== null && identity !== shownIdentity\.current\) \{\s*setHeldHere\(null\);\s*setOpenedHere\(null\);\s*\}/);
  // and so were the record, the successors found, and each action's own line: all inside the keyed part
  const keyed = page.slice(page.indexOf('<Fragment key={identity}>'), page.indexOf('</Fragment>'));
  for (const part of ['<FundListing ', '<ListingMore ', '<TopUpEscrow ', '<RenewListing ', '<CloseListing ']) assert.ok(keyed.includes(part), `${part} is keyed by the listing shown`);
  // the successor offered is the version the feed describes: a feed entry of another artifact than the chain has under its id offers nothing
  const extras = component('ListingExtras.jsx');
  assert.match(extras, /if \(s !== null && same\(e\.artifactHash, s\.artifactHash\) && onHold\.heldAt === 0n/);
});

test('a transaction that is mined is never reported as failed: the receipt of a call sent again at a higher fee, and no read between the receipt and its line', () => {
  const actions = component('ListingActions.jsx');
  // every transaction of the listing's page takes its receipt through minedReceipt, and names the hash it was mined under
  assert.doesNotMatch(actions, /tx\.wait\(\)/, 'top-up, renew, hold, close, withdraw');
  assert.equal(actions.split('await minedReceipt(tx);').length - 1, 5);
  assert.doesNotMatch(actions, /tx: tx\.hash/);
  const funding = component('FundListing.jsx');
  assert.doesNotMatch(funding, /tx\.wait\(\)|tx: tx\.hash/);
  assert.doesNotMatch(component('ListingExtras.jsx'), /tx\.wait\(\)|tx: tx\.hash/);
  // a renewal: until when is the receipt's own Renewed event, so the line and the refresh follow the receipt at once.
  // A read that failed after a mined, paid renewal used to report it as failed, and offer the payment again.
  const renew = actions.slice(actions.indexOf('export function RenewListing('), actions.indexOf('export function HoldListing('));
  assert.match(renew, /const receipt = await minedReceipt\(tx\);[\s\S]*?const renewed = listingEvent\(sa, receipt, 'Renewed', listingId\);\s*const seen = kept\(receipt, \{ until: renewed \? renewed\.args\.fundedUntil : null \}\);\s*setDone\(seen\);\s*onChanged\(seen\);/);
  // the opening, the same: until when is the receipt's Opened event, and no read follows the receipt
  const opening = funding.slice(funding.indexOf('.fund(listingId, due'), funding.indexOf('} catch (err) {'));
  assert.doesNotMatch(opening, /getListing|snapshot\(/, 'no read after the opening is sent');
  assert.match(opening, /const openedEvent = listingEvent\(sa, receipt, 'Opened', listingId\);\s*const seen = kept\(receipt, \{ until: openedEvent \? openedEvent\.args\.fundedUntil : null \}\);/);
  const sent = renew.slice(renew.indexOf('.renew(BigInt(listingId)'), renew.indexOf('} catch (err) {'));
  assert.doesNotMatch(sent, /getListing|snapshot\(|stakeAttestation\(/, 'no read after the renewal is sent');
  assert.match(SOURCE, /event Renewed\(uint256 indexed listingId, uint256 feeWei, uint64 fundedUntil\);/);
  assert.equal(new Interface(STAKE_ATTESTATION_ABI).getEvent('Renewed').format('full'), 'event Renewed(uint256 indexed listingId, uint256 feeWei, uint64 fundedUntil)');
  assert.equal(fill(STRINGS.renew.doneNoTime, { tx: '0xabc' }), 'Renewed (transaction 0xabc).');
  // a top-up, the same: what the escrow holds is the receipt's Funded event, and no read follows the receipt
  const topUp = actions.slice(actions.indexOf('export function TopUpEscrow('), actions.indexOf('export function RenewListing('));
  const paid = topUp.slice(topUp.indexOf('.fund(BigInt(listingId), 0n'), topUp.indexOf('} catch (err) {'));
  assert.doesNotMatch(paid, /getListing/, 'no read after the top-up is sent');
  assert.match(topUp, /\{done\.escrow === null && fill\(T\.doneNoEscrow, \{ tx: done\.tx \}\)\}/);
  assert.equal(fill(STRINGS.topUp.doneNoEscrow, { tx: '0xabc' }), 'Topped up (transaction 0xabc).');
});

test('a hold or an opening is set only for the listing it was sent for: a receipt that arrives after another listing is shown sets nothing', () => {
  const page = component('FundPage.jsx');
  // each callback is made for the listing shown when its action was drawn (`identity` in its closure); when it is
  // called, the listing shown may be another one (`shownIdentity`). The page still reads from the receipt's block.
  assert.match(page, /const onHeld = useCallback\(\(seen\) => \{\s*const here = identity === shownIdentity\.current;\s*if \(here\) setHeldHere\(asKept\(seen\)\);\s*refresh\(here \? seen : seen\.block\);\s*\}, \[refresh, identity\]\);/);
  assert.match(page, /const onOpened = useCallback\(\(seen\) => \{\s*const here = identity === shownIdentity\.current;\s*if \(here\) setOpenedHere\(seen\);\s*refresh\(here \? seen : seen\.block\);\s*\}, \[refresh, identity, setOpenedHere\]\);/);
  assert.ok(page.indexOf('const shownIdentity = useRef(null);') < page.indexOf('const onHeld = useCallback('), 'the identity shown is known to the callbacks');
});

test('a withdrawal says what its receipt says was paid, and the balance shown follows the page\'s read of the chain', () => {
  const actions = component('ListingActions.jsx');
  const withdraw = actions.slice(actions.indexOf('export function Withdraw('));
  // what was paid is the Withdrawn event of this contract for this wallet, not the balance read before sending: the
  // contract pays all it holds when the call is mined
  assert.match(fn(SOURCE, 'withdraw'), /emit Withdrawn\(msg\.sender, amt\);/);
  assert.equal(new Interface(STAKE_ATTESTATION_ABI).getEvent('Withdrawn').format('full'), 'event Withdrawn(address indexed account, uint256 amount)');
  assert.match(withdraw, /const paid = contractEvent\(sa, receipt, 'Withdrawn', \(event\) => same\(event\.args\.account, sender\)\);\s*const seen = kept\(receipt, \{ amount: paid \? paid\.args\.amount : null, account: sender \}\);/);
  assert.doesNotMatch(withdraw, /kept\(receipt, \{ amount, /, 'never the amount read before sending');
  assert.match(withdraw, /\{done\.amount === null\s*\? fill\(W\.doneNoAmount, \{ tx: done\.tx, account: done\.account \}\)\s*: fill\(W\.done, \{ tx: done\.tx, eth: formatEth\(done\.amount\), account: done\.account \}\)\}/);
  assert.equal(fill(STRINGS.withdraw.doneNoAmount, { tx: '0xabc', account: '0xdef' }), 'Withdrawn (transaction 0xabc) to 0xdef.');
  // The balance is read again whenever the page takes a new read of the listing, from a block that is not before it:
  // once the page has read a close or a withdrawal, the balance shown is not one from before it. A read that did not
  // reach that block shows no balance.
  assert.match(withdraw, /readFrom\(balance, read\?\.block \?\? 0, \{ live: \(\) => live \}\)\s*(?:\/\/[^\n]*\n\s*)?\.then\(\(\{ read: got, reached \}\) => \{ if \(live\) setHeld\(reached \? \{ account, wei: got\.wei \} : null\); \}\)/);
  assert.match(withdraw, /\}, \[account, read\?\.block, read\?\.blockHash, done\]\);/);
  assert.doesNotMatch(component('FundPage.jsx'), /setVersion|version=/, 'no count of actions stands in for the page\'s read');
});

// ---------------------------------------------------------------- the action, on the page
const NAMED = Object.freeze([/sepolia/i, /mainnet/i, /testnet/i, /\bbase\b/i, /faucet/i, /https?:/i, /\b0x[0-9a-f]{4,}/i, /github/i, /\.(org|com|io)\b/i, /@/]);
const holdStrings = () => Object.entries(H).flatMap(([k, v]) => (typeof v === 'string' ? [[`STRINGS.hold.${k}`, v]] : Object.entries(v).map(([k2, v2]) => [`STRINGS.hold.${k}.${k2}`, v2])));

test('every string of the hold is one line, names no network, faucet, host or account, and passes the wording check', () => {
  const all = holdStrings();
  assert.ok(all.length >= 14, all.map(([k]) => k).join());
  for (const [at, text] of all) {
    oneLine(at, text);
    assert.deepEqual(wordingProblems(text), [], at);
    for (const re of NAMED) assert.equal(re.test(text), false, `${at} names ${re}: ${text}`);
  }
  // "on hold", as the badge says it: a stake that is "held" could be read as one that is in place
  for (const [at, text] of all) assert.doesNotMatch(text, /\bheld\b/i, at);
  assert.equal(fill(H.done, { id: 7, time: 'T', tx: '0xabc' }), 'Listing 7 is on hold since T (transaction 0xabc).');
  assert.equal(fill(H.since, { time: 'T' }), 'This listing is on hold since T.');
  assert.equal(fill(H.ask, { id: 7 }), 'Hold listing 7');
  assert.match(fill(H.confirm, { id: 7 }), /^Hold listing 7 now/);
});

test('the action is offered to the listing\'s maker only, and to no other wallet', () => {
  const actions = component('ListingActions.jsx');
  const body = actions.slice(actions.indexOf('export function HoldListing('), actions.indexOf('\n}\n', actions.indexOf('export function HoldListing(')));
  assert.ok(body.length > 0, 'HoldListing, in ListingActions.jsx');
  // the connected wallet, compared with the listing's maker: without one, or with another, there is no button
  assert.match(body, /const account = w\.wallet\?\.account \?\? null;/);
  assert.match(body, /const isMaker = account !== null && same\(account, listing\.maker\);/);
  assert.match(body, /if \(!isMaker\) action = <p className="hint" data-testid="hold-maker-only">\{H\.makerOnly\}<\/p>;/);
  assert.equal(body.split('<button').length - 1, 3, 'ask, confirm and keep: each inside the maker\'s branch');
  assert.ok(body.indexOf('if (!isMaker) action =') < body.indexOf('<button'), 'the buttons come after the check');
  assert.match(H.makerOnly, /^Only this listing's maker can hold it/);
  // and the wallet that sends is checked again, since it can change between the page and the click
  assert.match(body, /const \{ signer, provider, account: sender \} = await w\.ensure\(\);\s*if \(!same\(sender, listing\.maker\)\) /);
  assert.match(body, /fill\(STRINGS\.claim\.notMaker, \{ maker: listing\.maker, account: sender \}\)/);
  // the contract's own rule
  assert.match(fn(LOGIC, 'hold'), /require\(msg\.sender == l\.maker, "not maker"\);/);
});

test('the action asks for confirmation before anything is sent, reads the listing and its hold again at one block, and reports the transaction', () => {
  const actions = component('ListingActions.jsx');
  const body = actions.slice(actions.indexOf('export function HoldListing('), actions.indexOf('\n}\n', actions.indexOf('export function HoldListing(')));
  // two steps before the wallet's own, as close(): the first button only asks
  assert.match(body, /const \[asking, setAsking\] = useState\(false\);/);
  assert.match(body, /onClick=\{\(\) => \{ setError\(null\); setAsking\(true\); \}\}>\s*\{fill\(H\.ask, \{ id: listingId \}\)\}/);
  assert.match(body, /<button type="button" className="danger" onClick=\{send\} disabled=\{busy\}>\s*\{busy \? H\.sending : fill\(H\.confirm, \{ id: listingId \}\)\}/);
  assert.match(body, /<button type="button" className="secondary" onClick=\{\(\) => setAsking\(false\)\} disabled=\{busy\}>\{H\.keep\}<\/button>/);
  assert.equal(body.split('.hold(BigInt(listingId))').length, 2, 'hold() is sent in one place');
  assert.ok(body.indexOf('const send = async') < body.indexOf('.hold(BigInt(listingId))'), 'inside send');
  // just before sending: the listing and its hold, through the wallet, at one block
  assert.match(body, /const \{ value: \[mine, now\], block \} = await snapshot\(provider, \(at\) => \{\s*const view = stakeAttestation\(at\);\s*return Promise\.all\(\[listingAt\(view, listingId\), readHold\(view, listingId\)\]\);\s*\}\);/);
  // a hold has no way back: it is sent only for the listing the page showed, the same artifact and the same maker's.
  // Another listing under the id, or none, sends nothing, takes the confirmation back and reads the page again.
  assert.match(body, /if \(!sameListing\(mine, listing\)\) \{\s*setError\(fill\(STRINGS\.fund\.replaced, \{ id: listingId \}\)\);\s*setAsking\(false\);\s*onChanged\(contradictedAt\(block\)\);\s*return undefined;\s*\}\s*if \(!holdTerms\(mine, now\)\.can/);
  assert.ok(body.indexOf('if (!sameListing(mine, listing))') < body.indexOf('.hold(BigInt(listingId))'), 'before hold() is sent');
  assert.match(body, /if \(!holdTerms\(mine, now\)\.can \|\| !same\(mine\.maker, sender\)\) \{\s*setError\(fill\(H\.changed, \{ id: listingId \}\)\);/);
  // the receipt, also of the same call sent again at a higher fee; this contract's Held event for this listing is the
  // hold and its time; and the page says it with the mined transaction, and is told the block to read from
  assert.match(body, /const receipt = await minedReceipt\(tx\);\s*\/\/[^\n]*\n\s*const held = heldEvent\(sa, receipt, listingId\);/);
  assert.match(read('../src/chain/wallet.js'), /if \(String\(log\.address\)\.toLowerCase\(\) !== String\(contract\.target\)\.toLowerCase\(\)\) continue;[\s\S]*?if \(event\?\.name === name && is\(event\)\) return event;/);
  assert.match(read('../src/chain/wallet.js'), /export const listingEvent = \(contract, receipt, name, listingId\) => contractEvent\(contract, receipt, name, \(event\) => event\.args\.listingId === BigInt\(listingId\)\);/);
  assert.match(actions, /const heldEvent = \(contract, receipt, listingId\) => listingEvent\(contract, receipt, 'Held', listingId\);/);
  // a mined transaction whose receipt shows no hold: never "nothing was sent", but which transaction it was, and no hold claimed
  assert.match(body, /if \(!held\) \{[\s\S]*?setError\(fill\(H\.notConfirmed, \{ id: listingId, tx: receipt\.hash \}\)\);\s*onChanged\(receipt\.blockNumber\);\s*return undefined;\s*\}\s*const seen = kept\(receipt, \{ heldAt: held\.args\.heldAt \}\);\s*setDone\(seen\);\s*onHeld\(seen\);/);
  assert.equal(fill(H.notConfirmed, { id: 7, tx: '0xabc' }).startsWith('Transaction 0xabc was mined, and its receipt does not show a hold of listing 7:'), true);
  assert.doesNotMatch(H.notConfirmed, /Nothing was sent/);
  assert.match(body, /fill\(H\.done, \{ id: listingId, time: formatTime\(hold\.heldAt\), tx: done\.tx \}\)/);
  assert.match(SOURCE, /event Held\(uint256 indexed listingId, uint64 heldAt\);/);
});

test('against a contract with no hold the page shows no hold action: the section is not drawn at all', () => {
  const actions = component('ListingActions.jsx');
  const body = actions.slice(actions.indexOf('export function HoldListing('), actions.indexOf('\n}\n', actions.indexOf('export function HoldListing(')));
  assert.match(body, /if \(!hold\.supported\) return null;/);
  assert.ok(body.indexOf('if (!hold.supported) return null;') < body.indexOf('data-testid="hold"'), 'before anything is drawn');
  // the listing's own page reads the view at the block it reads the listing at, and a refusal is "no hold"
  const page = component('FundPage.jsx');
  assert.match(page, /const listing = await listingAt\(view, listingId\);\s*if \(listing === null\) return \{ missing: true \};\s*const \[hold, takesCommits\] = await Promise\.all\(\[readHold\(view, listingId\), view\.acceptsCommits\(BigInt\(listingId\)\)\]\);/);
  // a read that fails any other way rejects with the rest: the page's "could not be read", never a listing "not on hold"
  assert.doesNotMatch(page, /readHold\([^)]*\)\.catch/);
  const lib = read('../src/lib/hold.js');
  assert.match(lib, /if \(refusedByContract\(err\)\) return NO_HOLD;\s*throw err;/);
});

test('once on hold, the page says so with the time, and still offers roll forward and close', () => {
  const page = component('FundPage.jsx');
  // the state stays the chain's (Open or Depleted): the hold is said beside it, with its time, and the pill is not green
  assert.match(page, /\{hold\.held && <><dt>\{F\.heldSince\}<\/dt><dd data-testid="listing-held-since">\{formatTime\(hold\.heldAt\)\}<\/dd><\/>\}/);
  assert.match(page, /\{hold\.held && <p className="warning" data-testid="listing-held">\{fill\(F\.held, \{ id: listingId, time: formatTime\(hold\.heldAt\) \}\)\}<\/p>\}/);
  // "open until" is said of a listing that takes claims, never of one on hold
  assert.match(page, /\{state === 'Open' && !hold\.held && <p className="ok" data-testid="listing-open-until">\{fill\(F\.alreadyOpen,/);
  assert.equal(fill(STRINGS.fund.held, { id: 7, time: 'T' }).startsWith('Listing 7 is on hold since T: it takes no new claims.'), true);
  assert.match(STRINGS.fund.held, /a late claim/);
  assert.match(STRINGS.fund.held, /The hold ends when the listing is rolled forward or closed\.$/);
  // roll forward and close are drawn from the listing's state and its pending claims, as before: a hold changes neither
  const extras = component('ListingExtras.jsx');
  const roll = extras.slice(extras.indexOf('export function RollForward('), extras.indexOf('/** Whether the site offers a commit'));
  assert.match(roll, /if \(!ROLLABLE\.has\(state\)\) return null;/);
  assert.doesNotMatch(roll, /hold\.held && return|if \(hold\.held\) return/);
  const actions = component('ListingActions.jsx');
  const close = actions.slice(actions.indexOf('export function CloseListing('), actions.indexOf('\n}\n', actions.indexOf('export function CloseListing(')));
  assert.ok(close.length > 0);
  assert.doesNotMatch(close, /\bhold\b|\bheld\b|heldAt/, 'close is offered by its own terms: the pending claims and what is owed');
});

test('the README says for which reads a block hash is held: the configured read address, not a wallet\'s node (R9-F2)', () => {
  const readme = read('../../README.md').replace(/\s+/g, ' ');
  const reads = readme.slice(readme.indexOf('**The page reads; it does not watch.**'), readme.indexOf('**What the page saw mined, against what it reads.**'));
  assert.match(reads, /What the page holds all the same, where a read address is configured \(`VITE_SA_RPC_URL`\): a hold's state and its next step, as the page shows them, come from one read tied to one block's hash/);
  assert.match(reads, /A wallet's node is asked by the block's number, so none of that is held for it: the read just before something is sent, and every read of the page where no read address is configured, are tied to their block only by its hash read before and after the calls/);
  assert.match(reads, /stand on the assumption alone, that the nodes behind the wallet's address agree on the chain/);
  const config = readme.slice(readme.indexOf('**Config** is Vite\'s build environment'), readme.indexOf('**Wording.**'));
  assert.match(config, /Without a read address the page's reads go through the visitor's wallet, by block number, and what they show of a hold is not tied to a block's hash/);
  assert.match(read('../../deploy/client.env'), /Left unset, the page reads through the visitor's wallet, by block number/);
  // and it is so: only a provider made for the read address is asked by hash
  assert.match(read('../src/chain/snapshot.js'), /const selector = SITE_READERS\.has\(provider\) \? \{ blockHash, requireCanonical: true \} : quantity\(block\);/);
});
