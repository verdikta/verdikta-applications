// What makes a listing count (owner decision Q34): the record, the feed, the badge and the labels read
// only a listing the builder signed and the project proved. Anything else of the hash shows apart, as
// not counted, with this reason, and never adds to the stake shown.
//
// `known` and `dispute` are the store's answers for the listing's two archives (site/archives.js),
// `terms` the store's answer on whether what the chain holds is what they say (src/control/index.js),
// and `fact` the proof's fact (facts.js).
import { getAddress } from 'ethers';

const sameArtifact = (known, artifact) => {
  if (known.repo !== artifact.repo || known.baseCommit !== artifact.baseCommit) return false;
  const k = known.artifact ?? { kind: 'repo' };
  if (artifact.kind === 'Contract') {
    return k.kind === 'contract' && String(k.chainId) === String(artifact.chainId) && getAddress(String(k.address).toLowerCase()) === artifact.address;
  }
  return k.kind === 'repo';
};

/** @returns {string|null} why the listing does not count; null: it counts */
export function notCountedReason({ known, dispute, artifact, fact, terms }) {
  for (const answer of [known, dispute]) {
    if (!answer) return 'ARCHIVE_UNAVAILABLE';
    if (!answer.ok) return answer.error;
    if (!answer.signed?.ok) return 'NOT_SIGNED_BY_BUILDER';
  }
  // each archive what it is on-chain, of one signed spec, and that spec this listing's
  if (known.signed.role !== 'listing' || dispute.signed.role !== 'dispute' || known.signed.specSha256 !== dispute.signed.specSha256) return 'ARCHIVE_MISMATCH';
  if (!artifact || !sameArtifact(known, artifact)) return 'ARCHIVE_MISMATCH';
  if (fact.proof !== 'yes') return fact.reason ?? 'NOT_CHECKED_YET';
  if (!terms) return 'NOT_CHECKED_YET';
  if (!terms.ok) return 'ARCHIVE_MISMATCH';
  return null;
}
