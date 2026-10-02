import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedApiOrigin, deployments } from '../_transaction-guards.js';

test('the bot API key only goes to the reviewed origin of the configured network', () => {
  assert.equal(reviewedApiOrigin('base'), 'https://bounties.verdikta.org');
  assert.equal(reviewedApiOrigin('base-sepolia'), 'https://bounties-testnet.verdikta.org');
  for (const network of Object.keys(deployments)) assert.equal(`${reviewedApiOrigin(network)}/api/docs`, deployments[network].docsUrl);
  assert.equal(reviewedApiOrigin('base', 'https://bounties.verdikta.org/'), 'https://bounties.verdikta.org');
  assert.throws(() => reviewedApiOrigin('base', 'https://bounties-testnet.verdikta.org'), /reviewed network API origin/);
  assert.throws(() => reviewedApiOrigin('base-sepolia', 'https://evil.example'), /reviewed network API origin/);
  assert.throws(() => reviewedApiOrigin('base', 'http://bounties.verdikta.org'), /reviewed network API origin/);
  assert.throws(() => reviewedApiOrigin('mainnet'), /No reviewed API origin/);
});
