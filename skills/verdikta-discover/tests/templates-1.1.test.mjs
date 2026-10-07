// The 1.1 template set: review-v1 and real-world-task-v1 beside the two source-bound templates, and the wider source rule
// for INDEPENDENT_PUBLIC_RETRIEVAL. Everything here is deterministic; agent behaviour is measured separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { preview, templates, inferTemplateId, checkSummary } from '../scripts/preview-core.mjs';
import { validateRequest, validateResult, validatePreview, validateLocalSummary, requestItemIds, TEMPLATE_IDS, HYBRID_TEMPLATE_IDS, MAX_REQUEST_CHARS } from '../scripts/validation.mjs';
import { composeEvaluationDescription, checkWorkOrderDraft, MAX_DESCRIPTION_CHARS } from '../scripts/work-order.mjs';

const require = createRequire(import.meta.url);
const { validateRubric } = require('../../../example-bounty-program/server/utils/validation.js');
const { classifyService, SERVICE_IDS } = require('../../../example-bounty-program/server/utils/marketSummary.js');
const root = new URL('../', import.meta.url);
const json = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const bytes = async name => readFile(new URL(name, root));
const clone = x => structuredClone(x);
const sha = data => createHash('sha256').update(data).digest('hex');
const NEW = ['review-v1', 'real-world-task-v1'];
const ajv = new Ajv({ strict: false }); addFormats(ajv);
const validPreview = ajv.compile(await json('schemas/preview.schema.json'));

test('four templates are registered everywhere a template id can appear', async () => {
  assert.deepEqual(TEMPLATE_IDS, ['source-check-v1', 'evidence-pack-v1', ...NEW]);
  assert.deepEqual(Object.keys(templates), TEMPLATE_IDS);
  assert.deepEqual(SERVICE_IDS, TEMPLATE_IDS);
  const schema = await json('schemas/preview.schema.json');
  assert.deepEqual(schema.properties.template_id.enum, [...TEMPLATE_IDS, null]);
  assert.deepEqual(schema.properties.draft.anyOf[1].properties.template_id.enum, TEMPLATE_IDS);
  assert.deepEqual(schema.properties.market_context.properties.service_scope.enum, [...TEMPLATE_IDS, 'unclassified', 'all']);
  for (const id of TEMPLATE_IDS) {
    assert.equal(templates[id].template_id, id);
    assert.ok(templates[id].delivery_note, `${id} has a delivery note`);
    assert.equal(templates[id].status, 'DRAFT_SERVICE_NOT_OFFER');
  }
  assert.equal(templates['source-check-v1'].template_version, '1.1.0');
  assert.equal(templates['evidence-pack-v1'].template_version, '1.1.0');
});

