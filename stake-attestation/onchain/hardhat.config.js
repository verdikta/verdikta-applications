// hardhat.config.js
// Tests run on the in-process Hardhat network and need no secrets. The two deploy networks (Base
// Sepolia and Base, P2e) take the deployer key and the RPC URL from the environment only, and
// the contract sizer fails the build of any contract over EIP-170's 24 KiB.
require("@nomicfoundation/hardhat-toolbox");
require("hardhat-contract-sizer");

// The deployer: PRIVATE_KEY from the environment (deploy_*.sh may load it from an untracked
// .env), never from this file. Unset, the live networks have no account and cannot send.
const ACCOUNTS = [process.env.PRIVATE_KEY].filter(Boolean);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: { compilers: [require("./solidity.settings.cjs")] },

  networks: {
    base_sepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: ACCOUNTS,
    },
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: ACCOUNTS,
    },
  },

  // `npx hardhat size-contracts` prints every contract's runtime and initcode size and, strict,
  // exits non-zero when one is over the limit (EIP-170, 24 KiB).
  contractSizer: {
    strict: true,
    runOnCompile: false,
    alphaSort: true,
  },

  // `npm run gas` (REPORT_GAS=1) prints gas per function; no price lookup, so no API key.
  gasReporter: {
    enabled: Boolean(process.env.REPORT_GAS),
    currency: "USD",
    noColors: Boolean(process.env.CI),
  },

  // deploy/verify.js and the deploy script's optional verification: an Etherscan v2 key from
  // the environment (ETHERSCAN_API_KEY), with Base's explorers.
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "base_sepolia",
        chainId: 84532,
        urls: { apiURL: "https://api-sepolia.basescan.org/api", browserURL: "https://sepolia.basescan.org" },
      },
      {
        network: "base",
        chainId: 8453,
        urls: { apiURL: "https://api.basescan.org/api", browserURL: "https://basescan.org" },
      },
    ],
  },

  mocha: { timeout: 100_000 },
  sourcify: { enabled: false },
};
