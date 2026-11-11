// Acceptance 1: `check` runs the code-runner pipeline minus the jury at CODE_RUNNER_URL, the image
// pulled by digest, with finding.json validation and scope through common, and prints the gate forecast
// and the pack. And the notes from A3a, A3b, A2c and Q35 the forecast must carry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildForecast, withoutProofText } from '../src/index.js';
import { closeRpc, runCli } from './helpers/cli.js';
import { FINDING, FIX_PATCH, JUSTIFICATION_CID, POC_MARKER, POC_PATCH, codeReview, makeClaimDir, makeWorld, vectorOf } from './helpers/world.js';
import { GATES, IMAGE_SHA, PACK, TOKEN, abstaining, definitive, pocFacts, refused, startRunner } from './helpers/runner.js';

const codeReviewKey = () => codeReview.createDevBuilderKey();
let w;
let l;
let runner;
const runnerOpt = () => ({ url: runner.url, token: TOKEN });
const check = (claimDir, over = {}) => w.hunter({ runner: runnerOpt(), signer: undefined }).check({ claimDir, listingId: l.listingId, ...over });

before(async () => {
  w = await makeWorld();
  l = await w.listing();
  runner = await startRunner();
});
after(async () => {
  await runner.close();
  await closeRpc(w);
  await w.close();
});

test('check posts one pipeline request with the bearer token and the listing\'s image by digest', async () => {
  runner.requests.length = 0;
  const r = await check(makeClaimDir({ fix: FIX_PATCH }));
  assert.equal(runner.requests.length, 1);
  const req = runner.requests[0];
  assert.deepEqual(req.spec, l.spec);
  assert.match(req.spec.env.image, /@sha256:[0-9a-f]{64}$/);
  assert.equal(Buffer.from(req.pocPatch, 'base64').toString(), POC_PATCH);
  assert.equal(Buffer.from(req.fixPatch, 'base64').toString(), FIX_PATCH);
  assert.deepEqual(req.finding, FINDING);
  assert.deepEqual(req.eaGates, { disclosure: 'pass', inScope: 'pass' });
  assert.equal(req.listingCid, l.listingCid);
  assert.equal(r.forecast.verdict, 'pass');
  assert.deepEqual(r.forecast.gates.map((g) => g.name), ['listingSigned', 'finding', 'inScope', 'applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']);
  assert.ok(r.pack.files.length > 0);
});

test('a finding.json common refuses, or one out of scope, stops at the local gate and never reaches the runner', async () => {
  runner.requests.length = 0;
  const outOfScope = await check(makeClaimDir({ finding: { ...FINDING, affectedPaths: ['lib/Other.sol'] } }));
  assert.equal(outOfScope.forecast.verdict, 'fail');
  assert.equal(outOfScope.forecast.gates.find((g) => g.name === 'inScope').status, 'fail');
  assert.match(outOfScope.forecast.gates.find((g) => g.name === 'inScope').detail, /PATH_OUT_OF_SCOPE/);
  assert.equal(outOfScope.forecast.settlesAs.outcome, 'INVALID');
  const schema = await check(makeClaimDir({ finding: { ...FINDING, claimedClass: 'HUGE' } }));
  assert.equal(schema.forecast.gates.find((g) => g.name === 'finding').status, 'fail');
  assert.equal(runner.requests.length, 0);
});

test('the runner\'s refusal codes are shown by code, path and detail, none taken for the claim\'s failure; odd ones lose their shape', async () => {
  runner.state.answer = () => refused([{ code: 'SOLC_NOT_OFFICIAL', path: '/spec/env/image', detail: 'svm/0.8.31/solc-0.8.31 is not the official build' }, { code: 'A_CODE_THIS_TOOL_HAS_NEVER_SEEN', path: '/x', detail: 'something new' }]);
  const r = await check(makeClaimDir());
  assert.equal(r.forecast.verdict, 'refused');
  assert.equal(r.forecast.settlesAs, null);
  assert.deepEqual(r.forecast.refusals.map((i) => i.code), ['SOLC_NOT_OFFICIAL', 'A_CODE_THIS_TOOL_HAS_NEVER_SEEN']);
  const cli = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { runner });
  assert.equal(cli.code, 1);
  assert.match(cli.stdout, /SOLC_NOT_OFFICIAL/);
  assert.match(cli.stdout, /\/spec\/env\/image/);
  assert.match(cli.stdout, /svm\/0\.8\.31\/solc-0\.8\.31 is not the official build/);
  assert.match(cli.stdout, /A_CODE_THIS_TOOL_HAS_NEVER_SEEN/);
  runner.state.answer = () => refused([{ code: 'not a code: quoted text', path: 'not a path: quoted text', detail: 'x' }]);
  const odd = await check(makeClaimDir());
  assert.deepEqual(odd.forecast.refusals, [{ code: 'UNKNOWN', path: '', detail: 'x' }]);
  runner.state.answer = (req) => definitive(req.spec);
});

