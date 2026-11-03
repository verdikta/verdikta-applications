// What `sign` checks before it signs a build's outputs, without re-running the build (design §20
// decision 3: signing in a separate job from the one that ran the maker's setup). That job
// receives only the build's output folder, so it checks:
//
//   before these           the project's proof, read again (src/listingProof.js recheckForSigning):
//                          nothing is signed for a listing without it
//   always                 the report accepted the listing; the files are the bytes it accepted;
//                          code_review.json, the baseline and known_issues.json validate; the report
//                          is about this listing, has every step of a build in order, and names the
//                          image, sizes and base code_review.json names, inside the class limits
//   --expect-outputs <h>   the folder is byte for byte the one the build job digested (outputsDigest)
//   --check-registry       the image code_review.json names is readable from its registry without a
//                          credential (as arbiters pull it), is the manifest and size the build
//                          measured, declares no volume, is built FROM the pinned base (its layers
//                          begin with the base's) and carries the listed commit's label
//
// and records what it still trusts, because only a re-run could check it: the code-runner's answer
// (baseline, timings, limits, harness proof), the verified-source comparison, the unpacked-size
// measurement, and that the build job ran this builder unmodified.
import crypto from 'node:crypto';

import { codeReview } from './common.js';
import { BuilderError } from './errors.js';
import { outputsDigest } from './outputs.js';
import { createRegistryClient } from './registry.js';
import { readJsonFile } from './spec.js';

const CLASS = codeReview.CLASS_HARD_LIMITS;
const PIN = codeReview.BASE_IMAGE_PINS.foundry;
const STEPS = Object.freeze(['spec', 'control', 'fetch', 'build', 'size', 'push', 'registry', 'verifiedSource', 'listingCheck', 'finalSpec']);
const IMAGE_REF = /^(.+)@(sha256:[0-9a-f]{64})$/;

const TRUSTS = Object.freeze({
  LISTING_CHECK_RESULTS: 'baseline.json, the timings, the default limits and the harness proof are the code-runner\'s answer as the build job recorded it, from the runner, runtime and platform the report names; repeating the check needs the image and a runner',
  DEPLOYMENT_ROLE: 'that the signer named in the report is the deployment\'s owner or deployer was read from the chain in the build job; its signature is checked again here unless the signer is a contract',
  VERIFIED_SOURCE: 'the comparison of the explorer\'s verified source and deployed code with the build at baseCommit ran in the build job; only its recorded result is seen here',
  UNPACKED_SIZE: 'env.unpackedBytes is the build\'s and the runner\'s measurement of the unpacked image; measuring it again needs the image unpacked',
  BUILD_JOB: 'the build job ran this builder unmodified, at the pinned ref, on a runner nothing else used; a maker\'s own CI is the maker\'s to vouch for, so a production key signs only in Verdikta\'s own workflow',
  OUTPUTS_IN_TRANSIT: 'the folder is the one the build job wrote: no --expect-outputs digest was given to compare it with',
  IMAGE_PUBLISHED: 'the image code_review.json names is published and readable by arbiters: --check-registry was not given',
});

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function refuse(code, detail) {
  throw new BuilderError(code, detail, { step: 'sign' });
}

/**
 * @param {object} o
 * @param {{ codeReview: Buffer, baseline: Buffer, knownIssues: Buffer|null }} o.files - readOutputs().files
 * @param {object} o.report - its validation report
 * @param {string} o.dir - the output folder (for --expect-outputs)
 * @param {string|null} [o.expectOutputs] - the build job's outputsDigest
 * @param {boolean} [o.checkRegistry]
 * @param {(repository: string) => { imageInfo(digest: string, platform: string): Promise<object> }} [o.registryFor]
 * @returns {Promise<{ checks: string[], trusts: { code: string, detail: string }[] }>}
 * @throws {BuilderError} the first check that fails, by its code; nothing is signed
 */
