// Chain reads (src/chain/wallet.js) are checked to come from the site's chain before anything
// read is shown or funded.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WalletError, verifyChain } from '../src/chain/wallet.js';

test('reads are checked to come from the site\'s chain', async () => {
  const provider = (id) => ({ send: async (m) => { assert.equal(m, 'eth_chainId'); return id; } });
  await verifyChain(provider('0x7a69'), 31337);
  await assert.rejects(verifyChain(provider('0x1'), 31337), (e) => e instanceof WalletError && e.code === 'wrongChain' && e.vars.actual === 1 && e.vars.expected === 31337);
});