test('an abstention says so, with its cause, and forecasts nothing', async () => {
  runner.state.answer = (req) => abstaining(req.spec, 'pull_failed', 'the registry was unreachable', 'pull');
  const r = await check(makeClaimDir());
  assert.equal(r.forecast.verdict, 'abstain');
  assert.equal(r.forecast.abstain.cause, 'pull_failed');
  assert.equal(r.forecast.settlesAs, null);
  runner.state.answer = (req) => definitive(req.spec);
});

test('an abstain a claim can cause is shown as an abstain, with what it costs (design §12 at A4b): nothing on-chain says why', async () => {
  for (const [cause, step, detail] of [['oom', 'poc:run-1', 'a process in the sandbox was OOM-killed during the step'], ['step_timeout', 'poc:run-2', 'the step hit its limit'], ['pids_limit', 'build', 'the pid table was full'], ['killed_by_signal', 'poc:run-1', 'exit 137']]) {
    runner.state.answer = (req) => abstaining(req.spec, cause, detail, step);
    const r = await check(makeClaimDir());
    assert.equal(r.forecast.verdict, 'abstain', cause);
    assert.equal(r.forecast.settlesAs, null, 'an abstain settles nothing');
    assert.equal(r.forecast.abstain.cause, cause);
    assert.equal(r.forecast.abstain.step, step);
    assert.equal(r.forecast.abstain.claimCanCause, true, cause);
    const text = r.forecast.abstain.cost;
    for (const needle of [/every arbiter/i, /no commit|no verdict/i, /base fees/, /K × the per-oracle fee/, /\$1\.75/, /\$3\.50/, /rest .*comes back at finalize/i, /no round settles/, /bond goes to the maker at expiry/, /[Nn]othing on-chain or on IPFS says why/]) {
      assert.match(text, needle, `${cause}: ${needle}`);
    }
  }
  const cli = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId), '--no-pack'], { runner });
  assert.equal(cli.code, 1, cli.stderr);
  assert.match(cli.stdout, /ABSTAIN/i);
  assert.match(cli.stdout, /killed_by_signal/);
  assert.match(cli.stdout, /poc:run-1/);
  assert.match(cli.stdout, /bond goes to the maker at expiry/);
  assert.match(cli.stdout, /\$1\.75/);
  assert.doesNotMatch(cli.stdout, /Settles as/);
  runner.state.answer = (req) => definitive(req.spec);
});

test('an abstain from this machine\'s own runner says that too, and still what the same cause would cost on the arbiters', async () => {
  runner.state.answer = (req) => abstaining(req.spec, 'docker_unreachable', 'the daemon cannot be reached', 'admission');
  const r = await check(makeClaimDir());
  assert.equal(r.forecast.verdict, 'abstain');
  assert.equal(r.forecast.abstain.claimCanCause, false);
  assert.match(r.forecast.abstain.cost, /this machine/);
  assert.match(r.forecast.abstain.cost, /no forecast/i);
  runner.state.answer = (req) => definitive(req.spec);
});

test('the request is what the EA sends (A4b): report cut as far as the pack could hold, an over-limit fix.patch dropped, an empty one absent', async () => {
  const maxChars = 60000 * 4;
  runner.requests.length = 0;
  await check(makeClaimDir({ report: `# ${'r'.repeat(maxChars + 500)}`, fix: 'x'.repeat(2000001) }));
  let req = runner.requests[0];
  assert.equal(req.report.length, maxChars);
  assert.equal(req.fixPatch, null);
  assert.equal(req.codeClass, 'code-standard');
  runner.requests.length = 0;
  await check(makeClaimDir({ fix: '' }));
  req = runner.requests[0];
  assert.equal(req.fixPatch, null);
});

test('a poc.patch over maxPatchBytes is the EA\'s INVALID at applies: forecast here, never sent to the runner', async () => {
  runner.requests.length = 0;
  const r = await check(makeClaimDir({ poc: `diff --git a/t b/t\n${'x'.repeat(2000001)}` }));
  assert.equal(r.forecast.verdict, 'fail');
  const gate = r.forecast.gates.find((g) => g.name === 'applies');
  assert.equal(gate.status, 'fail');
  assert.match(gate.detail, /maxPatchBytes/);
  assert.equal(r.forecast.settlesAs.outcome, 'INVALID');
  assert.equal(runner.requests.length, 0);
});

