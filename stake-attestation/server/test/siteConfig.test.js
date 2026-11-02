// The chain half of the server's config (node P4b1): the deployment, the indexer's depth and
// window, the keeper, the archive gateways. Credentials stay out of it: the RPC URL (which may
// carry a provider key in its path) and the keeper's private key are named, never held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { ConfigError, loadConfig } from '../src/config.js';
import { createChainProvider } from '../src/site/index.js';

const ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const base = { SA_CONTRACT_ADDRESS: ADDRESS.toLowerCase(), SA_CHAIN_ID: '84532', SA_FROM_BLOCK: '1000' };

test('no deployment, no chain: the listing flow runs alone', () => {
  assert.equal(loadConfig({}).chain, null);
});

test('a deployment: its address, chain, start block and the indexer\'s defaults', () => {
  const c = loadConfig(base);
  assert.equal(c.chain.address, ADDRESS);
  assert.equal(c.chain.chainId, 84532);
  assert.equal(c.chain.fromBlock, 1000);
  assert.equal(c.chain.confirmations, 10);
  assert.equal(c.chain.reorgWindowBlocks, 512);
  assert.equal(c.chain.chunkBlocks, 2000);
  assert.equal(c.chain.rpcUrlEnv, 'SA_RPC_URL');
  assert.ok(path.isAbsolute(c.chain.dataDir));
  assert.equal(c.keeper.enabled, true);
  assert.equal(c.keeper.keyEnv, 'SA_KEEPER_PRIVATE_KEY');
  assert.equal(c.keeper.expire, false);
  assert.deepEqual(c.archives.gateways, []);
});

test('the deployment\'s chain id and start block are required, and the depth is bounded by the window', () => {
  assert.throws(() => loadConfig({ SA_CONTRACT_ADDRESS: ADDRESS }), (e) => e instanceof ConfigError && /SA_CHAIN_ID/.test(e.message));
  assert.throws(() => loadConfig({ ...base, SA_FROM_BLOCK: '' }), (e) => /SA_FROM_BLOCK/.test(e.message));
  assert.throws(() => loadConfig({ ...base, SA_CONTRACT_ADDRESS: '0x1234' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, SA_CONFIRMATIONS: '600' }), (e) => /SA_REORG_WINDOW_BLOCKS/.test(e.message));
  assert.throws(() => loadConfig({ ...base, SA_KEEPER: 'maybe' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, SA_IPFS_GATEWAYS: 'ftp://gateway.example' }), ConfigError);
  assert.deepEqual(loadConfig({ ...base, SA_IPFS_GATEWAYS: 'https://a.example/, https://b.example' }).archives.gateways, ['https://a.example', 'https://b.example']);
});

test('the RPC URL is read when the provider is made, never kept in the config', () => {
  const url = 'https://base-sepolia.example/v2/a-provider-key-in-the-path';
  const env = { ...base, SA_RPC_URL: url };
  const c = loadConfig(env);
  assert.equal(JSON.stringify(c).includes('a-provider-key'), false);
  assert.throws(() => loadConfig({ ...base, SA_RPC_URL: 'http://rpc.example' }), (e) => /SA_RPC_URL/.test(e.message) && !e.message.includes('rpc.example'));
  assert.throws(() => createChainProvider(c, {}), (e) => e.code === 'RPC_URL_MISSING');
  const provider = createChainProvider(c, env);
  assert.equal(typeof provider.getBlockNumber, 'function');
  provider.destroy();
});
