// The listing flow (design §7, §8.1-§8.2, §10.4, §13.2 list and fund):
//
//   queued     the request passed request.js and the maker's wallet signed it; it waits for a slot
//   checking   the project's proof (node P9, owner decision Q34): the file at the listed commit names
//              the maker, on one of the repository's own branches or tags, and a contract's deployer
//              or owner signed. No proof: refused, with a named code, nothing built, signed or pinned
//   building   the environment builder (node P3a) builds and pushes the env image, checks a
//              contract's verified source, validates the listing on the arbiters' code-runner,
//              then signs attestation.json in a separate step
//   refused    the builder refused the listing: the validation report says why; nothing is built
//              or pinned (a failed verified-source check ends here)
//   scanning   the build was accepted, its result checked (below) and both archives built and
//              checked as arbiters read them; the baseline scan (design §8.3; node P4b2) runs on
//              the staked version, for the maker the request names
//   pinning    both archives are being pinned
//   ready      both CIDs are pinned: the view carries the validation report and every argument
//              of list(); the maker's wallet sends list() and then fund()
//   error      anything else (a builder or pinning failure, a result that does not check out):
//              nothing is issued; the maker may submit again
//
// A listing too large for the code-runner's request is refused, by the builder and again here (node
// P11; shared/src/listingRequestSize.js): every arbiter would abstain on every claim, and the bonds
// would go to the maker. The refusal states the size and the bound, and /api/status counts it.
//
// An accepted build is not taken on its word. Before any archive is issued: the report must say
// every step passed (for a contract, that the verified source matched), the built code_review.json
// must keep every term the maker submitted (the builder fills only env.image, env.platform,
// env.unpackedBytes and the limits), the known issues must be the bytes the server sent, and both
// archives must pass validateArchive.js (common's checks, as arbiters run them, with the
// attestation verified under the configured trust).
//
// The baseline scan is the maker's alone. Its document is kept in the job, apart from everything
// the view shows, and handed out only through scanAccess() to the route that checks the maker's
// signature. The view carries the scan's status and when it finished, never a finding, a count or
// an error text; the archives are built before the scan runs, from the builder's files only; the
// log gets the scan's outcome and the builder's error code. A scan that fails does not stop the
// listing: the scan is not a judgement, and the maker reads why it failed.
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { PROOF_REFUSALS, repositoryProofReason } from '@verdikta/stake-attestation-shared/control-proof';
import { listingParts, listingRequestRefusal } from '@verdikta/stake-attestation-shared/listing-request-size';

import { codeReview } from '../common.js';
import { CONTROL_REASONS, canonicalAddress, controlMessage, readAnswerFile } from '../control/facts.js';
import { buildListingArchives } from './archives.js';
import { artifactHashOf, artifactOf, listArguments } from './listParams.js';
import { RefusalCounter } from './refusals.js';
import { RequestError, parseListingRequest } from './request.js';
import { validateListingArchive } from './validateArchive.js';

const STEPS_ALWAYS_OK = ['spec', 'control', 'fetch', 'build', 'size', 'push', 'registry', 'listingCheck', 'finalSpec'];
const BUILDER_FILLS = new Set(['env', 'limits', 'attestation', 'baseline']);
const MAX_KEPT = 500;
const LIST_ACTION = 'list-version';
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** An error code fit for the log: a fixed identifier, never text that could quote a finding. */
const logCode = (c) => (typeof c === 'string' && CODE.test(c) ? c : 'SCAN_FAILED');

