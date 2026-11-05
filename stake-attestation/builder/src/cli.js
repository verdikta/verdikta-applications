// verdikta-build-env: the environment builder's command line.
//
//   build   builds, pushes, checks and validates a listing; writes code_review.json, the baseline,
//           known_issues.json and validation-report.json. Holds no secret: it refuses to start
//           while the production signing key is in its environment.
//   sign    signs attestation.json for an accepted build, in its own step (design §20 decision 3:
//           signing in a separate job from the one that ran the maker's setup), after checking the
//           build's outputs as far as it can without re-running the build (src/verifyBuild.js).
//   run     build, then sign, in one process: with a dev key only.
//   scan    the baseline scan (design §8.3; src/scan.js): findings for the maker only, in a folder
//           of their own; the agent pass only with --agent.
//   digest  the digest of a build's output folder, which the sign step can be asked to expect.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { BuilderError, Refusal } from './errors.js';
import { guarded } from './logSafe.js';
import { DEV_TRUST_FILE, outputsDigest, readOutputs, writeOutputs } from './outputs.js';
import { recheckForSigning } from './listingProof.js';
import { buildListing } from './pipeline.js';
import { REPORT_FILE } from './report.js';
import { scanListing, writeScan } from './scan.js';
import { attest, loadSigningKey } from './signing.js';
import { serializeJson } from './spec.js';
import { verifyForSigning } from './verifyBuild.js';
import { BUILDER_VERSION } from './version.js';

export const COMMANDS = Object.freeze({
  build: 'Build, push and validate a listing\'s env image; write code_review.json, baseline.json and the report',
  sign: 'Check an accepted build\'s outputs, then sign attestation.json with the configured key',
  run: 'build, then sign, in one process (dev key only)',
  scan: 'The baseline scan: Semgrep and a secret scan of the in-scope files, for the maker only',
  digest: 'Print the digest of a build\'s output folder (for sign --expect-outputs)',
});

// What each command needs, and the flags it takes.
const NEEDS = Object.freeze({ build: ['config', 'spec', 'out'], run: ['config', 'spec', 'out'], sign: ['config', 'dir'], scan: ['config', 'spec', 'out'], digest: ['dir'] });
const ALLOWED = Object.freeze({
  build: ['config', 'spec', 'known-issues', 'out', 'maker', 'control-proof'],
  run: ['config', 'spec', 'known-issues', 'out', 'maker', 'control-proof'],
  sign: ['config', 'dir', 'expect-outputs', 'check-registry', 'maker'],
  scan: ['config', 'spec', 'out', 'agent'],
  digest: ['dir'],
});
const FLAGS = new Set(['agent', 'check-registry']);

