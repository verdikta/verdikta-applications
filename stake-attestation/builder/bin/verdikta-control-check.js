#!/usr/bin/env node
// verdikta-control-check: what git says about a listing's repository (src/controlCheck.js), as one
// JSON object on stdout. No config, no secret, no Docker, and nothing but node's own modules and
// the builder's dependency-free files: the site's server runs it for every listing it shows.
//
//   verdikta-control-check --repo <https URL> --commit <id> [--mirror <path or URL>]
//                          [--timeout-ms <n>] [--max-bytes <n>]
//
// Exit status: 0 an answer, 1 no answer (the code on stderr: REPO_FETCH_FAILED, REPO_TOO_LARGE,
// REPO_CHECK_TIMEOUT), 64 usage error.
import { BuilderError } from '../src/errors.js';
import { checkRepositoryControl } from '../src/controlCheck.js';

const NAME = 'verdikta-control-check';
const DEFAULTS = Object.freeze({ 'timeout-ms': 120000, 'max-bytes': 256 * 1024 * 1024 });

function parse(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const m = /^--(repo|commit|mirror|timeout-ms|max-bytes)$/.exec(argv[i]);
    if (!m || i + 1 >= argv.length) return { error: `unknown or incomplete option '${argv[i]}'` };
    opts[m[1]] = argv[i + 1];
  }
  for (const k of ['repo', 'commit']) if (!opts[k]) return { error: `missing --${k}` };
  for (const k of ['timeout-ms', 'max-bytes']) {
    if (opts[k] === undefined) opts[k] = DEFAULTS[k];
    else if (!/^[1-9][0-9]{0,14}$/.test(opts[k])) return { error: `--${k} takes a whole number` };
    else opts[k] = Number(opts[k]);
  }
  return { opts };
}

const { opts, error } = parse(process.argv.slice(2));
if (error) {
  process.stderr.write(`${NAME}: ${error}\n`);
  process.exitCode = 64;
} else {
  try {
    const answer = await checkRepositoryControl({ repo: opts.repo, baseCommit: opts.commit, mirror: opts.mirror ?? null, timeoutMs: opts['timeout-ms'], maxBytes: opts['max-bytes'] });
    process.stdout.write(`${JSON.stringify({ version: 1, repo: opts.repo, commit: opts.commit, ...answer })}\n`);
  } catch (err) {
    if (err instanceof TypeError) {
      process.stderr.write(`${NAME}: ${err.message}\n`);
      process.exitCode = 64;
    } else {
      process.stderr.write(`${NAME}: ${err instanceof BuilderError ? err.message : `REPO_FETCH_FAILED: ${err?.message ?? err}`}\n`);
      process.exitCode = 1;
    }
  }
}
