import { supplierAddress } from './address.mjs';
import previewSchema from '../schemas/preview.schema.json' with { type: 'json' };
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import sourceRequest from '../schemas/source-check-v1.request.schema.json' with { type: 'json' };
import sourceResult from '../schemas/source-check-v1.result.schema.json' with { type: 'json' };
import packRequest from '../schemas/evidence-pack-v1.request.schema.json' with { type: 'json' };
import packResult from '../schemas/evidence-pack-v1.result.schema.json' with { type: 'json' };
import reviewRequest from '../schemas/review-v1.request.schema.json' with { type: 'json' };
import reviewResult from '../schemas/review-v1.result.schema.json' with { type: 'json' };
import taskRequest from '../schemas/real-world-task-v1.request.schema.json' with { type: 'json' };
import taskResult from '../schemas/real-world-task-v1.result.schema.json' with { type: 'json' };

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = {
  'source-check-v1': { request: ajv.compile(sourceRequest), result: ajv.compile(sourceResult) },
  'evidence-pack-v1': { request: ajv.compile(packRequest), result: ajv.compile(packResult) },
  'review-v1': { request: ajv.compile(reviewRequest), result: ajv.compile(reviewResult) },
  'real-world-task-v1': { request: ajv.compile(taskRequest), result: ajv.compile(taskResult) },
};
export const TEMPLATE_IDS = Object.keys(validators);
// The templates whose request is a list of source-bound items the agent can settle itself: only these take a local_summary.
export const HYBRID_TEMPLATE_IDS = ['source-check-v1', 'evidence-pack-v1'];
// Keeps a request that carries free text inside the evaluation-description budget of work-order.mjs.
export const MAX_REQUEST_CHARS = 4800;
const previewShape = ajv.compile(previewSchema);
const localSummaryShape = ajv.compile(previewSchema.properties.local_summary);
const marketContextShape = ajv.compile(previewSchema.properties.market_context);
const KNOWN_ORIGINS = { 'bounties.verdikta.org': 'BASE', 'bounties-testnet.verdikta.org': 'BASE_SEPOLIA' };
const TOKEN_PHOTO_TYPES = ['PHOTO', 'VIDEO_FRAME'];

/**
 * Market context is provenance-labelled aggregate context, never a quote. `network` is the
 * preview's own network ('UNSELECTED' until the owner selects one); a selected network must
 * match the context, and the two public origins must carry their own network.
 */
export function validateMarketContext(context, network = 'UNSELECTED') {
  if (!marketContextShape(context)) return marketContextShape.errors.map(e => `market_context${e.instancePath} ${e.message}`);
  const errors = [], host = new URL(context.source_url).host;
  if (network !== 'UNSELECTED' && context.network !== network) errors.push('market_context network differs from the selected network');
  if (KNOWN_ORIGINS[host] && KNOWN_ORIGINS[host] !== context.network) errors.push('market_context network does not match its source origin');
  if (context.source_url.endsWith('/api/jobs.txt') && context.fallback !== 'JOBS_TXT') errors.push('A jobs.txt context must say fallback JOBS_TXT');
  return errors;
}

// Items a request asks for: claim ids, "entity_id/field_id" for every cell of an evidence-pack grid,
// review item ids, or "step-N" for every step of a real-world task.
export function requestItemIds(kind, request) {
  if (kind === 'source-check-v1') return (request?.claims || []).map(c => c.claim_id);
  if (kind === 'review-v1') return (request?.items || []).map(i => i.item_id);
  if (kind === 'real-world-task-v1') return (request?.task?.steps || []).map((_, i) => `step-${i + 1}`);
  return (request?.entities || []).flatMap(e => (request?.fields || []).map(f => `${e.entity_id}/${f.field_id}`));
}
const sameSet = (a, b) => a.length === b.length && new Set([...a, ...b]).size === a.length;

/**
 * Local findings are context for the owner, never part of the commissioned request and never
 * independent verification. `request` is the DRAFT request (the residue in RESIDUAL mode, the
 * whole request in NON_INDEPENDENT_PASS mode).
 */
