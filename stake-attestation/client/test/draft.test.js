// The listing form's model (src/lib/draft.js): the defaults of design §7.1, the decision D8
// bounds the form holds, and the request it sends to POST /api/listings, which common's own
// validator accepts once the builder's fields are stood in (as the server's request.js does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import common from '@verdikta/common';

import { ethToAmount, ethToWei, formIssues, initialForm, listMismatches, setKind, setWindow, toListingRequest } from '../src/lib/draft.js';
import { generateDisclosureKeyPair } from '../src/lib/disclosure.js';

const { codeReview } = common;
const IMAGE = `ghcr.io/verdikta/stake-env@sha256:${'ab'.repeat(32)}`;

function filled(over = {}) {
  let f = initialForm();
  f = {
    ...f,
    repo: 'https://github.com/acme/vault',
    baseCommit: '7f3a9c0d1e2b3a4c5d6e7f8091a2b3c4d5e6f708',
    scopeInclude: 'src/**\n',
    scopeExclude: 'test/**\n\nscript/**',
    awards: { LOW: '0', MEDIUM: '0.1', HIGH: '0.40', CRITICAL: '2' },
    lowestClassCounted: 'MEDIUM',
    bond: '0.02',
    allowlist: ' 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \n',
    knownIssues: [{ title: 'Owner can pause deposits', class: 'MEDIUM', paths: 'src/Vault.sol\nsrc/Pausable.sol', description: 'The owner may pause deposits at any time; withdrawals stay open.' }],
    valueAtRiskUsd: '1250000',
    disclosureKey: generateDisclosureKeyPair().recipient,
    ...over,
  };
  return f;
}

test('the windows default to 14 days, 72 h, 48 h and 7 days; 30 days for a contract until the maker chooses', () => {
  const f = initialForm();
  assert.deepEqual([f.fixWindowDays, f.disputeWindowHours, f.disclosureGraceHours, f.revealWindowDays], ['14', '72', '48', '7']);
  const c = setKind(f, 'contract');
  assert.equal(c.fixWindowDays, '30');
  assert.equal(setKind(c, 'repo').fixWindowDays, '14');
  const chosen = setWindow(f, 'fixWindowDays', '21');
  assert.equal(setKind(chosen, 'contract').fixWindowDays, '21');
});

test('D8: fix window 0 to 90 days (0 allowed), dispute 24 to 2160 h, reveal 3 to 90 days, grace no longer than the fix window', () => {
  const issues = (w) => formIssues(filled(w));
  assert.deepEqual(issues({}), {});
  assert.deepEqual(issues({ fixWindowDays: '0', disclosureGraceHours: '0' }), {});
  assert.deepEqual(issues({ fixWindowDays: '0' }), { disclosureGraceHours: 'grace' });
  assert.deepEqual(issues({ fixWindowDays: '2', disclosureGraceHours: '48' }), {});
  assert.deepEqual(issues({ fixWindowDays: '2', disclosureGraceHours: '49' }), { disclosureGraceHours: 'grace' });
  assert.deepEqual(issues({ fixWindowDays: '91' }), { fixWindowDays: 'fixWindow' });
  assert.deepEqual(issues({ fixWindowDays: '90' }), {});
  assert.deepEqual(issues({ disputeWindowHours: '23' }), { disputeWindowHours: 'disputeWindow' });
  assert.deepEqual(issues({ disputeWindowHours: '2161' }), { disputeWindowHours: 'disputeWindow' });
  assert.deepEqual(issues({ disputeWindowHours: '24' }), {});
  assert.deepEqual(issues({ revealWindowDays: '2' }), { revealWindowDays: 'revealWindow' });
  assert.deepEqual(issues({ revealWindowDays: '91' }), { revealWindowDays: 'revealWindow' });
  assert.deepEqual(issues({ revealWindowDays: '3' }), {});
  for (const bad of ['', '2.5', '-1', '1e2', ' 7', '07x']) {
    assert.deepEqual(issues({ revealWindowDays: bad }), { revealWindowDays: 'wholeNumber' }, JSON.stringify(bad));
  }
  assert.deepEqual(issues({ valueAtRiskUsd: '12.5' }), { valueAtRiskUsd: 'wholeNumber' });
  assert.deepEqual(issues({ valueAtRiskUsd: '' }), {});
  assert.deepEqual(issues({ bond: 'lots' }), { bond: 'amount' });
  assert.deepEqual(issues({ awards: { LOW: '0', MEDIUM: '0.1', HIGH: 'x', CRITICAL: '2' } }), { 'awards.HIGH': 'amount' });
});

