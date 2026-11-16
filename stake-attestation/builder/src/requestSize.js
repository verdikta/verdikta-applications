// The size rule, at the builder's two steps (node P11; the rule and its arithmetic are
// shared/src/listingRequestSize.js): a listing too large for the code-runner's request is refused at
// build, and again at signing, before the key is asked for anything, because arbiters judge only signed
// archives. Build has no attestation yet, so it measures one of the exact size: the statement is the
// real one, and only the signature's fields, whose lengths never vary, are stand-ins.
import { listingParts, listingRequestBound, listingRequestRefusal, listingRequestSize } from '@verdikta/stake-attestation-shared/listing-request-size';

import { codeReview } from './common.js';
import { Refusal } from './errors.js';
import { serializeJson, withStandIns } from './spec.js';

// attestation.v1.json: the algorithm, a 64-hex key id and an Ed25519 signature in 88 characters of base64
const SIGNATURE = Object.freeze({ algorithm: 'Ed25519', keyId: '0'.repeat(64), value: `${'A'.repeat(85)}A==` });

function refuseIfOver(parts, step) {
  const over = listingRequestRefusal(parts, { codeReview });
  if (over) throw new Refusal(over.code, over.detail, { step });
}

/**
 * What can be told from the draft alone: known issues too large on their own are refused before anything
 * is fetched or built. Through the site that can't happen (its request body is smaller than the bound);
 * the command line takes any file.
 * @param {object} draft - a draft checkDraft() accepted
 * @param {Buffer|null} knownIssues - the known-issues file checkKnownIssues() accepted
 * @throws {Refusal} LISTING_REQUEST_TOO_LARGE
 */
export function assertDraftFits(draft, knownIssues) {
  refuseIfOver(listingParts({ codeReview: serializeJson(withStandIns(draft)), baseline: Buffer.from('{}'), knownIssues, attestation: {} }), 'spec');
}

/**
 * The whole listing, at the end of a build, recorded in the report whether it fits or not.
 * @param {object} o
 * @param {{ codeReview: Buffer, baseline: Buffer, knownIssues: Buffer|null }} o.files - the exact bytes written
 * @param {'dev'|'production'} o.trust - what the config's key will sign with
 * @param {string} o.runnerVersion - the code-runner that validated it, which the attestation names
 * @param {string} o.base - the base image the attestation names
 * @param {object} o.report
 * @throws {Refusal} LISTING_REQUEST_TOO_LARGE
 */
export function assertListingFits({ files, trust, runnerVersion, base, report }) {
  const statement = codeReview.createAttestationStatement({
    files: { codeReview: files.codeReview, baseline: files.baseline, knownIssues: files.knownIssues ?? undefined },
    trust,
    tools: { runner: runnerVersion },
    base,
  });
  const parts = listingParts({ ...files, attestation: { ...statement, signature: SIGNATURE } });
  report.listingRequest = { ...listingRequestSize(parts), maxBytes: listingRequestBound({ codeReview }) };
  refuseIfOver(parts, 'finalSpec');
}

/**
 * Before a signature exists: the statement about to be signed, over the files it binds.
 * @param {{ codeReview: Buffer, baseline: Buffer, knownIssues: Buffer|null }} files
 * @param {object} statement - createAttestationStatement()
 * @throws {Refusal} LISTING_REQUEST_TOO_LARGE
 */
export function assertStatementFits(files, statement) {
  refuseIfOver(listingParts({ ...files, attestation: { ...statement, signature: SIGNATURE } }), 'sign');
}
