import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { preview, previewText } from '../../../../skills/verdikta-discover/scripts/preview-core.mjs';

// The agent guide is served as a static file (public/guides/verdikta-discover.txt). These checks keep it in step with
// the skill: its example still makes the draft and hash it quotes, and the limits it states are the schemas' limits.
const skill = new URL('../../../../skills/verdikta-discover/', import.meta.url);
const bytes = await readFile(new URL('../../public/guides/verdikta-discover.txt', import.meta.url));
const guide = bytes.toString('utf8');
const schema = async name => JSON.parse(await readFile(new URL(`schemas/${name}`, skill), 'utf8'));
const jsonBlocks = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => m[1]);

test('the guide is plain ASCII with no unfilled placeholder', () => {
  // nginx serves it as text/plain without a charset, so only ASCII decodes the same everywhere.
  assert.ok([...bytes].every(b => b === 9 || b === 10 || (b >= 32 && b < 127)), 'non-ASCII byte in the guide');
  assert.doesNotMatch(guide, /\b(?:GUIDE_EXAMPLE_[A-Z]+|REAL_RUNS|USE_CASES|MEASURED(?:_POINTER)?)\b/);
});

test('every JSON example parses, and the example input makes the decision and draft hash the guide quotes', () => {
  assert.ok(jsonBlocks.length >= 1);
  for (const block of jsonBlocks) JSON.parse(block);
  const input = JSON.parse(jsonBlocks[0]);
  const result = preview(structuredClone(input));
  assert.equal(result.decision, 'PREVIEW');
  assert.equal(input.request.fixture_only, false);
  const sha = createHash('sha256').update(previewText(result)).digest('hex');
  assert.match(guide, new RegExp(`"draft_sha256": "${sha}"`));
});

test('the limits the guide states are the ones the schemas and the validator enforce', async () => {
  const claims = await schema('source-check-v1.request.schema.json');
  const pack = await schema('evidence-pack-v1.request.schema.json');
  assert.equal(claims.properties.claims.maxItems, 20);
  assert.equal(claims.properties.source_policy.properties.allowed_sources.maxItems, 30);
  assert.equal(pack.properties.entities.maxItems, 10);
  assert.equal(pack.properties.fields.maxItems, 10);
  assert.match(await readFile(new URL('scripts/validation.mjs', skill), 'utf8'), /request\.entities\.length \* request\.fields\.length > 50/);
  for (const phrase of ['1 to 20 atomic technical claims', 'up to 30 exact https URLs', 'up to 10 entities and 10 fields and at most 50 cells']) assert.ok(guide.includes(phrase), phrase);
});

test('the scripts and references the guide names exist in the skill', async () => {
  for (const name of ['scripts/preview.bundle.mjs', 'scripts/screen.mjs', 'scripts/url-screen.mjs', 'references/install.md', 'SKILL.md']) {
    assert.ok(guide.includes(name.replace(/^.*\//, '')), name);
    await access(new URL(name, skill));
  }
});
