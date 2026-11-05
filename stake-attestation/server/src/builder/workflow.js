// The environment builder behind the listing flow's interface, as a run of Verdikta's caller workflow (node P15;
// docs/builder-kms-signing.md). Production signing happens only in a GitHub job, by OIDC, with the key in KMS, so
// this backend starts a run, follows it and collects what it signed. build() resolves to what the command-line
// builder's does (src/builder/cli.js), with these differences:
//
//   hooks.onRun({ id, url })     the run was found: anyone with the listing's id may see it
//   hooks.onState(state)         'awaiting_approval' while a required reviewer has it, 'signing' once approved.
//                                With no reviewers neither is ever said, and nothing else differs
//   notStarted: true             GitHub refused the dispatch, so no run exists
//   never holdSlot               no run outlives its deadline by holding a slot; the sweep goes on cancelling it
//
// A run is found by its correlation id: `<site>-<job id>`, its run-name in the caller. Jobs live in memory, so after a
// restart nothing here follows the runs the last server started. The sweep, at start and then on a timer, cancels
// every active run with this site's prefix that no live build owns, which covers a restart, a run that showed up
// late, a cancel that didn't take, and a dispatch whose answer was lost. Runs under another prefix are not this
// server's: a person's test by hand, or another site's.
import { DISPATCH_MAX_CHARS, encodeSiteAuth, encodeSiteRequest } from '@verdikta/stake-attestation-shared/site-request';

import { readZipMember, zipDirectory } from '../zipRead.js';
import { createGithubActions } from './githubActions.js';

const ARTIFACT_PREFIX = 'site';
const SIGNED_ARTIFACT = `${ARTIFACT_PREFIX}-listing-signed`;
const LISTING_ARTIFACT = `${ARTIFACT_PREFIX}-listing`;
const REPORT_FILE = 'validation-report.json';
const PLAIN_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
/** Every listing's image goes here (owner decision Q42 (a)). */
const IMAGE_NAMESPACE = 'ghcr.io/verdikta/';
const MEMBER_MAX_BYTES = 16 * 1024 * 1024;
const COLLECT_ATTEMPTS = 5;
const SWEEP_PAGES = 3;
const PER_PAGE = 100;
/** A challenge's fields and a stake deployment, encoded, at their longest. */
const AUTH_CHARS = 512;
const INPUT_OVERHEAD = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errored = (code, detail, extra = {}) => ({ status: 'error', report: null, files: null, devTrust: null, error: { code, detail }, ...extra });
const logCode = (err) => (typeof err?.code === 'string' ? `${err.code}${err.status ? ` ${err.status}` : ''}` : (err?.name ?? 'error'));
const minutes = (ms) => Math.round(ms / 60000);

class Unusable extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}
const unusable = (code, detail) => { throw new Unusable(code, detail); };

/** The members of a run's folder, by name: each one's size capped, a zip bomb stopped by zipRead. */
function folderOf(zip) {
  let dir;
  try {
    dir = zipDirectory(zip);
  } catch (err) {
    unusable('BUILDER_OUTPUT_UNREADABLE', `the run's artifact cannot be read (${err?.code ?? 'error'})`);
  }
  return (name) => {
    if (typeof name !== 'string' || !PLAIN_NAME.test(name)) unusable('BUILDER_OUTPUT_INVALID', 'code_review.json names a file by something other than a plain name');
    const entry = dir.get(name);
    if (!entry) return null;
    try {
      return readZipMember(zip, entry, MEMBER_MAX_BYTES);
    } catch (err) {
      return unusable('BUILDER_OUTPUT_UNREADABLE', `${name} cannot be read from the run's artifact (${err?.code ?? 'error'})`);
    }
  };
}

function jsonOf(bytes, what) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return unusable('BUILDER_OUTPUT_INVALID', `${what} is not JSON`);
  }
}

