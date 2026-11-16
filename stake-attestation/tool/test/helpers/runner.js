// A stand-in for the arbiters' code-runner on a loopback port: POST /v1/runs as
// verdikta-arbiter code-runner/README.md (e3a9c48) and src/request.js define it. The request is
// held to the real validator's field list and shapes, and a bearer token is required, so a request the
// real runner would refuse fails here too. The answer is scripted by each test; `definitive`,
// `abstaining` and `refused` build the three forms the README gives. Only the fields the README and
// src/server.js document appear.
import http from 'node:http';

export const TOKEN = 'a-runner-token-for-tests-0123456789abcdef';
export const IMAGE_SHA = 'a'.repeat(64);

const FIELDS = ['listingCid', 'bcid', 'spec', 'attestation', 'pocPatch', 'fixPatch', 'baseline', 'finding', 'report', 'knownIssues', 'priorFindings', 'eaGates', 'deadline', 'codeClass'];
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})$/;

export function requestProblems(body) {
  const out = [];
  for (const k of Object.keys(body)) if (!FIELDS.includes(k)) out.push(`unknown field ${k}`);
  for (const k of ['listingCid', 'bcid']) if (typeof body[k] !== 'string' || !CID.test(body[k])) out.push(`${k} is not a CID`);
  for (const k of ['spec', 'attestation', 'baseline', 'finding']) if (!body[k] || typeof body[k] !== 'object' || Array.isArray(body[k])) out.push(`${k} is not an object`);
  const canonical64 = (t) => typeof t === 'string' && t !== '' && t.length % 4 === 0 && Buffer.from(t, 'base64').toString('base64') === t;
  if (!canonical64(body.pocPatch)) out.push('pocPatch is not canonical base64');
  if (body.fixPatch !== null && body.fixPatch !== undefined && !canonical64(body.fixPatch)) out.push('fixPatch is not canonical base64');
  if (typeof body.report !== 'string') out.push('report is not a string');
  if (!Array.isArray(body.knownIssues)) out.push('knownIssues is not an array');
  if (!Array.isArray(body.priorFindings)) out.push('priorFindings is not an array');
  const g = body.eaGates;
  if (!(g && Object.keys(g).length === 2 && g.disclosure === 'pass' && g.inScope === 'pass')) out.push('eaGates is not exactly both pass');
  if (!Number.isInteger(body.deadline) || body.deadline < 1 || body.deadline > 900000) out.push('deadline is out of range');
  return out;
}

const pass = (basis, detail = 'ok') => ({ status: 'pass', basis, detail });
const fail = (basis, detail) => ({ status: 'fail', basis, detail });

const CLEAN_INTEGRITY = { identityComplete: true, summaryConsistent: true, exitConsistent: true, protectedPathsUnchanged: true, frameworkUnchanged: true, dependenciesUnchanged: true, tamperFlags: [] };

export const GATES = {
  allPass: () => ({
    applies: pass('exit_code'), testPathsOnly: pass('exit_code'), build: pass('exit_code', 'the build command exited 0'),
    reproduces: pass('junit', '1 test the patch added failed as an assertion on all 3 runs'), integrity: pass('integrity', 'every integrity check passed on 3 runs'),
    claimedObservable: pass('junit', 'finding.json names test_drain; each quoted observable is in its recorded failure on every run'),
  }),
  pass,
  fail,
};

/** facts.poc as src/claim.js pocFacts writes it, for tests that fail on every run. */
export function pocFacts({ tests = [{ id: 'test/Exploit.t.sol > ExploitTest > test_drain()', runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: 'vault balance 0 after one withdraw' }], integrity = {}, report } = {}) {
  const runCounts = { fail: 0, pass: 0, error: 0, skip: 0, missing: 0, duplicate: 0, notRun: 0 };
  for (const t of tests) for (const r of t.runs) runCounts[r === 'not-run' ? 'notRun' : r] += 1;
  return {
    tier: 'B',
    testCount: tests.length,
    runCounts,
    tests,
    runs: [],
    report: report ?? { testCount: tests.length, runCounts, tests: tests.map((t) => ({ id: t.id, runs: t.runs, kind: t.kind, message: t.message })) },
    integrity: { ...CLEAN_INTEGRITY, ...integrity },
  };
}

export const PACK = (marker = 'pack text') => ({
  version: 1, codeClass: 'code-standard', budgetTokens: 60000, usedTokens: 12, sha256: 'b'.repeat(64),
  tiers: [{ rank: 1, name: 'poc', status: 'full', asked: 1, delivered: 1, omitted: {}, cut: 0, bytes: 40, bytesIncluded: 40, tokens: 10 }],
  files: [{ name: '00-manifest.json', tier: 'manifest', text: '{}' }, { name: '01-poc-diff.patch', tier: 'poc', text: `# the proof\n${marker}\n` }],
});

const base = (spec) => ({
  runId: '3f2a',
  runner: { version: '0.1.0', runtime: 'runc', platform: 'linux/amd64', gvisor: null },
  limits: { cpus: 2, memoryMb: 4096, pids: 4096, buildSeconds: 90, testSeconds: 180, runSeconds: 360, maxPatchBytes: 2000000, patchExpansionBytes: 50000000, platform: 'linux/amd64' },
  image: { ref: spec?.env?.image ?? null, cache: 'hit', durationMs: 41 },
  steps: [],
});

export function definitive(spec, { gates = GATES.allPass(), facts = {}, steps = [], report = { schema: 'verdikta.claim-report/1' }, reportSha256 = 'c'.repeat(64), reportUnavailable = null, contextPack = PACK(), image, platform } = {}) {
  const b = base(spec);
  if (platform) b.runner.platform = platform;
  return {
    status: 200,
    body: {
      outcome: 'definitive', ...b, ...(image ? { image } : {}), abstain: null, steps,
      gates,
      facts: { compiler: { tier: 'A', solc: '0.8.31' }, poc: pocFacts(), ...facts },
      report, reportSha256, reportUnavailable, contextPack,
    },
  };
}

export function abstaining(spec, cause = 'oom', detail = 'a process in the sandbox was OOM-killed during the step', step = 'build') {
  return { status: 503, body: { outcome: 'abstain', ...base(spec), abstain: { cause, step, detail }, gates: {}, facts: {}, report: null, reportSha256: null, reportUnavailable: null, contextPack: null } };
}

export function refused(issues) {
  return { status: 400, body: { outcome: 'requester_error', issues } };
}

export async function startRunner(answer = (req) => definitive(req.spec)) {
  const requests = [];
  const state = { answer, echoToken: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: state.echoToken ? `bad token ${req.headers.authorization}` : 'unauthorized' }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/runs') {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const problems = requestProblems(body);
      if (problems.length) {
        res.statusCode = 400;
        res.end(JSON.stringify({ outcome: 'requester_error', issues: problems.map((detail) => ({ code: 'SCHEMA', path: '/', detail })) }));
        return;
      }
      const a = await state.answer(body);
      res.statusCode = a.status;
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
