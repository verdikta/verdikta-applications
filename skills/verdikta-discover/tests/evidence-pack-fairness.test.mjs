// real-world-task-v1 1.1.0 and the hunter-side file check, after mainnet bounty 398 rejected three submissions for reasons the
// rubric wording and a missing pre-check allowed (tests/bounty-398-submissions.json holds what the check reads from each).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateResult, validateRequest, validateDraftRequest, evidenceFileErrors, challengeTokenLookalikes, CHALLENGE_TOKEN_ALPHABET } from '../scripts/validation.mjs';
import { parseWorkOrderDescription } from '../scripts/work-order.mjs';
import { preview } from '../scripts/preview-core.mjs';

const at = rel => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const json = async rel => JSON.parse(await readFile(at(rel), 'utf8'));
const fixture = await json('tests/bounty-398-submissions.json');
const order = parseWorkOrderDescription(fixture.description);
const [first, second, third] = fixture.submissions;
const names = s => s.files.map(f => f.name);

test('bounty 398: every result is valid against the schema and the request; the file names are what differ', () => {
  assert.deepEqual(order.errors, []);
  assert.equal(order.templateId, 'real-world-task-v1');
  for (const s of fixture.submissions) assert.deepEqual(validateResult(order.templateId, order.request, s.result, order.requestDigest, { production: true }), [], `submission ${s.submissionId}`);
});

test('bounty 398: submissions 1 and 2 list evidence files that were never attached; submission 3 does not', () => {
  const one = evidenceFileErrors(first.result, names(first));
  assert.ok(one.includes('No attached file is named result.json'));
  for (const missing of ['E1_token_photo.jpg', 'E2_frame_t005.png', 'E2_frame_t018.png', 'E2_frame_t134.png', 'evidence.md', 'attestation.md']) {
    assert.ok(one.some(e => e.startsWith(`result.json lists ${missing},`)), missing);
  }
  const two = evidenceFileErrors(second.result, names(second));
  assert.ok(two.some(e => e.startsWith('result.json lists E3_recording_frames.pdf,')));
  assert.equal(two.filter(e => e.startsWith('result.json lists ')).length, 7);
  assert.deepEqual(evidenceFileErrors(third.result, names(third)), []);
});

test('evidenceFileErrors: names match exactly, and a case-only difference is named', () => {
  const result = { evidence: [{ filename: 'E1_photo.jpg' }, { filename: 'E1_photo.jpg' }] };
  assert.deepEqual(evidenceFileErrors(result, ['result.json', 'E1_photo.jpg']), []);
  assert.deepEqual(evidenceFileErrors(result, ['result.json', 'e1_photo.JPG']), ['result.json lists E1_photo.jpg, which is not among the attached files (e1_photo.JPG differs only in case)']);
  assert.deepEqual(evidenceFileErrors({}, ['result.json']), []);
});

test('check-result --files reports the same errors and exits 1', async () => {
  const run = (...args) => { try { return { code: 0, out: execFileSync(process.execPath, [at('scripts/check-result.mjs'), ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: e.stdout }; } };
  const base = ['--request', at('examples/real-world-task-v1.request.json'), '--result', at('examples/real-world-task-v1.result.json'), '--allow-fixture'];
  const listed = (await json('examples/real-world-task-v1.result.json')).evidence.map(e => e.filename);
  assert.equal(run(...base, '--files', 'result.json', 'evidence.md', ...listed.map(n => `some/dir/${n}`)).code, 0);
  const bad = run(...base, '--files', 'result.json', ...listed.slice(1));
  assert.equal(bad.code, 1);
  assert.match(JSON.parse(bad.out).errors.join('\n'), new RegExp(`result\\.json lists ${listed[0].replace('.', '\\.')}`));
});

test('a new challenge token has no look-alike characters; an existing bounty keeps its token', async () => {
  assert.equal(/[0O1IL5S2Z6G8B]/.test(CHALLENGE_TOKEN_ALPHABET), false);
  assert.deepEqual(challengeTokenLookalikes('VD-MOBILE-9P6R-2026'), ['O', 'B', 'I', 'L', '6', '2', '0']);
  assert.deepEqual(challengeTokenLookalikes('FAKE-7QKM-4W9P'), []);
  const request = await json('examples/real-world-task-v1.request.json');
  assert.deepEqual(validateDraftRequest('real-world-task-v1', request), []);
  const old = structuredClone(request); old.evidence_spec.challenge_token = 'VD-MOBILE-9P6R-2026';
  assert.match(validateDraftRequest('real-world-task-v1', old).join('\n'), /look-alike characters \(O B I L 6 2 0\)/);
  assert.deepEqual(validateRequest('real-world-task-v1', old), []);
  // The drafting path refuses it; the hunter's check of bounty 398 (above) does not.
  const drafted = preview({ request: old, sharing_authorized: true, procurement_mode: 'OPEN' });
  assert.equal(drafted.decision, 'NEEDS_SCOPE');
  assert.equal(preview({ request, sharing_authorized: true, procurement_mode: 'OPEN' }).decision, 'PREVIEW');
  for (let i = 0; i < 20; i++) {
    const token = execFileSync(process.execPath, [at('scripts/challenge-token.mjs')], { encoding: 'utf8' }).trim();
    assert.match(token, /^[ACDEFHJKMNPQRTUVWXY3479]{4}(-[ACDEFHJKMNPQRTUVWXY3479]{4}){2}$/);
    assert.match(token, /^[A-Z0-9][A-Z0-9-]{6,30}[A-Z0-9]$/);
  }
  assert.match(await readFile(at('scripts/challenge-token.mjs'), 'utf8'), new RegExp(`ALPHABET = '${CHALLENGE_TOKEN_ALPHABET}'`));
});

test('real-world-task-v1 1.1.0: what the gates say', async () => {
  const template = await json('templates/real-world-task-v1.template.json');
  const rubric = await json('templates/real-world-task-v1.rubric.json');
  assert.equal(template.template_version, '1.1.0');
  const by = Object.fromEntries(rubric.criteria.map(c => [c.id, c.description]));
  // Authenticity targets fabricated or content-altered evidence, not disclosed handling.
  assert.equal(/\bedited\b/.test(by.authentic_consistent + rubric.forbidden_content.join(' ')), false);
  for (const allowed of [/format conversion/, /resizing or recompression/, /removal of location or other private metadata/, /redaction for privacy/, /AI assistance/, /truthfully describe/]) assert.match(by.authentic_consistent, allowed);
  for (const banned of [/stock/, /generated/, /composited/, /retouched/]) { assert.match(by.authentic_consistent, banned); assert.match(rubric.forbidden_content[1], banned); }
  // Links are archival; the token is compared with the expected one; the examined bounty is not the submitted-to bounty.
  assert.match(by.evidence_complete, /archival deliverable: it is delivered when it is stated, you do not need to open it, and whether your tools could open it is not graded/);
  assert.match(by.challenge_token, /consistent with the expected one passes/);
  assert.match(by.challenge_token, /Fail only when a character is clearly different from the expected one or missing/);
  assert.match(by.authentic_consistent, /not the bounty this submission is made to/);
  // The gates and weights themselves are unchanged.
  assert.deepEqual(rubric.criteria.map(c => [c.id, c.must, c.weight]), [['evidence_complete', true, 0], ['challenge_token', true, 0], ['authentic_consistent', true, 0], ['task_completion', false, 0.5], ['evidence_quality', false, 0.3], ['report_clarity', false, 0.2]]);
  assert.equal(template.recommended_threshold, 80);
});
