// The review focus: the bridge's rules are the real aggregator's. AggregatorLib's answers here came
// from the real library (test/fixtures/aggregator-lib.vectors.json, generated from verdikta-dispatcher
// at the commit it names); the rest follows ReputationAggregator.fulfill and _finalizeAggregation line
// by line, each case naming what the real contract does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AbiCoder, sha256 } from 'ethers';

import { AggregatorRound, REAL_CONFIG, commitHashOf, findBestCluster, normalizeToModal, parseCidSalt, revealHashOf } from '../src/aggregatorRound.js';

const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/aggregator-lib.vectors.json', import.meta.url), 'utf8'));
const OPERATOR = '0x0000000000000000000000000000000000000001';
const FEE = 120000000000000n;
const big = (a) => a.map((v) => v.map(BigInt));
const CID = (n) => `Qm${String(n).repeat(44)}`.slice(0, 46);
const SALT = 'be4cdf395cfcfd8b385f';

const newRound = () => new AggregatorRound({ operatorOf: () => OPERATOR, fee: FEE });
/** What an honest arbiter's commit is for this vector and salt: the EA's number. */
const commitOf = (vector, salt = SALT) => BigInt(`0x${revealHashOf(OPERATOR, vector, BigInt(`0x${salt}`))}`);
function committed(round, vectors4) {
  let last;
  vectors4.forEach((v, slot) => { last = round.fulfill(slot, [commitOf(v)], ''); });
  return last;
}

test('the real library\'s answers: findBestCluster', () => {
  assert.ok(vectors.findBestCluster.length >= 5);
  for (const t of vectors.findBestCluster) assert.deepEqual(findBestCluster(big(t.ll), t.sel, t.p), t.flags, JSON.stringify(t));
});

test('the real library\'s answers: normalizeToModal', () => {
  for (const t of vectors.normalizeToModal) {
    const { normalized, modalLen } = normalizeToModal(big(t.input));
    assert.equal(modalLen, t.modalLen);
    assert.deepEqual(normalized.map((v) => v.map(Number)), t.normalized);
  }
});

test('the real library\'s answers: isValidCidSalt and parseCidSaltUnchecked', () => {
  for (const t of vectors.isValidCidSalt) assert.equal(parseCidSalt(t.packed) !== null, t.ok, t.packed);
  for (const t of vectors.parseCidSalt) {
    const got = parseCidSalt(t.packed);
    assert.equal(got.cid, t.cid);
    assert.equal(got.salt.toString(), t.salt);
  }
});

test('the configuration is the real contract\'s default, and maxTotalFee is fee x (K + B x P)', () => {
  assert.deepEqual([REAL_CONFIG.k, REAL_CONFIG.m, REAL_CONFIG.n, REAL_CONFIG.p, REAL_CONFIG.bonus], [6, 4, 3, 2, 3]);
  assert.equal(AggregatorRound.required(FEE), FEE * 12n);
});

test('a commit is the low 128 bits of the number; a zero hash is no commit', () => {
  assert.equal(commitHashOf((1n << 128n) + 5n), '00000000000000000000000000000005');
  assert.equal(commitHashOf(1n << 128n), null);
  const r = newRound();
  assert.deepEqual(r.fulfill(0, [1n << 128n], ''), { kind: 'ignored', reason: 'zero commit' });
  assert.equal(r.commitHash.size, 0);
});

test('the hash the EA commits to: the first 128 bits of sha256(abi.encode(operator, scores, salt))', () => {
  const scores = [0n, 0n, 0n, 0n, 700000n, 300000n];
  const salt = BigInt(`0x${SALT}`);
  const encoded = AbiCoder.defaultAbiCoder().encode(['address', 'uint256[]', 'uint256'], [OPERATOR, scores, salt]);
  assert.equal(revealHashOf(OPERATOR, scores, salt), sha256(encoded).slice(2, 34));
});

test('the M-th commit starts the reveal phase, for the committed slots only, in slot order, as 32 lowercase hex', () => {
  const r = newRound();
  const v = [0n, 0n, 0n, 0n, 700000n, 300000n];
  assert.equal(r.fulfill(5, [commitOf(v)], '').kind, 'commit');
  assert.equal(r.fulfill(1, [commitOf(v)], '').kind, 'commit');
  assert.equal(r.fulfill(3, [commitOf(v)], '').kind, 'commit');
  const fourth = r.fulfill(0, [commitOf(v)], '');
  assert.equal(fourth.kind, 'reveal-phase');
  assert.deepEqual(fourth.reveals.map((x) => x.slot), [0, 1, 3, 5]);
  for (const x of fourth.reveals) assert.match(x.cid, /^2:[0-9a-f]{32}$/);
  assert.deepEqual(r.fulfill(2, [commitOf(v)], ''), { kind: 'ignored', reason: 'commit after the reveal phase began' });
});

