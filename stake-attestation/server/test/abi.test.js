// The ABI the server runs with (node P4b1). The server never compiles: it reads the contract
// through src/chain/abi/StakeAttestation.json, the merged ABI of onchain/deploy/helpers.js
// (StakeAttestation plus the lens views it answers at its own address). This test fails when the
// committed file is not the merged ABI of the contracts in ../onchain (`npm run abi` rewrites it),
// or when the enum names the server writes are not the contract's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENUMS, FEED_EVENTS, STAKE_ATTESTATION_ABI } from '../src/chain/abi.js';
import { solidityEnums } from './helpers/abiJson.js';
import { hardhat, mergedAbi } from './helpers/chain.js';

test('the committed ABI is onchain\'s merged ABI', async () => {
  const hre = await hardhat();
  assert.deepEqual(STAKE_ATTESTATION_ABI, mergedAbi(hre));
});

test('the enum names are the contract\'s, in declaration order', () => {
  assert.deepEqual(ENUMS, solidityEnums());
});

test('the feed carries the events of design §13.4, Disclosed, and every other event of a listing or a claim', () => {
  const events = STAKE_ATTESTATION_ABI.filter((f) => f.type === 'event');
  for (const name of ['Listed', 'Opened', 'Committed', 'Flagged', 'Released', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RolledForward', 'Renewed', 'Closed', 'LateClaim', 'Disclosed']) {
    assert.ok(FEED_EVENTS.includes(name), name);
  }
  for (const e of events) {
    const tied = e.inputs.some((i) => i.name === 'listingId' || i.name === 'claimId');
    assert.equal(FEED_EVENTS.includes(e.name), tied, `${e.name}: in the feed exactly when it is about a listing or a claim`);
  }
});
