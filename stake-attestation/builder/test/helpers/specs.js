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

const COMMAND_KEYS = Object.freeze(['build', 'test', 'testFiles', 'testIds']);
const SHAPED_LIKE_FORGE = (text) => /^forge (?:build|test)(?: [^;&|<>`$"()]*(?:\$\{?(?:FILES|TEST_IDS)\}?[^;&|<>`$"()]*)*)?$/.test(text);

/**
 * What a double of the runner says of a draft's commands, in the runner's words and order. This is not the
 * grammar: the builder holds no copy of it, and e2e/test/grammar.test.js asks the real one.
 * @param {object} spec
 * @param {{ refuses?: (text: string, key: string) => boolean }} [o]
 */
export function withGrammar(spec, { refuses = (text) => !SHAPED_LIKE_FORGE(text) } = {}) {
  const issues = [];
  for (const key of COMMAND_KEYS) {
    const text = spec.commands?.[key];
    const path = `/spec/commands/${key}`;
    if (typeof text !== 'string' || text === '') issues.push({ code: 'COMMAND_MISSING', path, detail: `the forge adapter needs commands.${key}` });
    else if (refuses(text, key)) issues.push({ code: 'COMMAND_NOT_ALLOWED', path, detail: `commands.${key}: ${JSON.stringify(text)} is not allowed` });
    else if (key === 'testFiles' && !text.includes('FILES')) issues.push({ code: 'COMMAND_PLACEHOLDER', path, detail: 'commands.testFiles must use --match-path $FILES' });
    else if (key === 'testIds' && !text.includes('TEST_IDS')) issues.push({ code: 'COMMAND_PLACEHOLDER', path, detail: 'commands.testIds must use --match-test $TEST_IDS' });
  }
  return issues;
}

/** A listing-check request that cannot start a run: its spec names another image than the one sent. */
export const cannotRun = (body) => body?.spec?.env?.image !== undefined && body.spec.env.image !== body.image;

/** The runner's 400 to such a request: the mismatch, always, and whatever else it found. */
export function commandCheckAnswer(body, opts) {
  const issues = [{ code: 'IMAGE_MISMATCH', path: '/spec/env/image', detail: 'code_review.json names another image than the one to check' }, ...withGrammar(body.spec, opts)];
  return { status: 400, json: { outcome: 'requester_error', issues } };
}

/**
 * A runner double for checkCommands alone.
 * @param {{ refuses?: Function, onBody?: (body: object) => void }} [o]
 */
export function runnerWithGrammar({ refuses, onBody = () => {} } = {}) {
  return {
    listingCheck: async (body) => {
      onBody(body);
      if (!cannotRun(body)) throw new Error('this double only answers the command check');
      return commandCheckAnswer(body, refuses ? { refuses } : undefined);
    },
  };
}

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
    compilers: { platform: 'linux/amd64', listAsOf: '2026-10-01', newest: '0.8.32', checked: [{ path: '/opt/verdikta/tools/share/svm/0.8.31/solc-0.8.31', release: '0.8.31' }] },
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
