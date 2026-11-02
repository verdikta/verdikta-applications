// "Did the builder sign this listing": the listing archive's attestation over the files it binds,
// verified with @verdikta/common's validateAttestation, as arbiters verify it. The site's record and
// feed ask this, and so does the hunter tool (node P5) before it offers a commit: a listing whose
// archive does not verify is one arbiters will not judge.
//
// The attestation binds code_review.json, the baseline and the known issues, not the manifest or the
// primary file, so those signed files can be repackaged around another panel or none. So it also
// asks what needs nothing extracted of what the arbiters' front gates ask and what the site builds:
// the six outcomes, the claim query, a valid baseline and known issues, and the panel, which must be
// common's for the archive's role (the listing or the dispute). An archive that fails these is not
// what the builder's flow issued, however good its signature, and the dispute archive counts as much
// as the listing archive: a maker who chose its own would choose who judges their disputes.
//
// A signature says nothing of who listed the archive: a signed archive can be listed from any
// wallet, and that wallet's address is not in it (docs/control-proof.md, "Replay"). The signature
// and the on-chain maker's proof are two checks, and a listing needs both.
//
// The archive is the maker's, so nothing is extracted: named members are read from the ZIP's central
// directory, each held to a byte cap (zipRead.js). This package has no dependency, so common's
// validators are an argument: `codeReview`, as the caller's pinned copy.
import { isDeepStrictEqual } from 'node:util';

import { ZipError, readZipMember, zipDirectory } from './zipRead.js';

