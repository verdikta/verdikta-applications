#!/usr/bin/env node
// A stand-in for verdikta-build-env (stake-attestation/builder, nodes P3a, P3b) that keeps its
// command line contract: `build --config C --spec S [--known-issues K] --out O` writes
// code_review.json, the baseline, known_issues.json and validation-report.json into O and exits 0
// (accepted), 2 (refused) or 1 (error); `sign --config C --dir O` writes attestation.json (and, for
// a dev key, dev-trust.json) and records the attestation in the report; `scan --config C --spec S
// --out O [--agent]` writes scan-findings.json into O, a new folder (owner-only), prints where it
// is and nothing of what it says, and exits 0 (scanned) or 1 (the scan failed; the details are in
// the file). Its behaviour comes from the config file ({ "mode": ..., "scanMode": ..., "mark": ...,
// "record": <file> }); every call is appended to the record with the argv and the environment it
// was given, so a test can check what the server passes. Test use only.
import fs from 'node:fs';
import path from 'node:path';

import { fakeBuilder } from '../helpers/fixtures.js';
import { scanDoc } from '../helpers/scan.js';

const FLAGS = new Set(['--agent', '--check-registry']);
const [command, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 1) {
  if (FLAGS.has(rest[i])) opts[rest[i].replace(/^--/, '')] = true;
  else {
    opts[rest[i].replace(/^--/, '')] = rest[i + 1];
    i += 1;
  }
}
const config = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
const record = (entry) => {
  const list = fs.existsSync(config.record) ? JSON.parse(fs.readFileSync(config.record, 'utf8')) : [];
  list.push(entry);
  fs.writeFileSync(config.record, JSON.stringify(list));
};
record({
  command,
  argv: process.argv.slice(2),
  env: { ...process.env },
  ...(command === 'build' ? {
    spec: JSON.parse(fs.readFileSync(opts.spec, 'utf8')),
    knownIssues: opts['known-issues'] ? fs.readFileSync(opts['known-issues']).toString('base64') : null,
  } : {}),
  ...(command === 'scan' ? {
    spec: JSON.parse(fs.readFileSync(opts.spec, 'utf8')),
    outExisted: fs.existsSync(opts.out),
    outParentMode: fs.statSync(path.dirname(opts.out)).mode & 0o777,
  } : {}),
});
const write = (dir, name, bytes) => fs.writeFileSync(path.join(dir, name), bytes);
const json = (v) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);

