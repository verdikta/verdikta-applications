// The chain the local round runs on: `hardhat node` on loopback, chain 31337, with Hardhat's public
// test accounts and no account or endpoint from the environment. It compiles nothing (the round reads
// onchain's own artifacts). A real node takes a transaction that will revert and mines it, so
// Hardhat is told not to throw from the send. A call that reverts is an error, as on a real node:
// with throwOnCallFailures off, Hardhat answered it with the revert's bytes, and the site's keeper
// took a finalize that would revert for one that passes. Blocks come with every transaction and once a second
// besides, so a "2 confirmations" wait (the hunter tool, the indexer) really waits for two blocks.
const path = require('node:path');

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: require('../../onchain/solidity.settings.cjs'),
  paths: { root: path.resolve(__dirname, '..', '..', 'onchain') },
  networks: {
    hardhat: {
      chainId: 31337,
      throwOnTransactionFailures: false,
      mining: { auto: true, interval: 1000 },
    },
  },
};
