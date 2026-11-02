// A listing's build, end to end (design §8.2 steps 1-4; build plan A4):
//
//   spec            the draft against @verdikta/common's schema and what this builder hosts
//   fetch           the listed commit's objects, by id, from the repository (or its mirror)
//   build           the env image (src/dockerfile.js): the maker's setup with network, then a
//                   final stage that runs nothing
//   size            its unpacked size, as the code-runner measures it: over 6 GB stops here
//   push            to the configured registry; from here on the image is its digest
//   registry        the linux/amd64 manifest an arbiter pulls: over 2 GB compressed, or any
//                   VOLUME, stops here
//   verifiedSource  for a contract: the explorer's verified source against the listed commit's
//                   files and its build with trusted tools against the deployed code (src/sourceCheck.js)
//   listingCheck    the code-runner's POST /v1/listing-checks: baseline.json, the timings, the
//                   default limits, the harness proof; its refusals stop the listing
//   finalSpec       code_review.json with env.image, env.platform, env.unpackedBytes and the limits
//
// Signing is a separate step (src/signing.js): it needs the key, and this process ran the maker's
// setup.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { codeReview } from './common.js';
import { baseImageRefs, writeBuildContext as writeContextDefault } from './dockerfile.js';
import { createDocker } from './docker.js';
import { BuilderError, Refusal } from './errors.js';
import { createExplorer } from './explorer.js';
import { fetchListedCommit as fetchDefault } from './git.js';
import { buildImage, imageSizeIssues, pushImage, unpackedBytes } from './image.js';
import { createRegistryClient } from './registry.js';
import { newReport, startStep } from './report.js';
import { createRunnerClient, interpretListingCheck } from './runner.js';
import { commitTree } from './commitFiles.js';
import { buildAtCommit } from './repoBuild.js';
import { fetchSolc } from './solc.js';
import { checkVerifiedSource } from './sourceCheck.js';
import { checkDraft, checkKnownIssues, finalSpec, runnerSpec, serializeJson } from './spec.js';
import { BUILDER_VERSION } from './version.js';

const CLASS_PLATFORM = codeReview.CLASS_HARD_LIMITS.platform;
const FETCH_TIMEOUT_MS = 600000;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Runs `fn` as the named step: ok when it returns, failed when it throws. */
async function step(report, name, fn) {
  const s = startStep(report, name);
  try {
    const out = await fn(s);
    if (s.entry.status === 'running') s.ok();
    return out;
  } catch (err) {
    s.fail(err.code);
    if (err && typeof err === 'object' && !err.step) err.step = name;
    throw err;
  }
}

/** What makes this build fit only for dev trust. */
function devOnly(config, report) {
  const out = [];
  const p = config.platforms;
  if (p.setup !== CLASS_PLATFORM) out.push({ code: 'SETUP_ON_OTHER_PLATFORM', detail: `the maker's setup ran on ${p.setup}; its outputs in the ${CLASS_PLATFORM} image may be built for the wrong platform` });
  if (p.extra.length) out.push({ code: 'EXTRA_PLATFORMS', detail: `the image index also holds ${p.extra.join(', ')}` });
  if (p.run !== CLASS_PLATFORM) out.push({ code: 'RUN_ON_OTHER_PLATFORM', detail: `the builder measured and ran the ${p.run} variant` });
  const r = report.listingCheck?.runner;
  if (r) {
    if (r.platform !== CLASS_PLATFORM) out.push({ code: 'VALIDATED_ON_OTHER_PLATFORM', detail: `the code-runner checked the ${r.platform} variant` });
    if (r.runtime !== 'runsc') out.push({ code: 'VALIDATED_WITHOUT_GVISOR', detail: `the code-runner ran under ${r.runtime}, not gVisor` });
  }
  return out;
}

/**
 * The verified-source check's build of the repository at baseCommit with trusted tools: the
 * listed commit's files from the fetched objects, the checksummed solc the explorer names, the
 * pinned base's forge, in a sandbox of the pushed image (src/repoBuild.js).
 * @returns {(req: { version: string, contractPath: string, contractName: string, paths: string[], gitDir: string, image: string }) => Promise<object>}
 */
