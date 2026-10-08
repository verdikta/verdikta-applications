'use strict';
const crypto = require('crypto');
const express = require('express');
const { address, digest } = require('./config');
const { eligibility } = require('./predicates');
const { message } = require('./messages');
const ATTEMPT_LIMIT = 10000;
const AUDIT_LIMIT = 20000;
function authenticated(value, secret) {
  if (typeof value !== 'string' || typeof secret !== 'string') return false;
  const hash = (input) => crypto.createHash('sha256').update(input).digest();
  return crypto.timingSafeEqual(hash(value), hash(secret));
}
function trimDiagnostics(state, store) {
  const attempts = Object.entries(state.attempts).sort(
    ([, first], [, second]) => first.at - second.at,
  );
  if (
    !store.capacityWarned &&
    (attempts.length >= ATTEMPT_LIMIT * 0.8 ||
      state.audit.length >= AUDIT_LIMIT * 0.8)
  ) {
    console.warn(
      'Campaign diagnostic retention is at 80% capacity; oldest unsuccessful records will be evicted.',
    );
    store.capacityWarned = true;
  }
  for (const [requestHash] of attempts.slice(
    0,
    Math.max(0, attempts.length - ATTEMPT_LIMIT),
  ))
    delete state.attempts[requestHash];
  state.audit.sort((first, second) => first.at - second.at);
  state.audit.splice(0, Math.max(0, state.audit.length - AUDIT_LIMIT));
}
function verify(config, store, body, now) {
  const fail = (code) => ({ ok: false, code, evidence: [] });
  if (store.failed) return fail('VERIFICATION_UNAVAILABLE_RETRY');
  if (
    !body ||
    ['userId', 'communityId', 'subdomain', 'questId', 'requestId'].some(
      (field) =>
        typeof body[field] !== 'string' ||
        !body[field].length ||
        body[field].length > 128,
    )
  )
    return fail('INVALID_REQUEST');
  const quest = Object.keys(config.quests).find(
    (alias) => config.quests[alias] === body.questId,
  );
  if (
    !quest ||
    body.communityId !== config.communityId ||
    body.subdomain !== config.subdomain
  )
    return fail('CAMPAIGN_NOT_ALLOWED');
  let wallet;
  try {
    wallet = address(body.accounts?.wallet);
    if (wallet === '0x' + '0'.repeat(40)) throw new Error();
  } catch {
    return fail('AUTHENTICATED_WALLET_REQUIRED');
  }
  return store.transactClaims((state) => {
    const userHash = digest([config.id, body.userId]);
    const requestHash = digest([config.id, body.requestId]);
    const fingerprint = digest([userHash, wallet, quest]);
    const previous =
      state.attempts[requestHash] ||
      Object.values(state.verifiedClaims).find(
        (claim) => claim.request === requestHash,
      );
    let result;
    if (previous && previous.fingerprint !== fingerprint) {
      result = fail('REQUEST_ID_REUSED');
    } else if (
      (state.identities[userHash] && state.identities[userHash] !== wallet) ||
      (state.wallets[wallet] && state.wallets[wallet] !== userHash)
    ) {
      result = fail('IDENTITY_REVIEW_REQUIRED');
    } else {
      result = eligibility(config, state, quest, wallet, now);
    }
    const record = {
      request: requestHash,
      fingerprint,
      userHash,
      wallet,
      quest,
      code: result.code,
      evidence: result.evidence,
      at: now,
      generation: state.chain.generation || null,
    };
    if (result.ok) {
      state.identities[userHash] = wallet;
      state.wallets[wallet] = userHash;
      const milestone = digest([userHash, wallet, quest]);
      // Successful milestones are durable, compacted separately from evictable failed-attempt diagnostics.
      const earned = state.verifiedClaims[milestone];
      state.verifiedClaims[milestone] = {
        ...record,
        firstVerifiedAt: earned?.firstVerifiedAt ?? now,
      };
      delete state.attempts[requestHash];
    } else {
      if (!previous || previous.fingerprint === fingerprint)
        state.attempts[requestHash] = record;
      if (
        !previous ||
        previous.code !== result.code ||
        previous.fingerprint !== fingerprint
      )
        state.audit.push(record);
    }
    trimDiagnostics(state, store);
    return result;
  });
}
function router(
  config,
  store,
  secret,
  clock = () => Math.floor(Date.now() / 1000),
) {
  const routes = express.Router();
  routes.get('/health', (request, response) => {
    const now = clock();
    const chain = store.state.chain;
    const ready =
      !store.failed &&
      !chain.error &&
      now >= chain.checkedAt &&
      now - chain.checkedAt <= config.maxAgeSeconds;
    response.status(ready ? 200 : 503).json({
      ready,
      code: ready ? 'READY' : chain.error || 'INDEX_NOT_READY',
      historyComplete: chain.historyComplete === true,
    });
  });
  routes.post(
    '/verify',
    (request, response, next) => {
      if (!authenticated(request.get('X-Api-Key'), secret))
        return response
          .status(400)
          .json({ message: message('AUTHENTICATION_FAILED') });
      next();
    },
    express.json({ limit: '8kb' }),
    (request, response) => {
      try {
        const result = verify(config, store, request.body, clock());
        return response
          .status(result.ok ? 200 : 400)
          .json({ message: message(result.code) });
      } catch {
        return response
          .status(400)
          .json({ message: message('VERIFICATION_UNAVAILABLE_RETRY') });
      }
    },
  );
  routes.use((error, request, response, next) => {
    response.status(400).json({ message: message('INVALID_REQUEST') });
  });
  return routes;
}
module.exports = {
  verify,
  router,
  authenticated,
  trimDiagnostics,
  ATTEMPT_LIMIT,
  AUDIT_LIMIT,
};
