// The cases the tool's observable lint and the runner's claimedObservable gate are held to, as test data and in the
// form of the runner's own table (verdikta-arbiter f1adbed, code-runner/test/unit/observable.test.js): `[what, command]`
// rows, with `run(command, observable, { added, known })` beside them in test/observable.test.js.
//
// Each group says what the runner answers: `status` and `named` are claimedObservable's own, for a PoC that reproduced,
// each added test failing with `MESSAGE`. No test here runs the runner: the tool can't import from the arbiter repo, so the
// answers are written down, and the pull request that brought this file says how they were compared with the runner.
//
// `from` says where a group came from: the runner's table, or added here for a part of the rule that table only implies.
//
// `stated: true` marks the one place the tool differs from the runner on purpose (a design review under owner decision
// Q38): a real added test called exactly a prefix, named only by that word. The runner passes, and the tool warns, because a
// static read can't tell whether forge runs a function of that name. Every other row matches the runner.

/** forge's test-function prefixes, as code-runner/src/forge.js TEST_FUNCTION_PREFIXES has them at f1adbed. */
export const RUNNER_PREFIXES = Object.freeze(['test', 'invariant', 'statefulFuzz', 'table', 'check', 'prove']);

export const MESSAGE = 'vault drained';
/** A listing's tests: every word the rule is about, and an ordinary test. */
export const BASELINE = Object.freeze([...RUNNER_PREFIXES, 'test_deposit']);
export const OBSERVABLE = 'test_drain fails at the committed hash with "vault drained"';
const ADDED = Object.freeze(['test_drain']);

// `named` is sorted, as the gate returns it.
const passes = (...named) => ({ status: 'pass', named: named.sort() });
const fails = (...named) => ({ status: 'fail', named: named.sort() });

const everyPrefix = (row) => RUNNER_PREFIXES.flatMap(row);

/**
 * Each row is `[what, command, observable = OBSERVABLE, runner = the group's]`. A group's `added` and `known` are the
 * `run` options of the runner's table: the tests the patch adds, and the baseline's.
 */
