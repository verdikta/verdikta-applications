// Import of a work-order draft into the Create Bounty form: either the preview .json that `verdikta-discover` or the
// Agents-page preview produces, or the assessment input an agent returned (then the preview is derived here). Pure and
// browser-safe: the draft is read locally, verified with the skill's own code (the same checks and the same description
// composition the onboarding binder uses) and turned into form values. Nothing is sent anywhere. Load this module
// lazily: it pulls in AJV, which compiles schemas at import time and so needs a CSP that allows evaluation (see the
// skill's references/install.md).
import { checkWorkOrderDraft, composeEvaluationDescription, sha256Hex, sameJson, isAssessmentInput, previewText } from '../../../../skills/verdikta-discover/scripts/work-order.mjs';
import { preview } from '../../../../skills/verdikta-discover/scripts/preview-core.mjs';
import { validatePreview, requestItemIds } from '../../../../skills/verdikta-discover/scripts/validation.mjs';

export const MAX_DRAFT_BYTES = 256 * 1024;
const TEMPLATE_LABEL = { 'source-check-v1': 'Technical claim source check', 'evidence-pack-v1': 'Bounded evidence pack', 'review-v1': 'Bounded review of a public artifact', 'real-world-task-v1': 'Real-world task with an evidence pack' };
const ITEM_NOUN = { 'source-check-v1': 'claims', 'evidence-pack-v1': 'cells', 'review-v1': 'review items', 'real-world-task-v1': 'steps' };
const SITE_NETWORK = { base: 'BASE', 'base-sepolia': 'BASE_SEPOLIA' };
const MISMATCH = 'Stored draft does not match a fresh scoped preview';

/**
 * Verify draft bytes: a preview the skill's script printed, or the assessment input an agent returned. A preview's
 * SHA-256 is of its exact bytes, which is what the onboarding binder commits to. An input is turned into its preview here
 * with the skill's own preview code, and the SHA-256 is of the text the script prints for that same input
 * (`node scripts/preview.bundle.mjs input.json`), so the website, the script and the binder agree on the draft.
 * Returns { ok, errors, sha256, assessment, draft, summary, extras, notes, derived, previewText }.
 */
export function inspectDraftBytes(bytes) {
  const result = { ok: false, errors: [], sha256: null, assessment: null, draft: null, summary: null, extras: { local_summary: null, market_context: null }, notes: [], derived: false, previewText: null };
  if (!(bytes instanceof Uint8Array)) { result.errors.push('Choose a work-order draft file or paste its JSON'); return result; }
  if (bytes.length === 0) { result.errors.push('The draft is empty'); return result; }
  if (bytes.length > MAX_DRAFT_BYTES) { result.errors.push(`The draft is larger than ${MAX_DRAFT_BYTES / 1024} KB`); return result; }
  let assessment;
  try { assessment = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { result.errors.push('The draft is not valid UTF-8 JSON'); return result; }
  let committed = bytes;
  if (isAssessmentInput(assessment)) {
    assessment = preview(structuredClone(assessment));
    if (!assessment.draft) { result.errors.push(`This assessment input does not make a draft (${assessment.decision}): ${assessment.reason}`, ...assessment.inputs_needed); return result; }
    result.derived = true; result.previewText = previewText(assessment);
    committed = new TextEncoder().encode(result.previewText);
    result.notes.push('Derived from the assessment input with the skill’s preview code. The SHA-256 is that of the preview the skill’s script prints for the same input.', ...assessment.inputs_needed);
  }
  result.sha256 = sha256Hex(committed);
  const checked = checkWorkOrderDraft(assessment);
  if (!checked.ok) {
    result.errors.push(...checked.errors);
    if (!result.derived && checked.errors.includes(MISMATCH)) result.errors.push('This preview was shortened or edited after the script printed it. Paste the assessment input the agent returned instead, or the script’s output unchanged.');
    return result;
  }
  const { draft } = checked;
  result.assessment = assessment; result.draft = draft;
  result.summary = {
    template_id: draft.template_id, template_label: TEMPLATE_LABEL[draft.template_id] ?? draft.template_id, task_id: draft.request.task_id,
    items: requestItemIds(draft.template_id, draft.request).length, item_noun: ITEM_NOUN[draft.template_id] ?? 'items', procurement: draft.procurement, network: assessment.network ?? 'UNSELECTED',
    task_summary: typeof assessment.task_summary === 'string' ? assessment.task_summary : '',
  };
  // Local findings and market context are shown for the owner's information only. They are not part of the
  // commissioned request, and they are hidden unless the whole assessment validates.
  const extraErrors = validatePreview(assessment);
  if (extraErrors.length) result.notes.push('The draft is accepted, but other sections of the file failed validation and are not shown.');
  else { result.extras.local_summary = assessment.local_summary ?? null; result.extras.market_context = assessment.market_context ?? null; }
  result.ok = true;
  return result;
}

/** Form values a verified draft prefills. The payout is never prefilled: nothing in a draft is a quote. */
export function draftToFormPatch(imported) {
  const { draft, summary } = imported;
  return {
    threshold: draft.threshold,
    rubric: {
      title: draft.rubric.title, description: '',
      criteria: draft.rubric.criteria.map(c => ({ id: c.id, label: c.label, must: !!c.must, weight: Number(c.weight), instructions: c.description })),
      forbiddenContent: draft.rubric.forbidden_content ?? [],
    },
    targetHunter: draft.procurement.mode === 'TARGETED' ? draft.procurement.targetHunter : '',
    suggestedTitle: `${summary.template_label}: ${summary.items} ${summary.item_noun}`,
    baseDescription: summary.task_summary,
  };
}

const canonicalCriteria = list => (list || []).map(c => ({ id: c.id, label: c.label, must: !!c.must, weight: Number(c.weight), description: c.description }));

/**
 * What the form currently holds that no longer matches the imported draft. `rubric` is the rubric as the form would
 * upload it. A TARGETED draft can never silently become OPEN, and an OPEN draft can never silently gain a target.
 */
export function draftDivergence(draft, { rubric, threshold, targetHunter }) {
  const issues = [];
  if (Number(threshold) !== draft.threshold) issues.push('threshold');
  if (rubric?.title !== draft.rubric.title) issues.push('rubric title');
  if (!sameJson(canonicalCriteria(rubric?.criteria), canonicalCriteria(draft.rubric.criteria))) issues.push('rubric criteria');
  if (!sameJson(rubric?.forbiddenContent ?? rubric?.forbidden_content ?? [], draft.rubric.forbidden_content ?? [])) issues.push('forbidden content');
  const wanted = draft.procurement.mode === 'TARGETED' ? draft.procurement.targetHunter.toLowerCase() : '';
  if (String(targetHunter || '').toLowerCase() !== wanted) issues.push(draft.procurement.mode === 'TARGETED' ? 'supplier address' : 'supplier (an open draft cannot gain a target)');
  return issues;
}

/** The evaluation description to send: the owner's text plus the committed work-order block. */
export function composeImportedDescription(imported, baseDescription) {
  return composeEvaluationDescription({ baseDescription, draftSha256: imported.sha256, templateId: imported.draft.template_id, request: imported.draft.request });
}

/** A selected network in the draft must be the site's network. */
export function networkMismatch(draftNetwork, siteNetwork) {
  return Boolean(draftNetwork && draftNetwork !== 'UNSELECTED' && SITE_NETWORK[siteNetwork] && SITE_NETWORK[siteNetwork] !== draftNetwork);
}
