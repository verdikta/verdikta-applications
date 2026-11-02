// verdikta-build-env: the environment builder's command line.
//
//   build  builds, pushes, checks and validates a listing; writes code_review.json, the baseline,
//          known_issues.json and validation-report.json. Holds no secret: it refuses to start
//          while the production signing key is in its environment.
//   sign   signs attestation.json for an accepted build, in its own step (design §20 decision 3:
//          signing in a separate job from the one that ran the maker's setup).
//   run    build, then sign, in one process: with a dev key only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { BuilderError } from './errors.js';
import { DEV_TRUST_FILE, readOutputs, writeOutputs } from './outputs.js';
import { buildListing } from './pipeline.js';
import { REPORT_FILE } from './report.js';
import { attest, loadSigningKey } from './signing.js';
import { serializeJson } from './spec.js';
import { BUILDER_VERSION } from './version.js';

export const COMMANDS = Object.freeze({
  build: 'Build, push and validate a listing\'s env image; write code_review.json, baseline.json and the report',
  sign: 'Sign attestation.json for an accepted build, with the configured key',
  run: 'build, then sign, in one process (dev key only)',
});

const USAGE = `Usage: verdikta-build-env <command> [options]

The Verdikta stake-attestation environment builder: builds a listing's env image FROM the
pinned foundry base, pushes it, checks a contract's verified source, validates the listing on
the arbiters' code-runner, and signs attestation.json.

Commands:
${Object.entries(COMMANDS).map(([name, about]) => `  ${name.padEnd(7)}${about}`).join('\n')}

Options:
  --config <file>        the builder's config (JSON)
  --spec <file>          build, run: the maker's draft code_review.json
  --known-issues <file>  build, run: known_issues.json, when the draft names one
  --out <dir>            build, run: where the files and the report are written (new or empty)
  --dir <dir>            sign: a build's output folder
  -h, --help             Show this help
  -v, --version          Print the version

Exit status: 0 accepted (or signed), 2 refused (see the report), 1 error, 64 usage error.
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const m = /^--(config|spec|known-issues|out|dir)$/.exec(rest[i]);
    if (!m || i + 1 >= rest.length) return { command, error: `unknown or incomplete option '${rest[i]}'` };
    opts[m[1]] = rest[i + 1];
    i += 1;
  }
  return { command, opts };
}

function emptyOrMissing(dir) {
  return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
}

async function sign({ dir, config, env, out }) {
  const key = loadSigningKey(config.signing.key, { env });
  const { files, report, names } = readOutputs(dir);
  const { attestation, bytes } = await attest({ files, report, key });
  const name = names.attestation || 'attestation.json';
  fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o644 });
  const trust = key.devTrust();
  if (trust) fs.writeFileSync(path.join(dir, DEV_TRUST_FILE), serializeJson(trust), { mode: 0o644 });
  report.attestation = { trust: attestation.trust, keyId: attestation.signature.keyId, issuedAt: attestation.issuedAt, file: name, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  fs.writeFileSync(path.join(dir, REPORT_FILE), serializeJson(report), { mode: 0o644 });
  out.write(`signed ${name} (${attestation.trust} trust, key ${attestation.signature.keyId})${trust ? `; the dev trust set is ${DEV_TRUST_FILE}` : ''}\n`);
}

async function build({ opts, config, out, deps }) {
  if (!emptyOrMissing(opts.out)) throw new BuilderError('OUT_DIR_NOT_EMPTY', `${opts.out} is not empty`);
  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(opts.spec, 'utf8'));
  } catch (err) {
    throw new BuilderError('SPEC_UNREADABLE', `${opts.spec}: ${err.message}`);
  }
  const knownIssues = opts['known-issues'] ? fs.readFileSync(opts['known-issues']) : null;
  const result = await buildListing({ draft, knownIssues, config, deps });
  writeOutputs(opts.out, result);
  const { report } = result;
  if (report.status === 'accepted') out.write(`accepted: ${report.image.ref}; the files and ${REPORT_FILE} are in ${opts.out}\n`);
  else if (report.status === 'refused') out.write(`refused: ${report.refusals.map((r) => `${r.code} (${r.step})`).join(', ')}; see ${path.join(opts.out, REPORT_FILE)}\n`);
  else out.write(`error: ${report.error.code}: ${report.error.detail}\n`);
  return report.status;
}

/**
 * @param {string[]} argv - the arguments after the program name
 * @param {{ env?: object, stdout?: { write(s: string): unknown }, stderr?: { write(s: string): unknown }, deps?: object }} [io]
 * @returns {Promise<number>} the exit status
 */
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, deps } = {}) {
  const first = argv[0];
  if (first === '-h' || first === '--help') {
    stdout.write(USAGE);
    return 0;
  }
  if (first === '-v' || first === '--version') {
    stdout.write(`${BUILDER_VERSION}\n`);
    return 0;
  }
  const { command, opts, error } = parseArgs(argv);
  if (error || !Object.hasOwn(COMMANDS, command ?? '')) {
    stderr.write(`verdikta-build-env: ${error ?? (command ? `unknown command '${command}'` : 'no command')}\n\n${USAGE}`);
    return 64;
  }
  const needs = command === 'sign' ? ['config', 'dir'] : ['config', 'spec', 'out'];
  const missing = needs.filter((k) => !opts[k]);
  if (missing.length) {
    stderr.write(`verdikta-build-env ${command}: missing --${missing.join(', --')}\n`);
    return 64;
  }
  try {
    const config = loadConfig(opts.config, { env });
    const key = config.signing.key;
    if (command === 'sign') {
      await sign({ dir: opts.dir, config, env, out: stdout });
      return 0;
    }
    if (command === 'build' && key !== 'dev' && key.env && env[key.env] !== undefined) {
      throw new BuilderError('BUILD_ENV_HOLDS_SIGNING_KEY', `the signing key (${key.env}) is in build's environment; build runs the maker's setup and holds no secret: sign in a separate step`);
    }
    if (command === 'run' && key !== 'dev') {
      throw new BuilderError('RUN_NEEDS_DEV_KEY', 'run builds and signs in one process, so it takes a dev key only; use build, then sign, for the production key');
    }
    const status = await build({ opts, config, out: stdout, deps });
    if (status !== 'accepted') return status === 'refused' ? 2 : 1;
    if (command === 'run') await sign({ dir: opts.out, config, env, out: stdout });
    return 0;
  } catch (err) {
    stderr.write(`verdikta-build-env: ${err instanceof BuilderError ? err.message : `BUILDER_FAILED: ${err?.message ?? err}`}\n`);
    if (err?.issues?.length) for (const i of err.issues) stderr.write(`  ${i.code}${i.detail ? `: ${i.detail}` : ''}\n`);
    return 1;
  }
}
