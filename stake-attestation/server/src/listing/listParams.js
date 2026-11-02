// The arguments of StakeAttestation.list(params, listingCid, disputeCid, knownIssueIds) for a
// listing, from its code_review.json (design §13.1-§13.2; decision D8 for the bounds), in the JSON
// the maker's wallet passes to ethers as it is: uint256 and uint64 values as decimal strings,
// bytes32 and addresses as 0x hex, enums and windows (uint8, uint32) as numbers.
//
// The contract trusts only what it stores, so everything here comes from the archive's own files:
// the disclosure key is the 32 bytes common's parseDisclosureKey decodes from the spec's age
// recipient, the known-issue ids are known_issues.json's, the awards are common's awardsToWei.
// The bounds below are the contract's (onchain/contracts/StakeAttestation.sol); the chain tests
// compare them with the deployed constants.
import { AbiCoder, getAddress, keccak256 } from 'ethers';

import { codeReview } from '../common.js';

export const LIST_LIMITS = Object.freeze({
  MAX_FIX_WINDOW: 90 * 86400,
  MIN_DISPUTE_WINDOW: 24 * 3600,
  MIN_REVEAL_WINDOW: 72 * 3600,
  MAX_WINDOW: 90 * 86400,
  MAX_KNOWN_ISSUES: 256,
  MAX_ALLOWLIST: 64,
});

/** StakeAttestation.ArtifactKind and Outcome, in declaration order. */
const ARTIFACT_KIND = Object.freeze({ repo: 0, contract: 1 });
const OUTCOME_OF_CLASS = Object.freeze(Object.fromEntries(codeReview.SEVERITY_CLASSES.map((c, i) => [c, codeReview.FIRST_SEVERITY_OUTCOME_INDEX + i])));
const coder = AbiCoder.defaultAbiCoder();

/** The bytes32 the contract stores for an age recipient: the X25519 key it encodes. */
export function disclosureKeyBytes32(recipient) {
  const bytes = Buffer.from(codeReview.parseDisclosureKey(recipient));
  if (bytes.length !== 32 || bytes.every((b) => b === 0)) throw new TypeError('the disclosure key does not decode to a usable 32-byte key');
  return `0x${bytes.toString('hex')}`;
}

/** A known_issues.json id ("sha256:<hex>") as the bytes32 list() takes. */
export function knownIssueIdBytes32(id) {
  return `0x${id.slice('sha256:'.length)}`;
}

/** The list() windows, in seconds, from the spec with common's defaults applied. */
export function listWindows(spec) {
  const eff = codeReview.effectiveStake(spec);
  return {
    fixWindow: eff.fixWindowDays * 86400,
    disputeWindow: eff.disputeWindowHours * 3600,
    disclosureGrace: eff.disclosureGraceHours * 3600,
    revealWindow: eff.revealWindowDays * 86400,
  };
}

/** StakeAttestation.Artifact for the spec. */
export function artifactOf(spec) {
  const a = spec.artifact ?? { kind: 'repo' };
  if (a.kind === 'contract') {
    return { kind: ARTIFACT_KIND.contract, repo: spec.repo, baseCommit: spec.baseCommit, chainId: String(a.chainId), addr: getAddress(a.address.toLowerCase()) };
  }
  return { kind: ARTIFACT_KIND.repo, repo: spec.repo, baseCommit: spec.baseCommit, chainId: '0', addr: '0x0000000000000000000000000000000000000000' };
}

/** StakeAttestation.artifactHashOf: the record key. */
export function artifactHashOf(artifact) {
  if (artifact.kind === ARTIFACT_KIND.repo) {
    return keccak256(coder.encode(['uint8', 'string', 'string'], [artifact.kind, artifact.repo, artifact.baseCommit]));
  }
  return keccak256(coder.encode(['uint8', 'string', 'string', 'uint64', 'address'], [artifact.kind, artifact.repo, artifact.baseCommit, artifact.chainId, artifact.addr]));
}

/**
 * What list() would refuse in a spec common accepts (decision D8's windows, a declared value that
 * is not whole dollars, a chain id that is not a positive integer). The awards rules and the
 * commit and repo shapes are common's schema and validator already; the number of known issues
 * and the allowlist are checked with the request (request.js).
 * @returns {{ code: 'LIST_BOUNDS', path: string, detail: string }[]} paths in the spec
 */
export function listIssues(spec) {
  const issues = [];
  const issue = (path, detail) => issues.push({ code: 'LIST_BOUNDS', path, detail });
  const w = listWindows(spec);
  const days = (s) => `${s / 86400} days`;
  if (w.fixWindow > LIST_LIMITS.MAX_FIX_WINDOW) issue('/stake/fixWindowDays', `the fix window is at most ${days(LIST_LIMITS.MAX_FIX_WINDOW)}`);
  if (w.disclosureGrace > w.fixWindow) issue('/stake/disclosureGraceHours', 'the disclosure grace cannot be longer than the fix window');
  if (w.disputeWindow < LIST_LIMITS.MIN_DISPUTE_WINDOW || w.disputeWindow > LIST_LIMITS.MAX_WINDOW) issue('/stake/disputeWindowHours', `the dispute window is 24 hours to ${days(LIST_LIMITS.MAX_WINDOW)}`);
  if (w.revealWindow < LIST_LIMITS.MIN_REVEAL_WINDOW || w.revealWindow > LIST_LIMITS.MAX_WINDOW) issue('/stake/revealWindowDays', `the reveal window is 72 hours to ${days(LIST_LIMITS.MAX_WINDOW)}`);
  const v = spec.stake.valueAtRiskUsd;
  if (v !== undefined && !Number.isSafeInteger(v)) issue('/stake/valueAtRiskUsd', 'the declared value at risk is recorded in whole dollars');
  if (spec.artifact?.kind === 'contract' && !(Number.isSafeInteger(spec.artifact.chainId) && spec.artifact.chainId > 0)) issue('/artifact/chainId', 'the chain id must be a positive integer');
  return issues;
}

/**
 * @param {object} o
 * @param {object} o.spec - the listing archive's code_review.json
 * @param {object[]|null} o.knownIssues - its known_issues.json, parsed
 * @param {string[]} o.allowlist - checksummed hunter addresses (empty: open)
 * @param {object} o.oracle - config.oracle
 * @param {string} o.listingCid
 * @param {string} o.disputeCid
 */
export function listArguments({ spec, knownIssues, allowlist, oracle, listingCid, disputeCid }) {
  const awards = codeReview.awardsToWei(spec.stake.awards);
  const artifact = artifactOf(spec);
  return {
    params: {
      artifact,
      disclosureKey: disclosureKeyBytes32(spec.stake.disclosureKey),
      awards: codeReview.SEVERITY_CLASSES.map((c) => awards[c].toString()),
      lowestClassCounted: OUTCOME_OF_CLASS[spec.stake.lowestClassCounted],
      bondWei: BigInt(spec.stake.bondWei).toString(),
      ...listWindows(spec),
      allowlist: [...allowlist],
      valueAtRiskUsd: String(spec.stake.valueAtRiskUsd ?? 0),
      oracle: { ...oracle },
    },
    listingCid,
    disputeCid,
    knownIssueIds: (knownIssues ?? []).map((k) => knownIssueIdBytes32(k.id)).sort(),
    artifactHash: artifactHashOf(artifact),
  };
}
