// The listing flow (design §7, §8.1-§8.2, §10.4, §13.2 list and fund):
//
//   queued     the request passed request.js; it waits for a build slot
//   building   the environment builder (node P3a) builds and pushes the env image, checks a
//              contract's verified source, validates the listing on the arbiters' code-runner,
//              then signs attestation.json in a separate step
//   refused    the builder refused the listing: the validation report says why; nothing is built
//              or pinned (a failed verified-source check ends here)
//   pinning    the build was accepted, its result checked (below) and both archives built and
//              checked as arbiters read them; they are being pinned
//   ready      both CIDs are pinned: the view carries the validation report and every argument
//              of list(); the maker's wallet sends list() and then fund()
//   error      anything else (a builder or pinning failure, a result that does not check out):
//              nothing is issued; the maker may submit again
//
// An accepted build is not taken on its word. Before any archive is issued: the report must say
// every step passed (for a contract, that the verified source matched), the built code_review.json
// must keep every term the maker submitted (the builder fills only env.image, env.platform,
// env.unpackedBytes and the limits), the known issues must be the bytes the server sent, and both
// archives must pass validateArchive.js (common's checks, as arbiters run them, with the
// attestation verified under the configured trust).
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { codeReview } from '../common.js';
import { buildListingArchives } from './archives.js';
import { artifactHashOf, artifactOf, listArguments } from './listParams.js';
import { parseListingRequest } from './request.js';
import { validateListingArchive } from './validateArchive.js';

const STEPS_ALWAYS_OK = ['spec', 'fetch', 'build', 'size', 'push', 'registry', 'listingCheck', 'finalSpec'];
const BUILDER_FILLS = new Set(['env', 'limits', 'attestation', 'baseline']);
const MAX_KEPT = 500;

export class QueueFullError extends Error {
  constructor() {
    super('BUILD_QUEUE_FULL: every build slot and queue place is taken; try again later');
    this.status = 429;
    this.code = 'BUILD_QUEUE_FULL';
  }
}

