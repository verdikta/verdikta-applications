// The contract as the tool calls it. StakeAttestation's is the merged ABI of onchain/deploy/helpers.js
// (the contract plus the lens views it answers at its own address), committed as
// abi/StakeAttestation.json and checked against the contracts in ../onchain by test/abi.test.js
// (`npm run abi` rewrites it). The tool never compiles and never reads onchain's build output.
import fs from 'node:fs';

export const STAKE_ATTESTATION_ABI = Object.freeze(JSON.parse(fs.readFileSync(new URL('./abi/StakeAttestation.json', import.meta.url), 'utf8')));

/** The one aggregator read the tool makes: where a round's justification was uploaded. */
export const AGGREGATOR_ABI = Object.freeze(['function getEvaluation(bytes32) view returns (uint256[] likelihoods, string justificationCID, bool exists)']);

/** The contract's enums, in declaration order (the ABI carries only uint8). */
export const CLAIM_STATES = Object.freeze(['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed']);
export const OUTCOMES = Object.freeze(['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const EXPIRIES = Object.freeze(['None', 'Undisclosed', 'Unrevealed', 'RoundsFailed', 'SubmissionsRefused']);
export const LISTING_STATES = Object.freeze(['Listed', 'Open', 'Depleted', 'Rolled', 'Closed']);
export const DISPUTE_RESULTS = Object.freeze(['None', 'Pending', 'Held', 'Overturned', 'NoVerdict']);
/** Which dispute-panel round a claim's dispute fields describe (errata E7, E9). */
export const DISPUTE_KINDS = Object.freeze(['None', 'Maker', 'Confirmation', 'Appeal']);
