import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rubricTemplates, getTemplateOptions } from '../../src/data/rubricTemplates.js';
const require = createRequire(import.meta.url);
const { rubricFingerprint, classifyRubric, normalizeRubricSource, templateRegistry } = require('../../../server/utils/templateUsage.js');

// The server counts template use by fingerprint (GET /api/jobs/admin/template-usage). A template
// changed without listing its new version would count as "no template" from then on.
const FIX = 'run `node scripts/registerRubricTemplates.js` in example-bounty-program/server';

test('every template version on the create page is listed for the server', () => {
  for (const [key, template] of Object.entries(rubricTemplates)) {
    const listed = templateRegistry.templates[key];
    assert.ok(listed, `${key} is not listed: ${FIX}`);
    const fingerprint = rubricFingerprint(template.criteria, template.forbiddenContent);
    assert.ok(listed.versions.some((v) => v.fingerprint === fingerprint), `${key} changed: ${FIX}`);
    assert.deepEqual(listed.criteriaIds, template.criteria.map((c) => c.id), `${key} criterion ids changed: ${FIX}`);
  }
});

test('a template pinned the way the create page pins it is recognised', () => {
  for (const [key, template] of Object.entries(rubricTemplates)) {
    // buildRubricForUpload in CreateBounty.jsx: instructions go out as `description`.
    const pinned = {
      title: template.title,
      criteria: template.criteria.map((c) => ({ id: c.id, label: c.label, must: !!c.must, weight: Number(c.weight), description: c.instructions })),
      forbiddenContent: template.forbiddenContent,
    };
    assert.equal(classifyRubric(pinned).key, key);
    assert.equal(classifyRubric(pinned).match, 'exact');
  }
});

test('every template the create page offers is a key the server accepts as a hint', () => {
  for (const { value } of getTemplateOptions().filter((o) => o.value)) {
    assert.equal(normalizeRubricSource({ source: 'template', templateKey: value }).templateKey, value);
  }
});
