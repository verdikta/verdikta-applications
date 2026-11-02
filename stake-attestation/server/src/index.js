import { createApp } from './app.js';
import { loadConfig } from './config.js';

// Everything comes from the environment (src/config.js); 5009 is the next free port after the
// repository's other apps (see ../README.md).
const config = loadConfig(process.env);

createApp({ config }).listen(config.port, config.host, () => {
  console.log(`stake-attestation server listening on http://${config.host}:${config.port} (pinning: ${config.pinning.backend}, trust: ${config.trust.mode})`);
});