test('prior valid findings go to the runner as the EA sends them: they are in the pack jurors read', async () => {
  const lp = await w.listing();
  const hunter = w.hunter();
  const first = makeClaimDir();
  const { claimId } = await hunter.commit({ claimDir: first, listingId: lp.listingId, acknowledge: true });
  await hunter.reveal({ claimDir: first });
  const req0 = (await w.sa.getClaim(claimId)).requestId;
  await (await w.aggregator.scriptResult(req0, vectorOf('HIGH'), JUSTIFICATION_CID)).wait();
  await (await w.sa.finalize(claimId)).wait();
  await w.increase((await w.sa.getListing(lp.listingId)).disputeWindow);
  await (await w.sa.settle(claimId)).wait();
  runner.requests.length = 0;
  await w.hunter({ runner: runnerOpt(), signer: undefined }).check({ claimDir: makeClaimDir(), listingId: lp.listingId });
  const req = runner.requests[0];
  assert.equal(req.priorFindings.length, 1);
  assert.equal(req.priorFindings[0].bcid, (await w.sa.getClaim(claimId)).bcid);
  assert.deepEqual(req.priorFindings[0].finding, FINDING);
  assert.ok(req.priorFindings[0].report.length <= 4096);
});

test('a prior finding this machine cannot read is named, and the pack is said to lack it', async () => {
  const lp = await w.listing();
  const hunter = w.hunter();
  const first = makeClaimDir();
  const { claimId } = await hunter.commit({ claimDir: first, listingId: lp.listingId, acknowledge: true });
  const { bcid } = await hunter.reveal({ claimDir: first });
  await (await w.aggregator.scriptResult((await w.sa.getClaim(claimId)).requestId, vectorOf('HIGH'), JUSTIFICATION_CID)).wait();
  await (await w.sa.finalize(claimId)).wait();
  await w.increase((await w.sa.getListing(lp.listingId)).disputeWindow);
  await (await w.sa.settle(claimId)).wait();
  w.ipfs.drop(bcid);
  const r = await w.hunter({ runner: runnerOpt(), signer: undefined, readBackMs: 10 }).check({ claimDir: makeClaimDir(), listingId: lp.listingId });
  assert.equal(r.forecast.priorFindings.read, 0);
  assert.deepEqual(r.forecast.priorFindings.unread, [bcid]);
});

test('what a repository or a test printed reaches the terminal without control characters', async () => {
  const gates = { ...GATES.allPass(), reproduces: GATES.fail('junit', 'test_drain errored \u001b[2J\u001b]0;owned\u0007') };
  delete gates.integrity;
  delete gates.claimedObservable;
  runner.state.answer = (req) => definitive(req.spec, { gates, facts: { poc: pocFacts({ tests: [{ id: 'test/E.t.sol > E > test_drain()', runs: ['error', 'error', 'error'], kind: 'error', message: 'bad \u001b[31m text' }] }) } });
  const cli = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { runner });
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(`${cli.stdout}${cli.stderr}`, /[\u0000-\u0008\u000b-\u001f]/);
  assert.match(cli.stdout, /test_drain errored/);
  runner.state.answer = (req) => definitive(req.spec);
});

