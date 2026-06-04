#!/usr/bin/env node
/**
 * Heal drifted `rubricCid` fields by re-deriving them from each job's
 * evaluationCid package.
 *
 * The on-chain evaluationCid package is content-addressed/immutable and is
 * exactly what the oracle grades against; its manifest.additional[gradingRubric]
 * .hash is the authoritative rubric pointer. The loose top-level `rubricCid`
 * field is just a convenience cache and can drift out of sync — e.g. after an
 * ID-renumber/heal that repaired a job's title + evaluationCid but left its
 * rubricCid pointing at a neighbour's rubric (this is what mis-graded bounty
 * 247: re-issue prefilled the create form from the stale pointer, minting a new
 * package whose graded criteria didn't match the task).
 *
 * This script makes `rubricCid` agree with the package again. It is a pure
 * metadata heal: it does NOT touch the immutable on-chain evaluationCid, so it
 * cannot fix a bounty whose package was already minted wrong (like 247) — it
 * only stops the bad pointer from contaminating future re-issues.
 *
 * IMPORTANT: stop the network's server before running. The sync service holds
 * jobs in memory and periodically writes jobs.json back, which would overwrite
 * this edit. The sync service never writes rubricCid, so the heal sticks once
 * the server is restarted.
 *
 * Usage:
 *   node scripts/healRubricCid.js --network base --all --dry-run   # report drift
 *   node scripts/healRubricCid.js --network base --all             # fix all
 *   node scripts/healRubricCid.js --network base --job 245 --job 246
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// ---- args ----
const argv = process.argv.slice(2);
const getFlag = (name) => argv.includes(`--${name}`);
const getOpt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const network = getOpt('network') || 'base';
const all = getFlag('all');
const dryRun = getFlag('dry-run');
const jobIds = argv
  .map((a, i) => (a === '--job' ? argv[i + 1] : null))
  .filter((v) => v != null)
  .map(Number);

if (!all && jobIds.length === 0) {
  console.error('Specify --job <id> (repeatable) or --all');
  process.exit(1);
}

const PINATA_GATEWAY = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud';
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.io';
const GATEWAYS = [PINATA_GATEWAY, IPFS_GATEWAY];

const STORAGE_FILE = path.join(__dirname, `../data/${network}/jobs.json`);

/**
 * Fetch the authoritative grading-rubric hash from a job's evaluation package.
 * Returns the gradingRubric CID from manifest.additional, or null if the package
 * can't be read / has no rubric reference (older rubric.json-in-zip packages
 * have no separate CID to point at, so we leave those alone).
 */
async function fetchPackageRubricHash(evaluationCid) {
  if (!evaluationCid || evaluationCid.startsWith('dev-')) return null;
  for (const gateway of GATEWAYS) {
    try {
      const res = await fetch(`${gateway}/ipfs/${evaluationCid}`, {
        headers: { Accept: 'application/octet-stream, application/zip, */*' },
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const zip = new AdmZip(buf);
      const entry = zip.getEntry('manifest.json');
      if (!entry) continue;
      const manifest = JSON.parse(entry.getData().toString('utf8'));
      const ref = (manifest.additional || []).find((a) => a && a.name === 'gradingRubric');
      return ref && ref.hash ? ref.hash : null;
    } catch (e) {
      console.warn(`  gateway ${gateway} failed: ${e.message}`);
    }
  }
  return null;
}

(async () => {
  if (!fs.existsSync(STORAGE_FILE)) {
    console.error(`jobs.json not found: ${STORAGE_FILE}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
  const data = JSON.parse(raw);
  const jobs = data.jobs || [];

  const targets = jobs.filter((j) => {
    const hasCid = j.evaluationCid && !String(j.evaluationCid).startsWith('dev-');
    const selected = all ? true : jobIds.includes(Number(j.jobId));
    return selected && hasCid;
  });

  console.log(`Network: ${network}`);
  console.log(`Storage: ${STORAGE_FILE}`);
  console.log(`Inspecting ${targets.length} job(s) with a real evaluationCid\n`);
  if (targets.length === 0) {
    console.log('Nothing to inspect.');
    return;
  }

  let drifted = 0;
  let healed = 0;
  let unresolved = 0;

  for (const job of targets) {
    const pkgHash = await fetchPackageRubricHash(job.evaluationCid);
    if (!pkgHash) {
      // Couldn't determine the authoritative hash (fetch failed or no rubric
      // reference in the package). Leave the stored pointer untouched.
      if (!all || jobIds.includes(Number(job.jobId))) {
        console.log(`Job ${job.jobId}: no gradingRubric in package (or fetch failed) — left as-is`);
      }
      unresolved++;
      continue;
    }
    if (job.rubricCid === pkgHash) {
      continue; // already consistent — stay quiet under --all to keep output readable
    }
    drifted++;
    console.log(`Job ${job.jobId} (${job.title || 'untitled'}):`);
    console.log(`  stored rubricCid : ${job.rubricCid || '(none)'}`);
    console.log(`  package rubric   : ${pkgHash}`);
    if (!dryRun) {
      job.rubricCid = pkgHash;
      healed++;
      console.log('  -> healed');
    } else {
      console.log('  -> would heal');
    }
  }

  console.log(`\nScanned: ${targets.length} | drifted: ${drifted} | unresolved: ${unresolved}`);

  if (drifted === 0) {
    console.log('No rubricCid drift found.');
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] Would heal ${drifted} record(s). No file written.`);
    return;
  }

  const backup = `${STORAGE_FILE}.bak-rubriccidheal-${Math.floor(Date.now() / 1000)}`;
  fs.writeFileSync(backup, raw);
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
  console.log(`Healed ${healed} record(s).`);
  console.log(`Backup written: ${backup}`);
})();
