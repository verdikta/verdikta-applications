// A listing request on its way from the site to the signing workflow (node P15). The request is a stranger's, and
// it crosses workflow inputs, so it travels as base64 of gzip: a form with nothing in it that an expression, a
// shell or a log could read as anything else. It is the exact bytes the maker's wallet signed for, so the jobs
// can check that signature for themselves, and a token holder who never had the wallet can't name its maker.
//
// What is not checked: the challenge's expiry and its one use, which only the site can know. A replay gets a
// fresh build of what that wallet already asked for. The clock stays out of it, since a build may outlast a
// challenge by hours.
//
// Node only (zlib, crypto); ethers comes as an argument, as this package has no dependency.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { LIST_ACTION, authMessageText } from './authMessage.js';

/** The server's body limit: no request it took can be larger. */
export const SITE_REQUEST_MAX_BYTES = 1024 * 1024;
/** What the inputs of one dispatch may hold, in characters, under GitHub's 65,535. */
export const DISPATCH_MAX_CHARS = 60000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const NONCE = /^[0-9a-f]{32}$/;
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNED_KEYS = Object.freeze(['spec', 'knownIssues', 'allowlist', 'maker', 'deploymentProof']);
const AUTH_KEYS = Object.freeze(['nonce', 'issuedAt', 'expiresAt', 'signature', 'stakeChainId', 'stakeContract']);
/** What the builder writes into the draft: everything else is the maker's, and signed. */
const BUILDER_FILLS = new Set(['env', 'limits', 'attestation', 'baseline']);

export class SiteRequestError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'SiteRequestError';
    this.code = code;
    this.detail = detail;
  }
}
const fail = (code, detail) => { throw new SiteRequestError(code, detail); };
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isEqual = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (!isObject(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
}

export const encodeSiteRequest = (signedJson) => zlib.gzipSync(Buffer.from(signedJson, 'utf8')).toString('base64');

/** @returns {string} the bytes the wallet signed for, as text */
export function decodeSiteRequest(text) {
  if (typeof text !== 'string' || !BASE64.test(text)) fail('SITE_REQUEST_INVALID', 'the request is not base64');
  try {
    return zlib.gunzipSync(Buffer.from(text, 'base64'), { maxOutputLength: SITE_REQUEST_MAX_BYTES }).toString('utf8');
  } catch {
    return fail('SITE_REQUEST_INVALID', `the request does not unpack to at most ${SITE_REQUEST_MAX_BYTES} bytes`);
  }
}

/** @param {{ nonce: string, issuedAt: string, expiresAt: string, signature: string, stakeChainId?: number|null, stakeContract?: string|null }} auth */
export const encodeSiteAuth = (auth) => Buffer.from(JSON.stringify(auth), 'utf8').toString('base64');

export function decodeSiteAuth(text) {
  const bad = () => fail('SITE_AUTH_INVALID', 'the signature\'s fields are not as a challenge makes them');
  if (typeof text !== 'string' || !BASE64.test(text)) bad();
  let a;
  try {
    a = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
  } catch {
    bad();
  }
  if (!isObject(a) || Object.keys(a).some((k) => !AUTH_KEYS.includes(k))) bad();
  const stakeChainId = a.stakeChainId ?? null;
  const stakeContract = a.stakeContract ?? null;
  if (typeof a.nonce !== 'string' || !NONCE.test(a.nonce) || typeof a.issuedAt !== 'string' || !TIME.test(a.issuedAt) || typeof a.expiresAt !== 'string' || !TIME.test(a.expiresAt)) bad();
  if (typeof a.signature !== 'string' || !SIGNATURE.test(a.signature)) bad();
  if (stakeChainId !== null && (!Number.isSafeInteger(stakeChainId) || stakeChainId < 1)) bad();
  if (stakeContract !== null && (typeof stakeContract !== 'string' || !ADDRESS.test(stakeContract))) bad();
  return { nonce: a.nonce, issuedAt: a.issuedAt, expiresAt: a.expiresAt, signature: a.signature, stakeChainId, stakeContract };
}

/**
 * The request, once the maker's wallet is shown to have signed exactly these bytes.
 * @param {{ request: string, auth: string, maker: string }} sent - the workflow's inputs
 * @param {{ verifyMessage: Function, getAddress: Function }} ethers
 * @returns {{ body: object, signedJson: string, maker: string, auth: object }}
 * @throws {SiteRequestError}
 */
export function verifySiteRequest({ request, auth, maker }, { verifyMessage, getAddress }) {
  const signedJson = decodeSiteRequest(request);
  const a = decodeSiteAuth(auth);
  let body;
  try {
    body = JSON.parse(signedJson);
  } catch {
    fail('SITE_REQUEST_INVALID', 'the request is not JSON');
  }
  if (!isObject(body) || !isObject(body.spec) || Object.keys(body).some((k) => !SIGNED_KEYS.includes(k))) fail('SITE_REQUEST_INVALID', `a request has ${SIGNED_KEYS.join(', ')}, and spec is an object`);
  if (typeof body.maker !== 'string' || !ADDRESS.test(body.maker)) fail('MAKER_INVALID', 'the request\'s maker is not an address');
  const canonical = getAddress(body.maker.toLowerCase());
  if (typeof maker !== 'string' || !ADDRESS.test(maker) || getAddress(maker.toLowerCase()) !== canonical) fail('SITE_REQUEST_MAKER_MISMATCH', 'the maker input is not the maker the request names');
  const digest = crypto.createHash('sha256').update(signedJson, 'utf8').digest('hex');
  const message = authMessageText({ action: LIST_ACTION, resource: `list-request:${digest}`, address: canonical, nonce: a.nonce, issuedAt: a.issuedAt, expiresAt: a.expiresAt });
  let signer = null;
  try {
    signer = verifyMessage(message, a.signature);
  } catch { /* below */ }
  if (signer !== canonical) fail('MAKER_SIGNATURE_INVALID', 'the maker\'s wallet did not sign this request');
  return { body, signedJson, maker: canonical, auth: a };
}

/** known_issues.json as the archive holds it: two-space JSON and a final newline, as the builder writes files. */
export const serializeKnownIssues = (list) => Buffer.from(`${JSON.stringify(list, null, 2)}\n`, 'utf8');

/**
 * The paths where a built code_review.json differs from the maker's draft beyond what the builder fills.
 * @param {object} draft
 * @param {object} built
 * @param {{ attestationFile: string, baselineFile: string }} names - common's defaults
 * @returns {string[]}
 */
export function specChanges(draft, built, { attestationFile, baselineFile }) {
  const out = [];
  for (const k of new Set([...Object.keys(draft), ...Object.keys(built)])) {
    if (BUILDER_FILLS.has(k)) continue;
    if (!isEqual(draft[k], built[k])) out.push(`/${k}`);
  }
  if (built.env?.from !== draft.env?.from) out.push('/env/from');
  if (built.attestation !== (draft.attestation ?? attestationFile)) out.push('/attestation');
  if (built.baseline !== (draft.baseline ?? baselineFile)) out.push('/baseline');
  for (const [k, v] of Object.entries(draft.limits ?? {})) if (built.limits?.[k] !== v) out.push(`/limits/${k}`);
  return out;
}
