// Testnet only, for now: nothing defaults to mainnet and a mainnet RPC is refused on every chain verb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { spawnCli } from './helpers/cli.js';
import { FINDING, makeClaimDir } from './helpers/world.js';

async function fakeRpc(chainIdHex) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString());
      const one = (c) => (c.method === 'eth_chainId' ? { jsonrpc: '2.0', id: c.id, result: chainIdHex } : { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'stop here' } });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(call) ? call.map(one) : one(call)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const envOn = (url) => ({
  PATH: process.env.PATH,
  VERDIKTA_RPC_URL: url,
  VERDIKTA_CONTRACT: `0x${'11'.repeat(20)}`,
  VERDIKTA_WALLET_KEY: `0x${'59'.repeat(32)}`,
  VERDIKTA_IPFS_GATEWAY: 'http://127.0.0.1:1',
  VERDIKTA_PIN_BACKEND: 'kubo',
  VERDIKTA_PIN_URL: 'http://127.0.0.1:1',
});

test('Base mainnet (8453), or any chain but Base Sepolia and a local node, is refused on every verb', async () => {
  for (const id of ['0x2105', '0x1']) {
    const rpc = await fakeRpc(id);
    for (const args of [['commit', makeClaimDir(), '--listing', '1', '--yes'], ['reveal', makeClaimDir()], ['status', '1'], ['claim', '1'], ['check', makeClaimDir(), '--listing', '1']]) {
      const r = await spawnCli(args, { ...envOn(rpc.url), CODE_RUNNER_URL: 'http://127.0.0.1:1', CODE_RUNNER_TOKEN: 'x'.repeat(32) });
      assert.equal(r.code, 1, `${args[0]}: ${r.stderr}`);
      assert.match(r.stderr, /NETWORK_NOT_ALLOWED/, args[0]);
    }
    await rpc.close();
  }
});

test('the default RPC is Base Sepolia, never mainnet', async () => {
  const { DEFAULT_RPC_URL, ALLOWED_CHAIN_IDS } = await import('../src/index.js');
  assert.match(DEFAULT_RPC_URL, /sepolia/);
  assert.deepEqual([...ALLOWED_CHAIN_IDS].sort(), [31337n, 84532n].sort());
  assert.equal(FINDING.version, 1);
});

test('no contract address, no gateway: a usage error that names them', async () => {
  const r = await spawnCli(['status', '1'], { PATH: process.env.PATH, VERDIKTA_RPC_URL: 'http://127.0.0.1:1' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /VERDIKTA_CONTRACT/);
});
