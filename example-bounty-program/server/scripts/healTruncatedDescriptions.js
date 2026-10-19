#!/usr/bin/env node
/**
 * Restore chain-synced job descriptions that the old sync extraction cut short.
 *
 * A bounty with no /jobs/create record of its own (re-funded package, or
 * created outside the site) gets its description from the evaluation package.
 * The sync used to read it with /Task Description:\s*(.+?)(?:\n\n|===|$)/s,
 * which stops at the first blank line or "===", so a description with either
 * kept only its first paragraph: mainnet #299 kept 39 of its 1,690 characters
 * and jurors checking its wager terms against /api/jobs/299 failed every claim.
 *
 * This re-reads each synced job's package with the fixed reader
 * (utils/taskDescription.js, via fetchEvaluationMetadata) and replaces the
 * stored description only when the stored one is a strict prefix of the
 * package's: the shape the truncation leaves. Hand edits and descriptions that
 * came from /jobs/create are left alone. Only jobs on the current escrow are
 * considered, because job ids repeat across escrow contracts.
 *
 * Dry run unless --apply. With --apply it backs up jobs.json, re-reads it, and
 * changes a job only if its description is still the one that was checked.
 * Stop the network's server first, or run it while the sync is quiet: the
 * storage lock is in-process only.
 *
 * Usage (from example-bounty-program/server):
 *   node scripts/healTruncatedDescriptions.js                          # dry run, NETWORK from .env
 *   node scripts/healTruncatedDescriptions.js --network base --job 299
 *   node scripts/healTruncatedDescriptions.js --network base --apply
 *   node scripts/healTruncatedDescriptions.js --jobs-file copy.json --escrow 0x...   # a copy of jobs.json
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SYNCED_DESCRIPTION = 'Fetched from blockchain';
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** A synced, linked job on the current escrow whose description came from its package. */
function isDescriptionHealCandidate(job, escrow) {
  if (!job) return false;
  if ((job.contractAddress || '').toLowerCase() !== escrow) return false;
  if (job.syncedFromBlockchain !== true || job.status === 'ORPHANED') return false;
  if (typeof job.evaluationCid !== 'string' || !job.evaluationCid || job.evaluationCid.startsWith('dev-')) return false;
  // The placeholder is the Phase D.6b metadata heal's job, not a truncation.
  return typeof job.description === 'string' && job.description.trim() !== '' &&
    job.description !== DEFAULT_SYNCED_DESCRIPTION;
}

/** The package's description when the stored one is a strict prefix of it, else null. */
function healedDescription(stored, fromPackage) {
  if (typeof stored !== 'string' || typeof fromPackage !== 'string') return null;
  return fromPackage.length > stored.length && fromPackage.startsWith(stored) ? fromPackage : null;
}

/**
 * Work out which jobs to change. fetchDescription(cid) resolves to the
 * package's description (null if it has none) or throws/returns undefined
 * when the package can't be read; each CID is fetched once.
 */
async function planDescriptionHeals(jobs, { escrow, jobIds = [], fetchDescription }) {
  const heals = [];
  const unreadable = [];
  let scanned = 0;
  const byCid = new Map();
  for (const job of jobs) {
    if (!isDescriptionHealCandidate(job, escrow)) continue;
    if (jobIds.length > 0 && !jobIds.includes(Number(job.jobId))) continue;
    scanned++;
    if (!byCid.has(job.evaluationCid)) {
      byCid.set(job.evaluationCid, Promise.resolve()
        .then(() => fetchDescription(job.evaluationCid))
        .catch(() => undefined));
    }
    const fromPackage = await byCid.get(job.evaluationCid);
    if (fromPackage === undefined) {
      unreadable.push(job.jobId);
      continue;
    }
    const after = healedDescription(job.description, fromPackage);
    if (after) heals.push({ jobId: job.jobId, title: job.title, evaluationCid: job.evaluationCid, before: job.description, after });
  }
  return { scanned, heals, unreadable };
}

/**
 * Apply planned heals to a freshly read storage object. A heal lands only on
 * the one synced job with that id on this escrow whose description is still
 * `before`; anything else is reported as skipped.
 */
