// Node P11: the size rule's arithmetic, against the arbiter's real code at the pin. The builder and the
// server can't import verdikta-arbiter, so shared/src/listingRequestSize.js holds a copy of the request
// the External Adapter sends and the numbers it depends on. This fails when they drift: the real
// buildRunRequest, byte for byte; the real body limit; the real validators; the real postRun; and the
// real server, which takes a body at the limit and answers 413 one byte over.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

import { baselineOfBytes } from '../../shared/test/helpers/baselineOfBytes.js';
import {
  LISTING_REQUEST_MAX_BYTES,
  RUNNER_MAX_BODY_BYTES,
  RUNNER_MAX_DEADLINE_MS,
  claimSideBytes,
  listingRequestSize,
  requestBytes,
  runRequestBody,
  worstClaimContext,
} from '../../shared/src/listingRequestSize.js';
import { codeReview } from '../src/common.js';
import { arbiterCheckout, E2E_DIR } from '../src/setup.js';

const CLASSES = Object.keys(codeReview.CODE_CLASSES);
const options = { codeReview };
const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe('the size rule against verdikta-arbiter at the pin', () => {
  let A;
  let require;
  before(() => {
    const { dir } = arbiterCheckout(() => {}, process.env, { packages: ['external-adapter', 'code-runner'] });
    require = createRequire(path.join(dir, 'package.json'));
    A = (relative) => require(path.join(dir, relative));
    A.dir = dir;
  });

  const realSpec = () => A('code-runner/test/helpers/claimRun').forgeSpec();
  const listingOf = (spec, baseline) => ({ spec, attestation: A('code-runner/test/helpers/requests').attestationFor(spec), baseline, knownIssues: [] });
  const baseOf = () => A('code-runner/test/helpers/fakeClaim').BASE;
  /** A real listing that takes `bytes` of the request. */
  function listingOfBytes(bytes) {
    const spec = realSpec();
    const beside = listingRequestSize(listingOf(spec, {})).bytes - 2;
    return listingOf(spec, baselineOfBytes(bytes - beside, baseOf()));
  }

  test('the numbers pinned here are the arbiter\'s, on the same release of @verdikta/common', () => {
    assert.equal(A('code-runner/src/config').MAX_BODY_BYTES, RUNNER_MAX_BODY_BYTES);
    assert.equal(A('code-runner/src/request').MAX_DEADLINE_MS, RUNNER_MAX_DEADLINE_MS);
    const pin = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).dependencies['@verdikta/common'];
    const ours = pin(path.join(E2E_DIR, 'package.json'));
    assert.equal(pin(path.join(A.dir, 'external-adapter', 'package.json')), ours);
    assert.equal(pin(path.join(A.dir, 'code-runner', 'package.json')), ours);
    // the fields of the body: exactly what the runner takes, in this copy's order
    const body = runRequestBody(worstClaimContext({ spec: {}, attestation: {}, baseline: {}, knownIssues: [] }, { codeReview, codeClass: 'code-standard' }), 1, options);
    assert.deepEqual(Object.keys(body), [...A('code-runner/src/request').FIELDS]);
  });

  test('the request built here is the real buildRunRequest\'s, byte for byte', () => {
    const { buildRunRequest } = A('external-adapter/src/codeReview/runnerClient');
    const same = (context, deadline) => assert.equal(JSON.stringify(runRequestBody(context, deadline, options)), JSON.stringify(buildRunRequest(context, deadline)));
    const listing = { spec: { a: '\u0001' }, attestation: { b: 1 }, baseline: { c: [1] }, knownIssues: [{ d: '"' }] };
    for (const codeClass of CLASSES) same(worstClaimContext(listing, { codeReview, codeClass }), RUNNER_MAX_DEADLINE_MS);
    const small = worstClaimContext(listing, { codeReview, codeClass: 'code-standard' });
    // an empty fix.patch goes as absent, no fix.patch too
    same({ ...small, claim: { ...small.claim, fixPatch: Buffer.alloc(0) } }, 700000);
    same({ ...small, claim: { ...small.claim, fixPatch: null } }, 700000);
    // a cut never goes through a character
    const emoji = '\u{1F600}'.repeat(300000);
    same({
      ...small,
      claim: { ...small.claim, report: emoji },
      priorFindings: small.priorFindings.map((p) => ({ ...p, report: emoji })),
    }, 700000);
    same({ ...small, claim: { ...small.claim, report: `x${emoji}` }, priorFindings: [{ ...small.priorFindings[0], report: `x${emoji}` }] }, 700000);
    // no prior findings, no known issues
    same({ ...small, listing: { ...small.listing, knownIssues: [] }, priorFindings: [] }, 1);
  });

  test('the worst claim is real: the EA\'s rules allow it and the real runner\'s validation takes the request', () => {
    const { validateRunRequest, imageBindingIssues } = A('code-runner/src/request');
    const { checkClaim } = A('code-runner/src/claim');
    const { maxPatchBytes } = A('external-adapter/src/codeReview/frontGates');
    const listing = listingOfBytes(LISTING_REQUEST_MAX_BYTES);
    assert.equal(listingRequestSize(listing).bytes, LISTING_REQUEST_MAX_BYTES);
    assert.equal(maxPatchBytes({}), codeReview.SPEC_LIMIT_MAXIMA.maxPatchBytes);
    for (const codeClass of CLASSES) {
      const context = worstClaimContext(listing, { codeReview, codeClass });
      assert.deepEqual(codeReview.validateFinding(context.claim.finding, { ...listing.spec, stake: { ...listing.spec.stake, scope: { include: ['**'] } } }).issues, []);
      const text = JSON.stringify(A('external-adapter/src/codeReview/runnerClient').buildRunRequest(context, RUNNER_MAX_DEADLINE_MS));
      assert.ok(Buffer.byteLength(text) <= A('code-runner/src/config').MAX_BODY_BYTES, `${codeClass}: ${Buffer.byteLength(text)}`);
      const checked = validateRunRequest(JSON.parse(text));
      assert.deepEqual(checked.issues, []);
      assert.deepEqual(imageBindingIssues(checked.request.spec, checked.request.attestation), []);
      assert.deepEqual(checkClaim(checked.request), []);
    }
  });

  test('the real postRun puts on the wire exactly the bytes measured here', async () => {
    const { postRun } = A('external-adapter/src/codeReview/runnerClient');
    const { createDeadline } = A('external-adapter/src/codeReview/time');
    const context = worstClaimContext(listingOfBytes(LISTING_REQUEST_MAX_BYTES), { codeReview, codeClass: 'code-standard' });
    const body = runRequestBody(context, RUNNER_MAX_DEADLINE_MS, options);
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ type: req.headers['content-type'], length: Number(req.headers['content-length']), bytes: Buffer.concat(chunks) });
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ outcome: 'abstain', abstain: { cause: 'test', step: 'test' } }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const runner = { url: `http://127.0.0.1:${server.address().port}`, readToken: () => 't' };
      await assert.rejects(postRun(runner, body, { deadline: createDeadline({ receivedAt: Date.now(), deadlineMs: 60000 }) }), /CODE_REVIEW_RUNNER_ABSTAIN/);
    } finally {
      await new Promise((r) => server.close(r));
    }
    assert.equal(seen.length, 1);
    assert.match(seen[0].type, /^application\/json/);
    assert.equal(seen[0].length, requestBytes(body));
    assert.ok(seen[0].bytes.equals(Buffer.from(JSON.stringify(body), 'utf8')));
  });

  describe('the real server', () => {
    let server;
    let target;
    let post;
    before(async () => {
      const { createServer } = A('code-runner/src/server');
      const { testConfig, request, TOKEN } = A('code-runner/test/helpers/http');
      const { claimSandbox } = A('code-runner/test/helpers/fakeClaim');
      server = createServer({
        config: testConfig(), docker: claimSandbox().docker, log: silent,
        meminfo: async () => ({ availableMb: 100000, error: null }),
        statfs: async () => ({ bavail: 1e12, bsize: 1 }),
      });
      target = await server.listen();
      post = (text) => request(target, { method: 'POST', path: '/v1/runs', token: TOKEN, body: Buffer.from(text, 'utf8') });
    });
    after(async () => { await server?.close(); });

    /** The real request, for a listing that takes the whole of what the largest class leaves plus `extra`. */
    const atTheLimit = (extra) => {
      const room = RUNNER_MAX_BODY_BYTES - claimSideBytes(options);
      const context = worstClaimContext(listingOfBytes(room + extra), { codeReview, codeClass: 'code-premium' });
      return JSON.stringify(A('external-adapter/src/codeReview/runnerClient').buildRunRequest(context, RUNNER_MAX_DEADLINE_MS));
    };

    test('the room measured here is exact: a body at the limit is read, one byte more is a 413', async () => {
      const exact = atTheLimit(0);
      assert.equal(Buffer.byteLength(exact), RUNNER_MAX_BODY_BYTES);
      const read = await post(exact);
      assert.notEqual(read.status, 413);
      assert.notEqual(read.status, 400, JSON.stringify(read.body?.issues));
      const over = atTheLimit(1);
      assert.equal(Buffer.byteLength(over), RUNNER_MAX_BODY_BYTES + 1);
      assert.equal((await post(over)).status, 413);
    });
  });
});
