/**
 * Centralized status display utilities
 * Single source of truth for all status labels, descriptions, and styling
 */

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
    icon: '⏰',
  },
  [BountyStatus.AWARDED]: {
    label: 'Awarded',
    description: 'A submission passed the evaluation threshold and the winner has been paid.',
    badgeClass: 'status-awarded',
    icon: '🎉',
  },
  [BountyStatus.CLOSED]: {
    label: 'Closed',
    description: 'This bounty has been closed without a winner. Funds returned to creator.',
    badgeClass: 'status-closed',
    icon: '🔒',
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

  // Final states
  PASSED: 'Passed',
  PASSED_PAID: 'PassedPaid',
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
  'PREPARED', // uppercase variant
];

// All statuses that indicate success
const SUCCESS_STATUSES = [
  SubmissionStatus.PASSED,
  SubmissionStatus.PASSED_PAID,
  SubmissionStatus.APPROVED,
  SubmissionStatus.ACCEPTED,
];

// All statuses that indicate failure
const FAILURE_STATUSES = [
  SubmissionStatus.FAILED,
  SubmissionStatus.REJECTED,
];

const SUBMISSION_STATUS_CONFIG = {
  // Pending states - all map to the same user-facing display
  pending: {
    label: 'Evaluating',
    description: 'Your submission is being evaluated by the AI jury. This typically takes 2-4 minutes.',
    badgeClass: 'status-pending',
    icon: '⏳',
  },
  // Success states
  success: {
    label: 'Approved',
    description: 'Your submission passed the evaluation threshold and met all requirements.',
    badgeClass: 'status-approved',
    icon: '✅',
  },
  // Failure states
  failure: {
    label: 'Rejected',
    description: 'Your submission did not meet the evaluation threshold or failed a must-pass criterion.',
    badgeClass: 'status-rejected',
    icon: '❌',
  },
  // Unknown/other
  unknown: {
    label: 'Unknown',
    description: 'Status information unavailable.',
    badgeClass: 'status-unknown',
    icon: '❓',
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
 * Normalize submission status to category (pending, success, failure, unknown)
 */
function getSubmissionStatusCategory(status) {
  if (!status) return 'unknown';

  const normalizedStatus = status.toString();

  if (PENDING_STATUSES.includes(normalizedStatus)) {
    return 'pending';
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
export function getSubmissionStatusLabel(status) {
  const category = getSubmissionStatusCategory(status);
  return SUBMISSION_STATUS_CONFIG[category].label;
}

/**
 * Get description/tooltip text for submission status
 */
export function getSubmissionStatusDescription(status) {
  const category = getSubmissionStatusCategory(status);
  return SUBMISSION_STATUS_CONFIG[category].description;
}

/**
 * Get CSS class for submission status badge
 */
export function getSubmissionStatusBadgeClass(status) {
  const category = getSubmissionStatusCategory(status);
  return SUBMISSION_STATUS_CONFIG[category].badgeClass;
}

/**
 * Get icon for submission status
 */
export function getSubmissionStatusIcon(status) {
  const category = getSubmissionStatusCategory(status);
  return SUBMISSION_STATUS_CONFIG[category].icon;
}

/**
 * Get full display text with icon for submission status
 */
export function getSubmissionStatusDisplay(status) {
  const icon = getSubmissionStatusIcon(status);
  const label = getSubmissionStatusLabel(status);
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
         s === 'PENDING_EVALUATION';
}

/**
 * Check if submission status is successful
 */
export function isSubmissionSuccess(status) {
  return getSubmissionStatusCategory(status) === 'success';
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
    icon: '⚠️',
  },
  [ArchiveStatus.RETRIEVED]: {
    label: 'Retrieved',
    description: 'Files have been successfully retrieved from archive.',
    badgeClass: 'archive-retrieved',
    icon: '✓',
  },
  [ArchiveStatus.VERIFIED]: {
    label: 'Archived',
    description: 'Files are archived and available for download.',
    badgeClass: 'archive-verified',
    icon: '✓',
  },
  [ArchiveStatus.REPINNED]: {
    label: 'Re-pinned',
    description: 'Files have been re-pinned to extend availability.',
    badgeClass: 'archive-repinned',
    icon: '↻',
  },
  [ArchiveStatus.FAILED]: {
    label: 'Failed',
    description: 'Failed to archive or retrieve files.',
    badgeClass: 'archive-failed',
    icon: '✗',
  },
  [ArchiveStatus.PENDING]: {
    label: 'Pending',
    description: 'Archive operation is in progress.',
    badgeClass: 'archive-pending',
    icon: '⏳',
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
export function getSubmissionBadgeProps(status) {
  return {
    className: `status-badge ${getSubmissionStatusBadgeClass(status)}`,
    title: getSubmissionStatusDescription(status),
    'aria-label': `Submission status: ${getSubmissionStatusLabel(status)}`,
  };
}
