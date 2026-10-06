import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preview } from '../../../../skills/verdikta-discover/scripts/preview-core.mjs';
import { inspectDraftBytes, draftToFormPatch, draftDivergence, composeImportedDescription, networkMismatch, MAX_DRAFT_BYTES } from '../../src/utils/workOrderImport.js';
import { rubricWeights } from '../../src/utils/rubricWeights.js';
const require = createRequire(import.meta.url);
const { validateRubric } = require('../../../server/utils/validation.js');

const skill = new URL('../../../../skills/verdikta-discover/', import.meta.url);
const example = JSON.parse(await readFile(new URL('examples/source-check-v1.request.json', skill), 'utf8'));
const request = { ...example, fixture_only: false, task_id: 'import-test' };
const TARGET = '0x52908400098527886E0F7030069857D2E4169EE7';
const bytesOf = a => new TextEncoder().encode(JSON.stringify(a, null, 2));
const open = (extra = {}) => preview({ request: structuredClone(request), task_summary: 'Check three claims', sharing_authorized: true, procurement_mode: 'OPEN', ...extra });
const targeted = () => open({ procurement_mode: 'TARGETED', targetHunter: TARGET });
// The rubric as CreateBounty.buildRubricForUpload() produces it from the form state.
const uploaded = (patch, over = {}) => ({ version: 'rubric-1', title: patch.rubric.title, description: '', threshold: patch.threshold, classId: 128, forbiddenContent: patch.rubric.forbiddenContent,
  criteria: patch.rubric.criteria.map(c => ({ id: c.id, label: c.label, must: c.must, weight: c.weight, description: c.instructions })), ...over });

