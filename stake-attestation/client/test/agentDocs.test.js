// /agents.txt and /llms.txt (node P27): what an agent that has only the site's URL reads before it pays a bond.
// Wrong is worse than missing there, so every fact in them that the code decides is read back from the code here,
// and this fails as soon as one stops matching:
//
//   commands and flags    the CLI's own lists (tool/src/usage.js COMMANDS and USAGE, tool/src/cli.js FLAGS, VALUES)
//   environment           the variables tool/src reads, the default RPC and the pin backends it takes
//   exit codes            the tool's table (tool/src/errors.js, through ToolError) and the CLI's own returns
//   API routes            server/src's routes, and the client's hash routes (src/App.jsx)
//   contract              every function named, with its arguments, against the tool's merged ABI; every constant
//                         stated as NAME = value against the Solidity source; every other time stated against the tool
//   files                 every file named against common's, the shared package's and the tool's own names
//   @verdikta/common      the version in every link equals the pinned one, and each linked file is in that release
//   hosts                 an allowed set, GitHub links only to the two public repositories at their refs
//   per-listing values    none stated: no wei or ETH amount, address, hash or number the code does not decide
//
// The branches the documents send an agent to are named once each, below: TOOL_REF for the tool and the site's code,
// ARBITER_DOCS_REF for the arbiters' code-runner. No document names the integration branch the build was made on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { wordingProblems } from '../e2e/support/wording.js';
import { STRINGS } from '../src/strings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '..');
const APP = path.resolve(CLIENT, '..');
const read = (...parts) => fs.readFileSync(path.join(APP, ...parts), 'utf8');

/** Where the documents send an agent for the tool: verdikta-applications' branch. Named here only. */
const TOOL_REF = 'main';
/**
 * The verdikta-arbiter ref of the documents' code-runner link. Named here only, and not read from
 * builder/test/docker/code-runner.pin.json: that pin moves with builder/action/pins.json and e2e/arbiter.pin.json (the
 * builder's signing workflow and the round), and its branch stays the one its commit is on.
 */
const ARBITER_DOCS_REF = 'main';
/** The branch the build was made on, which no document names: an agent that follows it gets a tool nobody maintains. */
const INTEGRATION_BRANCH = 'claude/stake-attestation';
const SITE = 'https://verifiers.verdikta.org';
const APPS_REPO = 'verdikta/verdikta-applications';
const ARBITER_REPO = 'verdikta/verdikta-arbiter';

const NAMES = ['agents.txt', 'llms.txt'];
const docs = () => NAMES.map((name) => [name, read('client', 'public', name)]);
const agents = () => read('client', 'public', 'agents.txt');
const lines = (text) => text.split('\n');

// ------------------------------------------------------------------------------------------- the tool

const toolSrc = (f) => read('tool', 'src', f);
const toolSources = () => fs.readdirSync(path.join(APP, 'tool', 'src')).filter((f) => f.endsWith('.js')).map(toolSrc).join('\n');
const quoted = (text) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);

function setLiteral(source, name) {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source);
  assert.ok(m, `tool/src/cli.js holds ${name}`);
  return quoted(m[1]);
}

/** What the tool's argument parser takes: its FLAGS and VALUES, and the two answers run() gives before them. */
function parsedFlags() {
  const cli = toolSrc('cli.js');
  const early = [...cli.matchAll(/first === '(--[a-z-]+)'/g)].map((m) => m[1]);
  return new Set([...setLiteral(cli, 'FLAGS'), ...setLiteral(cli, 'VALUES'), ...early]);
}

function commands() {
  const m = /export const COMMANDS = \{([\s\S]*?)\n\};/.exec(toolSrc('usage.js'));
  assert.ok(m, 'tool/src/usage.js holds COMMANDS');
  return [...m[1].matchAll(/^\s+([a-z]+):/gm)].map((x) => x[1]);
}

/** The flags USAGE documents per command, and the options it documents for every command. */
function usageFlags() {
  const usage = toolSrc('usage.js');
  const per = new Map(commands().map((c) => [c, new Set()]));
  for (const line of lines(usage)) {
    const m = /^ {2}([a-z]+) <[^>]+>/.exec(line);
    if (m && per.has(m[1])) for (const f of line.matchAll(/--[a-z][a-z-]*/g)) per.get(m[1]).add(f[0]);
  }
  const options = usage.slice(usage.indexOf('\nOptions:\n'), usage.indexOf('\nEnvironment:\n'));
  assert.ok(options.length > 20, 'USAGE has its Options');
  const global = new Set([...options.matchAll(/^ {2}(?:-[a-z], )?(--[a-z][a-z-]*)/gm)].map((m) => m[1]));
  return { per, global };
}

/** Every environment variable tool/src reads. */
const toolEnv = () => new Set([...toolSources().matchAll(/\benv\.([A-Z][A-Z0-9_]*)|numberEnv\(env, '([A-Z][A-Z0-9_]*)'\)|\benv\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)].map((m) => m[1] ?? m[2] ?? m[3]));

const { ERROR_TEXTS, ToolError } = await import(pathToFileURL(path.join(APP, 'tool', 'src', 'errors.js')).href);

/** Exit code -> the error codes that end with it: the tool's table, read through ToolError, and the CLI's own returns. */
function toolExits() {
  const exits = new Map([[0, []]]);
  for (const code of Object.keys(ERROR_TEXTS)) {
    const e = new ToolError(code).exitCode;
    exits.set(e, [...(exits.get(e) ?? []), code]);
  }
  for (const m of toolSrc('cli.js').matchAll(/return (\d);|\? (\d) : (\d);/g)) {
    for (const n of [m[1], m[2], m[3]].filter((x) => x !== undefined)) if (!exits.has(Number(n))) exits.set(Number(n), []);
  }
  return exits;
}

/** The documents' tool invocations: `verdikta-attest <args>` at a line's start or in backticks, or node running its bin. */
function invocations(text) {
  const out = [];
  lines(text).forEach((line, i) => {
    const re = /(?:^\s*|`)(?:node\s+\S*bin\/verdikta-attest\.js|verdikta-attest)((?:[ \t]+[^\s`#]+)*)/g;
    for (const m of line.matchAll(re)) out.push({ line: i + 1, args: m[1].trim().split(/\s+/).filter(Boolean) });
  });
  return out;
}

// ---------------------------------------------------------------------------------- the server and client

function serverRoutes() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/\b(?:app|router)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) out.push({ method: m[1].toUpperCase(), path: m[2] });
      }
    }
  };
  walk(path.join(APP, 'server', 'src'));
  return out;
}

