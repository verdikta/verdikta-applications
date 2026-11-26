// Opt-in integration suite: BountyEscrow against the REAL v2 aggregator, keeper and JuryBeacons from
// verdikta-dispatcher (reputationBasedAggregator/contracts), not MockVerdiktaAggregator.
// Run from onchain/: npm run test:integration (prepare.js copies both sets of sources into .contracts/).
// Secret-free: no networks but the in-process one.
require("@nomicfoundation/hardhat-toolbox");

// Mirrors verdikta-dispatcher/reputationBasedAggregator/hardhat.config.js (cancun: transient reentrancy guard)
const dispatcher = { version: "0.8.30", settings: { optimizer: { enabled: true, runs: 20 }, viaIR: true, evmVersion: "cancun" } };
const apps = require("../solidity.settings.cjs");

module.exports = {
  solidity: { compilers: [dispatcher, apps] },
  paths: { sources: "./.contracts", tests: "./test", cache: "./.cache", artifacts: "./.artifacts" },
  // The 50-arbiter jury's draw is ~13.5M gas, over a 30M block's comfort; the real per-tx cap
  // (2^24) is what the test asserts against, not the block limit.
  networks: { hardhat: { blockGasLimit: 60_000_000, allowUnlimitedContractSize: true, accounts: { count: 40 } } },
  mocha: { timeout: 600000 },
};