test('a duplicate commit is ignored; a reveal before the reveal phase reverts; so does a malformed payload', () => {
  const r = newRound();
  const v = [1n, 999999n];
  r.fulfill(0, [commitOf(v)], '');
  assert.deepEqual(r.fulfill(0, [commitOf(v)], ''), { kind: 'ignored', reason: 'duplicate commit' });
  assert.deepEqual(r.fulfill(0, v, `${CID(1)}:${SALT}`), { kind: 'reverted', reason: 'RevealBeforeCommit' });
  assert.deepEqual(r.fulfill(0, [5n], 'x'), { kind: 'reverted', reason: 'MalformedPayload' });
  assert.deepEqual(r.fulfill(0, v, ''), { kind: 'reverted', reason: 'MalformedPayload' });
});

test('a reveal that does not hash to its commit is not recorded, and the slot is a no-show', () => {
  const r = newRound();
  const v = [0n, 0n, 0n, 0n, 700000n, 300000n];
  committed(r, [v, v, v, v]);
  const other = [0n, 0n, 0n, 0n, 700001n, 299999n];
  assert.deepEqual(r.fulfill(0, other, `${CID(1)}:${SALT}`), { kind: 'ignored', reason: 'RevealHashMismatch' });
  assert.equal(r.responses.length, 0);
  assert.equal(r.isComplete, false);
});

test('reveals past the real limits are not recorded: too many scores, a CID string over 121 bytes, a bad salt, a repeat', () => {
  const r = newRound();
  const v = [0n, 1000000n];
  committed(r, [v, v, v, v]);
  assert.equal(r.fulfill(0, new Array(21).fill(0n), `${CID(1)}:${SALT}`).reason, 'RevealTooManyScores');
  assert.equal(r.fulfill(0, v, `${'a'.repeat(101)}:${SALT}`).reason, 'RevealCidTooLong');
  assert.equal(r.fulfill(0, v, `${CID(1)}:nothex`).reason, 'InvalidRevealFormat');
  assert.equal(r.fulfill(0, v, `${CID(1)}:${SALT}`).kind, 'reveal');
  assert.equal(r.fulfill(0, v, `${CID(1)}:${SALT}`).reason, 'duplicate reveal');
});

test('the N-th reveal finalizes: the closest pair of the first N, the floor of their mean, their CIDs comma-joined in order', () => {
  const r = newRound();
  const far = [0n, 0n, 0n, 0n, 1000000n, 0n];
  const a = [0n, 0n, 0n, 0n, 700000n, 300000n];
  const b = [0n, 0n, 0n, 0n, 700001n, 299999n];
  committed(r, [far, a, b, a]);
  assert.equal(r.fulfill(0, far, `${CID(0)}:${SALT}`).kind, 'reveal');
  assert.equal(r.fulfill(1, a, `${CID(1)}:${SALT}`).kind, 'reveal');
  const last = r.fulfill(2, b, `${CID(2)}:${SALT}`);
  assert.equal(last.kind, 'finalized');
  // 299,999.5 floors: the sum is 999,999, inside erratum E4's 999,995..1,000,000
  assert.deepEqual(last.likelihoods, [0n, 0n, 0n, 0n, 700000n, 299999n]);
  assert.equal(last.justifications, `${CID(1)},${CID(2)}`);
  assert.equal(last.clustered, 2);
  assert.equal(last.likelihoods.reduce((s, x) => s + x, 0n), 999999n);
  assert.deepEqual(r.fulfill(3, a, `${CID(3)}:${SALT}`), { kind: 'reverted', reason: 'AggregationComplete' });
});

test('scores above the real ceiling are clamped before aggregation', () => {
  const r = newRound();
  const huge = [10n ** 40n, 1n];
  committed(r, [huge, huge, huge, huge]);
  r.fulfill(0, huge, `${CID(0)}:${SALT}`);
  r.fulfill(1, huge, `${CID(1)}:${SALT}`);
  const last = r.fulfill(2, huge, `${CID(2)}:${SALT}`);
  assert.deepEqual(last.likelihoods, [10n ** 34n, 1n]);
});

test('the money, on every exit path: base to all K at request; bonus only to the clustered; the rest comes back', () => {
  const required = AggregatorRound.required(FEE);
  const failed = newRound();
  assert.equal(failed.baseCredited, FEE * 6n);
  assert.equal(failed.refund(required), FEE * 6n, 'a failed round spends the base fees and returns the reserve');

  const done = newRound();
  const v = [0n, 1000000n];
  committed(done, [v, v, v, v]);
  [0, 1, 2].forEach((slot) => done.fulfill(slot, v, `${CID(slot)}:${SALT}`));
  assert.equal(done.bonusCredited, FEE * 3n * 2n);
  assert.equal(done.refund(required), 0n, 'a finished round spends the whole worst case when every fee is at the ceiling');
  assert.equal(done.refund(required + 7n), 7n, 'anything above the worst case always comes back');
});
