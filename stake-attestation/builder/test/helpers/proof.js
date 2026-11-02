// A listing's build with doubles for everything but the listing proof (node P9): real git against a
// bare repository (test/helpers/proofRepo.js) through config.repoMirrors, or a stand-in answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getAddress } from 'ethers';

import { parseConfig } from '../../src/config.js';
import { BuilderError } from '../../src/errors.js';
import { buildListing } from '../../src/pipeline.js';
import { createExplorer } from '../../src/explorer.js';
import { FIXTURES, fakeDocker, readFixture, recordedExplorer } from './fakes.js';
import { acceptedListing, definitive, draftSpec } from './specs.js';
import { proofFile } from './proofRepo.js';

export const REPO = 'https://github.com/acme/vault';
export const MAKER = getAddress('0x5b38da6a701c568545dcfcb03fcb875f56beddc4');
export const stake = Object.freeze({ chainId: 84532, address: getAddress('0xe8a385e473ea710c5a88cc72681a16a26fe380e4') });
const DIGEST = `sha256:${'2'.repeat(64)}`;
const REPOSITORY = 'ghcr.io/verdikta/stake-env';
const IMAGE = `${REPOSITORY}@${DIGEST}`;

export const config = (over = {}) => ({
  registry: { repository: REPOSITORY },
  runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' },
  explorers: { 8453: { apiUrl: 'https://explorer.test/api' } },
  signing: { key: 'dev' },
  ...over,
});

/** The check's answer for a commit whose file names `maker`: the pipeline tests' stand-in for git. */
export const provenAnswer = (maker = MAKER) => async () => ({
  reachable: true,
  ref: 'refs/heads/main',
  file: { path: '.verdikta/stake-control.json', mode: '100644', blob: 'b'.repeat(40), size: 80, text: proofFile(maker), problem: null },
});

/**
 * The chain a deployment proof reads, as the explorer's adapter presents it. `owner` answers owner();
 * `deployer` is the sender of `creationTx`; `down` makes every read fail, as an explorer that is down.
 */
export function deployment({ owner = null, deployer = null, creationTx = null, address = null, code = '0x6001', chainId = 8453, down = false } = {}) {
  const read = (v) => {
    if (down) throw new BuilderError('EXPLORER_UNAVAILABLE', 'the explorer is down');
    return v;
  };
  return {
    send: async () => read(`0x${chainId.toString(16)}`),
    getBlockNumber: async () => read(100),
    getCode: async () => read(code),
    call: async () => read(owner ? `0x${'0'.repeat(24)}${owner.slice(2).toLowerCase()}` : `0x${'0'.repeat(64)}`),
    getTransaction: async (hash) => read(hash === creationTx ? { from: deployer } : null),
    getTransactionReceipt: async (hash) => read(hash === creationTx ? { status: 1, blockNumber: 50, contractAddress: address } : null),
  };
}

/**
 * Runs buildListing with doubles. The proof's repository half is real git over `h` unless
 * `checkRepositoryControl` replaces it. Returns the result with what ran.
 */
export async function attempt({ h, commit, draft, maker = MAKER, repoUrl = REPO, chain, deploymentProof = null, checkRepositoryControl }) {
  const spec = draft ?? draftSpec({ repo: repoUrl, baseCommit: commit });
  const calls = { fetch: [], docker: 0 };
  const rec = recordedExplorer({ getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault.json' });
  const inner = fakeDocker((args) => {
    if (args[0] === 'push') return { stdout: `digest: ${DIGEST} size: 1234\n` };
    if (args[0] === 'history') return { stdout: '700000000\n100000000\n' };
    return {};
  });
  const docker = { run: (...a) => { calls.docker += 1; return inner.run(...a); } };
  const cfg = parseConfig(config({ repoMirrors: { [spec.repo]: h.mirror } }), { baseDir: '/tmp', env: { CODE_RUNNER_TOKEN: 'runner-token-0123456789abcdef0123456789' } });
  const deps = {
    docker,
    fetchListedCommit: async (req) => { calls.fetch.push(req); return { gitDir: req.dir }; },
    writeBuildContext: () => ({ dockerfile: 'FROM x' }),
    registry: { imageInfo: async (digest) => ({ digest, manifestDigest: digest, compressedBytes: 300000000, platforms: ['linux/amd64'], config: { os: 'linux', architecture: 'amd64' }, volumes: [] }) },
    runner: { listingCheck: async () => { const d = definitive(IMAGE, acceptedListing(spec.baseCommit)); return { status: d.status, json: d.body }; } },
    explorerFor: (chainId, cfg) => createExplorer({ apiUrl: rec.apiUrl, apiKey: cfg.apiKey(), chainId, fetch: rec.fetch, timeoutMs: 5000 }),
    buildRepo: async (req) => ({
      files: new Map(req.paths.map((p) => [p, fs.readFileSync(path.join(FIXTURES, 'vault', p))])),
      config: readFixture('forge', 'config.json'),
      artifact: readFixture('forge', 'Vault.json'),
      build: { exitCode: 0, log: '' },
      skippedSubmodules: [],
      solc: { version: req.version, sha256: 'a'.repeat(64), platform: 'linux/amd64' },
    }),
    chainFor: () => chain,
    ...(checkRepositoryControl ? { checkRepositoryControl } : {}),
  };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-proof-'));
  try {
    const out = await buildListing({ draft: spec, knownIssues: null, maker, deploymentProof, config: cfg, deps, workDir });
    return { ...out, calls };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export { FIXTURES };
