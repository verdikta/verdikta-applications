// Node P47: the "Commits" section of a listing's own page says "the site offers it to hunters" only of a listing that
// counts and takes commits now. One value decides it: the contract's acceptsCommits(listingId), read in the snapshot
// the page reads the listing in. The rule is held here to the contract's source and to the page's code; the browser
// cases hold it on a page, state by state (e2e/hold.spec.js, listing-life.spec.js, maker-actions.spec.js,
// project-decides.spec.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interface } from 'ethers';

import { wordingProblems } from '../e2e/support/wording.js';
import { STAKE_ATTESTATION_ABI } from '../src/chain/abi.js';
import { STRINGS } from '../src/strings.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const SOURCE = read('../../onchain/contracts/StakeAttestation.sol');
/** One function of the contract's source, by name, to its closing brace at the function's indent. */
const solidity = (name) => {
  const m = new RegExp(`\\n {4}function ${name}\\([\\s\\S]*?\\n {4}\\}`).exec(SOURCE);
  assert.ok(m, `function ${name}`);
  return m[0];
};
/** A component's code without its comments: what it does, not what it says it does. */
const codeOf = (name) => read(`../src/components/${name}`)
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '');
/** One function of a component, by its opening words, to its closing brace at the start of a line. */
const part = (code, opening) => {
  const from = code.indexOf(opening);
  assert.ok(from > -1, opening);
  return code.slice(from, code.indexOf('\n}\n', from));
};
const O = STRINGS.offer;

test('the contract\'s view: a listing takes a commit while it is Open, its paid period is not over, its escrow is at least the top award and it is not on hold', () => {
  assert.match(solidity('acceptsCommits'), /function acceptsCommits\(uint256 listingId\) public view returns \(bool\) \{\s*Listing storage l = _mustListing\(listingId\);\s*return l\.state == ListingState\.Open\s*&& block\.timestamp < l\.fundedUntil\s*&& l\.escrowWei >= l\.awards\[3\]\s*&& _heldAt\[listingId\] == 0;/);
  // it is what commit() itself asks, so the page's sentence and the contract's refusal are one rule
  assert.match(solidity('commit'), /require\(acceptsCommits\(listingId\), "not accepting commits"\);/);
  // and the client's ABI has it as the contract declares it (e2e/abi.spec.js compares it with the compiled ABI)
  assert.equal(new Interface(STAKE_ATTESTATION_ABI).getFunction('acceptsCommits').format('full'), 'function acceptsCommits(uint256 listingId) view returns (bool)');
});

test('the page reads it in the listing\'s own snapshot, on the same contract, with no catch and no value in its place', () => {
  const page = codeOf('FundPage.jsx');
  const fn = part(page, 'async function readListing(');
  // the count, the listing, its hold and acceptsCommits: one callback of one snapshot, each on the snapshot's contract
  assert.match(fn, /await snapshot\(await chainReader\(\), async \(at\) => \{\s*const view = stakeAttestation\(at\);\s*const listing = await listingAt\(view, listingId\);\s*if \(listing === null\) return \{ missing: true \};\s*return \{ listing, hold: await readHold\(view, listingId\), takesCommits: await view\.acceptsCommits\(BigInt\(listingId\)\) \};\s*\}\);/);
  // a call that fails rejects the snapshot, as the listing's own does: nothing here catches it or answers for it
  assert.doesNotMatch(fn, /catch|\?\?|\|\||\? true|\? false/);
  // it is the client's only read of the view: no component asks it again, at another block
  const sources = fs.readdirSync(new URL('../src/components/', import.meta.url)).filter((f) => /\.jsx?$/.test(f)).map((f) => codeOf(f));
  for (const dir of ['../src/lib/', '../src/chain/']) for (const f of fs.readdirSync(new URL(dir, import.meta.url))) if (f.endsWith('.js')) sources.push(read(`${dir}${f}`));
  assert.equal(sources.join('\n').split('.acceptsCommits(').length - 1, 1, 'read in one place');
  // and the page hands that value, of that read, to the section
  assert.match(page, /<ListingMore listingId=\{listingId\} listing=\{l\} hold=\{hold\} takesCommits=\{loaded\.takesCommits\} quiet=\{quiet\} onChanged=\{onChanged\} \/>/);
  const extras = codeOf('ListingExtras.jsx');
  assert.match(extras, /export function ListingMore\(\{ listingId, listing, hold = NO_HOLD, takesCommits = false, quiet = false, onChanged = \(\) => \{\} \}\) \{/);
  assert.match(extras, /<CommitOffer data=\{data\} takesCommits=\{takesCommits\} held=\{hold\.held\} quiet=\{quiet\} \/>/);
});

test('the sentence and data-offered follow that one value: offered only when the listing counts and takes commits', () => {
  const offer = part(codeOf('ListingExtras.jsx'), 'function CommitOffer(');
  // with no answer of the chain's handed over, nothing is offered
  assert.match(offer, /^function CommitOffer\(\{ data, takesCommits = false, held = false, quiet = false \}\) \{/);
  assert.match(offer, /const offered = Boolean\(data\.counted\) && takesCommits === true;/);
  // in this order: the site could not read whether it counts; it does not count; it takes commits; it is on hold; else
  assert.match(offer, /let text = held \? O\.held : O\.notTaking;\s*if \(data\.failed\) text = fill\(O\.unknown, \{ reason: data\.failed \}\);\s*else if \(!data\.counted\) text = fill\(O\.no, \{ reason: data\.why \?\? STRINGS\.notCounted\.none \}\);\s*else if \(offered\) text = O\.yes;/);
  assert.equal(offer.split('O.yes').length - 1, 1, 'said in one place, under `offered`');
  assert.match(offer, /data-testid="commit-offer" data-offered=\{String\(offered\)\}>/);
  assert.equal(offer.split('data-offered').length - 1, 1);
  // one paragraph, and no reason by state: the section reads nothing of the listing but that value and its hold
  assert.equal(offer.split('<p>').length - 1, 1);
  assert.doesNotMatch(offer, /listing\b|state|LISTING_STATES|fundedUntil|escrow/);
  // while the page knows its read is behind it says nothing, as before
  assert.match(offer, /if \(!data \|\| quiet\) return null;/);
});

test('the sentences: four as they were, character for character, and one for a counted listing that takes no commits', () => {
  assert.deepEqual(Object.keys(O), ['title', 'yes', 'no', 'unknown', 'held', 'notTaking']);
  assert.equal(O.title, 'Commits');
  assert.equal(O.yes, 'This listing counts: its builder\'s signature and the project\'s proof check, and the site offers it to hunters.');
  assert.equal(O.no, 'This site offers no commit on this listing: {reason}');
  assert.equal(O.unknown, 'This site could not read whether this listing counts: {reason}. It offers no commit until it can.');
  assert.equal(O.held, 'This listing counts, and its maker has it on hold: it takes no commit, so the site does not offer it to hunters. A finding can still be filed on it as a late claim, which carries no award.');
  assert.equal(O.notTaking, 'This listing counts, and it takes no commits now, so the site does not offer it to hunters.');
  // one sentence, one line, no value to fill in, and no reason by state
  assert.match(O.notTaking, /^[^.\n{}]+\.$/);
  assert.doesNotMatch(O.notTaking, /closed|rolled|depleted|lapsed|escrow|fee|hold/i);
  // only `yes` says the site offers the listing
  for (const [key, text] of Object.entries(O)) assert.equal(/offers it to hunters/.test(text), key === 'yes', key);
  for (const [key, text] of Object.entries(O)) assert.deepEqual(wordingProblems(text), [], key);
});
