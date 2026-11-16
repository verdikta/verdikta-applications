// Sample listing requests and a stand-in for the environment builder (node P3a), behind the
// interface the server's builder adapter exposes: build({ draft, knownIssues }) resolves to
// { status, report, files, devTrust }. The stand-in does what the builder's build and sign steps
// do to the files (fill env.image, env.platform, env.unpackedBytes and the limits; write the
// baseline; sign attestation.json over the exact bytes with a dev key) without Docker, a
// registry, an explorer or the code-runner. Every key is generated per run.
import crypto from 'node:crypto';

import { Wallet } from 'ethers';
import { LISTING_REQUEST_MAX_BYTES, listingRequestRefusal } from '@verdikta/stake-attestation-shared/listing-request-size';

import { codeReview } from '../../src/common.js';
import { loadConfig } from '../../src/config.js';

export const BASE_COMMIT = '7f3a9c0d1e2b3a4c5d6e7f8091a2b3c4d5e6f708';
export const IMAGE = `ghcr.io/verdikta/stake-env@sha256:${'4e1b2c3d'.repeat(8)}`;

/** The wallet a test's listing request names as its maker: made per run, and it signs the request. */
export const MAKER_WALLET = Wallet.createRandom();
export const MAKER = MAKER_WALLET.address;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const serialize = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** A fresh age key pair: `recipient` is what the maker lists, `identity` what they keep. */
export function disclosureKeyPair() {
  return codeReview.generateDisclosureKeyPair();
}

/** A deployment proof in the right shape: API tests answer for it with a stand-in (startApi's checkDeployment). */
export const TEST_DEPLOYMENT_PROOF = Object.freeze({ signer: '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4', signature: `0x${'11'.repeat(65)}` });

/** A maker's draft code_review.json for a repository listing. */
export function draftSpec({ disclosureKey = disclosureKeyPair().recipient, ...over } = {}) {
  return {
    version: 1,
    kind: 'bug',
    repo: 'https://github.com/acme/vault',
    baseCommit: BASE_COMMIT,
    env: { from: 'foundry' },
    attestation: 'attestation.json',
    commands: {
      framework: 'forge',
      setup: 'forge build',
      build: 'forge build',
      test: 'forge test',
      testFiles: 'forge test --match-path $FILES',
      testIds: 'forge test --match-test $TEST_IDS',
    },
    baseline: 'baseline.json',
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    stake: {
      awards: { LOW: '0', MEDIUM: '0.1 ETH', HIGH: '0.4 ETH', CRITICAL: '2 ETH' },
      lowestClassCounted: 'MEDIUM',
      bondWei: '20000000000000000',
      fixWindowDays: 14,
      scope: { include: ['src/**'], exclude: ['test/**'] },
      knownIssues: 'known_issues.json',
      severityRubric: 'immunefi-v2.3',
      disclosureKey,
      valueAtRiskUsd: 1250000,
    },
    ...over,
  };
}

/** A contract listing's draft: the repository plus a deployment, checked against verified source. */
export function contractDraft(over = {}) {
  return draftSpec({ artifact: { kind: 'contract', address: '0x5f2a00000000000000000000000000000000c0de', chainId: 8453 }, ...over });
}

/** known_issues.json entries, each with the id common derives from its body. */
export function knownIssues() {
  const bodies = [
    { title: 'Rounding favours the vault on withdraw', class: 'LOW', paths: ['src/Vault.sol'], description: 'Share-to-asset conversion on withdraw rounds down by up to one wei in the vault\'s favour; accepted.' },
    { title: 'Owner can pause deposits', class: 'MEDIUM', paths: ['src/Vault.sol'], description: 'The owner may pause deposits at any time; withdrawals stay open. Documented and accepted.' },
  ];
  return bodies.map((b) => ({ id: codeReview.knownIssueId(b), ...b }));
}

/** A listing request body: the draft, its known issues, an allowlist and the maker. */
export function listingRequest({ spec = draftSpec(), issues = knownIssues(), allowlist = [], maker = MAKER, deploymentProof } = {}) {
  const body = { spec, allowlist, maker };
  if (issues) body.knownIssues = issues;
  if (spec.artifact?.kind === 'contract' && deploymentProof === undefined) body.deploymentProof = TEST_DEPLOYMENT_PROOF;
  if (deploymentProof) body.deploymentProof = deploymentProof;
  return body;
}

