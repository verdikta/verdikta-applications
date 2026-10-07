// Work-order draft verification and evaluation-description composition, shared by the onboarding
// binder (node) and the website's Create Bounty import (browser). Pure: no network, files,
// environment or node-only imports, and hashing through @noble/hashes (already a dependency).
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { preview, previewText, templates } from './preview-core.mjs';
import { validateRequest } from './validation.mjs';

export { previewText };

/**
 * An assessment input (the agent's own judgments, as in examples/assessment.json) rather than a preview the script printed.
 * Only an input has a top-level `request`; a preview carries its request inside `draft`.
 */
export const isAssessmentInput = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Boolean(value.request) && typeof value.request === 'object' && !Array.isArray(value.request) && !Object.hasOwn(value, 'draft');

// Conservative cap on the composed evaluation description (the composed-query cap is about 10k).
export const MAX_DESCRIPTION_CHARS = 6000;
const encoder = new TextEncoder();
export const sha256Hex = input => bytesToHex(sha256(typeof input === 'string' ? encoder.encode(input) : input));

/** Structural equality for JSON values; key order does not matter. */
export function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
}

/**
 * The draft checks both commissioning paths require, in the order the binder has always run them:
 * an accepted decision and a scoped, unquoted draft; the draft re-derives exactly from a fresh preview
 * of its own request; procurement agrees in both places; no fixture-only request; a valid request.
 * Returns { ok, errors, draft }. Config binding (rubric, threshold, supplier) stays with the caller.
 */
export function checkWorkOrderDraft(assessment) {
  const fail = (...errors) => ({ ok: false, errors, draft: null });
  const draft = assessment?.draft;
  if (assessment?.quote_status !== 'DRAFT_NOT_QUOTED' || !['PREVIEW', 'HANDOFF_REQUESTED'].includes(assessment?.decision) || !draft || typeof draft !== 'object') return fail('Only a scoped draft may be handed to commission mode');
  const checked = preview({ request: draft.request, template_id: draft.template_id, sharing_authorized: draft.sharing_authorized, procurement_mode: draft.procurement?.mode, targetHunter: draft.procurement?.targetHunter });
  if (!checked.draft || !sameJson(checked.draft, draft) || !sameJson(assessment.procurement, draft.procurement)) return fail('Stored draft does not match a fresh scoped preview');
  if (draft.request.fixture_only) return fail('Synthetic requests cannot be commissioned');
  const errors = validateRequest(draft.template_id, draft.request);
  return errors.length ? fail(...errors) : { ok: true, errors: [], draft };
}

// Where a supplier finds how to deliver: the fulfilment guide and the template's result schema, on the repository's main branch.
export const FULFILMENT_GUIDE_URL = 'https://raw.githubusercontent.com/verdikta/verdikta-applications/refs/heads/main/skills/verdikta-discover/references/fulfilment.md';
export const resultSchemaUrl = templateId => `https://raw.githubusercontent.com/verdikta/verdikta-applications/refs/heads/main/skills/verdikta-discover/schemas/${templateId}.result.schema.json`;
const REQUEST_LINE_PREFIX = 'Request bytes SHA-256 (result.input_sha256): ';
const REQUEST_MARKER = 'Request (exact UTF-8 JSON bytes, no trailing newline):';

/**
 * The evaluation description commits the exact request, so a supplier and the evaluator see the bytes the
 * owner approved. Only draft.request goes in: local findings and market context never do. After the request come
 * the pointer a supplier needs (the fulfilment guide and the result schema) and the template's delivery note
 * (templates/<id>.template.json), which closes the description.
 */
export function composeEvaluationDescription({ baseDescription, draftSha256, templateId, request }) {
  const requestBytes = JSON.stringify(request);
  const requestDigest = sha256Hex(requestBytes);
  const deliveryNote = templates[templateId]?.delivery_note ?? 'Deliver result.json and readable evidence.md.';
  const pointer = `How to deliver: ${FULFILMENT_GUIDE_URL} ; result.json must validate against ${resultSchemaUrl(templateId)} and carry the request bytes SHA-256 above as input_sha256.`;
  const description = `${baseDescription}\n\nApproved work-order draft SHA-256: ${draftSha256}\nService: ${templateId}\n${REQUEST_LINE_PREFIX}${requestDigest}\n${REQUEST_MARKER}\n${requestBytes}\n${pointer}\n${deliveryNote}`;
  if (description.length > MAX_DESCRIPTION_CHARS) throw new Error('Work-order instructions exceed the conservative description budget; reduce scope before commissioning');
  return { description, requestDigest };
}

/**
 * The work order a bounty description commits to, read back for a supplier or a hunter-side check: the template id from
 * the Service line, the request from the exact JSON line after the request marker, and the digests. Returns null when the
 * description carries no work order; errors name a corrupted one (a request line whose bytes no longer hash to the stated digest).
 */
export function parseWorkOrderDescription(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  const service = lines.find(l => /^Service: [a-z0-9-]+$/.test(l));
  const digestLine = lines.find(l => l.startsWith(REQUEST_LINE_PREFIX));
  const draftLine = lines.find(l => /^Approved work-order draft SHA-256: [0-9a-f]{64}$/.test(l));
  const at = lines.indexOf(REQUEST_MARKER);
  if (!service || !digestLine || !draftLine || at < 0 || at + 1 >= lines.length) return null;
  const templateId = service.slice('Service: '.length);
  const statedDigest = digestLine.slice(REQUEST_LINE_PREFIX.length).trim();
  const requestLine = lines[at + 1];
  const errors = [];
  let request = null;
  try { request = JSON.parse(requestLine); } catch { errors.push('The request line is not JSON'); }
  if (!/^[0-9a-f]{64}$/.test(statedDigest)) errors.push('The stated request digest is not a SHA-256');
  else if (request && sha256Hex(requestLine) !== statedDigest) errors.push('The request line does not hash to the stated digest');
  if (!templates[templateId]) errors.push(`Unknown service template: ${templateId}`);
  return { templateId, request, requestDigest: statedDigest, draftSha256: draftLine.slice('Approved work-order draft SHA-256: '.length), errors };
}