/** Every /api path the documents name, with the method written before it (GET when none is). */
function docRoutes(text) {
  return [...text.matchAll(/(?:\b(GET|POST|PUT|PATCH|DELETE) +(?:https:\/\/verifiers\.verdikta\.org)?)?(\/api(?:\/(?::?[A-Za-z0-9_-]+|<[A-Za-z0-9_-]+>))+)/g)]
    .map((m) => ({ method: m[1] ?? 'GET', path: m[2].replace(/<([A-Za-z0-9_-]+)>/g, ':$1') }));
}

const routeMatches = (route, doc) => {
  const a = route.path.split('/');
  const b = doc.path.split('/');
  return route.method === doc.method && a.length === b.length && a.every((s, i) => (s.startsWith(':') ? b[i].startsWith(':') : s === b[i]));
};

// ------------------------------------------------------------------------------------------- the contract

const ABI = JSON.parse(read('tool', 'src', 'abi', 'StakeAttestation.json')).filter((x) => x.type === 'function');
const SOL_TYPE = /^(?:u?int\d*|address|bool|string|bytes\d*)(?:\[\d*\])*$/;

/** The contract's constants, NAME -> expression, and their values with Solidity's time units. */
function solidity() {
  const raw = new Map();
  for (const f of ['StakeAttestation.sol', path.join('libraries', 'ClaimRules.sol')]) {
    for (const m of read('onchain', 'contracts', f).matchAll(/\buint\d+\s+(?:public|internal)\s+constant\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g)) raw.set(m[1], m[2].trim());
  }
  const UNITS = { seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800 };
  const value = (name, seen = []) => {
    assert.ok(raw.has(name), `${name} is a constant of StakeAttestation or ClaimRules`);
    assert.ok(!seen.includes(name), `${name}: a cycle`);
    const expr = raw.get(name)
      .replace(/ClaimRules\./g, '')
      .replace(/(\d[\d_]*)\s+(seconds|minutes|hours|days|weeks)\b/g, (_, n, u) => `(${n.replace(/_/g, '')}*${UNITS[u]})`)
      .replace(/\b\d[\d_]*\b/g, (n) => n.replace(/_/g, ''))
      .replace(/\b[A-Z][A-Z0-9_]*\b/g, (n) => `(${value(n, [...seen, name])})`);
    assert.match(expr, /^[\d\s+\-*/()]+$/, `${name} = ${raw.get(name)} is arithmetic`);
    return Function(`return (${expr});`)();
  };
  return { raw, value };
}

/** Each `NAME = value` the documents state. */
const statedConstants = (text) => [...text.matchAll(/\b([A-Z][A-Z0-9_]*[A-Z0-9]) = (\d[\d,_]*)/g)].map((m) => ({ name: m[1], value: Number(m[2].replace(/[,_]/g, '')), at: m.index, end: m.index + m[0].length }));

// ------------------------------------------------------------------------------------------------ common

const pkg = (name) => JSON.parse(read(name, 'package.json'));
const COMMON = path.join(CLIENT, 'node_modules', '@verdikta', 'common');
// CommonJS, through the client's own install of the pinned release
const { codeReview } = createRequire(import.meta.url)('@verdikta/common');
const pinnedCommon = () => pkg('client').dependencies['@verdikta/common'];

// -------------------------------------------------------------------------------------------------- tests

test('both documents exist, are UTF-8 text, and the README says how they stay true', () => {
  for (const [name, text] of docs()) {
    assert.ok(text.length > 200, name);
    assert.doesNotMatch(text, /\r|\t|[^\x09\x0a\x20-\x7e -￿]/u, `${name}: plain text, LF lines, no tab or control character`);
    assert.ok(text.endsWith('\n'), `${name} ends with a newline`);
  }
  const readme = read('README.md');
  assert.match(readme, /client\/public\/agents\.txt/);
  assert.match(readme, /client\/test\/agentDocs\.test\.js/);
});

