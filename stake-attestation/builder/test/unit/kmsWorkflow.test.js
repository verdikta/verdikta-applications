// Node P14, acceptance 4 and 6: who can reach the key. These tests read the workflows and run the sign
// workflow's first step. What GitHub and AWS do with them is predicted from their documents, and only a
// real run can prove it: docs/builder-kms-signing.md says which is which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { findForbiddenWords } from '@verdikta/stake-attestation-shared';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const APP = path.join(REPO_ROOT, 'stake-attestation');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const SIGN_FILE = path.join(WORKFLOWS, 'stake-attestation-builder-sign.yml');
const signText = fs.readFileSync(SIGN_FILE, 'utf8');
const signWf = parse(signText);
const mainText = fs.readFileSync(path.join(WORKFLOWS, 'stake-attestation-builder.yml'), 'utf8');
const mainWf = parse(mainText);
const ciText = fs.readFileSync(path.join(WORKFLOWS, 'stake-attestation.yml'), 'utf8');
const SELF = 'verdikta/verdikta-applications';
const job = signWf.jobs.sign;
const DOC = fs.readFileSync(path.join(APP, 'docs', 'builder-kms-signing.md'), 'utf8');
const ENVIRONMENT = 'stake-attestation-signing';

test('production signing has a workflow of its own: one job, called only by a caller, with the one identity it needs', () => {
  assert.deepEqual(Object.keys(signWf.on), ['workflow_call']);
  assert.deepEqual(signWf.permissions, {});
  assert.deepEqual(Object.keys(signWf.jobs), ['sign']);
  assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(job.environment, ENVIRONMENT, 'a fixed name: the trust policy names it, and no input can change it');
  assert.equal(job['runs-on'], 'ubuntu-24.04', 'GitHub-hosted: a fresh machine for this job alone');
  for (const f of fs.readdirSync(WORKFLOWS)) {
    if (f === path.basename(SIGN_FILE)) continue;
    assert.doesNotMatch(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8'), /uses:\s*['"]?\S*stake-attestation-builder-sign\.yml/, `${f} calls the signing workflow`);
  }
});

test('the workflow a maker calls can\'t mint a cloud identity at all, reads no secret, and doesn\'t sign in production', () => {
  assert.doesNotMatch(JSON.stringify(mainWf.jobs), /id-token/);
  assert.doesNotMatch(mainText, /id-token:\s*write/);
  assert.doesNotMatch(mainText, /secrets\./);
  assert.equal(mainWf.on.workflow_call.secrets, undefined);
  assert.equal(mainWf.on.workflow_call.inputs['signing-environment'], undefined);
  for (const [name, j] of Object.entries(mainWf.jobs)) {
    assert.equal(j.permissions?.['id-token'], undefined, name);
    assert.equal(j.environment, undefined, name);
  }
  assert.equal(mainWf.jobs.sign.if, "inputs.signing != 'production'");
  assert.deepEqual(mainWf.jobs.sign.permissions, { contents: 'read' });
  // The next job of a production caller gets what it needs to check the build's outputs.
  assert.equal(mainWf.on.workflow_call.outputs['artifact-id'].value, '${{ jobs.build.outputs.artifact-id }}');
  // Empty unless the build ran under production's checks (the publish target, the trusted key), and the signing
  // workflow's first step refuses an empty digest: a listing built as dev can't be handed on to be signed.
  assert.equal(mainWf.on.workflow_call.outputs['outputs-sha256'].value, "${{ inputs.signing == 'production' && jobs.build.outputs.outputs-sha256 || '' }}");
});

test('no other job in any workflow here asks for a cloud identity, and CI has no way to reach the key', () => {
  for (const f of fs.readdirSync(WORKFLOWS)) {
    if (f === path.basename(SIGN_FILE)) continue;
    assert.doesNotMatch(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8'), /id-token:\s*write/, f);
  }
  for (const word of [/VERDIKTA_KMS/, /kms-sign/, /kms-live-check/, /VERDIKTA_KMS_LIVE_CHECK/, /aws-actions/, /\baws kms\b/]) assert.doesNotMatch(ciText, word);
});

test('no long-lived cloud credential and no PEM anywhere: no key pair, no third-party action holding one', () => {
  for (const text of [signText, mainText, ciText]) {
    assert.doesNotMatch(text, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/);
    assert.doesNotMatch(text, /VERDIKTA_BUILDER_KEY/);
    assert.doesNotMatch(text, /aws-actions\//);
  }
  const declared = Object.keys(signWf.on.workflow_call.secrets).sort();
  assert.deepEqual(declared, ['VERDIKTA_KMS_KEY_ARN', 'VERDIKTA_KMS_ROLE_ARN']);
  for (const k of declared) assert.equal(signWf.on.workflow_call.secrets[k].required, true, `${k}: a caller that doesn't pass it stops at startup`);
  assert.deepEqual([...new Set([...signText.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort(), declared);
});

test('the key\'s references reach the first step (to check they\'re there) and the sign step only', () => {
  const using = job.steps.filter((s) => JSON.stringify(s).includes('secrets.'));
  assert.deepEqual(using.map((s) => job.steps.indexOf(s)), [0, job.steps.findIndex((s) => /verdikta-build-env\.js" sign\b/.test(s.run ?? ''))]);
});

test('the job holds the builder only: every action pinned to a commit, no checkout of the caller, nothing lifecycle, inputs never in a script', () => {
  for (const s of job.steps) {
    if (s.uses) assert.match(s.uses, /^actions\/(checkout|setup-node|download-artifact|upload-artifact)@[0-9a-f]{40}$/, s.uses);
    if (s.run) assert.doesNotMatch(s.run, /\$\{\{/, s.name);
  }
  const checkouts = job.steps.filter((s) => String(s.uses ?? '').startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with.repository, SELF);
  assert.equal(checkouts[0].with.ref, '${{ inputs.builder-ref }}');
  assert.equal(checkouts[0].with['persist-credentials'], false);
  assert.ok(job.steps.some((s) => /npm ci --ignore-scripts/.test(s.run ?? '')));
  const setup = job.steps.find((s) => String(s.uses ?? '').startsWith('actions/setup-node@'));
  assert.equal(setup.with.cache, undefined, 'nothing restored from a cache');
  assert.doesNotMatch(signText, /actions\/cache/);
});

test('it signs what the build job reported, checked: production through the KMS config, and only a signed folder leaves', () => {
  const config = job.steps.find((s) => /services\.js" sign-config/.test(s.run ?? ''));
  assert.match(config.run, /--signing production/);
  const sign = job.steps.find((s) => /verdikta-build-env\.js" sign\b/.test(s.run ?? ''));
  assert.match(sign.run, /--expect-outputs "\$OUTPUTS_SHA256" --check-registry/);
  assert.equal(sign.env.OUTPUTS_SHA256, '${{ inputs.outputs-sha256 }}');
  assert.deepEqual(job.steps.filter((s) => String(s.uses ?? '').startsWith('actions/download-artifact@')).map((d) => d.with.name), ['${{ inputs.artifact-id }}-listing']);
  const upload = job.steps.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.equal(job.steps.at(-1), upload, 'the upload comes after the signature was verified');
  assert.equal(upload.if, undefined, 'and only when every step before it passed');
  assert.equal(upload.with['include-hidden-files'], true);
  assert.equal(signWf.on.workflow_call.outputs['signed-artifact'].value, '${{ jobs.sign.outputs.signed-artifact }}');
  assert.equal(job.outputs['signed-artifact'], "${{ format('{0}-listing-signed', inputs.artifact-id) }}");
});

// The first step, run: it stands before any checkout, so it is the code the trust policy's commit pins.

const COMMIT = 'a'.repeat(40);
const GUARD = job.steps[0];

function jwt(claims) {
  return `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`;
}

function runGuard({ env = {}, claims = { job_workflow_sha: COMMIT, job_workflow_ref: `${SELF}/.github/workflows/stake-attestation-builder-sign.yml@${COMMIT}`, sub: `repo:verdikta/site:environment:${ENVIRONMENT}` }, curl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-guard-'));
  fs.writeFileSync(path.join(dir, 'curl'), curl ?? `#!/bin/sh\nprintf '%s\\n' "$*" > "${dir}/curl-args"\nprintf '%s' '${JSON.stringify({ count: 1, value: jwt(claims) })}'\n`, { mode: 0o755 });
  const r = spawnSync('bash', ['-c', GUARD.run], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      BUILDER_REF: COMMIT,
      OUTPUTS_SHA256: 'd'.repeat(64),
      EVENT_NAME: 'workflow_dispatch',
      VERDIKTA_KMS_KEY_ARN: 'set',
      VERDIKTA_KMS_ROLE_ARN: 'set',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.invalid/x?api-version=2.0',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'stub-request-token',
      ...env,
    },
  });
  const args = fs.existsSync(path.join(dir, 'curl-args')) ? fs.readFileSync(path.join(dir, 'curl-args'), 'utf8') : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...r, args };
}

test('the first step stands before any checkout and has no condition: nothing can route round it', () => {
  assert.equal(job.steps.findIndex((s) => s === GUARD), 0);
  assert.equal(GUARD.if, undefined);
  assert.equal(GUARD.uses, undefined);
  assert.ok(job.steps.findIndex((s) => String(s.uses ?? '').startsWith('actions/checkout@')) > 0);
  assert.equal(GUARD.env.BUILDER_REF, '${{ inputs.builder-ref }}');
  assert.equal(GUARD.env.EVENT_NAME, '${{ github.event_name }}');
});

test('with a real caller\'s run, the first step passes and shows the identity the trust policy matches, and never the token', () => {
  const r = runGuard();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /job_workflow_ref=verdikta\/verdikta-applications\/\.github\/workflows\/stake-attestation-builder-sign\.yml@a{40}/);
  assert.match(r.stdout, /sub=repo:verdikta\/site:environment:stake-attestation-signing/);
  assert.ok(!r.stdout.includes('eyJhbGci') && !r.stderr.includes('eyJhbGci'), 'the token is not shown');
  assert.ok(!r.stdout.includes('stub-request-token'));
  // A token for a look at its own claims: AWS would not take it (the audience it trusts is sts.amazonaws.com).
  assert.match(r.args, /audience=verdikta-builder-self-check/);
  assert.doesNotMatch(r.args, /sts\.amazonaws\.com/);
});

test('builder-ref must be this workflow\'s own commit: the trust policy\'s commit pin would otherwise bind only the YAML', () => {
  const r = runGuard({ env: { BUILDER_REF: 'b'.repeat(40) } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /builder-ref/);
  for (const claims of [{}, { job_workflow_sha: '' }, { job_workflow_sha: null }]) {
    assert.equal(runGuard({ claims }).status, 1, 'no claim is a refusal, not a pass');
  }
});

test('a fork\'s pull request, or a caller that didn\'t grant id-token: write, has no token to read: refused with the reason', () => {
  for (const missing of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) {
    const r = runGuard({ env: { [missing]: '' } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /id-token: write/);
  }
});

test('a pull-request or other outside trigger is refused, whatever the environment lets through', () => {
  for (const event of ['pull_request', 'pull_request_target', 'pull_request_review', 'issue_comment', 'workflow_run', 'push', 'schedule', 'merge_group', 'discussion', '']) {
    const r = runGuard({ env: { EVENT_NAME: event } });
    assert.equal(r.status, 1, event);
    assert.match(r.stdout, /workflow_dispatch/);
  }
  assert.equal(runGuard({ env: { EVENT_NAME: 'workflow_dispatch' } }).status, 0);
  assert.equal(runGuard({ env: { EVENT_NAME: 'repository_dispatch' } }).status, 1, 'the caller has one trigger');
});

test('a listing built without production\'s checks hands on no digest, and nothing is signed without one', () => {
  for (const digest of ['', 'not-a-digest', 'D'.repeat(64), 'd'.repeat(63)]) {
    const r = runGuard({ env: { OUTPUTS_SHA256: digest } });
    assert.equal(r.status, 1, digest);
    assert.match(r.stdout, /outputs-sha256/);
  }
  assert.equal(GUARD.env.OUTPUTS_SHA256, '${{ inputs.outputs-sha256 }}');
});

test('a maker\'s caller doesn\'t hold the references: refused here, before the AWS trust policy would refuse it', () => {
  for (const name of ['VERDIKTA_KMS_KEY_ARN', 'VERDIKTA_KMS_ROLE_ARN']) {
    const r = runGuard({ env: { [name]: '' } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(name));
  }
});

test('a token endpoint that fails or answers nonsense is a refusal', () => {
  for (const curl of ['#!/bin/sh\nexit 22\n', '#!/bin/sh\nprintf "{}"\n', '#!/bin/sh\nprintf "{\\"value\\":\\"no-dots\\"}"\n']) {
    assert.notEqual(runGuard({ curl }).status, 0, curl);
  }
});

test('the signing workflow is linted and scanned in CI, and CI runs on a change to it', () => {
  const ci = parse(ciText);
  assert.ok(ci.on.pull_request.paths.includes('.github/workflows/stake-attestation-builder-sign.yml'));
  const all = Object.values(ci.jobs).flatMap((j) => j.steps).filter((s) => s.run).map((s) => s.run).join('\n');
  assert.match(all, /actionlint"? [^\n]*\.github\/workflows\/stake-attestation-builder-sign\.yml/);
  assert.match(all, /check-forbidden-words\.js[^\n]*\.github\/workflows\/stake-attestation-builder-sign\.yml/);
});

// Acceptance 6 and the review focus: what this public repository says about the cloud.

test('no account id, ARN or region of ours in this public repository: the workflows, the action and the docs use placeholders', () => {
  const files = [
    SIGN_FILE,
    path.join(WORKFLOWS, 'stake-attestation-builder.yml'),
    path.join(WORKFLOWS, 'stake-attestation.yml'),
    path.join(APP, 'docs', 'builder-kms-signing.md'),
    path.join(APP, 'README.md'),
    ...fs.readdirSync(path.join(APP, 'builder', 'action')).map((f) => path.join(APP, 'builder', 'action', f)),
  ];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /\b[0-9]{12}\b/, `${f}: a 12-digit number`);
    assert.doesNotMatch(text, /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:[0-9]+:/, `${f}: a filled-in ARN`);
    assert.doesNotMatch(text, /\b(?:us|eu|ap|sa|ca|me|af)-(?:east|west|north|south|central|northeast|southeast)-[0-9]\b/, `${f}: a region`);
  }
});

test('the docs state the owner\'s step: the principal, its trust conditions, kms:Sign on this key alone, the environment, and the live check', () => {
  assert.deepEqual(findForbiddenWords(DOC), []);
  for (const needle of [
    'sts:AssumeRoleWithWebIdentity',
    'token.actions.githubusercontent.com:aud',
    'token.actions.githubusercontent.com:sub',
    'token.actions.githubusercontent.com:job_workflow_ref',
    'token.actions.githubusercontent.com:repository_id',
    'token.actions.githubusercontent.com:ref',
    'stake-attestation-builder-sign.yml@',
    `repo:verdikta/<caller>:environment:${ENVIRONMENT}`,
    `repo:verdikta@<owner-id>/<caller>@<repository-id>:environment:${ENVIRONMENT}`,
    'token.actions.githubusercontent.com:environment',
    'kms:Sign',
    'kms:SigningAlgorithm',
    'kms:MessageType',
    'ED25519_SHA_512',
    'VERDIKTA_KMS_KEY_ARN',
    'VERDIKTA_KMS_ROLE_ARN',
    'VERDIKTA_KMS_LIVE_CHECK=1',
    'id-token: write',
    'required reviewers',
  ]) assert.ok(DOC.includes(needle), needle);
  assert.match(DOC, /nothing else/i);
  assert.match(DOC, /Predicted|predicted/);
  assert.match(fs.readFileSync(path.join(APP, 'README.md'), 'utf8'), /docs\/builder-kms-signing\.md/);
});
