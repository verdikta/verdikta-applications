// What lintObservable warns of, against what the runner's claimedObservable gate decides (design §10.1; node P13). The rule
// is the runner's, from a design review under owner decision Q38 (verdikta-arbiter code-runner/src/observable.js, node A3d):
// both fields are text and nothing follows a shell. The gate decides; the tool only warns, so what matters here is a hunter
// told to fix what's fine, or not warned of a real loss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { addedTests, functionName, lintObservable, TEST_FUNCTION_PREFIXES } from '../src/observable.js';
import { BASELINE, MATRIX, NO_TEXT, OBSERVABLE, RUNNER_PREFIXES, baselineOf, patchAdding, tableCases } from './helpers/observableTable.js';

/** The runner's table's `run`, with the tool's lint in place of the gate. */
function run(command, observable = OBSERVABLE, { added = ['test_drain'], known = BASELINE, patch = patchAdding(added) } = {}) {
  return lintObservable({ finding: { poc: { command, observable } }, pocPatch: patch, baseline: baselineOf(known) });
}

const codes = (warnings) => warnings.map((w) => w.code).sort();
const namesOf = (warnings, code) => warnings.find((w) => w.code === code)?.names ?? null;

/** A patch, from lines of Solidity. */
function patchOf(...lines) {
  return ['diff --git a/test/E.t.sol b/test/E.t.sol', 'new file mode 100644', '--- /dev/null', '+++ b/test/E.t.sol', `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n');
}

// A condition of the rule: the list is one constant, and it is the runner's.

test('the tool\'s prefix list is the runner\'s: the same six words, in the same form', () => {
  assert.deepEqual([...TEST_FUNCTION_PREFIXES], ['test', 'invariant', 'statefulFuzz', 'table', 'check', 'prove']);
  assert.deepEqual([...TEST_FUNCTION_PREFIXES], [...RUNNER_PREFIXES]);
  assert.equal(Object.isFrozen(TEST_FUNCTION_PREFIXES), true);
});

test('the prefix list is one constant: the static read of the patch uses it too', () => {
  const source = fs.readFileSync(new URL('../src/observable.js', import.meta.url), 'utf8');
  assert.equal(source.match(/statefulFuzz/g).length, 1, 'the words are written once in the code');
  for (const prefix of TEST_FUNCTION_PREFIXES) assert.deepEqual(addedTests(patchAdding([`${prefix}_x`, prefix])), [prefix, `${prefix}_x`].sort());
  assert.deepEqual(addedTests(patchAdding(['setUp', 'helper', 'Test_x'])), []);
});

// The rule's first part.

test('a plain forge test on a listing with a baseline test() does not warn', () => {
  assert.deepEqual(run('forge test', OBSERVABLE, { known: ['test', 'test_deposit'] }), []);
});

test('no prefix warns, in the command or the observable, unless the patch adds a test of that name', () => {
  for (const prefix of TEST_FUNCTION_PREFIXES) {
    assert.deepEqual(run(`forge test --mt ${prefix}`), [], prefix);
    assert.deepEqual(run('forge test', `test_drain: ${prefix} fails with "vault drained"`), [], prefix);
    // Not a name: so it does not stand in for one either.
    assert.deepEqual(codes(run(`forge test --mt ${prefix}`, `the ${prefix} fails with "vault drained"`)), ['NO_ADDED_TEST_NAMED'], prefix);
    // The patch adds a test of that name: then the word names it, and the baseline's of the same name is no other test.
    assert.deepEqual(run(`forge build --mt ${prefix}`, 'fails with "vault drained"', { added: [prefix] }), [], prefix);
  }
});

// The rule's second part.

test('in the command an identifier ending in $ is itself and what comes before it; in the observable, itself only', () => {
  const known = ['test', 'test_base'];
  assert.deepEqual(namesOf(run('forge test --mt \'^test_base$\'', OBSERVABLE, { known }), 'OTHER_TEST_NAMED'), ['test_base']);
  assert.deepEqual(run('forge test', 'test_drain and test_base$ fail with "vault drained"', { known }), []);
  assert.deepEqual(run('forge test --mt \'^test_drain$\'', 'fails with "vault drained"', { known }), []);
  assert.deepEqual(codes(run('forge test', '^test_drain$ fails with "vault drained"', { known })), ['NO_ADDED_TEST_NAMED']);
});

// The table: the tool and the runner, on each case.

for (const c of tableCases()) {
  test(`table: ${c.title}`, () => {
    const warnings = run(c.command, c.observable, { added: c.added, known: c.known });
    const other = c.runner.named.filter((n) => !c.added.includes(n));
    assert.deepEqual(namesOf(warnings, 'OTHER_TEST_NAMED'), other.length ? other : null, 'another test named');
    assert.equal(warnings.some((w) => w.code === 'NO_ADDED_TEST_NAMED'), !c.runner.named.some((n) => c.added.includes(n)), 'no added test named');
    // A pass is no warning at all; every row quotes, so nothing here is about the quote.
    assert.deepEqual(codes(warnings).filter((code) => code === 'NOTHING_QUOTED'), []);
    if (c.runner.status === 'pass') assert.deepEqual(warnings, []);
  });
}

for (const [what, finding, runner] of NO_TEXT) {
  test(`table: a finding with no text to read: ${what}`, () => {
    const warnings = lintObservable({ finding, pocPatch: patchAdding(['test_drain']), baseline: baselineOf(BASELINE) });
    if (runner.status === 'pass') assert.deepEqual(warnings, []);
    else assert.ok(warnings.length > 0, 'the runner fails it, so the tool warns');
  });
}

test('table: the runner\'s before-and-after matrix, in its form', () => {
  // The old read: every identifier of both fields, and every name known.
  const before = (command, observable, known, added) => {
    const tokens = new Set([...`${command}\n${observable}`.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].map((m) => m[0]));
    const names = new Set([...known, ...added]);
    return [...tokens].filter((t) => names.has(t)).sort();
  };
  for (const command of MATRIX.commands) {
    for (const observable of MATRIX.observables) {
      const warnings = run(command, observable);
      const old = before(command, observable, BASELINE, ['test_drain']);
      const otherWords = old.filter((n) => n !== 'test_drain' && !RUNNER_PREFIXES.includes(n));
      // A prefix never makes the difference, so only an ordinary name can.
      assert.deepEqual(namesOf(warnings, 'OTHER_TEST_NAMED'), otherWords.length ? otherWords : null, `${command} ${observable}`);
      assert.equal(warnings.some((w) => w.code === 'NO_ADDED_TEST_NAMED'), !old.includes('test_drain'), `${command} ${observable}`);
    }
  }
});

// The review focus: a patch's line that is no test, in a word the rule makes common. Each of these reads as an added test of
// that name if the read is loose, which hides a real loss: the runner sees no such test, names nothing, and the claim settles
// INVALID with the bond gone. No warning would be given.

for (const [what, lines] of [
  ['an internal helper', ['contract E {', '  function test() internal { }', '  function test_drain() public { }', '}']],
  ['a private helper', ['contract E {', '  function test(uint256 a) private view returns (uint256) { return a; }', '  function test_drain() public { }', '}']],
  ['an interface\'s declaration', ['interface I {', '  function test() external;', '}', 'contract E { function test_drain() public { } }']],
  ['a declaration with no body', ['abstract contract A {', '  function test() public virtual;', '}', 'contract E { function test_drain() public { } }']],
  ['a helper written over several lines', ['contract E {', '  function test(', '    uint256 a', '  ) internal {', '  }', '  function test_drain() public { }', '}']],
  ['a line comment', ['contract E {', '  // function test() public { }', '  function test_drain() public { }', '}']],
  ['a comment after code', ['contract E {', '  uint256 x; // function test() public { }', '  function test_drain() public { }', '}']],
  ['a block comment', ['contract E {', '  /* function test() public { }', '     function test() public { } */', '  function test_drain() public { }', '}']],
  ['a string', ['contract E {', '  string s = "function test() public { }";', '  function test_drain() public { }', '}']],
]) {
  test(`what the patch adds that is no test does not make the word a name: ${what}`, () => {
    const patch = patchOf(...lines);
    assert.deepEqual(addedTests(patch), ['test_drain']);
    assert.deepEqual(codes(run('forge test', 'the vault is drained: "vault drained"', { patch })), ['NO_ADDED_TEST_NAMED']);
    assert.deepEqual(namesOf(run('forge test', 'the vault is drained: "vault drained"', { patch }), 'NO_ADDED_TEST_NAMED'), ['test_drain']);
    assert.deepEqual(run('forge test --mt test_drain', 'fails with "vault drained"', { patch }), []);
  });
}

test('a helper with another prefix is the same: the word check in prose is no name', () => {
  const patch = patchOf('contract E {', '  function check(uint256 a) internal pure { assert(a == 0); }', '  function test_drain() public { check(1); }', '}');
  assert.deepEqual(codes(run('forge test', 'the check fails with "vault drained"', { patch })), ['NO_ADDED_TEST_NAMED']);
});

// And the other direction: a test the read must not miss, or the hunter is told to fix what's fine.

for (const [what, lines] of [
  ['a test of its own name, public', ['contract E {', '  function test() public { assert(false); }', '}']],
  ['external and view', ['contract E {', '  function test() external view { assert(false); }', '}']],
  ['a fuzz test', ['contract E {', '  function test(uint256 a) public { assert(a == 0); }', '}']],
  ['with a modifier and a return', ['contract E {', '  function test() public only(1) returns (uint256) { assert(false); }', '}']],
  ['written over several lines', ['contract E {', '  function test(', '    uint256 a', '  )', '    public', '  {', '    assert(a == 0);', '  }', '}']],
  ['the name on the next line', ['contract E {', '  function', '    test() public { assert(false); }', '}']],
  ['after a comment that closes on the line', ['contract E {', '  /* first */ function test() public { assert(false); }', '}']],
  ['after a string holding a comment', ['contract E {', '  string s = "http://x"; function test() public { assert(false); }', '}']],
  ['the second on a line', ['contract E { function helper() internal { } function test() public { assert(false); } }']],
]) {
  test(`a test the patch adds is read: ${what}`, () => {
    const patch = patchOf(...lines);
    assert.deepEqual(addedTests(patch), ['test']);
    assert.deepEqual(run('forge test', 'fails with "vault drained"', { patch, known: ['test', 'test_deposit'] }), []);
  });
}

test('every test on a line is read', () => {
  assert.deepEqual(addedTests(patchOf('contract E { function test_a() public { } function test_b() public { } }')), ['test_a', 'test_b']);
});

test('a baseline test of the same name as one the patch adds is the added one, by name, as in the runner', () => {
  assert.deepEqual(run('forge test --mt test_deposit', 'fails with "vault drained"', { added: ['test_deposit'] }), []);
});

test('only added lines of Solidity are read', () => {
  const removed = ['diff --git a/test/E.t.sol b/test/E.t.sol', '--- a/test/E.t.sol', '+++ b/test/E.t.sol', '@@ -1,2 +1,1 @@', '-  function test_old() public { }', '   function test_kept() public { }', ''].join('\n');
  assert.deepEqual(addedTests(removed), []);
  const other = ['diff --git a/notes.md b/notes.md', '--- a/notes.md', '+++ b/notes.md', '@@ -0,0 +1,1 @@', '+function test_doc() public { }', ''].join('\n');
  assert.deepEqual(addedTests(other), []);
});

// What the tool can't match, each stated in the pull request: it reads a patch and text, and forge's list of tests is the
// runner's. These pin what the tool says, so a change here is a change to what the pull request states.

test('the tool can\'t see the recorded failure: with nothing quoted it warns, though the gate may pass', () => {
  // The runner passes this when the whole message is in the observable as written.
  assert.deepEqual(codes(run('forge test', 'test_drain: vault drained')), ['NOTHING_QUOTED']);
  // And a quote that is not in the failure fails the gate, with no warning here.
  assert.deepEqual(run('forge test', 'test_drain shows "no such text"'), []);
});

test('the tool reads a test as added by its name in the patch, not by forge\'s list', () => {
  // A new contract inheriting a baseline test: forge reports it under the new contract, so the runner counts it as added.
  const inherits = patchOf('contract E is VaultTest { function test_drain() public { assert(false); } }');
  assert.deepEqual(namesOf(run('forge test --mt test_deposit', OBSERVABLE, { patch: inherits }), 'OTHER_TEST_NAMED'), ['test_deposit']);
  // A baseline test's declaration edited: the same identity, so the runner does not count it as added.
  const edited = ['diff --git a/test/Vault.t.sol b/test/Vault.t.sol', '--- a/test/Vault.t.sol', '+++ b/test/Vault.t.sol', '@@ -1,1 +1,1 @@', '-  function test_deposit() public { }', '+  function test_deposit() external { }', ''].join('\n');
  assert.deepEqual(run('forge test --mt test_deposit', 'fails with "vault drained"', { patch: edited }), []);
  // check and prove are forge's only with symbolic entry points on, which the listing's config decides.
  assert.deepEqual(run('forge test --mt check_x', 'fails with "vault drained"', { added: ['check_x'] }), []);
});

// The docs.

test('the warnings say the rule, and read nothing as a shell would', () => {
  const noName = run('forge test', 'the vault is drained: "vault drained"');
  const detail = noName.find((w) => w.code === 'NO_ADDED_TEST_NAMED').detail;
  for (const prefix of TEST_FUNCTION_PREFIXES) assert.match(detail, new RegExp(`\\b${prefix}\\b`), prefix);
  const other = run('forge test --mp test/test_deposit/x.t.sol').find((w) => w.code === 'OTHER_TEST_NAMED').detail;
  assert.match(other, /wherever/);
  // Commit's notices name nothing of the patch: the details are the tool's own words.
  assert.doesNotMatch(detail, /test_drain/);
  assert.doesNotMatch(other, /test_deposit/);
});

test('the source and the README state the rule', () => {
  const source = fs.readFileSync(new URL('../src/observable.js', import.meta.url), 'utf8');
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## The hunter tool'), readme.indexOf('## The client'));
  for (const [where, text] of [['source', source], ['README', section]]) {
    assert.match(text, /nothing follows a shell/, where);
    assert.match(text, /prefix/, where);
    assert.match(text, /ending in `\$`/, where);
    assert.match(text, /itself only/, where);
  }
  for (const prefix of TEST_FUNCTION_PREFIXES) assert.match(section, new RegExp(`\`${prefix}\``), prefix);
});

test('functionName is the runner\'s', () => {
  assert.equal(functionName('test/x.t.sol > X > test_a(uint256)'), 'test_a');
  assert.equal(functionName('test_a'), 'test_a');
});
