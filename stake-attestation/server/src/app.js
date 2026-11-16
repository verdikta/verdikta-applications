import fs from 'node:fs';
import express from 'express';

import { AuthError, createWalletAuth } from './auth/walletAuth.js';
import { createCliBuilder } from './builder/cli.js';
import { createWorkflowBuilder } from './builder/workflow.js';
import { disputeStatementRouter } from './dispute/statement.js';
import { loadConfig } from './config.js';
import { ControlError as ListingControlError } from './control/index.js';
import { createRepositoryChecker } from './control/gitCheck.js';
import { BuildLimitError, createBuildBudget } from './listing/buildBudget.js';
import { RefusalCounter } from './listing/refusals.js';
import { RequestError } from './listing/request.js';
import { MakerSignatureError, QueueFullError, createListingService } from './listing/service.js';
import { createPinner } from './pinning/index.js';
import { ControlError, SiteError } from './site/index.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ID = /^[0-9a-f]{32}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const BADGE_MAX_AGE_S = 60;
// A draft code_review.json, its known issues (at most 256) and an allowlist (at most 64).
const BODY_LIMIT = '1mb';
// { nonce, signature }
const AUTH_BODY_LIMIT = '4kb';
// { signer, signature (at most 4,096 bytes, as hex), creationTx }
const PROOF_BODY_LIMIT = '16kb';

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
 *   POST /api/listings/challenge  { spec, knownIssues?, allowlist?, maker, deploymentProof? } -> 200 the
 *                            message the maker's wallet signs for this request; 400 an invalid request
 *   POST /api/listings       the same with auth: { nonce, signature } -> 202 { id, status, ... };
 *                            400 an invalid request (no build started), 401/403 the maker's wallet did
 *                            not sign it, 429 the build queue is full or a build limit is reached
 *                            (workflow backend), 503 the limits can't be kept. The listing's page then
 *                            says what became of it: refused for its proof, with a named code, or built
 *   POST /api/listings/deployment-message  { maker, repo, baseCommit, chainId, address } -> 200 the
 *                            message a contract listing's deployer or owner signs
 *   GET  /api/listings/:id   the listing's status, refusal, validation report and, once ready, both
 *                            CIDs and the arguments of list(); the maker and the scan's status
 *
 * and the baseline scan's findings, for the maker's wallet only (node P4b2; src/auth/walletAuth.js):
 *
 *   POST /api/listings/:id/scan/challenge   {} -> 200 { action, resource, address, nonce, issuedAt,
 *                            expiresAt, message }: the message the maker's wallet signs as it is;
 *                            404 no such listing, 429 too many challenges waiting
 *   POST /api/listings/:id/scan              { nonce, signature } -> 200 { id, maker, status, scan,
 *                            error }: the builder's scan-findings.json; 400 no nonce or signature,
 *                            401 an unknown, used, expired or mismatched challenge or a bad
 *                            signature, 403 signed by another wallet than the maker's, 404, 409
 *                            the scan has not finished (or will not run)
 *
 * and the maker's dispute statement, pinned for dispute() (node P6b; src/dispute/statement.js),
 * with a deployment configured; the same wallet sign-in, read at the latest block:
 *
 *   POST /api/claims/:claimId/dispute-statement/challenge   {} -> 200 the challenge for the
 *                            claim's listing's maker; 404 no such claim, 409 not disputable now
 *   POST /api/claims/:claimId/dispute-statement             { nonce, signature, statement } ->
 *                            200 { claimId, cid, bytes, sha256 }; 400/413 the statement (at most
 *                            4,096 bytes of UTF-8), 401/403 the signature, 409, 502 PIN_FAILED
 *
 * and, with a deployment configured (node P4b1; src/site/), everything at the indexed block:
 *
 *   GET  /api/feed                     the listings that take commits (design §15)
 *   GET  /api/feed/events?after=&limit=  the contract's events of listings and claims (§13.4)
 *   GET  /api/records/:hash            recordByHash for an artifact hash, its labels, its history
 *   GET  /api/records/:hash/badge.svg  the hash's badge (§4.1)
 *   GET  /api/status                   the indexer's cursor, the keeper's state, refused listing attempts
 *                                      by reason, and how much of the build limits is used (numbers: no
 *                                      address or repository)
 *
 * and a contract listing's control proof (node P8; src/control/, docs/control-proof.md). Anyone may
 * send one: it speaks for itself. The record states the message to sign:
 *
 *   POST /api/records/:hash/listings/:id/control-proof   { signer, signature, creationTx? } -> 200
 *                            { control }, the listing's fact; 400 a malformed field, 404 no such
 *                            listing of the hash, 409 not a contract listing, 422 the proof does not
 *                            count (error: why; nothing is stored), 429 too many being checked, 503
 *                            the listing's chain cannot be read
 *
 * Without one these answer 503 CHAIN_NOT_CONFIGURED (/api/status with the refused counts in its body).
 *
 * @param {object} [o]
 * @param {object} [o.config] - loadConfig(); default from process.env
 * @param {object} [o.builder] - the environment builder (default: its command line, src/builder/cli.js)
 * @param {object} [o.scanner] - the baseline scan (default: the builder's command line, `scan`)
 * @param {object} [o.pinner] - the pinning backend (default: config.pinning)
 * @param {object} [o.auth] - the wallet sign-in (default: createWalletAuth with config.auth)
 * @param {object} [o.logger]
 * @param {object} [o.site] - the chain side (src/site/index.js createSite)
 * @param {Function} [o.checkRepository] - what git says of a listing's repository (default: the
 *   control check's command line, src/control/gitCheck.js)
 * @param {Function} [o.checkDeployment] - a contract listing's signature, checked on its chain and kept
 *   if it counts (default: the site's; with no deployment configured there is nothing it can bind to)
 * @param {Record<string, string|undefined>} [o.env] - where the workflow backend's token is read
 */
export function createApp({ config = loadConfig(process.env), builder, scanner, pinner, auth, logger = consoleLogger, site = null, checkRepository, checkDeployment, env = process.env } = {}) {
  const buildRuns = !builder && config.builds.backend === 'workflow' ? createWorkflowBuilder(config.builds.workflow, { env, logger }) : null;
  const cli = (builder || buildRuns) && scanner ? null : createCliBuilder(config.builder, { logger });
  const pins = pinner ?? createPinner(config.pinning);
  const signIn = auth ?? createWalletAuth({ ttlMs: config.auth.challengeTtlMs });
  // anyone can ask for a listing's challenge, so those wait apart: a flood of them cannot take a
  // maker's sign-in for a scan or a dispute with it
  const listingSignIn = auth ?? createWalletAuth({ ttlMs: config.auth.challengeTtlMs, maxOutstanding: 2000 });
  const noDeployment = async () => {
    throw new ListingControlError('CHAIN_NOT_CHECKED', 'this server has no deployment configured, and a deployment proof names one', 503);
  };
  const listings = createListingService({
    config,
    builder: builder ?? buildRuns ?? cli,
    scanner: scanner ?? cli,
    budget: config.builds.limits ? createBuildBudget({ file: config.builds.stateFile, limits: config.builds.limits, logger }) : null,
    pinner: pins,
    logger,
    auth: listingSignIn,
    refusals: site?.refusals ?? new RefusalCounter(),
    proofs: {
      checkRepository: checkRepository ?? createRepositoryChecker(config.control),
      checkDeployment: checkDeployment ?? site?.checkDeployment ?? noDeployment,
      stake: site?.stake ?? null,
      noteDevTrust: site?.noteDevTrust,
    },
  });
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'stake-attestation-server', version });
  });

  const listingRoute = (name, handler) => (req, res) => {
    try {
      return handler(req, res);
    } catch (err) {
      if (err instanceof RequestError) return res.status(400).json({ error: err.code, issues: err.issues });
      if (err instanceof MakerSignatureError) return res.status(err.status).json({ error: err.code, detail: err.detail });
      if (err instanceof QueueFullError) return res.status(429).json({ error: err.code, detail: err.message });
      if (err instanceof BuildLimitError) return res.status(err.status).json({ error: err.code, detail: err.detail });
      if (err instanceof AuthError) return res.status(err.status).json({ error: err.code, detail: err.detail });
      logger.error(`POST ${name}: ${err?.stack ?? err}`);
      return res.status(500).json({ error: 'INTERNAL' });
    }
  };

  app.post('/api/listings', express.json({ limit: BODY_LIMIT }), listingRoute('/api/listings', (req, res) => {
    const view = listings.submit(req.body);
    return res.status(202).location(`/api/listings/${view.id}`).json(view);
  }));

  app.post('/api/listings/challenge', express.json({ limit: BODY_LIMIT }), listingRoute('/api/listings/challenge', (req, res) => res.set('cache-control', 'no-store').json(listings.challenge(req.body))));

  app.post('/api/listings/deployment-message', express.json({ limit: AUTH_BODY_LIMIT }), listingRoute('/api/listings/deployment-message', (req, res) => res.json(listings.deploymentMessage(req.body))));

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
  const boundedJson = (limit) => {
    const parse = express.json({ limit });
    return (req, res, next) => parse(req, res, (err) => {
      if (!err) return next();
      if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BODY_NOT_JSON' });
      if (err.type === 'entity.too.large') return res.status(413).json({ error: 'BODY_TOO_LARGE', limit });
      return res.status(Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 400).json({ error: 'BODY_INVALID' });
    });
  };
  const authBody = boundedJson(AUTH_BODY_LIMIT);

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

  // the maker's dispute statement, pinned for dispute() (node P6b; src/dispute/statement.js)
  app.use(disputeStatementRouter({ site, pinner: pins, auth: signIn, logger }));

  // the chain side: every answer is of the indexer's block
  const chainRoute = (handler) => async (req, res) => {
    if (!site) return res.status(503).json({ error: 'CHAIN_NOT_CONFIGURED' });
    try {
      return await handler(req, res);
    } catch (err) {
      if (err instanceof SiteError || err instanceof ControlError) return res.status(err.status).json({ error: err.code, detail: err.message });
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

  app.post('/api/records/:hash/listings/:id/control-proof', boundedJson(PROOF_BODY_LIMIT), chainRoute(async (req, res) => {
    const hash = hashParam(req, res);
    if (!hash) return undefined;
    return res.json({ control: await site.submitControlProof(hash, req.params.id, req.body) });
  }));

  app.get('/api/status', (req, res, next) => {
    if (site) return next();
    return res.status(503).json({ error: 'CHAIN_NOT_CONFIGURED', listings: { refused: listings.refusedCounts(), builds: listings.buildUsage() } });
  }, chainRoute(async (_req, res) => {
    const status = site.status();
    return res.json({ ...status, listings: { ...status.listings, builds: listings.buildUsage() } });
  }));

  // body-parser's errors: a body that is not JSON, or one over the limit
  app.use((err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'BODY_NOT_JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'BODY_TOO_LARGE', limit: BODY_LIMIT });
    return next(err);
  });

  app.listings = listings;
  // the workflow backend's sweep for runs nothing follows: src/index.js starts it
  app.buildRuns = buildRuns;
  app.site = site;
  return app;
}
