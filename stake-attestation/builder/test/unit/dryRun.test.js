// The reusable builder workflow's build-only input and CI's dry run of that workflow on the seed listing (node
// P26). build-only keeps the image on the runner's loopback registry: it is read in the four places that would
// let it leave or be signed, and nowhere else, so without it the workflow is what it was. The dry run calls the
// workflow as Verdikta's caller does for a production listing, with build-only on, and its report job holds the
// build's validation report to every step ok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { checkDraft } from '../../src/spec.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const builderText = fs.readFileSync(path.join(WORKFLOWS, 'stake-attestation-builder.yml'), 'utf8');
const builder = parse(builderText);
const ci = parse(fs.readFileSync(path.join(WORKFLOWS, 'stake-attestation.yml'), 'utf8'));
const README = fs.readFileSync(path.join(REPO_ROOT, 'stake-attestation', 'README.md'), 'utf8');
const SEED_FILE = 'stake-attestation/builder/test/fixtures/seed-listing/code_review.json';
const SEED = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, SEED_FILE), 'utf8'));
const SEED_COMMIT = 'c5264e4b6ab5f088098d43ca4619fd74cf6148ab';
const MAKER = '0xC8658795Faa64Ac57230c07F15055f33bD06aBDB';
const IMAGE_REPOSITORY = 'ghcr.io/verdikta/stake-env';
const dryRun = ci.jobs['builder-dry-run'];
const due = ci.jobs['builder-dry-run-due'];
const report = ci.jobs['builder-dry-run-report'];

test('build-only: a boolean input, off by default, read where the image could leave or be signed and nowhere else', () => {
  const input = builder.on.workflow_call.inputs['build-only'];
  assert.deepEqual({ required: input.required, type: input.type, default: input.default }, { required: false, type: 'boolean', default: false });
  assert.equal(builder.jobs.publish.if, '${{ !inputs.build-only }}');
  assert.equal(builder.jobs.sign.if, "inputs.signing != 'production' && !inputs.build-only");
  const upload = builder.jobs.build.steps.find((s) => s.name === 'Upload the image');
  assert.equal(upload.if, '${{ !inputs.build-only }}');
  assert.equal(builder.on.workflow_call.outputs['outputs-sha256'].value, "${{ inputs.signing == 'production' && !inputs.build-only && jobs.build.outputs.outputs-sha256 || '' }}");
  assert.equal(builderText.match(/inputs\.build-only/g).length, 4, 'those four, and no other step or job reads it');
  // Everything the build job checks still runs with it on: no step of build is conditional on it but the upload.
  for (const s of builder.jobs.build.steps) if (s !== upload) assert.doesNotMatch(String(s.if ?? ''), /build-only/, s.name);
  assert.equal(builder.jobs.source.if, undefined);
  assert.equal(builder.jobs.build.if, undefined);
});

test('the seed\'s draft: verdikta-arbiter at the listed commit, with arbiter-operator/README.md\'s "Foundry" fields, and valid', () => {
  assert.equal(SEED.repo, 'https://github.com/verdikta/verdikta-arbiter');
  assert.equal(SEED.baseCommit, SEED_COMMIT);
  assert.equal(SEED.artifact, undefined, 'a repository listing');
  // The README's block at that commit, field for field.
  assert.deepEqual(SEED.env, { from: 'foundry' });
  assert.deepEqual(SEED.commands, {
    framework: 'forge',
    setup: 'forge build',
    build: 'forge build',
    test: 'forge test',
    testFiles: 'forge test --match-path $FILES',
    testIds: 'forge test --match-test $TEST_IDS',
  });
  assert.deepEqual(SEED.paths, {
    tests: ['arbiter-operator/foundry/test/**'],
    protected: ['foundry.toml', 'arbiter-operator/foundry/lib/**', 'arbiter-operator/foundry/test/base/**', '.github/**', '.verdikta/**'],
  });
  assert.deepEqual(SEED.stake.scope, { include: ['arbiter-operator/contracts/**'] });
  assert.deepEqual(checkDraft(SEED), { ok: true, issues: [], warnings: [] });
});

