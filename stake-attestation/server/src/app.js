import fs from 'node:fs';
import express from 'express';

import { createCliBuilder } from './builder/cli.js';
import { loadConfig } from './config.js';
import { RequestError } from './listing/request.js';
import { QueueFullError, createListingService } from './listing/service.js';
import { createPinner } from './pinning/index.js';
import { SiteError } from './site/index.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ID = /^[0-9a-f]{32}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const BADGE_MAX_AGE_S = 60;
// A draft code_review.json, its known issues (at most 256) and an allowlist (at most 64).
const BODY_LIMIT = '1mb';

const consoleLogger = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  debug: () => {},
};

/**
 * The stake-attestation API:
 *
 *   GET  /health
 *   POST /api/listings       { spec, knownIssues?, allowlist? } -> 202 { id, status, ... };
 *                            400 an invalid request (no build started), 429 the build queue is full
 *   GET  /api/listings/:id   the listing's status, validation report and, once ready, both CIDs
 *                            and the arguments of list()
 *
 * and, with a deployment configured (node P4b1; src/site/), everything at the indexed block:
 *
 *   GET  /api/feed                     the listings that take commits (design §15)
 *   GET  /api/feed/events?after=&limit=  the contract's events of listings and claims (§13.4)
 *   GET  /api/records/:hash            recordByHash for an artifact hash, its labels, its history
 *   GET  /api/records/:hash/badge.svg  the hash's badge (§4.1)
 *   GET  /api/status                   the indexer's cursor and the keeper's state
 *
 * Without one these answer 503 CHAIN_NOT_CONFIGURED.
 *
 * @param {object} [o]
 * @param {object} [o.config] - loadConfig(); default from process.env
 * @param {object} [o.builder] - the environment builder (default: its command line, src/builder/cli.js)
 * @param {object} [o.pinner] - the pinning backend (default: config.pinning)
 * @param {object} [o.logger]
 * @param {object} [o.site] - the chain side (src/site/index.js createSite)
 */
export function createApp({ config = loadConfig(process.env), builder, pinner, logger = consoleLogger, site = null } = {}) {
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

  // the chain side: every answer is of the indexer's block
  const chainRoute = (handler) => async (req, res) => {
    if (!site) return res.status(503).json({ error: 'CHAIN_NOT_CONFIGURED' });
    try {
      return await handler(req, res);
    } catch (err) {
      if (err instanceof SiteError) return res.status(err.status).json({ error: err.code, detail: err.message });
      logger.error(`${req.method} ${req.path}: ${err?.stack ?? err}`);
      return res.status(500).json({ error: 'INTERNAL' });
    }
  };
  const hashParam = (req, res) => {
    if (HASH.test(req.params.hash)) return req.params.hash.toLowerCase();
    res.status(400).json({ error: 'BAD_HASH', detail: 'an artifact hash is 0x and 64 hex digits' });
    return null;
  };

  app.get('/api/feed', chainRoute(async (_req, res) => res.json(await site.feed())));

  app.get('/api/feed/events', chainRoute(async (req, res) => {
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    const after = typeof req.query.after === 'string' ? req.query.after : null;
    return res.json(site.events({ after, limit }));
  }));

  app.get('/api/records/:hash', chainRoute(async (req, res) => {
    const hash = hashParam(req, res);
    if (!hash) return undefined;
    const view = await site.record(hash);
    if (!view) return res.status(404).json({ error: 'RECORD_NOT_FOUND', detail: 'no listing of this artifact hash has opened' });
    return res.json(view);
  }));

  app.get('/api/records/:hash/badge.svg', chainRoute(async (req, res) => {
    const hash = hashParam(req, res);
    if (!hash) return undefined;
    const b = await site.badge(hash);
    res.set('content-type', 'image/svg+xml; charset=utf-8');
    res.set('cache-control', `public, max-age=${BADGE_MAX_AGE_S}`);
    return res.send(b.svg);
  }));

  app.get('/api/status', chainRoute(async (_req, res) => res.json(site.status())));

  // body-parser's errors: a body that is not JSON, or one over the limit
  app.use((err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'BODY_NOT_JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'BODY_TOO_LARGE', limit: BODY_LIMIT });
    return next(err);
  });

  app.listings = listings;
  app.site = site;
  return app;
}
