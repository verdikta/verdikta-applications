// Acceptance 1 and the review's "pins that can drift apart": the reusable workflow, P3a's Docker tests
// and the local round name one verdikta-arbiter commit, and this fails if they differ. The rule reads the
// three files, so moving them together passes and moving one does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ACTION_PINS } from '../../action/services.js';
import { PIN as DOCKER_PIN } from '../docker/helpers.js';
import { APP_DIR, otherArbiterPins, pinProblems, readArbiterPins } from '../helpers/pins.js';

const ARBITER = 'https://github.com/verdikta/verdikta-arbiter.git';

test('the three pin files name one commit of verdikta-arbiter', () => {
  const pins = readArbiterPins();
  assert.deepEqual(pinProblems(pins), []);
  assert.equal(pins.length, 3);
  assert.equal(pins[0].repository, ARBITER);
});

// Node P34: the pin is the arbiter release the arbiters run, on its main branch (G3 landed the build there), and each
// of the three files says so, so a pin that drifts back to a work branch shows here.
test('each of the three names the branch its commit is on, the arbiter\'s main', () => {
  for (const pin of readArbiterPins()) assert.equal(pin.branch, 'main', `${pin.file} names branch ${pin.branch}`);
});

test('the rule fails when one of them moves alone: a commit, a repository, a branch or a short id', () => {
  const pins = readArbiterPins();
  const moved = (i, over) => pins.map((p, k) => (k === i ? { ...p, ...over } : p));
  for (let i = 0; i < pins.length; i += 1) {
    assert.match(pinProblems(moved(i, { commit: 'a'.repeat(40) })).join(), /the commits differ/, pins[i].file);
    assert.match(pinProblems(moved(i, { repository: 'https://example.org/x.git' })).join(), /the repositories differ/, pins[i].file);
    assert.match(pinProblems(moved(i, { commit: pins[i].commit.slice(0, 7) })).join(), /not a whole commit/, pins[i].file);
  }
  for (let i = 0; i < pins.length; i += 1) {
    assert.match(pinProblems(moved(i, { branch: 'claude/stake-attestation' })).join(), /the branches differ/, pins[i].file);
  }
  assert.match(pinProblems([pins[0]]).join(), /1 pin file/);
});

test('what runs reads those files: the workflow\'s starter and the Docker tests load the pins the rule reads', () => {
  const [workflow, docker, round] = readArbiterPins();
  assert.equal(ACTION_PINS.codeRunner.commit, workflow.commit);
  assert.equal(DOCKER_PIN.commit, docker.commit);
  // The round reads its own (e2e/src/setup.js); e2e/test/ci.test.js holds that from its side.
  assert.match(fs.readFileSync(path.join(APP_DIR, 'e2e', 'src', 'setup.js'), 'utf8'), /arbiter\.pin\.json/);
  assert.equal(round.commit, workflow.commit);
});

test('no fourth place pins the arbiter: a file, a line or a workflow naming its own commit', () => {
  assert.deepEqual(otherArbiterPins(), []);
});

