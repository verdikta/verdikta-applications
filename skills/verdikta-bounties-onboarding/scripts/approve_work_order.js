#!/usr/bin/env node
// Bind a verdikta-discover assessment input to the owner's chat approval line and write the approved.json that
// create_bounty.js commissions. No wallet, API or network activity: the draft is derived with the discovery
// package's own preview code (the bytes the website's import and the owner's agent hash), the approval line must
// name that draft's hash and the money terms, and everything else comes from an operator-reviewed defaults file.
//
//   node approve_work_order.js --input assessment.json --approval "Approve 6a0eb529, payout 0.01 ETH, window 72h" \
//        --title "Outside review of the explainer rubric" [--notes "owner's words"] [--defaults commission-defaults.json] [--out-dir DIR]
//
// Then: node create_bounty.js --config <DIR>/approved.json --yes
// The owner's approval line is the authorization for --yes on that exact config and nothing else.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseEther } from 'ethers';
import { isMain } from './_cli.js';
import { arg } from './_lib.js';
import { defaultSecretsDir, ensureDir } from './_paths.js';

/** Approval lines in an owner message: hash prefix (8+ hex), payout in ETH, submission window in hours. */
export const APPROVAL_LINE = /\bapprove\s+([0-9a-f]{8,64})\b[\s,;:]*payout\s*[:=]?\s*(\d+(?:\.\d+)?)\s*eth\b[\s,;:]*window\s*[:=]?\s*(\d+)\s*h(?:ours?|rs?)?\b/gi;

export function parseApprovalLines(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const m of text.matchAll(APPROVAL_LINE)) {
    const hours = Number(m[3]);
    if (!Number.isSafeInteger(hours) || hours <= 0) continue;
    out.push({ hashPrefix: m[1].toLowerCase(), payoutEth: m[2], windowHours: hours, line: m[0] });
  }
  return out;
}

const REQUIRED_DEFAULTS = ['classId', 'juryNodes', 'oracle'];

export async function loadDefaults(file) {
  const defaults = JSON.parse(await fs.readFile(file, 'utf8'));
  if (defaults.fixture_only) throw new Error(`${file} is the shape example: copy it, replace the jury with real class models and remove fixture_only`);
  for (const k of REQUIRED_DEFAULTS) if (defaults[k] == null) throw new Error(`commission defaults need ${k}`);
  if (!Array.isArray(defaults.juryNodes) || !defaults.juryNodes.length) throw new Error('commission defaults need at least one jury node');
  for (const k of ['maxOracleFee', 'alpha', 'estimatedBaseCost', 'maxFeeBasedScaling']) if (defaults.oracle[k] == null) throw new Error(`commission defaults need oracle.${k}`);
  return defaults;
}

/**
 * Derive the draft, check the approval line against it, and return the config create_bounty.js takes.
 * `discover` is the loaded discovery package ({ preview, previewText, checkWorkOrderDraft, isAssessmentInput }).
 */
