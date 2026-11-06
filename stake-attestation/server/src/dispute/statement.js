// The maker's dispute statement (node P6b; design §13.2, erratum E2). dispute() takes only the
// statement's CID: the contract writes "verdikta-dispute: <cid>" as the request's second
// addendum line and the arbiters fetch the statement, at most MAX_DISPUTE_STATEMENT_BYTES (4,096)
// of UTF-8. The site pins it, because the browser holds no pinning credentials:
//
//   POST /api/claims/:claimId/dispute-statement/challenge  {} -> 200 the challenge (walletAuth:
//        action pin-dispute, resource claim:<claimId>, address the listing's maker)
//   POST /api/claims/:claimId/dispute-statement  { nonce, signature, statement } -> 200
//        { claimId, cid, bytes, sha256 }
//
// Only the listing's maker may pin one (a wallet signature over a one-time challenge,
// src/auth/walletAuth.js), and only while the claim can be disputed: a judged valid outcome,
// undisputed, inside its dispute window, read at the latest block through the lens
// (disputeDeadline). The statement is checked (non-blank, well-formed text, at most 4,096 bytes)
// and the claim read before the signature is checked, so a refusal for either costs the maker no
// challenge. Refusals: 400 a malformed claim id, body or statement; 413 a statement over the
// limit (STATEMENT_TOO_LONG) or a body over BODY_LIMIT; 404 no such claim; 409
// CLAIM_NOT_DISPUTABLE; walletAuth's 401 and 429; 403 NOT_THE_MAKER; 502 PIN_FAILED; 503
// CHAIN_NOT_CONFIGURED or CHAIN_UNAVAILABLE; 502 PIN_CID_UNVERIFIED when the backend answers a
// CID other than the statement's raw CID (CIDv1, raw, sha2-256), the only form the maker's page
// can check against the bytes. Every answer is no-store. Nothing else changes: the
// pin goes to the server's configured backend, as the listing archives do.
import crypto from 'node:crypto';
import express from 'express';

import { stakeAttestation } from '../chain/abi.js';
import { codeReview } from '../common.js';
import { AuthError } from '../auth/walletAuth.js';
import { PinError, rawCid } from '../pinning/index.js';

export const MAX_STATEMENT_BYTES = codeReview.MAX_DISPUTE_STATEMENT_BYTES;
export const PIN_DISPUTE = 'pin-dispute';
const CLAIM_ID = /^[1-9][0-9]{0,19}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// { nonce, signature, statement }: 4,096 bytes of text are at most 24,576 characters of JSON escapes
const BODY_LIMIT = '32kb';

