import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { preview } from '../scripts/preview-core.mjs';
import { sha256Hex, sameJson, checkWorkOrderDraft, composeEvaluationDescription, parseWorkOrderDescription, FULFILMENT_GUIDE_URL, resultSchemaUrl, MAX_DESCRIPTION_CHARS, isAssessmentInput, previewText } from '../scripts/work-order.mjs';

const root = new URL('../', import.meta.url);
const json = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const clone = x => structuredClone(x);
const TARGET = '0x1111111111111111111111111111111111111111';
const request = { ...(await json('examples/source-check-v1.request.json')), fixture_only: false, task_id: 'shared-module-test' };
const draftOf = (extra = {}) => preview({ request: clone(request), sharing_authorized: true, procurement_mode: 'OPEN', ...extra });

test('sameJson compares structure, ignores key order, and tells null from missing', () => {
  assert.ok(sameJson({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }));
  for (const [a, b] of [[{ a: 1 }, { a: 1, b: 2 }], [{ a: null }, {}], [[1, 2], [2, 1]], [{ a: 1 }, [{ a: 1 }]], [1, '1'], [null, {}], [{ a: undefined }, {}]]) assert.equal(sameJson(a, b), false, JSON.stringify([a, b]));
});

test('sha256Hex matches node:crypto for strings and bytes, including non-ASCII text', () => {
  for (const text of ['', 'abc', '{"claim":"café – 中文 😀"}', 'x'.repeat(100000)]) {
    const expected = createHash('sha256').update(text).digest('hex');
    assert.equal(sha256Hex(text), expected);
    assert.equal(sha256Hex(new TextEncoder().encode(text)), expected);
  }
});

test('the composed description keeps the exact format the binder has always produced', () => {
  const sha = 'a'.repeat(64);
  const { description, requestDigest } = composeEvaluationDescription({ baseDescription: 'Owner text', draftSha256: sha, templateId: 'source-check-v1', request });
  const bytes = JSON.stringify(request);
  assert.equal(requestDigest, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(description, `Owner text\n\nApproved work-order draft SHA-256: ${sha}\nService: source-check-v1\nRequest bytes SHA-256 (result.input_sha256): ${requestDigest}\nRequest (exact UTF-8 JSON bytes, no trailing newline):\n${bytes}\nHow to deliver: ${FULFILMENT_GUIDE_URL} ; result.json must validate against ${resultSchemaUrl('source-check-v1')} and carry the request bytes SHA-256 above as input_sha256.\nDeliver result.json and readable evidence.md. Documented UNRESOLVED results are valid; do not reward contradictions or fabricate cells.`);
  const parsed = parseWorkOrderDescription(description);
  assert.deepEqual(parsed.errors, []); assert.equal(parsed.templateId, 'source-check-v1'); assert.deepEqual(parsed.request, request); assert.equal(parsed.requestDigest, requestDigest); assert.equal(parsed.draftSha256, sha);
  assert.equal(parseWorkOrderDescription('Plain bounty text with no work order'), null);
  const corrupted = description.replace(bytes, bytes.replace('"C1"', '"C9"'));
  assert.ok(parseWorkOrderDescription(corrupted).errors.some(e => /hash/.test(e)));
});

test('the description budget is enforced', () => {
  const big = clone(request); big.claims = Array.from({ length: 20 }, (_, i) => ({ claim_id: `C${i}`, text: 'long claim text '.repeat(25) }));
  assert.throws(() => composeEvaluationDescription({ baseDescription: 'x', draftSha256: 'a'.repeat(64), templateId: 'source-check-v1', request: big }), /description budget/);
  const ok = composeEvaluationDescription({ baseDescription: 'x'.repeat(10), draftSha256: 'a'.repeat(64), templateId: 'source-check-v1', request });
  assert.ok(ok.description.length < MAX_DESCRIPTION_CHARS);
});

test('checkWorkOrderDraft accepts open, targeted and hybrid drafts and rejects tampered or unscoped ones', () => {
  assert.deepEqual(checkWorkOrderDraft(draftOf()).errors, []);
  assert.equal(checkWorkOrderDraft(draftOf()).ok, true);
  assert.equal(checkWorkOrderDraft(preview({ request, sharing_authorized: true, procurement_mode: 'TARGETED', targetHunter: TARGET })).ok, true);
  const hybrid = preview({ request: { ...clone(request), task_id: 'residual', claims: request.claims.slice(2) }, sharing_authorized: true, procurement_mode: 'OPEN',
    local_summary: { mode: 'RESIDUAL', independent: false, performed_by: 'AGENT', original_task_id: request.task_id, original_item_count: 3, method: 'm', limitations: 'l',
      resolved: [{ item_id: 'C1', verdict: 'SUPPORTED', value: null, source_url: 'https://docs.example/a', basis: 'b' }, { item_id: 'C2', verdict: 'CONTRADICTED', value: null, source_url: 'https://docs.example/a', basis: 'b' }],
      residual: [{ item_id: 'C3', reason: 'UNRESOLVED_ABSENT' }] } });
  assert.equal(hybrid.decision, 'PREVIEW'); assert.equal(checkWorkOrderDraft(hybrid).ok, true);
  const tampers = {
    'threshold changed': a => { a.draft.threshold = 10; }, 'rubric edited': a => { a.draft.rubric.criteria[0].description += ' (edited)'; },
    'procurement flipped to targeted': a => { a.draft.procurement = { mode: 'TARGETED', targetHunter: TARGET }; },
    'assessment procurement differs': a => { a.procurement = { mode: 'TARGETED', targetHunter: TARGET }; },
    'quote status changed': a => { a.quote_status = 'QUOTED'; }, 'decision LOCAL': a => { a.decision = 'LOCAL'; }, 'draft removed': a => { a.draft = null; },
    'sharing approval removed': a => { a.draft.sharing_authorized = false; }, 'fixture-only request': a => { a.draft.request.fixture_only = true; },
    'duplicate claim ids': a => { a.draft.request.claims.push(clone(a.draft.request.claims[0])); },
    'unknown template': a => { a.draft.template_id = 'made-up-v1'; },
  };
  for (const [name, tamper] of Object.entries(tampers)) { const a = draftOf(); tamper(a); assert.equal(checkWorkOrderDraft(a).ok, false, name); }
  for (const bad of [null, undefined, {}, [], 'x']) assert.equal(checkWorkOrderDraft(bad).ok, false);
});

test('the server classifier reads the lines the shared composer writes', () => {
  const require = createRequire(import.meta.url);
  const { classifyService } = require('../../../example-bounty-program/server/utils/marketSummary.js');
  for (const id of ['source-check-v1', 'evidence-pack-v1']) {
    const { description } = composeEvaluationDescription({ baseDescription: 'Owner text', draftSha256: 'b'.repeat(64), templateId: id, request });
    assert.equal(classifyService(description), id);
  }
});

test('isAssessmentInput tells an agent\'s input from a preview: only an input has a top-level request', async () => {
  const input = await json('examples/assessment.json');
  assert.equal(isAssessmentInput(input), true);
  assert.equal(isAssessmentInput({ ...input, decision: 'PREVIEW' }), true, 'a stray decision field does not make it a preview');
  for (const notInput of [preview(input), draftOf(), {}, [], null, 'x', { request: null }, { request: [] }, { request: {}, draft: null }]) assert.equal(isAssessmentInput(notInput), false, JSON.stringify(notInput)?.slice(0, 40));
  assert.equal(previewText(draftOf()), `${JSON.stringify(draftOf(), null, 2)}\n`);
});
