// The contract interfaces the server reads and calls. StakeAttestation's is the merged ABI of
// onchain/deploy/helpers.js (the contract plus the lens views it answers at its own address:
// recordByHash, recordPage, settleableAt, ...), committed as abi/StakeAttestation.json and checked
// against the contracts in ../onchain by test/abi.test.js (`npm run abi` rewrites it). The server
// never compiles and never reads onchain's build output.
import fs from 'node:fs';
import { Interface } from 'ethers';

export const STAKE_ATTESTATION_ABI = Object.freeze(JSON.parse(fs.readFileSync(new URL('./abi/StakeAttestation.json', import.meta.url), 'utf8')));
export const stakeAttestation = new Interface(STAKE_ATTESTATION_ABI);

/** The read side of Chainlink's AggregatorV3Interface: ETH/USD on Base (under-staked, §4.2). */
export const ETH_USD_FEED_ABI = Object.freeze([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/**
 * The contract's enums, by name, in declaration order (the ABI carries only uint8 and the type's
 * name; test/abi.test.js compares these with StakeAttestation.sol).
 */
export const ENUMS = Object.freeze({
  ListingState: Object.freeze(['Listed', 'Open', 'Depleted', 'Rolled', 'Closed']),
  Outcome: Object.freeze(['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  ArtifactKind: Object.freeze(['Repo', 'Contract']),
  ClaimState: Object.freeze(['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed']),
  Expiry: Object.freeze(['None', 'Undisclosed', 'Unrevealed', 'RoundsFailed', 'SubmissionsRefused']),
  DisputeResult: Object.freeze(['None', 'Pending', 'Held', 'Overturned', 'NoVerdict']),
  DisputeKind: Object.freeze(['None', 'Maker', 'Confirmation', 'Appeal']),
});

/** The severity classes, as Outcome names from LOW up: awards[] is indexed by class - LOW. */
export const SEVERITY_CLASSES = Object.freeze(ENUMS.Outcome.slice(2));
export const outcomeRank = (name) => ENUMS.Outcome.indexOf(name);

/**
 * The listing feed's events (design §13.4: "the listing feed is those events"): every event about
 * a listing or a claim. The rest (the owner's fee settings, ownership, the pull ledger) are the
 * contract's housekeeping; the indexer stores them too, the feed does not carry them.
 */
export const FEED_EVENTS = Object.freeze(
  STAKE_ATTESTATION_ABI
    .filter((f) => f.type === 'event' && f.inputs.some((i) => i.name === 'listingId' || i.name === 'claimId'))
    .map((f) => f.name),
);
