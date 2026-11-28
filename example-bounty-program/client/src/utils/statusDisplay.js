/**
 * Centralized status display utilities
 * Single source of truth for all status labels, descriptions, and styling
 */

// Icon name constants - components will map these to Lucide icons
export const IconName = {
  CLOCK: 'clock',
  PARTY: 'party',
  LOCK: 'lock',
  HOURGLASS: 'hourglass',
  CHECK: 'check',
  X: 'x',
  HELP: 'help',
  ALERT: 'alert',
  REFRESH: 'refresh',
};

// =============================================================================
// BOUNTY STATUS
// =============================================================================

export const BountyStatus = {
  OPEN: 'OPEN',
  EXPIRED: 'EXPIRED',
  AWARDED: 'AWARDED',
  CLOSED: 'CLOSED',
};

// Map on-chain status codes to status strings
export const ON_CHAIN_STATUS_MAP = {
  0: BountyStatus.OPEN,
  1: BountyStatus.EXPIRED,
  2: BountyStatus.AWARDED,
  3: BountyStatus.CLOSED,
};

const BOUNTY_STATUS_CONFIG = {
  [BountyStatus.OPEN]: {
    label: 'Open',
    description: 'This bounty is accepting submissions. Submit your work before the deadline.',
    badgeClass: 'status-open',
    icon: null,
  },
  [BountyStatus.EXPIRED]: {
    label: 'Expired',
    description: 'The submission deadline has passed. No new submissions accepted.',
    badgeClass: 'status-expired',
    icon: IconName.CLOCK,
  },
  [BountyStatus.AWARDED]: {
    label: 'Awarded',
    description: 'A winning submission was approved and the winner has been paid.',
    badgeClass: 'status-awarded',
    icon: IconName.PARTY,
  },
  [BountyStatus.CLOSED]: {
    label: 'Closed',
    description: 'This bounty has been closed without a winner. Funds returned to creator.',
    badgeClass: 'status-closed',
    icon: IconName.LOCK,
  },
};

// =============================================================================
// SUBMISSION STATUS
// =============================================================================

export const SubmissionStatus = {
  // Pending/In-progress states (internal names vary)
  PREPARED: 'Prepared',
  PENDING_VERDIKTA: 'PendingVerdikta',
  PENDING_EVALUATION: 'PENDING_EVALUATION',

  // Oracle evaluated, awaiting on-chain finalization
  ACCEPTED_PENDING_CLAIM: 'ACCEPTED_PENDING_CLAIM',
  REJECTED_PENDING_FINALIZATION: 'REJECTED_PENDING_FINALIZATION',
  // v2 (item 12's Q-of-N rule): a soft fail (R..Q-1 arbiters at the threshold) or a round that
  // ended with no result; finalize / closeFailedRound then puts the submission in AwaitingRerun.
  SOFT_FAIL_PENDING_FINALIZATION: 'SOFT_FAIL_PENDING_FINALIZATION',
  NO_RESULT_PENDING_CLOSE: 'NO_RESULT_PENDING_CLOSE',

  // v2: may re-run (2-hour window, up to 6 rounds), keeping its place and bond
  AWAITING_RERUN: 'AWAITING_RERUN',
  AWAITING_RERUN_ONCHAIN: 'AwaitingRerun',

  // Creator approval window
  PENDING_CREATOR_APPROVAL: 'PendingCreatorApproval',

  // Final states
  PASSED: 'Passed',
  PASSED_PAID: 'PassedPaid',
  PASSED_UNPAID: 'PassedUnpaid',
  APPROVED: 'APPROVED',
  ACCEPTED: 'ACCEPTED',
  FAILED: 'Failed',
  REJECTED: 'REJECTED',
};

// All statuses that indicate evaluation is in progress
export const PENDING_STATUSES = [
  SubmissionStatus.PREPARED,
  SubmissionStatus.PENDING_VERDIKTA,
  SubmissionStatus.PENDING_EVALUATION,
  SubmissionStatus.PENDING_CREATOR_APPROVAL,
  'PREPARED', // uppercase variant
];

