// What the signing workflow leaves behind, for tests of the listing flow's workflow backend: the listing's
// files as a run's artifact (a ZIP as actions/upload-artifact writes them), signed with a key of the test's.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeSiteAuth } from '@verdikta/stake-attestation-shared/site-request';

import { codeReview } from '../../src/common.js';
import { loadConfig } from '../../src/config.js';
import { MAKER, draftSpec, fakeBuilder, knownIssues, serialize } from './fixtures.js';
import { zipDeflated } from './zipDeflate.js';

export const TOKEN = 'stub-actions-token-value';
export const SIGNED_ARTIFACT = 'site-listing-signed';
export const LISTING_ARTIFACT = 'site-listing';

/** The environment of a server on the workflow backend, against the stub. */
export function workflowEnv(stub, over = {}) {
  return {
    SA_ATTESTATION_TRUST: 'production',
    SA_CHAIN_ID: '84532',
    SA_PINNING: 'mock',
    SA_BUILD_BACKEND: 'workflow',
    SA_BUILD_WORKFLOW_REPO: stub.repo,
    SA_BUILD_WORKFLOW_TOKEN: TOKEN,
    SA_GITHUB_API_URL: stub.base,
    SA_BUILD_WORKFLOW_SITE: 'testnet',
    SA_BUILD_POLL_MS: '2',
    SA_BUILD_FIND_MS: '200',
    SA_BUILD_RUN_DEADLINE_MS: '5000',
    SA_BUILD_APPROVAL_DEADLINE_MS: '5000',
    SA_BUILD_SWEEP_MS: '3600000',
    SA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sa-wf-')),
    ...over,
  };
}

export const workflowConfig = (stub, over) => loadConfig(workflowEnv(stub, over));

/** A request as the service hands it to the backend. */
export function buildInput({ draft = draftSpec(), jobId = 'a'.repeat(32), maker = MAKER } = {}) {
  const issues = knownIssues();
  const signedBody = JSON.stringify({ spec: draft, knownIssues: issues, allowlist: [], maker });
  return {
    jobId,
    draft,
    maker,
    knownIssues: serialize(issues),
    deploymentProof: null,
    signedBody,
    auth: { nonce: 'b'.repeat(32), issuedAt: '2026-11-05T12:00:00Z', expiresAt: '2026-11-05T12:05:00Z', signature: `0x${'1'.repeat(130)}` },
  };
}

/** The bytes of a whole listing folder, as a ZIP; `edit` may change the entries first. */
export function zipOf(files, { descriptors = true } = {}) {
  return zipDeflated(Object.entries(files).map(([name, bytes]) => ({ name, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) })), { descriptors });
}

/**
 * The signed folder for `draft`: what stake-attestation-builder-sign.yml uploads.
 * @param {object} o
 * @param {'production'|'dev'} [o.trust]
 * @param {crypto.KeyObject} [o.privateKey] - the signing key (default: one no set trusts)
 */
export async function signedListing({ draft = draftSpec(), issues = serialize(knownIssues()), maker = MAKER, trust = 'production', privateKey = codeReview.createDevBuilderKey().privateKey, alterSpec = null } = {}) {
  const { report, files } = await fakeBuilder({ alterSpec }).build({ draft, knownIssues: issues, maker });
  const spec = JSON.parse(files.codeReview.toString('utf8'));
  const statement = codeReview.createAttestationStatement({
    files: { codeReview: files.codeReview, baseline: files.baseline, knownIssues: files.knownIssues ?? undefined },
    trust,
    tools: { runner: '0.1.0' },
  });
  const attestation = serialize(codeReview.signAttestation(statement, privateKey));
  report.attestation = { trust, keyId: 'x', issuedAt: statement.issuedAt, file: spec.attestation, sha256: crypto.createHash('sha256').update(attestation).digest('hex') };
  return {
    report,
    folder: {
      'code_review.json': files.codeReview,
      [spec.baseline]: files.baseline,
      ...(files.knownIssues ? { [spec.stake.knownIssues]: files.knownIssues } : {}),
      [spec.attestation]: attestation,
      'validation-report.json': serialize(report),
    },
  };
}

export const encodedAuth = (auth) => encodeSiteAuth(auth);