/** What build() returns for the signed folder: the listing flow then checks it as it checks any build. */
function acceptedFrom(zip) {
  const read = folderOf(zip);
  const codeReview = read('code_review.json');
  const reportBytes = read(REPORT_FILE);
  if (!codeReview || !reportBytes) unusable('BUILDER_OUTPUT_INVALID', `the signed folder lacks code_review.json or ${REPORT_FILE}`);
  const spec = jsonOf(codeReview, 'code_review.json');
  const report = jsonOf(reportBytes, REPORT_FILE);
  if (typeof spec.env?.image !== 'string' || !spec.env.image.startsWith(IMAGE_NAMESPACE)) unusable('IMAGE_NOT_UNDER_VERDIKTA', `a listing's image goes under ${IMAGE_NAMESPACE}: this one does not`);
  const files = {
    codeReview,
    baseline: read(spec.baseline),
    knownIssues: spec.stake?.knownIssues ? read(spec.stake.knownIssues) : null,
    attestation: read(spec.attestation),
  };
  if (!files.baseline || !files.attestation || (spec.stake?.knownIssues && !files.knownIssues)) unusable('BUILDER_OUTPUT_INVALID', 'the signed folder lacks a file code_review.json names');
  // never dev trust: production verification is the only one this backend's archives get
  return { status: 'accepted', report, files, devTrust: null };
}

/**
 * @param {object} cfg - config.builds.workflow
 * @param {{ env?: Record<string,string|undefined>, logger: { info: Function, warn: Function, error: Function } }} o
 */
