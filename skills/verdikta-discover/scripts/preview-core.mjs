import { supplierAddress } from './address.mjs';
import { validateRequest, validateLocalSummary, validateMarketContext, requestItemIds } from './validation.mjs';
import sourceTemplate from '../templates/source-check-v1.template.json' with { type: 'json' };
import packTemplate from '../templates/evidence-pack-v1.template.json' with { type: 'json' };
import reviewTemplate from '../templates/review-v1.template.json' with { type: 'json' };
import taskTemplate from '../templates/real-world-task-v1.template.json' with { type: 'json' };
import sourceRubric from '../templates/source-check-v1.rubric.json' with { type: 'json' };
import packRubric from '../templates/evidence-pack-v1.rubric.json' with { type: 'json' };
import reviewRubric from '../templates/review-v1.rubric.json' with { type: 'json' };
import taskRubric from '../templates/real-world-task-v1.rubric.json' with { type: 'json' };
export const templates = { 'source-check-v1': sourceTemplate, 'evidence-pack-v1': packTemplate, 'review-v1': reviewTemplate, 'real-world-task-v1': taskTemplate };
const rubrics = { 'source-check-v1': sourceRubric, 'evidence-pack-v1': packRubric, 'review-v1': reviewRubric, 'real-world-task-v1': taskRubric };
// What leaves preview() is the caller's to mutate: never hand out the shared template objects themselves.
const own = value => (value === undefined ? undefined : structuredClone(value));

/** The template a request's shape implies when the caller names none. */
export function inferTemplateId(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  if (request.claims) return 'source-check-v1';
  if (request.entities) return 'evidence-pack-v1';
  if (request.artifact) return 'review-v1';
  if (request.evidence_spec) return 'real-world-task-v1';
  return null;
}

const DEFAULT_REASON = {
  'review-v1': 'An outside review of the artifact, with no stake in it, may be useful.',
  'real-world-task-v1': 'The task needs a person at the place; a bounded work order with an evidence specification can commission it.',
};
const WHY_OUTSOURCE = {
  'review-v1': ['An outside reviewer has no stake in the artifact and brings a second pair of eyes', 'Independent judgment the owner can weigh against the agent\'s own view'],
  'real-world-task-v1': ['The task must be performed by someone present in the physical world', 'An agent can commission and check this work but cannot do it'],
};
const EXTRA_RISK = {
  'review-v1': 'Judgment criteria are weighed by the evaluator; agreement with the owner\'s own view is not guaranteed.',
  'real-world-task-v1': 'Evidence is assessed, not proven: the challenge token and consistency checks reduce the risk of reused or generated evidence without removing it.',
};

