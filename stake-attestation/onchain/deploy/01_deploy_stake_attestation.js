// Deploy StakeAttestation (design §13) to Base Sepolia or Base, in the bounty program's style
// (example-bounty-program/onchain/deploy/01_deploy_bounty.js; run it through deploy_testnet.sh
// or deploy_mainnet.sh).
//
//   npx hardhat run deploy/01_deploy_stake_attestation.js --network base_sepolia
//
// Every value comes from the environment, none from a file in the repository:
//   PRIVATE_KEY                          the deployer (hardhat.config.js reads it)
//   VERDIKTA_AGGREGATOR_BASE_SEPOLIA     the ETH-funded aggregator on Base Sepolia, or
//   VERDIKTA_AGGREGATOR_BASE             the one on Base
//   SA_INITIAL_OWNER                     the contract owner (the listing fee and its recipient only)
//   SA_FEE_RECIPIENT                     where listing fees accrue
//   SA_LISTING_FEE_WEI                   the listing fee per 30 days, in wei (assumption A5: an
//                                        owner decision before mainnet)
//   ETHERSCAN_API_KEY                    optional: verify the contracts on BaseScan
// On a live network every one of them is required. On the in-process network (`npx hardhat run
// deploy/01_deploy_stake_attestation.js`, a local test) none is: a MockVerdiktaAggregator is
// deployed unless VERDIKTA_AGGREGATOR is set, and the deployer stands in for the owner and the
// fee recipient.
//
// Order: the linked libraries first, ClaimLogic then RecordLogic, then StakeAttestation linked
// to them; its constructor creates the lens and the EvaluationWallet implementation. Writes
// deployments/<chainId>-<network>.json and deployments/StakeAttestation.abi.json (untracked).
const { ethers } = require("ethers");
const { saveDeployment, writeMergedAbi, readWithRetry, DEFAULT_DIR } = require("./helpers");

const LIVE = {
  base_sepolia: { chainId: 84532, aggregatorVar: "VERDIKTA_AGGREGATOR_BASE_SEPOLIA" },
  base: { chainId: 8453, aggregatorVar: "VERDIKTA_AGGREGATOR_BASE" },
};
const IN_PROCESS = "hardhat";
const DEFAULT_LOCAL_FEE_WEI = 10n ** 16n; // the in-process network only

// The libraries StakeAttestation links, in the order they are deployed (P2b: ClaimLogic first).
const LIBRARIES = ["ClaimLogic", "RecordLogic"];

/**
 * The aggregator and constructor arguments for `network`, from `env`. Throws, naming the
 * variable, on a missing or malformed value; never falls back to a default on a live network.
 */
function configFromEnv(network, env = process.env) {
  const live = LIVE[network];
  if (!live && network !== IN_PROCESS) {
    throw new Error(`Unsupported network ${network}. Use base_sepolia or base (or the in-process hardhat network).`);
  }
  const raw = (name) => {
    const v = env[name];
    if (v === undefined || v === "") {
      if (live) throw new Error(`Set ${name} in the environment (see .env.example)`);
      return null;
    }
    return String(v).trim();
  };
  const address = (name) => {
    const v = raw(name);
    if (v === null) return null;
    if (!ethers.isAddress(v) || ethers.getAddress(v) === ethers.ZeroAddress) {
      throw new Error(`${name} must be a non-zero address, not ${JSON.stringify(v)}`);
    }
    return ethers.getAddress(v);
  };
  const wei = (name) => {
    const v = raw(name);
    if (v === null) return DEFAULT_LOCAL_FEE_WEI;
    if (!/^[0-9]+$/.test(v)) throw new Error(`${name} must be a whole number of wei, not ${JSON.stringify(v)}`);
    return BigInt(v);
  };
  return {
    aggregator: address(live ? live.aggregatorVar : "VERDIKTA_AGGREGATOR"),
    initialOwner: address("SA_INITIAL_OWNER"),
    feeRecipient: address("SA_FEE_RECIPIENT"),
    listingFeeWei: wei("SA_LISTING_FEE_WEI"),
  };
}

/** Refuse an aggregator address with no contract, or one that does not answer maxOracleFee(). */
async function checkAggregator(hre, address) {
  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`There is no contract at the aggregator address ${address}`);
  const aggregator = await hre.ethers.getContractAt("IVerdiktaAggregator", address);
  return aggregator.maxOracleFee();
}

/**
 * Deploy ClaimLogic, then RecordLogic, then StakeAttestation linked to both, with `cfg`'s
 * constructor arguments. Returns the deployment record (also what saveDeployment writes).
 */
