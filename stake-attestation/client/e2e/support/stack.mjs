#!/usr/bin/env node
// The local stack the Playwright tests run against. playwright.config.js starts it as its web
// server and stops it after the run. One process:
//
//   chain    the in-process Hardhat network with StakeAttestation and the mock aggregator,
//            deployed as the server's chain tests deploy it (server/test/helpers/chain.js),
//            behind Hardhat's own JSON-RPC server: the browser's test wallet and the tests use it
//   gateway  an IPFS gateway stand-in for the ciphertexts hunters pin: GET /ipfs/<cid> serves
//            what a test PUT there. Only the tests PUT; the client only reads.
//   api      the real server (server/src/app.js, configured by its own loadConfig) with mock
//            pinning, dev trust and, as its builder, server/test/fixtures/fake-builder-cli.js:
//            the stand-in the server's builder tests run, which keeps the builder's command
//            line. Its mode (accepted, refused-source, error) is read from builder.json at each
//            build, so a test can change it.
//   client   the production build (vite build, given the addresses above), served by
//            vite preview on 5176 with /api proxied to the api
//
// It writes .e2e/stack.json (untracked) for the tests: the URLs, the contract, the accounts and
// the merged ABI. No key, no secret and no live network: everything is local and per run.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '..', '..');
const SERVER = path.resolve(CLIENT, '..', 'server');
const STACK_DIR = path.join(CLIENT, '.e2e');
const CLIENT_PORT = 5176;
const CHAIN_ID = 31337;

const log = (...a) => console.error('[e2e stack]', ...a);

// The server is a package of its own: its locked dependencies (express, @verdikta/common,
// Hardhat for the chain) are installed once, exactly as CI installs them.
function ensureServerInstalled() {
  if (fs.existsSync(path.join(SERVER, 'node_modules', '.package-lock.json'))) return;
  log('installing the server\'s locked dependencies (npm ci --ignore-scripts)');
  const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: SERVER, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm ci in ${SERVER} exited ${r.status}`);
}

const fromServer = (rel) => import(pathToFileURL(path.join(SERVER, rel)).href);

async function startChain() {
  const { hardhat, deployStakeAttestation, mergedAbi, LISTING_FEE_WEI } = await fromServer('test/helpers/chain.js');
  const hre = await hardhat();
  const d = await deployStakeAttestation(hre);
  const signers = await hre.ethers.getSigners();
  const { TASK_NODE_CREATE_SERVER } = createRequire(path.join(SERVER, 'package.json'))('hardhat/builtin-tasks/task-names');
  const rpc = await hre.run(TASK_NODE_CREATE_SERVER, { hostname: '127.0.0.1', port: 0, provider: hre.network.provider });
  const { port } = await rpc.listen();
  return {
    rpc,
    rpcUrl: `http://127.0.0.1:${port}`,
    contract: await d.sa.getAddress(),
    abi: mergedAbi(hre),
    listingFeeWei: LISTING_FEE_WEI.toString(),
    accounts: {
      owner: d.owner.address,
      maker: d.maker.address,
      hunter: d.hunter.address,
      feeRecipient: d.feeRecipient.address,
      other: signers[4].address,
    },
  };
}

function startGateway() {
  const store = new Map();
  const server = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    const m = /^\/ipfs\/([0-9A-Za-z]{1,128})$/.exec(new URL(req.url, 'http://x').pathname);
    if (!m) {
      res.statusCode = 404;
      return res.end();
    }
    if (req.method === 'GET') {
      const bytes = store.get(m[1]);
      if (!bytes) {
        res.statusCode = 404;
        return res.end('not found');
      }
      res.setHeader('content-type', 'application/octet-stream');
      return res.end(bytes);
    }
    if (req.method === 'PUT') {
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => {
        store.set(m[1], Buffer.concat(parts));
        res.statusCode = 201;
        res.end();
      });
      return undefined;
    }
    res.statusCode = 405;
    return res.end();
  });
  return listen(server);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function startApi() {
  const builderConfig = path.join(STACK_DIR, 'builder.json');
  const builderRecord = path.join(STACK_DIR, 'builder-record.json');
  const workDir = path.join(STACK_DIR, 'builds');
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(builderConfig, JSON.stringify({ mode: 'accepted', record: builderRecord }));
  const { loadConfig } = await fromServer('src/config.js');
  const { createApp } = await fromServer('src/app.js');
  const config = loadConfig({
    SA_ATTESTATION_TRUST: 'dev',
    SA_CHAIN_ID: String(CHAIN_ID),
    SA_PINNING: 'mock',
    SA_BUILDER_BIN: path.join(SERVER, 'test', 'fixtures', 'fake-builder-cli.js'),
    SA_BUILDER_CONFIG: builderConfig,
    SA_BUILDER_WORK_DIR: workDir,
    SA_BUILDER_TIMEOUT_MS: '60000',
    SA_BUILDER_GRACE_MS: '1000',
  });
  const quiet = { info() {}, debug() {}, warn: (...a) => log('api:', ...a), error: (...a) => log('api:', ...a) };
  const app = createApp({ config, logger: quiet });
  const { server, url } = await listen(http.createServer(app));
  return { server, url, builderConfig, builderRecord };
}

function vite(args, env) {
  return spawn(process.execPath, [path.join(CLIENT, 'node_modules', 'vite', 'bin', 'vite.js'), ...args], {
    cwd: CLIENT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function main() {
  fs.rmSync(STACK_DIR, { recursive: true, force: true });
  fs.mkdirSync(STACK_DIR, { recursive: true });
  ensureServerInstalled();
  log('compiling and deploying StakeAttestation on the in-process Hardhat network');
  const chain = await startChain();
  const gateway = await startGateway();
  const api = await startApi();
  const stack = {
    chainId: CHAIN_ID,
    rpcUrl: chain.rpcUrl,
    gatewayUrl: gateway.url,
    apiUrl: api.url,
    clientUrl: `http://127.0.0.1:${CLIENT_PORT}`,
    contract: chain.contract,
    listingFeeWei: chain.listingFeeWei,
    accounts: chain.accounts,
    builderConfig: api.builderConfig,
    builderRecord: api.builderRecord,
    abi: chain.abi,
  };
  fs.writeFileSync(path.join(STACK_DIR, 'stack.json'), JSON.stringify(stack, null, 2));
  log(`chain ${chain.rpcUrl}, contract ${chain.contract}, gateway ${gateway.url}, api ${api.url}`);

  const clientEnv = {
    VITE_SA_CHAIN_ID: String(CHAIN_ID),
    VITE_SA_CONTRACT: chain.contract,
    VITE_SA_RPC_URL: chain.rpcUrl,
    VITE_IPFS_GATEWAY: gateway.url,
    SA_API_URL: api.url,
  };
  const build = vite(['build', '--logLevel', 'warn'], clientEnv);
  const code = await new Promise((resolve) => build.once('exit', resolve));
  if (code !== 0) throw new Error(`vite build exited ${code}`);
  const preview = vite(['preview', '--host', '127.0.0.1', '--port', String(CLIENT_PORT), '--strictPort'], clientEnv);

  const stop = async (exitCode) => {
    preview.kill('SIGTERM');
    await Promise.allSettled([chain.rpc.close(), new Promise((r) => gateway.server.close(r)), new Promise((r) => api.server.close(r))]);
    process.exit(exitCode);
  };
  preview.once('exit', (c) => {
    log(`vite preview exited ${c}`);
    stop(1);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => stop(0));
}

main().catch((err) => {
  log(err?.stack ?? err);
  process.exit(1);
});
