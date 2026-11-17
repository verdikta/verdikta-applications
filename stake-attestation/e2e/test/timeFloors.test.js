// Node P34, with no Docker: the arbiter at the pin applies the class time floors (owner decision Q84, node A26), shown
// by calling its own code. A listing's limits are measured on the signing workflow's runner, several times faster than
// an arbiter under gVisor, so the runner raises each default its listing check derives (code-runner/src/listing.js,
// deriveLimits) and each time limit a claim's run gets (code-runner/src/classLimits.js, checkSpec) to its floor. The
// builder writes the listing check's defaults into code_review.json, so a listing signed with this pin states them.
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

import { codeReview } from '../src/common.js';
import { draftSpec } from '../src/fixtures.js';
import { arbiterCheckout } from '../src/setup.js';

/** The owner's floors (Q84), in seconds. */
const FLOORS = Object.freeze({ buildSeconds: 60, testSeconds: 30, runSeconds: 180 });
/** What the check ran with besides time: the round's draft's cpus and memory, the class's patch size. */
const SPEC_LIMITS = Object.freeze({ cpus: 1, memoryMb: 2048, maxPatchBytes: 2000000 });

describe('the class time floors in verdikta-arbiter at the pin', () => {
  let listing;
  let classLimits;
  before(() => {
    const { dir } = arbiterCheckout(() => {}, process.env, { packages: ['code-runner'] });
    const require = createRequire(path.join(dir, 'package.json'));
    listing = require(path.join(dir, 'code-runner', 'src', 'listing'));
    classLimits = require(path.join(dir, 'code-runner', 'src', 'classLimits'));
  });

  test('this package\'s @verdikta/common holds the owner\'s floors', () => {
    assert.deepEqual({ ...codeReview.CLASS_TIME_FLOORS }, FLOORS);
  });

  test('a listing check whose measured defaults are below the floors answers the floors', () => {
    // 2 s preparation, a 2 s build and 1 s suite runs: 6, 3 and 21 s measured, as on the signing runner's fast builds
    const d = listing.deriveLimits({ prepareMs: 2000, buildMs: 2000, testMs: [1000, 1000, 1000] }, SPEC_LIMITS);
    assert.deepEqual(d.measured, { buildSeconds: 6, testSeconds: 3, runSeconds: 21 });
    assert.deepEqual(d.over, []);
    assert.deepEqual(d.limits, { ...SPEC_LIMITS, ...FLOORS });
  });

  test('a default above its floor stays as measured: each floor is a minimum, not a value', () => {
    // a 25 s build and a 12 s suite run: 75 s build, 36 s test, ceil(3 x 39) + 2 x 36 = 189 s run
    const d = listing.deriveLimits({ prepareMs: 2000, buildMs: 25000, testMs: [12000, 11000, 11500] }, SPEC_LIMITS);
    assert.deepEqual(d.limits, { ...SPEC_LIMITS, buildSeconds: 75, testSeconds: 36, runSeconds: 189 });
    // one below its floor, the others above theirs
    const mixed = listing.deriveLimits({ prepareMs: 2000, buildMs: 25000, testMs: [1000, 1000, 1000] }, SPEC_LIMITS);
    assert.deepEqual(mixed.limits, { ...SPEC_LIMITS, buildSeconds: 75, testSeconds: 30, runSeconds: 180 });
  });

  test('time limits a draft states below the floors are no refusal by themselves: a claim gets the floors', () => {
    const declared = draftSpec({ repo: 'https://github.com/verdikta-test/vault-fixture', baseCommit: 'd'.repeat(40), disclosureKey: 'k' }).limits;
    assert.ok(Object.keys(FLOORS).every((k) => declared[k] < FLOORS[k]), `the round's draft states less than the floors: ${JSON.stringify(declared)}`);
    const fast = listing.deriveLimits({ prepareMs: 2000, buildMs: 2000, testMs: [1000, 1000, 1000] }, SPEC_LIMITS).limits;
    assert.deepEqual(listing.limitsBelowDefaults(declared, fast), []);
    // below a default the measurement put above its floor, it still is one
    const slow = listing.deriveLimits({ prepareMs: 2000, buildMs: 25000, testMs: [1000, 1000, 1000] }, SPEC_LIMITS).limits;
    assert.deepEqual(listing.limitsBelowDefaults({ buildSeconds: 70 }, slow), [{ key: 'buildSeconds', declared: 70, effective: 70, default: 75 }]);
  });

  test('a claim\'s run on a listing that states less than the floors gets the floors', () => {
    const spec = {
      env: { image: `registry.invalid/env@sha256:${'e'.repeat(64)}`, platform: 'linux/amd64', unpackedBytes: 1000000 },
      limits: { cpus: 1, memoryMb: 2048, buildSeconds: 10, testSeconds: 5, runSeconds: 40 },
    };
    const r = classLimits.checkSpec(spec);
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    assert.deepEqual({ buildSeconds: r.limits.buildSeconds, testSeconds: r.limits.testSeconds, runSeconds: r.limits.runSeconds }, FLOORS);
  });
});
