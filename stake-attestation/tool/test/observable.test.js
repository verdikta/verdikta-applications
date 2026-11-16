// What lintObservable warns of, against what the runner's claimedObservable gate decides (design §10.1; node P13). The rule
// is the runner's, from a design review under owner decision Q38 (verdikta-arbiter code-runner/src/observable.js, node A3d):
// both fields are text and nothing follows a shell. The gate decides; the tool only warns, from a one-line read of the patch
// that does not read Solidity (a second design review under Q38). What matters here is the text half agreeing with the
// runner, an ordinary honest PoC getting no false warning, and a word a static read can't vouch for never hiding a real loss.
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
const detailOf = (warnings, code) => warnings.find((w) => w.code === code)?.detail ?? null;
const CANT_TELL = /a static read can't tell/;

/** A new file's patch, from lines of Solidity. */
function patchOf(...lines) {
  return ['diff --git a/test/E.t.sol b/test/E.t.sol', 'new file mode 100644', '--- /dev/null', '+++ b/test/E.t.sol', `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n');
}

// A condition of the rule: the list is one constant, and it is the runner's.

test('the tool\'s prefix list is the runner\'s: the same six words, in the same form', () => {
  assert.deepEqual([...TEST_FUNCTION_PREFIXES], ['test', 'invariant', 'statefulFuzz', 'table', 'check', 'prove']);
  assert.deepEqual([...TEST_FUNCTION_PREFIXES], [...RUNNER_PREFIXES]);
  assert.equal(Object.isFrozen(TEST_FUNCTION_PREFIXES), true);
});

test('the prefix list is one constant: the read of the patch uses it too', () => {
  const source = fs.readFileSync(new URL('../src/observable.js', import.meta.url), 'utf8');
  assert.equal(source.match(/statefulFuzz/g).length, 1, 'the words are written once in the code');
  for (const prefix of TEST_FUNCTION_PREFIXES) assert.deepEqual(addedTests(patchAdding([`${prefix}_x`, prefix])), [prefix, `${prefix}_x`].sort());
  assert.deepEqual(addedTests(patchAdding(['setUp', 'helper', 'Test_x'])), []);
});

// The rule's first part.

test('a plain forge test on a listing with a baseline test() does not warn, and does not make that test count as named', () => {
  assert.deepEqual(run('forge test', OBSERVABLE, { known: ['test', 'test_deposit'] }), []);
  // Nor does it stand in for the added test: the word is no name.
  const warnings = run('forge test', 'the vault is drained: "vault drained"', { known: ['test', 'test_deposit'] });
  assert.deepEqual(codes(warnings), ['NO_ADDED_TEST_NAMED']);
  assert.deepEqual(namesOf(warnings, 'NO_ADDED_TEST_NAMED'), ['test_drain']);
});

test('no prefix warns as another test, in the command or the observable, and none stands in for a name', () => {
  for (const prefix of TEST_FUNCTION_PREFIXES) {
    assert.deepEqual(run(`forge test --mt ${prefix}`), [], prefix);
    assert.deepEqual(run('forge test', `test_drain: ${prefix} fails with "vault drained"`), [], prefix);
    assert.deepEqual(codes(run(`forge test --mt ${prefix}`, `the ${prefix} fails with "vault drained"`)), ['NO_ADDED_TEST_NAMED'], prefix);
  }
});

// The design review's rule: a word that is exactly a prefix never satisfies the lint by itself. The read can't tell these
// apart, and it does not try: each is the same warning, and only forge's list says which the gate counts. On the first
// the gate passes (a stated difference); on the rest it fails and a bond is lost.

for (const [what, lines, runner] of [
  ['a real test', ['contract E {', '  function test() public { assert(false); }', '}'], 'pass'],
  ['an internal helper', ['contract E {', '  function test() internal { }', '  function test_drain() public { }', '}'], 'fail'],
  ['an interface\'s declaration', ['interface I {', '  function test() external;', '}', 'contract E { function test_drain() public { } }'], 'fail'],
  ['a comment', ['contract E {', '  // function test() public { }', '  function test_drain() public { }', '}'], 'fail'],
]) {
  test(`the word alone never satisfies the lint, whatever declares it: ${what}, where the gate would ${runner}`, () => {
    const warnings = run('forge test', 'fails with "vault drained"', { patch: patchOf(...lines) });
    assert.deepEqual(codes(warnings), ['NO_ADDED_TEST_NAMED']);
    assert.deepEqual(namesOf(warnings, 'NO_ADDED_TEST_NAMED'), ['test']);
    assert.match(detailOf(warnings, 'NO_ADDED_TEST_NAMED'), CANT_TELL);
  });
}

test('the warning for a word the patch declares is the same for each prefix, and names it apart from the text', () => {
  for (const prefix of TEST_FUNCTION_PREFIXES) {
    const patch = patchOf('contract E {', `  function ${prefix}(uint256 a) internal pure { assert(a == 0); }`, '  function test_drain() public { }', '}');
    const warnings = run('forge build', `the ${prefix} fails with "vault drained"`, { patch });
    assert.deepEqual(codes(warnings), ['NO_ADDED_TEST_NAMED'], prefix);
    assert.deepEqual(namesOf(warnings, 'NO_ADDED_TEST_NAMED'), [prefix], prefix);
    assert.match(detailOf(warnings, 'NO_ADDED_TEST_NAMED'), CANT_TELL, prefix);
    assert.match(detailOf(warnings, 'NO_ADDED_TEST_NAMED'), /longer name/, prefix);
    assert.match(detailOf(warnings, 'NO_ADDED_TEST_NAMED'), /run check with a runner/, prefix);
    // The words stay in names: only check prints them, and commit's notices name nothing of the patch.
    for (const other of ['invariant', 'statefulFuzz', 'table', 'prove']) assert.doesNotMatch(detailOf(warnings, 'NO_ADDED_TEST_NAMED'), new RegExp(`\\b${other}\\b`), prefix);
  }
});

test('more than one such word is listed, sorted; a longer added name settles it', () => {
  const patch = patchOf('contract E {', '  function test() public { }', '  function check() public { }', '  function test_drain() public { }', '}');
  assert.deepEqual(namesOf(run('forge test', 'the check fails with "vault drained"', { patch }), 'NO_ADDED_TEST_NAMED'), ['check', 'test']);
  assert.deepEqual(run('forge test --mt test_drain', 'the check fails with "vault drained"', { patch }), []);
});

test('a word the patch declares but the text does not spell gets the ordinary warning', () => {
  const patch = patchOf('contract E {', '  function check() internal { }', '  function test_drain() public { }', '}');
  const warnings = run('forge build', 'fails with "vault drained"', { patch });
  assert.deepEqual(codes(warnings), ['NO_ADDED_TEST_NAMED']);
  assert.deepEqual(namesOf(warnings, 'NO_ADDED_TEST_NAMED'), ['check', 'test_drain']);
  assert.doesNotMatch(detailOf(warnings, 'NO_ADDED_TEST_NAMED'), CANT_TELL);
});

test('the word beside another baseline test: both warnings, each as ever', () => {
  const warnings = run('forge test --mt test_deposit', 'fails with "vault drained"', { added: ['test'] });
  assert.deepEqual(codes(warnings), ['NO_ADDED_TEST_NAMED', 'OTHER_TEST_NAMED']);
  assert.deepEqual(namesOf(warnings, 'OTHER_TEST_NAMED'), ['test_deposit']);
  assert.match(detailOf(warnings, 'NO_ADDED_TEST_NAMED'), CANT_TELL);
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
    if (c.stated) {
      // The one stated difference: the gate passes on this word, and the tool warns that it can't tell.
      assert.equal(c.runner.status, 'pass');
      assert.deepEqual(codes(warnings), ['NO_ADDED_TEST_NAMED']);
      assert.deepEqual(namesOf(warnings, 'NO_ADDED_TEST_NAMED'), c.runner.named);
      assert.match(detailOf(warnings, 'NO_ADDED_TEST_NAMED'), CANT_TELL);
      return;
    }
    const other = c.runner.named.filter((n) => !c.added.includes(n));
    assert.deepEqual(namesOf(warnings, 'OTHER_TEST_NAMED'), other.length ? other : null, 'another test named');
    assert.equal(warnings.some((w) => w.code === 'NO_ADDED_TEST_NAMED'), !c.runner.named.some((n) => c.added.includes(n)), 'no added test named');
    // A pass is no warning at all; every row quotes, so nothing here is about the quote.
    assert.deepEqual(codes(warnings).filter((code) => code === 'NOTHING_QUOTED'), []);
    if (c.runner.status === 'pass') assert.deepEqual(warnings, []);
  });
}

test('the table states its one difference, and only on a word that is exactly a prefix', () => {
  const stated = tableCases().filter((c) => c.stated);
  assert.ok(stated.length > 0);
  for (const c of stated) {
    assert.equal(c.runner.status, 'pass', c.title);
    assert.ok(c.runner.named.every((n) => TEST_FUNCTION_PREFIXES.includes(n)), c.title);
  }
  // Every row where the runner's answer rests on such a word alone is one of them.
  for (const c of tableCases().filter((x) => !x.stated && x.runner.status === 'pass')) {
    assert.ok(c.runner.named.some((n) => !TEST_FUNCTION_PREFIXES.includes(n)), c.title);
  }
});

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

// An ordinary honest PoC: no warning to act on.

for (const [what, lines] of [
  ['a test with a helper', ['pragma solidity ^0.8.20;', 'contract ExploitTest {', '  function drainOnce() internal { }', '  function test_drain() public {', '    drainOnce();', '    assert(false);', '  }', '}']],
  ['a helper called check, and a test', ['contract ExploitTest {', '  function check(uint256 a) internal pure { assert(a == 0); }', '  function test_drain() public { check(1); }', '}']],
  ['a fixture marked for coverage, and a test', ['contract Fixture {', '  function test() external { }', '}', 'contract ExploitTest {', '  function test_drain() public { assert(false); }', '}']],
  ['an interface, and a test', ['interface IVault {', '  function check(address a) external view returns (bool);', '}', 'contract ExploitTest {', '  function test_drain() public { assert(false); }', '}']],
  ['a fuzz test over several lines', ['contract ExploitTest {', '  function test_drain(', '    uint256 a', '  ) public {', '    assert(a == 0);', '  }', '}']],
]) {
  test(`an ordinary PoC that names its test does not warn: ${what}`, () => {
    const patch = patchOf(...lines);
    for (const [command, observable] of [
      ['forge test --match-test test_drain', 'test_drain fails with "vault drained"'],
      ['forge test', 'test_drain fails with "vault drained"'],
      ['forge test --mt \'^test_drain$\'', 'the check fails with "vault drained"'],
      ['forge test --match-path test/E.t.sol', 'test_drain() fails: the test shows "vault drained"'],
    ]) assert.deepEqual(run(command, observable, { patch }), [], `${command}: ${observable}`);
  });
}

test('a baseline test of the same name as one the patch adds is the added one, by name, as in the runner', () => {
  assert.deepEqual(run('forge test --mt test_deposit', 'fails with "vault drained"', { added: ['test_deposit'] }), []);
});

// The read: one line at a time, of added lines of Solidity.

test('the read is a line at a time', () => {
  // A name after `function` on the same line, whatever else is on it: the first on the line.
  assert.deepEqual(addedTests(patchOf('contract E { function helper() internal { } function test_a() public { } function test_b() public { } }')), ['test_a']);
  assert.deepEqual(addedTests(patchOf('  function test_a(', '    uint256 a', '  ) public { }')), ['test_a']);
});

test('only added lines of Solidity are read', () => {
  const removed = ['diff --git a/test/E.t.sol b/test/E.t.sol', '--- a/test/E.t.sol', '+++ b/test/E.t.sol', '@@ -1,2 +1,1 @@', '-  function test_old() public { }', '   function test_kept() public { }', ''].join('\n');
  assert.deepEqual(addedTests(removed), []);
  const other = ['diff --git a/notes.md b/notes.md', '--- a/notes.md', '+++ b/notes.md', '@@ -0,0 +1,1 @@', '+function test_doc() public { }', ''].join('\n');
  assert.deepEqual(addedTests(other), []);
});

test('a Solidity path git quotes is still Solidity', () => {
  const quoted = ['diff --git "a/test/\\303\\251.t.sol" "b/test/\\303\\251.t.sol"', 'new file mode 100644', '--- /dev/null', '+++ "b/test/\\303\\251.t.sol"', '@@ -0,0 +1,1 @@', '+contract E { function test_drain() public { } }', ''].join('\n');
  assert.deepEqual(addedTests(quoted), ['test_drain']);
});

// What the tool can't tell, each stated in the file, the README and the pull request, with the check command as the answer.
// These pin what the tool says, so a change here is a change to what they state.

test('stated limit: the recorded failure is the runner\'s', () => {
  // The runner passes this when the whole message is in the observable as written.
  assert.deepEqual(codes(run('forge test', 'test_drain: vault drained')), ['NOTHING_QUOTED']);
  // And a quote that is not in the failure fails the gate, with no warning here.
  assert.deepEqual(run('forge test', 'test_drain shows "no such text"'), []);
});

test('stated limit: under a longer name, the read takes what the patch declares as its test', () => {
  // Each is no test to forge, so the runner names nothing and fails. The tool has no warning: run check.
  for (const [what, lines] of [
    ['an internal helper', ['contract E {', '  function test_helper() internal { }', '  function test_drain() public { }', '}']],
    ['an interface\'s declaration', ['interface I { function test_helper() external; }', 'contract E { function test_drain() public { } }']],
    ['a comment', ['contract E {', '  // function test_helper() public { }', '  function test_drain() public { }', '}']],
    ['a string', ['contract E {', '  string s = "function test_helper() public { }";', '  function test_drain() public { }', '}']],
    ['a modifier spelled oddly', ['contract E {', '  function test_helper() internal public$ { }', '  function test_drain() public { }', '}']],
  ]) {
    assert.deepEqual(run('forge test --mt test_helper', 'fails with "vault drained"', { patch: patchOf(...lines) }), [], what);
  }
  // check and prove are forge's only with symbolic entry points on, which the listing's config decides.
  assert.deepEqual(run('forge test --mt check_x', 'fails with "vault drained"', { added: ['check_x'] }), []);
});

test('stated limit: the read can miss a test, and warns of a name that is fine', () => {
  // The name on the line after `function`, and the second test on a line.
  assert.deepEqual(codes(run('forge test --mt test_x', 'fails with "vault drained"', { patch: patchOf('contract E {', '  function', '    test_x() public { }', '}') })), ['NO_ADDED_TEST_NAMED']);
  assert.deepEqual(codes(run('forge test --mt test_b', 'fails with "vault drained"', { patch: patchOf('contract E { function test_a() public { } function test_b() public { } }') })), ['NO_ADDED_TEST_NAMED']);
});

test('stated limit: identity is forge\'s, by file and contract and signature', () => {
  // A new contract inheriting a baseline test: forge reports it under the new contract, so the runner counts it as added.
  const inherits = patchOf('contract E is VaultTest { function test_drain() public { assert(false); } }');
  assert.deepEqual(namesOf(run('forge test --mt test_deposit', OBSERVABLE, { patch: inherits }), 'OTHER_TEST_NAMED'), ['test_deposit']);
  // A baseline test's declaration edited: the same identity, so the runner does not count it as added.
  const edited = ['diff --git a/test/Vault.t.sol b/test/Vault.t.sol', '--- a/test/Vault.t.sol', '+++ b/test/Vault.t.sol', '@@ -1,1 +1,1 @@', '-  function test_deposit() public { }', '+  function test_deposit() external { }', ''].join('\n');
  assert.deepEqual(run('forge test --mt test_deposit', 'fails with "vault drained"', { patch: edited }), []);
});

// The docs.

test('the warnings say the rule, and read nothing as a shell would', () => {
  const noName = run('forge test', 'the vault is drained: "vault drained"');
  const detail = detailOf(noName, 'NO_ADDED_TEST_NAMED');
  for (const prefix of TEST_FUNCTION_PREFIXES) assert.match(detail, new RegExp(`\\b${prefix}\\b`), prefix);
  const other = detailOf(run('forge test --mp test/test_deposit/x.t.sol'), 'OTHER_TEST_NAMED');
  assert.match(other, /wherever/);
  // Commit's notices name nothing of the patch: the details are the tool's own words.
  assert.doesNotMatch(detail, /test_drain/);
  assert.doesNotMatch(other, /test_deposit/);
});

test('the source and the README state the rule and the read', () => {
  const source = fs.readFileSync(new URL('../src/observable.js', import.meta.url), 'utf8');
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## The hunter tool'), readme.indexOf('## The client')).replace(/\s+/g, ' ');
  for (const [where, text] of [['source', source], ['README', section]]) {
    assert.match(text, /nothing follows a shell/, where);
    assert.match(text, /prefix/, where);
    assert.match(text, /ending in `\$`/, where);
    assert.match(text, /itself only/, where);
    assert.match(text, /static read can't tell/, where);
    assert.match(text, /with a runner/, where);
    assert.match(text, /interface's declaration/, where);
  }
  for (const prefix of TEST_FUNCTION_PREFIXES) assert.match(section, new RegExp(`\`${prefix}\``), prefix);
});

test('functionName is the runner\'s', () => {
  assert.equal(functionName('test/x.t.sol > X > test_a(uint256)'), 'test_a');
  assert.equal(functionName('test_a'), 'test_a');
});