test('a valid draft is verified from its exact bytes and summarised', () => {
  const bytes = bytesOf(open());
  const r = inspectDraftBytes(bytes);
  assert.equal(r.ok, true); assert.deepEqual(r.errors, []);
  assert.equal(r.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(r.summary, { template_id: 'source-check-v1', template_label: 'Technical claim source check', task_id: 'import-test', items: 3, item_noun: 'claims', procurement: { mode: 'OPEN', targetHunter: null }, network: 'UNSELECTED', task_summary: 'Check three claims' });
});

test('the same bytes with different whitespace are a different draft', () => {
  const a = open(), compact = new TextEncoder().encode(JSON.stringify(a));
  assert.equal(inspectDraftBytes(compact).ok, true);
  assert.notEqual(inspectDraftBytes(compact).sha256, inspectDraftBytes(bytesOf(a)).sha256);
});

test('anything that is not a scoped, unquoted, real draft is refused and nothing is imported', () => {
  const refused = {
    'quote status changed': a => { a.quote_status = 'QUOTED'; }, 'decision LOCAL': a => { a.decision = 'LOCAL'; }, 'draft removed': a => { a.draft = null; },
    'fixture-only request': a => { a.draft.request.fixture_only = true; }, 'threshold changed': a => { a.draft.threshold = 10; }, 'rubric edited': a => { a.draft.rubric.criteria[0].label = 'x'; },
    'procurement flipped': a => { a.draft.procurement = { mode: 'TARGETED', targetHunter: TARGET }; }, 'duplicate claim ids': a => { a.draft.request.claims.push(a.draft.request.claims[0]); },
  };
  for (const [name, tamper] of Object.entries(refused)) {
    const a = open(); tamper(a); const r = inspectDraftBytes(bytesOf(a));
    assert.equal(r.ok, false, name); assert.ok(r.errors.length > 0, name); assert.equal(r.draft, null, name);
  }
  const bad = [new Uint8Array(), new TextEncoder().encode('not json'), new TextEncoder().encode('[]'), new Uint8Array([0xff, 0xfe, 0xfd]), new TextEncoder().encode('﻿{}'), null, 'text'];
  for (const b of bad) assert.equal(inspectDraftBytes(b).ok, false);
  assert.equal(inspectDraftBytes(new Uint8Array(MAX_DRAFT_BYTES + 1)).ok, false);
});

test('local findings and market context are shown only when the whole assessment validates', () => {
  const context = { source_url: 'https://bounties-testnet.verdikta.org/api/market-summary', fetched_at: '2026-10-01T12:00:00Z', generated_at: null, network: 'BASE_SEPOLIA', window_days: 30, service_scope: 'all', sample_size: 3, not_a_quote: true, summary: { open: 1 }, caveat: 'Context only.' };
  const good = inspectDraftBytes(bytesOf(open({ market_context: context, network: 'BASE_SEPOLIA' })));
  assert.equal(good.ok, true); assert.deepEqual(good.extras.market_context, context); assert.deepEqual(good.notes, []);
  const a = open(); a.market_context = { ...context, not_a_quote: false };
  const hidden = inspectDraftBytes(bytesOf(a));
  assert.equal(hidden.ok, true, 'the draft itself is still verified'); assert.equal(hidden.extras.market_context, null); assert.equal(hidden.notes.length, 1);
  const b = open(); b.unexpected_section = 'x';
  assert.equal(inspectDraftBytes(bytesOf(b)).extras.market_context, null);
});

test('a draft prefills the rubric, threshold and procurement, and the rubric passes the server validator', () => {
  const imported = inspectDraftBytes(bytesOf(targeted()));
  const patch = draftToFormPatch(imported);
  assert.equal(patch.threshold, 85); assert.equal(patch.targetHunter, TARGET); assert.equal(patch.suggestedTitle, 'Technical claim source check: 3 claims'); assert.equal(patch.baseDescription, 'Check three claims');
  assert.equal(patch.rubric.criteria.length, 6);
  assert.deepEqual(patch.rubric.criteria.map(c => c.instructions), imported.draft.rubric.criteria.map(c => c.description));
  assert.equal(rubricWeights(patch.rubric.criteria).valid, true);
  assert.equal(validateRubric({ criteria: uploaded(patch).criteria }).valid, true);
  assert.equal(draftToFormPatch(inspectDraftBytes(bytesOf(open()))).targetHunter, '');
});

test('divergence: a targeted draft never silently becomes open, an open draft never gains a target, and edits are named', () => {
  const imported = inspectDraftBytes(bytesOf(targeted())), patch = draftToFormPatch(imported);
  const current = (over = {}) => ({ rubric: uploaded(patch), threshold: patch.threshold, targetHunter: patch.targetHunter, ...over });
  assert.deepEqual(draftDivergence(imported.draft, current()), []);
  assert.deepEqual(draftDivergence(imported.draft, current({ threshold: '85' })), [], 'a string threshold from an input is fine');
  assert.deepEqual(draftDivergence(imported.draft, current({ threshold: 70 })), ['threshold']);
  assert.deepEqual(draftDivergence(imported.draft, current({ targetHunter: '' })), ['supplier address']);
  assert.deepEqual(draftDivergence(imported.draft, current({ targetHunter: TARGET.toLowerCase() })), [], 'address case does not matter');
  assert.deepEqual(draftDivergence(imported.draft, current({ targetHunter: '0x1111111111111111111111111111111111111111' })), ['supplier address']);
  const edited = uploaded(patch); edited.criteria[0] = { ...edited.criteria[0], description: 'Weaker.' };
  assert.deepEqual(draftDivergence(imported.draft, current({ rubric: edited })), ['rubric criteria']);
  assert.deepEqual(draftDivergence(imported.draft, current({ rubric: uploaded(patch, { title: 'Renamed' }) })), ['rubric title']);
  assert.deepEqual(draftDivergence(imported.draft, current({ rubric: uploaded(patch, { criteria: uploaded(patch).criteria.slice(1) }) })), ['rubric criteria']);
  const openImported = inspectDraftBytes(bytesOf(open())), openPatch = draftToFormPatch(openImported);
  assert.deepEqual(draftDivergence(openImported.draft, { rubric: uploaded(openPatch), threshold: 85, targetHunter: '' }), []);
  assert.deepEqual(draftDivergence(openImported.draft, { rubric: uploaded(openPatch), threshold: 85, targetHunter: TARGET }), ['supplier (an open draft cannot gain a target)']);
});

test('the description appends exactly the committed block, with the draft hash and only the request', () => {
  const imported = inspectDraftBytes(bytesOf(open()));
  const { description } = composeImportedDescription(imported, 'My own words.');
  assert.ok(description.startsWith('My own words.\n\nApproved work-order draft SHA-256: ' + imported.sha256 + '\nService: source-check-v1\n'));
  assert.ok(description.includes(JSON.stringify(imported.draft.request)));
  const withLocal = open({ request: { ...structuredClone(request), task_id: 'residual', claims: request.claims.slice(2) },
    local_summary: { mode: 'RESIDUAL', independent: false, performed_by: 'AGENT', original_task_id: 'import-test', original_item_count: 3, method: 'm', limitations: 'LOCAL-LIMIT-MARKER',
      resolved: [{ item_id: 'C1', verdict: 'SUPPORTED', value: null, source_url: 'https://docs.example/a', basis: 'LOCAL-BASIS-MARKER' }, { item_id: 'C2', verdict: 'SUPPORTED', value: null, source_url: 'https://docs.example/a', basis: 'b' }],
      residual: [{ item_id: 'C3', reason: 'UNRESOLVED_ABSENT' }] } });
  const hybrid = inspectDraftBytes(bytesOf(withLocal));
  assert.equal(hybrid.ok, true); assert.ok(hybrid.extras.local_summary);
  assert.doesNotMatch(composeImportedDescription(hybrid, 'x').description, /LOCAL-BASIS-MARKER|LOCAL-LIMIT-MARKER|local_summary|"claim_id":"C1"/);
});

test('a selected network that differs from the site is flagged; an unselected one is not', () => {
  assert.equal(networkMismatch('BASE', 'base-sepolia'), true);
  assert.equal(networkMismatch('BASE_SEPOLIA', 'base-sepolia'), false);
  assert.equal(networkMismatch('UNSELECTED', 'base'), false);
  assert.equal(networkMismatch(undefined, 'base'), false);
});

const bundle = fileURLToPath(new URL('scripts/preview.bundle.mjs', skill));
const runBundle = (args, input) => spawnSync(process.execPath, [bundle, ...args], { input: JSON.stringify(input), encoding: 'utf8' });
const inputBytes = input => new TextEncoder().encode(JSON.stringify(input));
const baseInput = (extra = {}) => ({ request: structuredClone(request), task_summary: 'Check three claims', sharing_authorized: true, procurement_mode: 'OPEN', ...extra });

test('an assessment input is turned into its draft here, committed to the exact bytes the script prints for it', () => {
  const input = baseInput();
  const r = inspectDraftBytes(inputBytes(input));
  assert.equal(r.ok, true, r.errors.join('; ')); assert.equal(r.derived, true);
  const text = JSON.stringify(preview(structuredClone(input)), null, 2) + '\n';
  assert.equal(r.previewText, text);
  assert.equal(r.sha256, createHash('sha256').update(text).digest('hex'));
  // The bundled script prints exactly these bytes for the same input, and its --check summary names the same hash.
  assert.equal(runBundle(['-'], input).stdout, text);
  assert.equal(JSON.parse(runBundle(['--check', '-'], input).stdout).draft_sha256, r.sha256);
  // Importing the script's output file gives the same draft, hash, summary and prefill.
  const viaFile = inspectDraftBytes(new TextEncoder().encode(text));
  assert.equal(viaFile.ok, true); assert.equal(viaFile.derived, false); assert.equal(viaFile.sha256, r.sha256);
  assert.deepEqual(viaFile.summary, r.summary); assert.deepEqual(draftToFormPatch(viaFile), draftToFormPatch(r));
  assert.ok(r.notes[0].startsWith('Derived from the assessment input'));
});

test('a targeted or hybrid input keeps its supplier and local findings; the findings stay out of the description', () => {
  const targetedInput = inspectDraftBytes(inputBytes(baseInput({ procurement_mode: 'TARGETED', targetHunter: TARGET })));
  assert.equal(targetedInput.ok, true); assert.deepEqual(targetedInput.draft.procurement, { mode: 'TARGETED', targetHunter: TARGET });
  const hybrid = inspectDraftBytes(inputBytes(baseInput({ request: { ...structuredClone(request), task_id: 'residual', claims: request.claims.slice(2) },
    local_summary: { mode: 'RESIDUAL', independent: false, performed_by: 'AGENT', original_task_id: 'import-test', original_item_count: 3, method: 'm', limitations: 'l',
      resolved: [{ item_id: 'C1', verdict: 'SUPPORTED', value: null, source_url: 'https://docs.example/a', basis: 'LOCAL-BASIS-MARKER' }, { item_id: 'C2', verdict: 'SUPPORTED', value: null, source_url: 'https://docs.example/a', basis: 'b' }],
      residual: [{ item_id: 'C3', reason: 'UNRESOLVED_ABSENT' }] } })));
  assert.equal(hybrid.ok, true, hybrid.errors.join('; ')); assert.equal(hybrid.extras.local_summary.resolved.length, 2);
  assert.doesNotMatch(composeImportedDescription(hybrid, 'x').description, /LOCAL-BASIS-MARKER/);
});

test('an input that makes no draft says why, and nothing is imported', () => {
  const cases = {
    'no sharing approval': [baseInput({ sharing_authorized: undefined }), 'Obtain sharing approval'],
    'sharing declined': [baseInput({ sharing_authorized: false }), 'Sharing was declined'],
    'no supplier choice': [baseInput({ procurement_mode: undefined }), 'Select OPEN or TARGETED'],
    'fixture-only request': [baseInput({ request: structuredClone(example) }), 'Synthetic requests cannot be commissioned'],
    'inconsistent local summary': [baseInput({ local_summary: { mode: 'RESIDUAL', independent: false, performed_by: 'AGENT', original_task_id: 'x', original_item_count: 9, method: 'm', limitations: 'l', resolved: [], residual: [] } }), 'NEEDS_SCOPE'],
    'empty request': [{ request: {}, sharing_authorized: true, procurement_mode: 'OPEN' }, 'NEEDS_SCOPE'],
  };
  for (const [name, [input, message]] of Object.entries(cases)) {
    const r = inspectDraftBytes(inputBytes(input));
    assert.equal(r.ok, false, name); assert.equal(r.draft, null, name);
    assert.ok(r.errors.some(e => e.includes(message)), `${name}: ${r.errors.join(' | ')}`);
  }
});

test('an invalid market context in an input is left out of the draft, and the import says so', () => {
  const r = inspectDraftBytes(inputBytes(baseInput({ market_context: { source_url: 'http://example.com/x?y=1', not_a_quote: false } })));
  assert.equal(r.ok, true, r.errors.join('; ')); assert.equal(r.extras.market_context, null);
  assert.ok(r.notes.some(n => n.startsWith('Market context omitted')));
});

test('a preview whose draft was shortened after the script printed it is refused, with a pointer to the assessment input', () => {
  for (const cut of [a => { delete a.draft.rubric; }, a => { a.draft.rubric.criteria.pop(); }, a => { delete a.draft.threshold; }]) {
    const a = open(); cut(a);
    const r = inspectDraftBytes(bytesOf(a));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('Paste the assessment input the agent returned')), r.errors.join(' | '));
  }
  // Cuts outside the draft leave the draft verifiable: it imports, and the other sections are not shown.
  const prose = open(); delete prose.risks; delete prose.why_outsource;
  const kept = inspectDraftBytes(bytesOf(prose));
  assert.equal(kept.ok, true); assert.equal(kept.notes.length, 1);
  // A genuine but uncommissionable preview gets no such hint.
  const fixture = preview({ request: structuredClone(example), sharing_authorized: true, procurement_mode: 'OPEN' });
  assert.deepEqual(inspectDraftBytes(bytesOf(fixture)).errors, ['Synthetic requests cannot be commissioned']);
});
