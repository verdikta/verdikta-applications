// The in-process Hardhat network with StakeAttestation from ../onchain: the same contracts, the same
// compiler settings and the same deployment order as onchain's own tests (MockVerdiktaAggregator, then
// ClaimLogic and RecordLogic, then StakeAttestation linked to them), as the server's chain tests do it.
// node --test runs each file in its own process, so the copy and the compile happen once, under a
// lock, and are skipped while the sources' digest matches the last compile's stamp.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(here, '..', '..');
const ONCHAIN = path.resolve(TOOL, '..', 'onchain');
const WORK = path.join(TOOL, '.hardhat');
const LOCK = path.join(WORK, 'compile.lock');
const STAMP = path.join(WORK, 'sources.sha256');
const require = createRequire(import.meta.url);

const isOnchainSource = (src) => path.relative(path.join(ONCHAIN, 'contracts'), src).split(path.sep)[0] !== 'test';

function files(dir, keep = () => true) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath ?? d.path, d.name))
    .filter(keep)
    .sort();
}

function sourcesDigest() {
  const h = crypto.createHash('sha256');
  for (const f of [...files(path.join(ONCHAIN, 'contracts'), isOnchainSource), path.join(ONCHAIN, 'solidity.settings.cjs'), path.join(TOOL, 'test', 'chain', 'hardhat.config.cjs')]) {
    h.update(path.relative(TOOL, f)).update('\0').update(fs.readFileSync(f)).update('\0');
  }
  return h.digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withCompileLock(fn) {
  fs.mkdirSync(WORK, { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 600000) fs.rmSync(LOCK, { recursive: true, force: true });
      } catch { /* gone already */ }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
}

let hrePromise = null;

/** Hardhat's runtime on the in-process network, with onchain's contracts compiled. */
export function hardhat() {
  if (!hrePromise) {
    hrePromise = (async () => {
      process.env.HARDHAT_CONFIG = path.join(TOOL, 'test', 'chain', 'hardhat.config.cjs');
      process.env.HARDHAT_NETWORK = 'hardhat';
      process.env.HARDHAT_DISABLE_TELEMETRY_PROMPT = 'true';
      const hre = require('hardhat');
      await withCompileLock(async () => {
        const digest = sourcesDigest();
        const stamped = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8') : null;
        if (stamped === digest && fs.existsSync(path.join(WORK, 'artifacts'))) return;
        fs.rmSync(STAMP, { force: true });
        const to = path.join(WORK, 'contracts');
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(path.join(ONCHAIN, 'contracts'), to, { recursive: true, filter: isOnchainSource });
        await hre.run('compile', { quiet: true });
        fs.writeFileSync(STAMP, digest);
      });
      return hre;
    })();
  }
  return hrePromise;
}

/** onchain/deploy/helpers.js's mergedAbi: StakeAttestation plus the lens views. */
export function mergedAbi(hre) {
  return require(path.join(ONCHAIN, 'deploy', 'helpers.js')).mergedAbi(hre.artifacts);
}

async function linkedFactory(hre, name) {
  const artifact = await hre.artifacts.readArtifact(name);
  const libs = [...new Set(Object.values(artifact.linkReferences).flatMap((l) => Object.keys(l)))]
    .sort((a, b) => (a === 'ClaimLogic' ? -1 : b === 'ClaimLogic' ? 1 : a < b ? -1 : 1));
  const libraries = {};
  for (const lib of libs) {
    libraries[lib] = await (await (await hre.ethers.getContractFactory(lib)).deploy()).getAddress();
  }
  return hre.ethers.getContractFactory(name, { libraries });
}

export const LISTING_FEE_WEI = 10n ** 16n;

/** A fresh deployment: the mock aggregator and StakeAttestation, read through the merged ABI. */
export async function deployStakeAttestation(hre) {
  const [owner, maker, , feeRecipient] = await hre.ethers.getSigners();
  const aggregator = await (await hre.ethers.getContractFactory('MockVerdiktaAggregator')).deploy();
  const factory = await linkedFactory(hre, 'StakeAttestation');
  const deployed = await factory.deploy(await aggregator.getAddress(), owner.address, feeRecipient.address, LISTING_FEE_WEI);
  await deployed.waitForDeployment();
  const sa = new hre.ethers.Contract(await deployed.getAddress(), mergedAbi(hre), owner);
  return { sa, aggregator, owner, maker, feeRecipient };
}

/**
 * The in-process network over HTTP on a loopback port, for a CLI run as a child process. Every call is
 * recorded in `calls` for the test to read; `echoErrors` makes it answer each call with an error that
 * quotes the whole request, as a careless RPC gateway does.
 */
export async function startRpc(hre) {
  const calls = [];
  const options = { echoErrors: false, echoOnly: null, down: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      res.setHeader('content-type', 'application/json');
      if (options.down) {
        res.statusCode = 503;
        res.end(`upstream down; request was ${text}`);
        return;
      }
      const one = async (call) => {
        calls.push(call);
        if (options.echoErrors || options.echoOnly?.includes(call.method)) return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: `rejected: ${text}`, data: text } };
        try {
          const result = await hre.network.provider.send(call.method, call.params ?? []);
          return { jsonrpc: '2.0', id: call.id, result };
        } catch (err) {
          return { jsonrpc: '2.0', id: call.id, error: { code: err.code ?? -32000, message: err.message, data: err.data } };
        }
      };
      const parsed = JSON.parse(text);
      const answer = Array.isArray(parsed) ? await Promise.all(parsed.map(one)) : await one(parsed);
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, calls, options, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