test('agents.txt keeps the order the issue sets: the site, the listings, the claim\'s life, costs, the tool, the claim folder, pinning and the wallet, check, the local state, the reference', () => {
  const headings = lines(agents()).filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
  const order = [/what this site is/i, /listings/i, /claim's life/i, /costs/i, /verdikta-attest/i, /claim folder/i, /pinning.*wallet/i, /\bcheck\b/i, /local state/i, /full reference/i];
  assert.equal(headings.length, order.length, headings.join(' | '));
  headings.forEach((h, i) => assert.match(h, order[i], h));
});

test('llms.txt has the llms.txt format\'s shape (a title, a summary, lists of links) and points to agents.txt', () => {
  const text = read('client', 'public', 'llms.txt');
  const ls = lines(text);
  assert.match(ls[0], /^# \S/, 'an H1 with the site\'s name first');
  assert.equal(ls.filter((l) => /^# /.test(l)).length, 1, 'one H1');
  assert.match(ls.find((l) => l.trim() !== '' && !l.startsWith('# ')), /^> \S/, 'then a blockquote summary');
  const sections = ls.filter((l) => l.startsWith('## '));
  assert.ok(sections.length >= 2);
  const items = ls.filter((l) => l.startsWith('- '));
  for (const item of items) assert.match(item, /^- \[[^\]]+\]\(https:\/\/[^)\s]+\)(?:: .+)?$/, item);
  assert.ok(items.some((l) => l.includes(`](${SITE}/agents.txt)`)), 'a link to /agents.txt');
  assert.ok(ls.indexOf(ls.find((l) => l.includes(`](${SITE}/agents.txt)`))) < ls.indexOf('## Optional') || !ls.includes('## Optional'), 'the guide is not optional');
});

test('the home page links both documents, and they are the files in client/public', () => {
  assert.equal(STRINGS.footer.guide, '/agents.txt');
  assert.equal(STRINGS.footer.index, '/llms.txt');
  assert.match(STRINGS.footer.lead, /\bagents\b/i);
  const app = fs.readFileSync(path.join(CLIENT, 'src', 'App.jsx'), 'utf8');
  assert.match(app, /href=\{STRINGS\.footer\.guide\}/);
  assert.match(app, /href=\{STRINGS\.footer\.index\}/);
  for (const p of [STRINGS.footer.guide, STRINGS.footer.index]) assert.ok(fs.existsSync(path.join(CLIENT, 'public', p)), p);
});

test('every verdikta-attest command they name is one of the CLI\'s, and each flag on it is the parser\'s and documented for it', () => {
  const cmds = commands();
  const parsed = parsedFlags();
  const { per, global } = usageFlags();
  assert.ok(cmds.length >= 6 && parsed.size >= 10, 'the CLI\'s lists were read');
  let seen = 0;
  for (const [name, text] of docs()) {
    for (const { line, args } of invocations(text)) {
      if (args.length === 0) continue;
      seen += 1;
      const [first, ...rest] = args;
      if (first.startsWith('-')) {
        assert.ok(parsed.has(first) && global.has(first), `${name}:${line}: verdikta-attest ${first} is no option of the CLI`);
        continue;
      }
      assert.ok(cmds.includes(first), `${name}:${line}: '${first}' is no verdikta-attest command (${cmds.join(', ')})`);
      for (const flag of rest.filter((a) => a.startsWith('--'))) {
        assert.ok(parsed.has(flag), `${name}:${line}: ${flag} is no flag the CLI parses`);
        assert.ok(per.get(first).has(flag) || global.has(flag), `${name}:${line}: ${flag} is not documented for ${first}`);
      }
    }
  }
  assert.ok(seen >= 10, `the documents name the commands (${seen} found)`);
  // the commands an agent needs, each shown at least once
  const named = new Set(docs().flatMap(([, t]) => invocations(t).map((x) => x.args[0])));
  for (const c of cmds) assert.ok(named.has(c), `agents.txt shows ${c}`);
});

test('every --flag anywhere in them is the CLI\'s, or one of the few another command line owns', () => {
  const parsed = parsedFlags();
  const FOREIGN = new Map([['--branch', /^\s*git clone /], ['--cached', /\bgit diff --cached\b/], ['--match-test', /\bforge test --match-test\b/], ['--ignore-scripts', /\bnpm ci\b/]]);
  for (const [name, text] of docs()) {
    lines(text).forEach((line, i) => {
      for (const m of line.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) {
        const flag = m[0];
        if (parsed.has(flag)) continue;
        assert.ok(FOREIGN.has(flag) && FOREIGN.get(flag).test(line), `${name}:${i + 1}: ${flag} is no verdikta-attest flag`);
      }
    });
  }
});

test('every environment variable they name is one the tool reads, with the default RPC and the pin backends it takes', () => {
  const env = toolEnv();
  assert.ok(env.has('VERDIKTA_WALLET_KEY') && env.has('CODE_RUNNER_URL'), 'tool/src was read');
  for (const [name, text] of docs()) {
    const named = new Set([
      ...[...text.matchAll(/\b(?:VERDIKTA|CODE_RUNNER)_[A-Z0-9_]+\b/g)].map((m) => m[0]),
      ...[...text.matchAll(/(?:^|[\s(])(?:export )?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)=/gm)].map((m) => m[1]),
    ]);
    for (const v of named) assert.ok(env.has(v), `${name}: ${v} is no variable the tool reads`);
  }
  const text = agents();
  const rpcDefault = /export const DEFAULT_RPC_URL = '([^']+)'/.exec(toolSrc('context.js'))[1];
  assert.match(text, new RegExp(`VERDIKTA_RPC_URL[^\\n]*defaults to ${rpcDefault.replace(/[.]/g, '\\.')}\\b`));
  const backends = quoted(/if \(!\[([^\]]+)\]\.includes\(backend\)\)/.exec(toolSrc('ipfs.js'))[1]);
  const written = [...text.matchAll(/VERDIKTA_PIN_BACKEND=([a-z]+)/g)].map((m) => m[1]);
  assert.ok(written.length > 0);
  for (const b of written) assert.ok(backends.includes(b), `VERDIKTA_PIN_BACKEND=${b}: the tool takes ${backends.join(', ')}`);
  assert.deepEqual([...new Set(written)].sort(), [...backends].sort(), 'every backend the tool takes is shown');
});

// Each exit's line names the error codes that end with it (all but 1's, which is every other refusal), so a code that
// moves to another exit, an existing one included, fails here; and the CLI's own returns are on the lines they use.
test('the exit codes are the tool\'s table: each line names exactly the error codes that end with it, and the flags they need', () => {
  const text = agents();
  const start = text.indexOf('\nExit codes:\n');
  assert.ok(start >= 0, 'agents.txt has an Exit codes block');
  const block = text.slice(start + 1).split('\n\n')[0];
  const stated = new Map();
  let last = null;
  for (const line of lines(block).slice(1)) {
    const m = /^ {2}(\d) {2}(.+)$/.exec(line);
    if (m) stated.set((last = Number(m[1])), m[2]);
    else if (last !== null && /^ {5}\S/.test(line)) stated.set(last, `${stated.get(last)} ${line.trim()}`);
  }
  const exits = toolExits();
  assert.deepEqual([...stated.keys()].sort(), [...exits.keys()].sort(), 'the codes stated are the codes the tool returns');
  const exitOf = (code) => new ToolError(code).exitCode;
  for (const [exit, line] of stated) {
    const named = [...line.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g)].map((m) => m[0]).filter((c) => Object.hasOwn(ERROR_TEXTS, c));
    for (const c of named) assert.equal(exitOf(c), exit, `exit ${exit}'s line names ${c}, which the tool ends with ${exitOf(c)}`);
    if (exit <= 1) continue;
    assert.deepEqual([...new Set(named)].sort(), [...exits.get(exit)].sort(), `exit ${exit}'s line names the codes that end with it`);
    const flags = new Set(exits.get(exit).flatMap((c) => [...ERROR_TEXTS[c].matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0])));
    for (const f of flags) assert.ok(line.includes(f), `exit ${exit} is ${exits.get(exit).join(', ')}: its line names ${f}`);
  }
  // the CLI's own: status --wait out of time, status --wait on a round with no verdict, and check's forecast short of a pass
  const cli = toolSrc('cli.js');
  const waitExit = Number(/if \(r\.timedOut\) return (\d);/.exec(cli)[1]);
  const failedExit = Number(/if \(wait && r\.roundFailed\) return (\d);/.exec(cli)[1]);
  const checkExit = Number(/r\.forecast\.verdict === 'pass' \? 0 : (\d)/.exec(cli)[1]);
  assert.match(stated.get(waitExit), /status --wait/, `status --wait out of time ends with ${waitExit}`);
  assert.match(stated.get(failedExit), /status --wait/, `status --wait on a round with no verdict ends with ${failedExit}`);
  assert.match(stated.get(failedExit), /no verdict/, `exit ${failedExit}: a round with no verdict`);
  assert.match(stated.get(checkExit), /\bcheck\b/, `check short of a pass ends with ${checkExit}`);
  assert.match(stated.get(4), /again/, 'exit 4: run the same command again');
  // node P32: a code of its own, which no error of the tool and no other return of the CLI ends with
  assert.deepEqual(exits.get(failedExit), [], `no error code ends with ${failedExit}`);
  assert.ok(![0, 1, 2, 3, waitExit, checkExit].includes(failedExit), `exit ${failedExit} is no other exit's`);
});