export function repoBuilder({ config, docker, draft, workDir }) {
  const run = config.platforms.run;
  return async (req) => {
    const solc = await fetchSolc({ version: req.version, platform: run, baseUrl: config.solc.baseUrl, cacheDir: config.solc.cacheDir });
    const tree = await commitTree({ gitDir: req.gitDir, repo: draft.repo, baseCommit: draft.baseCommit, mirrorFor: config.mirrorFor, workDir });
    const out = await buildAtCommit({ docker, image: req.image, platform: run, solc, entries: tree.entries, skipped: tree.skipped, contractPath: req.contractPath, contractName: req.contractName, paths: req.paths });
    return { ...out, skippedSubmodules: tree.skipped, solc: { version: solc.longVersion, sha256: solc.sha256, platform: run } };
  };
}

/**
 * Builds, pushes and measures the env image for `draft` (steps fetch to registry).
 * @param {object} o
 * @param {object} o.draft - a draft checkDraft() accepted
 * @param {object} o.config - parseConfig()
 * @param {object} [o.deps] - doubles: docker, fetchListedCommit, writeBuildContext, registry
 * @param {object} o.report - the report to record into
 * @param {string} o.workDir - an empty folder for the fetch and the build context
 * @returns {Promise<{ ref: string, digest: string, tag: string, platform: string, platforms: string[], base: string, compressedBytes: number, unpackedBytes: number }>}
 * @throws {Refusal|BuilderError}
 */
export async function buildEnvImage({ draft, config, deps = {}, report, workDir }) {
  const docker = deps.docker ?? createDocker({ bin: config.docker.bin, host: config.docker.host });
  const fetchListedCommit = deps.fetchListedCommit ?? fetchDefault;
  const writeBuildContext = deps.writeBuildContext ?? writeContextDefault;
  const registry = deps.registry ?? createRegistryClient({ repository: config.registry.repository, apiUrl: config.registry.apiUrl });
  const { repository } = config.registry;
  const platforms = [CLASS_PLATFORM, ...config.platforms.extra];
  const gitDir = path.join(workDir, 'fetched.git');
  const contextDir = path.join(workDir, 'context');
  const tag = `${repository}:${draft.baseCommit.slice(0, 40)}-${crypto.randomBytes(4).toString('hex')}`;
  const refs = baseImageRefs(config.platforms);

  await step(report, 'fetch', () => fetchListedCommit({ repo: draft.repo, baseCommit: draft.baseCommit, mirror: config.mirrorFor(draft.repo), dir: gitDir, timeoutMs: FETCH_TIMEOUT_MS }));
  await step(report, 'build', async () => {
    writeBuildContext({ dir: contextDir, gitDir, setup: draft.commands.setup, baseCommit: draft.baseCommit, platforms: config.platforms, builderVersion: BUILDER_VERSION });
    await buildImage({ docker, contextDir, tag, platforms, timeoutMs: config.docker.buildTimeoutMs });
  });
  report.image = {
    ref: null, tag, digest: null, manifestDigest: null, platform: CLASS_PLATFORM, platforms, base: refs.attested,
    compressedBytes: null, unpackedBytes: { builder: null, runner: null, attested: null }, measuredOn: config.platforms.run, limits: config.limits,
  };
  const builderUnpacked = await step(report, 'size', async () => {
    const bytes = await unpackedBytes({ docker, ref: tag, platform: config.platforms.run });
    report.image.unpackedBytes.builder = bytes;
    const [issue] = imageSizeIssues({ unpackedBytes: bytes }, config.limits);
    if (issue) throw new Refusal(issue.code, issue.detail);
    return bytes;
  });
  const { digest } = await step(report, 'push', () => pushImage({ docker, tag, timeoutMs: config.docker.pushTimeoutMs }));
  const ref = `${repository}@${digest}`;
  report.image.ref = ref;
  report.image.digest = digest;
  const info = await step(report, 'registry', async () => {
    const i = await registry.imageInfo(digest, CLASS_PLATFORM);
    report.image.manifestDigest = i.manifestDigest;
    report.image.platforms = i.platforms;
    report.image.compressedBytes = i.compressedBytes;
    for (const p of platforms) {
      if (!i.platforms.includes(p)) throw new BuilderError('IMAGE_PLATFORM_MISSING', `the pushed image has no ${p} variant`);
    }
    if (i.volumes.length) throw new Refusal('IMAGE_DECLARES_VOLUMES', `the env image declares VOLUME ${i.volumes.join(', ')}; the code-runner refuses images with volumes`);
    const [issue] = imageSizeIssues({ compressedBytes: i.compressedBytes }, config.limits);
    if (issue) throw new Refusal(issue.code, `${issue.detail}; it was pushed as ${ref} and should be deleted`);
    return i;
  });
  return {
    ref, digest, tag, platform: CLASS_PLATFORM, platforms: info.platforms, base: refs.attested, compressedBytes: info.compressedBytes, unpackedBytes: builderUnpacked,
    // The listed commit's objects as fetched (the build context's copy), for the verified-source check.
    gitDir: path.join(contextDir, 'repo.git'),
  };
}