test('the dry run calls this repository\'s workflow file as a production caller would, with build-only on', () => {
  assert.equal(dryRun.uses, './.github/workflows/stake-attestation-builder.yml');
  assert.deepEqual(dryRun.with, {
    'builder-ref': '${{ github.workflow_sha }}',
    spec: SEED_FILE,
    maker: MAKER,
    'publish-repository': IMAGE_REPOSITORY,
    signing: 'production',
    runtime: 'runsc',
    'build-only': true,
  });
  assert.equal(dryRun.secrets, undefined);
  // What GitHub checks before anything runs: every called job's permissions, publish's included. No job that runs
  // holds packages: write (build has nothing, source reads), and nothing here gives a job an identity.
  assert.deepEqual(dryRun.permissions, { contents: 'read', packages: 'write' });
  assert.deepEqual(builder.jobs.build.permissions, {});
  assert.deepEqual(builder.jobs.source.permissions, { contents: 'read' });
  for (const [name, j] of Object.entries(ci.jobs)) {
    if (name === 'builder-dry-run') continue;
    assert.equal(j.permissions, undefined, `${name}: the workflow's contents: read`);
    assert.equal(j.uses, undefined, `${name} calls a workflow`);
  }
});

test('the dry run is due on the paths of what it runs, and always when dispatched', () => {
  assert.deepEqual([dryRun.needs].flat(), ['builder-dry-run-due']);
  assert.equal(dryRun.if, "needs.builder-dry-run-due.outputs.due == 'true'");
  const step = due.steps.find((s) => s.id === 'paths');
  assert.deepEqual(step.env.DRY_RUN_PATHS.trim().split('\n'), [
    '.github/workflows/stake-attestation.yml',
    '.github/workflows/stake-attestation-builder.yml',
    'stake-attestation/builder/action/',
    'stake-attestation/builder/src/',
    'stake-attestation/builder/package.json',
    'stake-attestation/builder/package-lock.json',
    'stake-attestation/builder/test/fixtures/seed-listing/',
  ]);
  for (const p of step.env.DRY_RUN_PATHS.trim().split('\n')) assert.ok(fs.existsSync(path.join(REPO_ROOT, p)), p);
  // The step itself, in a repository whose last commit changes `files`.
  const dueFor = (files, event = 'pull_request') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-due-'));
    try {
      const git = (...args) => {
        const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@verdikta.invalid', ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' } });
        assert.equal(r.status, 0, r.stderr);
      };
      git('init', '-q');
      fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), 'changed\n');
      }
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', 'change');
      const output = path.join(dir, 'github-output');
      const r = spawnSync('bash', ['-c', step.run], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: output, EVENT_NAME: event, DRY_RUN_PATHS: step.env.DRY_RUN_PATHS } });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return fs.readFileSync(output, 'utf8').trim();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  for (const f of ['stake-attestation/builder/src/pipeline.js', 'stake-attestation/builder/action/egress-rules.sh', 'stake-attestation/builder/action/pins.json', 'stake-attestation/builder/package-lock.json', '.github/workflows/stake-attestation-builder.yml', '.github/workflows/stake-attestation.yml', 'stake-attestation/builder/test/fixtures/seed-listing/code_review.json']) {
    assert.equal(dueFor([f]), 'due=true', f);
  }
  for (const f of ['stake-attestation/client/src/App.jsx', 'stake-attestation/builder/test/unit/cli.test.js', 'stake-attestation/builder/README.md', 'stake-attestation/server/src/index.js']) {
    assert.equal(dueFor([f]), 'due=false', f);
  }
  assert.equal(dueFor([], 'workflow_dispatch'), 'due=true', 'always when dispatched');
  const checkout = due.steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 2);
  assert.equal(checkout.with['persist-credentials'], false);
  // The app's CI runs on all of them: its trigger takes the whole app and both workflows.
  for (const p of ['stake-attestation/**', '.github/workflows/stake-attestation.yml', '.github/workflows/stake-attestation-builder.yml']) assert.ok(ci.on.pull_request.paths.includes(p), p);
});

