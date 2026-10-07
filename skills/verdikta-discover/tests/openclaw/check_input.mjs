#!/usr/bin/env node
// Round-11 scorer helper: reads one assessment input (JSON) from standard input and prints what the scorer needs to know
// about it, using the skill's own code: the decision and template preview() derives, whether checkWorkOrderDraft accepts
// the derived preview (the "fundable" gate), the preview SHA-256, and the template the request's shape implies.
import { createHash } from 'node:crypto';
import { preview, previewText, inferTemplateId } from '../../scripts/preview-core.mjs';
import { checkWorkOrderDraft } from '../../scripts/work-order.mjs';

let text = '';
for await (const chunk of process.stdin) text += chunk;
let input;
try { input = JSON.parse(text); } catch (error) { console.log(JSON.stringify({ error: `not JSON: ${error.message}` })); process.exit(0); }
const result = preview(structuredClone(input));
const checked = result.draft ? checkWorkOrderDraft(result) : { ok: false, errors: ['no draft'] };
console.log(JSON.stringify({
  decision: result.decision,
  template_id: result.template_id,
  inferred_template: inferTemplateId(input?.request),
  inputs_needed: result.inputs_needed,
  fundable: checked.ok,
  errors: checked.errors,
  draft_sha256: result.draft ? createHash('sha256').update(previewText(result)).digest('hex') : null,
  source_mode: input?.request?.source_policy?.mode ?? null,
  procurement_mode: input?.procurement_mode ?? null,
  has_local_summary: Boolean(input?.local_summary),
}));
