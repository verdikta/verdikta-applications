require('dotenv').config();

module.exports = {
  ipfs: {
    pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
    pinningKey: process.env.IPFS_PINNING_KEY,
  }
};