for (const kind of NEW) {
  const request = await json(`examples/${kind}.request.json`), result = await json(`examples/${kind}.result.json`);
  const digest = sha(await bytes(`examples/${kind}.request.json`));
  test(`${kind}: the request and result examples validate and bind`, () => {
    assert.deepEqual(validateRequest(kind, request), []);
    assert.deepEqual(validateResult(kind, request, result, digest), []);
    assert.equal(inferTemplateId(request), kind);
    assert.ok(validateResult(kind, request, result, digest, { production: true }).length, 'a fixture is refused for production');
    for (const mutate of [r => { r.input_sha256 = '0'.repeat(64); }, r => { r.task_id = 'other'; }, r => { r.fixture_only = false; }]) {
      const r = clone(result); mutate(r); assert.ok(validateResult(kind, request, r, digest).length);
    }
  });
  test(`${kind}: canonical rubric, weights that sum to one, threshold outside the rubric, compilable schemas`, async () => {
    const rubric = await json(`templates/${kind}.rubric.json`);
    assert.equal(validateRubric(rubric).valid, true, JSON.stringify(validateRubric(rubric).errors));
    assert.equal(rubric.threshold, undefined);
    assert.ok(Math.abs(rubric.criteria.filter(c => !c.must).reduce((s, c) => s + c.weight, 0) - 1) < 1e-9);
    assert.ok(rubric.criteria.filter(c => c.must).every(c => c.weight === 0));
    assert.ok(rubric.criteria.filter(c => c.must).length >= 3, 'honesty gates');
    for (const type of ['request', 'result']) assert.ok(ajv.compile(await json(`schemas/${kind}.${type}.schema.json`)));
  });
  test(`${kind}: a draft needs approvals; local_summary is refused; the draft verifies and re-derives`, () => {
    const a = preview({ request, sharing_authorized: true, procurement_mode: 'OPEN', task_summary: 'x' });
    assert.equal(a.decision, 'PREVIEW'); assert.equal(a.template_id, kind); assert.equal(a.draft.threshold, 80);
    assert.deepEqual(a.deliverable, templates[kind].delivery);
    assert.ok(validPreview(a), JSON.stringify(validPreview.errors)); assert.deepEqual(validatePreview(a), []);
    // The shared verifier refuses synthetic (fixture_only) requests, so the commissioning checks use a real-shaped copy.
    const real = preview({ request: { ...clone(request), fixture_only: false, task_id: `${request.task_id}-real` }, sharing_authorized: true, procurement_mode: 'OPEN' });
    assert.equal(checkWorkOrderDraft(real).ok, true, JSON.stringify(checkWorkOrderDraft(real).errors));
    assert.equal(checkWorkOrderDraft(a).ok, false, 'a fixture-only request cannot be commissioned');
    assert.deepEqual(checkSummary(a, () => 'H').drafted_items, requestItemIds(kind, request));
    assert.ok(a.risks.length === 5 && a.why_outsource.length === 2);
    assert.equal(preview({ request, procurement_mode: 'OPEN' }).decision, 'NEEDS_SCOPE');
    assert.equal(preview({ request, sharing_authorized: true }).decision, 'NEEDS_SCOPE');
    assert.equal(preview({ request, sharing_authorized: false, procurement_mode: 'OPEN' }).decision, 'UNSUITABLE');
    assert.equal(preview({ request, sharing_authorized: true, procurement_mode: 'OPEN', local_sufficient: true }).decision, 'LOCAL');
    const summary = { mode: 'NON_INDEPENDENT_PASS', independent: false, performed_by: 'AGENT', original_task_id: request.task_id, original_item_count: requestItemIds(kind, request).length, method: 'm', limitations: 'l', resolved: [], residual: [] };
    const hybrid = preview({ request, sharing_authorized: true, procurement_mode: 'OPEN', local_summary: summary });
    assert.equal(hybrid.decision, 'NEEDS_SCOPE'); assert.match(hybrid.reason, /source checks and evidence packs/); assert.equal('local_summary' in hybrid, false);
    assert.ok(validateLocalSummary(summary, kind, request).length);
    assert.equal(HYBRID_TEMPLATE_IDS.includes(kind), false);
    const tampered = clone(real); tampered.draft.rubric.criteria[0].label = 'x'; assert.equal(checkWorkOrderDraft(tampered).ok, false);
  });
  test(`${kind}: the composed description ends with the template's delivery note and the classifier reads it`, () => {
    const { description } = composeEvaluationDescription({ baseDescription: 'Owner text', draftSha256: 'a'.repeat(64), templateId: kind, request });
    assert.ok(description.endsWith(`\n${templates[kind].delivery_note}`));
    assert.match(description, new RegExp(`^Service: ${kind}$`, 'm'));
    assert.equal(classifyService(description), kind);
    assert.ok(description.length < MAX_DESCRIPTION_CHARS);
  });
}

test('the two source-bound templates compose exactly as before and still classify', async () => {
  const request = await json('examples/source-check-v1.request.json');
  const { description } = composeEvaluationDescription({ baseDescription: 'Owner text', draftSha256: 'a'.repeat(64), templateId: 'source-check-v1', request });
  assert.ok(description.endsWith('\nDeliver result.json and readable evidence.md. Documented UNRESOLVED results are valid; do not reward contradictions or fabricate cells.'));
  for (const id of ['source-check-v1', 'evidence-pack-v1']) assert.equal(classifyService(composeEvaluationDescription({ baseDescription: 'x', draftSha256: 'b'.repeat(64), templateId: id, request }).description), id);
  assert.equal(classifyService(composeEvaluationDescription({ baseDescription: 'x', draftSha256: 'b'.repeat(64), templateId: 'made-up-v9', request }).description), 'unclassified');
});