const USAGE = `Usage: verdikta-build-env <command> [options]

The Verdikta stake-attestation environment builder: builds a listing's env image FROM the
pinned foundry base, pushes it, checks a contract's verified source, validates the listing on
the arbiters' code-runner, and signs attestation.json.

Commands:
${Object.entries(COMMANDS).map(([name, about]) => `  ${name.padEnd(8)}${about}`).join('\n')}

Options:
  --config <file>          the builder's config (JSON)
  --spec <file>            build, run, scan: the maker's code_review.json (the draft, or the built one)
  --known-issues <file>    build, run: known_issues.json, when the draft names one
  --maker <address>        build, run, sign: the wallet that will send list(). The repository's
                           .verdikta/stake-control.json at the listed commit must name it
  --control-proof <file>   build, run: a contract listing's signature from its deployer or owner, JSON
                           { signer, signature, creationTx?, stakeChainId, stakeContract }
  --out <dir>              build, run, scan: where the output is written (new or empty)
  --dir <dir>              sign, digest: a build's output folder
  --expect-outputs <hex>   sign: refuse unless the folder's digest is this (from digest, in the build job)
  --check-registry         sign: read the image code_review.json names from its registry and check it
  --agent                  scan: also run the agent pass (scan.agent in the config; off by default)
  -h, --help               Show this help
  -v, --version            Print the version

Exit status: 0 accepted (or signed, scanned), 2 refused (see the report), 1 error, 64 usage error.
The scan's findings are the maker's alone: scan prints where they are and nothing of what they say.
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const m = /^--(config|spec|known-issues|out|dir|expect-outputs|check-registry|agent|maker|control-proof)$/.exec(rest[i]);
    if (m && FLAGS.has(m[1])) {
      opts[m[1]] = true;
      continue;
    }
    if (!m || i + 1 >= rest.length) return { command, error: `unknown or incomplete option '${rest[i]}'` };
    opts[m[1]] = rest[i + 1];
    i += 1;
  }
  const bad = Object.hasOwn(ALLOWED, command ?? '') ? Object.keys(opts).find((k) => !ALLOWED[command].includes(k)) : null;
  if (bad) return { command, error: `${command} does not take --${bad}` };
  if (opts['expect-outputs'] !== undefined && !/^[0-9a-f]{64}$/.test(opts['expect-outputs'])) return { command, error: '--expect-outputs takes a SHA-256 in lowercase hex' };
  return { command, opts };
}

function emptyOrMissing(dir) {
  return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
}

async function sign({ dir, config, env, out, maker, expectOutputs = null, checkRegistry = false, deps = {} }) {
  const key = loadSigningKey(config.signing.key, { env });
  const { files, report, names } = readOutputs(dir);
  const name = names.attestation || 'attestation.json';
  const taken = ['code_review.json', REPORT_FILE, DEV_TRUST_FILE, names.baseline, names.knownIssues].filter(Boolean);
  if (taken.includes(name) || !/^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/.test(name)) {
    throw new BuilderError('OUTPUT_INVALID', `code_review.json names the attestation ${JSON.stringify(name)}, which is not a free plain file name in ${dir}`);
  }
  if (fs.existsSync(path.join(dir, name))) throw new BuilderError('OUTPUT_INVALID', `${path.join(dir, name)} exists: this build is signed already`);
  // The folder is the listing's files as build wrote them, and nothing else: whatever is signed
  // here may be shipped whole as the listing.
  const listed = new Set(['code_review.json', REPORT_FILE, names.baseline, names.knownIssues].filter(Boolean));
  const extra = fs.readdirSync(dir).filter((f) => !listed.has(f));
  if (extra.length) throw new BuilderError('OUTPUT_INVALID', `${dir} also holds ${extra.join(', ')}: sign takes a folder of the listing's files only, as build wrote it`);
  // Everything that can be checked without re-running the build, before any signature exists.
  const verified = await verifyForSigning({ files, report, dir, expectOutputs, checkRegistry, ...(deps.registryFor ? { registryFor: deps.registryFor } : {}) });
  // The project's proof again, read from the host: nothing is signed without it.
  try {
    await recheckForSigning({ spec: JSON.parse(files.codeReview.toString('utf8')), report, maker, config, deps });
  } catch (err) {
    if (err instanceof Refusal) throw new BuilderError(err.code, err.detail, { step: 'sign' });
    throw err;
  }
  verified.checks.push('PROJECT_PROOF_STANDS');
  let signed;
  try {
    signed = await attest({ files, report, key });
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    // the maker's, as a build's refusal is: the report says why, and nothing is signed
    report.status = 'refused';
    report.refusals = [...(report.refusals ?? []), { code: err.code, detail: err.detail, step: err.step }];
    fs.writeFileSync(path.join(dir, REPORT_FILE), serializeJson(report), { mode: 0o644 });
    // the detail too: a signing job may keep nothing but its log. It is numbers, and names no project.
    out.write(`refused: ${err.code} (${err.step}): ${err.detail}; see ${path.join(dir, REPORT_FILE)}\n`);
    return 2;
  }
  const { attestation, bytes } = signed;
  verified.checks.push('LISTING_REQUEST_WITHIN_BOUND');
  fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o644 });
  const trust = key.devTrust();
  if (trust) fs.writeFileSync(path.join(dir, DEV_TRUST_FILE), serializeJson(trust), { mode: 0o644 });
  report.attestation = { trust: attestation.trust, keyId: attestation.signature.keyId, issuedAt: attestation.issuedAt, file: name, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  report.signing = verified;
  fs.writeFileSync(path.join(dir, REPORT_FILE), serializeJson(report), { mode: 0o644 });
  out.write(`signed ${name} (${attestation.trust} trust, key ${attestation.signature.keyId})${trust ? `; the dev trust set is ${DEV_TRUST_FILE}` : ''}\n`);
  return 0;
}

