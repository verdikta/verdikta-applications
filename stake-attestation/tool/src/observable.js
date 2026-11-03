// Helping a hunter write poc.command and poc.observable the way the runner's claimedObservable gate reads them
// (verdikta-arbiter code-runner/src/observable.js, node A3a):
//
//   - finding.json names the test by function name, in poc.command or poc.observable, and only tests the
//     patch added;
//   - each double-quoted fragment of the observable appears in the recorded failure on every run;
//   - with nothing quoted, the recorded message appears in the observable as written.
//
// The gate is the runner's and is what counts. Here: a static read of the patch that warns before anything runs
// (a test added in some form this read misses would only cost a warning), and after a run, a line built from
// what was recorded.

// forge's test kinds (the runner's TEST_FUNCTION).
const ADDED_TEST = /^\+.*?\bfunction\s+((?:test|invariant|statefulFuzz|table|check|prove)[A-Za-z0-9_$]*)\s*\(/;
const PRAGMA = /^\+\s*pragma\s+solidity\s+([^;]+);/;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const QUOTED = /"([^"]*)"/g;

/** A test identity's function name: `<file> > <Contract> > name(args)` → name. */
export function functionName(id) {
  const sig = String(id).split(' > ').pop();
  const open = sig.indexOf('(');
  return open < 0 ? sig : sig.slice(0, open);
}

const squash = (text) => String(text).replace(/\s+/g, ' ').trim();

function addedLinesOfSolidity(patch) {
  const out = [];
  let inSolidity = false;
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('+++ ')) {
      inSolidity = /\.sol\s*$/.test(line);
      continue;
    }
    if (inSolidity && line.startsWith('+')) out.push(line);
  }
  return out;
}

/** The test functions the patch's added lines declare. */
export function addedTests(patch) {
  const names = new Set();
  for (const line of addedLinesOfSolidity(patch)) {
    const m = ADDED_TEST.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

/** The pragmas the patch's added lines state. */
export function addedPragmas(patch) {
  const found = new Set();
  for (const line of addedLinesOfSolidity(patch)) {
    const m = PRAGMA.exec(line);
    if (m) found.add(squash(m[1]));
  }
  return [...found];
}

/**
 * What a static read can say of a finding against its patch. Advisory: the runner decides.
 * @param {{ finding: object, pocPatch: Buffer|string, baseline?: object }} o
 * @returns {{ code: 'NO_ADDED_TEST_NAMED'|'OTHER_TEST_NAMED'|'NOTHING_QUOTED', detail: string, names?: string[] }[]} `names`,
 *   apart from the text: they come from the patch or the finding, and only check prints them

 */
export function lintObservable({ finding, pocPatch, baseline }) {
  const out = [];
  const command = String(finding?.poc?.command ?? '');
  const observable = String(finding?.poc?.observable ?? '');
  const added = new Set(addedTests(Buffer.isBuffer(pocPatch) ? pocPatch.toString('utf8') : pocPatch));
  const known = new Set((baseline?.tests ?? []).map((t) => functionName(t.id)));
  const tokens = new Set([...`${command}\n${observable}`.matchAll(IDENTIFIER)].map((m) => m[0]));
  const others = [...tokens].filter((t) => known.has(t) && !added.has(t)).sort();
  if (![...tokens].some((t) => added.has(t))) {
    out.push({ code: 'NO_ADDED_TEST_NAMED', detail: 'Name a test the patch adds in poc.command or poc.observable; otherwise claimedObservable fails, and that settles INVALID.', names: [...added] });
  }
  if (others.length) out.push({ code: 'OTHER_TEST_NAMED', detail: 'A test is named that the patch did not add; claimedObservable fails on any such name.', names: others });
  const quoted = [...observable.matchAll(QUOTED)].map((m) => squash(m[1])).filter((f) => f !== '');
  if (quoted.length === 0) out.push({ code: 'NOTHING_QUOTED', detail: 'Quote what forge prints, in double quotes: each quoted fragment must appear in the recorded failure on every run. Without a quote, the whole recorded message must appear in the observable as written.' });
  return out;
}

/** A fragment a double-quoted part of an observable can hold, from a recorded message. */
function quotable(message) {
  const parts = String(message).split('"').map(squash).filter(Boolean);
  const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), '');
  return longest.length > 200 ? longest.slice(0, 200).trim() : longest;
}

/**
 * Lines that follow the rule, from what a run recorded (facts.poc).
 * @param {object} poc - the runner's facts.poc
 * @returns {{ suggestions: string[], hints: string[], recorded: { test: string, message: string|null }[] }}
 */
export function observableHelp(poc) {
  const suggestions = [];
  const hints = [];
  const recorded = [];
  const reported = new Map((poc?.report?.tests ?? []).map((t) => [t.id, t]));
  for (const t of poc?.tests ?? []) {
    const name = functionName(t.id);
    recorded.push({ test: name, message: t.message ?? null });
    if (t.kind !== 'assertion' || !t.message) continue;
    const fragment = quotable(t.message);
    if (fragment) suggestions.push(`${name} fails with "${fragment}"`);
    if (reported.get(t.id)?.message === null) hints.push(`${name}: its message changes between runs. Quote only the part that stays the same: a quoted fragment must appear on every run.`);
  }
  return { suggestions, hints, recorded };
}