test('review-v1: request rules', async () => {
  const request = await json('examples/review-v1.request.json');
  const errorsOf = mutate => { const r = clone(request); mutate(r); return validateRequest('review-v1', r); };
  assert.ok(errorsOf(r => { r.items.push(clone(r.items[0])); }).some(e => /Duplicate item/.test(e)));
  const items = n => Array.from({ length: n }, (_, i) => ({ item_id: `I${i}`, question: 'q', type: 'FINDING', wants_fix: false }));
  assert.deepEqual(errorsOf(r => { r.items = items(15); }), []);
  assert.ok(errorsOf(r => { r.items = items(16); }).length);
  assert.ok(errorsOf(r => { delete r.artifact.text; }).length, 'a URL or inline text is required');
  assert.deepEqual(errorsOf(r => { delete r.artifact.text; r.artifact.url = 'https://docs.example/rubric'; }), []);
  assert.ok(errorsOf(r => { delete r.artifact.text; r.artifact.url = 'http://docs.example/rubric'; }).length, 'https only');
  assert.ok(errorsOf(r => { r.artifact.text = 'x'.repeat(2501); }).length);
  assert.ok(errorsOf(r => { r.limits.max_findings_per_item = 11; }).length);
  assert.ok(errorsOf(r => { r.items[0].type = 'OPINION'; }).length);
  const big = clone(request); big.artifact.text = 'x'.repeat(2500); big.items = Array.from({ length: 15 }, (_, i) => ({ item_id: `I${i}`, question: 'q'.repeat(400), type: 'FINDING', wants_fix: false }));
  assert.ok(JSON.stringify(big).length > MAX_REQUEST_CHARS);
  assert.ok(validateRequest('review-v1', big).some(e => /too large/.test(e)));
  assert.equal(preview({ request: big, sharing_authorized: true, procurement_mode: 'OPEN' }).decision, 'NEEDS_SCOPE');
});

test('review-v1: result rules', async () => {
  const request = await json('examples/review-v1.request.json'), result = await json('examples/review-v1.result.json');
  const digest = sha(await bytes('examples/review-v1.request.json'));
  const cases = {
    'missing item': r => { r.items.pop(); },
    'duplicate item': r => { r.items.push(clone(r.items[0])); },
    'quotation not in the artifact': r => { r.items[0].findings[0].quote = 'Something the rubric never says.'; },
    'ASSESSED on a FINDING item': r => { r.items[0].status = 'ASSESSED'; r.items[0].rating = 50; },
    'ISSUE_FOUND on an ASSESSMENT item': r => { r.items[2].status = 'ISSUE_FOUND'; r.items[2].rating = null; r.items[2].findings = [clone(r.items[0].findings[0])]; },
    'more findings than the limit': r => { r.items[0].findings = [1, 2, 3, 4].map(i => ({ ...clone(r.items[0].findings[0]), finding_id: `X${i}` })); },
    'duplicate finding ids': r => { r.items[0].findings[1].finding_id = r.items[0].findings[0].finding_id; },
    'fix wanted but missing': r => { r.items[0].findings[0].proposed_change = null; },
    'ISSUE_FOUND without findings': r => { r.items[1].findings = []; },
    'NO_ISSUE with findings': r => { r.items[1].status = 'NO_ISSUE'; },
    'ASSESSED without a rating': r => { r.items[2].rating = null; },
    'UNRESOLVED without a reason': r => { r.items[1].status = 'UNRESOLVED'; r.items[1].findings = []; },
    'rating out of range': r => { r.items[2].rating = 101; },
  };
  for (const [name, mutate] of Object.entries(cases)) { const r = clone(result); mutate(r); assert.ok(validateResult('review-v1', request, r, digest).length, name); }
  // An approved artifact hash binds what the reviewer read.
  const pinned = clone(request); pinned.artifact.sha256 = 'a'.repeat(64);
  const pinnedDigest = sha(JSON.stringify(pinned));
  const seen = clone(result); seen.input_sha256 = pinnedDigest; seen.artifact_seen.sha256 = 'a'.repeat(64);
  assert.deepEqual(validateResult('review-v1', pinned, seen, pinnedDigest), []);
  seen.artifact_seen.sha256 = 'f'.repeat(64);
  assert.ok(validateResult('review-v1', pinned, seen, pinnedDigest).some(e => /differs from the approved/.test(e)));
  // An honest UNRESOLVED with a reason is valid; NO_ISSUE with a reason is valid.
  const unresolved = clone(result); unresolved.items[1] = { ...unresolved.items[1], status: 'UNRESOLVED', findings: [], unresolved_reason: 'Needs the submissions, which are out of scope.' };
  assert.deepEqual(validateResult('review-v1', request, unresolved, digest), []);
  const clean = clone(result); clean.items[1] = { ...clean.items[1], status: 'NO_ISSUE', findings: [] };
  assert.deepEqual(validateResult('review-v1', request, clean, digest), []);
});

