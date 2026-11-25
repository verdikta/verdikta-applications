// The contract as the tool calls it. StakeAttestation's is the merged ABI of onchain/deploy/helpers.js
// (the contract plus the lens views it answers at its own address), committed as
// abi/StakeAttestation.json and checked against the contracts in ../onchain by test/abi.test.js
// (`npm run abi` rewrites it). The tool never compiles and never reads onchain's build output.
import fs from 'node:fs';

export const STAKE_ATTESTATION_ABI = Object.freeze(JSON.parse(fs.readFileSync(new URL('./abi/StakeAttestation.json', import.meta.url), 'utf8')));

/**
 * The aggregator's reads the tool makes (contracts/interfaces/IVerdiktaAggregator.sol, the v2 ReputationAggregator): a
 * round's result and where its justification was uploaded (getEvaluation, valid from phase 6); the round's phase,
 * timing and money (getRoundInfo: received less baseFees, bonuses and rewards is what it refunds, to the requester or
 * the arbiter pool, address 0); the round's own jury and timeout (getJury: the listing's, sent with the request; the
 * aggregator has no jury of its own); and where a round's refund went (RequesterRefunded, indexed by round), or the
 * shares of a round nobody promoted, paid to the jurors that committed (CommitPayment, counted in its rewards).
 */
export const AGGREGATOR_ABI = Object.freeze([
  'function getEvaluation(bytes32) view returns (uint256[] aggregated, string justifications, bool valid)',
  'function getRoundInfo(bytes32) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)',
  'function getJury(bytes32) view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)',
  'event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount)',
  'event CommitPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount)',
]);

/** The v2 aggregator's round phases (getRoundInfo), by number. */
export const ROUND_PHASES = Object.freeze(['None', 'Draw', 'Beacons', 'Commit', 'Closing', 'Reveal', 'Final', 'Settled', 'Failed', 'Cancelled']);

/** The contract's enums, in declaration order (the ABI carries only uint8). */
export const CLAIM_STATES = Object.freeze(['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed']);
export const OUTCOMES = Object.freeze(['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const EXPIRIES = Object.freeze(['None', 'Undisclosed', 'Unrevealed', 'RoundsFailed', 'SubmissionsRefused', 'RoundsUnanswered']);
export const LISTING_STATES = Object.freeze(['Listed', 'Open', 'Depleted', 'Rolled', 'Closed']);
export const DISPUTE_RESULTS = Object.freeze(['None', 'Pending', 'Held', 'Overturned', 'NoVerdict']);
/** Which dispute-panel round a claim's dispute fields describe (errata E7, E9). */
export const DISPUTE_KINDS = Object.freeze(['None', 'Maker', 'Confirmation', 'Appeal']);
