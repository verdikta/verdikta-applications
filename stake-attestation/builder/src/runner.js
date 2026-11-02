// The code-runner's listing check (verdikta-arbiter code-runner, node A2b): POST
// /v1/listing-checks { spec, image, deadline }. The site validates a listing on the runner the
// arbiters use (build plan, assumption A4): the build once, the suite three times without network,
// baseline.json, the timings, the measured unpacked size, the default limits and the harness
// proof. The token is the runner's shared bearer token; it goes only to a loopback address, a
// Unix socket or an https URL, and never into an error or log line.
import http from 'node:http';
import https from 'node:https';

import { codeReview } from './common.js';
import { BuilderError } from './errors.js';
import { isLoopbackHost } from './net.js';

const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const LIMIT_KEYS = Object.freeze(['cpus', 'memoryMb', 'buildSeconds', 'testSeconds', 'runSeconds', 'maxPatchBytes']);

/**
 * @param {object} o
 * @param {string|null} [o.url] - http://127.0.0.1:8090, or an https URL for a remote runner
 * @param {string|null} [o.socket] - a Unix socket path instead
 * @param {string} o.token
 * @param {number} [o.timeoutMs] - how long to wait for an answer (the check's deadline plus a margin)
 */
export function createRunnerClient({ url = null, socket = null, token, timeoutMs = 960000 }) {
  if ((url === null) === (socket === null)) throw new TypeError('the runner needs exactly one of url and socket');
  let target = null;
  if (url !== null) {
    target = new URL(url);
    if (!(target.protocol === 'https:' || (target.protocol === 'http:' && isLoopbackHost(target.hostname)))) {
      throw new BuilderError('CONFIG_INVALID', 'the runner URL must be a loopback address over http, or https: its bearer token must not cross a network in the clear');
    }
  }
  if (typeof token !== 'string' || token.length < 32) throw new BuilderError('CONFIG_INVALID', 'the runner token must be at least 32 characters');

  function request(method, pathname, body) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const options = {
      method,
      path: pathname,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      },
      ...(socket ? { socketPath: socket } : { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined }),
    };
    const lib = target && target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_ANSWER_BYTES) {
            req.destroy(new Error(`the answer is larger than ${MAX_ANSWER_BYTES} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
          resolve({ status: res.statusCode, json });
        });
        res.on('error', (err) => reject(new BuilderError('RUNNER_UNAVAILABLE', `the code-runner's answer broke off: ${err.message}`)));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)));
      req.on('error', (err) => reject(new BuilderError('RUNNER_UNAVAILABLE', `the code-runner at ${socket || target.origin} cannot be reached: ${err.message}`)));
      req.end(payload);
    });
  }

  return {
    health: () => request('GET', '/health'),
    /** @param {{ spec: object, image: string, deadline: number }} body */
    listingCheck: ({ spec, image, deadline }) => request('POST', '/v1/listing-checks', { spec, image, deadline }),
  };
}

function invalid(detail) {
  return new BuilderError('RUNNER_ANSWER_INVALID', detail, { step: 'listingCheck' });
}

function summary(json, listing) {
  return {
    checkId: typeof json.checkId === 'string' ? json.checkId : null,
    runner: json.runner && typeof json.runner === 'object' ? { version: json.runner.version, runtime: json.runner.runtime, platform: json.runner.platform } : null,
    warnings: Array.isArray(listing?.warnings) ? listing.warnings.map((w) => ({ code: w.code, detail: w.detail })) : [],
    timings: listing?.timings ?? null,
    suite: listing?.suite ?? null,
    harness: listing?.harness ?? null,
    checkout: listing?.checkout ?? null,
  };
}

/**
 * What a listing-check answer means for the listing:
 *   accepted   baseline.json, the timings, the defaults and the measured size, checked
 *   refused    the runner's refusals (LISTING_TOO_HEAVY, LIMITS_BELOW_DEFAULTS, LEGACY_ASSERTIONS, ...)
 *   rejected   a 400: the image or spec is the requester's broken package, with the runner's issues
 *   abstained  a 503: nothing was decided; retry
 * @param {{ status: number, json: object|null }} answer
 * @param {{ spec: object, image: string }} asked
 * @throws {BuilderError} RUNNER_UNAUTHORIZED, RUNNER_ANSWER_INVALID
 */
export function interpretListingCheck({ status, json }, { spec, image }) {
  if (status === 401) throw new BuilderError('RUNNER_UNAUTHORIZED', 'the code-runner refused the token', { step: 'listingCheck' });
  if (!json || typeof json !== 'object') throw invalid(`the code-runner answered HTTP ${status} with no JSON`);
  if (status === 400 && json.outcome === 'requester_error') {
    const issues = (Array.isArray(json.issues) ? json.issues : []).map((i) => ({ code: String(i.code), path: i.path ?? null, detail: String(i.detail ?? '') }));
    return { outcome: 'rejected', issues: issues.length ? issues : [{ code: 'LISTING_CHECK_REJECTED', path: null, detail: 'the code-runner refused the request' }], ...summary(json, null) };
  }
  if (status === 503 && json.outcome === 'abstain') {
    return { outcome: 'abstained', abstain: json.abstain ?? { cause: 'unknown' }, ...summary(json, null) };
  }
  if (status !== 200 || json.outcome !== 'definitive' || json.kind !== 'listing-check' || !json.listing || typeof json.listing !== 'object') {
    throw invalid(`the code-runner answered HTTP ${status} without a listing check's result`);
  }
  const listing = json.listing;
  const base = summary(json, listing);
  if (!base.runner || !SEMVER.test(String(base.runner.version))) throw invalid('the answer does not name the runner\'s version');
  if (listing.status === 'refused') {
    const refusals = (Array.isArray(listing.refusals) ? listing.refusals : []).map((r) => ({ code: String(r.code), detail: String(r.detail ?? '') }));
    if (!refusals.length) throw invalid('a refused listing check names no refusal');
    return { outcome: 'refused', refusals, baseline: null, limits: null, unpackedBytes: listing.image?.unpackedBytes ?? null, ...base };
  }
  if (listing.status !== 'accepted') throw invalid(`unknown listing status ${JSON.stringify(listing.status)}`);
  if (listing.image?.ref !== image) throw invalid('the answer is for another image than the one sent');
  const unpackedBytes = listing.image.unpackedBytes;
  if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes < 1) throw invalid('the answer has no measured unpacked size');
  const baseline = listing.baseline;
  if (!baseline || baseline.baseCommit !== spec.baseCommit) throw invalid('the baseline is not for the listed commit');
  const v = codeReview.validateBaseline(baseline, spec);
  if (!v.ok) throw invalid(`the baseline does not validate: ${v.issues.map((i) => `${i.code} ${i.detail}`).join('; ')}`);
  const limits = listing.limits;
  if (!limits || !LIMIT_KEYS.every((k) => Number.isSafeInteger(limits[k]) && limits[k] > 0)) throw invalid('the answer has no default limits');
  return {
    outcome: 'accepted',
    baseline,
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k]])),
    unpackedBytes,
    refusals: [],
    ...base,
  };
}