if (config.mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (config.mode === 'leave-child') {
  // a builder that exits 0 while a process it started is still running
  const { spawn } = await import('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(`${config.record}.grandchild`, String(grandchild.pid));
  grandchild.unref();
  grandchild.stdout.destroy();
  grandchild.stderr.destroy();
  process.exit(0);
} else if (config.mode === 'hang-stubborn' || config.mode === 'hang-tree') {
  // A step that started a process of its own and waits on it, as the builder waits on the
  // docker CLI: the child has pipes of its own (builder/src/proc.js), so the builder's pipes
  // close as soon as the builder dies. 'hang-tree': the child takes a moment to stop on SIGTERM,
  // as a docker CLI stopping its container does. 'hang-stubborn': it ignores SIGTERM.
  const { spawn } = await import('node:child_process');
  const onTerm = config.mode === 'hang-tree' ? 'setTimeout(() => process.exit(0), 400)' : '{}';
  const grandchild = spawn(process.execPath, ['-e', `process.on("SIGTERM", () => ${onTerm}); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(`${config.record}.grandchild`, String(grandchild.pid));
  fs.writeFileSync(path.join(process.env.TMPDIR, 'builder-temp-file'), 'x');
  setInterval(() => {}, 1000);
} else if (command === 'scan') {
  // as the builder's writeScan: a new folder of its own, owner-only, the file created exclusively
  const mark = config.mark ?? 'no-mark';
  const scanMode = config.scanMode ?? 'ok';
  const file = path.join(opts.out, 'scan-findings.json');
  const writeFile = (bytes) => {
    fs.mkdirSync(opts.out, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  };
  const spec = JSON.parse(fs.readFileSync(opts.spec, 'utf8'));
  if (scanMode === 'hang') {
    setInterval(() => {}, 1000);
  } else if (scanMode === 'no-output') {
    process.stderr.write(`verdikta-build-env: SCAN_OUT_NOT_EMPTY: ${opts.out} is not empty (${mark})\n`);
    process.stdout.write(`${mark}\n`);
    process.exit(1);
  } else if (scanMode === 'garbage') {
    writeFile(Buffer.from(`{ "findings": [ "${mark}" `));
    process.exit(0);
  } else if (scanMode === 'not-a-scan') {
    writeFile(json({ kind: 'verdikta-listing-validation', status: 'ok', findings: [mark] }));
    process.exit(0);
  } else if (scanMode === 'too-large') {
    const doc = scanDoc(spec, { mark });
    doc.files.inScope = Array.from({ length: 400000 }, (_, i) => `src/${mark}-${i}.sol`);
    writeFile(json(doc));
    process.exit(0);
  } else {
    const failed = scanMode === 'error';
    writeFile(json(scanDoc(spec, { status: failed ? 'error' : 'ok', mark })));
    if (scanMode === 'chatty') {
      process.stdout.write(`found: ${mark}\n`);
      process.stderr.write(`verdikta-build-env: NOISE: ${mark}\n`);
    }
    if (failed) {
      process.stderr.write(`verdikta-build-env: scan SCAN_TOOL_FAILED; the details are in ${file} (for the maker only)\n`);
      process.exit(1);
    }
    process.stdout.write(`scan: wrote ${file}; it is for the maker only: keep it out of the listing archive, logs and public artifacts\n`);
    process.exit(0);
  }
} else if (command === 'build') {
  const draft = JSON.parse(fs.readFileSync(opts.spec, 'utf8'));
  const knownIssues = opts['known-issues'] ? fs.readFileSync(opts['known-issues']) : null;
  fs.mkdirSync(opts.out, { recursive: true });
  if (config.mode === 'no-report') process.exit(1);
  const outcome = { accepted: 'accepted', 'sign-fails': 'accepted', 'refused-source': 'refused-source', error: 'error' }[config.mode];
  const r = await fakeBuilder({ outcome }).build({ draft, knownIssues });
  if (r.status === 'accepted') {
    // what build writes: the files and the report, before signing
    write(opts.out, 'code_review.json', r.files.codeReview);
    const spec = JSON.parse(r.files.codeReview);
    write(opts.out, spec.baseline, r.files.baseline);
    if (r.files.knownIssues) write(opts.out, spec.stake.knownIssues, r.files.knownIssues);
    // kept for sign, as the real builder would recompute it
    write(opts.out, '.signed.json', json({ attestation: r.files.attestation.toString('utf8'), devTrust: r.devTrust, report: r.report }));
    r.report.attestation = null;
  }
  write(opts.out, 'validation-report.json', json(r.report));
  process.stdout.write(`${r.status}\n`);
  process.exit(r.status === 'accepted' ? 0 : r.status === 'refused' ? 2 : 1);
} else if (command === 'sign') {
  if (config.mode === 'sign-fails') {
    process.stderr.write('verdikta-build-env: SIGNING_KEY_NOT_TRUSTED: the configured key is not in the production set\n');
    process.exit(1);
  }
  const kept = JSON.parse(fs.readFileSync(path.join(opts.dir, '.signed.json'), 'utf8'));
  fs.rmSync(path.join(opts.dir, '.signed.json'));
  const spec = JSON.parse(fs.readFileSync(path.join(opts.dir, 'code_review.json'), 'utf8'));
  write(opts.dir, spec.attestation, Buffer.from(kept.attestation));
  write(opts.dir, 'dev-trust.json', json(kept.devTrust));
  write(opts.dir, 'validation-report.json', json(kept.report));
  process.exit(0);
} else {
  process.exit(64);
}