/** The maker's wallet did not sign this request. */
export class MakerSignatureError extends Error {
  constructor(status, code, detail) {
    super(`${code}: ${detail}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

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
export function reportProblem(draft, report, maker) {
  if (!report || report.status !== 'accepted') return `the report's status is ${report?.status ?? 'missing'}, not accepted`;
  if (report.control?.maker !== maker || report.control?.repo !== draft.repo || report.control?.commit !== draft.baseCommit) return `the report's proof is not for this maker, repository and commit`;
  if (draft.artifact?.kind === 'contract' && !report.control?.deployment) return 'the report records no deployment signature';
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

/** What anyone with the listing's id may know of its scan. */
function publicScan(scan) {
  if (scan.status === 'done' || scan.status === 'error') return { status: scan.status, finishedAt: scan.finishedAt };
  return { status: scan.status };
}

/**
 * @param {object} o
 * @param {object} o.config - loadConfig()
 * @param {{ build(input: { draft: object, knownIssues: Buffer|null, maker: string, deploymentProof: object|null }): Promise<object> }} o.builder
 * @param {{ scan(input: { spec: object }): Promise<{ status: 'ok'|'error', doc: object|null, error: { code: string, detail: string }|null, holdSlot?: boolean }> }} o.scanner -
 *   the baseline scan (src/builder/cli.js scan)
 * @param {{ backend: string, pin(bytes: Buffer, o?: { name?: string }): Promise<string> }} o.pinner
 * @param {{ info: Function, warn: Function, error: Function }} o.logger
 * @param {{ challenge: Function, verify: Function }} o.auth - the wallet sign-in (src/auth/walletAuth.js)
 * @param {object} o.proofs - where the project's proof is read: checkRepository({ repo, commit }),
 *   checkDeployment(listing, proof) (stores a proof that counts; throws ControlError for one that does
 *   not), stake ({ chainId, address }, or null: no deployment configured), noteDevTrust(devTrust)
 * @param {RefusalCounter} [o.refusals] - refused attempts by reason, for /api/status
 */
export function createListingService({ config, builder, scanner, pinner, logger, auth, proofs, refusals = new RefusalCounter() }) {
  const jobs = new Map();
  const queue = [];
  let running = 0;

  /** The request, or its refusal counted by each reason. */
  function parse(body) {
    try {
      return parseListingRequest(body, { gitHosts: config.control.gitHosts });
    } catch (err) {
      if (err instanceof RequestError) refusals.count(err.issues.map((i) => i.code));
      throw err;
    }
  }

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
      maker: job.request.maker,
      refusal: job.refusal ?? null,
      scan: publicScan(job.scan),
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

  function holdSlot(job, what, code) {
    // What the builder started may still be running under the Docker daemon: the slot stays
    // taken, so builds never run beyond SA_MAX_CONCURRENT_BUILDS, until an operator has
    // checked the Docker host and restarted the server.
    job.holdsSlot = true;
    logger.error(`listing ${job.id}: the builder's ${what} had to be stopped (${logCode(code)}); its build slot stays taken until the server restarts. Check the Docker host for containers labelled io.verdikta.builder=1.`);
  }

  /** The baseline scan of the staked version, for the maker named in the request. Never throws. */
  async function scan(job, spec) {
    if (job.scan.status !== 'pending') return;
    set(job, { status: 'scanning' });
    job.scan = { status: 'running' };
    let r;
    try {
      r = await scanner.scan({ spec: structuredClone(spec) });
    } catch (err) {
      // the error's name only: its message could quote what the scan read
      logger.error(`listing ${job.id}: the baseline scan could not be run (${err?.name ?? 'error'})`);
      r = { status: 'error', doc: null, error: { code: 'SCAN_FAILED', detail: 'the baseline scan could not be run' } };
    }
    if (r?.holdSlot) holdSlot(job, 'scan', r.error?.code);
    const doc = r?.doc ?? null;
    const ok = r?.status === 'ok' && doc?.status === 'ok';
    const error = doc ? null : (r?.error ?? { code: 'SCAN_FAILED', detail: 'the baseline scan returned nothing' });
    job.scanResult = { doc, error };
    job.scan = { status: ok ? 'done' : 'error', finishedAt: now() };
    if (ok) logger.info(`listing ${job.id} scan: done`);
    else logger.warn(`listing ${job.id} scan: error (${logCode(doc ? doc.error?.code : error.code)})`);
  }

  async function issue(job, r) {
    const { draft, knownIssues } = job.request;
    const problem = reportProblem(draft, r.report, job.request.maker);
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
    // the site counts an archive only under a key this server's own signing step made
    if (devTrust) proofs.noteDevTrust?.(devTrust);

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

    // the size rule, from the files the archives hold: before the scan reads them or anything is pinned
    const tooLarge = listingRequestRefusal(listingParts(files), { codeReview });
    if (tooLarge) {
      refuse(job, tooLarge.code, tooLarge.detail);
      return;
    }

    // between listing and open (design §8.3): the archives are fixed already, from the builder's
    // files alone, so nothing the scan finds can reach them
    await scan(job, archives.spec);

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
    try {
      await runSteps(job);
    } finally {
      // a listing that ended before its scan was reached is not scanned
      if (job.scan.status === 'pending') job.scan = { status: 'not_run' };
    }
  }

  /** Refused by a named code, and nothing issued: for its proof, or for its size (which says the numbers). */
  function refuse(job, code, detail = CONTROL_REASONS[code] ?? PROOF_REFUSALS[code] ?? code) {
    set(job, { status: 'refused', refusal: { code, detail } });
    refusals.count([code]);
    logger.info(`listing ${job.id} refused: ${code}`);
  }

  /** The project's proof. @returns {Promise<boolean>} whether the listing goes on to its build */
  async function checkProof(job) {
    const { draft, maker, deploymentProof } = job.request;
    set(job, { status: 'checking' });
    let answer;
    try {
      answer = await proofs.checkRepository({ repo: draft.repo, commit: draft.baseCommit });
    } catch (err) {
      if (err?.code === 'REPO_TOO_LARGE') {
        refuse(job, 'REPO_TOO_LARGE');
        return false;
      }
      logger.warn(`listing ${job.id}: the git host gave no answer (${err?.code ?? err?.name ?? 'error'})`);
      set(job, { status: 'error', error: { code: 'REPO_UNAVAILABLE', detail: CONTROL_REASONS.REPO_UNAVAILABLE } });
      return false;
    }
    const reason = repositoryProofReason({ reachable: answer.reachable, file: readAnswerFile(answer.file) }, maker);
    if (reason) {
      refuse(job, reason);
      return false;
    }
    if (draft.artifact?.kind !== 'contract') return true;
    const a = artifactOf(draft);
    try {
      await proofs.checkDeployment({
        artifactHash: job.artifactHash,
        maker,
        artifact: { kind: 'Contract', repo: a.repo, baseCommit: a.baseCommit, chainId: a.chainId, address: a.addr },
      }, deploymentProof);
      return true;
    } catch (err) {
      const transient = err?.status === 429 || err?.code === 'CHAIN_UNAVAILABLE';
      if (typeof err?.status !== 'number' || transient) {
        if (typeof err?.status !== 'number') logger.error(`listing ${job.id}: the deployment proof could not be checked (${err?.name ?? 'error'})`);
        set(job, { status: 'error', error: { code: 'CHAIN_UNAVAILABLE', detail: CONTROL_REASONS.CHAIN_UNAVAILABLE } });
        return false;
      }
      refuse(job, CONTROL_REASONS[err.code] ? err.code : 'SIGNATURE_INVALID');
      return false;
    }
  }

  async function runSteps(job) {
    if (!(await checkProof(job))) return;
    set(job, { status: 'building' });
    let r;
    const proof = job.request.deploymentProof;
    try {
      // copies: what the builder does to its input cannot change what the result is checked against
      r = await builder.build({
        draft: structuredClone(job.request.draft),
        knownIssues: job.request.knownIssues ? Buffer.from(job.request.knownIssues.bytes) : null,
        maker: job.request.maker,
        deploymentProof: proof ? { ...proof, stakeChainId: proofs.stake?.chainId ?? null, stakeContract: proofs.stake?.address ?? null } : null,
      });
    } catch (err) {
      logger.error(`listing ${job.id}: the builder failed: ${err?.message ?? err}`);
      set(job, { status: 'error', error: { code: 'BUILDER_FAILED', detail: 'the environment builder could not be run' } });
      return;
    }
    set(job, { report: r.report ?? null });
    if (r.holdSlot) holdSlot(job, 'build', r.error?.code);
    if (r.status === 'refused') {
      set(job, { status: 'refused' });
      refusals.count((r.report?.refusals ?? []).map((x) => x.code));
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
        if (!job.holdsSlot) running -= 1;
        pump();
      });
    }
  }

  return {
    /**
     * The message the maker's wallet signs for this request. Nothing to sign for a request that is refused anyway.
     * @throws {RequestError}
     */
    challenge(body) {
      const request = parse(body);
      return auth.challenge({ action: LIST_ACTION, resource: `list-request:${request.digest}`, address: request.maker });
    },

    /**
     * The message a contract listing's deployer or owner signs for a maker and an artifact.
     * @throws {RequestError}
     */
    deploymentMessage(body) {
      const o = body && typeof body === 'object' ? body : {};
      const maker = canonicalAddress(o.maker);
      // as the request's artifact takes it (listParams.js artifactOf): in any case
      const address = typeof o.address === 'string' ? canonicalAddress(o.address.toLowerCase()) : null;
      const chainId = Number(o.chainId);
      if (!maker || !address || !Number.isSafeInteger(chainId) || chainId < 1 || typeof o.repo !== 'string' || typeof o.baseCommit !== 'string' || !proofs.stake) {
        throw new RequestError([{ code: 'REQUEST_INVALID', path: '/', detail: proofs.stake ? 'the body is { maker, repo, baseCommit, chainId, address }' : 'this server has no deployment configured' }]);
      }
      const artifactHash = artifactHashOf({ kind: 1, repo: o.repo, baseCommit: o.baseCommit, chainId: String(chainId), addr: address });
      return { artifactHash, message: controlMessage({ maker, artifactHash, chainId, address, stakeChainId: proofs.stake.chainId, stakeContract: proofs.stake.address }) };
    },

    /** @throws {RequestError|MakerSignatureError|QueueFullError} */
    submit(body) {
      const request = parse(body);
      const a = body.auth;
      if (!a || typeof a !== 'object') {
        refusals.count(['MAKER_SIGNATURE_REQUIRED']);
        throw new MakerSignatureError(401, 'MAKER_SIGNATURE_REQUIRED', PROOF_REFUSALS.MAKER_SIGNATURE_REQUIRED);
      }
      const v = auth.verify({ action: LIST_ACTION, resource: `list-request:${request.digest}`, nonce: a.nonce, signature: a.signature });
      if (!v.ok) {
        refusals.count(['MAKER_SIGNATURE_INVALID']);
        throw new MakerSignatureError(v.status, 'MAKER_SIGNATURE_INVALID', `${PROOF_REFUSALS.MAKER_SIGNATURE_INVALID} ${v.detail}`);
      }
      if (running >= config.builds.maxConcurrent && queue.length >= config.builds.maxQueued) throw new QueueFullError();
      const at = now();
      const job = {
        id: crypto.randomBytes(16).toString('hex'),
        status: 'queued',
        createdAt: at,
        updatedAt: at,
        request,
        artifactHash: artifactHashOf(artifactOf(request.draft)),
        scan: { status: 'pending' },
      };
      jobs.set(job.id, job);
      prune();
      queue.push(job);
      logger.info(`listing ${job.id} queued: ${request.draft.repo}@${request.draft.baseCommit}`);
      pump();
      return view(job);
    },
    /** Refused attempts by reason, as /api/status states them. */
    refusedCounts: () => refusals.view(),
    get(id) {
      const job = jobs.get(id);
      return job ? view(job) : null;
    },
    /**
     * The scan's document, for the route that has checked the maker's signature and for nothing
     * else: { id, maker, scan (public status), result: { doc, error } | null }, or null.
     */
    scanAccess(id) {
      const job = jobs.get(id);
      if (!job) return null;
      return { id: job.id, maker: job.request.maker, scan: publicScan(job.scan), result: job.scanResult ?? null };
    },
  };
}