function applyDescriptionHeals(storage, heals, escrow) {
  const applied = [];
  const skipped = [];
  for (const heal of heals) {
    const matches = (storage.jobs || []).filter((j) =>
      j.jobId === heal.jobId &&
      j.syncedFromBlockchain === true &&
      (j.contractAddress || '').toLowerCase() === escrow);
    if (matches.length !== 1 || matches[0].description !== heal.before) {
      skipped.push(heal.jobId);
      continue;
    }
    matches[0].description = heal.after;
    applied.push(heal.jobId);
  }
  return { applied, skipped };
}

function firstLine(text, max = 80) {
  const line = String(text).split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

async function main() {
  const argv = process.argv.slice(2);
  const getOpt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  const apply = argv.includes('--apply');
  const jobIds = argv
    .map((a, i) => (a === '--job' ? Number(argv[i + 1]) : null))
    .filter((v) => v != null);

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  if (getOpt('network')) process.env.NETWORK = getOpt('network');
  const { config } = require('../config');
  const { fetchEvaluationMetadata } = require('../utils/syncService');

  const escrow = (getOpt('escrow') || config.bountyEscrowAddress || '').toLowerCase();
  if (!ADDRESS_RE.test(escrow)) {
    console.error(`No escrow address for network ${config.network}: set BOUNTY_ESCROW_ADDRESS_* in .env or pass --escrow 0x...`);
    process.exit(1);
  }
  const storageFile = getOpt('jobs-file')
    ? path.resolve(getOpt('jobs-file'))
    : path.join(__dirname, '..', 'data', config.network, 'jobs.json');
  if (!fs.existsSync(storageFile)) {
    console.error(`jobs.json not found: ${storageFile}`);
    process.exit(1);
  }

  console.log(`Network: ${config.network}`);
  console.log(`Escrow:  ${escrow}`);
  console.log(`Storage: ${storageFile}`);
  console.log(apply ? 'Mode:    APPLY\n' : 'Mode:    dry run (pass --apply to write)\n');

  const { jobs = [] } = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
  // One package read per CID, in sequence (gateways rate-limit the server):
  // a few hundred packages take minutes, so show that it is moving.
  let fetched = 0;
  const { scanned, heals, unreadable } = await planDescriptionHeals(jobs, {
    escrow,
    jobIds,
    fetchDescription: async (cid) => {
      const metadata = await fetchEvaluationMetadata(cid);
      if (++fetched % 25 === 0) console.error(`  ...${fetched} packages read`);
      return metadata ? metadata.description || null : undefined;
    },
  });

  for (const h of heals) {
    console.log(`Job ${h.jobId} (${h.title || 'untitled'}): ${h.before.length} -> ${h.after.length} chars`);
    console.log(`  package: ${h.evaluationCid}`);
    console.log(`  stored : ${JSON.stringify(firstLine(h.before))}`);
  }
  console.log(`\nSynced jobs on this escrow scanned: ${scanned} | truncated: ${heals.length} | package unreadable: ${unreadable.length}`);
  if (unreadable.length > 0) console.log(`Unreadable (re-run later): ${unreadable.join(', ')}`);

  if (heals.length === 0) {
    console.log('Nothing to heal.');
    return;
  }
  if (!apply) {
    console.log(`[dry run] Would restore ${heals.length} description(s): ${heals.map((h) => h.jobId).join(', ')}. No file written.`);
    return;
  }

  // Re-read right before writing so the window against a running server is the
  // length of this synchronous block, and only unchanged descriptions are touched.
  const raw = fs.readFileSync(storageFile, 'utf8');
  const storage = JSON.parse(raw);
  const { applied, skipped } = applyDescriptionHeals(storage, heals, escrow);
  if (applied.length === 0) {
    console.log(`Nothing written: every planned job changed since it was read (${skipped.join(', ')}).`);
    return;
  }
  const backup = `${storageFile}.bak-descriptionheal-${Math.floor(Date.now() / 1000)}`;
  fs.writeFileSync(backup, raw);
  const tmpFile = `${storageFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(storage, null, 2));
  fs.renameSync(tmpFile, storageFile);
  console.log(`Restored ${applied.length} description(s): ${applied.join(', ')}`);
  if (skipped.length > 0) console.log(`Skipped (changed since read, or ambiguous): ${skipped.join(', ')}`);
  console.log(`Backup written: ${backup}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { isDescriptionHealCandidate, healedDescription, planDescriptionHeals, applyDescriptionHeals };
