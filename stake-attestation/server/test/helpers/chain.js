// The in-process Hardhat network with StakeAttestation from ../onchain: the same contracts, the
// same compiler settings, the same deployment order as onchain's own tests and deploy script
// (MockVerdiktaAggregator, then ClaimLogic and RecordLogic, then StakeAttestation linked to them).
// Reads go through the merged ABI of onchain/deploy/helpers.js, so the lens views
// (recordByHash, recordPage, ...) answer at the StakeAttestation address.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '..', '..');
const ONCHAIN = path.resolve(SERVER, '..', 'onchain');
const WORK = path.join(SERVER, '.hardhat');
const require = createRequire(import.meta.url);

// onchain/contracts without its test harness (contracts/test/), which no server test deploys.
function copyContracts() {
  const to = path.join(WORK, 'contracts');
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(path.join(ONCHAIN, 'contracts'), to, {
    recursive: true,
    filter: (src) => path.relative(path.join(ONCHAIN, 'contracts'), src).split(path.sep)[0] !== 'test',
  });
}

let hrePromise = null;

/** Hardhat's runtime on the in-process network, with onchain's contracts compiled. */
export function hardhat() {
  if (!hrePromise) {
    hrePromise = (async () => {
      copyContracts();
      process.env.HARDHAT_CONFIG = path.join(SERVER, 'test', 'chain', 'hardhat.config.cjs');
      process.env.HARDHAT_NETWORK = 'hardhat';
      process.env.HARDHAT_DISABLE_TELEMETRY_PROMPT = 'true';
      const hre = require('hardhat');
      await hre.run('compile', { quiet: true });
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

export const LISTING_FEE_WEI = 10n ** 16n; // 0.01 ETH, the in-process deploy script's default

/** A fresh deployment: the mock aggregator and StakeAttestation, read through the merged ABI. */
export async function deployStakeAttestation(hre) {
  const [owner, maker, hunter, feeRecipient] = await hre.ethers.getSigners();
  const aggregator = await (await hre.ethers.getContractFactory('MockVerdiktaAggregator')).deploy();
  const factory = await linkedFactory(hre, 'StakeAttestation');
  const deployed = await factory.deploy(await aggregator.getAddress(), owner.address, feeRecipient.address, LISTING_FEE_WEI);
  await deployed.waitForDeployment();
  const sa = new hre.ethers.Contract(await deployed.getAddress(), mergedAbi(hre), owner);
  return { sa, aggregator, owner, maker, hunter, feeRecipient };
}