// Recorded from the real code-runner (verdikta-arbiter bdea108, runc, linux/arm64, its own Docker fixture image),
// with logs and file text trimmed: the mock above must not drift from what the runner answers.
const recorded = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/runner-answers/${name}.answer.json`, import.meta.url), 'utf8'));

// Node P21: common takes stake.documents since 1.9.0-attest.4, and the tool offers it only from node P20. check
// refuses a signed listing that names it, from the chain and from a file alike, by that one code, before any run.
test('check refuses a listing naming stake.documents, by one code, before any run: documents are not offered yet', async () => {
  const withDocuments = await w.listing({ stake: { documents: ['README.md'] } });
  assert.deepEqual(withDocuments.spec.stake.documents, ['README.md']);
  runner.requests.length = 0;
  for (const over of [{ listingId: withDocuments.listingId }, { listingId: undefined, listingArchive: withDocuments.archives.listing }]) {
    const err = await check(makeClaimDir(), over).then(() => null, (e) => e);
    assert.ok(err, `refused: ${Object.keys(over)}`);
    assert.equal(err.code, 'STAKE_DOCUMENTS_NOT_OFFERED');
    assert.match(err.message, /documents are not offered yet/i);
  }
  const cli = await runCli(w, ['check', makeClaimDir(), '--listing', String(withDocuments.listingId)], { runner });
  assert.equal(cli.code, 1);
  assert.match(cli.stderr, /STAKE_DOCUMENTS_NOT_OFFERED: .*documents are not offered yet/i);
  assert.equal(runner.requests.length, 0, 'the runner was not asked');
});

test('no run on a listing a commit would refuse: its image is one nobody attested', async () => {
  const unsigned = await w.listing({ signWith: codeReviewKey() });
  runner.requests.length = 0;
  const r = await check(makeClaimDir(), { listingId: unsigned.listingId });
  assert.equal(r.forecast.verdict, 'fail');
  assert.match(r.forecast.gates.find((g) => g.name === 'listingSigned').detail, /NOT_SIGNED_BY_BUILDER/);
  assert.equal(runner.requests.length, 0);
});

test('the run does not go through fetch, whose header timeout (five minutes) is shorter than a run may take', async () => {
  const hunter = w.hunter({ runner: runnerOpt(), signer: undefined, fetch: () => { throw new Error('fetch was used'); } });
  const r = await hunter.check({ claimDir: makeClaimDir(), listingArchive: l.archives.listing });
  assert.equal(r.forecast.verdict, 'pass');
  assert.equal(runner.requests.at(-1).deadline, 780000);
});

test('a name that merely starts like a loopback address is not this machine', async () => {
  for (const url of ['http://127.runner.example:8090', 'http://127.0.0.1.nip.example', 'http://127.0.0.1@runner.example', 'http://localhost.runner.example']) {
    const hunter = w.hunter({ runner: { url, token: TOKEN }, signer: undefined });
    await assert.rejects(hunter.check({ claimDir: makeClaimDir(), listingId: l.listingId }), (e) => e.code === 'RUNNER_NOT_LOCAL', url);
  }
});

test('a definitive answer with no evidence in it is no pass: a broken runner is an error, not a forecast', async () => {
  const bad = [
    { outcome: 'definitive' },
    { outcome: 'definitive', gates: {} },
    { outcome: 'definitive', gates: { applies: GATES.pass('exit_code') } },
    { outcome: 'definitive', gates: { ...GATES.allPass(), build: { status: 'maybe' } } },
    { outcome: 'definitive', gates: GATES.allPass() }, // no facts, no image
  ];
  for (const body of bad) {
    runner.state.answer = () => ({ status: 200, body });
    await assert.rejects(check(makeClaimDir()), (e) => e.code === 'RUNNER_ANSWER_INVALID', JSON.stringify(body).slice(0, 60));
  }
  const noReproducedFacts = { ...GATES.allPass() };
  delete noReproducedFacts.claimedObservable;
  runner.state.answer = (req) => definitive(req.spec, { gates: noReproducedFacts });
  await assert.rejects(check(makeClaimDir()), (e) => e.code === 'RUNNER_ANSWER_INVALID');
  const nothingFailed = { ...GATES.allPass(), reproduces: GATES.fail('integrity', 'x'), integrity: GATES.pass('integrity') };
  delete nothingFailed.claimedObservable;
  runner.state.answer = (req) => definitive(req.spec, { gates: nothingFailed });
  await assert.rejects(check(makeClaimDir()), (e) => e.code === 'RUNNER_ANSWER_INVALID', 'reproduces failed only through integrity, with no check failed: the arbiters abstain');
  const cli = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { runner: { url: runner.url } });
  assert.equal(cli.code, 1);
  assert.match(cli.stderr, /RUNNER_ANSWER_INVALID/);
  assert.doesNotMatch(cli.stdout, /Every gate would pass/);
  runner.state.answer = (req) => definitive(req.spec);
});

test('--no-pack means no proof text anywhere: build output, messages, runner text, names; the same under --json', async () => {
  const M = POC_MARKER;
  const answers = [
    (req) => definitive(req.spec, { gates: { applies: GATES.pass('exit_code', `wrote ${M}`), testPathsOnly: GATES.pass('exit_code'), build: GATES.fail('exit_code', `failed at ${M}`) }, steps: [{ name: 'build', outcome: 'ok', exitCode: 1, stdout: { text: M }, stderr: { text: `Error at ${M}` } }], facts: { compiler: { solc: '0.8.31' } } }),
    (req) => definitive(req.spec, { facts: { poc: pocFacts({ tests: [{ id: `test/${M}.t.sol > E > test_drain()`, runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: `balance ${M}` }] }) } }),
    (req) => abstaining(req.spec, 'oom', `killed near ${M}`, 'poc:1'),
    () => refused([{ code: 'SCHEMA', path: '/report', detail: `quotes ${M}` }]),
  ];
  for (const answer of answers) {
    runner.state.answer = answer;
    for (const extra of [[], ['--json']]) {
      const cli = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId), '--no-pack', ...extra], { runner });
      assert.equal(`${cli.stdout}${cli.stderr}`.includes(M), false, cli.stdout.slice(0, 400));
    }
    const shown = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { runner });
    assert.equal(`${shown.stdout}${shown.stderr}`.includes(M), true, 'without the flag the hunter sees it');
  }
  // A claim that fails here before any run: its settlement reason is fixed words, whatever the finding says.
  const out = makeClaimDir({ finding: { ...FINDING, affectedPaths: [`lib/${M}.sol`] } });
  for (const extra of [[], ['--json']]) {
    const cli = await runCli(w, ['check', out, '--listing', String(l.listingId), '--no-pack', ...extra], { runner });
    assert.equal(cli.code, 1);
    assert.match(cli.stdout, /INVALID/);
    assert.equal(`${cli.stdout}${cli.stderr}`.includes(M), false, cli.stdout.slice(0, 400));
  }
  runner.state.answer = (req) => definitive(req.spec);
});

test('--no-pack is an allow-list: a marker in any string a runner answers with, one at a time, never comes out', () => {
  const M = 'QUOTED-PROOF-TEXT';
  const leaves = (value, at = []) => {
    if (typeof value === 'string') return [at];
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([k, v]) => leaves(v, [...at, k]));
  };
  const setAt = (root, at, v) => {
    const copy = structuredClone(root);
    let node = copy;
    for (const k of at.slice(0, -1)) node = node[k];
    node[at.at(-1)] = v;
    return copy;
  };
  let tried = 0;
  for (const name of ['definitive', 'abstain']) {
    const a = recorded(name);
    for (const at of leaves(a.body)) {
      const body = setAt(a.body, at, `${M} ${at.join('.')}`);
      let f;
      try {
        f = buildForecast({ local: [], answer: { status: a.status, body }, spec: a.spec, pocPatch: Buffer.from(a.pocPatch), lint: [], priorFindings: { read: 0, unread: [], total: 0 } });
      } catch (err) {
        assert.equal(err.code, 'RUNNER_ANSWER_INVALID'); // a runner that says something unreadable: an error, with fixed words
        assert.equal(err.message.includes(M), false, at.join('.'));
        continue;
      }
      tried += 1;
      const out = JSON.stringify(withoutProofText(f));
      assert.equal(out.includes(M), false, `${at.join('.')} came through`);
    }
  }
  assert.ok(tried > 40, String(tried));
});

test('a real runner\'s definitive answer reads as a pass, on arm64 with no report and the run pattern from facts.poc', () => {
  const a = recorded('definitive');
  const f = buildForecast({ local: [], answer: { status: a.status, body: a.body }, spec: a.spec, pocPatch: Buffer.from(a.pocPatch), lint: [], priorFindings: {} });
  assert.equal(f.verdict, 'pass');
  assert.deepEqual(f.gates.map((g) => g.name), ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']);
  assert.deepEqual(f.tests[0].runs, ['fail', 'fail', 'fail']);
  assert.match(f.reportUnavailable, /linux\/arm64/);
  assert.equal(f.compiler, '/opt/solc/solc');
  assert.equal(f.observable.suggestions[0], 'test_drain fails with "vault credits one wei too many"');
  assert.equal(f.settlesAs, null);
});

test('a real runner\'s abstention, from a proof that sleeps past its limit: an abstain with its cost, and the gates it had reached', () => {
  const a = recorded('abstain');
  const f = buildForecast({ local: [], answer: { status: a.status, body: a.body }, spec: a.spec, pocPatch: Buffer.from(a.pocPatch), lint: [], priorFindings: {} });
  assert.equal(f.verdict, 'abstain');
  assert.equal(f.abstain.cause, 'step_timeout');
  assert.equal(f.abstain.step, 'poc:1');
  assert.equal(f.abstain.claimCanCause, true);
  assert.match(f.abstain.cost, /bond goes to the maker at expiry/);
  assert.deepEqual(f.gates.map((g) => [g.name, g.status]), [['applies', 'pass'], ['testPathsOnly', 'pass'], ['build', 'pass']]);
  assert.equal(f.settlesAs, null);
});

test('linux/arm64: no report, only gates and the pack, and the tool says so instead of failing', async () => {
  runner.state.answer = (req) => definitive(req.spec, { report: null, reportSha256: null, reportUnavailable: 'linux/arm64 is a development platform', platform: 'linux/arm64' });
  const r = await check(makeClaimDir());
  assert.equal(r.forecast.verdict, 'pass');
  assert.equal(r.forecast.reportUnavailable, 'linux/arm64 is a development platform');
  const cli = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { runner });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /linux\/arm64/);
  assert.match(cli.stdout, /no report/i);
  assert.match(cli.stdout, /01-poc-diff\.patch/);
  runner.state.answer = (req) => definitive(req.spec);
});

test('the run pattern comes from facts.poc.tests, not the report\'s folded form', async () => {
  const tests = [{ id: 'test/Exploit.t.sol > ExploitTest > test_drain()', runs: ['fail', 'pass', 'fail'], kind: 'assertion', message: 'flaky' }];
  const folded = { testCount: 1, runCounts: { fail: 0, pass: 0, error: 3, skip: 0, missing: 0, duplicate: 0, notRun: 0 }, tests: [{ id: tests[0].id, runs: ['error', 'error', 'error'], kind: 'error', message: 'disagree' }] };
  const gates = { ...GATES.allPass(), reproduces: GATES.fail('junit', 'test_drain passed on run 2') };
  delete gates.integrity;
  delete gates.claimedObservable;
  runner.state.answer = (req) => definitive(req.spec, { gates, facts: { poc: pocFacts({ tests, report: folded }) } });
  const r = await check(makeClaimDir());
  assert.deepEqual(r.forecast.tests[0].runs, ['fail', 'pass', 'fail']);
  runner.state.answer = (req) => definitive(req.spec);
});

test('a PoC whose pragma the listing\'s release cannot compile: build fails, with the pin and the pragma shown', async () => {
  const gates = { applies: GATES.pass('exit_code'), testPathsOnly: GATES.pass('exit_code'), build: GATES.fail('exit_code', 'the build command exited 1') };
  const steps = [{ name: 'build', outcome: 'ok', exitCode: 1, durationMs: 9, stdout: { text: '', totalBytes: 0, omittedBytes: 0 }, stderr: { text: 'Error: Found incompatible versions', totalBytes: 34, omittedBytes: 0 } }];
  runner.state.answer = (req) => definitive(req.spec, { gates, steps, facts: { compiler: { tier: 'A', solc: '0.7.6' }, poc: undefined }, report: null, contextPack: PACK() });
  const r = await check(makeClaimDir());
  assert.equal(r.forecast.verdict, 'fail');
  assert.equal(r.forecast.settlesAs.outcome, 'INVALID');
  assert.equal(r.forecast.build.compiler, '0.7.6');
  assert.deepEqual(r.forecast.build.pragmas, ['^0.8.20']);
  assert.match(r.forecast.build.output, /incompatible versions/);
  const cli = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { runner });
  assert.match(cli.stdout, /0\.7\.6/);
  assert.match(cli.stdout, /\^0\.8\.20/);
  runner.state.answer = (req) => definitive(req.spec);
});

test('claimedObservable: a failed gate shows the recorded failure and a line that follows the rule (A3a)', async () => {
  const gates = { ...GATES.allPass(), claimedObservable: GATES.fail('junit', '"something else" is not in the recorded failure of test_drain on every run') };
  runner.state.answer = (req) => definitive(req.spec, { gates });
  const r = await check(makeClaimDir({ finding: { ...FINDING, poc: { command: 'forge test --match-test test_drain', observable: 'test_drain fails with "something else"' } } }));
  assert.equal(r.forecast.verdict, 'fail');
  assert.equal(r.forecast.settlesAs.outcome, 'INVALID');
  assert.equal(r.forecast.observable.suggestions[0], 'test_drain fails with "vault balance 0 after one withdraw"');
  runner.state.answer = (req) => definitive(req.spec);
});

test('a static read warns before the run: no test the patch added named, another test named, nothing quoted', async () => {
  const none = await check(makeClaimDir({ finding: { ...FINDING, poc: { command: 'forge test', observable: 'the vault is drained by anyone at all' } } }));
  assert.ok(none.forecast.lint.some((x) => x.code === 'NO_ADDED_TEST_NAMED'));
  assert.ok(none.forecast.lint.some((x) => x.code === 'NOTHING_QUOTED'));
  const other = await check(makeClaimDir({ finding: { ...FINDING, poc: { command: 'forge test --match-test test_deposit_credits', observable: 'test_drain and test_deposit_credits both fail with "x"' } } }));
  assert.ok(other.forecast.lint.some((x) => x.code === 'OTHER_TEST_NAMED' && x.names.includes('test_deposit_credits')));
  const fine = await check(makeClaimDir());
  assert.deepEqual(fine.forecast.lint, []);
});

test('a message that moves between runs: the hint says to quote only its steady part', async () => {
  const tests = [{ id: 'test/Exploit.t.sol > ExploitTest > test_drain()', runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: 'balance 0 at 1767225600' }];
  const report = { testCount: 1, runCounts: { fail: 3, pass: 0, error: 0, skip: 0, missing: 0, duplicate: 0, notRun: 0 }, tests: [{ id: tests[0].id, runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: null }] };
  const gates = { ...GATES.allPass(), claimedObservable: GATES.fail('junit', 'not on every run') };
  runner.state.answer = (req) => definitive(req.spec, { gates, facts: { poc: pocFacts({ tests, report }) } });
  const r = await check(makeClaimDir());
  assert.match(r.forecast.observable.hints.join('\n'), /moves between runs|changes between runs/);
  runner.state.answer = (req) => definitive(req.spec);
});

test('Q35, in plain words: a date-keyed trap is not caught; a tamper flag costs the bond; other integrity failures return it', async () => {
  const tamper = { ...GATES.allPass(), reproduces: GATES.fail('integrity', 'not trusted'), integrity: GATES.fail('integrity', 'tamperFlags') };
  delete tamper.claimedObservable;
  runner.state.answer = (req) => definitive(req.spec, { gates: tamper, facts: { poc: pocFacts({ integrity: { tamperFlags: [{ kind: 'framework-patched', file: 'test/E.t.sol', line: 3 }], frameworkUnchanged: false } }) } });
  let r = await check(makeClaimDir());
  assert.equal(r.forecast.settlesAs.outcome, 'INVALID');
  assert.equal(r.forecast.settlesAs.bond, 'forfeited');
  assert.match(r.forecast.settlesAs.reason, /tamper/i);

  const other = { ...tamper, integrity: GATES.fail('integrity', 'dependenciesUnchanged') };
  runner.state.answer = (req) => definitive(req.spec, { gates: other, facts: { poc: pocFacts({ integrity: { dependenciesUnchanged: false } }) } });
  r = await check(makeClaimDir());
  assert.equal(r.forecast.settlesAs.outcome, 'DUPLICATE');
  assert.equal(r.forecast.settlesAs.bond, 'returned');
  assert.equal(r.forecast.settlesAs.award, 'none');
  assert.match(r.forecast.settlesAs.reason, /dependenciesUnchanged/);

  const alone = { ...tamper, reproduces: GATES.fail('junit', 'test_drain passed on run 1'), integrity: GATES.fail('integrity', 'dependenciesUnchanged') };
  const passed = [{ id: 'test/Exploit.t.sol > ExploitTest > test_drain()', runs: ['pass', 'pass', 'pass'], kind: null, message: null }];
  runner.state.answer = (req) => definitive(req.spec, { gates: alone, facts: { poc: pocFacts({ tests: passed, integrity: { dependenciesUnchanged: false } }) } });
  r = await check(makeClaimDir());
  assert.equal(r.forecast.settlesAs.outcome, 'INVALID', 'a reproduces failure on its own stays INVALID, whatever integrity says');

  runner.state.answer = (req) => definitive(req.spec);
  const cli = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId), '--no-pack'], { runner });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /date/i);
  assert.match(cli.stdout, /fakes no clock/);
  assert.match(cli.stdout, /tamper flag/i);
  assert.match(cli.stdout, /bond/);
});

test('a runner off the machine is refused unless asked for, and then the tool says it reads the plaintext', async () => {
  const hunter = w.hunter({ runner: { url: 'http://192.0.2.1:8090', token: TOKEN }, signer: undefined });
  await assert.rejects(hunter.check({ claimDir: makeClaimDir(), listingId: l.listingId }), (e) => e.code === 'RUNNER_NOT_LOCAL');
  const notices = [];
  const allowed = w.hunter({ runner: { url: runner.url.replace('127.0.0.1', 'localhost'), token: TOKEN, allowRemote: true }, signer: undefined, onNotice: (t) => notices.push(t) });
  await allowed.check({ claimDir: makeClaimDir(), listingId: l.listingId }).catch(() => {});
  const refusedLoud = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { runner: { url: 'http://192.0.2.1:8090' } });
  assert.equal(refusedLoud.code, 1);
  assert.match(refusedLoud.stderr, /RUNNER_NOT_LOCAL/);
  const seen = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId), '--remote-runner', '--no-pack'], { runner });
  assert.match(seen.stdout, /reads? the plaintext/i);
});

test('an image the runner reports under another digest is a failed forecast, never a pass', async () => {
  runner.state.answer = (req) => definitive(req.spec, { image: { ref: `ghcr.io/verdikta/stake-env@sha256:${IMAGE_SHA}`, cache: 'hit', durationMs: 1 } });
  const r = await check(makeClaimDir());
  assert.equal(r.forecast.verdict, 'fail');
  assert.equal(r.forecast.gates.find((g) => g.name === 'image').status, 'fail');
  runner.state.answer = (req) => definitive(req.spec);
});

test('a listing with no digest in its image is refused before the runner', async () => {
  const hunter = w.hunter({ runner: runnerOpt(), signer: undefined });
  const before_ = runner.requests.length;
  const bad = await hunter.check({ claimDir: makeClaimDir(), listingArchive: Buffer.from('not a zip') }).catch((e) => e);
  assert.equal(bad.code, 'LISTING_ARCHIVE_INVALID');
  assert.equal(runner.requests.length, before_);
});

test('check also works from a listing archive on disk, naming what it could not check', async () => {
  const r = await w.hunter({ runner: runnerOpt(), signer: undefined, provider: undefined, contract: undefined }).check({ claimDir: makeClaimDir(), listingArchive: l.archives.listing });
  assert.equal(r.forecast.gates.find((g) => g.name === 'listingSigned').status, 'pass');
  assert.match(r.forecast.gates.find((g) => g.name === 'listingSigned').detail, /chain/);
});

test('a long answer reaches a pipe whole: the process waits for it before it exits', async () => {
  const big = PACK(`line of proof ${'x'.repeat(200)}\n`.repeat(20000));
  runner.state.answer = (req) => definitive(req.spec, { contextPack: big });
  const json = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId), '--json'], { runner });
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).pack.files[1].text, big.files[1].text);
  const text = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { runner });
  assert.ok(text.stdout.includes(big.files[1].text));
  runner.state.answer = (req) => definitive(req.spec);
});

test('the CLI prints the forecast and the pack; --no-pack leaves the pack out; --json carries both', async () => {
  const shown = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { runner });
  assert.equal(shown.code, 0, shown.stderr);
  for (const name of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable', 'inScope']) assert.match(shown.stdout, new RegExp(name));
  assert.match(shown.stdout, /01-poc-diff\.patch/);
  assert.match(shown.stdout, /pack text/);
  const quiet = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId), '--no-pack'], { runner });
  assert.doesNotMatch(quiet.stdout, /pack text/);
  const json = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId), '--json'], { runner });
  const out = JSON.parse(json.stdout);
  assert.equal(out.forecast.verdict, 'pass');
  assert.ok(out.pack.files.length);
});

// Node P19 (owner, 2026-11-10, Q73 #2): report.md says where the code is required to behave as the PoC asserts, in a
// "## Requirement" section. The EA requires no such section, so check warns of a missing or empty one and refuses
// nothing for it: the forecast, the run and the exit code are what they would be with the section.
const WITH_REQUIREMENT = '# Reentrancy in withdraw\n\nThe attacker re-enters withdraw from its fallback and takes the whole balance.\n\n## Requirement\n\nsrc/Vault.sol:12: the NatSpec of withdraw says it pays the caller\'s own balance and no more.\n';

test('check warns, and refuses nothing, when report.md has no "## Requirement" section; with one, no warning', async () => {
  runner.requests.length = 0;
  const without = await check(makeClaimDir());
  assert.equal(without.forecast.verdict, 'pass');
  assert.equal(runner.requests.length, 1, 'the run went ahead');
  assert.deepEqual(without.forecast.reportWarnings.map((x) => x.code), ['NO_REQUIREMENT_SECTION']);
  assert.match(without.forecast.reportWarnings[0].detail, /## Requirement/);
  const withIt = await check(makeClaimDir({ report: WITH_REQUIREMENT }));
  assert.equal(withIt.forecast.verdict, 'pass');
  assert.deepEqual(withIt.forecast.reportWarnings, []);

  const cli = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { runner });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /NO_REQUIREMENT_SECTION/);
  assert.match(cli.stdout, /## Requirement/);
  const clean = await runCli(w, ['check', makeClaimDir({ report: WITH_REQUIREMENT }), '--listing', String(l.listingId)], { runner });
  assert.equal(clean.code, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /REQUIREMENT_SECTION/);
});

test('the requirement warning is fixed words: --no-pack and --json keep it; a gate that fails before the run keeps it too', async () => {
  const quiet = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId), '--no-pack'], { runner });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.match(quiet.stdout, /NO_REQUIREMENT_SECTION/);
  const json = JSON.parse((await runCli(w, ['check', makeClaimDir({ report: '# Title\n\n## Requirement\n\n## Impact\n\nThe vault is drained by anyone.\n' }), '--listing', String(l.listingId), '--no-pack', '--json'], { runner })).stdout);
  assert.deepEqual(json.forecast.reportWarnings.map((x) => x.code), ['EMPTY_REQUIREMENT_SECTION']);
  runner.requests.length = 0;
  const out = await check(makeClaimDir({ finding: { ...FINDING, affectedPaths: ['lib/Other.sol'] } }));
  assert.equal(out.forecast.verdict, 'fail');
  assert.equal(runner.requests.length, 0);
  assert.deepEqual(out.forecast.reportWarnings.map((x) => x.code), ['NO_REQUIREMENT_SECTION']);
});
