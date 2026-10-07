import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { preview, previewText } from '../../../verdikta-discover/scripts/preview-core.mjs';
import { checkWorkOrderDraft, isAssessmentInput } from '../../../verdikta-discover/scripts/work-order.mjs';
import { applyWorkOrder } from '../_work-order.js';
import { parseApprovalLines, bindApproval, approveWorkOrder, loadDefaults } from '../approve_work_order.js';

const discover = { preview, previewText, checkWorkOrderDraft, isAssessmentInput };
const defaults = { classId: 128, juryNodes: [{ provider: 'openai', model: 'gpt-5.6-terra', runs: 1, weight: 1 }], oracle: { maxOracleFee: '100000000000000', alpha: 500, estimatedBaseCost: '0', maxFeeBasedScaling: 1 } };

async function reviewInput() {
  const request = JSON.parse(await readFile(new URL('../../../verdikta-discover/examples/review-v1.request.json', import.meta.url), 'utf8'));
  request.fixture_only = false; request.task_id = 'approval-test-review';
  return { task_summary: 'Outside review of a public rubric', sharing_authorized: true, procurement_mode: 'OPEN', request };
}
const hashOf = input => createHash('sha256').update(previewText(preview(input))).digest('hex');

test('approval lines: hash prefix, payout and window, in any of the accepted spellings', () => {
  const lines = parseApprovalLines('Looks good.\nApprove 6a0eb529, payout 0.01 ETH, window 72h\nthanks');
  assert.deepEqual(lines.map(l => [l.hashPrefix, l.payoutEth, l.windowHours]), [['6a0eb529', '0.01', 72]]);
  assert.equal(parseApprovalLines('APPROVE 6A0EB52901EF payout: 0.5 eth window: 24 hours')[0].hashPrefix, '6a0eb52901ef');
  assert.equal(parseApprovalLines('approve 6a0eb529 payout 1 ETH window 48 hrs')[0].windowHours, 48);
  assert.deepEqual(parseApprovalLines('Approve 6a0eb5, payout 0.01 ETH, window 72h'), [], 'fewer than 8 hex chars is not an approval');
  assert.deepEqual(parseApprovalLines('Approve 6a0eb529, payout 0.01 ETH'), [], 'a window is required');
  assert.deepEqual(parseApprovalLines('I approve of this payout window'), []);
  assert.equal(parseApprovalLines('Approve 6a0eb529, payout 0.01 ETH, window 0h').length, 0);
});

