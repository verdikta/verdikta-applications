// hardhat.config.js
require("dotenv").config({ quiet: true });
// console.log("INFURA_API_KEY loaded:", process.env.INFURA_API_KEY ? "YES" : "NO");

const https = require("https");
require("@nomicfoundation/hardhat-toolbox");
require("hardhat-deploy");

const ACCOUNTS = [process.env.PRIVATE_KEY, process.env.PRIVATE_KEY_2].filter(Boolean);
const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60_000 });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.23",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    ],
  },

  networks: {
    development: {
      url: "http://127.0.0.1:8545",
      accounts: ACCOUNTS,
    },
    sepolia: {
      url: `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 11155111,
      gas: 18_500_000,
      gasPrice: 10_000_000_000,
      accounts: ACCOUNTS,
    },
    base_sepolia: {
      url: `https://base-sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 84532,
      gas: 10_000_000,
      gasPrice: 300_000_000, // increase this if needed
      accounts: ACCOUNTS,
    },
    base: {
      url: `https://base-mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
      // url: "https://mainnet.base.org",
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 8453,
      accounts: ACCOUNTS,
      // Optional: explicit EIP-1559 caps if you want to pin them
      // maxFeePerGas:  "30_000_000_000",  // 30 gwei
      // maxPriorityFeePerGas: "1_000_000_000", // 1 gwei
    },
  },

  // Tell hardhat-deploy to *always* use ordinary CREATE (no CREATE2)
  deterministicDeployment: false,

  namedAccounts: {
    deployer: 0,
    owner:    0,
  },

  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
    customChains: [
      {
        network:  "base_sepolia",
        chainId:  84532,
        urls: {
          apiURL:     "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network:  "base",
        chainId:  8453,
        urls: {
          apiURL:     "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },

  mocha: { timeout: 100_000 },
  sourcify: {enabled: false},
};
