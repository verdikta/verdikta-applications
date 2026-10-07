// Hunter-side guard for work-order bounties: before any upload, a result.json is checked against the request the bounty
// description commits to, with the discovery skill's own validator (the same rules the evaluator's structural gates assume).
// Pure apart from reading the named files; no network, no wallet.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * { workOrder, templateId, errors }: workOrder is false when the description carries no work order (nothing to check).
 * For a work order, the files must include a result.json that validates against the template's result schema, carries the
 * request's task_id and the stated input_sha256, and covers exactly the requested items; a fixture-only result is refused.
 */
export async function checkWorkOrderResult({ description, files = [] }) {
  const { parseWorkOrderDescription } = await import('../../verdikta-discover/scripts/work-order.mjs');
  const parsed = parseWorkOrderDescription(description);
  if (!parsed) return { workOrder: false, templateId: null, errors: [] };
  if (parsed.errors.length) return { workOrder: true, templateId: parsed.templateId, errors: parsed.errors.map(e => `bounty description: ${e}`) };
  const resultFile = files.find(f => path.basename(f) === 'result.json');
  if (!resultFile) return { workOrder: true, templateId: parsed.templateId, errors: ['A work-order bounty needs a result.json among the submitted files (see the fulfilment guide the description links)'] };
  let result;
  try { result = JSON.parse(await readFile(resultFile, 'utf8')); }
  catch (error) { return { workOrder: true, templateId: parsed.templateId, errors: [`result.json is not valid JSON: ${error.message}`] }; }
  const { validateResult } = await import('../../verdikta-discover/scripts/validation.mjs');
  const errors = validateResult(parsed.templateId, parsed.request, result, parsed.requestDigest, { production: true });
  return { workOrder: true, templateId: parsed.templateId, errors };
}