/** The help's exit codes: the "Exit codes:" block of tool/src/usage.js's USAGE, code -> its text. */
function usageExits() {
  const usage = toolSrc('usage.js');
  const start = usage.indexOf('\nExit codes:\n');
  assert.ok(start >= 0, 'USAGE has an Exit codes block');
  const out = new Map();
  let last = null;
  for (const line of lines(usage.slice(start + 1).split('\n\n')[0]).slice(1)) {
    const m = /^ {2}(\d) {2}(.+)$/.exec(line);
    if (m) out.set((last = Number(m[1])), m[2]);
    else if (last !== null && /^ {5}\S/.test(line)) out.set(last, `${out.get(last)} ${line.trim()}`);
  }
  return out;
}

test('node P32: the help lists the same exit codes as agents.txt, status --wait\'s round with no verdict among them', () => {
  const text = agents();
  const block = text.slice(text.indexOf('\nExit codes:\n') + 1).split('\n\n')[0];
  const stated = new Set([...block.matchAll(/^ {2}(\d) {2}/gm)].map((m) => Number(m[1])));
  const help = usageExits();
  assert.deepEqual([...help.keys()].sort(), [...stated].sort(), 'the same codes');
  assert.deepEqual([...help.keys()].sort(), [...toolExits().keys()].sort(), 'the codes the tool returns');
  const failedExit = Number(/if \(wait && r\.roundFailed\) return (\d);/.exec(toolSrc('cli.js'))[1]);
  assert.match(help.get(failedExit), /status --wait/);
  assert.match(help.get(failedExit), /no verdict/);
});

