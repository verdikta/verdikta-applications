// The client names the contract's enums as StakeAttestation.sol declares them (and as the server's
// record mirror writes them), read from the source here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CLAIM_STATES, CLASSES, DISPUTE_RESULTS, LISTING_STATES, OUTCOMES } from '../src/chain/abi.js';
import { STRINGS } from '../src/strings.js';

const SOURCE = fs.readFileSync(new URL('../../onchain/contracts/StakeAttestation.sol', import.meta.url), 'utf8');
function declared(name) {
  const m = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(SOURCE);
  assert.ok(m, name);
  return m[1].split(',').map((s) => s.trim());
}

test('the client\'s enum names are the contract\'s, in declaration order', () => {
  assert.deepEqual(LISTING_STATES, declared('ListingState'));
  assert.deepEqual(CLAIM_STATES, declared('ClaimState'));
  assert.deepEqual(OUTCOMES, declared('Outcome'));
  assert.deepEqual(DISPUTE_RESULTS, declared('DisputeResult'));
  assert.deepEqual(CLASSES, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
});

test('every listing state, claim state, dispute result and artifact kind has its words', () => {
  for (const s of LISTING_STATES) assert.equal(typeof STRINGS.enums.listingStates[s], 'string', s);
  for (const s of CLAIM_STATES) assert.equal(typeof STRINGS.enums.claimStates[s], 'string', s);
  for (const s of DISPUTE_RESULTS) assert.equal(typeof STRINGS.enums.disputes[s], 'string', s);
  for (const k of declared('ArtifactKind')) assert.equal(typeof STRINGS.enums.kinds[k], 'string', k);
});
