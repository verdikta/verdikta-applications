// An accepted build's output folder, made by the real pipeline (src/pipeline.js) with doubles for
// docker, the registry and the code-runner, so `sign` sees exactly what `build` writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Wallet } from 'ethers';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { createExplorer } from '../../src/explorer.js';
import { writeOutputs } from '../../src/outputs.js';
import { buildListing } from '../../src/pipeline.js';
import { FIXTURES, fakeDocker, readFixture, recordedExplorer } from './fakes.js';
import { deploymentMessage } from '../../src/listingProof.js';
import { MAKER, deployment, provenAnswer, stake } from './proof.js';
import { acceptedListing, definitive, draftSpec } from './specs.js';

export const DIGEST = `sha256:${'2'.repeat(64)}`;
export const MANIFEST_DIGEST = `sha256:${'3'.repeat(64)}`;
export const REPOSITORY = 'ghcr.io/verdikta/stake-env';
export const IMAGE = `${REPOSITORY}@${DIGEST}`;
const ISSUE = { title: 'Rounding favours the vault on withdraw', class: 'LOW', paths: ['src/Vault.sol'], description: 'Withdrawals round down by at most one wei; accepted.' };
export const KNOWN_ISSUES = Buffer.from(`${JSON.stringify([{ id: codeReview.knownIssueId(ISSUE), ...ISSUE }], null, 2)}\n`);

/**
 * Runs buildListing on `draft` with doubles and returns its result, whatever it was.
 * @param {object} [o]
 * @param {object} [o.draft]
 * @param {Buffer|null} [o.knownIssues]
 * @param {object} [o.registry] - config.registry
 * @param {object} [o.runner] - the code-runner's `runner` block in its answer
 * @param {object|null} [o.baseline] - the baseline.json the code-runner answers with
 */
export async function doubledBuild({ draft = draftSpec(), knownIssues = null, registry = { repository: REPOSITORY }, runner, compressedBytes = 300000000, maker = MAKER, deploymentProof = null, chainFor, baseline = null } = {}) {
  const config = parseConfig({
    registry,
    runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' },
    explorers: { 8453: { apiUrl: 'https://explorer.test/api', apiKeyEnv: 'EXPLORER_KEY' } },
    signing: { key: 'dev' },
  }, { baseDir: '/tmp', env: { CODE_RUNNER_TOKEN: 'runner-token-0123456789abcdef0123456789', EXPLORER_KEY: 'EXPLORERKEY0123456789' } });
  // A contract listing's verified source: recorded explorer answers for the fixture vault, and its
  // build at the commit as the fixture's files and artifact.
  const rec = recordedExplorer({ getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault.json' });
  const runs = [];
  const fetches = [];
  // a contract listing's owner signs, on a chain double
  const owner = Wallet.createRandom();
  const contract = draft.artifact?.kind === 'contract';
  const signed = contract && !deploymentProof
    ? { signer: owner.address, signature: await owner.signMessage(deploymentMessage({ spec: draft, maker, stake })), stakeChainId: stake.chainId, stakeContract: stake.address }
    : deploymentProof;
  const deps = {
    checkRepositoryControl: provenAnswer(maker),
    chainFor: chainFor ?? (() => deployment({ owner: owner.address, chainId: draft.artifact?.chainId ?? 8453 })),
    docker: fakeDocker((args) => {
      if (args[0] === 'push') return { stdout: `digest: ${DIGEST} size: 1234\n` };
      if (args[0] === 'history') return { stdout: '700000000\n100000000\n' };
      return {};
    }),
    fetchListedCommit: async (req) => { fetches.push(req); return { gitDir: req.dir }; },
    writeBuildContext: () => ({ dockerfile: 'FROM x' }),
    registry: { imageInfo: async (digest) => ({ digest, manifestDigest: MANIFEST_DIGEST, compressedBytes, platforms: ['linux/amd64'], config: { os: 'linux', architecture: 'amd64' }, volumes: [] }) },
    explorerFor: (chainId, cfg) => createExplorer({ apiUrl: rec.apiUrl, apiKey: cfg.apiKey(), chainId, fetch: rec.fetch, timeoutMs: 5000 }),
    buildRepo: async (req) => ({
      files: new Map(req.paths.map((p) => [p, fs.readFileSync(path.join(FIXTURES, 'vault', p))])),
      config: readFixture('forge', 'config.json'),
      artifact: readFixture('forge', 'Vault.json'),
      build: { exitCode: 0, log: '' },
      skippedSubmodules: [],
      solc: { version: req.version, sha256: 'a'.repeat(64), platform: 'linux/amd64' },
    }),
    runner: {
      listingCheck: async (body) => {
        runs.push(body);
        const d = definitive(body.image, acceptedListing(draft.baseCommit, baseline ? { baseline } : {}), runner);
        return { status: d.status, json: d.body };
      },
    },
  };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-accepted-'));
  try {
    const out = await buildListing({ draft, knownIssues, maker, deploymentProof: signed, config, deps, workDir });
    return { ...out, runs, fetches };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** As doubledBuild, for a test that needs the build accepted. */
export async function acceptedBuild(opts = {}) {
  const out = await doubledBuild(opts);
  if (out.status !== 'accepted') throw new Error(`the doubled build was ${out.status}: ${JSON.stringify(out.report.refusals ?? out.report.error)}`);
  return out;
}

/** Writes an accepted build into `dir` (as `build` does) and returns its files' bytes. */
export async function writeAcceptedBuild(dir, opts = {}) {
  const draft = opts.draft ?? (opts.knownIssues ? draftSpec({ stake: { ...draftSpec().stake, knownIssues: 'known_issues.json' } }) : draftSpec());
  const result = await acceptedBuild({ ...opts, draft });
  writeOutputs(dir, result);
  return {
    report: result.report,
    cr: result.files.get('code_review.json'),
    bl: result.files.get('baseline.json'),
    ki: result.files.get('known_issues.json') ?? null,
  };
}
