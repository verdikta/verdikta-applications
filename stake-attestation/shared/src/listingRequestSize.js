// How much of the code-runner's request a listing may take (node P11; design §8.3, §12, erratum E6).
//
// For each claim an arbiter's External Adapter POSTs one JSON body to its code-runner, and the runner
// answers 413 above 16 MiB. The listing's own files are in that body every time. So a listing that
// leaves a claim no room makes every arbiter abstain on every claim, no round settles, and under E6 the
// bonds go to the maker: a maker could list a stake no claim can settle, and collect. The builder
// refuses to sign such a listing (arbiters judge only signed archives), and the site shows and counts
// the refusal by this one code. The rule lives here so the builder and the server measure alike.
//
//   The listing's number  the bytes `spec`, `attestation`, `baseline` and `knownIssues` take in the body,
//                         each JSON.stringify(JSON.parse(file)) as the EA and axios make it. Those bytes
//                         are fixed at signing, so this is exact: there is one escaping to measure. One
//                         exception: known_issues.json is attested as given, so a file padded with
//                         whitespace counts at its file size, or it could grow the archive unmeasured.
//   The claim's number    what a claim and 8 prior findings can add at their caps, at the worst escaping
//                         JSON has (6 bytes per UTF-16 unit: a control character or a lone surrogate).
//                         That isn't known at signing, so it's measured by building that claim.
//   The bound             LISTING_REQUEST_MAX_BYTES, or less if a release of common ever leaves less.
//
// Measured, in bytes, with the listing's parts empty (test/unit/requestSize.test.js in the builder):
// 12,784,423 at code-standard and 14,224,422 at code-premium, whose report.md may be twice as long. That
// leaves 3,992,801 and 2,552,802 for the listing. The EA sends code-standard today (build plan A8), but
// the runner already takes code-premium and a listing is signed once, so the bound holds for both.
//
// The arbiter's code can't be imported from this repository's packages, so what is the arbiter's is
// copied here, in one place, each with its source. What is common's is read from the caller's pinned
// copy (this package has no dependency, so it's an argument). e2e/test/requestSize.test.js holds all of
// it to verdikta-arbiter at the commit in e2e/arbiter.pin.json and fails when they drift.

/** verdikta-arbiter code-runner/src/config.js, MAX_BODY_BYTES: above this the runner answers 413. */
export const RUNNER_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** code-runner/src/request.js, MAX_DEADLINE_MS: the longest `deadline` it takes. */
export const RUNNER_MAX_DEADLINE_MS = 900000;
/** code-runner/src/request.js, CID: "b" and at most 120 base32 characters. */
const LONGEST_CID_CHARS = 121;
/** external-adapter/src/codeReview/runnerClient.js, PRIOR_REPORT_MAX_CHARS: what of a prior finding's report.md goes. */
export const PRIOR_REPORT_MAX_CHARS = 4096;
/** external-adapter/src/codeReview/runnerClient.js, BYTES_PER_PACK_TOKEN: report.md goes as far as the pack could hold. */
export const BYTES_PER_PACK_TOKEN = 4;
/** external-adapter/src/codeReview/frontGates.js: what the EA sends once the claim passed its gates. */
const EA_GATES = Object.freeze({ disclosure: 'pass', inScope: 'pass' });

/** The refusal, by the one code the builder and the server use. */
export const LISTING_REQUEST_TOO_LARGE = 'LISTING_REQUEST_TOO_LARGE';
/** The share of the request a listing may take: 455,650 bytes under what code-premium leaves. */
export const LISTING_REQUEST_MAX_BYTES = 2 * 1024 * 1024;