test('real-world-task-v1: request rules', async () => {
  const request = await json('examples/real-world-task-v1.request.json');
  const errorsOf = mutate => { const r = clone(request); mutate(r); return validateRequest('real-world-task-v1', r); };
  assert.ok(errorsOf(r => { r.time_window.end = r.time_window.start; }).some(e => /end after/.test(e)));
  assert.ok(errorsOf(r => { r.evidence_spec.items.push(clone(r.evidence_spec.items[0])); }).some(e => /Duplicate evidence/.test(e)));
  assert.ok(errorsOf(r => { for (const i of r.evidence_spec.items) i.token_required = false; }).some(e => /challenge token/.test(e)));
  assert.deepEqual(errorsOf(r => { r.evidence_spec.items = r.evidence_spec.items.filter(i => i.type !== 'PHOTO'); }), [], 'no photographs: no token needed');
  const more = id => ({ evidence_id: id, type: 'DOCUMENT', requirement: 'r', count_min: 10, token_required: false });
  assert.ok(errorsOf(r => { r.evidence_spec.items.push(more('E4'), more('E5'), more('E6'), more('E7')); }).some(e => /40-file/.test(e)));
  assert.ok(errorsOf(r => { r.evidence_spec.challenge_token = 'short'; }).length);
  assert.ok(errorsOf(r => { r.evidence_spec.challenge_token = 'vb-lower-case-1'; }).length);
  assert.ok(errorsOf(r => { r.task.steps = Array.from({ length: 11 }, () => 's'); }).length);
  assert.ok(errorsOf(r => { delete r.location.remote_ok; }).length);
  assert.ok(errorsOf(r => { r.location.coordinates = { lat: 91, lon: 0 }; }).length);
  assert.ok(errorsOf(r => { r.task.steps = Array.from({ length: 10 }, (_, i) => `${'step '.repeat(55)}${i}`); r.task.constraints = Array.from({ length: 10 }, () => 'c'.repeat(300)); }).some(e => /too large/.test(e)));
});

test('real-world-task-v1: result rules', async () => {
  const request = await json('examples/real-world-task-v1.request.json'), result = await json('examples/real-world-task-v1.result.json');
  const digest = sha(await bytes('examples/real-world-task-v1.request.json'));
  const cases = {
    'missing step': r => { r.steps.pop(); },
    'duplicate step': r => { r.steps[1].step_index = 1; },
    'step out of range': r => { r.steps[2].step_index = 4; },
    'performed before the window': r => { r.performed.start = '2026-10-07T10:00:00Z'; },
    'performed end before start': r => { r.performed.end = '2026-10-09T10:00:00Z'; },
    'duplicate filename': r => { r.evidence[2].filename = r.evidence[1].filename; },
    'evidence for an unknown item': r => { r.evidence[1].evidence_id = 'E9'; },
    'fewer files than the minimum': r => { r.evidence.splice(2, 1); },
    'wrong evidence type': r => { r.evidence[0].type = 'SCREENSHOT'; },
    'token required but not shown': r => { r.evidence[0].shows_token = false; },
    'captured after the window': r => { r.evidence[1].captured_at = '2026-10-11T10:00:00Z'; },
    'path in a filename': r => { r.evidence[0].filename = '../etc/passwd'; },
    'short attestation': r => { r.attestation.statement = 'Done.'; },
  };
  for (const [name, mutate] of Object.entries(cases)) { const r = clone(result); mutate(r); assert.ok(validateResult('real-world-task-v1', request, r, digest).length, name); }
  const partial = clone(result); partial.steps[2].status = 'PARTIAL'; partial.steps[2].note = 'One date was illegible.';
  assert.deepEqual(validateResult('real-world-task-v1', request, partial, digest), []);
  assert.deepEqual(requestItemIds('real-world-task-v1', request), ['step-1', 'step-2', 'step-3']);
});

