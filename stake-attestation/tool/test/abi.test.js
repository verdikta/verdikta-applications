// The ABI the tool runs with is the merged ABI of the contracts in ../onchain (`npm run abi` rewrites it).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STAKE_ATTESTATION_ABI } from '../src/abi.js';
import { hardhat, mergedAbi } from './helpers/chain.js';

test('the committed ABI is onchain\'s merged ABI', async () => {
  assert.deepEqual(STAKE_ATTESTATION_ABI, mergedAbi(await hardhat()));
});
