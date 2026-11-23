// The contract interfaces the server reads and calls. StakeAttestation's is the merged ABI of
// onchain/deploy/helpers.js (the contract plus the lens views it answers at its own address:
// recordByHash, recordPage, settleableAt, ...), committed as abi/StakeAttestation.json and checked
// against the contracts in ../onchain by test/abi.test.js (`npm run abi` rewrites it). The server
// never compiles and never reads onchain's build output.
import fs from 'node:fs';
import { Interface } from 'ethers';

export const STAKE_ATTESTATION_ABI = Object.freeze(JSON.parse(fs.readFileSync(new URL('./abi/StakeAttestation.json', import.meta.url), 'utf8')));
export const stakeAttestation = new Interface(STAKE_ATTESTATION_ABI);

/**
 * What the keeper calls on the v2 Verdikta aggregator (onchain/contracts/interfaces/IVerdiktaAggregator.sol;
 * its address is the contract's verdikta()): the round's timing, the permissionless steps of a round
 * in flight (closeCommits, promote, settle), and the keeper's own credit (promote rewards, draw
 * rewards after 30 s). Its settle(bytes32) and EvaluationFailed(bytes32, uint8) share their names with
 * StakeAttestation's settle(uint256) and EvaluationFailed(uint256, uint256, bytes32, bool): the
 * indexer reads logs at the contract's address only (indexer.js), so the aggregator's never reach the
 * projection.
 */
export const AGGREGATOR_ABI = Object.freeze([
  'function getRoundInfo(bytes32 aggId) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)',
  'function closeCommits(bytes32 aggId)',
  'function promote(bytes32 aggId)',
  'function settle(bytes32 aggId)',
  'function ethOwed(address account) view returns (uint256)',
  'function withdrawEth()',
]);
export const aggregatorInterface = new Interface(AGGREGATOR_ABI);

/** The v2 aggregator's round phases (getRoundInfo), by number. */
export const ROUND_PHASES = Object.freeze(['None', 'Draw', 'Beacons', 'Commit', 'Closing', 'Reveal', 'Final', 'Settled', 'Failed', 'Cancelled']);

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
  Expiry: Object.freeze(['None', 'Undisclosed', 'Unrevealed', 'RoundsFailed', 'SubmissionsRefused', 'RoundsUnanswered']),
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