export function bindApproval({ input, approvalText, title, notes, defaults, discover }) {
  if (!discover.isAssessmentInput(input)) throw new Error('--input must be the agent\'s assessment input (a top-level request, no draft)');
  const derived = discover.preview(input);
  const text = discover.previewText(derived);
  const draftSha256 = createHash('sha256').update(text).digest('hex');
  const checked = discover.checkWorkOrderDraft(derived);
  if (!checked.ok) throw new Error(`The input does not derive a commissionable draft: ${checked.errors.join('; ')}`);
  const lines = parseApprovalLines(approvalText);
  if (!lines.length) throw new Error('No approval line found. Expected: Approve <hash prefix>, payout <X> ETH, window <N>h');
  const forDraft = lines.filter(l => draftSha256.startsWith(l.hashPrefix));
  if (!forDraft.length) throw new Error(`The approval names draft ${lines.map(l => l.hashPrefix).join(', ')}; this input derives ${draftSha256.slice(0, 16)}… Re-derive and ask for a fresh approval`);
  const approval = forDraft[0];
  if (parseEther(approval.payoutEth) <= 0n) throw new Error('Payout must be positive');
  const draft = checked.draft;
  if (!title || !String(title).trim()) throw new Error('--title required');
  const config = {
    approval: { line: approval.line, hashPrefix: approval.hashPrefix, draftSha256 },
    title: String(title).trim(),
    description: (notes && String(notes).trim()) || `${String(title).trim()}\n\n${input.task_summary || ''}`.trim(),
    workOrderDraftSha256: draftSha256,
    rubricJson: draft.rubric,
    threshold: draft.threshold,
    procurementMode: draft.procurement.mode,
    targetHunter: draft.procurement.mode === 'TARGETED' ? draft.procurement.targetHunter : null,
    bountyAmount: approval.payoutEth,
    submissionWindowHours: approval.windowHours,
    classId: defaults.classId,
    juryNodes: defaults.juryNodes,
    oracle: defaults.oracle,
    creatorAssessmentWindowSeconds: defaults.creatorAssessmentWindowSeconds ?? 0,
    workProductType: defaults.workProductType || 'research',
  };
  if (defaults.creatorDeterminationPayment != null) config.creatorDeterminationPayment = defaults.creatorDeterminationPayment;
  if (defaults.arbiterDeterminationPayment != null) config.arbiterDeterminationPayment = defaults.arbiterDeterminationPayment;
  return { config, draftText: text, draftSha256, approval, templateId: draft.template_id };
}

export async function loadDiscover() {
  const [core, workOrder] = await Promise.all([
    import('../../verdikta-discover/scripts/preview-core.mjs'),
    import('../../verdikta-discover/scripts/work-order.mjs'),
  ]);
  return { preview: core.preview, previewText: core.previewText, checkWorkOrderDraft: workOrder.checkWorkOrderDraft, isAssessmentInput: workOrder.isAssessmentInput };
}

export async function approveWorkOrder({ inputPath, approvalText, title, notes, defaultsPath, outDir, discover }) {
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const defaults = await loadDefaults(defaultsPath);
  const bound = bindApproval({ input, approvalText, title, notes, defaults, discover: discover || await loadDiscover() });
  const dir = outDir || path.join(defaultSecretsDir(), 'work-orders', bound.draftSha256.slice(0, 8));
  await ensureDir(dir);
  const draftPath = path.join(dir, 'draft.json'), approvedPath = path.join(dir, 'approved.json');
  bound.config.workOrderDraft = draftPath;
  // One approval, one bounty: an existing approved.json for this draft means it was already prepared (and
  // create_bounty.js refuses to create twice from the same config path through its state file).
  await fs.writeFile(draftPath, bound.draftText, { flag: 'wx', mode: 0o600 }).catch(e => { throw e.code === 'EEXIST' ? new Error(`${dir} already holds this draft; it was prepared before. Resume or inspect it instead of preparing it again`) : e; });
  await fs.writeFile(approvedPath, JSON.stringify(bound.config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...bound, dir, draftPath, approvedPath };
}

if (isMain(import.meta.url)) {
  const inputPath = arg('input'), approvalText = arg('approval'), title = arg('title');
  if (!inputPath || !approvalText || !title) {
    console.error('Usage: approve_work_order.js --input assessment.json --approval "Approve <hash prefix>, payout <X> ETH, window <N>h" --title "..." [--notes "..."] [--defaults commission-defaults.json] [--out-dir DIR]');
    process.exit(2);
  }
  const defaultsPath = arg('defaults') || path.join(defaultSecretsDir(), 'commission-defaults.json');
  approveWorkOrder({ inputPath, approvalText, title, notes: arg('notes'), defaultsPath, outDir: arg('out-dir') })
    .then(r => {
      console.log(`Draft ${r.draftSha256} (${r.templateId}) bound to the owner's approval: payout ${r.approval.payoutEth} ETH, window ${r.approval.windowHours} h, ${r.config.procurementMode}${r.config.targetHunter ? ' ' + r.config.targetHunter : ''}.`);
      console.log(`Wrote ${r.draftPath} and ${r.approvedPath}.`);
      console.log(`Next: node create_bounty.js --config ${r.approvedPath} --yes   (the approval line authorizes --yes for this config only)`);
    })
    .catch(e => { console.error(e.message); process.exit(1); });
}
