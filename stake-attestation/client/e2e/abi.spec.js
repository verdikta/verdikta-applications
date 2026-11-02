// The client's StakeAttestation ABI (src/chain/abi.js, the fragments it calls) is the contract's:
// each fragment, in full, equals the one in the merged ABI compiled from onchain/ for this run.
import { Interface } from 'ethers';

import { STAKE_ATTESTATION_ABI } from '../src/chain/abi.js';
import { expect, test } from './support/fixtures.js';

test('every fragment the client uses is the compiled contract\'s', async ({ stack }) => {
  const compiled = new Interface(stack.abi);
  const client = new Interface(STAKE_ATTESTATION_ABI);
  expect(client.fragments.length).toBe(STAKE_ATTESTATION_ABI.length);
  for (const f of client.fragments) {
    const match = f.type === 'event' ? compiled.getEvent(f.name) : compiled.getFunction(f.name);
    expect(match, `${f.type} ${f.name} is in the contract`).toBeTruthy();
    expect(f.format('full')).toBe(match.format('full'));
  }
});
