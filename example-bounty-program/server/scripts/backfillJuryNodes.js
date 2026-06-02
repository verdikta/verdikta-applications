#!/usr/bin/env node
/**
 * Backfill juryNodes onto existing job records from their evaluation package.
 *
 * Bounties synced from on-chain BountyCreated events before the sync service
 * learned to capture jury models were stored with juryNodes: []. The models are
 * immutable per evaluationCid (content-addressed in manifest.juryParameters.
 * AI_NODES), so we can safely fetch them once and persist them.
 *
 * IMPORTANT: stop the network's server before running (the sync service holds
 * jobs in memory and periodically writes jobs.json back, which would overwrite
 * this edit). applyChainBountyFields() preserves juryNodes on subsequent syncs,
 * so it is safe once the server is restarted.
 *
 * Usage:
 *   node scripts/backfillJuryNodes.js --network base --job 246
 *   node scripts/backfillJuryNodes.js --network base --all        # all empty
 *   node scripts/backfillJuryNodes.js --network base --job 246 --dry-run
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

/** Fetch manifest.juryParameters.AI_NODES → [{provider, model, runs, weight}] */
async function fetchJuryNodes(evaluationCid) {
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
      const aiNodes = manifest?.juryParameters?.AI_NODES;
      if (!Array.isArray(aiNodes)) return [];
      return aiNodes
        .filter((n) => n && n.AI_MODEL)
        .map((n) => ({
          provider: n.AI_PROVIDER,
          model: n.AI_MODEL,
          runs: n.NO_COUNTS || 1,
          weight: typeof n.WEIGHT === 'number' ? n.WEIGHT : 1,
        }));
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
    const empty = !Array.isArray(j.juryNodes) || j.juryNodes.length === 0;
    const hasCid = j.evaluationCid && !String(j.evaluationCid).startsWith('dev-');
    const selected = all ? true : jobIds.includes(Number(j.jobId));
    return selected && empty && hasCid;
  });

  console.log(`Network: ${network}`);
  console.log(`Storage: ${STORAGE_FILE}`);
  console.log(`Target jobs (empty juryNodes, real CID): ${targets.map((j) => j.jobId).join(', ') || '(none)'}`);
  if (targets.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  let updated = 0;
  for (const job of targets) {
    process.stdout.write(`Job ${job.jobId} (${job.evaluationCid}): `);
    const nodes = await fetchJuryNodes(job.evaluationCid);
    if (!nodes || nodes.length === 0) {
      console.log('no jury models found — skipped');
      continue;
    }
    job.juryNodes = nodes;
    updated++;
    console.log(`set ${nodes.length} model(s): ${nodes.map((n) => `${n.provider}/${n.model}`).join(', ')}`);
  }

  if (updated === 0) {
    console.log('No records updated.');
    return;
  }

  if (dryRun) {
    console.log(`\n[dry-run] Would update ${updated} record(s). No file written.`);
    return;
  }

  const backup = `${STORAGE_FILE}.bak-jurybackfill-${Math.floor(Date.now() / 1000)}`;
  fs.writeFileSync(backup, raw);
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
  console.log(`\nUpdated ${updated} record(s).`);
  console.log(`Backup written: ${backup}`);
})();
