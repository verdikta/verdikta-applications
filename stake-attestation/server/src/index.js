import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createGatewayFetcher } from './site/archives.js';
import { createChainProvider, createSite } from './site/index.js';

// Everything comes from the environment (src/config.js); 5009 is the next free port after the
// repository's other apps (see ../README.md).
const config = loadConfig(process.env);

const logger = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  debug: () => {},
};

// The chain side (indexer, keeper, feed, record, badge) when a deployment is configured.
let site = null;
if (config.chain) {
  site = createSite({
    config,
    provider: createChainProvider(config, process.env),
    env: process.env,
    fetchArchive: createGatewayFetcher(config.archives, logger),
    logger,
  });
  site.start();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      site.close();
      process.exit(0);
    });
  }
}

createApp({ config, logger, site }).listen(config.port, config.host, () => {
  const chain = config.chain ? `, chain ${config.chain.chainId} at ${config.chain.address}, keeper ${site.keeper ? site.keeper.address : 'off'}` : '';
  console.log(`stake-attestation server listening on http://${config.host}:${config.port} (pinning: ${config.pinning.backend}, trust: ${config.trust.mode}${chain})`);
});
