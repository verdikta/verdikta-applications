/**
 * Which rubric template a bounty came from (utils/templateUsage.js) and the backfill
 * that labels bounties created before tracking (scripts/backfillRubricTemplates.js).
 */
const {
  rubricFingerprint, classifyRubric, normalizeRubricSource, rubricTemplateRecord,
  inferredRubricTemplate, currentRubricTemplate, summarizeTemplateUsage, templateRegistry,
} = require('../utils/templateUsage');
const { planTemplateBackfill, applyTemplateBackfill } = require('../scripts/backfillRubricTemplates');

// The "General Submission" template as the create page pins it (instructions under
// `description`). general-v1 stays registered even if the template changes later.
const general = () => ({
  title: 'General Work Submission',
  threshold: 80,
  classId: 128,
  criteria: [
    { id: 'prohibited', label: 'Prohibited Content', must: true, weight: 0, description: 'Reject if contains NSFW, hate speech, or copyright violations.' },
    { id: 'requirements', label: 'Meets Requirements', must: false, weight: 0.35, description: 'Fulfills all stated requirements and specifications.' },
    { id: 'quality', label: 'Overall Quality', must: false, weight: 0.35, description: 'Professional quality, attention to detail, well-executed.' },
    { id: 'completeness', label: 'Completeness', must: false, weight: 0.3, description: 'Complete submission, nothing missing, ready to use.' },
  ],
  forbiddenContent: ['NSFW content', 'Hate speech', 'Copyright violations'],
});
const custom = () => ({ criteria: [{ id: 'quality', label: 'Overall Quality', must: false, weight: 1, description: 'General quality assessment.' }] });

describe('rubricFingerprint', () => {
  it('reads instructions and description alike and ignores bounty settings', () => {
    const pinned = general();
    const asTemplate = { ...pinned, title: 'Renamed', threshold: 60, classId: 131,
      criteria: pinned.criteria.map(({ description, ...c }) => ({ ...c, instructions: description })) };
    expect(rubricFingerprint(asTemplate.criteria, asTemplate.forbiddenContent))
      .toBe(rubricFingerprint(pinned.criteria, pinned.forbiddenContent));
  });

  it('changes with any criterion text, weight, order or forbidden item', () => {
    const base = general();
    const fp = rubricFingerprint(base.criteria, base.forbiddenContent);
    const edits = [
      (r) => { r.criteria[1].description += ' Extra.'; },
      (r) => { r.criteria[1].weight = 0.4; r.criteria[3].weight = 0.25; },
      (r) => { r.criteria.reverse(); },
      (r) => { r.forbiddenContent.pop(); },
    ];
    for (const edit of edits) {
      const r = general();
      edit(r);
      expect(rubricFingerprint(r.criteria, r.forbiddenContent)).not.toBe(fp);
    }
  });
});

describe('classifyRubric', () => {
  it('names a registered template version word for word', () => {
    expect(classifyRubric(general())).toMatchObject({ key: 'general', version: 'general-v1', match: 'exact' });
  });

  it('counts an edited copy with the same criterion ids as modified', () => {
    const r = general();
    r.criteria[2].description = 'Polished.';
    expect(classifyRubric(r)).toMatchObject({ key: 'general', version: null, match: 'modified' });
  });

  it('keeps the template the creator picked when they changed its criteria', () => {
    const r = general();
    r.criteria.push({ id: 'extra', label: 'Extra', must: false, weight: 0, description: 'More.' });
    expect(classifyRubric(r)).toMatchObject({ key: null, match: null });
    expect(classifyRubric(r, 'general')).toMatchObject({ key: 'general', match: 'modified' });
  });

  it('leaves other rubrics without a template, and has nothing to say without criteria', () => {
    expect(classifyRubric(custom())).toMatchObject({ key: null, version: null, match: null });
    expect(classifyRubric(null)).toBeNull();
    expect(classifyRubric({ criteria: [] })).toBeNull();
  });

  it('recognises the mutual-wager versions agents built before the template existed', () => {
    expect(templateRegistry.templates.mutualWager.versions.map((v) => v.version))
      .toEqual(['mutual-wager-v1', 'mutual-wager-v2', 'mutual-wager-v3']);
  });
});