export const TABLE = Object.freeze([
  {
    group: 'a word that is one of forge\'s prefixes names nothing in the command',
    from: 'runner',
    runner: passes('test_drain'),
    rows: [
      ['the plain command', 'forge test --match-test test_drain'],
      ['a plain forge test', 'forge test'],
      ['the word as a filter', 'forge test --mt test'],
      ['the word as a filter, with =', 'forge test --mt=test'],
      ['the word as an anchored filter', 'forge test --mt \'^test$\''],
      ['a path', 'forge test --match-path test/x.t.sol'],
      ['a path and a filter', 'forge test --match-path test/x.t.sol --match-test test_drain'],
      ['forge\'s shorthand for a path', 'forge test test/x.t.sol'],
      ['another directory first', 'cd x && forge test'],
      ['a directory called test first', 'cd test && forge test'],
      ['an environment variable', 'FOUNDRY_PROFILE=x forge test'],
      ['a flag the listing\'s grammar refuses', 'forge test --mt test_drain --json'],
      ['a substitution', 'forge test --fork-url $(cat url) --match-path test/x.t.sol'],
      ['a build first', 'forge build --skip test && forge test'],
      ['every word at once', 'forge test --match-path \'test/my test/x.t.sol\' --match-contract ExploitTest --no-match-test x --fuzz-runs 256 --isolate -vvvvv'],
    ],
  },
  {
    group: 'a word that is one of forge\'s prefixes names nothing in the observable',
    from: 'runner',
    runner: passes('test_drain'),
    rows: [
      ['test', 'forge test', 'test_drain: the test fails with "vault drained"'],
      ['test, called', 'forge test', 'test_drain and test() fail with "vault drained"'],
      ['check', 'forge test', 'test_drain: the check fails with "vault drained"'],
      ['invariant', 'forge test', 'test_drain: the invariant fails with "vault drained"'],
      ['table', 'forge test', 'test_drain: the table is wrong: "vault drained"'],
      ['prove', 'forge test', 'test_drain: these prove it: "vault drained"'],
      ['statefulFuzz', 'forge test', 'test_drain: statefulFuzz fails with "vault drained"'],
    ],
  },
  {
    group: 'each prefix is named exactly, and only that word',
    from: 'runner',
    runner: passes('test_drain'),
    rows: everyPrefix((p) => [
      [`${p} as a filter`, `forge test --mt ${p}`],
      [`${p} in prose`, 'forge test', `test_drain: ${p} fails with "vault drained"`],
      // Case and spelling are the text's: `Test` is no test here, and no prefix either.
      [`${p}, in capitals`, `forge test --mt ${p.toUpperCase()}`],
    ]),
  },
  ...RUNNER_PREFIXES.map((p) => ({
    group: `a longer name is a test: ${p}_x`,
    from: 'runner',
    known: [`${p}_x`],
    runner: fails(`${p}_x`, 'test_drain'),
    rows: [
      ['in the command', `forge test --mt ${p}_x`],
      ['in the observable', 'forge test', `test_drain and ${p}_x fail with "vault drained"`],
    ],
  })),
  {
    group: 'a finding naming another baseline test fails, in the command',
    from: 'runner',
    runner: fails('test_deposit', 'test_drain'),
    rows: [
      ['--match-test', 'forge test --match-test test_deposit'],
      ['--mt', 'forge test --mt test_deposit'],
      ['with =', 'forge test --match-test=test_deposit'],
      ['quoted', 'forge test --match-test \'test_deposit\''],
      ['double-quoted', 'forge test --match-test "test_deposit"'],
      ['anchored', 'forge test --match-test \'^test_deposit$\''],
      ['beside the added test', 'forge test --match-test \'test_drain|test_deposit\''],
      ['--no-match-test', 'forge test --no-match-test test_deposit'],
      ['--match-contract', 'forge test --match-contract test_deposit'],
      ['as a path', 'forge test --match-path test_deposit'],
      ['inside a path', 'forge test --match-path test/test_deposit/x.t.sol'],
      ['as an argument', 'forge test test_deposit'],
      ['as a flag forge does not have', 'forge test --test_deposit'],
      ['after a separator', 'forge test;forge test --mt test_deposit'],
      ['inside a substitution', 'forge test --mt $(printf test_deposit)'],
      ['inside ANSI-C quoting', 'forge test --mt $\'test_drain|\\\' --mp test_deposit\''],
      ['after a quote left open', 'forge test --mt \'test_drain test_deposit'],
      ['in another command', 'npx hardhat test --grep test_deposit'],
    ],
  },
  {
    group: 'a finding naming another baseline test fails, in the observable',
    from: 'runner',
    runner: fails('test_deposit', 'test_drain'),
    rows: [
      ['as the subject', 'forge test', 'test_deposit fails with "vault drained"', fails('test_deposit')],
      ['beside the added test', 'forge test', 'test_drain and test_deposit fail with "vault drained"'],
      ['called', 'forge test', 'VaultTest.test_deposit() reverts, then test_drain fails with "vault drained"'],
      ['in a quote', 'forge test', 'test_drain fails with "vault drained" in "test_deposit"'],
    ],
  },
  {
    group: 'a command that says only forge test, and no added name, names nothing',
    from: 'runner',
    runner: fails(),
    rows: [
      ['a plain forge test', 'forge test', 'the vault is drained in one call: "vault drained"'],
      ['the word as a filter', 'forge test --mt test', 'the test fails: "vault drained"'],
      ['a path', 'forge test --match-path test/x.t.sol', 'the invariant is broken: "vault drained"'],
    ],
  },
  {
    group: 'a test the patch added is named wherever the text spells it, and a prefix that is one counts',
    from: 'runner',
    stated: true,
    added: ['test'],
    runner: passes('test'),
    rows: [
      ['in forge test', 'forge test', 'fails with "vault drained"'],
      ['in a path', 'forge test --match-path test/x.t.sol', 'fails with "vault drained"'],
      ['in prose', 'forge build', 'the test fails with "vault drained"'],
    ],
  },
  {
    group: 'a test the patch added and a prefix that is one, nowhere in the text',
    from: 'runner',
    added: ['test'],
    runner: fails(),
    rows: [['nowhere in the text', 'forge build', 'fails with "vault drained"']],
  },
  {
    group: 'a test the patch added, beside another',
    from: 'runner',
    added: ['test', 'test_drain'],
    messages: { test_drain: 'other' },
    runner: passes('test', 'test_drain'),
    rows: [['its message is the one quoted', 'forge test', 'test_drain fails with "other"']],
  },
  {
    group: 'a name in a path counts for an added test',
    from: 'runner',
    runner: passes('test_drain'),
    rows: [['in a path', 'forge test --mp test/test_drain.t.sol', 'fails with "vault drained"']],
  },
  {
    group: '`$` in the observable belongs to the identifier: an added test_balance$ beside a baseline test_balance',
    from: 'runner',
    added: ['test_balance$'],
    known: ['test', 'test_balance', 'test_base'],
    runner: passes('test_balance$'),
    rows: [
      ['named in the observable', 'forge test', 'test_balance$() fails with "vault drained"'],
      // In the command it counts as itself too: a name ending in `$` is also the name before it, so this one names both.
      ['named in the command', 'forge test --mt test_balance$', 'fails with "vault drained"', fails('test_balance', 'test_balance$')],
    ],
  },
  {
    group: '`$` in the command is also a regex\'s end: a baseline test anchored',
    from: 'runner',
    known: ['test', 'test_balance', 'test_base'],
    runner: fails('test_base', 'test_drain'),
    rows: [
      ['in quotes', 'forge test --mt \'^test_base$\''],
      ['with =', 'forge test --mt=^test_base$'],
    ],
  },
  {
    group: '`$` in the command is also a regex\'s end: an added test anchored',
    from: 'runner',
    runner: passes('test_drain'),
    rows: [['anchored', 'forge test --mt \'^test_drain$\'', 'fails with "vault drained"']],
  },
  {
    group: 'a shell is out of scope: a name counts when it is spelled, and nothing is evaluated',
    from: 'runner',
    runner: passes('test_drain'),
    rows: [
      ['spelled in pieces', 'forge test --mt te""st_deposit'],
      ['built at run time', 'forge test --mt $(printf te; printf st_deposit)'],
      ['a pattern that would match it', 'forge test --mt \'test_dep.*\''],
    ],
  },
  // What the runner's table implies, spelled out.
  ...RUNNER_PREFIXES.map((p) => ({
    group: `a prefix the patch adds as a test counts: ${p}`,
    from: 'here',
    stated: true,
    added: [p],
    runner: passes(p),
    rows: [
      ['in the command', `forge build --mt ${p}`, 'fails with "vault drained"'],
      ['anchored in the command', `forge build --mt '^${p}$'`, 'fails with "vault drained"'],
      ['in the observable', 'forge build', `${p}: fails with "vault drained"`],
    ],
  })),
  ...RUNNER_PREFIXES.map((p) => ({
    group: `a prefix the patch adds as a test, nowhere in the text: ${p}`,
    from: 'here',
    added: [p],
    runner: fails(),
    rows: [['nowhere', 'forge build', 'fails with "vault drained"']],
  })),
  {
    group: '`$` in the observable is itself only',
    from: 'here',
    runner: passes('test_drain'),
    rows: [
      ['a baseline name, then $', 'forge test', 'test_drain and test_deposit$ fail with "vault drained"'],
      ['$, then a baseline name', 'forge test', 'test_drain and $test_deposit fail with "vault drained"'],
    ],
  },
  {
    group: '`$` in the command: only the end of an identifier is taken off',
    from: 'here',
    runner: fails('test_deposit', 'test_drain'),
    rows: [
      ['more than one', 'forge test --mt \'test_deposit$$\''],
      ['at the front, it stays', 'forge test --mt $test_deposit', OBSERVABLE, passes('test_drain')],
      ['alone', 'forge test --mt $ --mp $$', OBSERVABLE, passes('test_drain')],
    ],
  },
  {
    group: 'a baseline test whose name is a prefix and a `$` is no prefix',
    from: 'here',
    known: ['test', 'test$'],
    runner: fails('test$', 'test_drain'),
    rows: [
      ['in the command', 'forge test --mt \'test$\''],
      ['in the observable', 'forge test', 'test_drain and test$ fail with "vault drained"'],
    ],
  },
]);

