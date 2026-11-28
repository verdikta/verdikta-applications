import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPinner } from './pinning/index.js';
import { createGatewayFetcher } from './site/archives.js';
import { createJustificationFetcher } from './site/evidence.js';
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

// One pinning backend for the listing archives (the app) and for claims' content (the site).
const pinner = createPinner(config.pinning);

// The chain side (indexer, keeper, feed, record, badge) when a deployment is configured.
let site = null;
if (config.chain) {
  site = createSite({
    config,
    provider: createChainProvider(config, process.env),
    env: process.env,
    fetchArchive: createGatewayFetcher(config.archives, logger),
    fetchJustification: createJustificationFetcher(config.archives, logger),
    fetchContent: createGatewayFetcher({ ...config.archives, maxBytes: config.keepContent.maxBytes }, logger),
    pinner,
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

const app = createApp({ config, logger, site, pinner });
// What the last server started and nothing follows now is cancelled first (node P15).
app.buildRuns?.start();
app.listen(config.port, config.host, () => {
  const chain = config.chain ? `, chain ${config.chain.chainId} at ${config.chain.address}, keeper ${site.keeper ? site.keeper.address : 'off'}` : '';
  console.log(`stake-attestation server listening on http://${config.host}:${config.port} (pinning: ${config.pinning.backend}, trust: ${config.trust.mode}, builds: ${config.builds.backend}${chain})`);
});