// All statuses that indicate the submission PASSED evaluation. Note this says
// nothing about payment: the collapsed status is 'APPROVED' for both the winner
// (PassedPaid) and a submission that passed but lost the bounty (PassedUnpaid).
// The two are told apart by onChainStatus — see getSubmissionStatusCategory.
const SUCCESS_STATUSES = [
  SubmissionStatus.PASSED,
  SubmissionStatus.PASSED_PAID,
  SubmissionStatus.APPROVED,
  SubmissionStatus.ACCEPTED,
  SubmissionStatus.ACCEPTED_PENDING_CLAIM,
];

// All statuses that indicate failure
const FAILURE_STATUSES = [
  SubmissionStatus.FAILED,
  SubmissionStatus.REJECTED,
  SubmissionStatus.REJECTED_PENDING_FINALIZATION,
];

const SUBMISSION_STATUS_CONFIG = {
  // Pending states - all map to the same user-facing display
  pending: {
    label: 'Evaluating',
    description: 'Your submission is being evaluated by the AI jury. This typically takes 2-4 minutes.',
    badgeClass: 'status-pending',
    icon: IconName.HOURGLASS,
  },
  // Creator approval window — awaiting bounty creator review
  pending_creator_approval: {
    label: 'Pending Creator Approval',
    description: 'Awaiting bounty creator review. If not approved before the window closes, the submission proceeds to AI evaluation.',
    badgeClass: 'status-pending',
    icon: IconName.HOURGLASS,
  },
  // Oracle evaluated, passed threshold, awaiting on-chain finalization
  accepted_pending_claim: {
    label: 'Approved \u2014 Ready to Claim',
    description: 'AI evaluation passed the threshold. Click "Claim Bounty" to finalize on-chain.',
    badgeClass: 'status-approved',
    icon: IconName.CHECK,
  },
  // Oracle evaluated, below threshold, awaiting on-chain finalization
  rejected_pending_finalization: {
    label: 'Rejected \u2014 Pending Finalization',
    description: 'Hard fail: fewer arbiters than the forfeit line (R) scored at the threshold. Finalizing fails it and the hunter bond goes to the creator.',
    badgeClass: 'status-rejected',
    icon: IconName.X,
  },
  // v2: soft fail — finalize puts it in AwaitingRerun
  soft_fail_pending_finalization: {
    label: 'Soft Fail \u2014 Pending Finalization',
    description: 'Some arbiters scored it at the threshold, but fewer than the quota (Q). Finalizing keeps the bond and opens a 2-hour window to re-run with a fresh jury.',
    badgeClass: 'status-pending',
    icon: IconName.REFRESH,
  },
  // v2: the round ended with no result (not the hunter's fault)
  no_result_pending_close: {
    label: 'No Result \u2014 Close Round',
    description: 'The round ended without a result (too few commits or reveals, or it was never drawn). Closing it refunds what is left of the prepay; the submission keeps its place and bond and may re-run.',
    badgeClass: 'status-pending',
    icon: IconName.ALERT,
  },
  // v2: awaiting a re-run
  awaiting_rerun: {
    label: 'Awaiting Re-run',
    description: 'Soft fail or no result: the hunter (or the bond funder) may re-run it with a fresh jury within 2 hours (up to 6 rounds), keeping its place and bond. After the window anyone can expire it and the bond goes back.',
    badgeClass: 'status-pending',
    icon: IconName.REFRESH,
  },
  // Success states
  success: {
    label: 'Approved',
    description: 'Your submission was approved and selected as the winner.',
    badgeClass: 'status-approved',
    icon: IconName.CHECK,
  },
  // Passed the threshold, but another submission won the bounty (on-chain
  // PassedUnpaid). Distinct from `success` because no payout was made — showing
  // these as plain "Approved" told hunters they had won when they had not.
  success_unpaid: {
    label: 'Passed \u2014 Not Selected',
    description: 'Your submission met the evaluation threshold, but another submission won this bounty. No payout was made for this submission.',
    badgeClass: 'status-passed-unpaid',
    icon: IconName.CHECK,
  },
  // Failure states
  failure: {
    label: 'Rejected',
    description: 'Your submission did not meet the evaluation threshold or failed a must-pass criterion.',
    badgeClass: 'status-rejected',
    icon: IconName.X,
  },
  // Unknown/other
  unknown: {
    label: 'Unknown',
    description: 'Status information unavailable.',
    badgeClass: 'status-unknown',
    icon: IconName.HELP,
  },
};

