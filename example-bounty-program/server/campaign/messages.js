'use strict';
const sentences = {
  VERIFIED: 'Verified: you completed this campaign milestone.',
  INVALID_REQUEST:
    'Not verified: the verification request is invalid. Reconnect your wallet and retry.',
  AUTHENTICATION_FAILED:
    'Not verified: the campaign connection could not be authenticated. Contact the campaign operator.',
  CAMPAIGN_NOT_ALLOWED:
    'Not verified: this quest or community is not configured for this campaign.',
  AUTHENTICATED_WALLET_REQUIRED:
    'Not verified: connect and authenticate your wallet in Zealy.',
  IDENTITY_REVIEW_REQUIRED:
    'Not verified: this user or wallet is already linked to another campaign identity. Contact support.',
  REQUEST_ID_REUSED:
    'Not verified: this request identifier was already used for different claim details. Retry from Zealy.',
  VERIFICATION_UNAVAILABLE_RETRY:
    'Not verified yet: the verification service is unavailable. Please retry later.',
  INDEX_NOT_READY_RETRY:
    'Not verified yet: confirmed blockchain data is not current. Please retry later.',
  EXCEPTIONS_FILE_INVALID:
    'Not verified yet: campaign exception settings need operator attention. Please retry later.',
  CAMPAIGN_NOT_STARTED: 'Not verified yet: the campaign has not started.',
  CLAIM_WINDOW_CLOSED:
    'Not verified: the campaign claim and correction window has closed.',
  TEAM_WALLET_EXCLUDED:
    'Not verified: team wallets are excluded from these campaign claims.',
  WALLET_HELD_FOR_REVIEW:
    'Not verified yet: this wallet is held for an operator review.',
  BOUNTY_DENIED:
    'Not verified: the relevant bounty is excluded by a reviewed campaign exception.',
  HISTORY_INCOMPLETE_RETRY:
    'Not verified yet: current-deployment history is still being reconciled. Please retry later.',
  PRE_CAMPAIGN_ACTIVITY:
    'Not verified: this wallet has prior activity on the current deployment or the configured prior-wallet list.',
  NO_MATCHING_CHAIN_ACTIVITY:
    'Not verified yet: no qualifying activity was found for this wallet on the campaign deployment.',
  DUPLICATE_SCOPE_REVIEW:
    'Not verified: campaign bounties share the same task scope. Contact support if this is unexpected.',
  SUBMISSION_WINDOW_OUT_OF_RANGE:
    'Not verified: the bounty submission window is outside the campaign duration limits.',
  MINIMUM_ORIGINAL_FUNDING_NOT_MET:
    'Not verified: the original bounty funding is below the campaign minimum.',
  EVIDENCE_UNAVAILABLE_OR_INVALID:
    'Not verified yet: the original evaluation or submission evidence could not be validated. Retry or contact support.',
  CASH_ELIGIBILITY_REQUIRED:
    'Not verified: this cash quest requires an approved work order or a reviewed custom-bounty exception.',
  APPROVED_WORK_ORDER_REQUIRED:
    'Not verified: this template quest requires an approved work order.',
  BOUNTY_REFUNDED:
    'Not verified: the bounty was refunded before this milestone was completed.',
  REPEAT_TIMING_SCOPE_OR_OUTCOME_NOT_MET:
    'Not verified yet: the required distinct repeat task, timing, or paid outcome is missing.',
  PAYMENT_NOT_RECEIVED_IN_WINDOW:
    'Not verified yet: your bounty has not paid an eligible hunter inside the campaign window. Retry after settlement.',
  PASSING_PACKAGE_PENDING:
    'Not verified yet: a valid submitted work package and completed passing result are required.',
  MILESTONE_NOT_MET_OR_PENDING:
    'Not verified yet: the required campaign milestone is incomplete.',
};
function message(code) {
  return `${sentences[code] || sentences.VERIFICATION_UNAVAILABLE_RETRY} [${code}]`;
}
module.exports = { message };
