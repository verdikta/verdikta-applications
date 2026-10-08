#!/usr/bin/env node
'use strict';
// Host access is the authorization boundary. This command never locks or writes the ledger.
const fs = require('fs');
const { templateDigests } = require('../campaign/evidence');
async function main() {
  if (process.argv[2] === '--templates') return console.log(JSON.stringify(await templateDigests(),null,2));
  if (!process.argv[2]) throw new Error('Usage: node scripts/campaign-inspect.js /absolute/state/ledger.json | --templates');
  const s=JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const claimsPath = require('path').join(require('path').dirname(process.argv[2]), 'claims.json');
  if (fs.existsSync(claimsPath)) Object.assign(s, JSON.parse(fs.readFileSync(claimsPath, 'utf8')));
  s.conflicts ??= {}; s.audit ??= [];
  // No secrets, raw Zealy IDs, social details, request bodies or package contents.
  console.log(JSON.stringify({ version:s.version, policyHash:s.policyHash, coverage:s.chain.coverage,
    error:s.chain.error, checkedAt:s.chain.checkedAt, historyComplete:s.chain.historyComplete,
    conflicts:Object.keys(s.conflicts), audit:s.audit, bounties:s.bounties.map(b => ({
      key:b.key, creator:b.creator, createdAt:b.createdAt, originalWei:b.originalWei, refunded:b.refunded,
      payment:b.payment, templateId:b.workOrder?.templateId, requestDigest:b.workOrder?.requestDigest,
      review:b.review, evidenceError:b.evidenceError, duplicate:b.duplicate, submissions:b.submissions,
      newCreator:!s.history.creators[b.creator] && s.chain.historyComplete === true
    })), transactions:[...new Set(s.chain.logs.map(l => l.tx))] },null,2));
}
main().catch(() => { console.error('Campaign inspection failed; check path and configuration.'); process.exitCode=1; });