// =============================================================================
// HELPER FUNCTIONS - BOUNTY
// =============================================================================

/**
 * Get user-friendly label for bounty status
 */
export function getBountyStatusLabel(status) {
  const config = BOUNTY_STATUS_CONFIG[status?.toUpperCase?.()];
  return config?.label || status || 'Unknown';
}

/**
 * Get description/tooltip text for bounty status
 */
export function getBountyStatusDescription(status) {
  const config = BOUNTY_STATUS_CONFIG[status?.toUpperCase?.()];
  return config?.description || 'Status information unavailable.';
}

/**
 * Get CSS class for bounty status badge
 */
export function getBountyStatusBadgeClass(status) {
  const config = BOUNTY_STATUS_CONFIG[status?.toUpperCase?.()];
  return config?.badgeClass || 'status-unknown';
}

/**
 * Get icon for bounty status
 */
export function getBountyStatusIcon(status) {
  const config = BOUNTY_STATUS_CONFIG[status?.toUpperCase?.()];
  return config?.icon || null;
}

/**
 * Check if bounty is open for submissions
 */
export function isBountyOpen(status) {
  return status?.toUpperCase?.() === BountyStatus.OPEN;
}

// =============================================================================
// HELPER FUNCTIONS - SUBMISSION
// =============================================================================

/**
 * Normalize submission status to category (pending, success, success_unpaid,
 * failure, unknown).
 *
 * `onChainStatus` is the low-level contract enum name and is optional. It is the
 * ONLY way to tell a paid winner from a submission that passed but lost — the
 * collapsed `status` is 'APPROVED' for both. Callers that have the submission
 * record should always pass it; omitting it falls back to the old behaviour of
 * showing every passing submission as a plain "Approved".
 */
function getSubmissionStatusCategory(status, onChainStatus) {
  if (!status) return 'unknown';

  const normalizedStatus = status.toString();

  if (onChainStatus === SubmissionStatus.PASSED_UNPAID) {
    return 'success_unpaid';
  }

  if (normalizedStatus === 'PendingCreatorApproval') {
    return 'pending_creator_approval';
  }
  if (PENDING_STATUSES.includes(normalizedStatus)) {
    return 'pending';
  }
  // Oracle evaluated but not yet finalized — specific display categories
  if (normalizedStatus === 'ACCEPTED_PENDING_CLAIM') {
    return 'accepted_pending_claim';
  }
  if (normalizedStatus === 'REJECTED_PENDING_FINALIZATION') {
    return 'rejected_pending_finalization';
  }
  if (normalizedStatus === 'SOFT_FAIL_PENDING_FINALIZATION') {
    return 'soft_fail_pending_finalization';
  }
  if (normalizedStatus === 'NO_RESULT_PENDING_CLOSE') {
    return 'no_result_pending_close';
  }
  if (normalizedStatus === 'AWAITING_RERUN' || normalizedStatus === 'AwaitingRerun') {
    return 'awaiting_rerun';
  }
  if (SUCCESS_STATUSES.includes(normalizedStatus)) {
    return 'success';
  }
  if (FAILURE_STATUSES.includes(normalizedStatus)) {
    return 'failure';
  }
  return 'unknown';
}

/**
 * Get user-friendly label for submission status
 */
export function getSubmissionStatusLabel(status, onChainStatus) {
  const category = getSubmissionStatusCategory(status, onChainStatus);
  return SUBMISSION_STATUS_CONFIG[category].label;
}

/**
 * Get description/tooltip text for submission status
 */
export function getSubmissionStatusDescription(status, onChainStatus) {
  const category = getSubmissionStatusCategory(status, onChainStatus);
  return SUBMISSION_STATUS_CONFIG[category].description;
}

/**
 * Get CSS class for submission status badge
 */
export function getSubmissionStatusBadgeClass(status, onChainStatus) {
  const category = getSubmissionStatusCategory(status, onChainStatus);
  return SUBMISSION_STATUS_CONFIG[category].badgeClass;
}

/**
 * Get icon for submission status
 */