/** Finding shapes with no text to read, as `[what, finding, runner]`. */
export const NO_TEXT = Object.freeze([
  ['no poc', {}, fails()],
  ['no observable', { poc: { command: 'forge test --mt test_drain' } }, fails()],
  // No command: the observable alone can name the test.
  ['no command', { poc: { observable: OBSERVABLE } }, passes('test_drain')],
  ['a command that is no text', { poc: { command: 42, observable: OBSERVABLE } }, passes('test_drain')],
  // Added here: text only counts when it is text.
  ['a command that would spell a baseline test if it were made text', { poc: { command: ['test_deposit'], observable: OBSERVABLE } }, passes('test_drain')],
  ['an observable that would spell the added test if it were made text', { poc: { command: 'forge test', observable: ['test_drain "vault drained"'] } }, fails()],
]);

/** The runner's before-and-after matrix: what passed before A3d still passes, but for a baseline test anchored in the command. */
export const MATRIX = Object.freeze({
  commands: ['forge test', 'forge test --mt test_drain', 'forge test --mt test', 'forge test --mt test_deposit', 'forge test --mp test/test_drain.t.sol', 'cd x && forge test', '', 'test_drain'],
  observables: [OBSERVABLE, 'fails with "vault drained"', 'test_drain shows "no such text"', 'test_deposit fails with "vault drained"', 'test: "vault drained"', 'test_drain: the test fails with "vault drained"'],
});

/** Every row of TABLE, with its options filled in. */
export function tableCases() {
  return TABLE.flatMap((g) => g.rows.map(([what, command, observable = OBSERVABLE, runner = g.runner]) => ({
    title: `${g.group}: ${what}`,
    from: g.from,
    stated: g.stated ?? false,
    command,
    observable,
    added: g.added ?? ADDED,
    known: g.known ?? BASELINE,
    messages: g.messages ?? {},
    runner,
  })));
}

/** A patch that adds these tests in a new file. */
export function patchAdding(names) {
  return [
    'diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/test/Exploit.t.sol',
    `@@ -0,0 +1,${names.length + 2} @@`,
    '+contract ExploitTest {',
    ...names.map((n) => `+  function ${n}() public { assert(false); }`),
    '+}',
    '',
  ].join('\n');
}

/** A baseline holding tests of these names. */
export function baselineOf(names) {
  return { tests: names.map((n) => ({ id: `test/Vault.t.sol > VaultTest > ${n}()` })) };
}
