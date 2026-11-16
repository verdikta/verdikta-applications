// The in-process Hardhat network with StakeAttestation from ../onchain: the same contracts, the
// same compiler settings, the same deployment order as onchain's own tests and deploy script
// (MockVerdiktaAggregator, then ClaimLogic and RecordLogic, then StakeAttestation linked to them).
// Reads go through the merged ABI of onchain/deploy/helpers.js, so the lens views
// (recordByHash, recordPage, ...) answer at the StakeAttestation address. The server's own test
// contracts (test/chain/contracts: the Chainlink ETH/USD stand-in) compile beside them.
//
// node --test runs each test file in its own process, so the copy and the compile are done once,
// under a lock, and skipped while the sources' digest matches the one the last compile stamped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '..', '..');
const ONCHAIN = path.resolve(SERVER, '..', 'onchain');
const SERVER_CONTRACTS = path.join(SERVER, 'test', 'chain', 'contracts');
const WORK = path.join(SERVER, '.hardhat');
const LOCK = path.join(WORK, 'compile.lock');
const STAMP = path.join(WORK, 'sources.sha256');
const require = createRequire(import.meta.url);

const isOnchainSource = (src) => path.relative(path.join(ONCHAIN, 'contracts'), src).split(path.sep)[0] !== 'test';

function files(dir, keep = () => true) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath ?? d.path, d.name))
    .filter(keep)
    .sort();
}

/** The digest of everything the compile reads: both contract trees and the compiler settings. */
function sourcesDigest() {
  const h = crypto.createHash('sha256');
  const inputs = [
    ...files(path.join(ONCHAIN, 'contracts'), isOnchainSource),
    ...files(SERVER_CONTRACTS),
    path.join(ONCHAIN, 'solidity.settings.cjs'),
    path.join(SERVER, 'test', 'chain', 'hardhat.config.cjs'),
  ];
  for (const f of inputs) h.update(path.relative(SERVER, f)).update('\0').update(fs.readFileSync(f)).update('\0');
  return h.digest('hex');
}

// onchain/contracts without its test harness (contracts/test/), which no server test deploys, and
// the server's test contracts under server-test/.
function copyContracts() {
  const to = path.join(WORK, 'contracts');
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(path.join(ONCHAIN, 'contracts'), to, { recursive: true, filter: isOnchainSource });
  fs.cpSync(SERVER_CONTRACTS, path.join(to, 'server-test'), { recursive: true });
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
      // a lock older than ten minutes belongs to a process that died compiling
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
      process.env.HARDHAT_CONFIG = path.join(SERVER, 'test', 'chain', 'hardhat.config.cjs');
      process.env.HARDHAT_NETWORK = 'hardhat';
      process.env.HARDHAT_DISABLE_TELEMETRY_PROMPT = 'true';
      const hre = require('hardhat');
      await withCompileLock(async () => {
        const digest = sourcesDigest();
        const stamped = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8') : null;
        if (stamped === digest && fs.existsSync(path.join(WORK, 'artifacts'))) return;
        fs.rmSync(STAMP, { force: true });
        copyContracts();
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

/** onchain/contracts/StakeAttestation.sol, for tests that read its declarations. */
export function stakeAttestationSource() {
  return fs.readFileSync(path.join(ONCHAIN, 'contracts', 'StakeAttestation.sol'), 'utf8');
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

export const LISTING_FEE_WEI = 10n ** 16n; // 0.01 ETH, the in-process deploy script's default

/**
 * A fresh deployment: the mock aggregator and StakeAttestation, read through the merged ABI.
 * The owner then sets the confirmation size (erratum E9, node P17) above any award, so no listing
 * these tests make waits for a confirmation: the keeper does not call confirm() yet (node P18),
 * and the awards they pay settle as they did before the erratum. The narrow-INVALID floor keeps
 * its default, THRESHOLD: an empty band, every INVALID forfeits as before.
 */
export async function deployStakeAttestation(hre) {
  const [owner, maker, hunter, feeRecipient] = await hre.ethers.getSigners();
  const aggregator = await (await hre.ethers.getContractFactory('MockVerdiktaAggregator')).deploy();
  const factory = await linkedFactory(hre, 'StakeAttestation');
  const deployed = await factory.deploy(await aggregator.getAddress(), owner.address, feeRecipient.address, LISTING_FEE_WEI);
  await deployed.waitForDeployment();
  const sa = new hre.ethers.Contract(await deployed.getAddress(), mergedAbi(hre), owner);
  await (await sa.setConfirmAboveWei(hre.ethers.MaxUint256)).wait();
  return { sa, aggregator, owner, maker, hunter, feeRecipient };
}