// Pure assessment of caller-declared context, not an NLP classifier or purchase authority.
export function preview(input = {}) {
  const { request, task_summary = '', template_id, local_sufficient = false,
  sharing_authorized, unsuitable_reason = '', handoff_requested = false,
  procurement_mode = 'UNSELECTED', targetHunter = null, local_summary = null, market_context = null, network = 'UNSELECTED' } = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const kind = template_id ?? inferTemplateId(request);
  const errors = validateRequest(kind, request);
  let decision = 'PREVIEW', reason = local_summary?.mode === 'RESIDUAL'
    ? 'Part of the request was resolved locally by the agent, which is not independent verification. Only the remaining items need outside work.'
    : local_summary?.mode === 'NON_INDEPENDENT_PASS'
      ? 'Independent review was requested, so the whole request goes out. The agent\'s own pass is informational and not independent.'
      : DEFAULT_REASON[kind] ?? 'A bounded independent check or parallel research step may be useful.';
  if (unsuitable_reason || (request?.data_classification && request.data_classification !== 'PUBLIC_NON_SENSITIVE')) {
    decision = 'UNSUITABLE'; reason = unsuitable_reason || 'The pilot accepts only public non-sensitive inputs.';
  } else if (local_sufficient === true) {
    decision = 'LOCAL'; reason = 'Available local tools and sources meet the need; coordination and evaluation add unnecessary cost.';
  } else if (sharing_authorized !== true) {
    decision = sharing_authorized === false ? 'UNSUITABLE' : 'NEEDS_SCOPE'; reason = sharing_authorized === false ? 'Sharing was declined; keep this task local.' : 'Obtain sharing approval before preparing an external work order.';
  } else if (errors.length) {
    decision = 'NEEDS_SCOPE'; reason = 'Define or reduce the bounded request before considering outside work.';
  } else if (handoff_requested === true) {
    decision = 'HANDOFF_REQUESTED'; reason = 'Funding requires the separate authorized commissioning path.';
  }
  const targetingErrors = [];
  if (!['OPEN', 'TARGETED'].includes(procurement_mode)) targetingErrors.push('Select OPEN or TARGETED explicitly');
  if (procurement_mode === 'TARGETED' && !supplierAddress(targetHunter)) targetingErrors.push('Targeted procurement needs a nonzero 0x-prefixed supplier address with a valid checksum when mixed case');
  if (procurement_mode !== 'TARGETED' && targetHunter) targetingErrors.push('A supplier address requires TARGETED mode');
  if (targetingErrors.length && ['PREVIEW', 'HANDOFF_REQUESTED'].includes(decision)) { decision = 'NEEDS_SCOPE'; reason = targetingErrors[0]; }
  // Local findings travel beside the draft, never inside it. An inconsistent summary means the
  // draft is not trustworthy as written, so it goes back for scope instead of being emitted.
  const localErrors = local_summary && ['PREVIEW', 'HANDOFF_REQUESTED'].includes(decision) && !errors.length && !targetingErrors.length
    ? validateLocalSummary(local_summary, kind, request) : [];
  if (localErrors.length) { decision = 'NEEDS_SCOPE'; reason = localErrors[0]; }
  const template = templates[kind];
  const procurement = { mode: ['OPEN', 'TARGETED'].includes(procurement_mode) ? procurement_mode : 'UNSELECTED', targetHunter: procurement_mode === 'TARGETED' ? supplierAddress(targetHunter) : null };
  const selectedNetwork = ['BASE', 'BASE_SEPOLIA'].includes(network) ? network : 'UNSELECTED';
  // Market context is optional provenance-labelled context. An invalid one is left out (and said so)
  // rather than blocking the draft; it never touches costs, price_status or availability_status.
  const marketErrors = market_context ? validateMarketContext(market_context, selectedNetwork) : [];
  const inputsNeeded = [...errors, ...targetingErrors, ...localErrors, ...marketErrors.map(e => `Market context omitted: ${e}`), ...(sharing_authorized !== true ? ['Obtain sharing approval'] : [])];
  const hasDraft = ['PREVIEW', 'HANDOFF_REQUESTED'].includes(decision) && !errors.length && !targetingErrors.length;
  const residual = hasDraft && local_summary?.mode === 'RESIDUAL';
  return {
    schema_version: '1.0.0', decision, quote_status: 'DRAFT_NOT_QUOTED', template_id: template ? kind : null,
    network: selectedNetwork, reason, task_summary: task_summary || request?.task_id || 'Unscoped task',
    supplier: { status: 'UNKNOWN', candidates: [] }, price_status: 'UNKNOWN', availability_status: 'UNKNOWN',
    costs: { reward_wei: null, buyer_gas_estimate_wei: null, evaluation_prepay_estimate_wei: null, explanation: 'No supplier offer or live fee observation exists in this local preview.' },
    can_commission: false, authorization_granted: false, funds_moved: false,
    procurement,
    deliverable: own(template?.delivery) || [], acceptance_criteria: own(rubrics[kind]?.criteria) || [],
    inputs_needed: ['LOCAL','UNSUITABLE'].includes(decision) ? [] : inputsNeeded,
    risks: ['Later publication may expose task data.', 'No supplier, availability, price or SLA is confirmed.', 'Evidence shape does not authenticate sources; independently evaluated settlement is fallible.', 'Finalization and refunds can require separate state-dependent transactions.', ...(template && EXTRA_RISK[kind] ? [EXTRA_RISK[kind]] : [])],
    commissioning_requirements: own(template?.required_owner_decisions) || ['Define a supported task first'],
    why_outsource: residual
      ? ['The agent could not settle these items from the sources it could read: unresolved, conflicting or inaccessible', 'Independent adjudication of what the sources leave open']
      : (template && WHY_OUTSOURCE[kind]) || ['Independent checking or missing research capacity', 'Separable work can run in parallel'],
    why_not_outsource: ['Local execution may be simpler', 'Supplier, price and turnaround remain unknown'],
    next_action: decision === 'LOCAL' ? 'Do locally.' : decision === 'UNSUITABLE' ? 'Do not publish or commission this task.' : decision === 'NEEDS_SCOPE' ? 'Resolve the missing inputs before preparing a draft.' : 'Review the draft; obtain supplier agreement and separately authorize exact funding terms.',
    draft: hasDraft ? { template_id: kind, request, procurement, rubric: own(rubrics[kind]), threshold: template.recommended_threshold, sharing_authorized: true } : null,
    ...(hasDraft && local_summary ? { local_summary } : {}),
    ...(market_context && !marketErrors.length ? { market_context } : {}),
  };
}

/** The exact text scripts/preview.mjs prints for a preview: the bytes the website import and the onboarding binder commit to. */
export const previewText = result => `${JSON.stringify(result, null, 2)}\n`;

/**
 * What an agent checking its assessment input needs to see, instead of the whole preview: whether the input makes a draft,
 * what is missing, which items the draft holds, and the SHA-256 of the preview text, which the website shows again when the
 * owner imports the same input. `hashHex` maps a string to its SHA-256 hex digest (the caller supplies it, so this stays pure).
 */
export function checkSummary(result, hashHex) {
  const draft = result.draft;
  return {
    decision: result.decision,
    reason: result.reason,
    inputs_needed: result.inputs_needed,
    template_id: result.template_id,
    drafted_items: draft ? requestItemIds(draft.template_id, draft.request) : [],
    local_summary: result.local_summary
      ? { mode: result.local_summary.mode, resolved: result.local_summary.resolved.length, residual: result.local_summary.residual.length } : null,
    market_context_included: Boolean(result.market_context),
    draft_sha256: draft ? hashHex(previewText(result)) : null,
    deliver: draft
      ? 'Return your assessment input itself, unchanged, in a fenced json block: not this summary and not the full preview. The owner imports it on the Create Bounty page, which derives this same draft and shows this draft_sha256.'
      : 'No draft: fix the input or ask the owner for what inputs_needed lists.',
  };
}
