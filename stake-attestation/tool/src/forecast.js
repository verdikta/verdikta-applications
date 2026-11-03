// The gate forecast: what the runner decided, in its own terms, and what it would settle as under the rule the
// arbiters' External Adapter applies (external-adapter/src/codeReview/settlement.js, design §9.5 and §12, owner
// decision Q35). The rule is mirrored over facts.poc, which carries the same fields as the report: on
// linux/arm64 there is no report, and the report's own form folds what each run did (node A3b).
import { codeReview } from './common.js';
import { fail } from './errors.js';
import { ABSTAIN_BY_CLAIM, ABSTAIN_BY_HOST } from './notices.js';
import { addedPragmas, observableHelp } from './observable.js';

const RUNNER_GATES = Object.freeze(['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']);
/** Runs that disprove a reproduction by themselves; `notRun` only ever follows a failure that did. */
const DISPROVING = Object.freeze(['pass', 'error', 'skip', 'missing', 'duplicate']);
/** The runner's causes a claim's own patch can bring about (design §12); the rest are this machine's. */
const CLAIM_CAUSES = Object.freeze(['step_timeout', 'deadline', 'oom', 'pids_limit', 'sandbox_died', 'killed_by_signal']);

const invalid = (reason) => ({ outcome: 'INVALID', bond: 'forfeited', award: 'none', reason });
const unreadable = (why) => fail('RUNNER_ANSWER_INVALID', why);

/**
 * A definitive answer holds what its gates say or it is no answer: a gate runs exactly when the ones before it
 * passed, so a missing one with none failed is a broken runner, as are a status other than the two, a decided
 * reproduction with no run facts, and an image it does not name. A pass needs all six to say so.
 */
function assertReadable(body) {
  const gates = body.gates;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) throw unreadable('It holds no gates.');
  for (const name of RUNNER_GATES) {
    const g = gates[name];
    if (g !== undefined && g?.status !== 'pass' && g?.status !== 'fail') throw unreadable(`Gate ${name} says neither pass nor fail.`);
  }
  for (const name of ['applies', 'testPathsOnly', 'build', 'reproduces']) {
    if (!gates[name]) throw unreadable(`Gate ${name} is missing, and no gate before it failed.`);
    if (gates[name].status === 'fail') break;
  }
  if (gates.reproduces?.status === 'pass' && (!gates.integrity || !gates.claimedObservable)) throw unreadable('The proof reproduced, and a later gate is missing.');
  if (gates.reproduces && !body.facts?.poc) throw unreadable('It decided the reproduction and holds no run facts.');
  if (!body.image?.ref) throw unreadable('It does not name the image it ran.');
}

/**
 * @param {Record<string, { status: string }>} gates - the runner's
 * @param {object} [poc] - facts.poc
 * @returns {null | { outcome: string, bond: string, award: string, reason: string }} null: no failed gate says it
 */
export function settlesAs(gates, poc) {
  const failed = (name) => gates[name]?.status === 'fail';
  const flags = poc?.integrity?.tamperFlags ?? [];
  if (flags.length > 0) {
    const kinds = [...new Set(flags.map((f) => f.kind))].sort().join(', ');
    return invalid(`a tamper flag on the lines the patch added (${kinds}), which settles INVALID even beside another failed check`);
  }
  if (failed('applies')) return invalid('poc.patch does not apply to the listed commit, or is over the listing\'s patch limits');
  if (failed('testPathsOnly')) return invalid('poc.patch touches a path outside paths.tests or inside paths.protected');
  if (failed('build')) return invalid('the build failed with the patch applied');
  if (failed('reproduces')) {
    const counts = poc?.runCounts ?? {};
    const onItsOwn = !poc || poc.testCount === 0 || DISPROVING.some((key) => counts[key] > 0);
    if (onItsOwn) return invalid('the proof did not reproduce: a test the patch added passed, errored, was skipped, went missing or appeared twice on a run, or the patch added none');
    const checks = codeReview.INTEGRITY_CHECKS.filter((c) => poc.integrity?.[c] === false);
    if (checks.length === 0) throw unreadable('The proof failed only through integrity, with no failed check.'); // the arbiters abstain on this too
    return { outcome: 'DUPLICATE', bond: 'returned', award: 'none', reason: `a failed integrity check (${checks.join(', ') || 'unnamed'}): bond back, no award, and no model is called. It says nothing of who caused it` };
  }
  if (gates.reproduces?.status === 'pass' && failed('integrity')) throw unreadable('The proof reproduced with a failed integrity check.');
  if (failed('claimedObservable')) return invalid('the tests finding.json names are not the ones that failed, or the observable is not in the recorded failure');
  return null;
}

/** Fixed words: a gate's own detail can quote the finding, and a reason is printed under --no-pack too. */
const LOCAL_REASONS = Object.freeze({
  finding: 'finding.json does not validate',
  inScope: 'an affected path is outside the stake\'s scope',
  report: 'report.md is missing, empty, too short or not text',
  applies: 'poc.patch is missing, is not a patch, or is over the listing\'s patch limit',
});

// What a runner calls a cause, a step, a code or a path, only when it looks like one.
const CODE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const PATH = /^(\/[A-Za-z0-9_.-]{1,64}){0,16}$/;
const codeOf = (value, fallback = 'UNKNOWN') => (typeof value === 'string' && CODE.test(value) ? value : fallback);

