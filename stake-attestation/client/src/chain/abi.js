// The StakeAttestation fragments the client calls, in ethers' human-readable form. They are
// the contract's merged ABI (onchain/deploy/helpers.js) for these names: e2e/abi.spec.js
// compares each, in full, with the ABI compiled from onchain/ for the run.
const ORACLE = '(uint64 requestedClass, uint256 maxOracleFee, uint256 disputeMaxOracleFee, uint256 estimatedBaseCost, uint256 alpha, uint256 maxFeeBasedScaling)';
const ARTIFACT = '(uint8 kind, string repo, string baseCommit, uint64 chainId, address addr)';

const LIST_PARAMS = `(${ARTIFACT} artifact, bytes32 disclosureKey, uint256[4] awards, uint8 lowestClassCounted, uint256 bondWei, uint32 fixWindow, uint32 disputeWindow, uint32 disclosureGrace, uint32 revealWindow, address[] allowlist, uint256 valueAtRiskUsd, ${ORACLE} oracle)`;

const LISTING = '(address maker, uint8 state, uint8 artifactKind, uint8 lowestClassCounted, uint64 listedAt, uint64 openedAt, uint64 fundedUntil, '
  + 'uint32 fixWindow, uint32 disputeWindow, uint32 disclosureGrace, uint32 revealWindow, address artifactAddress, uint64 artifactChainId, '
  + 'bytes32 artifactHash, bytes32 disclosureKey, string listingCid, string disputeCid, uint256[4] awards, uint256 bondWei, uint256 valueAtRiskUsd, '
  + `bytes32[] knownIssueIds, address[] allowlist, ${ORACLE} oracle, uint256 escrowWei, uint256 owedWei, uint256 pendingClaims, uint256 predecessor, `
  + 'uint256 successor, uint64 rolledAt, uint64 headClaim, uint64 tailClaim, uint64 headSince, uint64 claimsCommitted, uint64 undisclosedClaims, '
  + 'uint64 unrevealedClaims, uint32[6] outcomeCounts, uint64 owedCursor, uint64 noVerdictClaims, uint64 disputesFiled, uint64 disputesHeld, '
  + 'uint64 disputesOverturned, uint64 disputesNoVerdict, uint64 closedAt, uint64 releasedClaims, uint64 lateClaims, uint64 lateExpired, '
  + 'uint32[6] lateOutcomeCounts, uint256 narrowInvalidFloor, uint256 confirmAboveWei, uint64 narrowInvalidClaims, uint64 lateNarrowInvalid, '
  + 'uint64 confirmationRounds, uint64 confirmationsHeld, uint64 confirmationsOverturned, uint64 confirmationsNoVerdict)';

const CLAIM = '(address hunter, uint64 committedAt, uint8 state, uint8 expiry, bool flaggedBadDisclosure, bool released, uint64 listingId, '
  + 'uint64 disclosedAt, uint64 fixWindowEnd, uint64 revealedAt, uint64 prevInOrder, uint64 nextInOrder, bytes16 contentKey, address evalWallet, '
  + 'bool disclosedAfterRoll, uint128 bondWei, uint128 prepayWei, bytes32 archiveHash, bytes32 ciphertextSha256, bytes32 ephemeralKey, '
  + 'bytes32 requestId, string ciphertextCid, string bcid, uint32[6] vector, uint64 judgedAt, uint64 settledAt, uint8 outcome, uint128 paidWei, '
  + 'uint128 owedWei, uint64 failedAt, bool roundStarted, uint8 dispute, uint8 disputedOutcome, uint64 disputedAt, uint64 disputeEndedAt, '
  + 'bool late, address disputeWallet, bytes32 disputeRequestId, uint8 disputeKind)';

export const STAKE_ATTESTATION_ABI = Object.freeze([
  `function list(${LIST_PARAMS} p, string listingCid, string disputeCid, bytes32[] knownIssueIds) returns (uint256 listingId)`,
  'function fund(uint256 listingId, uint256 expectedFeeWei) payable',
  'function feeDue(uint256 listingId) view returns (uint256)',
  `function getListing(uint256 listingId) view returns (${LISTING})`,
  `function getClaim(uint256 claimId) view returns (${CLAIM})`,
  'function listingCount() view returns (uint256)',
  'function claimCount() view returns (uint256)',
  'function activeListingOf(bytes32, address) view returns (uint256)',
  'function flagBadDisclosure(uint256 claimId)',
  // the maker's actions on a claim or a listing (node P6b) and the lens views that time them
  'function release(uint256 claimId)',
  'function rollForward(uint256 listingId, uint256 successorListingId)',
  'function dispute(uint256 claimId, string statementCid) payable',
  'function claimState(uint256 claimId) view returns (uint8)',
  'function claimTimes(uint256 claimId) view returns (uint256 discloseDeadline, uint256 revealableAt, uint256 revealDeadline)',
  'function disputeFee(uint256 listingId) view returns (uint256)',
  'function disputeDeadline(uint256 claimId) view returns (uint256)',
  'event Listed(uint256 indexed listingId, address indexed maker, bytes32 indexed artifactHash, uint8 kind, string repo, string baseCommit, uint64 chainId, address artifactAddress, string listingCid, string disputeCid)',
  'event Opened(uint256 indexed listingId, bytes32 indexed artifactHash, uint256 escrowWei, uint64 fundedUntil)',
]);

/** StakeAttestation's enums, in declaration order (test/enums.test.js reads them from the source). */
export const LISTING_STATES = Object.freeze(['Listed', 'Open', 'Depleted', 'Rolled', 'Closed']);
export const CLAIM_STATES = Object.freeze(['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed']);
export const OUTCOMES = Object.freeze(['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const DISPUTE_RESULTS = Object.freeze(['None', 'Pending', 'Held', 'Overturned', 'NoVerdict']);
/** The severity classes, LOW up: awards[] is indexed by class - LOW. */
export const CLASSES = Object.freeze(OUTCOMES.slice(2));
