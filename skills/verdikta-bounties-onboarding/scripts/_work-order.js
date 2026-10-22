// Optional local handoff from the separate discovery package. No wallet/API activity.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { importDiscover } from './_discover.js';
export async function applyWorkOrder(config) {
  if (!config.workOrderDraft) return config;
  const raw = await readFile(config.workOrderDraft, 'utf8');
  const digest = createHash('sha256').update(raw).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(config.workOrderDraftSha256 || '') || digest !== config.workOrderDraftSha256) throw new Error('Draft differs from the owner-approved SHA-256 commitment');
  const assessment = JSON.parse(raw), draft = assessment.draft;
  const purpose = 'Commissioning a verdikta-discover work-order draft';
  const { templates } = await importDiscover('preview-core.mjs', purpose);
  const { checkWorkOrderDraft, composeEvaluationDescription } = await importDiscover('work-order.mjs', purpose);
  // The same verification the website's import runs; the checks and their order are unchanged.
  const checked = checkWorkOrderDraft(assessment);
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  if (!templates[draft.template_id] || JSON.stringify(config.rubricJson) !== JSON.stringify(draft.rubric) || config.threshold !== draft.threshold) throw new Error('Review and bind the same draft rubric and threshold');
  if (config.procurementMode !== draft.procurement.mode || (draft.procurement.mode === 'TARGETED' && config.targetHunter?.toLowerCase() !== draft.procurement.targetHunter.toLowerCase())) throw new Error('Procurement changed from the reviewed draft');
  // Commit the exact request/criteria content through the existing evaluation package.
  // Limit is checked locally before any upload (the server's composed-query cap is 32k).
  const { description } = composeEvaluationDescription({ baseDescription: config.description, draftSha256: digest, templateId: draft.template_id, request: draft.request });
  return { ...config, description, workOrderDraftSha256: digest };
}
