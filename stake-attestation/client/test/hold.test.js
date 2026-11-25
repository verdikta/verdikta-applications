// Node P42: the maker's hold on a listing's page (StakeAttestation.hold, node P39). A hold stops new commits on a
// listing at once, before the fix it rolls forward to is public; it leaves every pending claim alone, and it has no
// resume. What the page says of it is held here to the contract's source, statement by statement, and the reader of
// the contract's heldAt view is held to the one rule that keeps the site true against a contract deployed before the
// hold: a call the contract REFUSES means "no hold here", and a call that fails any other way is a failed read, never
// "not on hold". What the page says of the listing after a read, a transaction or a disagreement is another file's:
// test/pageSays.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Contract, Interface, JsonRpcApiProvider, Network } from 'ethers';

import { wordingProblems } from '../e2e/support/wording.js';
import { LISTING_STATES, STAKE_ATTESTATION_ABI } from '../src/chain/abi.js';
import { NO_HOLD, holdTerms, readHold, refusedByContract, sameListing } from '../src/lib/hold.js';
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
// before the hold answers for heldAt, and what the first two shapes carry, both as measured. In each of these the node
// hands over the revert's data, which is the one thing the reader goes by.
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
  'a wallet that wraps its node\'s answer, the revert\'s data inside': { code: -32603, message: 'Internal JSON-RPC error.', data: { code: 3, message: 'execution reverted: unknown function', data: UNKNOWN_FUNCTION } },
  'a revert with a reason': { code: 3, message: 'execution reverted: no such view', data: '0x08c379a0' + '0'.repeat(62) + '20' + '0'.repeat(62) + '0c' + Buffer.from('no such view').toString('hex').padEnd(64, '0') },
});
// An error that says "revert" somewhere and hands over no revert data. The contract deployed before the hold never
// answers so (its lens's fallback reverts with data), and a word in an error is not the contract's: each of these is a
// failed read. The last is a wallet passing on a library's own wording over a block its node did not have: taken as
// "no hold", it would show a listing that is on hold as one that takes claims.
const NO_REVERT_DATA = Object.freeze({
  'a node that returns no data for an empty revert': { code: -32000, message: 'execution reverted' },
  'a wallet that wraps its node\'s answer, with no data': { code: -32603, message: 'Internal JSON-RPC error.', data: { code: -32000, message: 'execution reverted' } },
  'a node that says it in its data, in words': { code: -32015, message: 'VM execution error.', data: 'Reverted 0x' },
  'a wallet that says "missing revert data" over a block the node does not have': { code: -32603, message: 'missing revert data', data: { code: -32000, message: 'header not found' } },
  'the same, the wording nested': { code: -32603, message: 'Internal JSON-RPC error.', data: { code: -32000, message: 'header not found', cause: { message: 'missing revert data (action="call", data=null, reason=null)' } } },
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

test('readHold: the view\'s answer, and whether the listing is on hold by it', async () => {
  await withNode(() => ({ result: word(0) }), async (sa, node) => {
    assert.deepEqual(await readHold(sa, 7n), { supported: true, heldAt: 0n, held: false });
    // one eth_call, of heldAt(7). It names no block of its own: the contract it is given is a snapshot's
    // (chain/snapshot.js), whose every call is made at that snapshot's block (test/snapshot.test.js)
    assert.equal(node.calls.length, 1);
    assert.equal(node.calls[0].method, 'eth_call');
    assert.equal(node.calls[0].params[0].data, sa.interface.encodeFunctionData('heldAt', [7n]));
    assert.equal(readHold.length, 2, 'the contract and the listing: no block is handed in');
  });
  await withNode(() => ({ result: word(HELD_AT) }), async (sa) => {
    assert.deepEqual(await readHold(sa, '7'), { supported: true, heldAt: HELD_AT, held: true });
  });
  // The view itself answers 0 for a listing that is neither Open nor Depleted: a hold ends in a roll forward or a
  // close, and the page needs no rule of its own for that.
  assert.match(fn(SOURCE, 'heldAt'), /s == ListingState\.Open \|\| s == ListingState\.Depleted \? _heldAt\[listingId\] : 0/);
});

test('readHold: a call the contract refuses means a contract with no hold, by the revert data the node hands over', async () => {
  for (const [name, error] of Object.entries(REFUSALS)) {
    await withNode(() => ({ error }), async (sa) => {
      assert.deepEqual(await readHold(sa, 7n), { supported: false, heldAt: 0n, held: false }, name);
    });
  }
  // and the two measured answers of the contract deployed today are among them, with the lens's own revert as data
  for (const name of ['the deployed contract with no hold, over a public node', 'the same refusal on the local development node']) {
    assert.ok(JSON.stringify(REFUSALS[name]).includes(UNKNOWN_FUNCTION), name);
  }
  // why a contract from before the hold refuses: a selector StakeAttestation does not implement goes to the lens, whose
  // fallback reverts with these words
  assert.match(SOURCE, /fallback\(\) external \{\s*\(bool ok, bytes memory ret\) = address\(this\)\.staticcall\(\s*abi\.encodeWithSelector\(this\.lensDelegate\.selector, msg\.data\)/);
  assert.match(LENS, /fallback\(\) external \{[^}]*revert\("unknown function"\);/);
  assert.equal(new Interface(['error Error(string)']).decodeErrorResult('Error', UNKNOWN_FUNCTION)[0], 'unknown function');
  assert.deepEqual(NO_HOLD, { supported: false, heldAt: 0n, held: false });
  assert.ok(Object.isFrozen(NO_HOLD));
});

test('readHold: an error with no revert data is a failed read, never "no hold", whatever its words say (R1-F9)', async () => {
  for (const [name, error] of Object.entries(NO_REVERT_DATA)) {
    await withNode(() => ({ error }), async (sa) => {
      await assert.rejects(readHold(sa, 7n), (err) => {
        assert.equal(err.code, 'CALL_EXCEPTION', name);
        assert.equal(err.data, null, `${name}: ethers kept no revert data`);
        assert.equal(refusedByContract(err), false, name);
        return true;
      }, name);
    });
  }
  // the reader reads no word of an error: not the node's, not a wallet's
  const lib = read('../src/lib/hold.js');
  assert.match(lib, /export function refusedByContract\(err\) \{\s*return err\?\.code === 'CALL_EXCEPTION' && typeof err\.data === 'string';\s*\}/);
  assert.doesNotMatch(lib.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, ''), /textsOf|\.info\b|\.message\b|\.test\(|\/i\b/);
});

test('readHold: a read that fails another way is a failed read, never "not on hold"', async () => {
  for (const [name, error] of Object.entries(FAILURES)) {
    await withNode(() => ({ error }), async (sa) => {
      await assert.rejects(readHold(sa, 7n), (err) => {
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

test('refusedByContract: only a revert the node reports, by the revert\'s own data', () => {
  assert.equal(refusedByContract(null), false);
  assert.equal(refusedByContract(new Error('execution reverted')), false, 'not ethers\' CALL_EXCEPTION');
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION', data: '0x' }), true, 'the revert\'s data, empty');
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION', data: UNKNOWN_FUNCTION }), true, 'the lens\'s own revert');
  // no data: whatever the error says, in whatever place
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION', data: null, info: { error: { code: -32000, message: 'execution reverted' } } }), false);
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION', data: null, shortMessage: 'missing revert data', info: { error: { code: -32603, message: 'missing revert data', data: { message: 'header not found' } } } }), false);
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION', data: null, info: { error: { code: -32000, message: 'header not found' } } }), false);
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION', data: null }), false);
  assert.equal(refusedByContract({ code: 'CALL_EXCEPTION' }), false);
  assert.equal(refusedByContract({ code: 'NETWORK_ERROR', data: '0x' }), false);
});

const listing = (state, o = {}) => ({ state: BigInt(LISTING_STATES.indexOf(state)), maker: ADDRESS, pendingClaims: 0n, owedWei: 0n, ...o });

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

// ---------------------------------------------------------------- the action, on the page
const NAMED = Object.freeze([/sepolia/i, /mainnet/i, /testnet/i, /\bbase\b/i, /faucet/i, /https?:/i, /\b0x[0-9a-f]{4,}/i, /github/i, /\.(org|com|io)\b/i, /@/]);
const holdStrings = () => Object.entries(H).flatMap(([k, v]) => (typeof v === 'string' ? [[`STRINGS.hold.${k}`, v]] : Object.entries(v).map(([k2, v2]) => [`STRINGS.hold.${k}.${k2}`, v2])));
const holdSection = () => {
  const actions = component('ListingActions.jsx');
  const body = actions.slice(actions.indexOf('export function HoldListing('), actions.indexOf('\n}\n', actions.indexOf('export function HoldListing(')));
  assert.ok(body.length > 0, 'HoldListing, in ListingActions.jsx');
  return body;
};

test('every string of the hold is one line, names no network, faucet, host or account, and passes the wording check', () => {
  const all = holdStrings();
  assert.ok(all.length >= 13, all.map(([k]) => k).join());
  for (const [at, text] of all) {
    oneLine(at, text);
    assert.deepEqual(wordingProblems(text), [], at);
    for (const re of NAMED) assert.equal(re.test(text), false, `${at} names ${re}: ${text}`);
  }
  // "on hold", as the badge says it: a stake that is "held" could be read as one that is in place
  for (const [at, text] of all) assert.doesNotMatch(text, /\bheld\b/i, at);
  assert.equal(fill(H.since, { time: 'T' }), 'This listing is on hold since T.');
  assert.equal(fill(H.ask, { id: 7 }), 'Hold listing 7');
  assert.match(fill(H.confirm, { id: 7 }), /^Hold listing 7 now/);
});

test('the action is offered to the listing\'s maker only, and to no other wallet', () => {
  const body = holdSection();
  // the connected wallet, compared with the listing's maker: without one, or with another, there is no button
  assert.match(body, /const account = w\.wallet\?\.account \?\? null;/);
  assert.match(body, /const isMaker = account !== null && same\(account, listing\.maker\);/);
  assert.match(body, /if \(!isMaker\) action = <p className="hint" data-testid="hold-maker-only">\{H\.makerOnly\}<\/p>;/);
  assert.equal(body.split('<button').length - 1, 3, 'ask, confirm and keep: each inside the maker\'s branch');
  assert.ok(body.indexOf('if (!isMaker) action =') < body.indexOf('<button'), 'the buttons come after the check');
  assert.match(H.makerOnly, /^Only this listing's maker can hold it/);
  // and the wallet that sends is checked again, since it can change between the page and the click
  assert.match(body, /const \{ signer, provider, account: sender \} = await w\.ensure\(\);\s*if \(!same\(sender, asking\.maker\)\) /);
  assert.match(body, /fill\(STRINGS\.claim\.notMaker, \{ maker: asking\.maker, account: sender \}\)/);
  // the contract's own rule
  assert.match(fn(LOGIC, 'hold'), /require\(msg\.sender == l\.maker, "not maker"\);/);
});

test('the action asks for confirmation before anything is sent, reads the listing and its hold again at one block, and reports the transaction', () => {
  const body = holdSection();
  // two steps before the wallet's own, as close(): the first button only asks
  assert.match(body, /const \[asking, setAsking\] = useState\(null\);/);
  assert.match(body, /<button type="button" className="danger" onClick=\{send\} disabled=\{busy\}>\s*\{busy \? H\.sending : fill\(H\.confirm, \{ id: listingId \}\)\}/);
  assert.match(body, /<button type="button" className="secondary" onClick=\{\(\) => setAsking\(null\)\} disabled=\{busy\}>\{H\.keep\}<\/button>/);
  // R1-F3: the first step is taken for one listing, by its maker and artifact, and is kept with them. The
  // confirmation is drawn only while that listing is the one on display, and is taken for that listing alone: if the
  // page comes to show another of the maker's listings under the id, the first step is to take again.
  assert.match(body, /onClick=\{\(\) => \{ setError\(null\); setAsking\(\{ maker: listing\.maker, artifactHash: listing\.artifactHash \}\); \}\}>\s*\{fill\(H\.ask, \{ id: listingId \}\)\}/);
  assert.match(body, /const confirming = asking !== null && sameListing\(listing, asking\);/);
  assert.match(body, /else if \(confirming\) \{\s*action = \(\s*<p className="actions">/);
  assert.doesNotMatch(body, /else if \(asking\)/, 'never drawn from the first step alone');
  assert.match(body, /const send = async \(\) => \{\s*(?:\/\/[^\n]*\n\s*)?if \(!confirming\) return undefined;/);
  assert.match(body, /if \(!same\(sender, asking\.maker\)\) \{\s*setAsking\(null\);/);
  assert.doesNotMatch(body, /setAsking\((?:true|false)\)/);
  assert.equal(body.split('.hold(BigInt(listingId))').length, 2, 'hold() is sent in one place');
  assert.ok(body.indexOf('const send = async') < body.indexOf('.hold(BigInt(listingId))'), 'inside send');
  // just before sending: the listing and its hold, through the wallet, in one snapshot of one block
  assert.match(body, /const \{ value: \[mine, now\], block \} = await snapshot\(provider, async \(at\) => \{\s*const view = stakeAttestation\(at\);\s*const source = await listingAt\(view, listingId\);\s*return \[source, holdable\(source\) \? await readHold\(view, listingId\) : NO_HOLD\];\s*\}\);/);
  // A hold has no way back: it is sent only for the listing the page showed (the same artifact, the same maker's),
  // and only while that listing can be held. Otherwise nothing is sent, the confirmation is taken back, and the page
  // is told the wallet's read disagreed with it, at that read's block.
  assert.match(body, /const holdable = \(l\) => sameListing\(l, asking\) && holdTerms\(l, NOT_ON_HOLD\)\.can;/);
  assert.match(body, /if \(!holdable\(mine\) \|\| !holdTerms\(mine, now\)\.can\) \{\s*setError\(fill\(H\.changed, \{ id: listingId \}\)\);\s*setAsking\(null\);\s*onChanged\(disagreedAt\(block\)\);\s*return undefined;\s*\}\s*const tx = await stakeAttestation\(signer\)\.hold\(BigInt\(listingId\)\);/);
  assert.doesNotMatch(body, /sameListing\((?:mine|l|source), listing\)/, 'the wallet\'s read is held to the listing of the first step, not to whatever the page shows at the click');
  const shown = { maker: '0xAbC0000000000000000000000000000000000001', artifactHash: `0x${'ab'.repeat(32)}` };
  assert.equal(sameListing({ maker: shown.maker.toLowerCase(), artifactHash: shown.artifactHash.toUpperCase().replace('0X', '0x') }, shown), true);
  assert.equal(sameListing({ ...shown, artifactHash: `0x${'cd'.repeat(32)}` }, shown), false, 'another artifact under the id');
  assert.equal(sameListing({ ...shown, maker: '0xAbC0000000000000000000000000000000000002' }, shown), false, 'another maker\'s');
  assert.equal(sameListing(null, shown), false, 'no listing under the id');
  assert.equal(fill(H.changed, { id: 7 }), 'Nothing was sent: on the chain as your wallet reads it now, listing 7 is not as this page showed it. This page reads it again.');
  // The transaction is reported as the page's other actions report theirs: by the hash it was mined under, also when
  // the wallet sent the call again at a higher fee. The line says the transaction and nothing of what the listing is.
  assert.match(body, /const receipt = await minedReceipt\(tx, onChanged\);\s*setDone\(\{ tx: receipt\.hash \}\);/);
  assert.match(body, /\{done && <p className="ok" data-testid="hold-mined">\{fill\(H\.mined, \{ id: listingId, tx: done\.tx \}\)\}<\/p>\}/);
  assert.equal(fill(H.mined, { id: 7, tx: '0xabc' }), 'The hold() call for listing 7 was mined (transaction 0xabc). What the listing is now is said on this page only from its own read of the chain.');
  assert.doesNotMatch(H.mined, /on hold|push the fix|since|takes no/i);
  assert.match(SOURCE, /event Held\(uint256 indexed listingId, uint64 heldAt\);/);
});

test('against a contract with no hold the page shows no hold action: the section is not drawn at all', () => {
  const body = holdSection();
  assert.match(body, /if \(!hold\.supported\) return null;/);
  assert.ok(body.indexOf('if (!hold.supported) return null;') < body.indexOf('data-testid="hold"'), 'before anything is drawn');
  // a read that fails any other way rejects with the rest of the page's read: "could not be read", never "not on hold"
  assert.doesNotMatch(component('FundPage.jsx'), /readHold\([^)]*\)\.catch/);
  assert.match(read('../src/lib/hold.js'), /if \(refusedByContract\(err\)\) return NO_HOLD;\s*throw err;/);
  // and the roll-forward panel says what it said before the hold existed (test/rollGuidance.test.js has the lines)
  const extras = component('ListingExtras.jsx');
  assert.match(extras, /\{hold\.supported \? \(\s*<>\s*<p className="warning" data-testid="roll-hold-first">/);
  assert.match(extras, /\) : \(\s*<>\s*<p className="warning" data-testid="roll-fix-keep">\{RF\.fix\.keep\}<\/p>/);
});

test('once on hold, the page says so with the time, from its read, and still offers roll forward and close', () => {
  const page = component('FundPage.jsx');
  // the state stays the chain's (Open or Depleted): the hold is said beside it, with its time, and the pill is not green
  assert.match(page, /\{!quiet && <><dt>\{F\.state\}<\/dt><dd data-testid="listing-state"><StatePill state=\{hold\.held \? null : state\} text=\{F\.states\[state\] \?\? state\} \/><\/dd><\/>\}/);
  assert.match(page, /\{!quiet && hold\.held && <><dt>\{F\.heldSince\}<\/dt><dd data-testid="listing-held-since">\{formatTime\(hold\.heldAt\)\}<\/dd><\/>\}/);
  assert.match(page, /\{!quiet && hold\.held && <p className="warning" data-testid="listing-held">\{fill\(F\.held, \{ id: listingId, time: formatTime\(hold\.heldAt\) \}\)\}<\/p>\}/);
  // "open until" is said of a listing that takes claims, never of one on hold
  assert.match(page, /\{!quiet && state === 'Open' && !hold\.held && <p className="ok" data-testid="listing-open-until">\{fill\(F\.alreadyOpen,/);
  assert.equal(fill(STRINGS.fund.held, { id: 7, time: 'T' }).startsWith('Listing 7 is on hold since T: it takes no new claims.'), true);
  assert.match(STRINGS.fund.held, /a late claim/);
  assert.match(STRINGS.fund.held, /The hold ends when the listing is rolled forward or closed\.$/);
  // the hold's own section says since when, and what is left
  const body = holdSection();
  assert.match(body, /if \(!off && hold\.held\) \{\s*body = \(\s*<>\s*<p data-testid="hold-since">\{fill\(H\.since, \{ time: formatTime\(hold\.heldAt\) \}\)\}<\/p>\s*<p className="hint">\{H\.next\}<\/p>/);
  // the commit offer never says the site offers a listing on hold
  const extras = component('ListingExtras.jsx');
  const offer = extras.slice(extras.indexOf('function CommitOffer('), extras.indexOf('\n}\n', extras.indexOf('function CommitOffer(')));
  assert.match(offer, /let text = held \? O\.held : O\.yes;/);
  assert.match(offer, /data-offered=\{String\(Boolean\(data\.counted\) && !held\)\}/);
  assert.match(STRINGS.offer.yes, /the site offers it to hunters\.$/);
  assert.doesNotMatch(STRINGS.offer.held, /offers it to hunters\.$/);
  // roll forward and close are drawn from the listing's state and its pending claims, as before: a hold changes neither
  const roll = extras.slice(extras.indexOf('export function RollForward('), extras.indexOf('function CommitOffer('));
  // no panel for a listing that is neither Open nor Depleted (nor while the page knows its read is behind): only the
  // panel's own error, if it has one
  assert.match(roll, /if \(quiet \|\| !ROLLABLE\.has\(state\)\) return error \? <p className="error" role="alert">\{error\}<\/p> : null;/);
  assert.doesNotMatch(roll, /hold\.held && return|if \(hold\.held\) return/);
  const actions = component('ListingActions.jsx');
  const close = actions.slice(actions.indexOf('export function CloseListing('), actions.indexOf('\n}\n', actions.indexOf('export function CloseListing(')));
  assert.ok(close.length > 0);
  assert.doesNotMatch(close, /\bhold\b|\bheld\b|heldAt/, 'close is offered by its own terms: the pending claims and what is owed');
});

test('a successor is never a listing on hold: the picker leaves it out, the read before sending refuses it, and the panel looks again when asked', () => {
  // the contract would take it: rollForward asks for an Open listing of the maker's with no predecessor, and reads no hold
  const roll = fn(SOURCE, 'rollForward');
  assert.match(roll, /successorListingId != listingId && s\.maker == msg\.sender && s\.state == ListingState\.Open\s*&& s\.predecessor == 0,/);
  assert.doesNotMatch(code(roll), /_heldAt|acceptsCommits/);
  const extras = component('ListingExtras.jsx');
  const panel = extras.slice(extras.indexOf('export function RollForward('), extras.indexOf('function CommitOffer('));
  // the picker: each candidate and its hold, in one snapshot
  assert.match(panel, /const \[s, onHold\] = await Promise\.all\(\[sa\.getListing\(BigInt\(e\.listingId\)\), hold\.supported \? readHold\(sa, e\.listingId\) : NO_HOLD\]\);\s*if \(!onHold\.held && confirmSuccessor\(/);
  // the read before sending: this listing, then the successor and the successor's hold, in one snapshot through the wallet
  assert.match(panel, /return \[source, await listingAt\(sa, pick\), hold\.supported \? await readHold\(sa, pick\) : NO_HOLD\];/);
  assert.match(panel, /if \(successorHold\.held\) \{\s*setAgain\(\(n\) => n \+ 1\);\s*return setHeldSuccessor\(pick\);\s*\}\s*const tx = await stakeAttestation\(signer\)\.rollForward\(/);
  assert.equal(fill(STRINGS.roll.successorOnHold, { id: 9 }), 'Nothing was sent: listing 9 is on hold and takes no commits, so this listing is not rolled forward to it. Choose another listing.');
  // looked for again when asked, where the contract has the hold; against one without, the panel is what it was
  assert.match(panel, /\{hold\.supported && record && !recordReading && \(!identity \|\| options !== null\) && \(\s*<button type="button" className="secondary" data-testid="roll-look-again" onClick=\{lookAgain\}/);
  // a record that did not have this listing yet (the site's mirror trailed its opening), or whose read failed, is
  // read again first; the successors are then looked for by the identity it brings
  assert.match(panel, /const lookAgain = \(\) => \{\s*setError\(null\);\s*setHeldSuccessor\(null\);\s*if \(!identity\) return onRecordAgain\(\);\s*setOptions\(null\);\s*return setAgain\(\(n\) => n \+ 1\);\s*\};/);
  assert.match(extras, /export function useListingRecord\(listingId, artifactHash, opened, again = 0\) \{/);
  assert.match(extras, /\}, \[listingId, artifactHash, opened, again\]\);/);
  assert.match(panel, /\}, \[listingId, listing\.maker, state, identity, hold\.supported, again\]\);/);
  assert.equal(STRINGS.roll.again, 'Look again for listings to roll to');
});
