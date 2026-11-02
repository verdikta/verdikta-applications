import fs from 'node:fs';
import express from 'express';

import { AuthError, createWalletAuth } from './auth/walletAuth.js';
import { createCliBuilder } from './builder/cli.js';
import { loadConfig } from './config.js';
import { RequestError } from './listing/request.js';
import { QueueFullError, createListingService } from './listing/service.js';
import { createPinner } from './pinning/index.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ID = /^[0-9a-f]{32}$/;
// A draft code_review.json, its known issues (at most 256) and an allowlist (at most 64).
const BODY_LIMIT = '1mb';
// { nonce, signature }
const AUTH_BODY_LIMIT = '4kb';

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
 *                            and the arguments of list(); the maker and the scan's status
 *
 * and the baseline scan's findings, for the maker's wallet only (node P4b2; src/auth/walletAuth.js):
 *
 *   POST /api/listings/:id/scan/challenge   {} -> 200 { action, resource, address, nonce, issuedAt,
 *                            expiresAt, message }: the message the maker's wallet signs as it is;
 *                            404 no such listing, 409 the listing names no maker, 429 too many
 *                            challenges waiting
 *   POST /api/listings/:id/scan              { nonce, signature } -> 200 { id, maker, status, scan,
 *                            error }: the builder's scan-findings.json; 400 no nonce or signature,
 *                            401 an unknown, used, expired or mismatched challenge or a bad
 *                            signature, 403 signed by another wallet than the maker's, 404, 409
 *                            the scan has not finished (or will not run)
 *
 * @param {object} [o]
 * @param {object} [o.config] - loadConfig(); default from process.env
 * @param {object} [o.builder] - the environment builder (default: its command line, src/builder/cli.js)
 * @param {object} [o.scanner] - the baseline scan (default: the builder's command line, `scan`)
 * @param {object} [o.pinner] - the pinning backend (default: config.pinning)
 * @param {object} [o.auth] - the wallet sign-in (default: createWalletAuth with config.auth)
 * @param {object} [o.logger]
 */
export function createApp({ config = loadConfig(process.env), builder, scanner, pinner, auth, logger = consoleLogger } = {}) {
  const cli = builder && scanner ? null : createCliBuilder(config.builder, { logger });
  const listings = createListingService({
    config,
    builder: builder ?? cli,
    scanner: scanner ?? cli,
    pinner: pinner ?? createPinner(config.pinning),
    logger,
  });
  const signIn = auth ?? createWalletAuth({ ttlMs: config.auth.challengeTtlMs });
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

  // The baseline scan's findings go to the maker's wallet and nowhere else (design §8.3). Every
  // answer here is no-store; none but the 200 carries anything of the scan beyond its status, and
  // a failure is logged by its route and the error's name only.
  const scanRoute = (handler) => (req, res) => {
    try {
      const access = ID.test(req.params.id) ? listings.scanAccess(req.params.id) : null;
      if (!access) return res.status(404).json({ error: 'LISTING_NOT_FOUND' });
      if (!access.maker) return res.status(409).json({ error: 'LISTING_HAS_NO_MAKER', detail: 'the listing request named no maker, so its scan was not run' });
      return handler(req, res, access);
    } catch (err) {
      logger.error(`${req.method} /api/listings/:id/${req.path.endsWith('/challenge') ? 'scan/challenge' : 'scan'} failed (${err?.name ?? 'error'})`);
      return res.status(500).json({ error: 'INTERNAL' });
    }
  };
  const resourceOf = (id) => `listing:${id}`;
  // no-store from the first middleware on, and the body's own errors answered here, with this
  // route's limit, so a malformed or oversized body is no exception to either
  const noStore = (_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  };
  const authJson = express.json({ limit: AUTH_BODY_LIMIT });
  const authBody = (req, res, next) => authJson(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BODY_NOT_JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'BODY_TOO_LARGE', limit: AUTH_BODY_LIMIT });
    return res.status(Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 400).json({ error: 'BODY_INVALID' });
  });

  app.post('/api/listings/:id/scan/challenge', noStore, scanRoute((_req, res, access) => {
    try {
      return res.json(signIn.challenge({ action: 'read-scan', resource: resourceOf(access.id), address: access.maker }));
    } catch (err) {
      if (err instanceof AuthError) return res.status(err.status).json({ error: err.code, detail: err.detail });
      throw err;
    }
  }));

  app.post('/api/listings/:id/scan', noStore, authBody, scanRoute((req, res, access) => {
    // before the signature is checked, so asking early costs the maker no challenge
    if (!access.result) return res.status(409).json({ error: 'SCAN_NOT_READY', scan: access.scan });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const v = signIn.verify({ action: 'read-scan', resource: resourceOf(access.id), nonce: body.nonce, signature: body.signature });
    if (!v.ok && v.status === 403) return res.status(403).json({ error: 'NOT_THE_MAKER', detail: `${v.detail}, the listing's maker` });
    if (!v.ok) return res.status(v.status).json({ error: v.code, detail: v.detail });
    return res.json({ id: access.id, maker: access.maker, status: access.scan.status, scan: access.result.doc, error: access.result.error });
  }));

  // body-parser's errors: a body that is not JSON, or one over the limit
  app.use((err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'BODY_NOT_JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'BODY_TOO_LARGE', limit: BODY_LIMIT });
    return next(err);
  });

  app.listings = listings;
  return app;
}