export function validateLocalSummary(summary, kind, request) {
  if (!localSummaryShape(summary)) return localSummaryShape.errors.map(e => `local_summary${e.instancePath} ${e.message}`);
  if (!HYBRID_TEMPLATE_IDS.includes(kind)) return ['local_summary applies to source checks and evidence packs only; describe your own view of a review or task in task_summary'];
  const errors = [], draftIds = requestItemIds(kind, request);
  const resolved = summary.resolved.map(r => r.item_id), residual = summary.residual.map(r => r.item_id), overlap = summary.grid_overlap || [];
  if (!unique(resolved) || !unique(residual)) errors.push('local_summary lists an item more than once');
  const verdictKinds = kind === 'source-check-v1' ? ['SUPPORTED', 'CONTRADICTED'] : ['FOUND'];
  if (summary.resolved.some(r => !verdictKinds.includes(r.verdict))) errors.push(`local_summary verdicts for ${kind} must be ${verdictKinds.join(' or ')}`);
  if (summary.mode === 'RESIDUAL') {
    if (summary.original_task_id === request?.task_id) errors.push('A residual request needs its own task_id, different from the original');
    if (resolved.some(id => residual.includes(id))) errors.push('An item cannot be both resolved and residual');
    if (resolved.length + residual.length !== summary.original_item_count) errors.push('Resolved plus residual items must equal original_item_count');
    if (kind === 'source-check-v1' && overlap.length) errors.push('grid_overlap applies to evidence packs only');
    if (overlap.some(id => !resolved.includes(id) || residual.includes(id))) errors.push('grid_overlap cells must be resolved locally and not residual');
    if (!sameSet(draftIds, [...residual, ...overlap])) errors.push('The draft request must hold exactly the residual items (plus grid_overlap cells for a non-rectangular residue)');
    if (!residual.length) errors.push('A residual request needs at least one residual item; resolve everything locally with LOCAL instead');
    if (summary.residual.some(r => r.reason === 'INDEPENDENT_REVIEW_REQUESTED')) errors.push('INDEPENDENT_REVIEW_REQUESTED needs mode NON_INDEPENDENT_PASS');
  } else {
    if (summary.original_task_id !== request?.task_id) errors.push('A non-independent pass keeps the original request and task_id');
    if (residual.length || overlap.length) errors.push('A non-independent pass drafts every item: residual and grid_overlap must be empty');
    if (draftIds.length !== summary.original_item_count) errors.push('The draft request must hold every original item');
    if (resolved.some(id => !draftIds.includes(id))) errors.push('A resolved item is not in the draft request');
  }
  return errors;
}

