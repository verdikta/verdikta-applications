// Helping a hunter write poc.command and poc.observable the way the runner's claimedObservable gate reads them
// (verdikta-arbiter code-runner/src/observable.js, nodes A3a and A3d; design §10.1):
//
//   - finding.json names the test by function name, in poc.command or poc.observable, and only tests the
//     patch added;
//   - both fields are text. The runner never runs poc.command, so what counts is what the text spells, and
//     nothing follows a shell: a name counts wherever it is spelled, in a filter, a path or a quote, and a name
//     built at run time is not read;
//   - a word that is exactly one of forge's test-function prefixes (TEST_FUNCTION_PREFIXES) names nothing in
//     either field, unless the patch adds a test of that name: a plain `forge test` names nothing, whatever the
//     baseline holds. Every other identifier is read wherever it is;
//   - in poc.command an identifier ending in `$` counts as itself and as what comes before it, so `^test_x$`
//     names test_x. In poc.observable it counts as itself only: `$` belongs to a Solidity identifier there;
//   - each double-quoted fragment of the observable appears in the recorded failure on every run;
//   - with nothing quoted, the recorded message appears in the observable as written.
//
// The gate is the runner's and is what counts. Here: a static read of the patch that warns before anything runs,
// and after a run, a line built from what was recorded.
//
// The read is one line at a time, by design (a design review under owner decision Q38): an added line of a Solidity
// file with `function` and a name under a test-function prefix. It does not read Solidity, so it can't tell a test
// from an internal helper, an interface's declaration, a comment or a string, and it can't see forge's list of tests.
// The tool only warns, and the check command with a runner gives the gate's answer. So:
//
//   - a word that is exactly a prefix never satisfies this lint by itself, though the gate counts it when forge ran it
//     as a test the patch added. Whether forge runs a function called `check` or `test` is what a static read can't tell,
//     so when the patch declares one and the text names no longer added name, NO_ADDED_TEST_NAMED says that. This is
//     the one place the lint differs from the gate on purpose;
//   - a longer name is taken as the patch's test on the read's word. Where that is wrong the lint is too, and these are
//     stated limits with check as the answer: a helper, an interface's declaration or a comment under a longer name; a
//     name on the line after `function`, or the second test on a line; a test inherited from elsewhere; a baseline
//     test's declaration edited; and `check` and `prove`, which are forge's only with symbolic entry points on.
//
// test/helpers/observableTable.js holds the runner's table, with what the runner answers on each case, and
// test/observable.test.js holds the tool to it.

/**
 * forge's test-function prefixes, the one list here. The runner's forge.js TEST_FUNCTION_PREFIXES has the same six words in
 * the same form; this repo can't import it, so test/observable.test.js pins them.
 */
export const TEST_FUNCTION_PREFIXES = Object.freeze(['test', 'invariant', 'statefulFuzz', 'table', 'check', 'prove']);

const ADDED_TEST = new RegExp(`^\\+.*?\\bfunction\\s+((?:${TEST_FUNCTION_PREFIXES.join('|')})[A-Za-z0-9_$]*)\\s*\\(`);
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

/** The identifiers a text spells. */
const identifiers = (text) => [...text.matchAll(IDENTIFIER)].map((m) => m[0]);

/** The identifiers poc.command spells: one ending in `$` is also what comes before it, a regex's end. */
const commandIdentifiers = (command) => identifiers(command).flatMap((t) => (t.endsWith('$') ? [t, t.replace(/\$+$/, '')] : [t]));

/** A field of poc as the runner takes it: text, or nothing to read. */
const textOf = (value) => (typeof value === 'string' ? value : '');

function addedLinesOfSolidity(patch) {
  const out = [];
  let inSolidity = false;
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('+++ ')) {
      inSolidity = /\.sol"?\s*$/.test(line);
      continue;
    }
    if (inSolidity && line.startsWith('+')) out.push(line);
  }
  return out;
}

/** The functions under a test-function prefix that the patch's added lines declare, a line at a time: see the top of this file. */
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
  const command = textOf(finding?.poc?.command);
  const observable = textOf(finding?.poc?.observable);
  const added = new Set(addedTests(Buffer.isBuffer(pocPatch) ? pocPatch.toString('utf8') : pocPatch));
  // A prefix alone is no other test's name.
  const known = new Set((baseline?.tests ?? []).map((t) => functionName(t.id)).filter((n) => !TEST_FUNCTION_PREFIXES.includes(n)));
  const spelled = new Set([...commandIdentifiers(command), ...identifiers(observable)]);
  const others = [...spelled].filter((t) => known.has(t) && !added.has(t)).sort();
  // A prefix alone never satisfies the lint: this read can't tell whether forge runs a function of that name.
  const isPrefix = (t) => TEST_FUNCTION_PREFIXES.includes(t);
  const declared = [...spelled].filter((t) => added.has(t));
  if (!declared.some((t) => !isPrefix(t))) {
    if (declared.length) {
      out.push({ code: 'NO_ADDED_TEST_NAMED', detail: 'The patch declares a function called this, and poc.command and poc.observable name no longer added name. The runner counts this word only if forge ran it as a test the patch added, and a static read can\'t tell: it could be a helper, an interface\'s declaration or a comment. Name the test by a longer name, or run check with a runner to see the gate\'s answer.', names: declared.sort() });
    } else {
      out.push({ code: 'NO_ADDED_TEST_NAMED', detail: `Name a test the patch adds in poc.command or poc.observable; otherwise claimedObservable fails, and that settles INVALID. A word that is exactly one of forge's test prefixes (${TEST_FUNCTION_PREFIXES.join(', ')}) names nothing, unless the patch adds a test of that name: a plain forge test names no test.`, names: [...added] });
    }
  }
  if (others.length) out.push({ code: 'OTHER_TEST_NAMED', detail: 'A test is named that the patch did not add; claimedObservable fails on any such name. Both fields are read as text: a name counts wherever it is spelled, in a filter, a path or a quote.', names: others });
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