function baselineFor(baseCommit) {
  const id = (fn) => `test/Vault.t.sol > VaultTest > ${fn}`;
  const tests = [
    { id: id('test_deposit_credits()'), results: ['pass', 'pass', 'pass'] },
    { id: id('test_owner_is_deployer()'), results: ['pass', 'pass', 'pass'] },
  ];
  return {
    version: 1, baseCommit, framework: 'forge', runs: 3, tests,
    stable: tests.map((t) => t.id), unstable: [],
    timings: { buildSeconds: 4.2, testSeconds: [1.5, 1.4, 1.6] },
  };
}

/** What the builder's size rule says of a listing one byte over the bound. */
export function tooLargeDetail() {
  const bound = LISTING_REQUEST_MAX_BYTES;
  return listingRequestRefusal({ spec: {}, attestation: {}, knownIssues: [], baseline: { pad: 'x'.repeat(bound + 1 - 6 - 10) } }, { codeReview }).detail;
}

const STEPS = ['spec', 'control', 'fetch', 'build', 'size', 'push', 'registry', 'verifiedSource', 'listingCheck', 'finalSpec'];

/** Whether a draft names documents (stake.documents, a list with an entry), as the builder and the runner read it. */
const namesDocuments = (draft) => Array.isArray(draft.stake?.documents) && draft.stake.documents.length > 0;

function reportFor(draft, statuses = {}, maker = MAKER, deploymentProof = null) {
  const contract = draft.artifact?.kind === 'contract';
  // node P20: the builder's documents step, right after the fetch, only when the draft names documents
  const steps = namesDocuments(draft) ? [...STEPS.slice(0, 3), 'documents', ...STEPS.slice(3)] : STEPS;
  return {
    version: 1,
    kind: 'verdikta-listing-validation',
    builder: { version: '0.1.0' },
    createdAt: '2026-11-02T00:00:00Z',
    status: 'pending',
    listing: { repo: draft.repo, baseCommit: draft.baseCommit, artifact: draft.artifact ?? { kind: 'repo' } },
    steps: steps.map((name) => ({
      name,
      status: statuses[name] ?? (name === 'verifiedSource' && !contract ? 'skipped' : 'ok'),
      durationMs: 1,
      ...(name === 'verifiedSource' && !contract ? { detail: 'not a contract listing' } : {}),
    })),
    control: { maker, repo: draft.repo, commit: draft.baseCommit, path: '.verdikta/stake-control.json', ref: 'refs/heads/main', blob: 'b'.repeat(40), deployment: contract ? { signer: deploymentProof?.signer ?? null, signature: deploymentProof?.signature ?? null, role: 'owner', contractSigner: false } : null },
    image: { ref: IMAGE, digest: IMAGE.split('@')[1], platform: 'linux/amd64', unpackedBytes: { builder: 812000000, runner: 812000000, attested: 812000000 } },
    verifiedSource: contract ? { status: 'match', issues: [], warnings: [] } : null,
    listingCheck: { status: 'accepted', runner: { version: '0.1.0', runtime: 'runsc', platform: 'linux/amd64' } },
    ...(namesDocuments(draft) ? {
      documents: { globs: [...draft.stake.documents], candidates: 4, read: [{ path: 'README.md', bytes: 120 }], pastCap: [], skipped: [], unmatched: [] },
    } : {}),
    baseline: null,
    limits: null,
    files: null,
    attestation: null,
    devOnly: [],
    refusals: [],
    warnings: [],
    error: null,
  };
}

/** The code_review.json the builder writes for `draft`. */
export function builtSpec(draft) {
  const out = structuredClone(draft);
  out.env = { image: IMAGE, from: draft.env.from, platform: 'linux/amd64', unpackedBytes: 812000000 };
  out.attestation = draft.attestation ?? 'attestation.json';
  out.baseline = draft.baseline ?? 'baseline.json';
  out.limits = { cpus: 2, memoryMb: 4096, buildSeconds: 13, testSeconds: 5, runSeconds: 34, maxPatchBytes: 2000000, ...(draft.limits ?? {}) };
  return out;
}

/**
 * The builder stand-in. `outcome`:
 *   'accepted'        build and sign succeed
 *   'refused-source'  the verified-source check refuses (a contract listing whose deployment is not the repo's code)
 *   'refused'         another refusal (listingCheck)
 *   'error'           the build could not be validated (an error to retry)
 * Two hooks stand in for a builder that misbehaves: `alterSpec(spec)` edits the built
 * code_review.json before it is written and signed (the attestation verifies over the edit), and
 * `tamper({ spec, report, files })` edits the accepted result after signing. `delayMs` holds the
 * build open (Infinity: until `release()`). `baseline`: the baseline.json the build writes and signs.
 *   'refused-too-large'  the builder's size rule refuses it (node P11)
 */