/**
 * The whole build of a listing, without signing.
 * @param {object} o
 * @param {object} o.draft - the maker's draft code_review.json
 * @param {Buffer|null} [o.knownIssues] - the exact bytes of known_issues.json, when the draft names one
 * @param {object} o.config - parseConfig()
 * @param {object} [o.deps] - doubles (docker, fetchListedCommit, writeBuildContext, registry, runner, explorerFor, buildRepo)
 * @param {string} [o.workDir] - where the temporary build folder is made (default config.workDir)
 * @returns {Promise<{ status: 'accepted'|'refused'|'error', files: Map<string, Buffer>, report: object }>}
 */
export async function buildListing({ draft, knownIssues = null, config, deps = {}, workDir }) {
  const report = newReport({ draft });
  const files = new Map();
  let tmp = null;
  let docker = null;
  try {
    const known = await step(report, 'spec', () => {
      const v = checkDraft(draft);
      report.warnings.push(...v.warnings);
      if (!v.ok) throw new Refusal('SPEC_INVALID', `code_review.json does not validate: ${v.issues.map((i) => i.code).join(', ')}`, { issues: v.issues });
      return checkKnownIssues(draft, knownIssues);
    });
    tmp = fs.mkdtempSync(path.join(workDir ?? config.workDir, 'vab-build-'));
    docker = deps.docker ?? createDocker({ bin: config.docker.bin, host: config.docker.host });
    const image = await buildEnvImage({ draft, config, deps: { ...deps, docker }, report, workDir: tmp });

    await step(report, 'verifiedSource', async (s) => {
      if (draft.artifact?.kind !== 'contract') {
        s.skip('not a contract listing');
        return;
      }
      const { chainId, address } = draft.artifact;
      const ex = config.explorers.get(chainId);
      if (!ex) throw new BuilderError('EXPLORER_NOT_CONFIGURED', `no explorer is configured for chain ${chainId} (config explorers)`);
      const explorer = deps.explorerFor ? deps.explorerFor(chainId, ex) : createExplorer({ apiUrl: ex.apiUrl, apiKey: ex.apiKey(), chainId, timeoutMs: ex.timeoutMs });
      const buildImpl = deps.buildRepo ?? repoBuilder({ config, docker, draft, workDir: tmp });
      const buildRepo = (req) => buildImpl({ ...req, baseCommit: draft.baseCommit, gitDir: image.gitDir, image: image.ref });
      const r = await checkVerifiedSource({ spec: draft, explorer, buildRepo });
      const api = new URL(ex.apiUrl);
      report.verifiedSource = {
        status: r.ok ? 'match' : 'mismatch',
        explorer: { apiUrl: `${api.origin}${api.pathname}`, chainId, address },
        contract: r.contract,
        summary: r.summary,
        issues: r.issues,
        warnings: r.warnings,
      };
      if (!r.ok) throw Object.assign(new Refusal(r.issues[0].code, r.issues[0].detail), { all: r.issues });
    });

    const lc = await step(report, 'listingCheck', async () => {
      const runner = deps.runner ?? createRunnerClient({ url: config.runner.url, socket: config.runner.socket, token: config.runner.token(), timeoutMs: config.runner.deadlineMs + 60000 });
      const answer = await runner.listingCheck({ spec: runnerSpec(draft, image.ref), image: image.ref, deadline: config.runner.deadlineMs });
      const r = interpretListingCheck(answer, { spec: draft, image: image.ref });
      report.listingCheck = {
        status: r.outcome, checkId: r.checkId, runner: r.runner, refusals: r.refusals ?? [], issues: r.issues ?? [], warnings: r.warnings,
        abstain: r.abstain ?? null, timings: r.timings, limits: r.limits ?? null, unpackedBytes: r.unpackedBytes ?? null, suite: r.suite, harness: r.harness, checkout: r.checkout,
      };
      if (r.outcome === 'abstained') {
        throw new BuilderError('LISTING_CHECK_ABSTAINED', `the code-runner decided nothing (${r.abstain.cause}${r.abstain.step ? ` at ${r.abstain.step}` : ''}): ${r.abstain.detail ?? ''}`.trim());
      }
      if (r.outcome === 'refused') throw Object.assign(new Refusal(r.refusals[0].code, r.refusals[0].detail), { all: r.refusals });
      if (r.outcome === 'rejected') throw Object.assign(new Refusal(r.issues[0].code, r.issues[0].detail), { all: r.issues.map(({ code, detail }) => ({ code, detail })) });
      return r;
    });

    await step(report, 'finalSpec', () => {
      const attested = Math.max(image.unpackedBytes, lc.unpackedBytes);
      report.image.unpackedBytes.runner = lc.unpackedBytes;
      report.image.unpackedBytes.attested = attested;
      const [issue] = imageSizeIssues({ unpackedBytes: attested }, config.limits);
      if (issue) throw new Refusal(issue.code, issue.detail);
      const spec = finalSpec(draft, { image: image.ref, unpackedBytes: attested, limits: lc.limits });
      const v = codeReview.validateCodeReviewSpec(spec);
      if (!v.ok) throw new Refusal('SPEC_INVALID', `the completed code_review.json does not validate: ${v.issues.map((i) => i.code).join(', ')}`, { issues: v.issues });
      const b = codeReview.validateBaseline(lc.baseline, spec);
      if (!b.ok) throw new BuilderError('RUNNER_ANSWER_INVALID', `the code-runner's baseline does not validate: ${b.issues.map((i) => i.code).join(', ')}`);
      files.set('code_review.json', serializeJson(spec));
      files.set(spec.baseline, serializeJson(lc.baseline));
      if (known) files.set(known.name, known.bytes);
      report.files = Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)]));
      report.limits = spec.limits;
      report.baseline = { tests: lc.baseline.tests.length, stable: lc.baseline.stable.length, unstable: lc.baseline.unstable };
    });
    report.status = 'accepted';
  } catch (err) {
    if (err instanceof Refusal) {
      report.status = 'refused';
      const list = err.all ?? [{ code: err.code, detail: err.detail }];
      for (const r of list) {
        report.refusals.push({
          code: r.code,
          detail: r.detail,
          step: err.step,
          ...(r === list[0] && err.issues ? { issues: err.issues } : {}),
          ...(r.path ? { path: r.path } : {}),
          ...(r === list[0] && err.log ? { log: err.log } : r.log ? { log: r.log } : {}),
        });
      }
      files.clear();
    } else {
      report.status = 'error';
      report.error = { code: err instanceof BuilderError ? err.code : 'BUILDER_FAILED', detail: err instanceof BuilderError ? err.detail : String(err?.message ?? err), step: err?.step ?? null };
      files.clear();
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    // The local tag only: the pushed image is the listing's, and a runner's cache keeps its own references.
    if (docker && report.image?.tag) await docker.run(['image', 'rm', report.image.tag], { timeoutMs: 120000 });
  }
  report.devOnly = devOnly(config, report);
  return { status: report.status, files, report };
}