describe('rubricTemplateRecord', () => {
  it('records the hint as the source and only a registered template key', () => {
    expect(normalizeRubricSource({ source: 'template', templateKey: 'general' })).toEqual({ source: 'template', templateKey: 'general' });
    expect(normalizeRubricSource({ source: 'template', templateKey: 'nope' })).toEqual({ source: 'template', templateKey: null });
    expect(normalizeRubricSource({ source: 'reissue', templateKey: 'general' })).toEqual({ source: 'reissue', templateKey: null });
    for (const hint of [undefined, null, 'template', { source: 'unknown' }, { source: 'admin' }, { source: 'reference', templateKey: 'general' }]) {
      expect(normalizeRubricSource(hint)).toEqual({ source: 'api', templateKey: null });
    }
  });

  it('builds the stored record', () => {
    expect(rubricTemplateRecord(general(), { source: 'template', templateKey: 'general' })).toEqual({
      key: 'general', version: 'general-v1', match: 'exact', fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      source: 'template', inferred: false,
    });
    expect(rubricTemplateRecord({ criteria: null }, undefined)).toEqual({
      key: null, version: null, match: null, fingerprint: null, source: 'api', inferred: false,
    });
  });

  it('marks a rubric the server filled in from a template key as reference', () => {
    expect(rubricTemplateRecord(general(), { source: 'scratch' }, { reference: 'general' }))
      .toMatchObject({ key: 'general', match: 'exact', source: 'reference' });
  });
});

describe('summarizeTemplateUsage', () => {
  const jobs = [
    { jobId: 1, createdAt: 1000, status: 'AWARDED', onChain: true, createdByClientType: 'frontend', rubricTemplate: rubricTemplateRecord(general(), { source: 'template', templateKey: 'general' }) },
    { jobId: 2, createdAt: 2000, status: 'OPEN', syncedFromBlockchain: true, rubricContent: general() },
    { jobId: 3, createdAt: 3000, status: 'ORPHANED', onChain: false, createdByClientType: 'bot', rubricTemplate: rubricTemplateRecord(custom(), undefined) },
    { jobId: 4, createdAt: 4000 * 1000, status: 'CLOSED', onChain: true },
  ];

  it('counts each template by stage, match, version and source, inferring unlabelled jobs', () => {
    const s = summarizeTemplateUsage(jobs);
    expect(s.totals).toMatchObject({ created: 4, onChain: 3, awarded: 1 });
    expect(s.totals.via).toEqual({ site: { created: 1, onChain: 1 }, agent: { created: 1, onChain: 0 }, unknown: { created: 2, onChain: 2 } });
    const row = s.templates.find((t) => t.key === 'general');
    expect(row).toMatchObject({ kind: 'rubric', label: 'General Submission', created: 2, onChain: 2, awarded: 1, exact: 2, modified: 0, inferred: 1,
      versions: { 'general-v1': 2 }, sources: { template: 1, unknown: 1 }, via: { site: { created: 1, onChain: 1 } } });
    expect(s.templates.find((t) => t.key === 'source-check-v1')).toMatchObject({ kind: 'service', label: 'Source Check' });
    expect(s.templates[0].key).toBe('general');
    expect(s.templates).toHaveLength(Object.keys(templateRegistry.templates).length);
    expect(s.none).toMatchObject({ created: 1, onChain: 0, sources: { api: 1 } });
    expect(s.unclassified).toMatchObject({ created: 1, onChain: 1 });
  });

  it('filters by creation time, reading millisecond timestamps as seconds', () => {
    const s = summarizeTemplateUsage(jobs, { since: 3000 });
    expect(s.since).toBe(new Date(3000 * 1000).toISOString());
    expect(s.totals.created).toBe(2);
    expect(s.templates.find((t) => t.key === 'general').created).toBe(0);
  });
});

