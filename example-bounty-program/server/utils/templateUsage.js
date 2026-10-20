/**
 * Which rubric template a bounty was built from, and how often each one is used
 * (GET /api/jobs/admin/template-usage).
 *
 * The templates live in the client (client/src/data/rubricTemplates.js, ES module).
 * The server knows them by fingerprint: rubricTemplateFingerprints.json lists every
 * version of every template, including versions that are no longer offered, so a
 * bounty built from an old version is still recognised. After changing a template,
 * run `node scripts/registerRubricTemplates.js` to add its new version; the client
 * unit test templateFingerprints.test.js fails until that is done.
 *
 * A rubric is classified from its content, so bounties created by agents through the
 * API, re-issued bounties and bounties that predate this tracking are all counted.
 * The create page adds a hint, rubricSource, saying how the creator started the
 * rubric; the hint is unverified (anyone can send it) and only labels the source.
 */

const crypto = require('crypto');
const registry = require('./rubricTemplateFingerprints.json');

// How the creator started the rubric. 'api' when no hint was sent; 'unknown' for
// bounties classified after the fact (scripts/backfillRubricTemplates.js).
const SOURCES = ['template', 'reissue', 'import', 'library', 'scratch', 'api', 'unknown'];

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Fingerprint of what the jury reads from a rubric: each criterion's id, label,
 * must, weight and instructions, in order, and the forbidden-content list. Title,
 * description, threshold and class are bounty settings and are left out. The
 * create page pins a criterion's instructions as `description`; templates and some
 * agents use `instructions`.
 */
function rubricFingerprint(criteria, forbiddenContent) {
  const canonical = JSON.stringify({
    criteria: (criteria || []).map((c) => [
      text(c?.id), text(c?.label), !!c?.must, Number(c?.weight ?? 0),
      text(c?.instructions) || text(c?.description),
    ]),
    forbiddenContent: (Array.isArray(forbiddenContent) ? forbiddenContent : []).map(text),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

const forbiddenOf = (rubric) => rubric?.forbiddenContent || rubric?.forbidden_content || [];

/**
 * { key, version, match, fingerprint } for a rubric ({ criteria, forbiddenContent }).
 * match is 'exact' when the rubric is a registered template version word for word,
 * 'modified' when it has a template's criterion ids but different content (or the
 * hint names a template the creator then edited), and null for any other rubric.
 * Returns null when there is no rubric to classify.
 */
function classifyRubric(rubric, templateHint = null) {
  const criteria = rubric?.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) return null;
  const fingerprint = rubricFingerprint(criteria, forbiddenOf(rubric));
  const templates = Object.entries(registry.templates);
  for (const [key, t] of templates) {
    const hit = t.versions.find((v) => v.fingerprint === fingerprint);
    if (hit) return { key, version: hit.version, match: 'exact', fingerprint };
  }
  const ids = criteria.map((c) => text(c?.id)).sort().join(',');
  const family = templates.find(([, t]) => [...t.criteriaIds].sort().join(',') === ids);
  const key = family?.[0] ?? (registry.templates[templateHint] ? templateHint : null);
  return { key, version: null, match: key ? 'modified' : null, fingerprint };
}

/**
 * The create page's hint, reduced to { source, templateKey }: a known source and,
 * for 'template', a registered template key. Anything else counts as 'api'.
 */
function normalizeRubricSource(hint) {
  const source = SOURCES.includes(hint?.source) && hint.source !== 'unknown' ? hint.source : 'api';
  const templateKey = source === 'template' && registry.templates[hint?.templateKey] ? hint.templateKey : null;
  return { source, templateKey };
}

/** The rubricTemplate record stored on a job at /jobs/create. */
function rubricTemplateRecord(rubric, hint) {
  const { source, templateKey } = normalizeRubricSource(hint);
  const c = classifyRubric(rubric, templateKey);
  return {
    key: c?.key ?? null,
    version: c?.version ?? null,
    match: c?.match ?? null,
    fingerprint: c?.fingerprint ?? null,
    source,
    inferred: false,
  };
}

/** The record for a job created before tracking, from its stored rubric; null if it has none. */
function inferredRubricTemplate(job) {
  const c = classifyRubric(job?.rubricContent);
  if (!c) return null;
  return { key: c.key, version: c.version, match: c.match, fingerprint: c.fingerprint, source: 'unknown', inferred: true };
}

// Stages a bounty passes through. createdAt is unix seconds (older records: ms).
const createdSec = (job) => {
  const t = Number(job?.createdAt) || 0;
  return t > 1e12 ? Math.floor(t / 1000) : t;
};
const isOnChain = (job) => (job.onChain === true || job.syncedFromBlockchain === true) && job.status !== 'ORPHANED';
const isAwarded = (job) => job.status === 'AWARDED';

const STAGE_DEFINITIONS = {
  created: 'Every bounty record: website and API creates (including ones never funded) and bounties found on chain.',
  onChain: 'Funded on chain (linked to a createBounty transaction) and not orphaned.',
  awarded: 'Paid out to a winning submission (status AWARDED).',
};

function emptyRow(extra = {}) {
  return { ...extra, created: 0, onChain: 0, awarded: 0, exact: 0, modified: 0, inferred: 0, versions: {}, sources: {} };
}

function tally(row, job, record) {
  row.created++;
  if (isOnChain(job)) row.onChain++;
  if (isAwarded(job)) row.awarded++;
  if (!record) return;
  if (record.match === 'exact') row.exact++;
  if (record.match === 'modified') row.modified++;
  if (record.inferred) row.inferred++;
  if (record.version) row.versions[record.version] = (row.versions[record.version] || 0) + 1;
  row.sources[record.source] = (row.sources[record.source] || 0) + 1;
}

/**
 * Template usage over jobs created at or after `since` (unix seconds, optional).
 * A job without a stored rubricTemplate is classified from its rubricContent on
 * the fly (inferred); one with neither is 'unclassified'.
 */
function summarizeTemplateUsage(jobs, { since = null } = {}) {
  const templates = Object.fromEntries(Object.entries(registry.templates)
    .map(([key, t]) => [key, emptyRow({ key, label: t.label })]));
  const none = emptyRow();
  const unclassified = emptyRow();
  const totals = { created: 0, onChain: 0, awarded: 0 };
  for (const job of jobs || []) {
    if (since != null && createdSec(job) < since) continue;
    totals.created++;
    if (isOnChain(job)) totals.onChain++;
    if (isAwarded(job)) totals.awarded++;
    const record = job.rubricTemplate || inferredRubricTemplate(job);
    if (!record) tally(unclassified, job, null);
    else if (record.key && templates[record.key]) tally(templates[record.key], job, record);
    else tally(none, job, record);
  }
  return {
    since: since != null ? new Date(since * 1000).toISOString() : null,
    stages: STAGE_DEFINITIONS,
    totals,
    templates: Object.values(templates).sort((a, b) => b.onChain - a.onChain || b.created - a.created),
    none,
    unclassified,
  };
}

module.exports = {
  SOURCES,
  rubricFingerprint,
  classifyRubric,
  normalizeRubricSource,
  rubricTemplateRecord,
  inferredRubricTemplate,
  summarizeTemplateUsage,
  templateRegistry: registry,
};
