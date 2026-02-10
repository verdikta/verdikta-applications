#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Load .env for NETWORK setting
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { config: serverConfig } = require('../config');

const dataPath = path.join(__dirname, '..', 'data', serverConfig.network, 'jobs.json');
if (!fs.existsSync(dataPath)) {
  console.error(`Data file not found: ${dataPath}`);
  console.error(`Check NETWORK env var (current: ${serverConfig.network})`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Find orphaned duplicates (no submissions, orphan reason is not_found_on_chain)
const orphanedDupes = data.jobs.filter(j =>
  j.orphanReason === 'not_found_on_chain' &&
  (j.submissions === undefined || j.submissions.length === 0)
);

console.log('Found orphaned duplicates:', orphanedDupes.map(j => ({ jobId: j.jobId })));

// Remove them
const before = data.jobs.length;
data.jobs = data.jobs.filter(j => {
  const isOrphanedDupe = j.orphanReason === 'not_found_on_chain' &&
    (j.submissions === undefined || j.submissions.length === 0);
  return !isOrphanedDupe;
});

fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
console.log('Cleaned up', before - data.jobs.length, 'orphaned duplicates');
