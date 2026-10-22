// Hunter-side guard for work-order bounties: before any upload, a result.json is checked against the request the bounty
// description commits to, with the discovery skill's own validator (the same rules the evaluator's structural gates assume).
// Pure apart from reading the named files; no network, no wallet.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { importDiscover } from './_discover.js';

// The lines verdikta-discover's composeEvaluationDescription writes into a work-order bounty. Its parser
// (parseWorkOrderDescription) needs all four, so a description with none of them is no work order and the sibling is
// never loaded for it; any one of them sends the description to the full parser, which then needs the sibling.
export const WORK_ORDER_MARKERS = Object.freeze([
  /^Service: [a-z0-9-]+\r?$/m,
  /^Request bytes SHA-256 \(result\.input_sha256\): /m,
  /^Approved work-order draft SHA-256: /m,
  /^Request \(exact UTF-8 JSON bytes, no trailing newline\):/m,
]);
export const looksLikeWorkOrder = (description) => typeof description === 'string' && WORK_ORDER_MARKERS.some((marker) => marker.test(description));

/**
 * { workOrder, templateId, errors }: workOrder is false when the description carries no work order (nothing to check).
 * For a work order, the files must include a result.json that validates against the template's result schema, carries the
 * request's task_id and the stated input_sha256, and covers exactly the requested items; a fixture-only result is refused.
 */
export async function checkWorkOrderResult({ description, files = [], loadModule }) {
  if (!looksLikeWorkOrder(description)) return { workOrder: false, templateId: null, errors: [] };
  const service = /^Service: ([a-z0-9-]+)\r?$/m.exec(description)?.[1];
  const purpose = `Submitting to a work-order bounty${service ? ` (Service: ${service})` : ''}`;
  const { parseWorkOrderDescription } = await importDiscover('work-order.mjs', purpose, loadModule);
  const parsed = parseWorkOrderDescription(description);
  if (!parsed) return { workOrder: false, templateId: null, errors: [] };
  if (parsed.errors.length) return { workOrder: true, templateId: parsed.templateId, errors: parsed.errors.map(e => `bounty description: ${e}`) };
  const resultFile = files.find(f => path.basename(f) === 'result.json');
  if (!resultFile) return { workOrder: true, templateId: parsed.templateId, errors: ['A work-order bounty needs a result.json among the submitted files (see the fulfilment guide the description links)'] };
  let result;
  try { result = JSON.parse(await readFile(resultFile, 'utf8')); }
  catch (error) { return { workOrder: true, templateId: parsed.templateId, errors: [`result.json is not valid JSON: ${error.message}`] }; }
  const { validateResult } = await importDiscover('validation.mjs', purpose, loadModule);
  const errors = validateResult(parsed.templateId, parsed.request, result, parsed.requestDigest, { production: true });
  return { workOrder: true, templateId: parsed.templateId, errors };
}