test('the walk that says so can fail: it finds a pin in a new file, a line and a workflow', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-pins-'));
  try {
    const app = path.join(root, 'stake-attestation');
    const hex = 'b'.repeat(40);
    for (const file of ['builder/action/pins.json', 'builder/test/docker/code-runner.pin.json', 'e2e/arbiter.pin.json']) {
      fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
      fs.writeFileSync(path.join(app, file), JSON.stringify(file.endsWith('pins.json') ? { codeRunner: { repository: ARBITER, commit: hex } } : { repository: ARBITER, commit: hex }));
    }
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    assert.deepEqual(otherArbiterPins({ appDir: app, repoDir: root }), [], 'the three themselves are not a fourth');
    fs.writeFileSync(path.join(app, 'fourth.json'), JSON.stringify({ repository: ARBITER, commit: hex }));
    fs.writeFileSync(path.join(app, 'README.md'), `the runner of verdikta-arbiter at ${hex}\n`);
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'x.yml'), 'with:\n  repository: verdikta/verdikta-arbiter\n  ref: main\n');
    assert.deepEqual(otherArbiterPins({ appDir: app, repoDir: root }).sort(), ['.github/workflows/x.yml', 'stake-attestation/README.md', 'stake-attestation/fourth.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the docs say how to move the pin, and that it moves before launch to what the canaries run', () => {
  const readme = fs.readFileSync(path.join(APP_DIR, 'README.md'), 'utf8');
  const section = /### Moving the arbiter pin\n([\s\S]*?)(?=\n#{2,3} )/.exec(readme)?.[1];
  assert.ok(section, 'README: ### Moving the arbiter pin');
  for (const file of readArbiterPins().map((p) => p.file)) assert.ok(section.includes(file), `it names ${file}`);
  assert.match(section, /before launch/i);
  assert.match(section, /canar/i);
});

// Node P34: the commit is chosen on the arbiter's main, and the release of @verdikta/common it runs moves with it, in
// all six packages (shared/test/repo/packages.test.js; e2e/test/requestSize.test.js holds e2e's to the arbiter's).
test('the docs say the commit comes from the arbiter\'s main, and that @verdikta/common moves with it', () => {
  const readme = fs.readFileSync(path.join(APP_DIR, 'README.md'), 'utf8');
  const section = /### Moving the arbiter pin\n([\s\S]*?)(?=\n#{2,3} )/.exec(readme)?.[1] ?? '';
  assert.match(section, /1\. Choose a commit on the arbiter's `main`/);
  assert.doesNotMatch(section, /arbiter's `claude\/stake-attestation`/);
  assert.match(section, /@verdikta\/common/);
  assert.match(section, /shared\/test\/repo\/packages\.test\.js/);
  assert.match(section, /e2e\/test\/timeFloors\.test\.js/);
});

// Node P34: the pin decides what a listing check runs, but signing runs the builder commit the caller names, so the
// section says what the owner does for signing to use a new pin. Neither of those two is in this repository.
test('the docs say the owner\'s two steps that make signing use a new pin: the caller\'s BUILDER_COMMIT and the trust policy', () => {
  const readme = fs.readFileSync(path.join(APP_DIR, 'README.md'), 'utf8');
  const section = /### Moving the arbiter pin\n([\s\S]*?)(?=\n#{2,3} )/.exec(readme)?.[1] ?? '';
  const at = section.indexOf('**Signing with a new pin');
  assert.ok(at >= 0, 'README, Moving the arbiter pin: **Signing with a new pin**');
  // up to the next paragraph in bold, or the section's end
  const rest = section.slice(at + 2);
  const steps = rest.slice(0, rest.includes('\n\n**') ? rest.indexOf('\n\n**') : rest.length);
  const one = /\n1\. ([\s\S]*?)\n2\. /.exec(steps)?.[1] ?? '';
  const two = /\n2\. ([\s\S]*?)(?:\n\n|$)/.exec(steps)?.[1] ?? '';
  for (const needle of ['caller', 'BUILDER_COMMIT', 'builder/caller/stake-attestation-site-build.yml']) assert.ok(one.includes(needle), `step 1 names ${needle}`);
  for (const needle of ['trust policy', 'job_workflow_ref', 'stake-attestation-builder-sign.yml@']) assert.ok(two.includes(needle), `step 2 names ${needle}`);
  assert.match(steps, /owner/);
  assert.match(steps, /both/i);
  // the caller template keeps its placeholder: the commit goes in at the owner's copy, never here
  const caller = fs.readFileSync(path.join(APP_DIR, 'builder', 'caller', 'stake-attestation-site-build.yml'), 'utf8');
  assert.equal(caller.match(/@BUILDER_COMMIT\b/g)?.length, 2);
  assert.doesNotMatch(caller, /@[0-9a-f]{40}\b/);
});