async function deployStakeAttestation(hre, cfg, { log = console.log } = {}) {
  const { ethers: hEthers } = hre;
  const [deployer] = await hEthers.getSigners();
  if (!deployer) throw new Error("No deployer account: set PRIVATE_KEY in the environment");
  const linked = Object.values((await hre.artifacts.readArtifact("StakeAttestation")).linkReferences)
    .flatMap((l) => Object.keys(l));
  if ([...new Set(linked)].sort().join() !== [...LIBRARIES].sort().join()) {
    throw new Error(`StakeAttestation links ${linked.join(", ")}; this script deploys ${LIBRARIES.join(", ")}. Update LIBRARIES.`);
  }
  await checkAggregator(hre, cfg.aggregator);

  const libraries = {};
  const transactions = {};
  for (const name of LIBRARIES) {
    const lib = await (await hEthers.getContractFactory(name)).deploy();
    await lib.waitForDeployment();
    libraries[name] = await lib.getAddress();
    transactions[name] = lib.deploymentTransaction().hash;
    log(`${name}: ${libraries[name]}`);
  }

  const args = [cfg.aggregator, cfg.initialOwner, cfg.feeRecipient, cfg.listingFeeWei];
  const sa = await (await hEthers.getContractFactory("StakeAttestation", { libraries })).deploy(...args);
  await sa.waitForDeployment();
  const address = await sa.getAddress();
  const tx = sa.deploymentTransaction();
  const rc = await tx.wait();
  transactions.StakeAttestation = tx.hash;
  // The constructor created both; callers never need the lens (its views answer at `address`),
  // but it is recorded so it can be verified and found on explorers.
  const lens = await readWithRetry("lens()", () => sa.lens(), log);
  const walletImplementation = await readWithRetry("walletImplementation()", () => sa.walletImplementation(), log);
  log(`StakeAttestation: ${address} (block ${rc.blockNumber})`);
  log(`StakeAttestationLens (created by StakeAttestation): ${lens}`);
  log(`EvaluationWallet implementation (created by StakeAttestation): ${walletImplementation}`);

  return {
    network: hre.network.name,
    chainId: Number((await hEthers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    deploymentBlock: rc.blockNumber,
    constructorArgs: [cfg.aggregator, cfg.initialOwner, cfg.feeRecipient, cfg.listingFeeWei.toString()],
    libraries,
    transactions,
    contracts: {
      ClaimLogic: libraries.ClaimLogic,
      RecordLogic: libraries.RecordLogic,
      StakeAttestation: address,
      StakeAttestationLens: lens,
      EvaluationWalletImplementation: walletImplementation,
      VerdiktaAggregator: cfg.aggregator,
    },
  };
}

/** Verify every contract of a deployment on BaseScan (hardhat-verify), retrying while it indexes. */
async function verifyDeployment(hre, out, { log = console.log, attempts = 4, delayMs = 15000 } = {}) {
  const [aggregator] = out.constructorArgs;
  const jobs = [
    { name: "ClaimLogic", address: out.contracts.ClaimLogic, contract: "contracts/libraries/ClaimLogic.sol:ClaimLogic", constructorArguments: [] },
    { name: "RecordLogic", address: out.contracts.RecordLogic, contract: "contracts/libraries/RecordLogic.sol:RecordLogic", constructorArguments: [] },
    {
      name: "StakeAttestation", address: out.contracts.StakeAttestation, contract: "contracts/StakeAttestation.sol:StakeAttestation",
      constructorArguments: out.constructorArgs, libraries: out.libraries,
    },
    { name: "StakeAttestationLens", address: out.contracts.StakeAttestationLens, contract: "contracts/StakeAttestationLens.sol:StakeAttestationLens", constructorArguments: [aggregator] },
    {
      name: "EvaluationWallet", address: out.contracts.EvaluationWalletImplementation, contract: "contracts/EvaluationWallet.sol:EvaluationWallet",
      constructorArguments: [out.contracts.StakeAttestation, aggregator],
    },
  ];
  for (const { name, ...job } of jobs) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await hre.run("verify:verify", job);
        log(`${name} verified`);
        break;
      } catch (e) {
        const m = e.message || String(e);
        if (/already verified/i.test(m)) { log(`${name} already verified`); break; }
        if (attempt < attempts && /has no bytecode|does not have bytecode|not indexed/i.test(m)) {
          log(`${name}: not indexed yet; retry ${attempt}/${attempts - 1} in ${delayMs / 1000}s`);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        log(`${name}: verify failed (${m}); run deploy/verify.js later`);
        break;
      }
    }
  }
}

async function main({ env = process.env, saveDir = DEFAULT_DIR, log = console.log } = {}) {
  const hre = require("hardhat");
  const network = hre.network.name;
  const cfg = configFromEnv(network, env);
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer account: set PRIVATE_KEY in the environment");
  if (network === IN_PROCESS) {
    if (cfg.aggregator === null) {
      const mock = await (await hre.ethers.getContractFactory("MockVerdiktaAggregator")).deploy();
      await mock.waitForDeployment();
      cfg.aggregator = await mock.getAddress();
      log(`In-process network: MockVerdiktaAggregator deployed at ${cfg.aggregator}`);
    }
    cfg.initialOwner = cfg.initialOwner ?? deployer.address;
    cfg.feeRecipient = cfg.feeRecipient ?? deployer.address;
  }
  log(`Deployer : ${deployer.address}`);
  log(`Network  : ${network} (${(await hre.ethers.provider.getNetwork()).chainId})`);
  log(`Aggregator (ETH): ${cfg.aggregator}`);
  log(`Owner ${cfg.initialOwner}, fee recipient ${cfg.feeRecipient}, listing fee ${cfg.listingFeeWei} wei`);

  const out = await deployStakeAttestation(hre, cfg, { log });
  saveDeployment(out, saveDir, log);
  writeMergedAbi(hre.artifacts, saveDir, log);
  if (out.deploymentBlock) log(`Deployment block: ${out.deploymentBlock} (the indexer's start block)`);
  if (LIVE[network] && env.ETHERSCAN_API_KEY) await verifyDeployment(hre, out, { log });
  return out;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

module.exports = { LIVE, LIBRARIES, configFromEnv, checkAggregator, deployStakeAttestation, verifyDeployment, main };
