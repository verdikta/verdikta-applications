// Acceptance 3: the listing is validated through the code-runner's listing-check mode
// (POST /v1/listing-checks, verdikta-arbiter node A2b), which returns baseline.json, the timings
// and the default limits; a refusal (too heavy, limits below the defaults, legacy assertions, ...)
// stops the listing. These tests use a runner double answering in the documented shapes; the
// Docker suite runs the real code-runner as a sidecar.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRunnerClient, interpretListingCheck } from '../../src/runner.js';
import { fakeRunner } from '../helpers/fakes.js';
import { BASE_COMMIT, abstained, acceptedListing, definitive, draftSpec, refusedListing, requesterError } from '../helpers/specs.js';

const TOKEN = 'runner-token-0123456789abcdef0123456789';
const IMAGE = `127.0.0.1:5000/env@sha256:${'c'.repeat(64)}`;

async function withRunner(answer, fn) {
  const srv = await fakeRunner({ token: TOKEN, answer });
  try {
    return await fn(srv, createRunnerClient({ url: srv.url, token: TOKEN, timeoutMs: 10000 }));
  } finally {
    await srv.close();
  }
}

test('the request is exactly { spec, image, deadline }, with the bearer token', async () => {
  await withRunner(() => definitive(IMAGE, acceptedListing()), async (srv, client) => {
    await client.listingCheck({ spec: { ...draftSpec(), env: { from: 'foundry', image: IMAGE, platform: 'linux/amd64' } }, image: IMAGE, deadline: 900000 });
    const [req] = srv.requests;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/listing-checks');
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(req.headers['content-type'], 'application/json');
    const body = JSON.parse(req.body);
    assert.deepEqual(Object.keys(body).sort(), ['deadline', 'image', 'spec']);
    assert.equal(body.spec.env.image, IMAGE);
  });
});

test('accepted: baseline.json, the timings, the measured size and the default limits come back', async () => {
  await withRunner(() => definitive(IMAGE, acceptedListing()), async (_srv, client) => {
    const r = interpretListingCheck(await client.listingCheck({ spec: draftSpec(), image: IMAGE, deadline: 900000 }), { spec: draftSpec(), image: IMAGE });
    assert.equal(r.outcome, 'accepted');
    assert.equal(r.baseline.baseCommit, BASE_COMMIT);
    assert.deepEqual(r.baseline.stable.length, 2);
    assert.deepEqual(r.timings, { prepareSeconds: 2.1, buildSeconds: 4.2, testSeconds: [1.5, 1.4, 1.6] });
    assert.deepEqual(r.limits, { cpus: 2, memoryMb: 4096, buildSeconds: 13, testSeconds: 5, runSeconds: 34, maxPatchBytes: 2000000 });
    assert.equal(r.unpackedBytes, 812000000);
    assert.deepEqual(r.runner, { version: '0.1.0', runtime: 'runsc', platform: 'linux/amd64' });
  });
});

for (const code of ['LISTING_TOO_HEAVY', 'LIMITS_BELOW_DEFAULTS', 'LEGACY_ASSERTIONS', 'BUILD_FAILED', 'HARNESS_ERROR_NOT_REPORTED']) {
  test(`refused ${code}: the listing stops with the runner's reason`, async () => {
    const answer = () => definitive(IMAGE, refusedListing(code, `${code} detail`));
    await withRunner(answer, async (_srv, client) => {
      const r = interpretListingCheck(await client.listingCheck({ spec: draftSpec(), image: IMAGE, deadline: 900000 }), { spec: draftSpec(), image: IMAGE });
      assert.equal(r.outcome, 'refused');
      assert.deepEqual(r.refusals, [{ code, detail: `${code} detail` }]);
      assert.equal(r.baseline, null);
    });
  });
}

test('an abstaining runner is an error to retry, never a refusal', async () => {
  await withRunner(() => abstained('pull_failed'), async (_srv, client) => {
    const r = interpretListingCheck(await client.listingCheck({ spec: draftSpec(), image: IMAGE, deadline: 900000 }), { spec: draftSpec(), image: IMAGE });
    assert.equal(r.outcome, 'abstained');
    assert.equal(r.abstain.cause, 'pull_failed');
  });
});

test('the runner\'s 400 (the image or spec is the requester\'s broken package) refuses with its issues', async () => {
  await withRunner(() => requesterError('IMAGE_LAUNCHER_WRITABLE'), async (_srv, client) => {
    const r = interpretListingCheck(await client.listingCheck({ spec: draftSpec(), image: IMAGE, deadline: 900000 }), { spec: draftSpec(), image: IMAGE });
    assert.equal(r.outcome, 'rejected');
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_LAUNCHER_WRITABLE']);
  });
});

test('an answer for another image, another commit, or a baseline common rejects is not trusted', () => {
  const asAnswer = (d) => ({ status: d.status, json: d.body });
  const ok = asAnswer(definitive(IMAGE, acceptedListing()));
  assert.equal(interpretListingCheck(ok, { spec: draftSpec(), image: IMAGE }).outcome, 'accepted');
  assert.throws(() => interpretListingCheck(ok, { spec: draftSpec(), image: IMAGE.replace('c', 'd') }), { code: 'RUNNER_ANSWER_INVALID' });
  assert.throws(() => interpretListingCheck(asAnswer(definitive(IMAGE, acceptedListing('e'.repeat(40)))), { spec: draftSpec(), image: IMAGE }), { code: 'RUNNER_ANSWER_INVALID' });
  const broken = asAnswer(definitive(IMAGE, acceptedListing()));
  broken.json.listing.baseline.stable = [];
  assert.throws(() => interpretListingCheck(broken, { spec: draftSpec(), image: IMAGE }), { code: 'RUNNER_ANSWER_INVALID' });
  assert.throws(() => interpretListingCheck({ status: 200, json: { outcome: 'definitive', kind: 'run' } }, { spec: draftSpec(), image: IMAGE }), { code: 'RUNNER_ANSWER_INVALID' });
});

test('a wrong token is a configuration error, and the token never appears in an error', async () => {
  const srv = await fakeRunner({ token: TOKEN, answer: () => definitive(IMAGE, acceptedListing()) });
  try {
    const client = createRunnerClient({ url: srv.url, token: 'wrong-token-wrong-token-wrong-token-00', timeoutMs: 5000 });
    const r = await client.listingCheck({ spec: draftSpec(), image: IMAGE, deadline: 900000 });
    const err = (() => { try { interpretListingCheck(r, { spec: draftSpec(), image: IMAGE }); return null; } catch (e) { return e; } })();
    assert.equal(err.code, 'RUNNER_UNAUTHORIZED');
    assert.ok(!JSON.stringify({ m: err.message, s: err.stack }).includes('wrong-token'));
  } finally {
    await srv.close();
  }
});

test('the bearer token travels in the clear only to loopback or a Unix socket; a remote runner needs https', () => {
  assert.throws(() => createRunnerClient({ url: 'http://10.0.0.5:8090', token: TOKEN }), /loopback/);
  assert.doesNotThrow(() => createRunnerClient({ url: 'https://runner.example.org', token: TOKEN }));
  assert.doesNotThrow(() => createRunnerClient({ socket: '/run/verdikta-code-runner/runner.sock', token: TOKEN }));
});
