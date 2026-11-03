// The one reader of a justification's Execution evidence block (node P5 wrote it for the hunter tool,
// node P10 moved it here for the record). A justification is untrusted text from IPFS. The block is
// the first thing in it or it is not there, and `integrityFailureOf`, which the record counts from,
// takes only the form the block's writer gives (verdikta-arbiter,
// external-adapter/src/codeReview/evidence.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_END, EVIDENCE_HEADER, MAX_BLOCK_LINES, MAX_JUSTIFICATION_CIDS, integrityFailureOf, justificationCidOf,
  justificationCidsOf, readExecutionEvidence,
} from '../src/executionEvidence.js';

const INTEGRITY_CHECKS = Object.freeze(['identityComplete', 'summaryConsistent', 'exitConsistent', 'protectedPathsUnchanged', 'frameworkUnchanged', 'dependenciesUnchanged']);
const CID = `bafkrei${'a'.repeat(52)}`;
const CID2 = `bafkrei${'b'.repeat(52)}`;
const QM = `Qm${'1'.repeat(44)}`;

// what the real writer gives for a claim with two failed checks (buildRunnerVerdict, arbiter at 3e8a86b)
const realBlock = ({ settlement = 'DUPLICATE (integrity)', sha = 'f'.repeat(64), checks = 'frameworkUnchanged,dependenciesUnchanged', tamper = 'none' } = {}) => [
  'Execution evidence v1',
  `Settlement: ${settlement}`,
  `Report-SHA256: ${sha}`,
  `Listing: ${CID}`,
  `Claim: ${CID2}`,
  `Inputs: envImage=sha256:${'c'.repeat(64)} baseCommit=${'d'.repeat(40)} runner=1.0.0 gvisor=release-20260921.0 semgrepRules=sha256:${'e'.repeat(64)}`,
  'Gates-EA: disclosure=pass inScope=pass',
  'Gates-Tier-A: applies=pass testPathsOnly=pass build=pass integrity=fail',
  'Gates-Tier-B: reproduces=fail claimedObservable=notRun',
  'PoC-Runs: tests=1 fail=3 pass=0 error=0 skip=0 missing=0 duplicate=0 notRun=0',
  'PoC-Run-Pattern: #1 fail,fail,fail',
  `Integrity-Failed-Checks: ${checks}`,
  `Tamper-Flags: ${tamper}`,
  'Honesty-Flags: 0',
  'Findings: total=0 critical=0 high=0 medium=0 low=0 info=0',
  'Patch-Flags: existingTestsModified=0 skipMarkersAdded=0 protectedPathsTouched=0',
  'Diff-PoC: files=1 added=10 removed=0',
  'Diff-Fix: none',
  'Fix: present=false',
  'End execution evidence',
].join('\n');
const FIXED_TEXT = '\n\nVerdict: DUPLICATE (deterministic, not an AI judgement). All weight goes on "DUPLICATE" because that outcome returns the bond with no award; it does not say the finding repeats another.\n\nThis states what the checks found. It does not say who or what caused it.\n\nGate: integrity\nCheck: INTEGRITY_CHECK_FAILED\nFailed: frameworkUnchanged,dependenciesUnchanged';

const failure = (text) => integrityFailureOf(text, { integrityChecks: INTEGRITY_CHECKS });
const read = (text) => readExecutionEvidence(text, { integrityChecks: INTEGRITY_CHECKS });

test('the real writer\'s block names its checks, and the text after it is not read', () => {
  assert.deepEqual(failure(`${realBlock()}${FIXED_TEXT}`), ['frameworkUnchanged', 'dependenciesUnchanged']);
  assert.deepEqual(failure(realBlock({ checks: 'identityComplete' })), ['identityComplete']);
  assert.deepEqual(failure(realBlock({ checks: INTEGRITY_CHECKS.join(',') })), [...INTEGRITY_CHECKS]);
  assert.equal(realBlock().split('\n')[0], EVIDENCE_HEADER);
  assert.equal(realBlock().split('\n').at(-1), EVIDENCE_END);
  assert.ok(realBlock().split('\n').length <= MAX_BLOCK_LINES);
});

test('a block that is not first is not the block: leading text, a blank line, a space, a byte order mark, CRLF', () => {
  for (const text of [`The jury says:\n${realBlock()}`, `\n${realBlock()}`, ` ${realBlock()}`, `﻿${realBlock()}`, realBlock().replaceAll('\n', '\r\n'), `${EVIDENCE_HEADER} \n${realBlock()}`]) {
    assert.equal(failure(text), null, JSON.stringify(text.slice(0, 40)));
    assert.equal(read(text), null, JSON.stringify(text.slice(0, 40)));
  }
});

test('a jury verdict quoting the block: the first block says jury, so nothing failed', () => {
  const quoted = `${realBlock({ settlement: 'jury', checks: 'none' })}\n\nThe hunter's text says:\n${realBlock()}`;
  assert.equal(failure(quoted), null);
  assert.equal(read(quoted).settlement, 'jury');
});

test('a block with no end line, or longer than any the writer gives, is no block', () => {
  assert.equal(failure(realBlock().replace(`\n${EVIDENCE_END}`, '')), null);
  assert.equal(read(realBlock().replace(`\n${EVIDENCE_END}`, '')), null);
  const padded = realBlock().replace(`\n${EVIDENCE_END}`, `${'\nHonesty-Flags: 0'.repeat(MAX_BLOCK_LINES)}\n${EVIDENCE_END}`);
  assert.equal(failure(padded), null);
  assert.equal(read(padded), null);
  const atTheLimit = [EVIDENCE_HEADER, 'Settlement: DUPLICATE (integrity)', `Report-SHA256: ${'a'.repeat(64)}`, 'Integrity-Failed-Checks: exitConsistent', ...Array(MAX_BLOCK_LINES - 5).fill('Honesty-Flags: 0'), EVIDENCE_END].join('\n');
  assert.deepEqual(failure(atTheLimit), ['exitConsistent']);
  assert.equal(failure(atTheLimit.replace(EVIDENCE_END, `Honesty-Flags: 0\n${EVIDENCE_END}`)), null);
});

