// POST /api/listings: the maker's request, checked before any build is started.
//
//   { "spec": <draft code_review.json, with its stake block and disclosure key>,
//     "knownIssues": <known_issues.json entries, when spec.stake.knownIssues names the file>,
//     "allowlist": [<hunter addresses>] }     (optional; empty or absent: open to every hunter)
//
// The draft is what the builder completes (it measures env.image, env.platform, env.unpackedBytes
// and the default limits), so it is checked here with common's validator over the builder's
// stand-ins for those fields, as the builder's own first step checks it. Before that, the
// disclosure key is decoded with common's parseDisclosureKey: a key no hunter can encrypt to is
// refused before anything is built. What list() would refuse (the windows, the allowlist, the
// number of known issues) and a claim query too long for a primary file are refused here too,
// so a build is never spent on a listing that could not go on-chain.
import { getAddress, isAddress } from 'ethers';

import { codeReview } from '../common.js';
import { RESERVED_NAMES } from './archives.js';
import { LIST_LIMITS, disclosureKeyBytes32, listIssues } from './listParams.js';

const TOP_KEYS = ['spec', 'knownIssues', 'allowlist'];
const PLACEHOLDER_IMAGE = `registry.invalid/verdikta-builder-draft@sha256:${'0'.repeat(64)}`;
const ZERO = '0x0000000000000000000000000000000000000000';

export class RequestError extends Error {
  constructor(issues) {
    super(`LISTING_REQUEST_INVALID: ${issues.map((i) => i.code).join(', ')}`);
    this.name = 'RequestError';
    this.status = 400;
    this.code = 'LISTING_REQUEST_INVALID';
    this.issues = issues;
  }
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The draft with the builder's stand-ins for the fields it measures (builder/src/spec.js). */
export function withStandIns(draft) {
  const env = isObject(draft.env) ? draft.env : {};
  return {
    ...draft,
    env: { from: env.from, image: PLACEHOLDER_IMAGE, platform: codeReview.OCI_PLATFORM, unpackedBytes: 1 },
    attestation: draft.attestation ?? codeReview.ATTESTATION_FILE,
    baseline: draft.baseline ?? codeReview.BASELINE_FILE,
  };
}

/** known_issues.json as the archive will hold it: two-space JSON and a final newline, as the builder writes files. */
export function serializeKnownIssues(list) {
  return Buffer.from(`${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

function allowlistOf(raw, issues) {
  if (raw === undefined || raw === null) return [];
  const bad = (detail) => { issues.push({ code: 'ALLOWLIST_INVALID', path: '/allowlist', detail }); return []; };
  if (!Array.isArray(raw)) return bad('the allowlist is a list of hunter addresses');
  if (raw.length > LIST_LIMITS.MAX_ALLOWLIST) return bad(`at most ${LIST_LIMITS.MAX_ALLOWLIST} hunters can be invited`);
  const out = [];
  for (const [i, a] of raw.entries()) {
    if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a) || !isAddress(a.toLowerCase())) return bad(`entry ${i} is not an address`);
    const addr = getAddress(a.toLowerCase());
    if (addr === ZERO) return bad('the zero address cannot be invited');
    if (out.includes(addr)) return bad(`${addr} is listed twice`);
    out.push(addr);
  }
  return out;
}

/**
 * @param {unknown} body - the parsed JSON body
 * @returns {{ draft: object, knownIssues: { list: object[], bytes: Buffer }|null, allowlist: string[], disclosureKey: { recipient: string, bytes32: string } }}
 * @throws {RequestError} with every issue found
 */
export function parseListingRequest(body) {
  const issues = [];
  if (!isObject(body)) throw new RequestError([{ code: 'REQUEST_INVALID', path: '/', detail: 'the body is a JSON object { spec, knownIssues?, allowlist? }' }]);
  for (const k of Object.keys(body)) {
    if (!TOP_KEYS.includes(k)) issues.push({ code: 'REQUEST_INVALID', path: `/${k}`, detail: `unknown field; a listing request has ${TOP_KEYS.join(', ')}` });
  }
  const draft = body.spec;
  if (!isObject(draft)) throw new RequestError([...issues, { code: 'REQUEST_INVALID', path: '/spec', detail: 'spec is the draft code_review.json, an object' }]);

  // the disclosure key first: without one a hunter can encrypt to, nothing else matters
  let disclosureKey = null;
  try {
    const recipient = draft.stake?.disclosureKey;
    disclosureKey = { recipient, bytes32: disclosureKeyBytes32(recipient) };
  } catch (err) {
    issues.push({ code: 'DISCLOSURE_KEY_INVALID', path: '/spec/stake/disclosureKey', detail: `${err.message}; no claim could be encrypted to it` });
  }

  const standIn = withStandIns(draft);
  const v = codeReview.validateCodeReviewSpec(standIn);
  for (const i of v.issues) issues.push({ code: 'SPEC_INVALID', path: `/spec${i.path === '/' ? '' : i.path}`, detail: `${i.code}: ${i.detail}` });

  const names = [
    ['attestation', standIn.attestation],
    ['baseline', standIn.baseline],
    ['stake/knownIssues', isObject(draft.stake) ? draft.stake.knownIssues : undefined],
  ];
  for (const [where, name] of names) {
    if (RESERVED_NAMES.includes(name)) issues.push({ code: 'FILE_NAME_RESERVED', path: `/spec/${where}`, detail: `${name} is a name the listing archive uses for its own file` });
  }

  const named = isObject(draft.stake) ? draft.stake.knownIssues : undefined;
  const given = body.knownIssues !== undefined && body.knownIssues !== null;
  let knownIssues = null;
  if (given && !named) issues.push({ code: 'KNOWN_ISSUES_NOT_NAMED', path: '/knownIssues', detail: 'known issues were given but spec.stake.knownIssues names no file for them' });
  if (named && !given) issues.push({ code: 'KNOWN_ISSUES_MISSING', path: '/knownIssues', detail: `spec.stake.knownIssues names ${named}, but no known issues were given` });
  if (given) {
    const r = codeReview.validateKnownIssues(body.knownIssues);
    if (!r.ok) for (const i of r.issues) issues.push({ code: 'KNOWN_ISSUES_INVALID', path: `/knownIssues${i.path === '/' ? '' : i.path}`, detail: `${i.code}: ${i.detail}` });
    else if (body.knownIssues.length > LIST_LIMITS.MAX_KNOWN_ISSUES) issues.push({ code: 'LIST_BOUNDS', path: '/knownIssues', detail: `at most ${LIST_LIMITS.MAX_KNOWN_ISSUES} known issues are stored on-chain` });
    else knownIssues = { list: body.knownIssues, bytes: serializeKnownIssues(body.knownIssues) };
  }

  const allowlist = allowlistOf(body.allowlist, issues);

  if (v.ok) {
    for (const i of listIssues(standIn)) issues.push({ ...i, path: `/spec${i.path}` });
    try {
      codeReview.buildClaimQuery(standIn);
    } catch (err) {
      issues.push({ code: 'CLAIM_QUERY_INVALID', path: '/spec', detail: err.message });
    }
  }
  if (issues.length) throw new RequestError(issues);
  return { draft, knownIssues, allowlist, disclosureKey };
}