test('an approval that names the derived draft binds rubric, threshold, supplier and terms; create_bounty.js accepts the result', async () => {
  const input = await reviewInput(); const sha = hashOf(input);
  const bound = bindApproval({ input, approvalText: `Great.\nApprove ${sha.slice(0, 8)}, payout 0.01 ETH, window 72h`, title: 'Rubric review', defaults, discover });
  assert.equal(bound.draftSha256, sha); assert.equal(bound.templateId, 'review-v1');
  const c = bound.config;
  assert.equal(c.bountyAmount, '0.01'); assert.equal(c.submissionWindowHours, 72); assert.equal(c.procurementMode, 'OPEN'); assert.equal(c.targetHunter, null);
  assert.equal(c.threshold, 80); assert.equal(c.classId, 128); assert.equal(c.workProductType, 'research'); assert.equal(c.creatorAssessmentWindowSeconds, 0);
  assert.deepEqual(c.rubricJson, preview(input).draft.rubric);
  assert.match(c.description, /Rubric review/);
  // The binder (what create_bounty.js runs first) accepts exactly this config once the draft file exists.
  const dir = await mkdtemp(`${tmpdir()}/verdikta-approve-`);
  try {
    const file = `${dir}/draft.json`; await writeFile(file, bound.draftText);
    const applied = await applyWorkOrder({ ...c, workOrderDraft: file });
    assert.match(applied.description, /Approved work-order draft SHA-256: /); assert.match(applied.description, /Service: review-v1/);
    assert.match(applied.description, /result\.input_sha256/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a targeted draft keeps its supplier; the owner notes become the words above the committed block', async () => {
  const input = { ...(await reviewInput()), procurement_mode: 'TARGETED', targetHunter: '0x1111111111111111111111111111111111111111' };
  const sha = hashOf(input);
  const bound = bindApproval({ input, approvalText: `Approve ${sha.slice(0, 12)}, payout 0.02 ETH, window 48h`, title: 'T', notes: 'Please be thorough.', defaults, discover });
  assert.equal(bound.config.procurementMode, 'TARGETED'); assert.equal(bound.config.targetHunter, '0x1111111111111111111111111111111111111111');
  assert.equal(bound.config.description, 'Please be thorough.');
});

test('refusals: another draft, no line, synthetic request, unscoped input, placeholder defaults', async () => {
  const input = await reviewInput(); const sha = hashOf(input);
  assert.throws(() => bindApproval({ input, approvalText: 'Approve deadbeef, payout 0.01 ETH, window 72h', title: 'T', defaults, discover }), /names draft deadbeef/);
  assert.throws(() => bindApproval({ input, approvalText: 'post it', title: 'T', defaults, discover }), /No approval line/);
  assert.throws(() => bindApproval({ input, approvalText: `Approve ${sha.slice(0, 8)}, payout 0 ETH, window 72h`, title: 'T', defaults, discover }), /positive/);
  const synthetic = { ...input, request: { ...input.request, fixture_only: true } };
  assert.throws(() => bindApproval({ input: synthetic, approvalText: `Approve ${hashOf(synthetic).slice(0, 8)}, payout 0.01 ETH, window 72h`, title: 'T', defaults, discover }), /Synthetic/);
  const unscoped = { ...input, sharing_authorized: false };
  assert.throws(() => bindApproval({ input: unscoped, approvalText: `Approve ${hashOf(unscoped).slice(0, 8)}, payout 0.01 ETH, window 72h`, title: 'T', defaults, discover }), /commissionable/);
  assert.throws(() => bindApproval({ input: preview(input), approvalText: 'Approve 00000000, payout 0.01 ETH, window 72h', title: 'T', defaults, discover }), /assessment input/);
  const dir = await mkdtemp(`${tmpdir()}/verdikta-defaults-`);
  try {
    await writeFile(`${dir}/d.json`, await readFile(new URL('../../examples/commission-defaults.json', import.meta.url)));
    await assert.rejects(loadDefaults(`${dir}/d.json`), /shape example/);
    await writeFile(`${dir}/d2.json`, JSON.stringify({ ...defaults, oracle: { alpha: 500 } }));
    await assert.rejects(loadDefaults(`${dir}/d2.json`), /oracle\.maxOracleFee/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approveWorkOrder writes draft.json (the hashed bytes) and approved.json once per draft', async () => {
  const input = await reviewInput(); const sha = hashOf(input);
  const dir = await mkdtemp(`${tmpdir()}/verdikta-wo-`);
  try {
    await writeFile(`${dir}/input.json`, JSON.stringify(input)); await writeFile(`${dir}/defaults.json`, JSON.stringify(defaults));
    const r = await approveWorkOrder({ inputPath: `${dir}/input.json`, approvalText: `Approve ${sha.slice(0, 8)}, payout 0.01 ETH, window 72h`, title: 'Rubric review', defaultsPath: `${dir}/defaults.json`, outDir: `${dir}/out`, discover });
    assert.equal(createHash('sha256').update(await readFile(r.draftPath)).digest('hex'), sha, 'draft.json holds the bytes the hash covers');
    const approved = JSON.parse(await readFile(r.approvedPath, 'utf8'));
    assert.equal(approved.workOrderDraft, r.draftPath); assert.equal(approved.workOrderDraftSha256, sha); assert.equal(approved.approval.hashPrefix, sha.slice(0, 8));
    await assert.rejects(approveWorkOrder({ inputPath: `${dir}/input.json`, approvalText: `Approve ${sha.slice(0, 8)}, payout 0.01 ETH, window 72h`, title: 'Rubric review', defaultsPath: `${dir}/defaults.json`, outDir: `${dir}/out`, discover }), /prepared before/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
