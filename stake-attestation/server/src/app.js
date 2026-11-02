import fs from 'node:fs';
import express from 'express';

import { createCliBuilder } from './builder/cli.js';
import { loadConfig } from './config.js';
import { RequestError } from './listing/request.js';
import { QueueFullError, createListingService } from './listing/service.js';
import { createPinner } from './pinning/index.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ID = /^[0-9a-f]{32}$/;
// A draft code_review.json, its known issues (at most 256) and an allowlist (at most 64).
const BODY_LIMIT = '1mb';

const consoleLogger = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  debug: () => {},
};

/**
 * The stake-attestation API (the feed and the record mirror arrive with P4b1):
 *
 *   GET  /health
 *   POST /api/listings       { spec, knownIssues?, allowlist? } -> 202 { id, status, ... };
 *                            400 an invalid request (no build started), 429 the build queue is full
 *   GET  /api/listings/:id   the listing's status, validation report and, once ready, both CIDs
 *                            and the arguments of list()
 *
 * @param {object} [o]
 * @param {object} [o.config] - loadConfig(); default from process.env
 * @param {object} [o.builder] - the environment builder (default: its command line, src/builder/cli.js)
 * @param {object} [o.pinner] - the pinning backend (default: config.pinning)
 * @param {object} [o.logger]
 */
export function createApp({ config = loadConfig(process.env), builder, pinner, logger = consoleLogger } = {}) {
  const listings = createListingService({
    config,
    builder: builder ?? createCliBuilder(config.builder, { logger }),
    pinner: pinner ?? createPinner(config.pinning),
    logger,
  });
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'stake-attestation-server', version });
  });

  app.post('/api/listings', express.json({ limit: BODY_LIMIT }), (req, res) => {
    try {
      const view = listings.submit(req.body);
      res.status(202).location(`/api/listings/${view.id}`).json(view);
    } catch (err) {
      if (err instanceof RequestError) return res.status(400).json({ error: err.code, issues: err.issues });
      if (err instanceof QueueFullError) return res.status(429).json({ error: err.code, detail: err.message });
      logger.error(`POST /api/listings: ${err?.stack ?? err}`);
      return res.status(500).json({ error: 'INTERNAL' });
    }
  });

  app.get('/api/listings/:id', (req, res) => {
    const view = ID.test(req.params.id) ? listings.get(req.params.id) : null;
    if (!view) return res.status(404).json({ error: 'LISTING_NOT_FOUND' });
    return res.json(view);
  });

  // body-parser's errors: a body that is not JSON, or one over the limit
  app.use((err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'BODY_NOT_JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'BODY_TOO_LARGE', limit: BODY_LIMIT });
    return next(err);
  });

  app.listings = listings;
  return app;
}
