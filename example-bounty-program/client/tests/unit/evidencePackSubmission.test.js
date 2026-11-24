// The submit page's file-name check for real-world-task work orders, on the three bounty-398 submissions
// (skills/verdikta-discover/tests/bounty-398-submissions.json): 1 and 2 are flagged, 3 is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRealWorldTaskOrder, evidenceFileProblems } from '../../src/utils/evidencePackSubmission.js';

const fixture = JSON.parse(await readFile(new URL('../../../../skills/verdikta-discover/tests/bounty-398-submissions.json', import.meta.url), 'utf8'));
// What the page sees: the text of a file named result.json, if one was chosen.
const problems = s => evidenceFileProblems(s.resultFile === 'result.json' ? JSON.stringify(s.result) : null, s.files.map(f => f.name));

test('only a real-world-task work order gets the check', () => {
  assert.equal(isRealWorldTaskOrder(fixture.description), true);
  assert.equal(isRealWorldTaskOrder('Write a blog post.\nService: review-v1'), false);
  assert.equal(isRealWorldTaskOrder('The Service: real-world-task-v1 line must stand alone'), false);
  assert.equal(isRealWorldTaskOrder(undefined), false);
});

test('bounty 398: submissions 1 and 2 are flagged, submission 3 is not', () => {
  const [first, second, third] = fixture.submissions;
  assert.match(problems(first)[0], /No file is named result\.json/);
  assert.match(problems(second)[0], /No file is named result\.json/);
  assert.deepEqual(problems(third), []);
  // With the result renamed, the listed names are what is left to fix.
  const renamed = s => evidenceFileProblems(JSON.stringify(s.result), [...s.files.map(f => f.name), 'result.json']);
  assert.match(renamed(first)[0], /^result\.json lists E1_token_photo\.jpg, E2_frame_t005\.png, E2_frame_t018\.png, E2_frame_t134\.png, evidence\.md, attestation\.md, but no chosen file has those names/);
  assert.match(renamed(second)[0], /E3_recording_frames\.pdf/);
});

test('unreadable or partial results do not throw', () => {
  assert.deepEqual(evidenceFileProblems('{not json', ['result.json']), ['result.json is not valid JSON.']);
  assert.deepEqual(evidenceFileProblems('{}', ['result.json']), []);
  assert.deepEqual(evidenceFileProblems('{"evidence":[{"filename":"a.png"},null,{"filename":7}]}', ['result.json', 'a.png']), []);
  assert.match(evidenceFileProblems('{"evidence":[{"filename":"a.png"}]}', ['result.json', 'A.png'])[0], /lists a\.png, but no chosen file has that name/);
});