async function scan({ opts, config, out, err, deps }) {
  const target = opts.out;
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new BuilderError('SCAN_OUT_NOT_EMPTY', `${target} is not empty: the scan's findings go into a folder of their own, never beside a listing's files`);
  if (opts.agent && !config.scan.agent) throw new BuilderError('AGENT_NOT_CONFIGURED', '--agent needs scan.agent in the config: a model of the code-standard pool');
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(opts.spec, 'utf8'));
  } catch {
    throw new BuilderError('SPEC_UNREADABLE', `${opts.spec} cannot be read as JSON`);
  }
  const { status, doc } = await scanListing({ spec, config, deps, agent: Boolean(opts.agent) });
  const file = writeScan(target, doc);
  // Where the findings are, never what they say: this output may be a public CI log.
  if (status === 'ok') {
    out.write(`scan: wrote ${file}; it is for the maker only: keep it out of the listing archive, logs and public artifacts\n`);
    return 0;
  }
  err.write(`verdikta-build-env: scan ${doc.error.code}; the details are in ${file} (for the maker only)\n`);
  return 1;
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
  let deploymentProof = null;
  if (opts['control-proof']) {
    try {
      deploymentProof = JSON.parse(fs.readFileSync(opts['control-proof'], 'utf8'));
    } catch (err) {
      throw new BuilderError('CONTROL_PROOF_UNREADABLE', `${opts['control-proof']}: ${err.message}`);
    }
  }
  const result = await buildListing({ draft, knownIssues, maker: opts.maker ?? null, deploymentProof, config, deps });
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
export async function main(argv, { env = process.env, stdout: rawOut = process.stdout, stderr: rawErr = process.stderr, deps } = {}) {
  // What goes to a step's output can quote a maker's text, and a runner reads its lines as workflow commands.
  const stdout = guarded(rawOut);
  const stderr = guarded(rawErr);
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
  const missing = NEEDS[command].filter((k) => !opts[k]);
  if (missing.length) {
    stderr.write(`verdikta-build-env ${command}: missing --${missing.join(', --')}\n`);
    return 64;
  }
  try {
    if (command === 'digest') {
      stdout.write(`${outputsDigest(opts.dir)}\n`);
      return 0;
    }
    const config = loadConfig(opts.config, { env });
    const key = config.signing.key;
    if (command === 'sign') {
      return await sign({ dir: opts.dir, config, env, out: stdout, maker: opts.maker ?? null, expectOutputs: opts['expect-outputs'] ?? null, checkRegistry: Boolean(opts['check-registry']), deps });
    }
    if (command === 'scan') return await scan({ opts, config, out: stdout, err: stderr, deps });
    if (command === 'build' && key !== 'dev' && key.env && env[key.env] !== undefined) {
      throw new BuilderError('BUILD_ENV_HOLDS_SIGNING_KEY', `the signing key (${key.env}) is in build's environment; build runs the maker's setup and holds no secret: sign in a separate step`);
    }
    if (command === 'run' && key !== 'dev') {
      throw new BuilderError('RUN_NEEDS_DEV_KEY', 'run builds and signs in one process, so it takes a dev key only; use build, then sign, for the production key');
    }
    const status = await build({ opts, config, out: stdout, deps });
    if (status !== 'accepted') return status === 'refused' ? 2 : 1;
    if (command === 'run') return await sign({ dir: opts.out, config, env, out: stdout, maker: opts.maker ?? null, deps });
    return 0;
  } catch (err) {
    stderr.write(`verdikta-build-env: ${err instanceof BuilderError ? err.message : `BUILDER_FAILED: ${err?.message ?? err}`}\n`);
    if (err?.issues?.length) for (const i of err.issues) stderr.write(`  ${i.code}${i.detail ? `: ${i.detail}` : ''}\n`);
    return 1;
  }
}
