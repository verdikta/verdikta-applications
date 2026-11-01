import fs from 'node:fs';
import express from 'express';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The stake-attestation API. Routes arrive with the listing flow (P4a) and the feed (P4b1). */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'stake-attestation-server', version });
  });

  return app;
}