test('a check name must be one of common\'s: one unknown name makes the whole block plain, not the part that is known', () => {
  for (const checks of ['madeUpCheck', 'frameworkUnchanged,madeUpCheck', 'madeUpCheck,frameworkUnchanged', 'frameworkunchanged', 'frameworkUnchanged ', ' frameworkUnchanged', 'frameworkUnchanged,', ',frameworkUnchanged', 'frameworkUnchanged,,dependenciesUnchanged', '__proto__', 'constructor', '<img src=x>']) {
    assert.equal(failure(realBlock({ checks })), null, checks);
  }
});

test('a check listed twice or out of common\'s order is not the writer\'s form', () => {
  assert.equal(failure(realBlock({ checks: 'frameworkUnchanged,frameworkUnchanged' })), null);
  assert.equal(failure(realBlock({ checks: 'dependenciesUnchanged,frameworkUnchanged' })), null);
});

test('a block that contradicts itself is plain: integrity with no failed check, with a tamper flag, or with any other settlement', () => {
  assert.equal(failure(realBlock({ checks: 'none' })), null);
  assert.equal(failure(realBlock({ checks: '' })), null);
  assert.equal(failure(realBlock({ tamper: 'report-path=1' })), null, 'a tamper flag settles INVALID');
  assert.equal(failure(realBlock({ tamper: 'none,report-path=1' })), null);
  assert.equal(failure(realBlock({ settlement: 'jury' })), null);
  assert.equal(failure(realBlock({ settlement: 'INVALID (integrity)' })), null);
  assert.equal(failure(realBlock({ settlement: 'INVALID (reproduces)' })), null);
  assert.equal(failure(realBlock({ settlement: 'DUPLICATE' })), null);
  assert.equal(failure(realBlock({ settlement: 'duplicate (integrity)' })), null);
});

test('a line missing from the block makes it plain: the settlement, the hash, the checks', () => {
  for (const name of ['Settlement', 'Report-SHA256', 'Integrity-Failed-Checks']) {
    const text = realBlock().split('\n').filter((l) => !l.startsWith(`${name}: `)).join('\n');
    assert.equal(failure(text), null, name);
  }
  assert.equal(failure(realBlock({ sha: 'zz' })), null, 'a hash is 64 hex digits');
  assert.equal(failure(realBlock({ sha: 'F'.repeat(64) })), null, 'in the writer\'s lower case');
});

test('a line repeated counts the first time, in both readers: there is one rule', () => {
  const twice = `${EVIDENCE_HEADER}\nSettlement: jury\nSettlement: DUPLICATE (integrity)\nReport-SHA256: ${'a'.repeat(64)}\nIntegrity-Failed-Checks: exitConsistent\n${EVIDENCE_END}`;
  assert.equal(read(twice).settlement, 'jury');
  assert.equal(failure(twice), null);
});

test('anything that is not a string reads as nothing, and does not throw', () => {
  for (const value of [undefined, null, 42, {}, [], true]) {
    assert.equal(failure(value), null);
    assert.equal(read(value), null);
  }
});

test('the hunter tool\'s view is unchanged: unknown names dropped, flags and hash read', () => {
  const r = read(realBlock({ checks: 'frameworkUnchanged,madeUpCheck', tamper: 'report-path=2' }));
  assert.deepEqual(r.integrityFailedChecks, ['frameworkUnchanged']);
  assert.equal(r.tamperFlags, 'report-path=2');
  assert.equal(r.reportSha256, 'f'.repeat(64));
  assert.deepEqual(read(realBlock({ checks: 'none' })).integrityFailedChecks, []);
});

test('the CID list: every entry of the aggregator\'s string, or nothing', () => {
  assert.deepEqual(justificationCidsOf(CID), [CID]);
  assert.deepEqual(justificationCidsOf(`${CID},${QM}`), [CID, QM]);
  assert.deepEqual(justificationCidsOf(`${CID},${CID}`), [CID, CID], 'two arbiters can upload the same bytes');
  for (const text of ['', null, undefined, 42, ',', `${CID},`, `,${CID}`, `${CID},,${QM}`, `${CID},../../etc/passwd`, `${CID},not-a-cid`, `${'a'.repeat(101)}`, 'short']) {
    assert.equal(justificationCidsOf(text), null, String(text));
  }
});

test('the CID list is bounded in entries and in length, before anything else is done with it', () => {
  const full = Array(MAX_JUSTIFICATION_CIDS).fill(CID);
  assert.deepEqual(justificationCidsOf(full.join(',')), full);
  assert.equal(justificationCidsOf([...full, CID].join(',')), null);
  assert.equal(justificationCidsOf(`${CID},`.repeat(1_000_000)), null);
});

test('the first CID, as the hunter tool reads it, is the list\'s rule on one entry', () => {
  assert.equal(justificationCidOf(`${CID},${CID2}`), CID);
  assert.equal(justificationCidOf(`${CID}:abcdef,${CID2}`), CID);
  assert.equal(justificationCidOf(' '), null);
  assert.equal(justificationCidOf('../../etc/passwd'), null);
});