export async function verifyForSigning({ files, report, dir, expectOutputs = null, checkRegistry = false, registryFor = (repository) => createRegistryClient({ repository }) }) {
  const checks = [];
  const pass = (c) => checks.push(c);

  if (!report || report.status !== 'accepted') refuse('SIGNING_NOT_ACCEPTED', `the validation report's status is ${report?.status ?? 'missing'}: only an accepted listing is attested`);
  pass('REPORT_ACCEPTED');

  let spec;
  try {
    spec = JSON.parse(Buffer.from(files.codeReview).toString('utf8'));
  } catch {
    refuse('SIGNING_REPORT_MISMATCH', 'code_review.json is not JSON');
  }
  const names = { codeReview: 'code_review.json', baseline: spec.baseline, knownIssues: spec.stake?.knownIssues ?? null };
  for (const [role, name] of Object.entries(names)) {
    const actual = files[role] ? sha256(files[role]) : null;
    const expected = name ? report.files?.[name] ?? null : null;
    if (expected !== actual) refuse('SIGNING_REPORT_MISMATCH', `${name || role} is not the file the validation accepted`);
  }
  pass('FILES_MATCH_REPORT');

  const sv = codeReview.validateCodeReviewSpec(spec);
  if (!sv.ok) refuse('SPEC_INVALID', `code_review.json does not validate: ${sv.issues.map((i) => i.code).join(', ')}`);
  pass('SPEC_VALID');
  let baseline;
  try {
    baseline = JSON.parse(Buffer.from(files.baseline).toString('utf8'));
  } catch {
    refuse('BASELINE_INVALID', `${spec.baseline} is not JSON`);
  }
  const bv = codeReview.validateBaseline(baseline, spec);
  if (!bv.ok) refuse('BASELINE_INVALID', `${spec.baseline} does not validate: ${bv.issues.map((i) => i.code).join(', ')}`);
  pass('BASELINE_VALID');
  if (files.knownIssues) {
    let list;
    try {
      list = readJsonFile(files.knownIssues);
    } catch {
      refuse('KNOWN_ISSUES_INVALID', `${names.knownIssues} is not JSON in UTF-8`);
    }
    if (!codeReview.validateKnownIssues(list).ok) refuse('KNOWN_ISSUES_INVALID', `${names.knownIssues} does not validate`);
    pass('KNOWN_ISSUES_VALID');
  }

  const l = report.listing ?? {};
  const kind = spec.artifact?.kind ?? 'repo';
  const sameArtifact = (a) => (a?.kind ?? 'repo') === kind
    && (kind !== 'contract' || (a.chainId === spec.artifact.chainId && String(a.address).toLowerCase() === String(spec.artifact.address).toLowerCase()));
  if (l.repo !== spec.repo || l.baseCommit !== spec.baseCommit || !sameArtifact(l.artifact)) {
    refuse('LISTING_MISMATCH', 'the validation report is about another repository, commit or artifact than code_review.json');
  }
  // A contract's verified source must have been read for this deployment.
  if (kind === 'contract' && !sameArtifact({ kind, ...report.verifiedSource?.explorer })) {
    refuse('LISTING_MISMATCH', `the report's verified source is for ${report.verifiedSource?.explorer?.address ?? 'no address'} on chain ${report.verifiedSource?.explorer?.chainId ?? 'none'}, not the listed deployment`);
  }
  pass('LISTING_MATCHES_REPORT');

  const steps = Array.isArray(report.steps) ? report.steps : [];
  const contract = kind === 'contract';
  const ran = steps.map((s) => s?.name);
  if (ran.join(',') !== STEPS.join(',')) refuse('STEPS_INCOMPLETE', `the report's steps are ${ran.join(', ') || 'none'}, not a whole build (${STEPS.join(', ')})`);
  for (const s of steps) {
    const want = s.name === 'verifiedSource' && !contract ? 'skipped' : 'ok';
    if (s.status !== want) refuse('STEPS_INCOMPLETE', `the report's ${s.name} step is ${s.status}, not ${want}`);
  }
  if (report.listingCheck?.status !== 'accepted') refuse('STEPS_INCOMPLETE', 'the report does not record an accepted listing check');
  if (contract && report.verifiedSource?.status !== 'match') refuse('STEPS_INCOMPLETE', 'the report does not record a verified-source match for this contract listing');
  pass('STEPS_COMPLETE');

  const img = report.image ?? {};
  const m = IMAGE_REF.exec(String(spec.env?.image ?? ''));
  if (!m || img.ref !== spec.env.image || img.digest !== m[2] || spec.env.platform !== CLASS.platform || img.platform !== CLASS.platform) {
    refuse('IMAGE_NOT_THE_REPORTS', `code_review.json names ${spec.env?.image} (${spec.env?.platform}); the report validated ${img.ref} (${img.platform})`);
  }
  pass('IMAGE_MATCHES_REPORT');

  const u = img.unpackedBytes ?? {};
  const measured = [u.builder, u.runner];
  if (!measured.every((n) => Number.isSafeInteger(n) && n > 0) || u.attested !== Math.max(...measured) || spec.env.unpackedBytes !== u.attested
    || u.attested > CLASS.imageUnpackedBytes || !Number.isSafeInteger(img.compressedBytes) || img.compressedBytes < 1 || img.compressedBytes > CLASS.imageCompressedBytes) {
    refuse('SIZE_MISMATCH', 'the image sizes in the report and code_review.json disagree, or exceed the class limits');
  }
  pass('SIZES_WITHIN_LIMITS');

  if (spec.env.from !== 'foundry' || ![PIN.reference, `${PIN.repository}:${PIN.version}@${PIN.indexDigest}`].includes(img.base)) {
    refuse('BASE_NOT_PINNED', `the report's base image ${img.base} is not the foundry base pinned in @verdikta/common`);
  }
  pass('BASE_PINNED');

  if (expectOutputs !== null) {
    const got = outputsDigest(dir);
    if (got !== expectOutputs) refuse('OUTPUTS_CHANGED', `the folder's digest is ${got}, not the ${expectOutputs} the build job published: it changed after the build`);
    pass('OUTPUTS_MATCH_BUILD');
  }

  if (checkRegistry) {
    const [, repository, digest] = m;
    let info;
    try {
      info = await registryFor(repository).imageInfo(digest, CLASS.platform);
    } catch (err) {
      refuse('IMAGE_NOT_PUBLISHED', `${spec.env.image} cannot be read from its registry without a credential, as arbiters pull it: ${err?.code ?? ''} ${err?.detail ?? err?.message ?? ''}`.trim());
    }
    pass('IMAGE_PUBLISHED');
    if (info.manifestDigest !== img.manifestDigest || info.compressedBytes !== img.compressedBytes || info.volumes.length > 0) {
      refuse('IMAGE_DIFFERS_FROM_REPORT', `the registry's ${CLASS.platform} manifest of ${spec.env.image} is not the one the build measured (manifest ${info.manifestDigest}, ${info.compressedBytes} bytes${info.volumes.length ? `, VOLUME ${info.volumes.join(', ')}` : ''})`);
    }
    pass('IMAGE_MATCHES_MEASUREMENTS');
    let base;
    try {
      base = await registryFor(PIN.repository).imageInfo(PIN.digest, CLASS.platform);
    } catch (err) {
      throw new BuilderError('REGISTRY_UNAVAILABLE', `the pinned base ${PIN.reference} cannot be read: ${err?.detail ?? err?.message ?? err}`, { step: 'sign' });
    }
    const prefix = base.diffIds;
    if (prefix.length === 0 || info.diffIds.length <= prefix.length || prefix.some((d, i) => info.diffIds[i] !== d)) {
      refuse('IMAGE_NOT_FROM_PINNED_BASE', `the layers of ${spec.env.image} do not begin with those of the pinned base ${PIN.reference}`);
    }
    pass('IMAGE_FROM_PINNED_BASE');
    if (info.labels?.['io.verdikta.listing.base-commit'] !== spec.baseCommit) {
      refuse('IMAGE_LABEL_MISMATCH', `${spec.env.image} is labelled with commit ${info.labels?.['io.verdikta.listing.base-commit'] ?? 'none'}, not ${spec.baseCommit}`);
    }
    pass('IMAGE_LABELLED_WITH_COMMIT');
  }

  const trusts = ['LISTING_CHECK_RESULTS', ...(contract ? ['VERIFIED_SOURCE', 'DEPLOYMENT_ROLE'] : []), 'UNPACKED_SIZE', 'BUILD_JOB',
    ...(expectOutputs === null ? ['OUTPUTS_IN_TRANSIT'] : []), ...(checkRegistry ? [] : ['IMAGE_PUBLISHED'])]
    .map((code) => ({ code, detail: TRUSTS[code] }));
  return { checks, trusts };
}
