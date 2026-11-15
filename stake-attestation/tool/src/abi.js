// The contract as the tool calls it. StakeAttestation's is the merged ABI of onchain/deploy/helpers.js
// (the contract plus the lens views it answers at its own address), committed as
// abi/StakeAttestation.json and checked against the contracts in ../onchain by test/abi.test.js
// (`npm run abi` rewrites it). The tool never compiles and never reads onchain's build output.
import fs from 'node:fs';

export const STAKE_ATTESTATION_ABI = Object.freeze(JSON.parse(fs.readFileSync(new URL('./abi/StakeAttestation.json', import.meta.url), 'utf8')));

/**
 * The aggregator's reads the tool makes (contracts/interfaces/IVerdiktaAggregator.sol): a round's result and where
 * its justification was uploaded; whether a round that is over failed (what finalize's _poll reads) and the time a
 * round has; and the round's money, getEthAccounting, which the deployed ReputationAggregator answers
 * (verdikta-dispatcher) and the mock does not.
 */
export const AGGREGATOR_ABI = Object.freeze([
  'function getEvaluation(bytes32) view returns (uint256[] likelihoods, string justificationCID, bool exists)',
  'function getAggregationStatus(bytes32) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)',
  'function getEthAccounting(bytes32) view returns (uint256 ethReceived, uint256 baseCredited, uint256 bonusCredited, uint256 bonusMultiplierSnap, uint256 reserved)',
  'function responseTimeoutSeconds() view returns (uint256)',
]);

/** The contract's enums, in declaration order (the ABI carries only uint8). */
export const CLAIM_STATES = Object.freeze(['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed']);
export const OUTCOMES = Object.freeze(['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const EXPIRIES = Object.freeze(['None', 'Undisclosed', 'Unrevealed', 'RoundsFailed', 'SubmissionsRefused']);
export const LISTING_STATES = Object.freeze(['Listed', 'Open', 'Depleted', 'Rolled', 'Closed']);
export const DISPUTE_RESULTS = Object.freeze(['None', 'Pending', 'Held', 'Overturned', 'NoVerdict']);
/** Which dispute-panel round a claim's dispute fields describe (errata E7, E9). */
export const DISPUTE_KINDS = Object.freeze(['None', 'Maker', 'Confirmation', 'Appeal']);
