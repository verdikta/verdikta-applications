// The code-runner's listing check (verdikta-arbiter code-runner, node A2b): POST
// /v1/listing-checks { spec, image, deadline }. The site validates a listing on the runner the
// arbiters use (build plan, assumption A4): the build once, the suite three times without network,
// baseline.json, the timings, the measured unpacked size, the default limits and the harness
// proof. The token is the runner's shared bearer token; it goes only to a loopback address, a
// Unix socket or an https URL, and never into an error or log line.
//
// What a listing's commands may be is the arbiters' rule (owner decision Q31,
// code-runner/src/commands.js), so this builder holds no copy of it: checkCommands asks the runner,
// before anything of the repository is read or the maker's setup runs. A request whose spec names
// another image than the one sent always gets a 400 from the runner's request validation, with
// every issue it found, and starts nothing.
import http from 'node:http';
import https from 'node:https';

import { codeReview } from './common.js';
import { BuilderError } from './errors.js';
import { isLoopbackHost } from './net.js';

const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const LIMIT_KEYS = Object.freeze(['cpus', 'memoryMb', 'buildSeconds', 'testSeconds', 'runSeconds', 'maxPatchBytes']);
const CHECK_IMAGE = 'registry.invalid/verdikta-builder-command-check';
const CHECK_DEADLINE_MS = 1000;
const MISMATCH = 'IMAGE_MISMATCH';
const NOT_ALLOWED = 'COMMAND_NOT_ALLOWED';
/** What a runner without Q31's grammar lets through and one with it refuses, per command. */
const CANARY = Object.freeze({
  build: 'true; forge build',
  test: 'true; forge test',
  testFiles: 'true; forge test --match-path $FILES',
  testIds: 'true; forge test --match-test $TEST_IDS',
});

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
    compilers: listing?.compilers ?? null,
  };
}

/**
 * A listing-check request that cannot start a run, for a draft: its spec names another image than the
 * one sent, so the runner's request validation answers 400 whatever else it finds.
 */
export function commandCheckBody(draft) {
  const env = draft.env && typeof draft.env === 'object' ? draft.env : {};
  return {
    spec: { ...draft, env: { from: env.from, image: `${CHECK_IMAGE}@sha256:${'1'.repeat(64)}` } },
    image: `${CHECK_IMAGE}@sha256:${'0'.repeat(64)}`,
    deadline: CHECK_DEADLINE_MS,
  };
}

/** The draft with a shell in front of each of its commands. */
export function commandCanary(draft) {
  return { ...draft, commands: { ...draft.commands, ...CANARY } };
}

/** The issues of such a request's answer, but the mismatch that made it one. */
function commandAnswer({ status, json }) {
  if (status === 401) throw new BuilderError('RUNNER_UNAUTHORIZED', 'the code-runner refused the token', { step: 'spec' });
  const issues = status === 400 && json?.outcome === 'requester_error' && Array.isArray(json.issues) ? json.issues : null;
  if (!issues || !issues.some((i) => i?.code === MISMATCH)) {
    throw new BuilderError('RUNNER_ANSWER_INVALID', `the code-runner answered HTTP ${status} to a request it should refuse, for naming two images`, { step: 'spec' });
  }
  return issues.filter((i) => i.code !== MISMATCH).map((i) => ({ code: String(i.code), path: i.path ?? null, detail: String(i.detail ?? '') }));
}

/**
 * What the runner says of a draft's commands, by its own codes.
 *
 * It first asks about the canary: a runner that lets any of the four through has not got the grammar
 * an arbiter's runner refuses claims by, so whatever it accepted, a claim could refuse. The workflow's
 * runner is the pinned commit (action/pins.json); a site's is its operator's, and this is the floor
 * under that, since nothing a runner answers names its commit.
 *
 * @param {object} o
 * @param {{ listingCheck: Function }} o.runner - createRunnerClient()
 * @param {object} o.draft
 * @returns {Promise<{ canary: string, issues: { code: string, path: string|null, detail: string }[] }>}
 * @throws {BuilderError} RUNNER_WITHOUT_GRAMMAR, RUNNER_UNAUTHORIZED, RUNNER_ANSWER_INVALID, RUNNER_UNAVAILABLE
 */
export async function checkCommands({ runner, draft }) {
  const canary = commandAnswer(await runner.listingCheck(commandCheckBody(commandCanary(draft))));
  const lets = Object.keys(CANARY).filter((key) => !canary.some((i) => i.code === NOT_ALLOWED && i.path === `/spec/commands/${key}`));
  if (lets.length) {
    throw new BuilderError('RUNNER_WITHOUT_GRAMMAR', `the code-runner does not refuse a shell in front of commands.${lets.join(', commands.')}, as an arbiter's runner does: it is older than the verdikta-arbiter commit this builder is pinned to (action/pins.json), and a claim could refuse what it accepts`, { step: 'spec' });
  }
  return { canary: NOT_ALLOWED, issues: commandAnswer(await runner.listingCheck(commandCheckBody(draft))) };
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
  // A runner before node A2c has not read the image's compilers, and accepts what the design's listing check refuses.
  if (!Array.isArray(listing.compilers?.checked)) throw invalid('the answer does not say the runner read the image\'s compilers: it is older than the verdikta-arbiter commit this builder is pinned to');
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