export function createWorkflowBuilder(cfg, { env = process.env, logger }) {
  const api = createGithubActions({ apiUrl: cfg.apiUrl, repo: cfg.repo, file: cfg.file, ref: cfg.ref, tokenEnv: cfg.tokenEnv, env });
  const own = new RegExp(`^${cfg.site}-[0-9a-f]{32}$`);
  /** correlation id -> its run's id, or null while it is being looked for */
  const live = new Map();
  const cancelTries = new Map();
  let timer = null;

  /** One of ours: started on the branch, by dispatch, in this repository. A title alone says nothing. */
  const fromUs = (run) => run?.event === 'workflow_dispatch' && run.head_branch === cfg.ref && String(run.repository?.full_name ?? cfg.repo).toLowerCase() === cfg.repo.toLowerCase();

  function inputsFor({ jobId, signedBody, auth, maker, draft, deploymentProof }) {
    return {
      'correlation-id': `${cfg.site}-${jobId}`,
      request: encodeSiteRequest(signedBody),
      auth: encodeSiteAuth({ ...auth, stakeChainId: deploymentProof?.stakeChainId ?? null, stakeContract: deploymentProof?.stakeContract ?? null }),
      maker,
      'chain-id': draft.artifact?.kind === 'contract' ? String(draft.artifact.chainId) : '',
    };
  }

  async function findRun(correlationId, deadline) {
    for (;;) {
      try {
        const runs = await api.listRuns({ perPage: PER_PAGE });
        const match = runs.filter((r) => r.display_title === correlationId && fromUs(r)).sort((a, b) => a.id - b.id)[0];
        if (match) return match;
      } catch (err) {
        logger.warn(`build ${correlationId}: looking for its run: ${logCode(err)}`);
      }
      if (Date.now() >= deadline) return null;
      await sleep(cfg.pollMs);
    }
  }

  async function cancelOnce(run, why) {
    try {
      await api.cancel(run.id);
    } catch (err) {
      // the sweep goes on trying: this run is no longer live
      logger.warn(`run ${run.id} (${why}): the cancel did not take: ${logCode(err)}`);
    }
  }

  /** Follows the run to its end or a deadline. @returns {Promise<{ run?: object, stop?: object }>} */
  async function follow(run, hooks) {
    let activeMs = 0;
    let last = Date.now();
    let waitingSince = null;
    for (;;) {
      await sleep(cfg.pollMs);
      const t = Date.now();
      if (waitingSince === null) activeMs += t - last;
      last = t;
      let r = null;
      try {
        r = await api.getRun(run.id);
      } catch (err) {
        if (err?.status === 404) return { stop: errored('RUN_LOST', 'the run no longer exists; nothing was issued; submit again') };
        logger.warn(`run ${run.id}: reading it: ${logCode(err)}`);
      }
      if (r?.status === 'completed') return { run: r };
      if (r?.status === 'waiting' && waitingSince === null) {
        waitingSince = t;
        hooks.onState?.('awaiting_approval');
      } else if (r && r.status !== 'waiting' && waitingSince !== null) {
        waitingSince = null;
        hooks.onState?.('signing');
      }
      if (waitingSince !== null && t - waitingSince >= cfg.approvalDeadlineMs) {
        await cancelOnce(run, 'approval deadline');
        return { stop: errored('APPROVAL_DEADLINE', `no reviewer answered in ${minutes(cfg.approvalDeadlineMs)} min, so the run was cancelled and nothing was signed; submit again (it counts as another build)`) };
      }
      if (activeMs >= cfg.runDeadlineMs) {
        await cancelOnce(run, 'deadline');
        return { stop: errored('RUN_DEADLINE', `the run did not finish in ${minutes(cfg.runDeadlineMs)} min, so it was cancelled and nothing was issued; submit again`) };
      }
    }
  }

  /** A read worth retrying: a build of two hours should not be lost to a passing failure of the API. */
  async function retrying(fn) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof Unusable || attempt >= COLLECT_ATTEMPTS || (err?.status >= 400 && err?.status < 500) || err?.code === 'ARTIFACT_TOO_LARGE' || err?.code === 'ARTIFACT_LOCATION_REFUSED') throw err;
        await sleep(cfg.pollMs);
      }
    }
  }

  async function artifactZip(runId, name) {
    const a = (await retrying(() => api.artifacts(runId))).find((x) => x.name === name && !x.expired);
    return a ? retrying(() => api.download(a.id, cfg.artifactMaxBytes)) : null;
  }

  async function collectSigned(run) {
    try {
      const zip = await artifactZip(run.id, SIGNED_ARTIFACT);
      if (!zip) return errored('BUILDER_OUTPUT_INVALID', 'the run succeeded and left no signed listing');
      return acceptedFrom(zip);
    } catch (err) {
      if (err instanceof Unusable) return errored(err.code, err.detail);
      logger.warn(`run ${run.id}: collecting its artifact: ${logCode(err)}`);
      return errored('BUILDER_OUTPUT_UNREADABLE', 'the run\'s signed listing could not be collected; submit again');
    }
  }

  /** The report of a run that did not succeed, if it left one. */
  async function reportOf(run) {
    try {
      const zip = await artifactZip(run.id, LISTING_ARTIFACT);
      if (!zip) return null;
      const bytes = folderOf(zip)(REPORT_FILE);
      return bytes ? jsonOf(bytes, REPORT_FILE) : null;
    } catch (err) {
      logger.warn(`run ${run.id}: reading its report: ${logCode(err)}`);
      return null;
    }
  }

  /** The maps from a run that did not succeed to a refusal or an error. */
  async function collectFailure(run) {
    const report = await reportOf(run);
    const approvals = await retrying(() => api.approvals(run.id)).catch((err) => {
      logger.warn(`run ${run.id}: reading its reviews: ${logCode(err)}`);
      return [];
    });
    // a person's word, without their comment: it stays in GitHub
    if (approvals.some((a) => a?.state === 'rejected')) {
      const refusal = { code: 'SIGNING_DECLINED', detail: 'a required reviewer declined to sign this listing', step: 'sign' };
      return { status: 'refused', report: { ...(report ?? {}), status: 'refused', refusals: [...(report?.refusals ?? []), refusal] }, files: null, devTrust: null };
    }
    if (report?.status === 'refused') return { status: 'refused', report, files: null, devTrust: null };
    if (report?.status === 'error') return { status: 'error', report, files: null, devTrust: null, error: report.error ?? { code: 'BUILD_FAILED', detail: 'the build could not be validated' } };
    if (report?.status === 'accepted') return errored('PUBLISH_OR_SIGN_FAILED', 'the build passed, and the run\'s publish or sign job failed; nothing was issued; the run says why', { report });
    const conclusion = /^[a-z_]{1,32}$/.test(run.conclusion ?? '') ? run.conclusion : null;
    return errored(conclusion ? `RUN_${conclusion.toUpperCase()}` : 'RUN_FAILED', `the run ended ${conclusion ?? 'without a conclusion the site reads'}; nothing was issued`);
  }

  /** Cancels this site's active runs that no live build owns. Never throws on GitHub's account. */
  async function sweep() {
    const seen = new Set();
    try {
      for (let page = 1; page <= SWEEP_PAGES; page += 1) {
        const runs = await api.listRuns({ page, perPage: PER_PAGE });
        for (const run of runs) {
          seen.add(run.id);
          if (run.status === 'completed' || !own.test(run.display_title ?? '') || !fromUs(run)) continue;
          const owner = live.get(run.display_title);
          if (owner === null || owner === run.id) continue;
          const tries = (cancelTries.get(run.id) ?? 0) + 1;
          cancelTries.set(run.id, tries);
          try {
            if (tries > 2) await api.forceCancel(run.id);
            else await api.cancel(run.id);
            logger.info(`sweep: cancelled run ${run.id}, which no build follows`);
          } catch (err) {
            logger.warn(`sweep: run ${run.id}: ${logCode(err)}`);
          }
        }
        if (runs.length < PER_PAGE) break;
      }
      for (const id of cancelTries.keys()) if (!seen.has(id)) cancelTries.delete(id);
    } catch (err) {
      logger.warn(`sweep: reading the runs: ${logCode(err)}`);
    }
  }

  return {
    backend: 'workflow',
    sweep,

    /** Why a parsed request can't travel as a dispatch, or null. Asked before the wallet is asked to sign. */
    requestProblem({ signedBody }) {
      const chars = encodeSiteRequest(signedBody).length + AUTH_CHARS + INPUT_OVERHEAD;
      if (chars <= DISPATCH_MAX_CHARS) return null;
      return { code: 'DISPATCH_REQUEST_TOO_LARGE', path: '/', detail: `this request takes ${chars} characters as workflow inputs, and at most ${DISPATCH_MAX_CHARS} fit: shorten the known issues or the commands` };
    },

    /**
     * @param {{ jobId: string, signedBody: string, auth: object, maker: string, draft: object, deploymentProof: object|null }} input
     * @param {{ onRun?: Function, onState?: Function }} [hooks]
     */
    async build(input, hooks = {}) {
      const correlationId = `${cfg.site}-${input.jobId}`;
      live.set(correlationId, null);
      try {
        let runId = null;
        try {
          runId = await api.dispatch(inputsFor(input));
        } catch (err) {
          logger.warn(`build ${correlationId}: the dispatch: ${logCode(err)}`);
          // GitHub's refusal, or no token: nothing started. Anything else: a run may exist, so it is looked for.
          if (err?.code === 'TOKEN_MISSING' || (err?.status >= 400 && err?.status < 500)) {
            return errored('BUILD_DISPATCH_FAILED', err?.code === 'TOKEN_MISSING' ? err.detail : 'GitHub did not start the build; try again later', { notStarted: true });
          }
          const found = await findRun(correlationId, Date.now() + cfg.findMs);
          if (!found) return errored('BUILD_DISPATCH_FAILED', 'GitHub did not say the build started, and no run appeared; try again later');
          runId = found.id;
        }
        const run = runId !== null ? { id: runId } : await findRun(correlationId, Date.now() + cfg.findMs);
        if (!run) return errored('RUN_NOT_FOUND', `no run appeared in ${minutes(cfg.findMs)} min after the build was asked for; try again later`);
        live.set(correlationId, run.id);
        if (typeof hooks.onRun === 'function') hooks.onRun({ id: run.id, url: `https://github.com/${cfg.repo}/actions/runs/${run.id}` });
        logger.info(`build ${correlationId}: run ${run.id}`);
        const { run: finished, stop } = await follow(run, hooks);
        if (stop) return stop;
        return finished.conclusion === 'success' ? await collectSigned(finished) : await collectFailure(finished);
      } finally {
        live.delete(correlationId);
      }
    },

    /** The first sweep, then one on a timer. Resolves when the first has ended. */
    start() {
      if (!timer) {
        timer = setInterval(sweep, cfg.sweepMs);
        timer.unref();
      }
      return sweep();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
