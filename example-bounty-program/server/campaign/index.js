'use strict';
const { ethers } = require('ethers');
const { Store } = require('./store');
const { Indexer } = require('./indexer');
const { router, authenticated } = require('./service');
const { message } = require('./messages');
function install(app, configSource, rpcUrl, secret, options = {}) {
  let store;
  let provider;
  try {
    // Configuration loading is inside the boundary: even malformed JSON cannot stop the product API.
    const config =
      typeof configSource === 'function' ? configSource() : configSource;
    if (!config) return null;
    store = new Store(config.stateDirectory, config.policyHash, options);
    store.transact((state) => {
      state.chain.error = 'STARTUP_RECONCILIATION_REQUIRED';
    });
    provider = options.provider || new ethers.JsonRpcProvider(rpcUrl);
    const indexer = new Indexer(config, store, provider);
    const reconcile = () => {
      void indexer.reconcile().catch(() => {
        store.failed = true;
      });
    };
    const timer = setInterval(reconcile, config.pollSeconds * 1000);
    timer.unref();
    const close = () => {
      clearInterval(timer);
      provider.destroy?.();
      store.close();
      process.removeListener('exit', close);
    };
    process.once('exit', close);
    app.use('/api/campaign', router(config, store, secret));
    reconcile();
    return { store, indexer, close };
  } catch {
    try {
      store?.close();
      provider?.destroy?.();
    } catch {
      /* Preserve the product API on cleanup failure too. */
    }
    console.warn(
      'Campaign verification disabled: configuration, state or writer lock needs operator attention.',
    );
    app.get('/api/campaign/health', (request, response) =>
      response
        .status(503)
        .json({ ready: false, code: 'VERIFICATION_UNAVAILABLE_RETRY' }),
    );
    app.post('/api/campaign/verify', (request, response) => {
      const code =
        secret && !authenticated(request.get('X-Api-Key'), secret)
          ? 'AUTHENTICATION_FAILED'
          : 'VERIFICATION_UNAVAILABLE_RETRY';
      response.status(400).json({ message: message(code) });
    });
    return null;
  }
}
module.exports = { install };