export class StatementError extends Error {
  constructor(status, code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'StatementError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** The statement's UTF-8 bytes; throws StatementError unless it is a non-blank, well-formed string within the limit. */
export function statementBytes(statement) {
  if (typeof statement !== 'string' || !statement.trim() || LONE_SURROGATE.test(statement)) {
    throw new StatementError(400, 'STATEMENT_INVALID', 'the statement is non-blank UTF-8 text');
  }
  const bytes = Buffer.from(statement, 'utf8');
  if (bytes.length > MAX_STATEMENT_BYTES) throw new StatementError(413, 'STATEMENT_TOO_LONG', `the statement is ${bytes.length} bytes; at most ${MAX_STATEMENT_BYTES}`);
  return bytes;
}

/**
 * The claim's listing's maker, when the claim can be disputed at the latest block; reads the
 * claim, its listing and the lens's disputeDeadline at one block.
 * @param {import('ethers').JsonRpcApiProvider} provider
 * @param {string} address - the StakeAttestation deployment (merged ABI: the lens answers there)
 */
export async function disputeTarget(provider, address, claimId) {
  let block;
  let read;
  try {
    block = await provider.send('eth_getBlockByNumber', ['latest', false]);
    read = async (fn, args = []) => stakeAttestation.decodeFunctionResult(fn, await provider.send('eth_call', [{ to: address, data: stakeAttestation.encodeFunctionData(fn, args) }, block.number]));
  } catch {
    throw new StatementError(503, 'CHAIN_UNAVAILABLE', 'the chain could not be read');
  }
  const id = BigInt(claimId);
  let found;
  try {
    const [count] = await read('claimCount');
    if (id > count) found = null;
    else {
      const [claim] = await read('getClaim', [id]);
      const [[listing], [deadline]] = await Promise.all([read('getListing', [claim.listingId]), read('disputeDeadline', [id])]);
      found = { maker: listing.maker, deadline };
    }
  } catch {
    throw new StatementError(503, 'CHAIN_UNAVAILABLE', 'the chain could not be read');
  }
  if (!found) throw new StatementError(404, 'CLAIM_NOT_FOUND', `there is no claim ${claimId}`);
  if (found.deadline === 0n || BigInt(block.timestamp) >= found.deadline) {
    throw new StatementError(409, 'CLAIM_NOT_DISPUTABLE', 'the claim is not a judged valid outcome inside its dispute window, or it was disputed already');
  }
  return { maker: found.maker };
}

/**
 * @param {object} o
 * @param {object|null} o.site - the chain side (src/site/index.js): its provider and contract
 * @param {{ pin(bytes: Buffer, o?: { name?: string }): Promise<string> }} o.pinner
 * @param {object} o.auth - createWalletAuth()
 * @param {object} o.logger
 * @returns {import('express').Router}
 */
export function disputeStatementRouter({ site, pinner, auth, logger }) {
  const router = express.Router();
  const noStore = (_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  };
  const parse = express.json({ limit: BODY_LIMIT });
  const body = (req, res, next) => parse(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'BODY_TOO_LARGE', limit: BODY_LIMIT });
    return res.status(400).json({ error: err.type === 'entity.parse.failed' ? 'BODY_NOT_JSON' : 'BODY_INVALID' });
  });
  const route = (handler) => async (req, res) => {
    if (!site) return res.status(503).json({ error: 'CHAIN_NOT_CONFIGURED' });
    const { claimId } = req.params;
    if (!CLAIM_ID.test(claimId)) return res.status(400).json({ error: 'BAD_CLAIM_ID', detail: 'a claim id is a whole number from 1' });
    try {
      return await handler(req, res, claimId);
    } catch (err) {
      if (err instanceof StatementError || err instanceof AuthError) return res.status(err.status).json({ error: err.code, detail: err.detail });
      if (err instanceof PinError) {
        logger.error(`claim ${claimId}: the dispute statement could not be pinned (${err.code})`);
        return res.status(502).json({ error: 'PIN_FAILED' });
      }
      logger.error(`${req.method} /api/claims/:id/dispute-statement failed (${err?.name ?? 'error'})`);
      return res.status(500).json({ error: 'INTERNAL' });
    }
  };
  const resourceOf = (claimId) => `claim:${claimId}`;

  router.post('/api/claims/:claimId/dispute-statement/challenge', noStore, body, route(async (_req, res, claimId) => {
    const { maker } = await disputeTarget(site.provider, site.contract, claimId);
    return res.json(auth.challenge({ action: PIN_DISPUTE, resource: resourceOf(claimId), address: maker }));
  }));

  router.post('/api/claims/:claimId/dispute-statement', noStore, body, route(async (req, res, claimId) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const bytes = statementBytes(b.statement);
    await disputeTarget(site.provider, site.contract, claimId);
    const v = auth.verify({ action: PIN_DISPUTE, resource: resourceOf(claimId), nonce: b.nonce, signature: b.signature });
    if (!v.ok && v.status === 403) return res.status(403).json({ error: 'NOT_THE_MAKER', detail: `${v.detail}, the listing's maker` });
    if (!v.ok) return res.status(v.status).json({ error: v.code, detail: v.detail });
    const cid = await pinner.pin(bytes, { name: `dispute-statement-claim-${claimId}.txt` });
    // a statement is one block: the backend must answer its raw CID, the one the maker's page
    // checks against the bytes before paying for the dispute
    if (cid !== rawCid(bytes)) {
      logger.error(`claim ${claimId}: the pinning backend answered a CID that is not the statement's raw CID`);
      return res.status(502).json({ error: 'PIN_CID_UNVERIFIED', detail: 'the pinning backend did not answer the statement\'s raw CID (CIDv1, raw, sha2-256)' });
    }
    logger.info(`claim ${claimId}: dispute statement pinned (${cid}, ${bytes.length} bytes)`);
    return res.json({ claimId, cid, bytes: bytes.length, sha256: `0x${crypto.createHash('sha256').update(bytes).digest('hex')}` });
  }));

  return router;
}