/** The report job's check, run here with jq on a report the test writes. */
function runReportCheck(reportDoc, spec = { baseCommit: SEED_COMMIT, env: { image: `${IMAGE_REPOSITORY}@sha256:${'a'.repeat(64)}` } }) {
  const step = report.steps.find((s) => s.env?.BASE_COMMIT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-dryrun-'));
  try {
    fs.mkdirSync(path.join(dir, 'listing'));
    fs.writeFileSync(path.join(dir, 'listing', 'validation-report.json'), JSON.stringify(reportDoc));
    fs.writeFileSync(path.join(dir, 'listing', 'code_review.json'), JSON.stringify(spec));
    return spawnSync('bash', ['-c', step.run], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...step.env } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SOLC = { path: '/opt/verdikta/tools/share/svm/0.8.19/solc-0.8.19', release: '0.8.19' };
function acceptedReport(over = {}) {
  const steps = ['spec', 'control', 'fetch', 'build', 'size', 'push', 'registry', 'verifiedSource', 'listingCheck', 'finalSpec']
    .map((name) => (name === 'verifiedSource' ? { name, status: 'skipped', durationMs: 0, detail: 'not a contract listing' } : { name, status: 'ok', durationMs: 1000 }));
  return { status: 'accepted', steps, devOnly: [], listingCheck: { runner: { runtime: 'runsc' }, timings: { buildSeconds: 4 }, compilers: { checked: [SOLC] } }, ...over };
}

const jq = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0 ? false : 'no jq on this machine (GitHub\'s runners have it)';

test('the report job holds the build to every step ok, gVisor, the seed\'s commit, the production repository and the setup\'s solc', { skip: jq }, () => {
  assert.deepEqual([report.needs].flat(), ['builder-dry-run']);
  const download = report.steps.find((s) => String(s.uses ?? '').startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, '${{ needs.builder-dry-run.outputs.artifact-id }}-listing');
  assert.deepEqual(report.steps.find((s) => s.env?.BASE_COMMIT).env, { BASE_COMMIT: SEED_COMMIT, PUBLISH_REPOSITORY: IMAGE_REPOSITORY, SOLC: '0.8.19' });

  const ok = runReportCheck(acceptedReport());
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /listingCheck: ok, 1 s/);
  assert.match(ok.stdout, /the setup left solc 0\.8\.19 at \/opt\/verdikta\/tools\/share\/svm\/0\.8\.19\/solc-0\.8\.19/);

  const failing = (doc, pattern, spec) => {
    const r = runReportCheck(doc, spec);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, pattern);
  };
  const base = acceptedReport();
  failing({ ...base, status: 'refused' }, /::error::the listing is refused/);
  failing({ ...base, steps: base.steps.map((s) => (s.name === 'listingCheck' ? { ...s, status: 'failed' } : s)) }, /::error::step listingCheck is failed/);
  failing({ ...base, steps: base.steps.filter((s) => s.name !== 'listingCheck') }, /::error::no listingCheck step/);
  failing({ ...base, steps: base.steps.map((s) => (s.name === 'control' ? { ...s, status: 'skipped' } : s)) }, /::error::step control is skipped/);
  failing({ ...base, devOnly: [{ code: 'VALIDATED_WITHOUT_GVISOR' }] }, /fit for dev trust only: VALIDATED_WITHOUT_GVISOR/);
  failing({ ...base, listingCheck: { ...base.listingCheck, runner: { runtime: 'runc' } } }, /validated under runc/);
  failing({ ...base, listingCheck: { ...base.listingCheck, compilers: { checked: [] } } }, /no solc 0\.8\.19 from the setup/);
  failing(base, /code_review\.json lists 0{40}/, { baseCommit: '0'.repeat(40), env: { image: `${IMAGE_REPOSITORY}@sha256:${'a'.repeat(64)}` } });
  failing(base, /code_review\.json names 127\.0\.0\.1:5000\/stake-env@/, { baseCommit: SEED_COMMIT, env: { image: `127.0.0.1:5000/stake-env@sha256:${'a'.repeat(64)}` } });
});

test('the README states the egress rule and the input', () => {
  const section = README.slice(README.indexOf('### The reusable builder workflow'), README.indexOf('## The mock aggregator'));
  for (const needle of ['builder/action/egress-rules.sh', '169.254.169.254', '168.63.129.16', 'port 53', '`build-only`', 'builder-dry-run']) {
    assert.ok(section.includes(needle), needle);
  }
});