test('node P32: the new command lines: reveal is a dry run without --yes, as commit, reveal --retrigger and appeal', () => {
  const reveal = toolSrc('reveal.js');
  const main = /export async function runReveal[\s\S]*$/.exec(reveal)[0];
  assert.match(main, /revealNotice\(/, 'reveal says what it would send');
  assert.match(main, /if \(!acknowledge\) throw fail\('NEEDS_ACKNOWLEDGEMENT'\)/, 'and sends nothing without acknowledge');
  const text = agents();
  const flat = text.replace(/\s+/g, ' ');
  assert.match(flat, /`commit` on a folder with no commit signed yet, `reveal`, `reveal --retrigger` and `appeal` print what they will send and send nothing without --yes \(exit 3\)/);
  assert.doesNotMatch(flat, /`reveal` asks for no --yes/);
  const block = lines(text.slice(text.indexOf('The commands, in order'), text.indexOf('\nIf it is judged INVALID')));
  assert.ok(block.some((l) => /^ {4}verdikta-attest reveal \.\/claim +# .*sends nothing/.test(l)), 'the dry run');
  assert.ok(block.some((l) => /^ {4}verdikta-attest reveal \.\/claim --yes +#/.test(l)), 'the reveal');
  // section 4's cast lines: commitPrice, revealTopUp, retriggerTopUp and disputeFee, each by the id it takes
  const costs = text.slice(text.indexOf('\n## 4. '), text.indexOf('\n## 5. '));
  for (const [fn, arg] of [['commitPrice', 'listingId'], ['revealTopUp', 'claimId'], ['retriggerTopUp', 'claimId'], ['disputeFee', 'listingId']]) {
    const line = `    cast call "$VERDIKTA_CONTRACT" "${fn}(uint256)(uint256)" <${arg}> --rpc-url https://sepolia.base.org`;
    assert.ok(costs.includes(line), `section 4: ${line.trim()}`);
    const abi = ABI.find((f) => f.name === fn);
    assert.equal(abi.inputs[0].name, arg, `${fn} takes ${arg}`);
  }
});

test('node P32: check is described as the tool describes it, never as optional', () => {
  const line = quoted(/export const DILIGENCE = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(toolSrc('notices.js'))[1]).find((l) => /^Run check /.test(l));
  assert.ok(line, 'the tool\'s diligence text says when to run check');
  const flat = agents().replace(/\s+/g, ' ');
  assert.ok(flat.includes(line), `agents.txt says it word for word: ${line}`);
  for (const m of flat.matchAll(/[^.]*\boptional\b[^.]*/gi)) assert.doesNotMatch(m[0], /\bcheck\b|runner/, `"${m[0].trim()}"`);
});

test('node P32: the gaps a fresh agent met are filled: dry runs, the human\'s step, known issues, Apple silicon, a round with no verdict, a moved deadline', () => {
  const flat = agents().replace(/\s+/g, ' ');
  // what a dry run needs and writes: the token is read only when a pin is made (tool/src/ipfs.js)
  assert.match(toolSrc('ipfs.js'), /const pinFor = [\s\S]*?if \(needsToken && !token\) throw fail\('PIN_CONFIG'/);
  assert.match(flat, /A dry run needs the wallet key[^.]*VERDIKTA_PIN_BACKEND[^.]*not VERDIKTA_PIN_TOKEN/);
  assert.match(flat, /writes `claim\/\.verdikta-claim\/` with a `\.gitignore`/);
  // a human's go-ahead, twice
  assert.match(flat, /human[^.]*wallet key[^.]*code-runner|human[^.]*code-runner[^.]*wallet key/i);
  // a listing that names no known issues file has none (tool/src/listing.js takes it as [])
  assert.match(toolSrc('listing.js'), /knownIssues: spec\.stake\?\.knownIssues \? [^:]+ : \[\]/);
  assert.match(flat, /names no `stake\.knownIssues` file has no known issues/);
  // Apple silicon: the class platform is common's, and the runner README's "Run it" says how
  assert.ok(flat.includes(`\`${codeReview.OCI_PLATFORM}\``), `the platform, ${codeReview.OCI_PLATFORM}`);
  assert.match(flat, /On Apple silicon, `check` runs the runner in amd64 mode/);
  assert.match(flat, /code-runner \(its README, "Run it"\)/);
  // a round with no verdict: what it means, and that a re-trigger of the same claim likely fails the same way
  assert.match(flat, /status --wait` exits 5[^.]*no verdict/);
  assert.match(flat, /likely to fail the same way/);
  // a release moves the reveal deadline earlier, and status says so
  assert.match(toolSrc('status.js'), /moved earlier/);
  assert.match(flat, /release[^.]*moves your reveal deadline earlier[^.]*run `verdikta-attest status/);
});


// tools/src/commit.js asks for --yes only before a commit is signed; a resumed one goes on without it (R1-F1).
test('what they say commit does without --yes is what commit.js does', () => {
  const commit = toolSrc('commit.js');
  const asksOnlyFirst = /if \(!state \|\| state\.stage === 'prepared'\) \{\s*const \{ listing, inputs \} = await readyToCommit\(/.test(commit);
  assert.ok(asksOnlyFirst, 'commit.js reads the acknowledgement only for a folder with no commit signed (readyToCommit)');
  assert.match(/function readyToCommit[\s\S]*?\n\}/.exec(commit)[0], /NEEDS_ACKNOWLEDGEMENT/);
  const text = agents().replace(/\s+/g, ' ');
  assert.match(text, /`commit` on a folder with no commit signed yet/);
  assert.match(text, /Once a commit is signed, `commit` resumes it on every run, --yes or not/);
  assert.doesNotMatch(text, /verdikta-attest commit [^#\n]*# prints the terms and the price; sends nothing/);
});

test('every /api route they name is one of the server\'s, by method, and every #/ page one of the client\'s', () => {
  const routes = serverRoutes();
  assert.ok(routes.length >= 10, 'server/src was read');
  let n = 0;
  for (const [name, text] of docs()) {
    for (const d of docRoutes(text)) {
      n += 1;
      assert.ok(routes.some((r) => routeMatches(r, d)), `${name}: ${d.method} ${d.path} is no route of the server`);
    }
  }
  assert.ok(n >= 5);
  const app = fs.readFileSync(path.join(CLIENT, 'src', 'App.jsx'), 'utf8');
  const pages = new Set([...app.matchAll(/h === '\/([a-z]+)'|\^\\\/([a-z]+)\(/g)].map((m) => m[1] ?? m[2]));
  for (const [name, text] of docs()) {
    for (const m of text.matchAll(/#\/([a-z]+)/g)) assert.ok(pages.has(m[1]), `${name}: #/${m[1]} is no page of the client`);
  }
});

test('every contract function they name is in the ABI, with the arguments it takes', () => {
  const byName = new Map();
  for (const f of ABI) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  let n = 0;
  for (const [name, text] of docs()) {
    lines(text).forEach((line, i) => {
      if (/\bnode -[ep]\b/.test(line)) return; // inline JavaScript, not the contract
      for (const m of line.matchAll(/(?<![\w.$-])([a-z][A-Za-z0-9]*)\(([^()]*)\)/g)) {
        n += 1;
        const fns = byName.get(m[1]);
        assert.ok(fns, `${name}:${i + 1}: ${m[1]}() is no function of StakeAttestation or its lens`);
        const args = m[2].split(',').map((a) => a.trim()).filter(Boolean);
        const fits = fns.some((f) => f.inputs.length === args.length && f.inputs.every((input, k) => (SOL_TYPE.test(args[k]) ? input.type === args[k] : input.name === args[k])));
        assert.ok(fits, `${name}:${i + 1}: ${m[0]} is not how ${m[1]} is declared (${fns.map((f) => `${m[1]}(${f.inputs.map((x) => `${x.type} ${x.name}`).join(', ')})`).join('; ')})`);
      }
    });
  }
  assert.ok(n >= 10, `the documents name the contract's functions (${n})`);
});

const solidityEnum = (name) => {
  const m = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(read('onchain', 'contracts', 'StakeAttestation.sol'));
  assert.ok(m, `StakeAttestation.sol: enum ${name}`);
  return m[1].split(',').map((s) => s.trim());
};

test('the outcomes are the contract\'s, in its order, and every claim state named is one of its states', () => {
  const text = agents().replace(/\s+/g, ' ');
  const m = /six outcomes, in this order: ((?:[A-Z]+, )+[A-Z]+),/.exec(text);
  assert.ok(m, 'agents.txt lists the outcomes in order');
  assert.deepEqual(m[1].split(', '), solidityEnum('Outcome'));
  const states = solidityEnum('ClaimState');
  const named = [...text.matchAll(/\b(?:the claim is|leaves the claim|it is) ([A-Z][a-z]+(?:[A-Z][a-z]+)*)\b/g)].map((x) => x[1]);
  assert.ok(named.length >= 2, 'the documents name claim states');
  for (const s of named) assert.ok(states.includes(s), `${s} is no ClaimState (${states.join(', ')})`);
  // a word in CamelCase is a state, a contract or GitHub: anything else is a name nothing here checks
  const contracts = fs.readdirSync(path.join(APP, 'onchain', 'contracts', 'libraries')).concat(fs.readdirSync(path.join(APP, 'onchain', 'contracts'))).map((f) => f.replace(/\.sol$/, ''));
  for (const [name, t] of docs()) {
    for (const w of t.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g)) assert.ok(states.includes(w[0]) || contracts.includes(w[0]) || w[0] === 'GitHub', `${name}: ${w[0]}`);
  }
});

test('every CODE they name is an error code of the tool, a variable it reads or a constant of the contract', () => {
  const env = toolEnv();
  const { raw } = solidity();
  for (const [name, text] of docs()) {
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b(?!\.[a-z])/g)) { // not a file's name
      assert.ok(Object.hasOwn(ERROR_TEXTS, m[0]) || env.has(m[0]) || raw.has(m[0]), `${name}: ${m[0]} is no error code, variable or constant of the code`);
    }
  }
});

test('every contract constant they state is the Solidity source\'s value, and every other time they state is the tool\'s', () => {
  const { raw, value } = solidity();
  for (const [name, text] of docs()) {
    const stated = statedConstants(text);
    for (const s of stated) {
      assert.ok(raw.has(s.name), `${name}: ${s.name} is no constant of the contract`);
      assert.equal(s.value, value(s.name), `${name}: ${s.name} = ${s.value}, but the contract says ${value(s.name)}`);
    }
    // a duration anywhere else is a timing fact nothing checks, but for the watch's limit (tool/src/status.js)
    const watchMinutes = Function(`return (${/export const WATCH_MAX_MS = ([^;]+);/.exec(toolSrc('status.js'))[1]}) / 60000;`)();
    for (const m of text.matchAll(/\b(\d+) (seconds?|minutes?|hours?|days?|weeks?)\b/g)) {
      const inStatement = stated.some((s) => m.index >= s.at && m.index <= s.end + 1);
      if (inStatement) continue;
      assert.ok(/^minutes?$/.test(m[2]) && Number(m[1]) === watchMinutes, `${name}: "${m[0]}" is a time nothing here checks`);
      const sentence = text.slice(Math.max(0, m.index - 80), m.index);
      assert.match(sentence, /--wait/, `${name}: "${m[0]}" is said of status --wait`);
    }
  }
  assert.ok(statedConstants(agents()).some((s) => s.name === 'DISCLOSE_WINDOW'), 'agents.txt states the disclose window');
});

test('every file they name is one the arbiters, the listing flow or the tool names', () => {
  const known = new Set([
    ...Object.entries(codeReview).filter(([k]) => /_FILE$/.test(k)).map(([, v]) => v),
    ...quoted(read('shared', 'src', 'builderSignature.js').split('\n').filter((l) => /^const [A-Z_]+_FILE = /.test(l)).join('\n')),
    ...[...toolSources().matchAll(/'([\w-]+\.(?:json|zip|age))'/g)].map((m) => m[1]),
    ...fs.readdirSync(path.join(COMMON, 'schemas')),
    ...fs.readdirSync(path.join(COMMON, 'docs')),
    'README.md', 'agents.txt', 'llms.txt', 'listing.zip',
  ]);
  for (const [name, text] of docs()) {
    for (const m of text.replace(/https?:\/\/\S+/g, '').matchAll(/(?<![\w./-])([\w-]+(?:\.v\d+)?\.(?:json|md|patch|zip|age|sol))\b/g)) {
      if (m[1].endsWith('.sol')) {
        assert.ok(fs.existsSync(path.join(APP, 'onchain', 'contracts', m[1])) || fs.existsSync(path.join(APP, 'onchain', 'contracts', 'libraries', m[1])), `${name}: ${m[1]}`);
        continue;
      }
      assert.ok(known.has(m[1]), `${name}: ${m[1]} is no file the code names`);
    }
  }
  const stateDir = /export const STATE_DIR = '([^']+)'/.exec(toolSrc('workspace.js'))[1];
  const folders = [...agents().matchAll(/\.verdikta-[a-z]+(?=\/)/g)].map((m) => m[0]);
  assert.ok(folders.length > 0);
  for (const f of folders) assert.equal(f, stateDir, 'the claim\'s state folder is the tool\'s');
});

test('every @verdikta/common version in a link is the one this app pins, and each linked file is in that release', () => {
  const pinned = pinnedCommon();
  for (const p of ['client', 'tool', 'server']) assert.equal(pkg(p).dependencies['@verdikta/common'], pinned, `${p} pins @verdikta/common ${pinned}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(COMMON, 'package.json'), 'utf8')).version, pinned, 'the installed common is the pinned one');
  let unpkg = 0;
  for (const [name, text] of docs()) {
    for (const m of text.matchAll(/@verdikta\/common@([0-9A-Za-z.+-]+?)(?=[/\s)]|$)/g)) assert.equal(m[1], pinned, `${name}: @verdikta/common@${m[1]}`);
    for (const m of text.matchAll(/npmjs\.com\/package\/@verdikta\/common\/v\/([0-9A-Za-z.+-]+)/g)) assert.equal(m[1], pinned, `${name}: npm link to ${m[1]}`);
    for (const m of text.matchAll(/(?<![\w-])@verdikta\/common (\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/g)) assert.equal(m[1], pinned, `${name}: @verdikta/common ${m[1]}`);
    for (const m of text.matchAll(/https:\/\/unpkg\.com\/@verdikta\/common@[^/\s)]+\/([^\s)#]+)/g)) {
      unpkg += 1;
      assert.ok(fs.existsSync(path.join(COMMON, m[1])), `${name}: ${m[1]} is in @verdikta/common ${pinned}`);
    }
  }
  assert.ok(unpkg >= 2, 'the finding schema and the specification are linked');
  assert.ok(agents().includes(`https://unpkg.com/@verdikta/common@${pinned}/schemas/finding.v1.json`), 'agents.txt links the finding schema');
});

const escaped = (ref) => ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Every place a document sends an agent to a branch, held to TOOL_REF and ARBITER_DOCS_REF: the GitHub links (to the
 * two public repositories only), the clone line and the prose of agents.txt, and any branch of the build's (claude/...)
 * named anywhere. An empty list is a document that sends an agent nowhere else.
 */
function refProblems(name, text) {
  const problems = [];
  for (const m of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[/\s)#]|$)(\/(?:tree|blob)\/([^\s)#]+))?/g)) {
    if (![APPS_REPO, ARBITER_REPO].includes(m[1])) {
      problems.push(`${name}: github.com/${m[1]} is not a public repository of the site's`);
      continue;
    }
    if (m[3] === undefined) continue;
    const ref = m[1] === APPS_REPO ? TOOL_REF : ARBITER_DOCS_REF;
    if (!m[3].startsWith(`${ref}/`)) problems.push(`${name}: ${m[1]} at ${m[3]}: the ref is ${ref}`);
  }
  for (const m of text.matchAll(/--branch (\S+)/g)) {
    if (m[1] !== TOOL_REF) problems.push(`${name}: git clone --branch ${m[1]}: the ref is ${TOOL_REF}`);
  }
  for (const m of text.matchAll(/(?<![\w-])claude\/[\w.-]*\w/g)) {
    problems.push(`${name}:${text.slice(0, m.index).split('\n').length}: names the branch ${m[0]}`);
  }
  if (/\bmoves? to main\b/i.test(text)) problems.push(`${name}: says the tool moves to main: it is there`);
  if (name === 'agents.txt') {
    if (!text.includes(`git clone --branch ${TOOL_REF} https://github.com/${APPS_REPO}.git`)) problems.push(`agents.txt: no clone of the tool at ${TOOL_REF}`);
    if (!new RegExp(`(?<![\\w-])branch\\s+${escaped(TOOL_REF)}\\b`).test(text)) problems.push(`agents.txt: the prose does not name the branch ${TOOL_REF}`);
    if (!text.includes(`https://github.com/${ARBITER_REPO}/tree/${ARBITER_DOCS_REF}/code-runner`)) problems.push(`agents.txt: no code-runner link at ${ARBITER_DOCS_REF}`);
  }
  return problems;
}

test('every host they name is an allowed one; GitHub links go to the two public repositories, at their refs', () => {
  const ALLOWED = new Set(['verifiers.verdikta.org', 'github.com', 'www.npmjs.com', 'unpkg.com', 'sepolia.base.org', 'sepolia.basescan.org', 'gateway.pinata.cloud', 'localhost']);
  for (const [name, text] of docs()) {
    for (const m of text.matchAll(/\bhttps?:\/\/([^/\s)<>"'`]+)/g)) {
      const host = m[1].replace(/:\d+$/, '').replace(/[.,;:]+$/, '').toLowerCase();
      assert.ok(ALLOWED.has(host), `${name}: ${host} is not an allowed host`);
    }
    for (const m of text.matchAll(/\b(?:[a-z0-9-]+\.)+(?:org|io|com|net|cloud|dev|app|xyz|sh|ai|co|link|info)\b/gi)) {
      assert.ok(ALLOWED.has(m[0].toLowerCase()), `${name}: ${m[0]} is not an allowed host`);
    }
    assert.deepEqual(refProblems(name, text), [], name);
  }
  assert.doesNotMatch(agents(), /verdikta-common\b/, 'never the private repository of @verdikta/common');
});

test('a document that still names the integration branch, in a link, the clone line or the prose, fails', () => {
  const from = INTEGRATION_BRANCH;
  const cases = [
    ['llms.txt', 'the tool README link', (t) => t.replace(`${APPS_REPO}/blob/${TOOL_REF}/`, `${APPS_REPO}/blob/${from}/`)],
    ['agents.txt', 'the tool README link', (t) => t.replace(`${APPS_REPO}/blob/${TOOL_REF}/`, `${APPS_REPO}/blob/${from}/`)],
    ['agents.txt', 'the contracts link', (t) => t.replace(`${APPS_REPO}/tree/${TOOL_REF}/`, `${APPS_REPO}/tree/${from}/`)],
    ['agents.txt', 'the code-runner link', (t) => t.replace(`${ARBITER_REPO}/tree/${ARBITER_DOCS_REF}/`, `${ARBITER_REPO}/tree/${from}/`)],
    ['agents.txt', 'the clone line', (t) => t.replace(`--branch ${TOOL_REF} `, `--branch ${from} `)],
    ['agents.txt', 'the prose naming the branch', (t) => t.replace(new RegExp(`(?<![\\w-])branch(\\s+)${escaped(TOOL_REF)}\\b`), `branch$1${from}`)],
    ['agents.txt', 'the branch in other prose', (t) => t.replace('It is not on npm.', `It is not on npm. Its source was ${from}.`)],
    ['llms.txt', 'the branch in other prose', (t) => t.replace('in the README of the branch', `in the README of ${from}, the branch`)],
    ['agents.txt', 'the sentence that it moves to main', (t) => t.replace('It is not on npm.', 'It is not on npm. It moves to main once the site\'s build merges there.')],
  ];
  const texts = new Map(docs());
  for (const [name, text] of texts) assert.deepEqual(refProblems(name, text), [], `${name} as it is`);
  for (const [name, where, change] of cases) {
    const text = texts.get(name);
    const changed = change(text);
    assert.notEqual(changed, text, `${name}, ${where}: the change applies to the document`);
    assert.notDeepEqual(refProblems(name, changed), [], `${name}, ${where}: a document naming ${from} there fails`);
  }
});

test('no per-listing value is stated as a fact: no amount, address or hash, and no number the code does not decide', () => {
  const { value } = solidity();
  const chainIds = new Set(/ALLOWED_CHAIN_IDS = Object\.freeze\(\[([^\]]+)\]\)/.exec(toolSrc('context.js'))[1].split(',').map((s) => s.trim().replace(/n$/, '')));
  const siteChain = /^VITE_SA_CHAIN_ID=(\d+)$/m.exec(read('deploy', 'client.env'))[1];
  assert.ok(chainIds.has(siteChain), 'the tool takes the site\'s chain');
  for (const [name, text] of docs()) {
    const stripped = text
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\b\d+\.\d+\.\d+[0-9A-Za-z.+-]*/g, ' ');
    const allowed = new Set([
      siteChain,
      ...statedConstants(text).map((s) => String(value(s.name))),
      // the key file's modes, as the tool states them, and the umask that makes one: the bits cli.js refuses
      ...(ERROR_TEXTS.WALLET_KEY_FILE.match(/\b0[0-7]{3}\b/g) ?? []),
      ...[...toolSrc('cli.js').matchAll(/st\.mode & 0o(0[0-7]{2})\)/g)].map((m) => m[1]),
      // the claim folder's and its files' modes, as tool/src/workspace.js sets them
      ...[...toolSrc('workspace.js').matchAll(/\b0o([0-7]{3})\b/g)].map((m) => `0${m[1]}`),
    ]);
    for (const m of stripped.matchAll(/(?<!\w|\d\.)\d{3,}(?!\w|\.\d)/g)) assert.ok(allowed.has(m[0]), `${name}: ${m[0]} is a number nothing here checks (a listing's value?)`);
    assert.doesNotMatch(stripped, /\b\d+(?:\.\d+)?\s*(?:ETH|wei|gwei)\b/i, `${name}: an amount`);
    assert.doesNotMatch(text, /0x[0-9a-fA-F]{8,}/, `${name}: an address or a hash`);
    for (const m of text.matchAll(/\b(\d+)\b/g)) {
      if (m[1] === siteChain) assert.match(text.slice(Math.max(0, m.index - 20), m.index), /chain id\s*$/, `${name}: ${siteChain} only as the chain id`);
    }
  }
});

test('the wording rules: no banned word, no judgemental phrase, nothing that says the measurement bar was met', () => {
  for (const [name, text] of docs()) {
    assert.deepEqual(wordingProblems(text), [], name);
    assert.doesNotMatch(text, /phase 1|calibrat|accura|precision|recall/i, name);
  }
});

// ------------------------------------------------------------------------------------------------ node P35

/** The names agents.txt lists, four spaces in, under the line that starts with `heading`, up to the next "- GET". */
function listedFields(heading) {
  const text = agents();
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `agents.txt has "${heading}"`);
  const rest = text.slice(start + heading.length);
  return [...rest.slice(0, rest.search(/\n- GET /)).matchAll(/^ {4}([a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)?) {2,}\S/gm)].map((m) => m[1]);
}

/** Whether a field name is a key the server's code writes into an answer: `name:` or a shorthand `name,` / `name }`. */
const serverWrites = (name) => {
  const sources = ['feed.js', 'index.js', 'archives.js', 'sameRepository.js']
    .map((f) => path.join(APP, 'server', 'src', 'site', f))
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p, 'utf8'))
    .join('\n');
  return new RegExp(`[{,\\s]${name}(?::|\\s*[,}])`).test(sources);
};

test('node P35: the disclosure key\'s two encodings are one key, as the site, the tool and agents.txt say it, word for word', async () => {
  const { DISCLOSURE_KEY_NOTE } = await import('@verdikta/stake-attestation-shared/disclosure-key');
  const flat = agents().replace(/\s+/g, ' ');
  assert.ok(flat.includes(DISCLOSURE_KEY_NOTE), `agents.txt says it: ${DISCLOSURE_KEY_NOTE}`);
  const fields = listedFields('Each entry of `listings`:');
  assert.equal(fields[fields.indexOf('disclosureKey') + 1], 'disclosureRecipient', 'the new field beside the old one');
  assert.match(flat, /`stake\.disclosureKey`[^.]*age recipient[^.]*base64/, 'the archive names it as an age recipient or in base64, as common takes it');
  // the tool's notice and the site's pages say it with the same constant
  assert.match(toolSrc('notices.js'), /DISCLOSURE_KEY_NOTE/);
  assert.match(fs.readFileSync(path.join(CLIENT, 'src', 'strings.js'), 'utf8'), /DISCLOSURE_KEY_NOTE/);
});

test('node P35: every field agents.txt lists for a feed entry or a record is one the server writes, the related listings among them', () => {
  const entry = listedFields('Each entry of `listings`:');
  const record = listedFields('- GET https://verifiers.verdikta.org/api/records/<artifactHash>');
  for (const name of ['disclosureRecipient', 'sameRepository']) assert.ok(entry.includes(name), `a feed entry's ${name}`);
  assert.ok(record.includes('sameRepository'), 'a record\'s sameRepository');
  for (const name of [...entry, ...record.map((n) => n.split('.')[0])]) assert.ok(serverWrites(name), `${name} is a field server/src/site writes`);
  // what each related listing holds, as agents.txt names it, is what the server's helper writes
  const flat = agents().replace(/\s+/g, ' ');
  const m = /`sameRepository` names (?:them|the others), each with its ([^.]+)\./.exec(flat);
  assert.ok(m, 'agents.txt says what each related listing holds');
  const named = m[1].replace(/\([^)]*\)/g, '').split(/,| and /).map((x) => x.trim()).filter(Boolean);
  assert.deepEqual(named, ['listingId', 'artifactHash', 'artifact', 'state', 'lapsed', 'counted', 'page']);
  for (const name of named) assert.ok(serverWrites(name), `${name} is a field of a related listing`);
  assert.match(flat, /artifact\.repo` exactly as/);
  // R1-F1: the record is the version's, which listings of one artifactHash share; the contract's artifactHashOf hashes
  // the kind, the repository, the commit, the chain and the address
  const para = /Listings of one repository\.[^]*?not another's\./.exec(flat)?.[0];
  assert.ok(para, 'agents.txt says how listings of one repository relate');
  assert.match(para, /The record is the version's: listings with the same artifactHash share it, which is the same kind, repository and commit and, for a deployed contract, the same chain and address\./);
  assert.doesNotMatch(para, /own [^.]*record\b|one commit share/);
  const hashOf = /function artifactHashOf\([^)]*\)[^{]*\{([\s\S]*?)\n {4}\}/.exec(read('onchain', 'contracts', 'StakeAttestation.sol'));
  assert.ok(hashOf, 'StakeAttestation.sol: artifactHashOf');
  for (const field of ['kind', 'repo', 'baseCommit', 'chainId', 'addr']) assert.match(hashOf[1], new RegExp(`\\.${field}\\b`), `artifactHashOf hashes ${field}`);
  assert.match(flat, /#\/fund\/<listingId>/);
});

/** The numbered list under "What the jurors read.", each item with its continuation lines. */
function packItems() {
  const text = agents();
  const start = text.indexOf('\nWhat the jurors read.');
  assert.ok(start >= 0, 'agents.txt says what the jurors read');
  const para = text.slice(start, text.indexOf('\n\n', start + 1));
  const items = [];
  for (const line of lines(para)) {
    const m = /^ {2}(\d)\. (.+)$/.exec(line);
    if (m) items.push(m[2]);
    else if (items.length && /^ {5}\S/.test(line) && !/^ {2}\d\. /.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return { para, flat: para.replace(/\s+/g, ' '), items };
}

// What the jury reads is common's (CONTEXT_PACK_TIERS, selectDocuments; docs/CODE_REVIEW_SPECIFICATION.md, "Stake
// documents"): agents.txt names each tier in common's order, and nothing of the repository besides.
test('node P35: what the jurors read is @verdikta/common\'s context pack, every tier in its order, and nothing else of the repository', () => {
  const { para, flat, items } = packItems();
  const PHRASES = {
    poc: /^poc\.patch\b/,
    claim: /^finding\.json and report\.md\b/,
    source: /^the source files your `affectedPaths` name that are in the listing's `scope`, whole, comments and all\b/,
    documents: /^the files the listing's `documents` match at `baseCommit` \(none, and no such part, when it names none\)/,
    callSites: /call what your PoC calls\b/,
    knownIssues: /^the listing's known issues\b/,
    priorFindings: /earlier valid findings\b/,
    fix: /^fix\.patch\b/,
    tree: /file names\b/,
  };
  const tiers = codeReview.CONTEXT_PACK_TIERS;
  assert.deepEqual(Object.keys(PHRASES).sort(), [...tiers].sort(), 'a line for each of common\'s tiers, and none for another');
  assert.equal(items.length, tiers.length, items.join(' | '));
  tiers.forEach((tier, i) => assert.match(items[i], PHRASES[tier], `item ${i + 1} is common's tier ${tier}`));
  // the documents tier is the listing's stake.documents, as common picks them: none when it names none
  const stake = { scope: { include: ['src/**'] } };
  const tree = ['README.md', 'docs/spec.md', 'src/Vault.sol', 'test/Vault.t.sol'];
  assert.deepEqual(codeReview.selectDocuments(tree, stake, ['src/Vault.sol']).paths, []);
  assert.deepEqual(codeReview.selectDocuments(tree, { ...stake, documents: [] }, ['src/Vault.sol']).paths, []);
  assert.deepEqual(codeReview.selectDocuments(tree, { ...stake, documents: ['docs/**', 'README.md'] }, ['src/Vault.sol']).paths, ['docs/spec.md', 'README.md']);
  // the key sentence, and what a hunter does with it
  assert.match(flat, /^ What the jurors read\. For the requirement, they read the listing's `documents` and the in-scope source files your finding names, comments included, and of the rest of the repository only call-site lines and file names\./);
  assert.match(flat, /Of the rest of the repository they see only those call-site lines and the file names: no other source file, test or document\./);
  assert.match(flat, /`## Requirement`/);
  assert.match(flat, /`check` prints the pack for your claim/);
  assert.match(flat, /primary_query\.json/);
  assert.doesNotMatch(para, /\bnatspec\b/i, 'the pack has no tier of its own for any one kind of comment');
});
