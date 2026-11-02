// An accepted build's output folder, made by the real pipeline (src/pipeline.js) with doubles for
// docker, the registry and the code-runner, so `sign` sees exactly what `build` writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseConfig } from '../../src/config.js';
import { writeOutputs } from '../../src/outputs.js';
import { buildListing } from '../../src/pipeline.js';
import { fakeDocker } from './fakes.js';
import { acceptedListing, definitive, draftSpec } from './specs.js';

export const DIGEST = `sha256:${'2'.repeat(64)}`;
export const MANIFEST_DIGEST = `sha256:${'3'.repeat(64)}`;
export const REPOSITORY = 'ghcr.io/verdikta/stake-env';
export const IMAGE = `${REPOSITORY}@${DIGEST}`;
export const KNOWN_ISSUES = Buffer.from(`${JSON.stringify([{ id: `sha256:${'a'.repeat(64)}`, title: 'Rounding favours the vault on withdraw', class: 'LOW', paths: ['src/Vault.sol'], description: 'Withdrawals round down by at most one wei; accepted.' }], null, 2)}\n`);

/**
 * Runs buildListing on `draft` with doubles and returns its result.
 * @param {object} [o]
 * @param {object} [o.draft]
 * @param {Buffer|null} [o.knownIssues]
 * @param {object} [o.registry] - config.registry
 * @param {object} [o.runner] - the code-runner's `runner` block in its answer
 */
export async function acceptedBuild({ draft = draftSpec(), knownIssues = null, registry = { repository: REPOSITORY }, runner, compressedBytes = 300000000 } = {}) {
  const config = parseConfig({
    registry,
    runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' },
    signing: { key: 'dev' },
  }, { baseDir: '/tmp', env: { CODE_RUNNER_TOKEN: 'runner-token-0123456789abcdef0123456789' } });
  const runs = [];
  const deps = {
    docker: fakeDocker((args) => {
      if (args[0] === 'push') return { stdout: `digest: ${DIGEST} size: 1234\n` };
      if (args[0] === 'history') return { stdout: '700000000\n100000000\n' };
      return {};
    }),
    fetchListedCommit: async (req) => ({ gitDir: req.dir }),
    writeBuildContext: () => ({ dockerfile: 'FROM x' }),
    registry: { imageInfo: async (digest) => ({ digest, manifestDigest: MANIFEST_DIGEST, compressedBytes, platforms: ['linux/amd64'], config: { os: 'linux', architecture: 'amd64' }, volumes: [] }) },
    runner: {
      listingCheck: async (body) => {
        runs.push(body);
        const d = definitive(body.image, acceptedListing(draft.baseCommit), runner);
        return { status: d.status, json: d.body };
      },
    },
  };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-accepted-'));
  try {
    const out = await buildListing({ draft, knownIssues, config, deps, workDir });
    if (out.status !== 'accepted') throw new Error(`the doubled build was ${out.status}: ${JSON.stringify(out.report.refusals ?? out.report.error)}`);
    return { ...out, runs };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
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
