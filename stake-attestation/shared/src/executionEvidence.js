// The Execution evidence block at the start of an arbiter's justification (verdikta-arbiter,
// external-adapter/src/codeReview/evidence.js; its README, "The justification"), and the one reader of
// it: the hunter tool explains a claim from it, the record counts from it. A justification is untrusted
// text from IPFS. The block is the first line onward or it is not there, jury text follows it and can
// say anything, and only the first block is ever read:
//
//   Execution evidence v1                       the first line
//   Settlement: jury | INVALID (<gate>) | DUPLICATE (integrity)
//   Report-SHA256: <64 hex>
//   Integrity-Failed-Checks: none | <name>[,<name>…]    in common's INTEGRITY_CHECKS order
//   End execution evidence                      the last line of the block
//
// The chain says a claim's outcome. The block only says why.

export const EVIDENCE_HEADER = 'Execution evidence v1';
export const EVIDENCE_END = 'End execution evidence';
/** The writer's block is 20 lines; a block this long is no block of its. */
export const MAX_BLOCK_LINES = 64;
/** The aggregator joins the clustered oracles' CIDs (2 by default, of the 6 it polls). */
export const MAX_JUSTIFICATION_CIDS = 16;
/** What a reader downloads of one upload at most: a jury's has model results beside its justification. */
export const MAX_JUSTIFICATION_UPLOAD_BYTES = 4 * 1024 * 1024;

// StakeAttestation._isValidCid and the aggregator's MAX_CID_LENGTH (46 to 100 letters and digits)
const CID_SHAPE = /^[0-9A-Za-z]{46,100}$/;
const MAX_CID_LENGTH = 100;

/** A CID safe to put in a URL: the contract's rule. */
export const isCidShaped = (cid) => typeof cid === 'string' && CID_SHAPE.test(cid);

const cidOfEntry = (entry) => entry.split(':')[0].trim();

/** The first comma-separated CID of what the aggregator holds, in a form safe to fetch; else null. */
export function justificationCidOf(text) {
  const first = cidOfEntry(String(text ?? '').split(',', 1)[0]);
  return isCidShaped(first) ? first : null;
}

/**
 * Every CID of what the aggregator holds: the clustered oracles', joined by commas.
 * @returns {string[]|null} the CIDs, in order; null when any entry is not one, or there are too many
 */
export function justificationCidsOf(text) {
  if (typeof text !== 'string' || text.length > MAX_JUSTIFICATION_CIDS * (MAX_CID_LENGTH + 1)) return null;
  const cids = text.split(',').map(cidOfEntry);
  return cids.length <= MAX_JUSTIFICATION_CIDS && cids.every(isCidShaped) ? cids : null;
}

/** The first block's lines by name, a line that appears twice counting the first time; null: there is no block. */
function blockFields(justification) {
  if (typeof justification !== 'string') return null;
  const lines = justification.split('\n', MAX_BLOCK_LINES + 1);
  if (lines[0] !== EVIDENCE_HEADER) return null;
  const end = lines.indexOf(EVIDENCE_END);
  if (end < 0 || end >= MAX_BLOCK_LINES) return null;
  const fields = new Map();
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(': ');
    if (at > 0 && !fields.has(line.slice(0, at))) fields.set(line.slice(0, at), line.slice(at + 2));
  }
  return fields;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The block at the very start of a justification, if that is what is there, for reading out to a person:
 * every field is held to the form the block's writer gives it, so nothing else from an upload reaches
 * them, and a name that is not a check is left out.
 * @param {unknown} justification
 * @param {{ integrityChecks: readonly string[] }} o - common's INTEGRITY_CHECKS
 * @returns {null | { settlement: string, reportSha256: string|null, integrityFailedChecks: string[]|null, tamperFlags: string|null }}
 */
export function readExecutionEvidence(justification, { integrityChecks }) {
  const fields = blockFields(justification);
  if (!fields) return null;
  const settlement = fields.get('Settlement');
  if (!/^(jury|DUPLICATE \(integrity\)|INVALID \([A-Za-z]{1,40}\))$/.test(settlement ?? '')) return null;
  const sha = fields.get('Report-SHA256');
  const checks = fields.get('Integrity-Failed-Checks');
  const flags = fields.get('Tamper-Flags');
  let integrityFailedChecks = null;
  if (checks !== undefined) integrityFailedChecks = checks === 'none' ? [] : checks.split(',').filter((c) => integrityChecks.includes(c));
  return {
    settlement,
    reportSha256: SHA256.test(sha ?? '') ? sha : null,
    integrityFailedChecks,
    tamperFlags: /^(none|[a-z-]{1,40}=[0-9]{1,6}(,[a-z-]{1,40}=[0-9]{1,6})*)$/.test(flags ?? '') ? flags : null,
  };
}

/**
 * The checks a justification says the claim failed, for counting: only the form its writer gives. It
 * settles DUPLICATE (integrity), with a report hash, no tamper flag (a tamper flag settles INVALID) and
 * at least one check, each one of common's, once, in common's order. Anything else is null: one unknown
 * name makes the whole block unusable, not the part that is known. This says nothing about the outcome,
 * which only the chain says.
 * @param {unknown} justification
 * @param {{ integrityChecks: readonly string[] }} o - common's INTEGRITY_CHECKS
 * @returns {string[]|null}
 */
export function integrityFailureOf(justification, { integrityChecks }) {
  const fields = blockFields(justification);
  if (!fields || fields.get('Settlement') !== 'DUPLICATE (integrity)') return null;
  if (!SHA256.test(fields.get('Report-SHA256') ?? '')) return null;
  if ((fields.get('Tamper-Flags') ?? 'none') !== 'none') return null;
  const names = (fields.get('Integrity-Failed-Checks') ?? '').split(',');
  let at = -1;
  for (const name of names) {
    const position = integrityChecks.indexOf(name);
    if (position <= at) return null;
    at = position;
  }
  return names;
}

/**
 * What the record says beside the count (owner decision Q35, condition 3), on the API and on the page.
 * It states what the checks found. A hunter can raise the count on purpose, so it proves no trap, and it
 * must not imply that either side caused a failure.
 */
export const INTEGRITY_NOTE = 'These claims settled as DUPLICATE on-chain: bond back, no award. The count and the check names come from '
  + 'the justifications the arbiters uploaded, and the count is kept apart from the other duplicates. It states what the checks found. '
  + 'It does not say who or what caused a failure, and a hunter\'s own failed run also raises it.';