class Stop extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}
const stop = (code, detail) => { throw new Stop(code, detail); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Why an accepted report cannot be trusted to have run every check, or null. */
export function reportProblem(draft, report) {
  if (!report || report.status !== 'accepted') return `the report's status is ${report?.status ?? 'missing'}, not accepted`;
  const steps = new Map((Array.isArray(report.steps) ? report.steps : []).map((s) => [s?.name, s?.status]));
  for (const name of STEPS_ALWAYS_OK) if (steps.get(name) !== 'ok') return `the report's ${name} step is ${steps.get(name) ?? 'missing'}`;
  if (draft.artifact?.kind === 'contract') {
    if (steps.get('verifiedSource') !== 'ok') return `a contract listing's verifiedSource step is ${steps.get('verifiedSource') ?? 'missing'}`;
    if (report.verifiedSource?.status !== 'match') return `the verified-source check says ${report.verifiedSource?.status ?? 'nothing'}, not match`;
  } else if (!['ok', 'skipped'].includes(steps.get('verifiedSource'))) {
    return `the report's verifiedSource step is ${steps.get('verifiedSource') ?? 'missing'}`;
  }
  if (report.listingCheck?.status !== 'accepted') return `the code-runner's listing check says ${report.listingCheck?.status ?? 'nothing'}`;
  if (!report.attestation) return 'the report records no signed attestation';
  return null;
}

/** The paths where the built code_review.json differs from the maker's draft beyond what the builder fills. */
export function specChanges(draft, built) {
  const out = [];
  for (const k of new Set([...Object.keys(draft), ...Object.keys(built)])) {
    if (BUILDER_FILLS.has(k)) continue;
    if (!isDeepStrictEqual(draft[k], built[k])) out.push(`/${k}`);
  }
  if (built.env?.from !== draft.env?.from) out.push('/env/from');
  if (built.attestation !== (draft.attestation ?? codeReview.ATTESTATION_FILE)) out.push('/attestation');
  if (built.baseline !== (draft.baseline ?? codeReview.BASELINE_FILE)) out.push('/baseline');
  for (const [k, v] of Object.entries(draft.limits ?? {})) if (built.limits?.[k] !== v) out.push(`/limits/${k}`);
  return out;
}

/**
 * @param {object} o
 * @param {object} o.config - loadConfig()
 * @param {{ build(input: { draft: object, knownIssues: Buffer|null }): Promise<object> }} o.builder
 * @param {{ backend: string, pin(bytes: Buffer, o?: { name?: string }): Promise<string> }} o.pinner
 * @param {{ info: Function, warn: Function, error: Function }} o.logger
 */
export function createListingService({ config, builder, pinner, logger }) {
  const jobs = new Map();
  const queue = [];
  let running = 0;

  const now = () => new Date().toISOString();
  const set = (job, fields) => Object.assign(job, fields, { updatedAt: now() });

  function view(job) {
    const ready = job.status === 'ready';
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      listing: { repo: job.request.draft.repo, baseCommit: job.request.draft.baseCommit, artifact: job.request.draft.artifact ?? { kind: 'repo' } },
      artifactHash: job.artifactHash,
      disclosureKey: job.request.disclosureKey,
      validationReport: job.report ?? null,
      error: job.error ?? null,
      archives: ready ? job.archives : null,
      list: ready ? job.list : null,
      trust: ready ? job.trust : null,
      devTrust: ready ? job.devTrust : null,
    };
  }

  function prune() {
    if (jobs.size <= MAX_KEPT) return;
    for (const [id, job] of jobs) {
      if (jobs.size <= MAX_KEPT) break;
      if (['ready', 'refused', 'error'].includes(job.status)) jobs.delete(id);
    }
  }

  async function issue(job, r) {
    const { draft, knownIssues } = job.request;
    const problem = reportProblem(draft, r.report);
    if (problem) stop('BUILD_REPORT_INCONSISTENT', `the builder accepted the listing, but ${problem}`);
    const files = r.files;
    if (!files?.codeReview || !files.baseline || !files.attestation) stop('BUILD_REPORT_INCONSISTENT', 'the builder accepted the listing but returned no code_review.json, baseline or attestation');
    let built;
    try {
      built = JSON.parse(Buffer.from(files.codeReview).toString('utf8'));
    } catch {
      stop('BUILD_REPORT_INCONSISTENT', 'the built code_review.json is not JSON');
    }
    const changed = specChanges(draft, built);
    if (changed.length) stop('BUILD_CHANGED_SPEC', `the built code_review.json changed what the maker submitted at ${changed.join(', ')}`);
    if (!(knownIssues ? Buffer.from(files.knownIssues ?? []).equals(knownIssues.bytes) : !files.knownIssues)) {
      stop('BUILD_CHANGED_SPEC', 'the built known_issues.json is not the one the maker submitted');
    }

    // The trust the arbiters will apply: the statement's own (signed) trust picks it, and dev
    // keys count only on a server in dev trust, from the signing step this server ran.
    let statementTrust;
    try {
      statementTrust = JSON.parse(Buffer.from(files.attestation).toString('utf8')).trust;
    } catch {
      statementTrust = null;
    }
    const devTrust = config.trust.mode === 'dev' && statementTrust === 'dev' && r.devTrust?.dev === true && Array.isArray(r.devTrust.keys) ? r.devTrust : undefined;

    let archives;
    try {
      archives = buildListingArchives(files);
    } catch (err) {
      stop('ARCHIVE_BUILD_FAILED', err.message);
    }
    for (const role of ['listing', 'dispute']) {
      const v = await validateListingArchive(archives[role].bytes, { role, trust: devTrust });
      if (!v.ok) stop('ARCHIVE_INVALID', `the ${role} archive would be refused by arbiters: ${v.issues.map((i) => `${i.code}: ${i.detail}`).join('; ')}`);
    }

    set(job, { status: 'pinning' });
    const cids = {};
    for (const role of ['listing', 'dispute']) {
      try {
        cids[role] = await pinner.pin(archives[role].bytes, { name: `${role}-${job.id}.zip` });
      } catch (err) {
        stop('PIN_FAILED', err?.code && err?.detail ? `${err.code}: ${err.detail}` : `the ${pinner.backend} backend failed`);
      }
    }
    // everything list() stores comes from the archive's own files
    const args = listArguments({
      spec: archives.spec,
      knownIssues: files.knownIssues ? JSON.parse(Buffer.from(files.knownIssues).toString('utf8')) : null,
      allowlist: job.request.allowlist,
      oracle: config.oracle,
      listingCid: cids.listing,
      disputeCid: cids.dispute,
    });
    const summary = (role) => ({
      cid: cids[role],
      sha256: sha256(archives[role].bytes),
      size: archives[role].bytes.length,
      members: Object.fromEntries(archives[role].members.map((m) => [m.name, sha256(m.bytes)])),
    });
    set(job, {
      status: 'ready',
      archives: { listing: summary('listing'), dispute: summary('dispute') },
      list: { params: args.params, listingCid: args.listingCid, disputeCid: args.disputeCid, knownIssueIds: args.knownIssueIds },
      artifactHash: args.artifactHash,
      trust: statementTrust,
      devTrust: devTrust ?? null,
    });
    logger.info(`listing ${job.id} ready: listing ${cids.listing}, dispute ${cids.dispute} (${pinner.backend})`);
  }

  async function run(job) {
    set(job, { status: 'building' });
    let r;
    try {
      // copies: what the builder does to its input cannot change what the result is checked against
      r = await builder.build({ draft: structuredClone(job.request.draft), knownIssues: job.request.knownIssues ? Buffer.from(job.request.knownIssues.bytes) : null });
    } catch (err) {
      logger.error(`listing ${job.id}: the builder failed: ${err?.message ?? err}`);
      set(job, { status: 'error', error: { code: 'BUILDER_FAILED', detail: 'the environment builder could not be run' } });
      return;
    }
    set(job, { report: r.report ?? null });
    if (r.status === 'refused') {
      set(job, { status: 'refused' });
      logger.info(`listing ${job.id} refused: ${(r.report?.refusals ?? []).map((x) => `${x.code} (${x.step})`).join(', ')}`);
      return;
    }
    if (r.status !== 'accepted') {
      const e = r.error ?? r.report?.error ?? {};
      set(job, { status: 'error', error: { code: e.code ?? 'BUILD_FAILED', detail: e.detail ?? 'the build could not be validated' } });
      logger.warn(`listing ${job.id} build error: ${e.code ?? 'BUILD_FAILED'}`);
      return;
    }
    try {
      await issue(job, r);
    } catch (err) {
      const e = err instanceof Stop ? { code: err.code, detail: err.detail } : { code: 'ISSUE_FAILED', detail: 'the archives could not be issued' };
      if (!(err instanceof Stop)) logger.error(`listing ${job.id}: ${err?.stack ?? err}`);
      logger.warn(`listing ${job.id} not issued: ${e.code}`);
      set(job, { status: 'error', error: e });
    }
  }

  function pump() {
    while (running < config.builds.maxConcurrent && queue.length) {
      const job = queue.shift();
      running += 1;
      run(job).finally(() => {
        running -= 1;
        pump();
      });
    }
  }

  return {
    /** @throws {import('./request.js').RequestError|QueueFullError} */
    submit(body) {
      const request = parseListingRequest(body);
      if (running >= config.builds.maxConcurrent && queue.length >= config.builds.maxQueued) throw new QueueFullError();
      const at = now();
      const job = {
        id: crypto.randomBytes(16).toString('hex'),
        status: 'queued',
        createdAt: at,
        updatedAt: at,
        request,
        artifactHash: artifactHashOf(artifactOf(request.draft)),
      };
      jobs.set(job.id, job);
      prune();
      queue.push(job);
      logger.info(`listing ${job.id} queued: ${request.draft.repo}@${request.draft.baseCommit}`);
      pump();
      return view(job);
    },
    get(id) {
      const job = jobs.get(id);
      return job ? view(job) : null;
    },
  };
}
