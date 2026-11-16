// POST /api/listings: the maker's request, checked before any build is started.
//
//   { "spec": <draft code_review.json, with its stake block and disclosure key>,
//     "knownIssues": <known_issues.json entries, when spec.stake.knownIssues names the file>,
//     "allowlist": [<hunter addresses>],      (optional; empty or absent: open to every hunter)
//     "maker": "<the maker's address>",       (required, node P9: the wallet that will send list(). The
//                                              repository's file must name it, and it signs the request;
//                                              the baseline scan's findings go to it, design §8.3)
//     "deploymentProof": { signer, signature, creationTx? },  (a contract listing: required, its
//                                              deployer's or owner's signature, docs/control-proof.md)
//     "auth": { nonce, signature } }          (the maker's wallet's signature of the challenge)
//
// The draft is what the builder completes (it measures env.image, env.platform, env.unpackedBytes
// and the default limits), so it is checked here with common's validator over the builder's
// stand-ins for those fields, as the builder's own first step checks it. Before that, the
// disclosure key is decoded with common's parseDisclosureKey: a key no hunter can encrypt to is
// refused before anything is built. What list() would refuse (the windows, the allowlist, the
// number of known issues) and a claim query too long for a primary file are refused here too,
// so a build is never spent on a listing that could not go on-chain. The listing's documents
// (stake.documents, owner decision Q61 (a); node P20) go through common's validator like the rest:
// it checks each entry with documentGlobProblem and reports a bad one at its own path with its own
// code (STAKE_DOCUMENT_*), which the site passes on as they are. The site holds no glob rule.
import crypto from 'node:crypto';

import { getAddress, isAddress } from 'ethers';
import { DEFAULT_GIT_HOSTS, PROOF_REFUSALS, proofFieldProblem, repoUrlCheck } from '@verdikta/stake-attestation-shared/control-proof';
import { serializeKnownIssues } from '@verdikta/stake-attestation-shared/site-request';

import { codeReview } from '../common.js';
import { canonicalAddress } from '../control/facts.js';
import { RESERVED_NAMES } from './archives.js';
import { LIST_LIMITS, disclosureKeyBytes32, listIssues } from './listParams.js';

const TOP_KEYS = ['spec', 'knownIssues', 'allowlist', 'maker', 'deploymentProof', 'auth'];
// Names the builder writes beside the listing's files in its output folder, and the scan's own
// file, which is the maker's alone and never a listing file (builder/src/spec.js).
const BUILDER_NAMES = Object.freeze(['validation-report.json', 'dev-trust.json', 'scan-findings.json']);
const PLACEHOLDER_IMAGE = `registry.invalid/verdikta-builder-draft@sha256:${'0'.repeat(64)}`;
const ZERO = '0x0000000000000000000000000000000000000000';
/** Where common's validator reports one stake.documents entry. */
const DOCUMENT_ENTRY = /^\/stake\/documents\/[0-9]+$/;

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

export { serializeKnownIssues };

/** The maker's address, checksummed: every listing names one. */
function makerOf(raw, issues) {
  if (raw === undefined || raw === null || raw === '') {
    issues.push({ code: 'MAKER_REQUIRED', path: '/maker', detail: 'a listing names its maker, the wallet that will send list(): the project names that address in its repository' });
    return null;
  }
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw) || !isAddress(raw.toLowerCase())) {
    issues.push({ code: 'MAKER_INVALID', path: '/maker', detail: 'the maker is the 0x address of the wallet that will send list()' });
    return null;
  }
  const addr = getAddress(raw.toLowerCase());
  if (addr === ZERO) {
    issues.push({ code: 'MAKER_INVALID', path: '/maker', detail: 'the zero address cannot sign in' });
    return null;
  }
  return addr;
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
 * @param {{ gitHosts?: string[] }} [o] - the hosts the site reads a repository from
 * @returns {{ draft: object, knownIssues: { list: object[], bytes: Buffer }|null, allowlist: string[], maker: string, deploymentProof: object|null, disclosureKey: { recipient: string, bytes32: string }, signedBody: string, digest: string }}
 * @throws {RequestError} with every issue found
 */