test('ETH amounts become the spec\'s "<decimal> ETH" and wei strings', () => {
  assert.equal(ethToAmount('0'), '0');
  assert.equal(ethToAmount('0.0'), '0');
  assert.equal(ethToAmount('0.10'), '0.1 ETH');
  assert.equal(ethToAmount('2'), '2 ETH');
  assert.equal(ethToAmount(' 1.000000000000000001 '), '1.000000000000000001 ETH');
  assert.equal(ethToWei('0.02'), '20000000000000000');
  for (const bad of ['', '1e3', '-1', '0x10', '.5', '1.', '0.0000000000000000001', '1,5']) {
    assert.throws(() => ethToAmount(bad), /amount/, JSON.stringify(bad));
  }
  // what the spec carries parses back to the same wei with common's parser
  for (const v of ['0.1', '2', '0.000000000000000001', '123.456']) {
    assert.equal(codeReview.parseAmountToWei(ethToAmount(v)).toString(), ethToWei(v));
  }
});

test('the request: the draft code_review.json, its known issues with common\'s ids, the allowlist', () => {
  const f = filled();
  const body = toListingRequest(f);
  assert.deepEqual(Object.keys(body).sort(), ['allowlist', 'knownIssues', 'spec']);
  assert.deepEqual(body.allowlist, ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8']);
  const { spec } = body;
  assert.equal(spec.version, 1);
  assert.equal(spec.kind, 'bug');
  assert.equal(spec.artifact, undefined);
  assert.deepEqual(spec.env, { from: 'foundry' });
  assert.deepEqual(spec.commands, {
    framework: 'forge',
    setup: 'forge install',
    build: 'forge build',
    test: 'forge test',
    testFiles: 'forge test --match-path $FILES',
    testIds: 'forge test --match-test $TEST_IDS',
  });
  assert.deepEqual(spec.paths, { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.github/**'] });
  assert.deepEqual(spec.stake, {
    awards: { LOW: '0', MEDIUM: '0.1 ETH', HIGH: '0.4 ETH', CRITICAL: '2 ETH' },
    lowestClassCounted: 'MEDIUM',
    bondWei: '20000000000000000',
    fixWindowDays: 14,
    disputeWindowHours: 72,
    disclosureGraceHours: 48,
    revealWindowDays: 7,
    scope: { include: ['src/**'], exclude: ['test/**', 'script/**'] },
    knownIssues: 'known_issues.json',
    severityRubric: 'immunefi-v2.3',
    disclosureKey: f.disclosureKey,
    valueAtRiskUsd: 1250000,
  });
  assert.equal(body.knownIssues.length, 1);
  const [ki] = body.knownIssues;
  assert.deepEqual(ki.paths, ['src/Vault.sol', 'src/Pausable.sol']);
  assert.equal(ki.id, codeReview.knownIssueId(ki));
  assert.equal(codeReview.validateKnownIssues(body.knownIssues).ok, true);

  // common's validator, over the builder's stand-ins for the fields it measures
  const standIn = { ...spec, env: { ...spec.env, image: IMAGE, platform: 'linux/amd64', unpackedBytes: 1 } };
  const v = codeReview.validateCodeReviewSpec(standIn);
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('a contract listing, no known issues, an open listing and no declared value', () => {
  const f = setKind(filled({ knownIssues: [], allowlist: '', valueAtRiskUsd: '', scopeExclude: '' }), 'contract');
  const body = toListingRequest({ ...f, address: '0x5f2a00000000000000000000000000000000c0de', chainId: '8453', commands: { ...f.commands, setup: '', lint: 'forge fmt --check' } });
  assert.deepEqual(body.allowlist, []);
  assert.equal('knownIssues' in body, false);
  assert.deepEqual(body.spec.artifact, { kind: 'contract', address: '0x5f2a00000000000000000000000000000000c0de', chainId: 8453 });
  assert.equal(body.spec.stake.fixWindowDays, 30);
  assert.equal('knownIssues' in body.spec.stake, false);
  assert.equal('valueAtRiskUsd' in body.spec.stake, false);
  assert.deepEqual(body.spec.stake.scope, { include: ['src/**'] });
  assert.equal('setup' in body.spec.commands, false);
  assert.equal(body.spec.commands.lint, 'forge fmt --check');
});

test('a form with a client-side issue is never turned into a request', () => {
  assert.throws(() => toListingRequest(filled({ bond: 'lots' })), /amount/);
  assert.throws(() => toListingRequest(filled({ fixWindowDays: '0' })), /form/);
});

test('list() is sent only with the maker\'s own key and terms: listMismatches names what the server changed', async () => {
  const { disclosureKeyBytes32 } = await import('../src/lib/disclosure.js');
  const body = toListingRequest(filled());
  // the server's listParams.js for this request, as P4a returns it
  const ids = body.knownIssues.map((k) => `0x${k.id.slice(7)}`);
  const list = {
    params: {
      artifact: { kind: 0, repo: body.spec.repo, baseCommit: body.spec.baseCommit, chainId: '0', addr: '0x0000000000000000000000000000000000000000' },
      disclosureKey: disclosureKeyBytes32(body.spec.stake.disclosureKey),
      awards: ['0', '100000000000000000', '400000000000000000', '2000000000000000000'],
      lowestClassCounted: 3,
      bondWei: '20000000000000000',
      fixWindow: 14 * 86400,
      disputeWindow: 72 * 3600,
      disclosureGrace: 48 * 3600,
      revealWindow: 7 * 86400,
      allowlist: ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
      valueAtRiskUsd: '1250000',
      oracle: { requestedClass: '133' },
    },
    knownIssueIds: ids,
  };
  assert.deepEqual(listMismatches(body, list, disclosureKeyBytes32), []);
  const other = disclosureKeyBytes32(generateDisclosureKeyPair().recipient);
  const changed = (patch, extra = {}) => listMismatches(body, { ...list, ...extra, params: { ...list.params, ...patch } }, disclosureKeyBytes32);
  assert.deepEqual(changed({ disclosureKey: other }), ['disclosureKey']);
  assert.deepEqual(changed({ awards: ['0', '1', '400000000000000000', '2000000000000000000'] }), ['awards']);
  assert.deepEqual(changed({ bondWei: '0' }), ['bondWei']);
  assert.deepEqual(changed({ fixWindow: 0, disclosureGrace: 0 }), ['fixWindow', 'disclosureGrace']);
  assert.deepEqual(changed({ allowlist: [] }), ['allowlist']);
  assert.deepEqual(changed({ lowestClassCounted: 5 }), ['lowestClassCounted']);
  assert.deepEqual(changed({ valueAtRiskUsd: '0' }), ['valueAtRiskUsd']);
  assert.deepEqual(changed({ artifact: { ...list.params.artifact, baseCommit: 'f'.repeat(40) } }), ['artifact']);
  assert.deepEqual(changed({}, { knownIssueIds: [] }), ['knownIssueIds']);

  const c = setKind(filled({ knownIssues: [] }), 'contract');
  const cBody = toListingRequest({ ...c, address: '0x5f2a00000000000000000000000000000000c0de', chainId: '8453' });
  const cList = { ...list, knownIssueIds: [], params: { ...list.params, disclosureKey: disclosureKeyBytes32(cBody.spec.stake.disclosureKey), fixWindow: 30 * 86400, artifact: { kind: 1, repo: cBody.spec.repo, baseCommit: cBody.spec.baseCommit, chainId: '8453', addr: '0x5F2a00000000000000000000000000000000c0DE' } } };
  assert.deepEqual(listMismatches(cBody, cList, disclosureKeyBytes32), []);
});

// Node P20: the documents field. One glob per line becomes stake.documents, after the scope, as the maker typed it;
// an empty field is no field at all, so a listing without documents is the request it was. A line common refuses
// is the form's own issue, and the form sends nothing until it is fixed.
test('the documents field: up to 16 globs, one per line, as stake.documents after the scope; none, no field', () => {
  const none = toListingRequest(filled());
  assert.equal(Object.hasOwn(none.spec.stake, 'documents'), false);
  assert.equal(Object.hasOwn(initialForm(), 'documents'), true);
  const blank = toListingRequest(filled({ documents: '\n  \n' }));
  assert.deepEqual(blank, none);
  const r = toListingRequest(filled({ documents: 'README.md\n docs/** \n\n' }));
  assert.deepEqual(r.spec.stake.documents, ['README.md', 'docs/**']);
  const keys = Object.keys(r.spec.stake);
  assert.equal(keys.indexOf('documents'), keys.indexOf('scope') + 1);
  const standIn = { ...r.spec, env: { from: 'foundry', image: IMAGE, platform: 'linux/amd64', unpackedBytes: 1 } };
  assert.deepEqual(codeReview.validateCodeReviewSpec(standIn).issues, []);
});

test('a document line common refuses is the form\'s issue, by common\'s code, and blocks the request', () => {
  assert.equal(formIssues(filled({ documents: 'README.md' })).documents, undefined);
  const issues = formIssues(filled({ documents: 'README.md\n./docs/**\nREADME.md' }));
  assert.deepEqual(issues.documents.map((i) => [i.index, i.code]), [[1, 'STAKE_DOCUMENT_NOT_PLAIN'], [2, 'STAKE_DOCUMENT_DUPLICATE']]);
  assert.throws(() => toListingRequest(filled({ documents: '/etc/passwd' })), /documents/);
});
