// "Did the builder sign this listing": the listing archive's attestation over the files it binds,
// verified with @verdikta/common's validateAttestation, as arbiters verify it. The site's record and
// feed ask this, and so does the hunter tool (node P5) before it offers a commit: a listing whose
// archive does not verify is one arbiters will not judge.
//
// The attestation binds code_review.json, the baseline and the known issues, not the manifest, the
// primary file or the ZIP around them, so those signed files can be repackaged around another panel,
// another query, or in a form one reader takes and another refuses. So the archive must be, byte for
// byte, what the listing flow issues for them (server/src/listing/archives.js): its writer is
// deterministic, so anyone can rebuild it from its members and compare. Its baseline and known issues
// must be valid too. An archive that differs is not what the flow issued, however good its signature,
// and the dispute archive counts as much as the listing archive: a maker who chose their own would
// choose who judges their disputes.
//
// A signature says nothing of who listed the archive: a signed archive can be listed from any
// wallet, and that wallet's address is not in it (docs/control-proof.md, "Replay"). The signature
// and the on-chain maker's proof are two checks, and a listing needs both.
//
// The archive is the maker's, so nothing is extracted: named members are read from the ZIP's central
// directory, each held to a byte cap (zipRead.js). This package has no dependency, so common's
// validators are an argument: `codeReview`, as the caller's pinned copy.
import { zipStored } from './zip.js';
import { ZipError, readZipMember, zipDirectory } from './zipRead.js';

const PLAIN_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
const SPEC_MAX_BYTES = 1024 * 1024;
const MEMBER_MAX_BYTES = 8 * 1024 * 1024;
const MANIFEST_FILE = 'manifest.json';
const PRIMARY_FILE = 'primary_query.json';
const SPEC_FILE = 'code_review.json';
// a byte order mark stays in the text, and JSON.parse refuses it, as the arbiters' reader does
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const written = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** The attested hashes of a statement's files, as one value: the same in a listing's two archives. */
const filesKey = (attestation) => JSON.stringify([attestation.sha256?.codeReview ?? null, attestation.sha256?.baseline ?? null, attestation.sha256?.knownIssues ?? null]);

const invalid = (reason = 'ARCHIVE_INVALID') => ({ signed: false, reason, spec: null, knownIssues: null });

/**
 * @param {Buffer} bytes - the listing archive
 * @param {object} o
 * @param {object} o.codeReview - @verdikta/common's codeReview module
 * @param {{ publicKey: string }[]} [o.devKeys] - dev keys this caller accepts for a statement that
 *   says dev; without them only the production trusted-builder set counts
 * @returns {{ signed: true, role: 'listing'|'dispute', filesSha256: string, keyId: string, trust: string, issuedAt: string|null, spec: object, knownIssues: object[]|null, reason: null }
 *   | { signed: false, reason: 'ARCHIVE_INVALID'|'ARCHIVE_TOO_LARGE'|'NOT_SIGNED_BY_BUILDER', spec: object|null, knownIssues: object[]|null, issues?: string[] }}
 */