export function getSubmissionStatusIcon(status, onChainStatus) {
  const category = getSubmissionStatusCategory(status, onChainStatus);
  return SUBMISSION_STATUS_CONFIG[category].icon;
}

/**
 * Get full display text with icon for submission status
 */
export function getSubmissionStatusDisplay(status, onChainStatus) {
  const icon = getSubmissionStatusIcon(status, onChainStatus);
  const label = getSubmissionStatusLabel(status, onChainStatus);
  return icon ? `${icon} ${label}` : label;
}

/**
 * Check if submission status is pending (evaluation in progress)
 */
export function isSubmissionPending(status) {
  return getSubmissionStatusCategory(status) === 'pending';
}

/**
 * Check if submission is actually on-chain (started, not just prepared).
 * "Prepared" submissions only exist in the backend, not on the blockchain.
 * Only "PendingVerdikta" submissions can be timed out or have evaluations checked.
 */
export function isSubmissionOnChain(status) {
  if (!status) return false;
  const s = status.toString();
  return s === SubmissionStatus.PENDING_VERDIKTA ||
         s === SubmissionStatus.PENDING_EVALUATION ||
         s === 'PENDING_EVALUATION' ||
         s === SubmissionStatus.PENDING_CREATOR_APPROVAL ||
         s === SubmissionStatus.ACCEPTED_PENDING_CLAIM ||
         s === SubmissionStatus.REJECTED_PENDING_FINALIZATION ||
         s === SubmissionStatus.SOFT_FAIL_PENDING_FINALIZATION ||
         s === SubmissionStatus.NO_RESULT_PENDING_CLOSE ||
         s === SubmissionStatus.AWAITING_RERUN ||
         s === SubmissionStatus.AWAITING_RERUN_ONCHAIN;
}

/** v2 local statuses whose round is in flight on-chain (PendingVerdikta). */
export const IN_FLIGHT_STATUSES = [
  'PENDING_EVALUATION', 'PendingVerdikta', 'ACCEPTED_PENDING_CLAIM', 'REJECTED_PENDING_FINALIZATION',
  'SOFT_FAIL_PENDING_FINALIZATION', 'NO_RESULT_PENDING_CLOSE',
];

/** Is the submission awaiting a re-run (v2, on-chain AwaitingRerun)? */
export function isAwaitingRerun(sub) {
  return sub?.status === 'AWAITING_RERUN' || sub?.onChainStatus === 'AwaitingRerun';
}

/** Round phase labels (v2 aggregator getRoundInfo / lens getOracleResult phase). */
export const ROUND_PHASE_LABELS = {
  0: 'Not started', 1: 'Drawing jury', 2: 'Beacons', 3: 'Commit', 4: 'Closing commits',
  5: 'Reveal', 6: 'Final', 7: 'Settled', 8: 'Failed', 9: 'Cancelled',
};
/** The round timeline steps shown per in-flight submission (phase number -> step). */
export const ROUND_TIMELINE = [
  { phase: 1, label: 'Draw' },
  { phase: 2, label: 'Beacons', beaconsOnly: true },
  { phase: 3, label: 'Commit' },
  { phase: 4, label: 'Close' },
  { phase: 5, label: 'Reveal' },
  { phase: 6, label: 'Result' },
];
/** Item 12's outcome names (lens getOracleResult.outcome). */
export const ROUND_OUTCOME_LABELS = {
  not_ready: 'In progress', no_result: 'No result', pass: 'Pass', soft_fail: 'Soft fail', hard_fail: 'Hard fail',
};

/**
 * A judged round's verdict as the CONTRACT decides it (BountyRules, item 12): the number of
 * arbiters scoring at or above the threshold against Q and R, never the aggregate score against
 * the threshold (scores 100/100/70/70 at threshold 80 average 85, yet two of four is a soft fail
 * at Q = 3). The lens's outcome wins when the page has it; otherwise the server's status, which
 * the sync derives from the same outcome.
 * @param {string} status - the submission's status
 * @param {{outcome?: string}} [roundState] - the lens's round state (getOracleResult)
 * @returns {'pass'|'soft_fail'|'hard_fail'|null} null when no verdict is known
 */