export function parseListingRequest(body, { gitHosts = DEFAULT_GIT_HOSTS } = {}) {
  const issues = [];
  if (!isObject(body)) throw new RequestError([{ code: 'REQUEST_INVALID', path: '/', detail: 'the body is a JSON object { spec, knownIssues?, allowlist?, maker, deploymentProof?, auth }' }]);
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
  for (const i of v.issues) {
    // a document glob's issue is common's, entry by entry: its own path and its own code
    if (DOCUMENT_ENTRY.test(i.path)) issues.push({ code: i.code, path: `/spec${i.path}`, detail: i.detail });
    else issues.push({ code: 'SPEC_INVALID', path: `/spec${i.path === '/' ? '' : i.path}`, detail: `${i.code}: ${i.detail}` });
  }

  const names = [
    ['attestation', standIn.attestation],
    ['baseline', standIn.baseline],
    ['stake/knownIssues', isObject(draft.stake) ? draft.stake.knownIssues : undefined],
  ];
  const seen = new Map();
  for (const [where, name] of names) {
    if (RESERVED_NAMES.includes(name)) issues.push({ code: 'FILE_NAME_RESERVED', path: `/spec/${where}`, detail: `${name} is a name the listing archive uses for its own file` });
    else if (BUILDER_NAMES.includes(name)) issues.push({ code: 'FILE_NAME_RESERVED', path: `/spec/${where}`, detail: `${name} is a name the builder writes itself` });
    if (typeof name === 'string' && seen.has(name)) {
      issues.push({ code: 'FILE_NAME_COLLISION', path: `/spec/${where}`, detail: `${name} is also the ${seen.get(name)} file's name; each archive member needs its own` });
    }
    if (typeof name === 'string') seen.set(name, where);
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
  const maker = makerOf(body.maker, issues);

  // the repository's proof is read from a URL the site reads, and a contract's signature comes with the request
  if (typeof draft.repo === 'string') {
    const url = repoUrlCheck(draft.repo, gitHosts);
    if (!url.ok) issues.push({ code: url.reason, path: '/spec/repo', detail: PROOF_REFUSALS[url.reason] });
  }
  const contract = draft.artifact?.kind === 'contract';
  let deploymentProof = null;
  if (body.deploymentProof !== undefined && body.deploymentProof !== null) {
    if (!contract) issues.push({ code: 'REQUEST_INVALID', path: '/deploymentProof', detail: 'a repository listing has no deployment signature: its proof is the file at the commit' });
    else if (proofFieldProblem(body.deploymentProof, canonicalAddress)) issues.push({ code: 'SIGNATURE_INVALID', path: '/deploymentProof', detail: proofFieldProblem(body.deploymentProof, canonicalAddress).detail });
    else deploymentProof = { signer: canonicalAddress(body.deploymentProof.signer), signature: body.deploymentProof.signature, creationTx: body.deploymentProof.creationTx ?? null };
  } else if (contract) {
    issues.push({ code: 'NO_SIGNATURE', path: '/deploymentProof', detail: PROOF_REFUSALS.NO_SIGNATURE });
  }

  if (v.ok) {
    for (const i of listIssues(standIn)) issues.push({ ...i, path: `/spec${i.path}` });
    try {
      codeReview.buildClaimQuery(standIn);
    } catch (err) {
      issues.push({ code: 'CLAIM_QUERY_INVALID', path: '/spec', detail: err.message });
    }
  }
  if (issues.length) throw new RequestError(issues);
  const { auth, ...signed } = body;
  // What the maker's wallet signs for: the whole request but its signature, as it was sent. The signing
  // workflow gets these bytes and checks the signature again (node P15).
  const signedBody = JSON.stringify(signed);
  return { draft, knownIssues, allowlist, maker, deploymentProof, disclosureKey, signedBody, digest: crypto.createHash('sha256').update(signedBody).digest('hex') };
}