export function readSignedListing(bytes, { codeReview, devKeys = null }) {
  let entries;
  const member = (name, max) => {
    const entry = entries.get(name);
    return entry ? readZipMember(bytes, entry, max) : null;
  };
  const json = (name, max) => {
    const raw = member(name, max);
    if (!raw) throw new ZipError('ZIP_INVALID', `${name} is not in the archive`);
    return { raw, value: JSON.parse(utf8.decode(raw)) };
  };
  try {
    entries = zipDirectory(bytes);
    const read = json(SPEC_FILE, SPEC_MAX_BYTES);
    const spec = read.value;
    if (!spec || typeof spec !== 'object' || !codeReview.validateCodeReviewSpec(spec).ok) return invalid();

    const named = (name) => (typeof name === 'string' && PLAIN_NAME.test(name) ? name : null);
    const baselineName = named(spec.baseline ?? codeReview.BASELINE_FILE);
    const attestationName = named(spec.attestation ?? codeReview.ATTESTATION_FILE);
    const knownName = spec.stake?.knownIssues === undefined ? null : named(spec.stake.knownIssues);
    if (!baselineName || !attestationName || (spec.stake?.knownIssues !== undefined && !knownName)) return invalid();
    const baseline = member(baselineName, MEMBER_MAX_BYTES);
    const known = knownName ? member(knownName, MEMBER_MAX_BYTES) : null;
    const attestationBytes = member(attestationName, MEMBER_MAX_BYTES);
    if (!baseline || !attestationBytes || (knownName && !known)) return { ...invalid('NOT_SIGNED_BY_BUILDER'), spec };

    // exactly what the listing flow issues for these files: the panel says which archive it is
    const issue = (panel) => zipStored([
      { name: MANIFEST_FILE, bytes: written({ version: '1.0', primary: { filename: PRIMARY_FILE }, juryParameters: panel, codeReview: SPEC_FILE }) },
      { name: PRIMARY_FILE, bytes: written({ query: codeReview.buildClaimQuery(spec), outcomes: [...codeReview.BUG_OUTCOMES], references: [] }) },
      { name: SPEC_FILE, bytes: read.raw },
      { name: attestationName, bytes: attestationBytes },
      { name: baselineName, bytes: baseline },
      ...(knownName ? [{ name: knownName, bytes: known }] : []),
    ]);
    let role = null;
    if (issue(codeReview.CODE_STANDARD_PANEL).equals(bytes)) role = 'listing';
    else if (issue(codeReview.CODE_STANDARD_DISPUTE_PANEL).equals(bytes)) role = 'dispute';
    if (!role) return invalid();

    const knownIssues = knownName ? JSON.parse(utf8.decode(known)) : null;
    if (knownName && !codeReview.validateKnownIssues(knownIssues).ok) return invalid();
    if (!codeReview.validateBaseline(JSON.parse(utf8.decode(baseline)), spec).ok) return invalid();

    const attestation = JSON.parse(utf8.decode(attestationBytes));
    const files = { codeReview: read.raw, baseline, ...(known ? { knownIssues: known } : {}) };
    // the statement's own (signed) trust picks the verification, as the arbiters' front gates do
    const trust = devKeys?.length && attestation?.trust === 'dev' ? { dev: true, keys: devKeys } : undefined;
    const verified = codeReview.validateAttestation(attestation, { files, trust });
    if (!verified.ok) {
      return { signed: false, reason: 'NOT_SIGNED_BY_BUILDER', spec, knownIssues, issues: verified.issues.map((i) => i.code) };
    }
    return { signed: true, reason: null, role, filesSha256: filesKey(attestation), keyId: attestation.signature.keyId, trust: attestation.trust, issuedAt: attestation.issuedAt ?? null, spec, knownIssues };
  } catch (err) {
    return invalid(err?.code === 'ZIP_TOO_LARGE' ? 'ARCHIVE_TOO_LARGE' : 'ARCHIVE_INVALID');
  }
}

/**
 * "Did the builder sign this listing": both of its archives, for the listing the chain holds. Each must
 * be read as what it is on-chain (the listing's panel, the dispute's), both must hold the same signed
 * files, and it must be that listing's: the repository, the commit and the disclosure key the chain
 * stores. A hunter encrypts to the on-chain key while arbiters check against the archive's, so another
 * key there would cost the hunter the bond. This is the check the hunter tool (node P5) makes before
 * it offers a commit.
 * @param {object} o
 * @param {Buffer} o.listingBytes - the archive at the listing's listingCid
 * @param {Buffer} o.disputeBytes - the archive at its disputeCid
 * @param {object} o.codeReview - @verdikta/common's codeReview module
 * @param {{ repo: string, baseCommit: string, disclosureKey: string }} o.listing - what the chain stores
 *   (disclosureKey: the bytes32, 0x hex)
 * @param {{ publicKey: string }[]} [o.devKeys]
 * @returns {{ signed: boolean, reason: string|null, keyId?: string, trust?: string }}
 */
export function didBuilderSign({ listingBytes, disputeBytes, codeReview, listing, devKeys = null }) {
  const read = readSignedListing(listingBytes, { codeReview, devKeys });
  if (!read.signed) return { signed: false, reason: read.reason };
  const dispute = readSignedListing(disputeBytes, { codeReview, devKeys });
  if (!dispute.signed) return { signed: false, reason: dispute.reason };
  if (read.role !== 'listing' || dispute.role !== 'dispute' || read.filesSha256 !== dispute.filesSha256) return { signed: false, reason: 'ARCHIVE_MISMATCH' };
  let key = null;
  try {
    key = `0x${Buffer.from(codeReview.parseDisclosureKey(read.spec.stake.disclosureKey)).toString('hex')}`;
  } catch { /* no key this listing could hold */ }
  if (read.spec.repo !== listing.repo || read.spec.baseCommit !== listing.baseCommit || key !== String(listing.disclosureKey).toLowerCase()) {
    return { signed: false, reason: 'ARCHIVE_MISMATCH' };
  }
  return { signed: true, reason: null, keyId: read.keyId, trust: read.trust };
}
