#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { templateDigests } = require('../campaign/evidence');
const { CASH_QUESTS } = require('../campaign/config');
// Reward candidates are separate from the stricter cash eligibility predicates.
const CASH_REWARD_QUESTS = [...CASH_QUESTS, 'Q9'];
function inspect(filename) {
  const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const claimsPath = path.join(path.dirname(filename), 'claims.json');
  if (fs.existsSync(claimsPath)) {
    const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
    if (claims.policyHash !== state.policyHash)
      throw new Error('Policy mismatch');
    Object.assign(state, claims);
  }
  const verifiedClaims = Object.values(state.verifiedClaims || {});
  return {
    version: state.version,
    policyHash: state.policyHash,
    coverage: state.chain.coverage,
    error: state.chain.error,
    checkedAt: state.chain.checkedAt,
    lagNotice: state.chain.lagNotice,
    evidenceFingerprint: state.chain.evidenceFingerprint,
    snapshotSetHash: state.chain.snapshotSetHash,
    historyComplete: state.chain.historyComplete,
    identities: Object.entries(state.identities || {}).map(
      ([userHash, wallet]) => ({ userHash, wallet }),
    ),
    appliedReleases: state.appliedReleases || {},
    verifiedCashClaims: verifiedClaims.filter(
      (claim) => claim.code === 'VERIFIED' && CASH_QUESTS.includes(claim.quest),
    ),
    verifiedCashCandidateClaims: verifiedClaims
      .filter(
        (claim) =>
          claim.code === 'VERIFIED' && CASH_REWARD_QUESTS.includes(claim.quest),
      )
      .map((claim) => ({ ...claim, rewardStatus: 'candidate-only' })),
    verifiedHouseAssistedCreatorClaims: verifiedClaims.filter(
      (claim) =>
        claim.code === 'VERIFIED' &&
        claim.creatorCompletionKind === 'house-assisted',
    ),
    verifiedClaims,
    priorWallets: state.eligibilityPolicy?.priorWallets,
    teamWallets: state.eligibilityPolicy?.teamWallets,
    houseHunterWallets: state.eligibilityPolicy?.houseHunterWallets || [],
    unsuccessfulAudit: state.audit || [],
    exceptions: state.exceptions,
    evidenceFailures: Object.fromEntries(
      Object.entries(state.evidenceCache || {}).map(([cid, record]) => [
        cid,
        {
          fetchFailure: record.fetchFailure,
          checks: Object.fromEntries(
            Object.entries(record.checks).filter(([, check]) => check.terminal),
          ),
        },
      ]),
    ),
    bounties: state.bounties.map((bounty) => ({
      key: bounty.key,
      creator: bounty.creator,
      createdAt: bounty.createdAt,
      originalWei: bounty.originalWei,
      refunded: bounty.refunded,
      payment: bounty.payment,
      kind: bounty.evidence?.kind,
      classification: bounty.evidence?.classification,
      templateId: bounty.evidence?.templateId,
      scopeDigest: bounty.evidence?.scopeDigest,
      evidenceError: bounty.evidenceError,
      duplicate: bounty.duplicate,
      submissions: bounty.submissions,
      newToCurrentDeployment:
        !state.history.creators[bounty.creator] &&
        state.chain.historyComplete === true,
    })),
    transactions: [...new Set(state.chain.logs.map((log) => log.tx))],
  };
}
async function main() {
  const result =
    process.argv[2] === '--templates'
      ? await templateDigests()
      : inspect(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) {
  main().catch(() => {
    console.error(
      'Campaign inspection failed; check the state path and configuration.',
    );
    process.exitCode = 1;
  });
}
module.exports = { inspect };