test('source checks and evidence packs: independent retrieval may cite public sources beyond the approved list; a provided corpus may not', async () => {
  for (const kind of ['source-check-v1', 'evidence-pack-v1']) {
    const request = await json(`examples/${kind}.request.json`), result = await json(`examples/${kind}.result.json`);
    const digest = sha(await bytes(`examples/${kind}.request.json`));
    const rows = kind === 'source-check-v1' ? 'claims' : 'cells';
    const extra = { source_id: 'S9', url: 'https://vendor.example/docs/retention', title: 'Vendor retention policy', version: '2.0', retrieved_at: '2026-10-06T12:00:00Z', provenance: 'INDEPENDENT_PUBLIC_RETRIEVAL', snapshot_sha256: 'b'.repeat(64), locator: 'section 4', excerpt: 'Input data is retained for 30 days.' };
    const withExtra = clone(result); withExtra.sources.push(extra); withExtra[rows][0].evidence_ids.push('S9');
    withExtra[rows][0].effort.push({ location: extra.url, outcome: 'RETRIEVED', note: 'Retrieved the vendor page.' });
    assert.ok(validateResult(kind, request, withExtra, digest).some(e => /outside the approved URL list/.test(e)), `${kind}: PROVIDED_CORPUS still refuses it`);
    const open = clone(request); open.source_policy.mode = 'INDEPENDENT_PUBLIC_RETRIEVAL'; open.source_policy.max_search_actions_per_item = 3;
    const openDigest = sha(JSON.stringify(open));
    const accepted = clone(withExtra); accepted.input_sha256 = openDigest;
    assert.deepEqual(validateResult(kind, open, accepted, openDigest), [], kind);
    const asProvided = clone(accepted); asProvided.sources[1].provenance = 'BUYER_PROVIDED';
    assert.ok(validateResult(kind, open, asProvided, openDigest).some(e => /independent public retrieval/.test(e)), kind);
    const noTime = clone(accepted); noTime.sources[1].retrieved_at = null;
    assert.ok(validateResult(kind, open, noTime, openDigest).length, `${kind}: an independent retrieval carries its time`);
    const inspected = clone(accepted); inspected[rows][0].effort[1].outcome = 'INSPECTED_PROVIDED';
    assert.ok(validateResult(kind, open, inspected, openDigest).some(e => /retrieved, not inspected/.test(e)), kind);
    const http = clone(accepted); http.sources[1].url = 'http://vendor.example/docs'; http[rows][0].effort[1].location = http.sources[1].url;
    assert.ok(validateResult(kind, open, http, openDigest).length, `${kind}: https only`);
    const budget = clone(accepted); budget[rows][0].effort.push({ location: 'https://third.example/', outcome: 'NOT_FOUND', note: 'n' }, { location: 'https://fourth.example/', outcome: 'NOT_FOUND', note: 'n' });
    assert.ok(validateResult(kind, open, budget, openDigest).some(e => /Search budget/.test(e)), `${kind}: the search budget still binds`);
  }
});

test('malformed new-template requests need scope, and shapes that fit no template select none', () => {
  for (const request of [{ artifact: {} }, { evidence_spec: {} }, { artifact: { kind: 'rubric' }, items: [] }]) {
    const a = preview({ request, sharing_authorized: true, procurement_mode: 'OPEN' });
    assert.equal(a.decision, 'NEEDS_SCOPE'); assert.equal(a.draft, null);
  }
  for (const value of [{ foo: 1 }, null, [], 'x']) assert.equal(inferTemplateId(value), null);
  assert.equal(preview({ request: { foo: 1 }, sharing_authorized: true, procurement_mode: 'OPEN' }).template_id, null);
});
