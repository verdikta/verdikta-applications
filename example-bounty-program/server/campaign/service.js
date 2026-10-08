'use strict';
const crypto = require('crypto');
const express = require('express');
const { address, digest } = require('./config');
const { eligibility } = require('./predicates');
function authenticated(value, secret) {
  if (typeof value !== 'string') return false;
  const hash = x => crypto.createHash('sha256').update(x).digest();
  return crypto.timingSafeEqual(hash(value), hash(secret));
}
function verify(c, store, body, now) {
  const fail = code => ({ ok:false, code, evidence:[] });
  if (store.failed) return fail('VERIFICATION_UNAVAILABLE_RETRY');
  if (!body || ['userId','communityId','subdomain','questId','requestId'].some(k => typeof body[k] !== 'string' || body[k].length < 1 || body[k].length > 128)) return fail('INVALID_REQUEST');
  const quest = Object.keys(c.quests).find(q => c.quests[q] === body.questId);
  if (!quest || body.communityId !== c.communityId || body.subdomain !== c.subdomain) return fail('CAMPAIGN_NOT_ALLOWED');
  let wallet;
  try { wallet=address(body.accounts?.wallet); if (wallet === '0x'+'0'.repeat(40)) throw new Error('ZERO_WALLET'); } catch { return fail('AUTHENTICATED_WALLET_REQUIRED'); }
  return store.transactClaims(s => {
    const user=digest([c.id, body.userId]), request=digest([c.id, body.requestId]), fingerprint=digest([user, wallet, quest]);
    const previous=s.attempts[request];
    if ((!previous && Object.keys(s.attempts).length >= 10000) || s.audit.length >= 20000) return fail('CAPACITY_REVIEW_REQUIRED');
    let result;
    if (previous && previous.fingerprint !== fingerprint) result=fail('REQUEST_ID_REUSED');
    else if ((s.identities[user] && s.identities[user] !== wallet) || (s.wallets[wallet] && s.wallets[wallet] !== user)) {
      s.conflicts[wallet]=true;
      if (s.identities[user]) s.conflicts[s.identities[user]]=true;
      result=fail('IDENTITY_REVIEW_REQUIRED');
    } else {
      s.identities[user]=wallet; s.wallets[wallet]=user;
      // Always re-evaluate even prior success: outage, reorg, exclusions and claim cutoff apply to retries.
      result=eligibility(c,s,quest,wallet,now);
    }
    const record={ fingerprint, user, wallet, quest, code:result.code, evidence:result.evidence, at:now, generation:s.chain.generation || null };
    if (!previous || previous.fingerprint === fingerprint) s.attempts[request]=record;
    if (!previous || previous.code !== result.code || previous.fingerprint !== fingerprint || digest(previous.evidence) !== digest(record.evidence)) s.audit.push({ request,...record });
    return result;
  });
}
function router(c, store, secret, clock=() => Math.floor(Date.now()/1000)) {
  const r=express.Router();
  r.get('/health', (req,res) => {
    const now=clock(), chain=store.state.chain;
    const ready=!store.failed && !chain.error && now >= chain.checkedAt && now-chain.checkedAt <= c.maxAgeSeconds;
    res.status(ready ? 200 : 503).json({ ready, code:ready ? 'READY' : 'INDEX_NOT_READY', historyComplete:chain.historyComplete === true });
  });
  r.post('/verify', (req,res,next) => {
    if (!authenticated(req.get('X-Api-Key'),secret)) return res.status(400).json({ message:'AUTHENTICATION_FAILED' });
    next();
  }, express.json({limit:'8kb'}), (req,res) => {
    // Zealy documents only 200/400. Even authentication/operational failures use a non-success 400 message.
    if (!authenticated(req.get('X-Api-Key'),secret)) return res.status(400).json({ message:'AUTHENTICATION_FAILED' });
    try {
      const result=verify(c,store,req.body,clock());
      return res.status(result.ok ? 200 : 400).json({ message:result.code });
    } catch { return res.status(400).json({ message:'VERIFICATION_UNAVAILABLE_RETRY' }); }
  });
  r.use((err,req,res,next) => {
    res.status(400).json({message:'INVALID_REQUEST'});
  });
  return r;
}
module.exports = { verify, router, authenticated };
