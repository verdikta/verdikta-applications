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
  const seen = { at: HELD_AT, block: 90 };
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
  // the page keeps the receipt's time and block, and holdView is given the block each read is of
  assert.match(page, /const onHeld = useCallback\(\(at, block\) => \{\s*setHeldHere\(\{ at, block \}\);\s*refresh\(block\);/);
  assert.match(page, /const hold = holdView\(l, loaded\.hold, heldHere, loaded\.block\);/);
  // a read of that block or later replaces the receipt for good: a later read from a node behind cannot bring it back
  assert.match(page, /setHeldHere\(\(seen\) => \(seen && read\.block >= seen\.block \? null : seen\)\);/);
  // the hold's own section: its line of a mined hold shows only while the listing reads on hold; otherwise the page
  // says the hold is not on the chain, in an alert, and offers the action again
  const actions = component('ListingActions.jsx');
  const body = actions.slice(actions.indexOf('export function HoldListing('), actions.indexOf('\n}\n', actions.indexOf('export function HoldListing(')));
  assert.match(body, /if \(hold\.held\) \{[\s\S]*?const mine = done !== null && BigInt\(done\.heldAt\) === hold\.heldAt;\s*body = \(/);
  assert.doesNotMatch(body, /if \(done \|\| /, 'a mined hold alone never draws the listing as on hold');
  // one answer for when the hold began: the time the page states (the chain's, once a read has it), in the section as
  // in the summary. The receipt's transaction is named with it only while the hold read is that receipt's.
  assert.match(body, /\{mine\s*\? <p className="ok" data-testid="held">\{fill\(H\.done, \{ id: listingId, time: formatTime\(hold\.heldAt\), tx: done\.tx \}\)\}<\/p>\s*: <p data-testid="hold-since">\{fill\(H\.since, \{ time: formatTime\(hold\.heldAt\) \}\)\}<\/p>\}/);
  assert.doesNotMatch(body, /formatTime\(done\.heldAt\)/, 'the receipt\'s time is never drawn beside the chain\'s');
  assert.match(body, /\{done && <p className="error" role="alert" data-testid="hold-dropped">\{fill\(H\.dropped, \{ tx: done\.tx \}\)\}<\/p>\}/);
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
  assert.match(page, /needed\.current = Math\.max\(needed\.current, minBlock\);\s*const from = needed\.current;/);
  assert.match(page, /readFrom\(\(\) => readListing\(listingId\), from, \{ live: wanted \}\)\.then\(\(\{ read, reached \}\) => \{/);
  assert.doesNotMatch(page, /readFrom\([^)]*minBlock/, 'never from the one refresh\'s own block alone');
  assert.match(page, /if \(reached\) \{\s*(?:\/\/[^\n]*\n\s*)?setLoaded\(\(was\) => \(read\.missing && was && !was\.failed && \(!was\.missing \|\| was\.gone\) \? \{ \.\.\.read, gone: true \} : read\)\);\s*setBehind\(null\);/);
  assert.match(page, /\} else if \(from > 0\) setBehind\(from\);/);
  // the page is keyed by its listing (App.jsx), so the kept block is one listing's
  assert.match(read('../src/App.jsx'), /<FundPage key=\{r\.listingId \?\? 'none'\} listingId=\{r\.listingId\} \/>/);
  assert.match(page, /\{behind !== null && \(\s*<>\s*<p className="warning" role="status" data-testid="listing-behind">\{fill\(F\.behind, \{ block: behind \}\)\}<\/p>\s*<button type="button" className="secondary" data-testid="listing-read-again" onClick=\{\(\) => refresh\(behind\)\}>\{F\.retry\}<\/button>/);
  assert.equal(fill(STRINGS.fund.behind, { block: 90 }), 'This page has not read the chain as of block 90 yet, which the wallet\'s node has reached: what it shows of the listing may be from before the last change sent or seen through the wallet.');
  // every action of the page hands the refresh its receipt's block: the hold, the roll, the close, the top-up, the renewal, the opening
  const actions = component('ListingActions.jsx');
  assert.equal(actions.split('onChanged(receipt.blockNumber);').length - 1, 4, 'top-up, renew, close, and a mined hold() with no Held event');
  // and an action that sends nothing because the wallet's read found the listing changed hands over that read's block
  assert.equal(actions.split('onChanged(blockTag);').length - 1, 8, 'top-up, renew, hold, close: each for a listing that changed, and for one that is another or gone');
  assert.doesNotMatch(actions, /onChanged\(\)/, 'no refresh without a block from an action that read one');
  assert.match(actions, /onHeld\(held\.args\.heldAt, receipt\.blockNumber\);/);
  const extras = component('ListingExtras.jsx');
  assert.match(extras, /const receipt = await minedReceipt\(tx\);\s*setDone\(\{ id: pick, tx: receipt\.hash, block: receipt\.blockNumber \}\);\s*onChanged\(receipt\.blockNumber\);/);
  assert.match(component('FundListing.jsx'), /const receipt = await tx\.wait\(\);[\s\S]*?onOpened\(receipt\.blockNumber\);/);
  // a listing opened from its own page: its line stays, and the page follows the listing, so the hold is there without a reload
  assert.match(page, /const onOpened = useCallback\(\(block = 0\) => \{\s*setOpenedHere\(\{ block \}\);\s*refresh\(block\);/);
  assert.match(page, /\{\(state === 'Listed' \|\| openedHere !== null\) && <FundListing /);
});

test('a listing that is gone as of a later block is an answer of that block: the page says so, and drops the hold it saw mined', () => {
  const page = component('FundPage.jsx');
  // the count is read at the block of the rest, and "no such listing" carries that block: readFrom takes it once it
  // reaches the block waited for, where a bare null would be tried again for ever
  assert.match(page, /const block = Number\(await provider\.send\('eth_blockNumber', \[\]\)\);\s*const at = \{ blockTag: block \};\s*if \(id === 0n \|\| id > \(await sa\.listingCount\(at\)\)\) return \{ missing: true, block \};/);
  assert.doesNotMatch(page, /return null;\s*\/\/ a raw eth_blockNumber/);
  assert.doesNotMatch(page, /sa\.listingCount\(\)/, 'never at another block than the rest');
  // the hold seen mined is dropped by any read of its block or later, the missing one included
  assert.match(page, /setHeldHere\(\(seen\) => \(seen && read\.block >= seen\.block \? null : seen\)\);/);
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
  assert.match(page, /<FundListing listingId=\{BigInt\(listingId\)\} top=\{l\.awards\[3\]\} maker=\{l\.maker\} artifactHash=\{l\.artifactHash\} followed=\{state !== 'Listed'\} dropped=\{openingDropped\} onOpened=\{onOpened\} \/>/);
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
  assert.match(component('FundPage.jsx'), /takesCommits=\{loaded\.takesCommits\}/);
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
  assert.match(panel, /const \[s, onHold\] = await Promise\.all\(\[sa\.getListing\(id\), hold\.supported \? readHold\(sa, id\) : NO_HOLD\]\);\s*if \(onHold\.heldAt === 0n && confirmSuccessor\(/);
  assert.match(panel, /hold\.supported \? readHold\(reader, pick, \{ blockTag \}\) : NO_HOLD,/);
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
  assert.match(wallet, /export async function listingAt\(contract, listingId, blockTag\) \{\s*const id = BigInt\(listingId\);\s*if \(id === 0n \|\| id > BigInt\(await contract\.listingCount\(\{ blockTag \}\)\)\) return null;\s*return contract\.getListing\(id, \{ blockTag \}\);/);
  assert.match(fn(SOURCE, 'getListing'), /return _mustListing\(listingId\);/);
  assert.match(SOURCE, /function _mustListing\(uint256 listingId\) internal view returns \(Listing storage\) \{\s*require\(listingId != 0 && listingId <= listingCount, "bad listingId"\);/);
  // the four actions of the page, and the roll forward: each reads through listingAt and stops on sameListing
  const actions = component('ListingActions.jsx');
  assert.equal(actions.split('if (!sameListing(mine, listing)) {').length - 1, 4, 'top-up, renew, hold, close');
  assert.equal(actions.split('setError(fill(STRINGS.fund.replaced, { id: listingId }));').length - 1, 4);
  assert.doesNotMatch(actions, /reader\.getListing\(BigInt\(listingId\), \{ blockTag/, 'no preflight reads the listing past listingAt');
  const extras = component('ListingExtras.jsx');
  const panel = extras.slice(extras.indexOf('export function RollForward('), extras.indexOf('/**\n * Whether the site offers a commit'));
  assert.match(panel, /listingAt\(reader, listingId, blockTag\),\s*listingAt\(reader, pick, blockTag\),/);
  assert.match(panel, /if \(!sameListing\(mine, listing\)\) \{\s*setError\(fill\(STRINGS\.fund\.replaced, \{ id: listingId \}\)\);\s*onChanged\(blockTag\);\s*return undefined;\s*\}/);
  // and the successor is the version the picker showed under that id
  assert.match(panel, /out\.push\(\{ id: e\.listingId, commit: e\.artifact\.baseCommit, artifactHash: s\.artifactHash,/);
  assert.match(panel, /const chosen = options\.find\(\(o\) => o\.id === pick\);[\s\S]*?\|\| successor === null \|\| !chosen \|\| !same\(successor\.artifactHash, chosen\.artifactHash\)/);
  assert.equal(fill(STRINGS.fund.replaced, { id: 7 }), 'Nothing was sent: on the chain as your wallet reads it now, listing 7 is not the listing this page shows, or there is no such listing. This page reads it again.');
});

test('an opening, a roll and a close the page saw mined stand by their receipts only until a read reaches their block', () => {
  const page = component('FundPage.jsx');
  // the opening: shown as open by its receipt while the read is from before its block; a read of that block or later
  // that still says Listed is the state shown, the opening is said not to be there, and the funding form is back
  assert.match(page, /const openingAhead = openedHere !== null && loaded\.block < openedHere\.block;\s*const openingDropped = openedHere !== null && !openingAhead && state === 'Listed';\s*const shown = state === 'Listed' && openingAhead \? 'Open' : state;/);
  const funding = component('FundListing.jsx');
  assert.match(funding, /if \(opened && !dropped\) \{/);
  assert.match(funding, /\{opened && dropped && <p className="error" role="alert" data-testid="opening-dropped">\{fill\(C\.openingDropped, \{ id: String\(listingId\), tx: opened\.tx \}\)\}<\/p>\}/);
  assert.equal(fill(STRINGS.chain.openingDropped, { id: 7, tx: '0xabc' }), 'The opening sent from this page (transaction 0xabc) is not on the chain as this page now reads it: listing 7 is listed and not funded. Look the transaction up, and fund the listing again if it is gone.');
  // the roll: its line replaces the panel only while the listing reads rolled, or the read is from before the roll
  const extras = component('ListingExtras.jsx');
  assert.match(extras, /const rolledHere = done !== null && \(!ROLLABLE\.has\(state\) \|\| readBlock === null \|\| readBlock < done\.block\);/);
  assert.match(extras, /if \(rolledHere\) return <p data-testid="rolled" className="ok">/);
  assert.match(extras, /\{done && <p className="error" role="alert" data-testid="roll-dropped">\{fill\(RF\.dropped, \{ tx: done\.tx \}\)\}<\/p>\}/);
  assert.match(page, /<ListingMore listingId=\{listingId\} listing=\{l\} hold=\{hold\} takesCommits=\{loaded\.takesCommits\} readBlock=\{loaded\.block\} /);
  // the close, the same way
  const actions = component('ListingActions.jsx');
  assert.match(actions, /const closedHere = done !== null && \(terms\.why === 'closed' \|\| readBlock === null \|\| readBlock < done\.block\);/);
  assert.match(actions, /\{done && !closedHere && <p className="error" role="alert" data-testid="close-dropped">\{fill\(C\.dropped, \{ id: listingId, tx: done\.tx \}\)\}<\/p>\}/);
  assert.match(page, /<CloseListing listingId=\{listingId\} listing=\{l\} readBlock=\{loaded\.block\} onChanged=\{refresh\} \/>/);
  for (const [at, text] of [['roll.dropped', STRINGS.roll.dropped], ['close.dropped', STRINGS.close.dropped], ['chain.openingDropped', STRINGS.chain.openingDropped], ['fund.replaced', STRINGS.fund.replaced]]) {
    oneLine(at, text);
    assert.deepEqual(wordingProblems(text), [], at);
    assert.match(text, at === 'fund.replaced' ? /^Nothing was sent/ : /is not on the chain as this page now reads it/, at);
  }
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
  assert.match(body, /const blockTag = await blockNow\(provider\);\s*const \[mine, now\] = await Promise\.all\(\[listingAt\(reader, listingId, blockTag\), readHold\(reader, listingId, \{ blockTag \}\)\]\);/);
  // a hold has no way back: it is sent only for the listing the page showed, the same artifact and the same maker's.
  // Another listing under the id, or none, sends nothing, takes the confirmation back and reads the page again.
  assert.match(body, /if \(!sameListing\(mine, listing\)\) \{\s*setError\(fill\(STRINGS\.fund\.replaced, \{ id: listingId \}\)\);\s*setAsking\(false\);\s*onChanged\(blockTag\);\s*return undefined;\s*\}\s*if \(!holdTerms\(mine, now\)\.can/);
  assert.ok(body.indexOf('if (!sameListing(mine, listing))') < body.indexOf('.hold(BigInt(listingId))'), 'before hold() is sent');
  assert.match(body, /if \(!holdTerms\(mine, now\)\.can \|\| !same\(mine\.maker, sender\)\) \{\s*setError\(fill\(H\.changed, \{ id: listingId \}\)\);/);
  // the receipt, also of the same call sent again at a higher fee; this contract's Held event for this listing is the
  // hold and its time; and the page says it with the mined transaction, and is told the block to read from
  assert.match(body, /const receipt = await minedReceipt\(tx\);\s*\/\/[^\n]*\n\s*const held = heldEvent\(reader, receipt, listingId\);/);
  assert.match(actions, /if \(!same\(log\.address, contract\.target\)\) continue;[\s\S]*?if \(event\?\.name === 'Held' && event\.args\.listingId === BigInt\(listingId\)\) return event;/);
  // a mined transaction whose receipt shows no hold: never "nothing was sent", but which transaction it was, and no hold claimed
  assert.match(body, /if \(!held\) \{[\s\S]*?setError\(fill\(H\.notConfirmed, \{ id: listingId, tx: receipt\.hash \}\)\);\s*onChanged\(receipt\.blockNumber\);\s*return undefined;\s*\}\s*setDone\(\{ tx: receipt\.hash, heldAt: held\.args\.heldAt \}\);\s*onHeld\(held\.args\.heldAt, receipt\.blockNumber\);/);
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
  assert.match(page, /const block = Number\(await provider\.send\('eth_blockNumber', \[\]\)\);\s*const at = \{ blockTag: block \};\s*if \([^\n]*\) return \{ missing: true, block \};\s*const \[listing, hold, takesCommits\] = await Promise\.all\(\[sa\.getListing\(id, at\), readHold\(sa, id, at\), sa\.acceptsCommits\(id, at\)\]\);\s*return \{ listing, hold, takesCommits, block \};/);
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