describe('currentRubricTemplate', () => {
  it('re-infers an inferred label, so templates registered later count', () => {
    const job = { rubricContent: general(), rubricTemplate: { key: null, version: null, match: null, fingerprint: 'stale', source: 'unknown', inferred: true } };
    expect(currentRubricTemplate(job)).toMatchObject({ key: 'general', match: 'exact', inferred: true });
  });

  it('upgrades a recorded fingerprint that now matches a template version, keeping its source', () => {
    const fingerprint = rubricFingerprint(general().criteria, general().forbiddenContent);
    const job = { rubricTemplate: { key: null, version: null, match: null, fingerprint, source: 'api', inferred: false } };
    expect(currentRubricTemplate(job)).toMatchObject({ key: 'general', version: 'general-v1', match: 'exact', source: 'api' });
  });

  it('leaves other recorded labels alone', () => {
    const rubricTemplate = { key: 'general', version: null, match: 'modified', fingerprint: 'x', source: 'template', inferred: false };
    expect(currentRubricTemplate({ rubricTemplate, rubricContent: custom() })).toBe(rubricTemplate);
  });
});

describe('backfill', () => {
  const escrow = '0x' + 'ab'.repeat(20);
  const storage = () => ({ jobs: [
    { jobId: 1, contractAddress: escrow, evaluationCid: 'QmA', rubricContent: general() },
    { jobId: 1, contractAddress: '0x' + 'cd'.repeat(20), evaluationCid: 'QmOld', rubricContent: custom() },
    { jobId: 2, contractAddress: escrow, evaluationCid: 'QmB', rubricTemplate: { key: 'general', source: 'template' }, rubricContent: custom() },
    { jobId: 3, contractAddress: escrow, evaluationCid: 'QmC' },
  ] });

  it('plans a label for each unlabelled job with a stored rubric', () => {
    const plan = planTemplateBackfill(storage().jobs);
    expect(plan.map((p) => [p.jobId, p.rubricTemplate.key, p.rubricTemplate.inferred, p.rubricTemplate.source]))
      .toEqual([[1, 'general', true, 'unknown'], [1, null, true, 'unknown']]);
    expect(inferredRubricTemplate(storage().jobs[3])).toBeNull();
  });

  it('labels jobs that share an id across escrows separately', () => {
    const s = storage();
    const { applied, skipped } = applyTemplateBackfill(s, planTemplateBackfill(storage().jobs));
    expect(applied).toEqual([1, 1]);
    expect(skipped).toEqual([]);
    expect(s.jobs[0].rubricTemplate).toMatchObject({ key: 'general', match: 'exact', inferred: true });
    expect(s.jobs[1].rubricTemplate).toMatchObject({ key: null, inferred: true });
    expect(s.jobs[2].rubricTemplate).toEqual({ key: 'general', source: 'template' });
  });

  it('with refresh, relabels only inferred labels that now classify differently', () => {
    const s = storage();
    s.jobs[0].rubricTemplate = { key: null, version: null, match: null, source: 'unknown', inferred: true };
    s.jobs[1].rubricTemplate = inferredRubricTemplate(s.jobs[1]);
    s.jobs[2].rubricTemplate = { key: null, source: 'api', inferred: false };
    expect(planTemplateBackfill(s.jobs)).toEqual([]);
    const plan = planTemplateBackfill(s.jobs, { refresh: true });
    expect(plan.map((p) => p.jobId)).toEqual([1]);
    expect(applyTemplateBackfill(s, plan, { refresh: true }).applied).toEqual([1]);
    expect(s.jobs[0].rubricTemplate).toMatchObject({ key: 'general', match: 'exact', inferred: true });
    expect(s.jobs[2].rubricTemplate).toEqual({ key: null, source: 'api', inferred: false });
  });

  it('skips a job labelled or changed since the plan was made', () => {
    const plan = planTemplateBackfill(storage().jobs);
    const s = storage();
    s.jobs[0].rubricTemplate = { key: 'general', source: 'template', inferred: false };
    s.jobs[1].rubricContent = general();
    const { applied, skipped } = applyTemplateBackfill(s, plan);
    expect(applied).toEqual([]);
    expect(skipped).toEqual([1, 1]);
    expect(s.jobs[0].rubricTemplate.inferred).toBe(false);
    expect(s.jobs[1].rubricTemplate).toBeUndefined();
  });
});
