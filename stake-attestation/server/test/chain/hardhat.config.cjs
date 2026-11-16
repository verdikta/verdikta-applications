// The in-process Hardhat network the server's chain tests run on: the contracts of ../../../onchain
// (copied into server/.hardhat/contracts by test/helpers/chain.js, since Hardhat compiles only
// sources inside its project root), compiled with onchain's own compiler settings. No live
// network, no account from the environment, no secret.
const path = require('node:path');

require('@nomicfoundation/hardhat-ethers');

const root = path.resolve(__dirname, '..', '..');
const work = path.join(root, '.hardhat');

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: { compilers: [require('../../../onchain/solidity.settings.cjs')] },
  paths: {
    root,
    sources: path.join(work, 'contracts'),
    artifacts: path.join(work, 'artifacts'),
    cache: path.join(work, 'cache'),
  },
  networks: { hardhat: {} },
};
