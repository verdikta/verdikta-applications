/**
 * The v2 ReputationAggregator as the bounty server uses it (verdikta-dispatcher `beacon` branch;
 * onchain/contracts/interfaces/IVerdiktaAggregator.sol has the requester's view with notes).
 *
 * Most reads go through the escrow's lens instead (getOracleResult, nextAction: the round's phase
 * and the Q-of-N outcome with no aggregator ABI). This is for what only the aggregator answers:
 * the round-moving calls the keeper loop sends (drawJury goes through the escrow, so the draw reward
 * reaches the submission's wallet; closeCommits, promote, settle, cancelUnsealed go here), the
 * keeper's own ethOwed, and analytics (config, slots, events).
 */

const AGGREGATOR_ABI = [
  // round
  'function getRoundInfo(bytes32 aggId) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)',
  'function getEvaluation(bytes32 aggId) view returns (uint256[] aggregated, string justifications, bool valid)',
  'function getOutcomeScores(bytes32 aggId, uint256 outcome) view returns (uint256[] scores, bool valid)',
  'function getSlot(bytes32 aggId, uint256 i) view returns (tuple(address oracle, uint96 fee, bytes32 key, address payee, uint40 committedAt, uint8 flags, uint8 qcode, bytes32 commitHash))',
  'function getJury(bytes32 aggId) view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)',
  'function isFailed(bytes32 aggId) view returns (bool)',
  'function roundCount() view returns (uint256)',
  // moving a round (anyone)
  'function sealSeed(bytes32 aggId)',
  'function drawJury(bytes32 aggId)',
  'function closeCommits(bytes32 aggId)',
  'function promote(bytes32 aggId)',
  'function settle(bytes32 aggId)',
  'function cancelUnsealed(bytes32 aggId)',
  // money
  'function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) view returns (uint256)',
  'function ethOwed(address account) view returns (uint256)',
  'function withdrawEth()',
  // configuration
  'function maxOracleFee() view returns (uint256)',
  // the jury is each request's (getJury per round); the owner bounds it: K <= maxJury, T+ < timeout <= maxTimeout
  'function maxJury() view returns (uint8)',
  'function maxTimeout() view returns (uint40)',
  'function tPlus() view returns (uint40)',
  'function revealWindow() view returns (uint40)',
  'function bonusMultiplier() view returns (uint8)',
  'function drawRewardFees() view returns (uint8)',
  'function promoteRewardFees() view returns (uint8)',
  'function spreadFloor() view returns (uint256)',
  'function keeper() view returns (address)',
  'function beacons() view returns (address)',
  'function treasury() view returns (address)',
  // events
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
  'event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue)',
  'event SeedSealed(bytes32 indexed aggRequestId, bytes32 blockHash)',
  'event BeaconStageStarted(bytes32 indexed aggRequestId, uint256 beacons)',
  'event BeaconPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount)',
  'event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward)',
  'event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bytes32 commitHash)',
  'event CommitWindowClosed(bytes32 indexed aggRequestId, uint256 closeBlock)',
  'event CommitPhaseComplete(bytes32 indexed aggRequestId, uint256 promoted)',
  'event RevealReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bool late, uint8 qcode)',
  'event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)',
  'event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase)',
  'event RoundSettled(bytes32 indexed aggRequestId, bool failed)',
  'event RoundCancelled(bytes32 indexed aggRequestId, uint256 toTreasury)',
  'event BasePayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount)',
  'event BonusPayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount)',
  'event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount)',
  'event SlotSkipped(bytes32 indexed aggRequestId, uint256 pollIndex, uint8 reason)',
  'event EthWithdrawn(address indexed payee, uint256 amount)',
  // errors
  'error BadInput()',
  'error InsufficientPayment()',
  'error WrongPhase()',
  'error TooEarly()',
  'error NotDue()',
  'error SeedExpired()',
  'error DrawExpired()',
  'error BadJury()',
  'error NothingOwed()',
  'error EthTransferFailed()'
];

/** getRoundInfo's phase, by number. */
const PHASES = Object.freeze({
  0: 'none',
  1: 'draw',
  2: 'beacons',
  3: 'commit',
  4: 'closing',
  5: 'reveal',
  6: 'final',
  7: 'settled',
  8: 'failed',
  9: 'cancelled'
});

/** The escrow lens's OracleResult.outcome (BountyRules.Outcome), by number. */
const OUTCOMES = Object.freeze({
  0: 'not_ready',
  1: 'no_result',
  2: 'pass',
  3: 'soft_fail',
  4: 'hard_fail'
});

/** BountyEscrow.SubmissionStatus, by number. */
const SUBMISSION_STATUSES = Object.freeze([
  'Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid', 'PendingCreatorApproval', 'AwaitingRerun'
]);

module.exports = { AGGREGATOR_ABI, PHASES, OUTCOMES, SUBMISSION_STATUSES };
