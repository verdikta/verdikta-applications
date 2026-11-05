// What stands between a stranger and Verdikta's runner minutes (node P15, acceptance 4): the limits, per
// wallet, per repository owner and overall, which outlive a restart and refuse when they can't be kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BuildLimitError, createBuildBudget } from '../src/listing/buildBudget.js';

const WINDOW = 1000;
const LIMITS = { perWallet: 2, perRepoOwner: 2, overall: 3, windowMs: WINDOW };
const A = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const B = '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2';

function setup({ limits = LIMITS, file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-budget-')), 'build-budget.json') } = {}) {
  const clock = { t: 10000 };
  const make = () => createBuildBudget({ file, limits, now: () => clock.t, logger: { error() {} } });
  return { budget: make(), make, clock, file };
}
const refuses = (fn, code, status = 429) => assert.throws(fn, (e) => e instanceof BuildLimitError && e.code === code && e.status === status);

test('a wallet gets its number of attempts in the window, and then the next window', () => {
  const { budget, clock } = setup();
  budget.admit('j1', A);
  budget.admit('j2', A);
  refuses(() => budget.admit('j3', A), 'MAKER_BUILD_LIMIT');
  budget.admit('j4', B);
  clock.t += WINDOW + 1;
  budget.admit('j5', A);
});

test('a refund gives back the overall budget, never the wallet\'s attempt: bad proofs cannot drain the budget, and cost their wallet', () => {
  const { budget } = setup();
  budget.admit('j1', A);
  budget.release('j1');
  budget.admit('j2', A);
  budget.release('j2');
  refuses(() => budget.admit('j3', A), 'MAKER_BUILD_LIMIT');
  budget.admit('j4', B);
  budget.admit('j5', B);
  budget.admit('j6', '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db');
  refuses(() => budget.admit('j7', '0x78731D3Ca6b7E34aC0F824c42a7cC18A495cabaB'), 'BUILD_BUDGET_EXHAUSTED');
  budget.release('j4');
  budget.admit('j8', '0x78731D3Ca6b7E34aC0F824c42a7cC18A495cabaB');
});

test('several wallets do not get past the owner limit: a build is charged to the repository\'s owner once its proof stands', () => {
  const { budget } = setup({ limits: { ...LIMITS, perWallet: 10, overall: 10 } });
  budget.admit('j1', A);
  budget.chargeOwner('j1', 'github.com/acme');
  budget.admit('j2', B);
  budget.chargeOwner('j2', 'github.com/acme');
  budget.admit('j3', '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db');
  refuses(() => budget.chargeOwner('j3', 'github.com/acme'), 'REPO_OWNER_BUILD_LIMIT');
  budget.chargeOwner('j3', 'github.com/other');
});

test('the overall limit holds whoever asks: several wallets and several accounts use it up and no more', () => {
  const { budget } = setup({ limits: { ...LIMITS, perWallet: 1, perRepoOwner: 1, overall: 2 } });
  budget.admit('j1', A);
  budget.chargeOwner('j1', 'github.com/one');
  budget.admit('j2', B);
  budget.chargeOwner('j2', 'github.com/two');
  refuses(() => budget.admit('j3', '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db'), 'BUILD_BUDGET_EXHAUSTED');
});

test('a restart forgets nothing, and the file holds counts for the window only', () => {
  const { budget, make, clock, file } = setup();
  budget.admit('j1', A);
  budget.admit('j2', A);
  refuses(() => make().admit('j3', A), 'MAKER_BUILD_LIMIT');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  clock.t += WINDOW + 1;
  const later = make();
  later.admit('j4', B);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).entries.map((e) => e.id), ['j4']);
});

test('a state file that cannot be read or written refuses builds: a limit nobody can keep is no limit', () => {
  const { file, make } = setup();
  fs.writeFileSync(file, '{ not json');
  refuses(() => make().admit('j1', A), 'BUILD_BUDGET_UNAVAILABLE', 503);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-budget-'));
  const gone = createBuildBudget({ file: path.join(dir, 'missing', 'build-budget.json'), limits: LIMITS, now: () => 1, logger: { error() {} } });
  refuses(() => gone.admit('j1', A), 'BUILD_BUDGET_UNAVAILABLE', 503);
  gone.release('j1');
});

test('the view holds numbers, never an address', () => {
  const { budget } = setup();
  budget.admit('j1', A);
  const v = budget.view();
  assert.deepEqual(v, { windowMs: WINDOW, used: 1, overall: 3 });
  assert.doesNotMatch(JSON.stringify(v), /0x/);
});
