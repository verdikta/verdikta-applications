'use strict';
const { ethers } = require('ethers');
const { Store } = require('./store');
const { Indexer } = require('./indexer');
const { router } = require('./service');
function install(app, c, rpcUrl, secret) {
  if (!c) return null;
  const store = new Store(c.stateDirectory, c.policyHash);
  store.transact(s => { s.chain.error='STARTUP_RECONCILIATION_REQUIRED'; });
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const indexer = new Indexer(c, store, provider);
  app.use('/api/campaign', router(c, store, secret));
  const timer = setInterval(() => { void indexer.reconcile(); }, c.pollSeconds*1000);
  timer.unref();
  void indexer.reconcile();
  process.once('exit', () => store.close());
  return { store, indexer };
}
module.exports = { install };
