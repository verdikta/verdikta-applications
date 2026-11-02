#!/usr/bin/env node
// A stand-in for verdikta-build-env (stake-attestation/builder, node P3a) that keeps its command
// line contract: `build --config C --spec S [--known-issues K] --out O` writes code_review.json,
// the baseline, known_issues.json and validation-report.json into O and exits 0 (accepted),
// 2 (refused) or 1 (error); `sign --config C --dir O` writes attestation.json (and, for a dev key,
// dev-trust.json) and records the attestation in the report. Its behaviour comes from the config
// file ({ "mode": ..., "record": <file> }); every call is appended to the record with the argv
// and the environment it was given, so a test can check what the server passes. Test use only.
import fs from 'node:fs';
import path from 'node:path';

import { fakeBuilder } from '../helpers/fixtures.js';

const [command, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, '')] = rest[i + 1];
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
});
const write = (dir, name, bytes) => fs.writeFileSync(path.join(dir, name), bytes);
const json = (v) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);

if (config.mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (config.mode === 'hang-stubborn') {
  // a step whose child does not stop on SIGTERM (as a container the docker CLI started would
  // outlive the CLI): only SIGKILL ends it
  const { spawn } = await import('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.writeFileSync(`${config.record}.grandchild`, String(grandchild.pid));
  setInterval(() => {}, 1000);
} else if (config.mode === 'hang-tree') {
  // a step that started a process of its own (git, docker, a signer) and waits on it; the
  // grandchild shares the step's output pipes, as a docker CLI it ran would
  const { spawn } = await import('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.writeFileSync(`${config.record}.grandchild`, String(grandchild.pid));
  fs.writeFileSync(path.join(process.env.TMPDIR, 'builder-temp-file'), 'x');
  setInterval(() => {}, 1000);
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
