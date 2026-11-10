// The chain side of a round: `hardhat node` as a process of its own, the real contracts deployed from
// onchain's own artifacts in the order of its deploy script (the libraries, then StakeAttestation
// linked to them), and MockVerdiktaAggregator. Every account is Hardhat's public test mnemonic.
import fs from 'node:fs';
import path from 'node:path';
import { ContractFactory, Contract, HDNodeWallet, JsonRpcProvider, MaxUint256, Wallet } from 'ethers';

import { APP_DIR, E2E_DIR } from './setup.js';
import { freePort, launch, waitUntil } from './proc.js';

export const CHAIN_ID = 31337;
const ONCHAIN = path.join(APP_DIR, 'onchain');
// Hardhat's own default accounts: public, and worth nothing anywhere else.
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const keyOf = (index) => HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, '', `m/44'/60'/0'/0/${index}`).privateKey;
export const LISTING_FEE_WEI = 10n ** 16n;

const artifact = (rel) => JSON.parse(fs.readFileSync(path.join(ONCHAIN, 'artifacts', 'contracts', rel), 'utf8'));

async function deploy(art, signer, args = [], libraries = {}) {
  let bytecode = art.bytecode;
  for (const refs of Object.values(art.linkReferences ?? {})) {
    for (const [name, places] of Object.entries(refs)) {
      if (!libraries[name]) throw new Error(`no address for the library ${name}`);
      for (const { start, length } of places) {
        bytecode = bytecode.slice(0, 2 + start * 2) + libraries[name].slice(2).toLowerCase() + bytecode.slice(2 + (start + length) * 2);
      }
    }
  }
  const contract = await new ContractFactory(art.abi, bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

/** The merged ABI the server keeps in step with onchain (a test of its own fails when they differ). */
const mergedAbi = () => {
  const file = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'server', 'src', 'chain', 'abi', 'StakeAttestation.json'), 'utf8'));
  return file.abi ?? file;
};

/**
 * @param {{ logDir: string }} o
 * @returns {Promise<object>} the chain: its URL and provider, the contracts, the wallets, and close()
 */
export async function startChain({ logDir }) {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const node = launch('hardhat', [path.join(ONCHAIN, 'node_modules', '.bin', 'hardhat'), '--config', path.join(E2E_DIR, 'chain', 'hardhat.config.cjs'), 'node', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: ONCHAIN,
    logDir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true' },
  });
  const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 200;
  const close = async () => {
    provider.destroy();
    await node.close();
  };
  try {
    await waitUntil('waiting for hardhat node', () => provider.getBlockNumber().then(() => true), { timeoutMs: 120000, proc: node });
    const wallet = (i) => new Wallet(keyOf(i), provider);
    const accounts = { deployer: wallet(0), maker: wallet(1), hunter: wallet(2), feeRecipient: wallet(3), bridge: wallet(4), other: wallet(5), keeper: wallet(9) };
    const aggregatorAdmin = await deploy(artifact('mocks/MockVerdiktaAggregator.sol/MockVerdiktaAggregator.json'), accounts.deployer);
    const libraries = {};
    for (const lib of ['ClaimLogic', 'RecordLogic']) {
      libraries[lib] = await (await deploy(artifact(`libraries/${lib}.sol/${lib}.json`), accounts.deployer)).getAddress();
    }
    const fromBlock = await provider.getBlockNumber();
    const stake = await deploy(artifact('StakeAttestation.sol/StakeAttestation.json'), accounts.deployer, [await aggregatorAdmin.getAddress(), accounts.deployer.address, accounts.feeRecipient.address, LISTING_FEE_WEI], libraries);
    // The confirmation size (erratum E9, node P17) above any award, so the round's valid claim pays
    // after its dispute window as before: the keeper does not call confirm() yet (node P18). The
    // narrow-INVALID floor keeps its default, THRESHOLD, so every INVALID forfeits as before.
    await (await stake.setConfirmAboveWei(MaxUint256)).wait();
    const contract = await stake.getAddress();
    const sa = new Contract(contract, mergedAbi(), provider);
    return {
      rpcUrl,
      provider,
      node,
      sa,
      contract,
      fromBlock,
      aggregator: aggregatorAdmin.connect(accounts.bridge),
      aggregatorAddress: await aggregatorAdmin.getAddress(),
      accounts,
      keys: { hunter: keyOf(2), keeper: keyOf(9) },
      /** Moves the chain's clock on: the windows are forced, never slept through. */
      async advance(seconds) {
        await provider.send('evm_increaseTime', [Number(seconds)]);
        await provider.send('evm_mine', []);
      },
      latest: async () => (await provider.getBlock('latest')).timestamp,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