const PLAIN_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
const MANIFEST_MAX_BYTES = 64 * 1024;
const SPEC_MAX_BYTES = 1024 * 1024;
const MEMBER_MAX_BYTES = 8 * 1024 * 1024;
const CODE_CLASS = 'code-standard';
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The folder the archive's files sit in: the root, or its one top-level folder (as ArchiveService). */
function rootOf(entries) {
  if (entries.has('manifest.json')) return '';
  const files = [...entries.keys()].filter((n) => !n.endsWith('/'));
  const tops = new Set(files.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/') + 1) : '')));
  if (tops.size !== 1) return null;
  const [top] = tops;
  return top && entries.has(`${top}manifest.json`) ? top : null;
}

const invalid = (reason = 'ARCHIVE_INVALID') => ({ signed: false, reason, spec: null, knownIssues: null });

/**
 * @param {Buffer} bytes - the listing archive
 * @param {object} o
 * @param {object} o.codeReview - @verdikta/common's codeReview module
 * @param {{ publicKey: string }[]} [o.devKeys] - dev keys this caller accepts for a statement that
 *   says dev; without them only the production trusted-builder set counts
 * @returns {{ signed: true, role: 'listing'|'dispute', specSha256: string, keyId: string, trust: string, issuedAt: string|null, spec: object, knownIssues: object[]|null, reason: null }
 *   | { signed: false, reason: 'ARCHIVE_INVALID'|'ARCHIVE_TOO_LARGE'|'NOT_SIGNED_BY_BUILDER', spec: object|null, knownIssues: object[]|null, issues?: string[] }}
 */
export function readSignedListing(bytes, { codeReview, devKeys = null }) {
  let entries;
  let root;
  let spec;
  const member = (name, max) => {
    const entry = entries.get(`${root}${name}`);
    return entry ? readZipMember(bytes, entry, max) : null;
  };
  const json = (name, max) => {
    const raw = member(name, max);
    if (!raw) throw new ZipError('ZIP_INVALID', `${name} is not in the archive`);
    return { raw, value: JSON.parse(utf8.decode(raw)) };
  };
  try {
    entries = zipDirectory(bytes);
    root = rootOf(entries);
    if (root === null) return invalid();
    const manifest = json('manifest.json', MANIFEST_MAX_BYTES).value;
    if (typeof manifest?.codeReview !== 'string' || !PLAIN_NAME.test(manifest.codeReview)) return invalid();
    const read = json(manifest.codeReview, SPEC_MAX_BYTES);
    spec = read.value;
    if (!spec || typeof spec !== 'object' || !codeReview.validateCodeReviewSpec(spec).ok) return invalid();
    // what arbiters read of the rest: a panel and a primary file they would judge with
    if (typeof manifest.version !== 'string' || typeof manifest.primary?.filename !== 'string' || !PLAIN_NAME.test(manifest.primary.filename)) return invalid();
    if (!codeReview.validateClassEnvelope(manifest.juryParameters, CODE_CLASS).ok) return invalid();
    let role = null;
    if (isDeepStrictEqual(manifest.juryParameters, codeReview.CODE_STANDARD_PANEL)) role = 'listing';
    else if (isDeepStrictEqual(manifest.juryParameters, codeReview.CODE_STANDARD_DISPUTE_PANEL)) role = 'dispute';
    if (!role) return invalid();
    const primary = json(manifest.primary.filename, SPEC_MAX_BYTES).value;
    if (!codeReview.validateBugOutcomes(primary?.outcomes).ok || primary.query !== codeReview.buildClaimQuery(spec)) return invalid();

    const named = (name) => (typeof name === 'string' && PLAIN_NAME.test(name) ? name : null);
    const baselineName = named(spec.baseline ?? codeReview.BASELINE_FILE);
    const attestationName = named(spec.attestation ?? codeReview.ATTESTATION_FILE);
    const knownName = spec.stake?.knownIssues === undefined ? null : named(spec.stake.knownIssues);
    if (!baselineName || !attestationName || (spec.stake?.knownIssues !== undefined && !knownName)) return invalid();
    const files = { codeReview: read.raw };
    const baseline = member(baselineName, MEMBER_MAX_BYTES);
    if (baseline) files.baseline = baseline;
    const known = knownName ? member(knownName, MEMBER_MAX_BYTES) : null;
    if (known) files.knownIssues = known;
    let knownIssues = null;
    if (knownName) {
      if (!known) return { ...invalid('NOT_SIGNED_BY_BUILDER'), spec };
      knownIssues = JSON.parse(utf8.decode(known));
      if (!codeReview.validateKnownIssues(knownIssues).ok) return invalid();
    }
    if (baseline && !codeReview.validateBaseline(JSON.parse(utf8.decode(baseline)), spec).ok) return invalid();
    const attestationBytes = member(attestationName, MEMBER_MAX_BYTES);
    let attestation;
    if (attestationBytes) attestation = JSON.parse(utf8.decode(attestationBytes));
    // the statement's own (signed) trust picks the verification, as the arbiters' front gates do
    const trust = devKeys?.length && attestation?.trust === 'dev' ? { dev: true, keys: devKeys } : undefined;
    const verified = codeReview.validateAttestation(attestation, { files, trust });
    if (!verified.ok) {
      return { signed: false, reason: 'NOT_SIGNED_BY_BUILDER', spec, knownIssues, issues: verified.issues.map((i) => i.code) };
    }
    return { signed: true, reason: null, role, specSha256: attestation.sha256?.codeReview ?? null, keyId: attestation.signature.keyId, trust: attestation.trust, issuedAt: attestation.issuedAt ?? null, spec, knownIssues };
  } catch (err) {
    return invalid(err?.code === 'ZIP_TOO_LARGE' ? 'ARCHIVE_TOO_LARGE' : 'ARCHIVE_INVALID');
  }
}

/**
 * "Did the builder sign this listing": both of its archives, for the listing the chain holds. Each must
 * be read as what it is on-chain (the listing's panel, the dispute's), both must hold the same signed
 * spec, and it must be that listing's: the repository, the commit and the disclosure key the chain
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
  if (read.role !== 'listing' || dispute.role !== 'dispute' || read.specSha256 !== dispute.specSha256) return { signed: false, reason: 'ARCHIVE_MISMATCH' };
  let key = null;
  try {
    key = `0x${Buffer.from(codeReview.parseDisclosureKey(read.spec.stake.disclosureKey)).toString('hex')}`;
  } catch { /* no key this listing could hold */ }
  if (read.spec.repo !== listing.repo || read.spec.baseCommit !== listing.baseCommit || key !== String(listing.disclosureKey).toLowerCase()) {
    return { signed: false, reason: 'ARCHIVE_MISMATCH' };
  }
  return { signed: true, reason: null, keyId: read.keyId, trust: read.trust };
}