const gate = (name, status, detail, basis = 'local') => ({ name, status, basis, detail });

function stepOutput(steps, name) {
  const step = (steps ?? []).find((s) => s.name === name);
  if (!step) return '';
  return [step.stdout?.text, step.stderr?.text].filter(Boolean).join('\n');
}

const digestOf = (ref) => /@(sha256:[0-9a-f]{64})$/.exec(String(ref ?? ''))?.[1] ?? null;

/**
 * @param {object} o
 * @param {object[]} o.local - the gates decided here, before the runner
 * @param {object|null} o.answer - the runner's { status, body }, or null when it was not called
 * @param {object} o.spec
 * @param {Buffer} o.pocPatch
 * @param {object[]} o.lint
 * @param {object} o.priorFindings
 * @param {string[]} o.notes
 */
export function buildForecast({ local, answer, spec, pocPatch, lint, priorFindings, notes = [] }) {
  const gates = [...local];
  const base = {
    verdict: 'pass',
    gates,
    settlesAs: null,
    refusals: null,
    abstain: null,
    reportUnavailable: null,
    reportSha256: null,
    runner: null,
    image: null,
    compiler: null,
    tests: [],
    build: null,
    observable: null,
    lint,
    fix: null,
    priorFindings,
    notes,
  };
  const localSettles = () => {
    const s = local.find((g) => g.status === 'fail' && Object.hasOwn(LOCAL_REASONS, g.name));
    return s ? invalid(LOCAL_REASONS[s.name]) : null;
  };
  if (!answer) return { ...base, verdict: 'fail', settlesAs: localSettles() };

  const { status, body } = answer;
  if (status === 400) {
    const issues = Array.isArray(body?.issues) ? body.issues : [];
    return {
      ...base,
      verdict: 'refused',
      refusals: issues.map((i) => ({ code: codeOf(i?.code), path: typeof i?.path === 'string' && PATH.test(i.path) ? i.path : '', detail: String(i?.detail ?? '') })),
    };
  }
  base.runner = body.runner ?? null;
  base.image = body.image ?? null;
  // A gate not reached is absent: what is here is what the run decided, an abstention's too.
  const runnerGates = body.gates ?? {};
  for (const name of RUNNER_GATES) {
    const g = runnerGates[name];
    if (g) gates.push({ name, status: g.status, basis: g.basis ?? 'runner', detail: g.detail ?? null });
  }
  if (body.outcome === 'abstain') {
    const a = body.abstain ?? {};
    const claimCanCause = CLAIM_CAUSES.includes(a.cause);
    return {
      ...base,
      verdict: 'abstain',
      abstain: { cause: codeOf(a.cause, 'unknown'), step: codeOf(a.step, null), detail: a.detail ?? null, claimCanCause, cost: claimCanCause ? ABSTAIN_BY_CLAIM : ABSTAIN_BY_HOST },
    };
  }

  assertReadable(body);
  const poc = body.facts?.poc;
  base.compiler = body.facts?.compiler?.solc ?? null;
  base.fix = body.facts?.fix ?? null;
  base.tests = (poc?.tests ?? []).map((t) => ({ id: t.id, runs: t.runs, kind: t.kind, message: t.message ?? null }));
  base.reportUnavailable = body.reportUnavailable ?? null;
  base.reportSha256 = body.reportSha256 ?? null;
  if (runnerGates.build?.status === 'fail') {
    base.build = { compiler: base.compiler, pragmas: addedPragmas(pocPatch.toString('utf8')), output: stepOutput(body.steps, 'build') };
  }
  if (poc) base.observable = observableHelp(poc);
  const specDigest = digestOf(spec?.env?.image);
  const ranDigest = digestOf(body.image?.ref);
  if (ranDigest !== specDigest) {
    gates.push(gate('image', 'fail', `The runner reports ${body.image.ref}; the listing names ${spec.env.image}.`, 'runner'));
  }
  const anyFailed = gates.some((g) => g.status === 'fail');
  return { ...base, verdict: anyFailed ? 'fail' : 'pass', settlesAs: settlesAs(runnerGates, poc) ?? (anyFailed ? localSettles() : null) };
}

export { gate };

/**
 * The forecast with nothing that can quote the proof: no runner text, no recorded message, no test name, no build
 * output. Status, counts and codes stay. What --no-pack prints.
 */
export function withoutProofText(f) {
  return {
    ...f,
    gates: f.gates.map((g) => (g.name === 'listingSigned' ? g : { ...g, detail: null })),
    tests: f.tests.map((t, i) => ({ id: `test ${i + 1}`, runs: t.runs, kind: t.kind, message: null })),
    abstain: f.abstain ? { ...f.abstain, detail: null } : null,
    refusals: f.refusals ? f.refusals.map((i) => ({ ...i, detail: '' })) : null,
    build: f.build ? { compiler: f.build.compiler, pragmas: [], output: '' } : null,
    observable: null,
    lint: f.lint.map((l) => ({ code: l.code, detail: l.detail })),
    settlesAs: f.settlesAs,
    fix: null,
    notes: f.notes.filter((n) => !/^[A-Z_]+: /.test(n)),
  };
}
