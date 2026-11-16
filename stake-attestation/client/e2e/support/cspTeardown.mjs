// The CSP run's last word (playwright.csp.config.js; node P23): every report the browser sent to the stack's
// report-uri during the run (e2e/support/headerServer.mjs keeps them in .e2e/csp-reports.json), however it came about,
// fails the run, but those of e2e/csp.spec.js's control tests, which make a violation on purpose (?csp-control= in the
// page's address). The per-test watcher in fixtures.js names the test; this catches a page no fixture watched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.e2e', 'csp-reports.json');

export default async function cspTeardown() {
  let reports = [];
  try {
    reports = JSON.parse(fs.readFileSync(REPORTS, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const unexpected = reports.filter((r) => !/[?&]csp-control=/.test(String(r['document-uri'] ?? '')));
  if (unexpected.length) {
    throw new Error(`Content-Security-Policy reports during the run:\n${unexpected.map((r) => JSON.stringify(r)).join('\n')}`);
  }
}
