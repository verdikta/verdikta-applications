/**
 * The rubric templates, as agents get them: GET /api/templates lists them and
 * GET /api/templates/:key returns one ready for POST /jobs/create, which also accepts
 * `rubricTemplate: "<key>"` in place of rubricJson and fills the rubric in itself.
 *
 * The create page's templates come from shared/rubricTemplates.json (the client reads
 * the same file). The verdikta-discover work-order templates are listed for discovery
 * only: their bounties are built from a work-order request by that skill, not by key.
 */

const templateData = require('../../shared/rubricTemplates.json');
const { rubricFingerprint, templateRegistry } = require('./templateUsage');

const DISCOVER_SKILL_URL = 'https://github.com/verdikta/verdikta-applications/tree/main/skills/verdikta-discover';

/** The template's rubric in /jobs/create form: criterion text goes in `description`. */
function apiRubric(t) {
  return {
    version: t.version,
    title: t.title,
    ...(t.description && { description: t.description }),
    criteria: t.criteria.map((c) => ({ id: c.id, label: c.label, must: !!c.must, weight: Number(c.weight), description: c.instructions })),
    forbiddenContent: [...(t.forbiddenContent || [])],
  };
}

/** The registered version name of a template's current text (null if the list is out of date). */
function currentVersion(key, t) {
  const fp = rubricFingerprint(t.criteria, t.forbiddenContent);
  return templateRegistry.templates[key]?.versions.find((v) => v.fingerprint === fp)?.version ?? null;
}

function summary(key, t) {
  return {
    key,
    kind: 'rubric',
    label: t.label,
    title: t.title,
    version: currentVersion(key, t),
    useWhen: t.useWhen,
    recommendedThreshold: t.threshold,
    recommendedClassId: t.classId,
    criteria: t.criteria.length,
    mustPass: t.criteria.filter((c) => c.must).length,
    detail: `/api/templates/${key}`,
  };
}

function serviceSummaries() {
  return Object.entries(templateRegistry.templates)
    .filter(([, t]) => t.kind === 'service')
    .map(([key, t]) => ({
      key,
      kind: 'service',
      label: t.label,
      version: t.versions[t.versions.length - 1]?.version ?? null,
      useWhen: 'An agent work order (bounded outside work with a fixed result schema). Built from a work-order request by the verdikta-discover skill, which composes the description; not available by key.',
      docs: DISCOVER_SKILL_URL,
    }));
}

/** Every template: the create page's (usable by key) and the work-order templates. */
function listTemplates() {
  return [
    ...Object.entries(templateData.templates).map(([key, t]) => summary(key, t)),
    ...serviceSummaries(),
  ];
}

/** One create-page template with its API-ready rubric, or null. */
function getTemplate(key) {
  const t = Object.prototype.hasOwnProperty.call(templateData.templates, key) ? templateData.templates[key] : null;
  if (!t) return null;
  return {
    ...summary(key, t),
    ...(t.description && { instructions: t.description }),
    rubricJson: apiRubric(t),
    fingerprint: rubricFingerprint(t.criteria, t.forbiddenContent),
    previousVersions: (templateRegistry.templates[key]?.versions || [])
      .map((v) => v.version).filter((v) => v !== currentVersion(key, t)),
  };
}

const templateKeys = () => Object.keys(templateData.templates);

/**
 * Fill in a /jobs/create body that names `rubricTemplate`. Returns { body } with
 * rubricJson set (and threshold / classId defaulted to the template's when absent), or
 * { error } with the 400 response. `rubricTemplateVersion`, when given, must be the
 * current version, so a caller mirroring another bounty learns the text has moved on.
 */
function expandRubricTemplate(body) {
  const key = body.rubricTemplate;
  const fix = 'GET /api/templates lists the templates; GET /api/templates/:key returns one with its rubricJson.';
  if (typeof key !== 'string' || !getTemplate(key)) {
    const service = serviceSummaries().find((s) => s.key === key);
    return { error: {
      error: 'Unknown rubric template',
      code: 'UNKNOWN_TEMPLATE',
      details: service
        ? `${key} is a verdikta-discover work-order template. Build the bounty from a work-order request with that skill (${DISCOVER_SKILL_URL}); it is not available by key.`
        : `rubricTemplate must be one of: ${templateKeys().join(', ')}`,
      fix,
    } };
  }
  if (body.rubricJson != null || body.rubricCid != null) {
    return { error: {
      error: 'Invalid rubric',
      code: 'RUBRIC_TEMPLATE_CONFLICT',
      details: 'Pass rubricTemplate, rubricJson or rubricCid, not more than one.',
      fix: `To change a template, read GET /api/templates/${key}, edit its rubricJson and send that instead.`,
    } };
  }
  const t = getTemplate(key);
  if (body.rubricTemplateVersion != null && body.rubricTemplateVersion !== t.version) {
    return { error: {
      error: 'Rubric template version changed',
      code: 'TEMPLATE_VERSION_CHANGED',
      details: `${key} is now ${t.version}; you asked for ${body.rubricTemplateVersion}. Bounties that must match each other word for word (a mutual wager pair) need the same version.`,
      currentVersion: t.version,
      fix: `Send rubricTemplateVersion "${t.version}", or omit it to take the current text.`,
    } };
  }
  return { body: {
    ...body,
    rubricJson: t.rubricJson,
    threshold: body.threshold ?? t.recommendedThreshold,
    classId: body.classId ?? t.recommendedClassId,
  }, template: t };
}

module.exports = { listTemplates, getTemplate, expandRubricTemplate, apiRubric };
