#!/usr/bin/env node
/**
 * Label bounties created before template tracking with the template their rubric
 * came from (job.rubricTemplate, see utils/templateUsage.js). Each label is worked
 * out from the stored rubric (job.rubricContent) and marked inferred: true with
 * source 'unknown', because how the creator started the rubric was never recorded.
 * Jobs that already have a label, or have no stored rubric, are left alone. With
 * --refresh, inferred labels are worked out again too, for templates registered since
 * (a label recorded at /jobs/create is never changed).
 *
 * GET /api/jobs/admin/template-usage infers missing labels on the fly, so the report
 * is complete without this; the backfill makes the labels part of the record.
 *
 * Dry run unless --apply. With --apply it backs up jobs.json, re-reads it, and labels
 * a job only if it still has no label. Stop the network's server first, or run it
 * while the sync is quiet: the storage lock is in-process only.
 *
 * Usage (from example-bounty-program/server):
 *   node scripts/backfillRubricTemplates.js                        # dry run, NETWORK from .env
 *   node scripts/backfillRubricTemplates.js --network base --apply
 *   node scripts/backfillRubricTemplates.js --network base --refresh --apply
 *   node scripts/backfillRubricTemplates.js --jobs-file copy.json  # a copy of jobs.json
 */

const fs = require('fs');
const path = require('path');
const { inferredRubricTemplate } = require('../utils/templateUsage');

// Job ids repeat across escrow contracts, so a job is found by id, escrow and package.
const jobKey = (j) => `${j.jobId}|${(j.contractAddress || '').toLowerCase()}|${j.evaluationCid || ''}`;

const sameLabel = (a, b) => a?.key === b?.key && a?.version === b?.version && a?.match === b?.match;
// A job the backfill may label: no label yet, or (refresh) one it inferred itself.
const labelable = (job, refresh) => !job.rubricTemplate || (refresh && job.rubricTemplate.inferred === true);

/**
 * [{ key, jobId, rubricTemplate }] for the unlabelled jobs that have a stored rubric,
 * and with refresh, the inferred labels that now classify differently.
 */
function planTemplateBackfill(jobs, { refresh = false } = {}) {
  const plan = [];
  for (const job of jobs || []) {
    if (!labelable(job, refresh)) continue;
    const rubricTemplate = inferredRubricTemplate(job);
    if (rubricTemplate && !sameLabel(rubricTemplate, job.rubricTemplate)) {
      plan.push({ key: jobKey(job), jobId: job.jobId, rubricTemplate });
    }
  }
  return plan;
}

/**
 * Apply a plan to a freshly read storage object. A label lands only on a job with
 * the same id, escrow and package that still has no label and the same rubric.
 */
function applyTemplateBackfill(storage, plan, { refresh = false } = {}) {
  const applied = [];
  const skipped = [];
  for (const { key, jobId, rubricTemplate } of plan) {
    const job = (storage.jobs || []).find((j) => jobKey(j) === key && labelable(j, refresh) &&
      inferredRubricTemplate(j)?.fingerprint === rubricTemplate.fingerprint);
    if (!job) {
      skipped.push(jobId);
      continue;
    }
    job.rubricTemplate = { ...rubricTemplate };
    applied.push(jobId);
  }
  return { applied, skipped };
}

async function main() {
  const argv = process.argv.slice(2);
  const getOpt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  const apply = argv.includes('--apply');
  const refresh = argv.includes('--refresh');

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  if (getOpt('network')) process.env.NETWORK = getOpt('network');
  const { config } = require('../config');

  const storageFile = getOpt('jobs-file')
    ? path.resolve(getOpt('jobs-file'))
    : path.join(__dirname, '..', 'data', config.network, 'jobs.json');
  if (!fs.existsSync(storageFile)) {
    console.error(`jobs.json not found: ${storageFile}`);
    process.exit(1);
  }
  console.log(`Network: ${config.network}`);
  console.log(`Storage: ${storageFile}`);
  console.log(apply ? 'Mode:    APPLY\n' : 'Mode:    dry run (pass --apply to write)\n');

  const { jobs = [] } = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
  const plan = planTemplateBackfill(jobs, { refresh });
  const counts = {};
  for (const { rubricTemplate: t } of plan) {
    const label = t.key ? `${t.key} (${t.match}${t.version ? `, ${t.version}` : ''})` : 'no template';
    counts[label] = (counts[label] || 0) + 1;
  }
  for (const [label, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${label}`);
  const labelled = jobs.filter((j) => j.rubricTemplate).length;
  const noRubric = jobs.filter((j) => !j.rubricTemplate && !inferredRubricTemplate(j)).length;
  console.log(`\nJobs: ${jobs.length} | already labelled: ${labelled} | to label${refresh ? ' or relabel' : ''}: ${plan.length} | no stored rubric: ${noRubric}`);

  if (plan.length === 0) {
    console.log('Nothing to label.');
    return;
  }
  if (!apply) {
    console.log(`[dry run] Would label ${plan.length} job(s). No file written.`);
    return;
  }

  // Re-read right before writing so the window against a running server is the
  // length of this synchronous block, and only still-unlabelled jobs are touched.
  const raw = fs.readFileSync(storageFile, 'utf8');
  const storage = JSON.parse(raw);
  const { applied, skipped } = applyTemplateBackfill(storage, plan, { refresh });
  if (applied.length === 0) {
    console.log(`Nothing written: every planned job changed since it was read (${skipped.join(', ')}).`);
    return;
  }
  const backup = `${storageFile}.bak-templatebackfill-${Math.floor(Date.now() / 1000)}`;
  fs.writeFileSync(backup, raw);
  const tmpFile = `${storageFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(storage, null, 2));
  fs.renameSync(tmpFile, storageFile);
  console.log(`Labelled ${applied.length} job(s).`);
  if (skipped.length > 0) console.log(`Skipped (changed since read, or ambiguous): ${skipped.join(', ')}`);
  console.log(`Backup written: ${backup}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { planTemplateBackfill, applyTemplateBackfill };