export function validatePreview(assessment) {
  if (!previewShape(assessment)) return previewShape.errors.map(e => `${e.instancePath || '/'} ${e.message}`);
  const errors = [];
  if (assessment.draft) {
    const a = assessment.procurement, b = assessment.draft.procurement;
    if (a.mode !== b.mode || a.targetHunter !== b.targetHunter) errors.push('Draft procurement differs from assessment');
    if (a.mode === 'TARGETED' && !supplierAddress(a.targetHunter)) errors.push('Invalid supplier checksum/address');
    if (assessment.local_summary) errors.push(...validateLocalSummary(assessment.local_summary, assessment.draft.template_id, assessment.draft.request));
  }
  if (assessment.market_context) errors.push(...validateMarketContext(assessment.market_context, assessment.network));
  return errors;
}
const unique = values => new Set(values).size === values.length;
function shape(kind, type, value) {
  const validate = validators[kind]?.[type];
  if (!validate) return ['Select a supported service template'];
  return validate(value) ? [] : validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`);
}
export function validateRequest(kind, request) {
  const errors = shape(kind, 'request', request);
  if (errors.length) return errors;
  if (kind === 'review-v1') return reviewRequestErrors(request);
  if (kind === 'real-world-task-v1') return taskRequestErrors(request);
  const p = request.source_policy;
  if (p.minimum_locations_per_item > new Set(p.allowed_sources).size) errors.push('Minimum locations exceeds the approved source list');
  if (p.minimum_locations_per_item > p.max_search_actions_per_item) errors.push('Search budget is below minimum locations');
  if (kind === 'source-check-v1') {
    if (!unique(request.claims.map(c => c.claim_id))) errors.push('Duplicate claim IDs');
  } else {
    if (!unique(request.entities.map(e => e.entity_id)) || !unique(request.fields.map(f => f.field_id))) errors.push('Duplicate entity/field IDs');
    if (request.entities.length * request.fields.length > 50) errors.push('Maximum 50 entity-field cells');
  }
  return errors;
}
function reviewRequestErrors(request) {
  const errors = [];
  if (!unique(request.items.map(i => i.item_id))) errors.push('Duplicate item IDs');
  if (JSON.stringify(request).length > MAX_REQUEST_CHARS) errors.push('Request too large for the evaluation description: shorten the artifact text or the questions');
  return errors;
}
function taskRequestErrors(request) {
  const errors = [], start = Date.parse(request.time_window.start), end = Date.parse(request.time_window.end);
  if (!(end > start)) errors.push('The time window must end after it starts');
  const items = request.evidence_spec.items;
  if (!unique(items.map(i => i.evidence_id))) errors.push('Duplicate evidence IDs');
  const photos = items.filter(i => TOKEN_PHOTO_TYPES.includes(i.type));
  if (photos.length && !photos.some(i => i.token_required)) errors.push('At least one photo or video-frame item must require the challenge token');
  if (items.reduce((n, i) => n + i.count_min, 0) > 40) errors.push('Minimum evidence files exceed the 40-file cap');
  if (JSON.stringify(request).length > MAX_REQUEST_CHARS) errors.push('Request too large for the evaluation description: shorten the steps, requirements or constraints');
  return errors;
}
// approvedDigest must be SHA-256 of the exact approved request bytes, never reserialized JSON.
export function validateResult(kind, request, result, approvedDigest, { production = false } = {}) {
  const errors = [...validateRequest(kind, request), ...shape(kind, 'result', result)];
  if (errors.length) return errors;
  if (result.task_id !== request.task_id || result.input_sha256 !== approvedDigest) errors.push('Request identity/digest mismatch');
  if (result.fixture_only !== request.fixture_only) errors.push('Fixture classification mismatch');
  if (production && (request.fixture_only || result.fixture_only)) errors.push('Synthetic fixtures cannot be commissioned');
  if (kind === 'review-v1') return [...errors, ...reviewResultErrors(request, result)];
  if (kind === 'real-world-task-v1') return [...errors, ...taskResultErrors(request, result)];
  if (production && result.sources.some(s => s.provenance === 'SYNTHETIC_FIXTURE')) errors.push('Synthetic fixtures cannot be commissioned');
  // PROVIDED_CORPUS cites only the approved list. INDEPENDENT_PUBLIC_RETRIEVAL may cite other public sources,
  // each as an independent retrieval (the schema then requires its retrieval time, and every source carries an excerpt and locator).
  const policy = request.source_policy, approved = policy.allowed_sources, independent = policy.mode === 'INDEPENDENT_PUBLIC_RETRIEVAL';
  for (const source of result.sources.filter(s => !approved.includes(s.url))) {
    if (!independent) errors.push('Evidence source is outside the approved URL list');
    else if (source.provenance !== 'INDEPENDENT_PUBLIC_RETRIEVAL') errors.push('A source outside the approved list must be an independent public retrieval');
  }
  const sources = new Set(result.sources.map(s => s.source_id));
  if (sources.size !== result.sources.length) errors.push('Duplicate evidence IDs');
  const claimMode = kind === 'source-check-v1';
  const rows = claimMode ? result.claims : result.cells;
  const key = row => claimMode ? row.claim_id : JSON.stringify([row.entity_id, row.field_id]);
  const expected = new Set(claimMode ? request.claims.map(key) : request.entities.flatMap(e => request.fields.map(f => key({ ...e, ...f }))));
  if (rows.length !== expected.size || !unique(rows.map(key)) || rows.some(r => !expected.has(key(r)))) errors.push('Results must cover exactly the requested items');
  for (const row of rows) {
    const refs = [...row.evidence_ids, ...(row.alternatives || []).flatMap(a => a.evidence_ids)];
    if (refs.some(id => !sources.has(id))) errors.push('Unknown evidence reference');
    if (row.effort.length > policy.max_search_actions_per_item) errors.push('Search budget exceeded');
    for (const effort of row.effort.filter(e => !approved.includes(e.location))) {
      if (!independent) errors.push('Effort location is outside the approved URL list');
      else if (effort.outcome === 'INSPECTED_PROVIDED') errors.push('A location outside the approved list is retrieved, not inspected as provided');
    }
    // A blocked URL counts only for that URL, never for other required locations.
    if (new Set(row.effort.map(e => e.location)).size < policy.minimum_locations_per_item) errors.push('Minimum search effort not documented');
    for (const effort of row.effort.filter(e => !['ACCESS_BLOCKED', 'NOT_FOUND', 'OUT_OF_SCOPE'].includes(e.outcome))) {
      if (!refs.some(id => result.sources.some(s => s.source_id === id && s.url === effort.location))) errors.push('Inspected effort needs linked source evidence');
    }
    if (claimMode) {
      if (row.original_claim !== request.claims.find(c => c.claim_id === row.claim_id)?.text) errors.push('Original claim changed');
      if (row.version_scope !== policy.version_scope || row.as_of !== policy.as_of) errors.push('Scope changed');
    } else {
      const field = request.fields.find(f => f.field_id === row.field_id);
      const values = row.status === 'FOUND' ? [row.value] : row.alternatives.map(a => a.value);
      if (field && values.some(v => typeof v !== field.value_type)) errors.push('Cell value type mismatch');
      if (row.status === 'CONFLICTING' && !unique(values.map(v => JSON.stringify(v)))) errors.push('Conflicting alternatives must differ');
    }
  }
  return errors;
}
function reviewResultErrors(request, result) {
  const errors = [], got = result.items.map(i => i.item_id);
  if (!unique(got) || !sameSet(request.items.map(i => i.item_id), got)) errors.push('Results must cover exactly the requested items');
  if (request.artifact.sha256 && result.artifact_seen.sha256 && request.artifact.sha256 !== result.artifact_seen.sha256) errors.push('The reviewed artifact differs from the approved one');
  const byId = new Map(request.items.map(i => [i.item_id, i]));
  for (const row of result.items) {
    const item = byId.get(row.item_id);
    if (!item) continue;
    if (item.type === 'FINDING' && row.status === 'ASSESSED') errors.push(`${row.item_id}: a FINDING item is ISSUE_FOUND, NO_ISSUE or UNRESOLVED`);
    if (item.type === 'ASSESSMENT' && ['ISSUE_FOUND', 'NO_ISSUE'].includes(row.status)) errors.push(`${row.item_id}: an ASSESSMENT item is ASSESSED or UNRESOLVED`);
    if (row.findings.length > request.limits.max_findings_per_item) errors.push(`${row.item_id}: more findings than the limit`);
    if (!unique(row.findings.map(f => f.finding_id))) errors.push(`${row.item_id}: duplicate finding IDs`);
    if (item.wants_fix && row.findings.some(f => !f.proposed_change)) errors.push(`${row.item_id}: every finding needs a proposed change`);
    // With the artifact inline, every quotation is checkable here; with a URL only, the evaluator checks it against the page.
    if (request.artifact.text && row.findings.some(f => !request.artifact.text.includes(f.quote))) errors.push(`${row.item_id}: a quotation is not in the artifact text`);
  }
  return errors;
}
function taskResultErrors(request, result) {
  const errors = [], count = request.task.steps.length, indexes = result.steps.map(s => s.step_index);
  if (indexes.length !== count || !unique(indexes) || indexes.some(i => i < 1 || i > count)) errors.push('Results must report exactly the requested steps');
  const start = Date.parse(request.time_window.start), end = Date.parse(request.time_window.end);
  const inWindow = at => { const t = Date.parse(at); return t >= start && t <= end; };
  if (!inWindow(result.performed.start) || !inWindow(result.performed.end) || Date.parse(result.performed.end) < Date.parse(result.performed.start)) errors.push('The work must fall inside the time window');
  if (!unique(result.evidence.map(e => e.filename))) errors.push('Duplicate evidence filenames');
  const specIds = new Set(request.evidence_spec.items.map(i => i.evidence_id));
  if (result.evidence.some(e => !specIds.has(e.evidence_id))) errors.push('Evidence refers to an item the specification does not have');
  for (const item of request.evidence_spec.items) {
    const files = result.evidence.filter(e => e.evidence_id === item.evidence_id);
    if (files.length < item.count_min) errors.push(`${item.evidence_id}: fewer files than the minimum`);
    if (files.some(e => e.type !== item.type)) errors.push(`${item.evidence_id}: evidence type differs from the specification`);
    if (item.token_required && files.some(e => !e.shows_token)) errors.push(`${item.evidence_id}: every file must show the challenge token`);
    if (files.some(e => !inWindow(e.captured_at))) errors.push(`${item.evidence_id}: evidence captured outside the time window`);
  }
  return errors;
}
