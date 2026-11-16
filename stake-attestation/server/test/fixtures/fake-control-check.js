#!/usr/bin/env node
// A stand-in for verdikta-control-check (builder/bin), to test how the server treats the check
// itself: FAKE_MODE (in the file named by the --mirror argument) says what it does. Test use only.
import fs from 'node:fs';

const args = process.argv.slice(2);
const mode = fs.readFileSync(args[args.indexOf('--mirror') + 1], 'utf8').trim();
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'hang-ignoring-sigterm') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'not-json') process.stdout.write('{ not json');
else if (mode === 'wrong-shape') process.stdout.write(JSON.stringify({ version: 1, reachable: 'yes' }));
else if (mode === 'other-commit') process.stdout.write(JSON.stringify({ version: 1, repo: args[args.indexOf('--repo') + 1], commit: 'f'.repeat(40), reachable: true, ref: 'refs/heads/main', file: null }));
else if (mode === 'too-large') {
  process.stderr.write('verdikta-control-check: REPO_TOO_LARGE: over the cap\n');
  process.exitCode = 1;
} else {
  process.stderr.write('verdikta-control-check: REPO_FETCH_FAILED: the host answered 503\n');
  process.exitCode = 1;
}
