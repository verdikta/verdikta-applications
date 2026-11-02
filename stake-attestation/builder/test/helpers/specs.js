// Sample inputs: a maker's draft code_review.json and the code-runner's listing-check answers, in
// the shapes verdikta-arbiter code-runner/README.md ("POST /v1/listing-checks") documents.
import { codeReview } from '../../src/common.js';

export const BASE_COMMIT = '7f3a9c0d1e2b3a4c5d6e7f8091a2b3c4d5e6f708';
export const RECIPIENT = codeReview.generateDisclosureKeyPair().recipient;

/** A maker's draft: what they write before the builder fills env.image, unpackedBytes and limits. */
export function draftSpec(over = {}) {
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
      scope: { include: ['src/**'] },
      severityRubric: 'immunefi-v2.3',
      disclosureKey: RECIPIENT,
    },
    ...over,
  };
}

/** A contract listing's draft. */
export function contractDraft(over = {}) {
  return draftSpec({ artifact: { kind: 'contract', address: '0x5f2A00000000000000000000000000000000C0dE', chainId: 8453 }, ...over });
}

export const RUNNER = { version: '0.1.0', runtime: 'runsc', platform: 'linux/amd64' };
const ID = (fn) => `test/Vault.t.sol > VaultTest > ${fn}`;

export function acceptedListing(baseCommit = BASE_COMMIT, over = {}) {
  const tests = [
    { id: ID('test_deposit_credits()'), results: ['pass', 'pass', 'pass'] },
    { id: ID('test_owner_is_deployer()'), results: ['pass', 'pass', 'pass'] },
  ];
  return {
    status: 'accepted',
    refusals: [],
    warnings: [],
    image: { ref: null, unpackedBytes: 812000000 },
    checkout: { commit: 'f'.repeat(40), tree: 'e'.repeat(40), paths: 6, corrected: 0, correctedPaths: [] },
    timings: { prepareSeconds: 2.1, buildSeconds: 4.2, testSeconds: [1.5, 1.4, 1.6] },
    baseline: {
      version: 1, baseCommit, framework: 'forge', runs: 3, tests,
      stable: tests.map((t) => t.id), unstable: [],
      timings: { buildSeconds: 4.2, testSeconds: [1.5, 1.4, 1.6] },
    },
    limits: { cpus: 2, memoryMb: 4096, buildSeconds: 13, testSeconds: 5, runSeconds: 34, maxPatchBytes: 2000000 },
    suite: { tests: 2, stable: 2, unstable: 0, exitCodes: [0, 0, 0], harnessErrors: [[], [], []] },
    harness: {
      path: 'test/VerdiktaHarness.t.sol',
      probes: [
        { name: 'fails', variant: 'forge-std', verdict: 'not_run' },
        { name: 'fails', variant: 'plain', verdict: 'assertion' },
        { name: 'compileError', variant: null, verdict: 'no_junit' },
        { name: 'setUpError', variant: null, verdict: 'harness_error' },
      ],
    },
    leftoverProcesses: [],
    ...over,
  };
}

/** The 200 answer of a definitive listing check. */
export function definitive(image, listing, runner = RUNNER) {
  return {
    status: 200,
    body: {
      outcome: 'definitive', kind: 'listing-check', checkId: '3f2a9c',
      runner,
      limits: { cpus: 2, memoryMb: 4096, pids: 4096, buildSeconds: 90, testSeconds: 360, runSeconds: 720, platform: 'linux/amd64' },
      abstain: null,
      image: { ref: image, cache: 'pulled', durationMs: 2100 },
      listing: { ...listing, image: { ...listing.image, ref: image } },
      steps: [],
    },
  };
}

export function refusedListing(code, detail) {
  return acceptedListing(BASE_COMMIT, {
    status: 'refused', refusals: [{ code, detail }], baseline: null, limits: null, harness: null,
  });
}

export function abstained(cause = 'pull_failed') {
  return {
    status: 503,
    body: { outcome: 'abstain', kind: 'listing-check', checkId: '3f2a9d', runner: RUNNER, abstain: { cause, step: 'pull', detail: 'the registry did not answer' }, listing: null, steps: [] },
  };
}

export function requesterError(code = 'IMAGE_OBJECTS_MISSING') {
  return { status: 400, body: { outcome: 'requester_error', issues: [{ code, path: '/image', detail: 'the image lacks the listed commit\'s objects' }] } };
}
