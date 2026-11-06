// hardhat.config.js
// Tests run on the in-process Hardhat network and need no secrets. Deployment networks and the
// verification config arrive with the deploy scripts (P2e), loading keys from the environment.
require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: { compilers: [require("./solidity.settings.cjs")] },

  // `npm run gas` (REPORT_GAS=1) prints gas per function; no price lookup, so no API key.
  gasReporter: {
    enabled: Boolean(process.env.REPORT_GAS),
    currency: "USD",
    noColors: Boolean(process.env.CI),
  },

  mocha: { timeout: 100_000 },
  sourcify: { enabled: false },
};
