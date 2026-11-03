#!/usr/bin/env node
// One documented command: the whole local round. Exit 0 only if every check passed and nothing was
// left behind; 1 on any failure. --report <file> writes what happened as JSON.
import fs from 'node:fs';
import path from 'node:path';

import { runRound } from '../src/round.js';

const at = process.argv.indexOf('--report');
const reportFile = at >= 0 ? path.resolve(process.argv[at + 1]) : null;

const report = await runRound({
  onFinished: (r) => {
    if (reportFile) fs.writeFileSync(reportFile, `${JSON.stringify(r, null, 2)}\n`);
  },
});
const failed = report.checks.filter((c) => !c.ok).length;
process.stdout.write(`${report.ok ? 'PASSED' : 'FAILED'}: ${report.checks.length} checks, ${failed} failed, ${report.seconds} s, on ${report.platform}${report.ok ? '' : `\n${report.failure}`}\n`);
// A pipe is asynchronous on some platforms: an exit before it drains would cut the report short.
process.stdout.write('', () => process.stderr.write('', () => process.exit(report.ok ? 0 : 1)));
