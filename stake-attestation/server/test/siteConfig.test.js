// The chain half of the server's config (node P4b1): the deployment, the indexer's depth and
// window, the keeper, the archive gateways. Credentials stay out of it: the RPC URL (which may
// carry a provider key in its path) and the keeper's private key are named, never held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ConfigError, loadConfig } from '../src/config.js';
import { createChainProvider, createSite } from '../src/site/index.js';
import { quietLogger } from './helpers/http.js';

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

/** A JSON-RPC endpoint on loopback that answers a few methods and counts every call. */
async function fakeRpc({ chainId }) {
  const calls = [];
  let height = 100;
  const block = (n) => ({
    number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, '0')}`, parentHash: `0x${(n - 1).toString(16).padStart(64, '0')}`,
    timestamp: '0x6553f100', nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0',
    miner: '0x0000000000000000000000000000000000000000', extraData: '0x', baseFeePerGas: '0x1', transactions: [],
    logsBloom: `0x${'0'.repeat(512)}`, sha3Uncles: `0x${'0'.repeat(64)}`, stateRoot: `0x${'0'.repeat(64)}`, receiptsRoot: `0x${'0'.repeat(64)}`, transactionsRoot: `0x${'0'.repeat(64)}`, mixHash: `0x${'0'.repeat(64)}`, size: '0x1', uncles: [],
  });
  const answer = ({ id, method, params }) => {
    calls.push(method);
    if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: `0x${chainId.toString(16)}` };
    if (method === 'eth_blockNumber') return { jsonrpc: '2.0', id, result: `0x${height.toString(16)}` };
    if (method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id, result: block(Number(params[0])) };
    if (method === 'eth_getCode') return { jsonrpc: '2.0', id, result: '0x6080' };
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method} here` } };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(answer) : answer(msg)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)), setHeight: (h) => { height = h; } };
}

test('the production provider: the indexer asks the endpoint for its chain id, so a wrong SA_RPC_URL is refused', async () => {
  const rpc = await fakeRpc({ chainId: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-provider-'));
  const env = { ...base, SA_RPC_URL: rpc.url, SA_DATA_DIR: dir, SA_KEEPER: 'off' };
  const config = loadConfig(env);
  const provider = createChainProvider(config, env);
  const site = createSite({ config, provider, env, fetchArchive: async () => { throw new Error('none'); }, logger: quietLogger() });
  try {
    await assert.rejects(site.sync(), (e) => e.code === 'WRONG_CHAIN');
    assert.ok(rpc.calls.includes('eth_chainId'));
    assert.equal(site.store.state.cursor, null);
  } finally {
    site.close();
    provider.destroy();
    await rpc.close();
  }
});

test('the production provider caches nothing: a block read twice is asked for twice', async () => {
  const rpc = await fakeRpc({ chainId: 84532 });
  const env = { ...base, SA_RPC_URL: rpc.url };
  const provider = createChainProvider(loadConfig(env), env);
  try {
    const a = await provider.getBlock(7);
    const b = await provider.getBlock(7);
    assert.equal(a.hash, b.hash);
    assert.equal(rpc.calls.filter((m) => m === 'eth_getBlockByNumber').length, 2);
    await provider.getBlockNumber();
    rpc.setHeight(101);
    assert.equal(await provider.getBlockNumber(), 101, 'no stale head either');
  } finally {
    provider.destroy();
    await rpc.close();
  }
});