export function fakeBuilder({ outcome = 'accepted', alterSpec = null, tamper = null, delayMs = 0, baseline = null } = {}) {
  const key = codeReview.createDevBuilderKey();
  const calls = [];
  let release = null;
  const gate = delayMs === Infinity ? new Promise((r) => { release = r; }) : null;
  return {
    calls,
    key,
    devTrust: () => ({ dev: true, keys: [{ publicKey: key.publicKey }] }),
    release: () => release?.(),
    async build({ draft, knownIssues: knownIssuesBytes, maker = MAKER, deploymentProof = null }) {
      calls.push({ draft: structuredClone(draft), knownIssues: knownIssuesBytes ? Buffer.from(knownIssuesBytes) : null, maker, deploymentProof });
      if (gate) await gate;
      else if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (outcome === 'refused-source') {
        const report = reportFor(draft, { verifiedSource: 'failed', listingCheck: 'pending', finalSpec: 'pending' }, maker, deploymentProof);
        report.steps = report.steps.filter((s) => s.status !== 'pending');
        report.status = 'refused';
        report.verifiedSource = { status: 'mismatch', issues: [{ code: 'BYTECODE_MISMATCH', detail: 'the deployed runtime code is not the repository\'s build at baseCommit' }], warnings: [] };
        report.refusals.push({ code: 'BYTECODE_MISMATCH', detail: 'the deployed runtime code is not the repository\'s build at baseCommit', step: 'verifiedSource' });
        return { status: 'refused', report, files: null, devTrust: null };
      }
      if (outcome === 'refused') {
        const report = reportFor(draft, { listingCheck: 'failed', finalSpec: 'pending' }, maker, deploymentProof);
        report.steps = report.steps.filter((s) => s.status !== 'pending');
        report.status = 'refused';
        report.refusals.push({ code: 'LISTING_TOO_HEAVY', detail: 'the suite needs more than runSeconds', step: 'listingCheck' });
        return { status: 'refused', report, files: null, devTrust: null };
      }
      if (outcome === 'refused-too-large') {
        const report = reportFor(draft, { finalSpec: 'failed' }, maker, deploymentProof);
        report.status = 'refused';
        report.refusals.push({ code: 'LISTING_REQUEST_TOO_LARGE', detail: tooLargeDetail(), step: 'finalSpec' });
        return { status: 'refused', report, files: null, devTrust: null };
      }
      if (outcome === 'error') {
        const report = reportFor(draft, { listingCheck: 'failed', finalSpec: 'pending' }, maker, deploymentProof);
        report.steps = report.steps.filter((s) => s.status !== 'pending');
        report.status = 'error';
        report.error = { code: 'LISTING_CHECK_ABSTAINED', detail: 'the code-runner decided nothing (pull_failed at pull)', step: 'listingCheck' };
        return { status: 'error', report, files: null, devTrust: null };
      }
      const spec = builtSpec(draft);
      alterSpec?.(spec);
      const files = {
        codeReview: serialize(spec),
        baseline: serialize(baseline ?? baselineFor(spec.baseCommit)),
        knownIssues: knownIssuesBytes ? Buffer.from(knownIssuesBytes) : null,
        attestation: null,
      };
      const report = reportFor(draft, {}, maker, deploymentProof);
      report.status = 'accepted';
      report.files = { 'code_review.json': sha256(files.codeReview), [spec.baseline]: sha256(files.baseline) };
      if (files.knownIssues) report.files[spec.stake.knownIssues] = sha256(files.knownIssues);
      report.limits = spec.limits;
      const statement = codeReview.createAttestationStatement({
        files: { codeReview: files.codeReview, baseline: files.baseline, knownIssues: files.knownIssues ?? undefined },
        trust: 'dev',
        tools: { runner: '0.1.0' },
      });
      const attestation = codeReview.signAttestation(statement, key.privateKey);
      files.attestation = serialize(attestation);
      report.attestation = { trust: 'dev', keyId: attestation.signature.keyId, issuedAt: attestation.issuedAt, file: spec.attestation, sha256: sha256(files.attestation) };
      tamper?.({ spec, report, files });
      return { status: 'accepted', report, files, devTrust: { dev: true, keys: [{ publicKey: key.publicKey }] } };
    },
  };
}

/** The server config the tests run with: dev trust (the stand-in signs with a dev key), mock pinning. */
export function testConfig(env = {}) {
  return loadConfig({ SA_ATTESTATION_TRUST: 'dev', SA_CHAIN_ID: '31337', SA_PINNING: 'mock', ...env });
}