export function roundVerdict(status, roundState) {
  const o = roundState?.outcome;
  if (o === 'pass' || o === 'soft_fail' || o === 'hard_fail') return o;
  if (status === 'ACCEPTED_PENDING_CLAIM') return 'pass';
  if (status === 'SOFT_FAIL_PENDING_FINALIZATION') return 'soft_fail';
  if (status === 'REJECTED_PENDING_FINALIZATION') return 'hard_fail';
  return null;
}

/**
 * Check if submission status is successful
 */
export function isSubmissionSuccess(status, onChainStatus) {
  const category = getSubmissionStatusCategory(status, onChainStatus);
  // Both categories passed evaluation; they differ only in whether this
  // submission was the one paid. Use isSubmissionPaidWinner for that.
  return category === 'success' || category === 'success_unpaid';
}

/**
 * Check if the submission passed evaluation AND was the one paid.
 */
export function isSubmissionPaidWinner(status, onChainStatus) {
  return getSubmissionStatusCategory(status, onChainStatus) === 'success';
}

/**
 * Check if submission status is a failure
 */
export function isSubmissionFailure(status) {
  return getSubmissionStatusCategory(status) === 'failure';
}

/**
 * Check if any submissions in array are pending
 */
export function hasAnyPendingSubmissions(submissions) {
  if (!Array.isArray(submissions)) return false;
  return submissions.some(sub => isSubmissionPending(sub?.status));
}

// =============================================================================
// ARCHIVE STATUS (for MyBounties page)
// =============================================================================

export const ArchiveStatus = {
  EXPIRED: 'expired',
  RETRIEVED: 'retrieved',
  VERIFIED: 'verified',
  REPINNED: 'repinned',
  FAILED: 'failed',
  PENDING: 'pending',
};

const ARCHIVE_STATUS_CONFIG = {
  [ArchiveStatus.EXPIRED]: {
    label: 'Expired',
    description: 'Archive period has expired. Files may no longer be available.',
    badgeClass: 'archive-expired',
    icon: IconName.ALERT,
  },
  [ArchiveStatus.RETRIEVED]: {
    label: 'Retrieved',
    description: 'Files have been successfully retrieved from archive.',
    badgeClass: 'archive-retrieved',
    icon: IconName.CHECK,
  },
  [ArchiveStatus.VERIFIED]: {
    label: 'Archived',
    description: 'Files are archived and available for download.',
    badgeClass: 'archive-verified',
    icon: IconName.CHECK,
  },
  [ArchiveStatus.REPINNED]: {
    label: 'Re-pinned',
    description: 'Files have been re-pinned to extend availability.',
    badgeClass: 'archive-repinned',
    icon: IconName.REFRESH,
  },
  [ArchiveStatus.FAILED]: {
    label: 'Failed',
    description: 'Failed to archive or retrieve files.',
    badgeClass: 'archive-failed',
    icon: IconName.X,
  },
  [ArchiveStatus.PENDING]: {
    label: 'Pending',
    description: 'Archive operation is in progress.',
    badgeClass: 'archive-pending',
    icon: IconName.HOURGLASS,
  },
};

/**
 * Get archive status display info
 */
export function getArchiveStatusInfo(status) {
  const config = ARCHIVE_STATUS_CONFIG[status?.toLowerCase?.()];
  return config || ARCHIVE_STATUS_CONFIG[ArchiveStatus.PENDING];
}

// =============================================================================
// STATUS BADGE COMPONENT HELPERS
// =============================================================================

/**
 * Get props for a bounty status badge with tooltip
 */
export function getBountyBadgeProps(status) {
  return {
    className: `status-badge ${getBountyStatusBadgeClass(status)}`,
    title: getBountyStatusDescription(status),
    'aria-label': `Bounty status: ${getBountyStatusLabel(status)}`,
  };
}

/**
 * Get props for a submission status badge with tooltip
 */
export function getSubmissionBadgeProps(status, onChainStatus) {
  return {
    className: `status-badge ${getSubmissionStatusBadgeClass(status, onChainStatus)}`,
    title: getSubmissionStatusDescription(status, onChainStatus),
    'aria-label': `Submission status: ${getSubmissionStatusLabel(status, onChainStatus)}`,
  };
}