// As the EA's reader decodes them, strictly. A byte order mark stays in the text and JSON.parse refuses it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const EMPTY_LISTING = Object.freeze({ spec: {}, attestation: {}, baseline: {}, knownIssues: [] });
/** What the empty listing takes of a body: `{}`, `{}`, `{}` and `[]`. */
const EMPTY_LISTING_BYTES = 8;
/** Control characters JSON writes as \u00XX and a path's pattern allows: not \b, \t, \n, \v, \f or \r. */
const WIDEST = Array.from({ length: 31 }, (_, i) => i + 1).filter((c) => c < 8 || c > 13).map((c) => String.fromCharCode(c));
const WIDE = WIDEST[0];
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** The bytes `value` takes in a JSON body. */
export function requestBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** The EA's cutText: at most `max` UTF-16 units, never through a character. */
function cutText(text, max) {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * The body of POST /v1/runs: external-adapter/src/codeReview/runnerClient.js, buildRunRequest, field for
 * field, with common's module as an argument.
 * @param {{ codeClass: string, eaGates: object, listing: object, claim: object, priorFindings: object[] }} context
 * @param {number} deadlineMs
 * @param {{ codeReview: object }} o - @verdikta/common's codeReview module
 */
export function runRequestBody(context, deadlineMs, { codeReview }) {
  const { listing, claim } = context;
  const reportMax = codeReview.getCodeClass(context.codeClass).envelope.contextPackTokens * BYTES_PER_PACK_TOKEN;
  return {
    listingCid: listing.cid,
    bcid: claim.bcid,
    spec: listing.spec,
    attestation: listing.attestation,
    pocPatch: Buffer.from(claim.pocPatch).toString('base64'),
    fixPatch: claim.fixPatch && claim.fixPatch.length > 0 ? Buffer.from(claim.fixPatch).toString('base64') : null,
    baseline: listing.baseline,
    finding: claim.finding,
    report: cutText(claim.report, reportMax),
    knownIssues: listing.knownIssues,
    priorFindings: context.priorFindings.map((prior) => ({ ...prior, report: cutText(prior.report, PRIOR_REPORT_MAX_CHARS) })),
    eaGates: context.eaGates,
    deadline: deadlineMs,
    codeClass: context.codeClass,
  };
}

/** A finding at every cap of common's schema, each character at JSON's widest. */
function worstFinding(schema) {
  const { properties: p, definitions: d } = schema;
  const wide = (n) => WIDE.repeat(n);
  const pathLength = d.RepoPath.maxLength;
  return {
    version: 1,
    title: wide(p.title.maxLength),
    claimedClass: 'CRITICAL',
    rootCause: wide(p.rootCause.maxLength),
    // `uniqueItems`: two characters of 25 tell 625 paths apart
    affectedPaths: Array.from({ length: p.affectedPaths.maxItems }, (_, i) => `${WIDEST[Math.floor(i / WIDEST.length)]}${WIDEST[i % WIDEST.length]}${wide(pathLength - 2)}`),
    poc: { command: wide(p.poc.properties.command.maxLength), observable: wide(p.poc.properties.observable.maxLength) },
    fixIncluded: false, // a character longer than true
  };
}

/** The longest CID the runner takes; a different one for each `index`. */
const longestCid = (index) => `b${BASE32[index].repeat(LONGEST_CID_CHARS - 1)}`;

/**
 * The most a claim and its prior findings can put in the EA's request, beside `listing`: everything the
 * front gates let through at its cap (frontGates.js), with text at JSON's widest. In the context
 * buildRunRequest and runRequestBody take.
 * @param {{ spec: object, attestation: object, baseline: object, knownIssues: object[] }} listing
 * @param {{ codeReview: object, codeClass: string }} o
 */
export function worstClaimContext(listing, { codeReview, codeClass }) {
  const finding = worstFinding(codeReview.schemas.finding);
  const patch = Buffer.alloc(codeReview.SPEC_LIMIT_MAXIMA.maxPatchBytes, 0xff);
  // past every cut, so the request holds as much as the EA would send
  const reportChars = codeReview.getCodeClass(codeClass).envelope.contextPackTokens * BYTES_PER_PACK_TOKEN + 1;
  return {
    codeClass,
    eaGates: EA_GATES,
    listing: { cid: longestCid(0), spec: listing.spec, attestation: listing.attestation, baseline: listing.baseline, knownIssues: listing.knownIssues },
    claim: { bcid: longestCid(1), finding, report: WIDE.repeat(reportChars), pocPatch: patch, fixPatch: patch },
    priorFindings: Array.from({ length: codeReview.MAX_PRIOR_FINDINGS }, (_, i) => ({
      bcid: longestCid(i + 2),
      finding,
      report: WIDE.repeat(PRIOR_REPORT_MAX_CHARS + 1),
    })),
  };
}

const measuredClaimSide = new WeakMap();

/**
 * What the request holds besides the listing's four parts, at its largest: the claim, its prior findings,
 * the CIDs and the JSON around them, at whichever code class leaves the listing least. Built once per
 * process, since a body takes a moment to write.
 * @param {{ codeReview: object }} o
 * @returns {number}
 */
export function claimSideBytes({ codeReview }) {
  if (!measuredClaimSide.has(codeReview)) {
    const sizes = Object.keys(codeReview.CODE_CLASSES).map((codeClass) => requestBytes(
      runRequestBody(worstClaimContext(EMPTY_LISTING, { codeReview, codeClass }), RUNNER_MAX_DEADLINE_MS, { codeReview }),
    ));
    measuredClaimSide.set(codeReview, Math.max(...sizes) - EMPTY_LISTING_BYTES);
  }
  return measuredClaimSide.get(codeReview);
}

/**
 * How much of the request a listing may take: the share, or what the claim side leaves if that's less.
 * @param {{ codeReview: object }} o
 * @returns {number}
 */
export function listingRequestBound({ codeReview }) {
  return Math.min(LISTING_REQUEST_MAX_BYTES, RUNNER_MAX_BODY_BYTES - claimSideBytes({ codeReview }));
}

/**
 * A listing's files as the EA reads them and sends them on.
 * @param {{ codeReview: Uint8Array, baseline: Uint8Array, knownIssues?: Uint8Array|null, attestation: Uint8Array|object }} files -
 *   the exact bytes; `attestation` may be its value instead, before there's a file
 * @returns {{ spec: object, attestation: object, baseline: object, knownIssues: object[], knownIssuesFileBytes: number }}
 * @throws {TypeError|SyntaxError} a file that isn't UTF-8 or isn't JSON: the EA would refuse it too
 */
export function listingParts({ codeReview, baseline, knownIssues = null, attestation }) {
  const read = (bytes) => JSON.parse(utf8.decode(bytes));
  return {
    spec: read(codeReview),
    attestation: ArrayBuffer.isView(attestation) ? read(attestation) : attestation,
    baseline: read(baseline),
    // the EA sends [] for a listing that names no known issues (frontGates.js, readListing)
    knownIssues: knownIssues ? read(knownIssues) : [],
    knownIssuesFileBytes: knownIssues ? knownIssues.length : 0,
  };
}

/**
 * What a listing takes of the request.
 * @param {{ spec: object, attestation: object, baseline: object, knownIssues: object[], knownIssuesFileBytes?: number }} parts
 * @returns {{ bytes: number, parts: { spec: number, attestation: number, baseline: number, knownIssues: number } }}
 */
export function listingRequestSize(parts) {
  const sizes = {
    spec: requestBytes(parts.spec),
    attestation: requestBytes(parts.attestation),
    baseline: requestBytes(parts.baseline),
    knownIssues: Math.max(requestBytes(parts.knownIssues), parts.knownIssuesFileBytes ?? 0),
  };
  return { bytes: sizes.spec + sizes.attestation + sizes.baseline + sizes.knownIssues, parts: sizes };
}

/**
 * The refusal of a listing too large for the request, or null. Numbers only: no name of the project.
 * @param {object} parts - listingParts()
 * @param {{ codeReview: object }} o
 * @returns {null|{ code: string, detail: string, bytes: number, bound: number }}
 */
export function listingRequestRefusal(parts, { codeReview }) {
  const { bytes, parts: p } = listingRequestSize(parts);
  const bound = listingRequestBound({ codeReview });
  if (bytes <= bound) return null;
  return {
    code: LISTING_REQUEST_TOO_LARGE,
    detail: `The listing takes ${bytes} bytes (baseline ${p.baseline}, known issues ${p.knownIssues}, the larger of their file and what the request holds, code_review.json ${p.spec}, attestation ${p.attestation}). A listing may take at most ${bound} of the ${RUNNER_MAX_BODY_BYTES}-byte request an arbiter sends the code-runner for each claim, which keeps the rest for the claim and its prior findings. A request over that limit isn't read, and every arbiter abstains on that claim.`,
    bytes,
    bound,
  };
}
