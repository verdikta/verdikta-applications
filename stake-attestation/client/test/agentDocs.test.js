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

// node P33 (issue #205): an agent whose claim the keeper settled had to read the contract's events to learn who settled
// it and what it paid. Step 8 says what `claim` and `status` report of a settle, and it is what tool/src reports.
test('node P33: step 8 says what claim and status report of a settle: the event\'s outcome and amounts, its transaction, block and sender', () => {
  const step8 = /\n8\. Settle and withdraw:([\s\S]*?)\n\n## 4\./.exec(agents())?.[1]?.replace(/\s+/g, ' ');
  assert.ok(step8, 'agents.txt §3 has its step 8');
  const settlement = toolSrc('settlement.js');
  // who sent it: settlement.by's values and the words the tool prints for each, in the tool's order
  const block = /export const SETTLED_BY = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(settlement);
  assert.ok(block, 'tool/src/settlement.js holds SETTLED_BY');
  const by = [...block[1].matchAll(/^\s+(\w+): '((?:[^'\\]|\\.)*)',?$/gm)].map((m) => ({ key: m[1], words: m[2].replace(/\\'/g, '\'') }));
  assert.deepEqual(by.map((b) => b.key), ['thisRun', 'hunter', 'other']);
  const [run, hunter, other] = by.map((b) => b.words);
  assert.ok(step8.includes(`who sent it: ${run}, ${hunter} in an earlier run, or ${other}`), `step 8 names the senders as the tool does: ${run}; ${hunter}; ${other}`);
  assert.match(settlement, /, in an earlier run/, 'the tool says the hunter\'s own address sent it in an earlier run');
  assert.ok(step8.includes(`\`settlement\`, whose \`by\` is \`${by[0].key}\`, \`${by[1].key}\` or \`${by[2].key}\``), 'the --json field and its values');
  // the event's amounts, in ETH: read from the event, never from the claim's record
  assert.match(step8, /from the settle's Settled event: its outcome, what it paid and what it left owed, in ETH, the settle transaction and its block, and who sent it/);
  assert.match(settlement, /parseLog\(/);
  assert.match(settlement, /formatEther\(/);
  // its own settle from its receipt; any other only in the blocks of the claim's settledAt, in capped ranges
  assert.match(toolSrc('claim.js'), /settlementFromReceipt\(/);
  assert.match(step8, /A settle `claim` sends is read from its own receipt\./);
  const getClaim = ABI.find((f) => f.name === 'getClaim');
  assert.ok(getClaim.outputs[0].components.some((c) => c.name === 'settledAt'), 'getClaim returns settledAt');
  assert.match(settlement, /\.settledAt\b/);
  assert.match(step8, /only in the blocks whose time is `getClaim\(claimId\)`'s `settledAt`, in ranges a public RPC's `eth_getLogs` limit takes/);
  // not found: said, and no sender named
  assert.match(settlement, /'notInBlocks'/);
  assert.match(settlement, /'unread'/);
  assert.match(step8, /when it is not found there, or the RPC does not answer, they say so and name no sender/);
  // both verbs print it, and --json carries it
  assert.match(toolSrc('status.js'), /out\.settlement = /);
  assert.match(/function printStatus[\s\S]*?\n\}/.exec(toolSrc('cli.js'))[0], /settlementLines\(s\.settlement\)/);
  // a withdrawal: its transaction and its amount
  assert.match(toolSrc('cli.js'), /Sent withdraw: \$\{s\.tx\}, \$\{eth\(s\.amountWei\)\}/);
  assert.match(step8, /`verdikta-attest claim` withdraws it and prints the transaction and the amount/);
});


// tools/src/commit.js asks for --yes only before a commit is signed; a resumed one goes on without it (R1-F1).
test('what they say commit does without --yes is what commit.js does', () => {
  const commit = toolSrc('commit.js');
  const asksOnlyFirst = /if \(!state \|\| state\.stage === 'prepared'\) \{\s*const \{ listing, inputs, price \} = await readyToCommit\(/.test(commit);
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
  // The last three are other people's pages, which nothing here can read: where test ETH comes from (Base's "Get funds",
  // which lists the faucets and the bridges) and where a pinning token is made. Each answered when it was added
  // (2026-11-22, after tester bounty 400); a page that moves is a broken link, never a wrong amount or address.
  const ALLOWED = new Set(['verifiers.verdikta.org', 'github.com', 'www.npmjs.com', 'unpkg.com', 'sepolia.base.org', 'sepolia.basescan.org', 'gateway.pinata.cloud', 'localhost', 'docs.base.org', 'app.pinata.cloud', 'console.filebase.com']);
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
      // the memory a run's sandbox asks for: the class's hard limit, which no listing and no setting changes
      String(codeReview.CLASS_HARD_LIMITS.memoryMb),
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

// ------------------------------------------------------------------------------------- tester bounty 400

// An outside agent walked the site with this document (bounty 400 on Verdikta Bounties, 2026-11-21) and lost hours
// where it was silent: what `check` needs from the machine, which platforms the tool runs on, where test ETH comes
// from, and that claims on a listing reveal in commit order. Each statement added for it is held to the code here.
const section = (n) => {
  const text = agents();
  const start = text.indexOf(`\n## ${n}. `);
  assert.ok(start >= 0, `agents.txt has a section ${n}`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
};

test('bounty 400: claims reveal in commit order, and the document says how to see the queue, as the contract, the tool and the feed have it', () => {
  const flat = agents().replace(/\s+/g, ' ');
  // the contract: a reveal needs the claim at the head of the listing's queue, and the lens gives no deadline before
  const logic = read('onchain', 'contracts', 'libraries', 'ClaimLogic.sol');
  assert.match(logic, /require\(l\.headClaim == claimId, "earlier claim unresolved"\);/);
  const lens = /function claimTimes\([\s\S]*?\n {4}\}/.exec(read('onchain', 'contracts', 'StakeAttestationLens.sol'))[0];
  assert.match(lens, /if \(l\.headClaim == claimId\) \{\s*revealDeadline = /, 'claimTimes gives a reveal deadline only to the head claim');
  assert.match(flat, /While an earlier claim on the listing is open, yours has no reveal deadline yet: `claimTimes\(claimId\)` gives 0 for it/);
  assert.match(flat, /A release by the maker ends your fix window, not that wait\./);
  // the tool: status names the claim, reveal refuses with OUT_OF_ORDER, and commit's terms say how many are open
  assert.match(toolSrc('reveal.js'), /headClaim\) !== String\(state\.claimId\)\) throw fail\('OUT_OF_ORDER'/);
  assert.match(flat, /`status` names the claim yours waits for, and until it is settled or expired `reveal` refuses with OUT_OF_ORDER and pins nothing/);
  const status = toolSrc('status.js');
  for (const key of ['waitsFor', 'disclosed', 'discloseDeadline', 'revealableAt', 'revealDeadline']) {
    assert.match(status, new RegExp(`\\b${key}\\b[:,]`), `status.js writes ${key}`);
    assert.ok(flat.includes(`\`${key}\``), `agents.txt names status --json's ${key}`);
  }
  assert.match(status, /headClaim !== 0n && headClaim !== BigInt\(claimId\)\) waitsFor = headClaim/);
  assert.match(toolSrc('notices.js'), /Open claims on this listing now: \$\{open\}, the earliest claim \$\{t\.headClaim\}/);
  assert.match(toolSrc('listing.js'), /pendingClaims: l\.pendingClaims,\s*headClaim: l\.headClaim,/);
  assert.match(flat, /The first run of `verdikta-attest commit`, which sends nothing \(section 4\), says how many are open and which is the earliest, before you pay\./);
  // the feed: claimsSoFar is every claim ever committed, and the events route names what opens and what closes one
  const feed = read('server', 'src', 'site', 'feed.js');
  assert.match(feed, /claimsSoFar: Number\(onchain\.claimsCommitted\)/);
  assert.match(flat, /`claimsSoFar` counts every claim ever committed there, open or not\./);
  // and, since batch 2, the queue itself: the contract's count of open claims and the earliest of them, null for none.
  // A feed entry is an Open listing, and a late claim is taken on a Rolled or Closed one or, since the maker's hold
  // (node P39), on one its maker has held. So on an entry that is not held every claim in the queue is one of
  // pendingClaims: each is ahead of a claim committed now. A held listing stays Open and takes no commit; until the
  // feed leaves it out (node P40) an entry can be one, with late claims in its queue that pendingClaims does not count.
  assert.match(feed, /pendingClaims: Number\(onchain\.pendingClaims\),\s*headClaim: onchain\.headClaim === '0' \? null : onchain\.headClaim,/);
  assert.match(feed, /if \(onchain\.state !== 'Open' \|\| lapsed \|\|/, 'only an Open listing is an entry');
  const commitBody = /function commit\([\s\S]*?\n {4}\}/.exec(logic)[0];
  assert.match(commitBody, /s == StakeAttestation\.ListingState\.Rolled\s*\|\| \(s == StakeAttestation\.ListingState\.Closed && l\.openedAt != 0\)\s*\|\| listingHeld,\s*"not accepting late claims"/, 'a late claim needs a listing that is Rolled, Closed after it opened, or held');
  // held is the contract's own record of a hold (_heldAt, read through heldAt): lateClaim hands it to commit, only
  // the maker's hold sets it, on an Open or a Depleted listing, and a listing where it is set takes no commit
  assert.match(read('onchain', 'contracts', 'StakeAttestation.sol'), /msg\.value, true, _heldAt\[listingId\] != 0\s*\);/, 'lateClaim reads the hold');
  const holdBody = /function hold\([\s\S]*?\n {4}\}/.exec(logic)[0];
  assert.match(holdBody, /require\(msg\.sender == l\.maker, "not maker"\);/);
  assert.match(holdBody, /require\(s == StakeAttestation\.ListingState\.Open \|\| s == StakeAttestation\.ListingState\.Depleted, "not rollable"\);/);
  assert.match(holdBody, /require\(heldAt\[listingId\] == 0, "already held"\);\s*heldAt\[listingId\] = uint64\(block\.timestamp\);/);
  assert.match(read('onchain', 'contracts', 'StakeAttestation.sol'), /&& l\.escrowWei >= l\.awards\[3\]\s*&& _heldAt\[listingId\] == 0;/, 'acceptsCommits is false on a held listing');
  assert.match(read('onchain', 'contracts', 'StakeAttestation.sol'), /uint256 pendingClaims; +\/\/ claims neither settled nor expired \(P2b\); never a late claim \(P2e\)/);
  assert.match(read('onchain', 'contracts', 'StakeAttestation.sol'), /uint64 +headClaim; +\/\/ the earliest claim neither settled nor expired \(0 = none\)/);
  assert.match(flat, /`pendingClaims` is how many claims are open there now, every one of them ahead of a claim you commit, and `headClaim` is the first of them: 0 and null on a listing where yours would be first\./);
  const table = listedFields('Each entry of `listings`:');
  assert.deepEqual(table.slice(table.indexOf('claimsSoFar'), table.indexOf('claimsSoFar') + 3), ['claimsSoFar', 'pendingClaims', 'headClaim'], 'the feed table lists both beside claimsSoFar');
  assert.match(flat, /pendingClaims claims on it that are open now: neither settled nor expired headClaim the earliest of those, by its claim id, a string of digits; null when none is open/);
  // and no listing comes back to Open from Rolled or Closed: the two places that set Open start from Listed (the
  // opening fund) and from Depleted (a top-up), so an entry that is not held never holds a late claim from an earlier
  // life. A Depleted listing can be held, take late claims and be topped up to Open: it is held still, for the hold
  // is written in one place and nothing clears it
  const host = read('onchain', 'contracts', 'StakeAttestation.sol');
  assert.equal(`${host}\n${logic}`.split('heldAt[listingId] = ').length - 1, 1, 'the hold is set in one place only');
  assert.doesNotMatch(`${host}\n${logic}`, /delete _?heldAt|heldAt\[[^\]]*\] = 0\b/, 'and never cleared');
  const opens = [...`${host}\n${logic}`.matchAll(/l\.state = (?:StakeAttestation\.)?ListingState\.Open;/g)];
  assert.equal(opens.length, 2, 'a listing becomes Open in two places only');
  assert.match(host, /if \(s == ListingState\.Listed\) \{[\s\S]{0,600}?l\.state = ListingState\.Open;/);
  assert.match(logic, /if \(l\.state == StakeAttestation\.ListingState\.Depleted && escrow >= l\.awards\[3\] && l\.owedWei == 0\) \{\s*l\.state = StakeAttestation\.ListingState\.Open;/);
  const events = new Set(JSON.parse(read('tool', 'src', 'abi', 'StakeAttestation.json')).filter((x) => x.type === 'event').map((x) => x.name));
  const named = /a claim of the listing with a (\w+) event and neither a (\w+) nor an (\w+) one is open/.exec(flat);
  assert.ok(named, 'agents.txt says which events make a claim open');
  assert.deepEqual(named.slice(1), ['Committed', 'Settled', 'Expired']);
  for (const e of named.slice(1)) assert.ok(events.has(e), `${e} is an event of the contract`);
  // the events come a page at a time, from a cursor the answer gives: an agent that counts open claims reads them all
  assert.match(read('server', 'src', 'app.js'), /const after = typeof req\.query\.after === 'string' \? req\.query\.after : null;/);
  assert.match(read('server', 'src', 'site', 'index.js'), /events: page, next: last \? `\$\{last\.blockNumber\}:\$\{last\.logIndex\}` : after/);
  assert.match(flat, /a page at a time: ask again with `\?after=` and the page's `next`, until a page holds no events/);
  // a claim leaves the queue exactly when it is settled or expired: resolve() is the one place that unlinks a claim
  // and lowers pendingClaims, and its only two callers are settle and expire, each of which emits its own event
  const resolveBody = /function resolve\([\s\S]*?\n {4}\}/.exec(logic)[0];
  assert.match(resolveBody, /if \(!c\.late\) l\.pendingClaims -= 1;/);
  assert.equal(logic.split('l.pendingClaims -= 1').length - 1, 1, 'pendingClaims goes down in one place only');
  const callers = [];
  for (const m of logic.matchAll(/\n {4}function (\w+)\([\s\S]*?\n {4}\}/g)) if (/\bresolve\(claims, c, l\);/.test(m[0])) callers.push([m[1], m[0]]);
  assert.deepEqual(callers.map(([name]) => name).sort(), ['expire', 'settle'], 'only settle and expire take a claim out of the queue');
  const byName = new Map(callers);
  assert.match(byName.get('settle'), /emit StakeAttestation\.Settled\(claimId,/);
  assert.match(byName.get('expire'), /emit StakeAttestation\.Expired\(claimId,/);
  // an abandoned claim ahead: anyone may expire it, the keeper only where that is turned on, and the tool has no verb
  assert.match(flat, /A claim ahead of yours that its hunter abandons leaves the queue only when someone calls `expire\(claimId\)` on it, once its own deadline has passed \(steps 3, 5 and 6\): anyone may, the site's keeper does not unless its operator has turned that on, and `verdikta-attest` has no command for it\./);
  assert.match(read('server', 'src', 'config.js'), /expire: onOff\(env, 'SA_KEEPER_EXPIRE', false\),/, 'the keeper expires claims only when set to');
  assert.ok(!commands().includes('expire'), 'the tool has no expire command');
  assert.match(toolSrc('status.js'), /If that claim is abandoned, it leaves the queue only when someone calls expire on it after its own deadline: anyone may, and this tool has no command for it\./);
  // --json writes every bigint as a string of digits, so a deadline not yet set is "0", which is not falsy
  assert.match(toolSrc('cli.js'), /const replacer = \(_k, v\) => \(typeof v === 'bigint' \? v\.toString\(\) : v\);/);
  assert.match(flat, /each id and time as a string of digits:[^.]*`revealDeadline` is "0" until the chain sets it\./);
});

test('bounty 400: what check needs from the machine is the class\'s memory limit, and a refusal or an empty folder is no forecast', () => {
  const memoryMb = codeReview.CLASS_HARD_LIMITS.memoryMb;
  const text = agents();
  const stated = [...text.matchAll(/\b(\d+) MiB\b/g)].map((m) => Number(m[1]));
  assert.ok(stated.length >= 2, 'the prerequisites and section 8 both state it');
  for (const n of stated) assert.equal(n, memoryMb, `${n} MiB: the class's limit is ${memoryMb}`);
  const s8 = section(8);
  assert.ok(s8.includes(`A run's sandbox may use up to ${memoryMb} MiB of memory, the class's limit, which no setting lowers`));
  assert.match(section(1), new RegExp(`with ${memoryMb} MiB of memory free for a run beyond what the runner holds back, and twice that for a claim with a fix\\.patch \\(section 8\\)`));
  // the tool says the same when the runner admits no run, in fixed words, and calls it no forecast
  const notices = toolSrc('notices.js');
  assert.match(notices, /export const ADMISSION_HINT = 'When the runner refuses for memory, as its detail says: [^\n]*no setting lowers, twice over for a claim with a fix\.patch/);
  assert.match(toolSrc('forecast.js'), /hint: a\.cause === 'admission_refused' \? ADMISSION_HINT : null/);
  assert.match(notices, /export const ABSTAIN_BY_HOST = `No forecast: this machine's runner could not finish the run, which says nothing of your claim\./);
  assert.match(s8, /A run it does not admit ends `ABSTAIN: admission_refused`, with the figures: that is no forecast, and it says nothing of your claim\./);
  // The runner is another repository's (verdikta-arbiter, code-runner), and nothing here can read it: what section 8
  // says of it was read against its main (79d7f51: src/admission.js, health.js, claim.js) and is held to these words,
  // so that a change of them is a decision. Its /health reports what it measured and never does the sum; a claim with
  // a fix.patch opens two sandboxes (sandboxesFor); without a memory reading under runc it admits the run unchecked.
  assert.match(s8, /a claim with a fix\.patch runs two sandboxes at once, so it needs twice that\./);
  // the reserve's settings are in the runner's README, in its "Configuration" table (there on arbiter main)
  assert.match(s8, /that reserve can be lowered in the runner's settings \(its README, "Configuration"\)\./);
  assert.match(toolSrc('check.js'), /fixPatch: fixPatch \? fixPatch\.toString\('base64'\) : null,/, 'check sends the fix.patch the folder holds');
  assert.match(s8, /`GET \/health` on the runner, with its token, says what it measured, the free memory and its reserve, and not whether your run would fit: do that sum yourself\./);
  assert.match(s8, /Where the runner cannot measure memory, as on macOS, it admits a run unchecked/);
  // a folder with none of a claim's files: an error of its own, before anything is read or sent
  assert.match(toolSrc('check.js'), /if \(!inputs\.finding && !inputs\.report && !inputs\.pocPatch\) throw fail\('NO_CLAIM_FILES'\);/);
  assert.match(ERROR_TEXTS.NO_CLAIM_FILES, /no forecast/);
  assert.match(s8, /`check` prints the folder it read first\. A folder that holds none of a claim's files is refused with NO_CLAIM_FILES: that is no forecast either/);
  assert.match(toolSrc('cli.js'), /if \(claimDir\) out\(`Claim folder: \$\{claimDir\}`\);/);
});

test('bounty 400: the platforms, the key file and the name: Windows drives are refused by the mode check, and verdikta-attest is a name the package gives', () => {
  const flat = agents().replace(/\s+/g, ' ');
  const text5 = agents().slice(agents().indexOf('\n## 5. '), agents().indexOf('\n## 6. '));
  // where test ETH comes from: Base's page lists faucets for Base Sepolia, and no bridge for it, so none is promised
  assert.match(section(1), /Take it from a Base Sepolia faucet: https:\/\/docs\.base\.org\/get-started\/get-funds lists them\./);
  assert.doesNotMatch(section(1), /lists both/);
  assert.match(section(1), /Linux, macOS, or WSL2 with everything on a Linux path\. The tool does not run on native Windows, nor from a Windows drive mounted in WSL/);
  // the check that refuses: POSIX mode bits, which a Windows drive cannot give; the errors say so
  assert.match(toolSrc('cli.js'), /\(st\.mode & 0o077\) !== 0\) throw fail\('WALLET_KEY_FILE'\)/);
  for (const code of ['WALLET_KEY_FILE', 'FILE_NOT_PRIVATE']) assert.match(ERROR_TEXTS[code], /Windows drive[^.]*\bWSL\b[^.]*: keep [^.]* on a Linux or macOS path\./, code);
  assert.match(section(7), /A Windows drive gives no file that mode, so the tool refuses a key file there \(WALLET_KEY_FILE\)/);
  assert.match(section(9), /Keep the folder and its copies on a Linux or macOS path/);
  // the name: a link beside the package's own bin file, which is executable, or `npm link`, which installs that bin. Not
  // a shell function: POSIX sh refuses a hyphen in a function's name, and many harnesses run commands through sh -c
  assert.deepEqual(pkg('tool').bin, { 'verdikta-attest': 'bin/verdikta-attest.js' });
  assert.match(read('tool', 'bin', 'verdikta-attest.js'), /^#!\/usr\/bin\/env node\n/, 'the bin file runs by its own name');
  assert.ok((fs.statSync(path.join(APP, 'tool', 'bin', 'verdikta-attest.js')).mode & 0o111) !== 0, 'and is executable');
  assert.ok(text5.includes('    ln -sf verdikta-attest.js bin/verdikta-attest && export PATH="$PWD/bin:$PATH"\n'), 'the line that gives the name');
  assert.doesNotMatch(agents(), /^\s*verdikta-attest\(\)/m, 'no shell function of that name: sh refuses it');
  assert.match(flat, /`npm link` in the tool folder, once, puts the name on your PATH for every shell/);
  assert.match(flat, /The PATH change lasts for that shell only, as every export below does/);
  // the contract's address, as a line that runs: /api/status answers `contract`
  assert.match(read('server', 'src', 'site', 'index.js'), /\bcontract: chain\.address,/);
  assert.ok(text5.includes('    export VERDIKTA_CONTRACT="$(curl -fsS https://verifiers.verdikta.org/api/status | jq -r .contract)"\n'), 'the contract line');
  assert.doesNotMatch(section(5), /VERDIKTA_CONTRACT=</, 'no placeholder where a command goes');
});

test('bounty 400: tamper flags and integrity checks are common\'s, each kind said once; the feed\'s labels are the server\'s', () => {
  const s1 = section(1);
  const FLAGS = {
    'report-path-referenced': /names the report's path/,
    'exit-during-import': /exits while the tests load/,
    'exit-handler-registered': /registers an exit handler/,
    'framework-patched': /patches the test framework/,
    'reporter-patched': /or its reporter/,
    'write-outside-repository': /writes outside the repository/,
  };
  assert.deepEqual(Object.keys(FLAGS).sort(), [...codeReview.TAMPER_FLAG_KINDS].sort(), 'a phrase for each of common\'s tamper flag kinds, and none for another');
  const flags = /A tamper flag is[^.]*\./.exec(s1)?.[0];
  assert.ok(flags, 'section 1 says what a tamper flag is');
  for (const [kind, phrase] of Object.entries(FLAGS)) assert.match(flags, phrase, kind);
  const CHECKS = {
    identityComplete: /every test ran once under its own name/,
    summaryConsistent: /the summary/,
    exitConsistent: /the exit status agree with the results/,
    protectedPathsUnchanged: /the protected paths/,
    frameworkUnchanged: /the framework/,
    dependenciesUnchanged: /the dependencies are unchanged/,
  };
  assert.deepEqual(Object.keys(CHECKS).sort(), [...codeReview.INTEGRITY_CHECKS].sort(), 'a phrase for each of common\'s integrity checks');
  const checks = /The integrity checks are[^.]*\./.exec(s1)?.[0];
  assert.ok(checks, 'section 1 says what the integrity checks are');
  for (const [name, phrase] of Object.entries(CHECKS)) assert.match(checks, phrase, name);
  // the feed: what `listings` holds, and the labels the server computes
  const feed = read('server', 'src', 'site', 'feed.js');
  assert.match(feed, /if \(onchain\.state !== 'Open' \|\| lapsed \|\| BigInt\(onchain\.escrowWei\) < BigInt\(onchain\.awards\[3\]\)\) continue;/);
  assert.match(section(2), /every listing that takes claims now: open, its paid period not ended, its escrow at least its CRITICAL award/);
  const labels = read('server', 'src', 'record', 'labels.js');
  for (const key of ['stake', 'invited', 'lapsed', 'live']) {
    assert.match(labels, new RegExp(`\\n {4}${key}[:,]`), `listingLabels returns ${key}`);
    assert.ok(section(2).includes(`\`${key}\``), `agents.txt names labels.${key}`);
  }
  const stakeLabels = quoted(/export const STAKE_LABELS = Object\.freeze\(\[([^\]]+)\]/.exec(labels)[1]);
  assert.ok(section(2).includes(`\`stake\` (${stakeLabels.slice(0, -1).join(', ')} or ${stakeLabels.at(-1)},`), `the stake labels: ${stakeLabels.join(', ')}`);
  assert.match(labels, /live: listing\.state === 'Open' && !listing\.lapsed && heldAt === null,/);
});

test('bounty 400: what a commit carries, who pays a confirmation, a dry run\'s needs, and an appeal round with no verdict, as the code has them', () => {
  const s3 = section(3);
  const s4 = section(4);
  // a confirmation's fee is the listing's escrow's (ClaimLogic.confirm), never the hunter's
  const confirm = /function confirm\([\s\S]*?\n {4}\}/.exec(read('onchain', 'contracts', 'libraries', 'ClaimLogic.sol'))[0];
  assert.match(confirm, /uint256 escrow = l\.escrowWei;\s*require\(escrow >= fee, "escrow below fee"\);\s*escrow -= fee;/);
  assert.match(s3, /The confirmation's fee comes out of the listing's escrow, not out of your wallet; if that leaves the escrow below your award, the rest is owed to you \(section 1\)\./);
  // and an award is paid from what the escrow then holds, the rest owed (ClaimLogic.settle)
  assert.match(read('onchain', 'contracts', 'libraries', 'ClaimLogic.sol'), /paid = award < escrow \? award : escrow;\s*owed = award - paid;/);
  // an appeal round with no verdict: one re-trigger, and if that returns none too the INVALID stands (the tool's notice)
  assert.match(toolSrc('notices.js'), /If this round settles no verdict too, the INVALID stands/);
  assert.match(s3, /An appeal round with no verdict is not the panel's verdict, and may be re-triggered once: run `appeal` again\. If that round returns none either, the INVALID stands\./);
  // commitPrice is the value the commit carries: commit.js sends exactly it
  assert.match(toolSrc('commit.js'), /estimate = await ctx\.estimate\(\{ data, value: price \}\);/);
  assert.match(s4, /It is the whole amount the commit carries, not a fee on top of the bond\./);
  // a dry run: the pin target is asked for before anything starts, and the claim's files are read before the terms
  const cli = toolSrc('cli.js');
  assert.match(/case 'commit': \{[\s\S]*?\n {4}\}/.exec(cli)[0], /needsIpfs\(\);\s*const hunter = createHunter/);
  const ready = /async function readyToCommit[\s\S]*?\n\}/.exec(toolSrc('commit.js'))[0];
  assert.ok(ready.indexOf('readClaimInputs(') < ready.indexOf('ctx.notice(commitNotice('), 'the files are read before the terms are said');
  assert.match(s4, /A `commit` dry run reads the claim folder's files before it prints the terms, so it needs them written\./);
  // fix.patch and fixIncluded, as common's specification has them
  const spec = fs.readFileSync(path.join(COMMON, 'docs', 'CODE_REVIEW_SPECIFICATION.md'), 'utf8');
  assert.match(spec, /`fixIncluded` \| True when `fix\.patch` is present\. The fix is checked and reported but never changes the outcome/);
  assert.match(section(6), /`fixIncluded` says the claim carries one: set it to true only with it\./);
  // the observable: with no quote the whole recorded message must be there (the tool's own words for it)
  assert.match(toolSrc('observable.js'), /Without a quote, the whole recorded message must appear in the observable as written\./);
  assert.match(section(6), /a quoted fragment that is not in the recorded failure on every run fails `claimedObservable`, and so does an observable with no quote at all unless the whole recorded message appears in it as written\. The claim then settles INVALID\./);
});

// ------------------------------------------------------------------------------------------------ node P43

// A late claim (design §13.2, decision D6; issue #230): a finding on a listing that takes no commit any more, filed
// with `verdikta-attest commit --late`. Wrong here costs a bond for nothing, so each statement of agents.txt on it is
// held to the contract's source and to the tool's: when a listing takes one, what it costs, what it pays, the command.
test('node P43: a late claim is what the contract and the tool make of it: when a listing takes one, what it costs, what it pays, and the command', () => {
  const text = agents();
  const raw = /\nLate claims\. [\s\S]*?(?=\n\n## 4\. )/.exec(text)?.[0];
  assert.ok(raw, 'agents.txt section 3 says what a late claim is, after step 8');
  const block = raw.replace(/\s+/g, ' ');
  const logic = read('onchain', 'contracts', 'libraries', 'ClaimLogic.sol');
  const host = read('onchain', 'contracts', 'StakeAttestation.sol');
  const lens = read('onchain', 'contracts', 'StakeAttestationLens.sol');
  const commit = toolSrc('commit.js');
  const cli = toolSrc('cli.js');
  const notices = toolSrc('notices.js');

  // the call: lateClaim, with a commit's arguments (the ABI test holds the names), sent by the tool in commit's place
  assert.ok(block.includes('`lateClaim(listingId, archiveHash, ciphertextSha256)` in place of `commit`'));
  assert.match(commit, /const data = ctx\.encode\(late \? 'lateClaim' : 'commit', \[listingId, state\.archiveSha256, state\.ciphertextSha256\]\);/, 'the tool sends lateClaim or commit, with the same two hashes');
  assert.match(commit, /estimate = await ctx\.estimate\(\{ data, value: price \}\);/, 'and the price it read, either way');

  // when a listing takes one: the lens's acceptsLateClaims, which is ClaimLogic.commit's own rule (the bounty 400 test
  // above holds that one), and the tool asks the lens, never the hold
  const accepts = /function acceptsLateClaims\([\s\S]*?\n {4}\}/.exec(lens)?.[0];
  assert.ok(accepts, 'StakeAttestationLens.sol: acceptsLateClaims');
  assert.match(accepts, /return l\.state == StakeAttestation\.ListingState\.Rolled\s*\|\| \(l\.state == StakeAttestation\.ListingState\.Closed && l\.openedAt != 0\)\s*\|\| host\.heldAt\(listingId\) != 0;/);
  assert.ok(block.includes('When a listing takes one: while `acceptsLateClaims(listingId)` is true: the listing rolled forward (state Rolled), or closed after it opened (state Closed), or its maker holds it (`hold(listingId)`: the state stays Open or Depleted, and no commit is taken from then on).'));
  assert.ok(block.includes('A listing that never opened takes neither a commit nor a late claim.'));
  for (const state of ['Open', 'Depleted', 'Rolled', 'Closed']) assert.ok(solidityEnum('ListingState').includes(state), `${state} is a listing state`);
  assert.match(commit, /ctx\.read\('acceptsLateClaims', \[listingId\]\)/, 'the tool asks the lens whether the listing takes a late claim');
  assert.doesNotMatch(toolSources(), /\('heldAt'|\('hold'/, 'and reads no hold: a contract without one answers acceptsLateClaims all the same');
  assert.ok(raw.includes('\n      cast call "$VERDIKTA_CONTRACT" "acceptsLateClaims(uint256)(bool)" <listingId> --rpc-url https://sepolia.base.org\n'), 'the line that reads it');
  const view = ABI.find((f) => f.name === 'acceptsLateClaims');
  assert.deepEqual([view.inputs.map((i) => `${i.type} ${i.name}`), view.outputs.map((o) => o.type)], [['uint256 listingId'], ['bool']]);

  // open to every wallet: commit asks isAllowed, lateClaim does not, and the tool's check follows
  const lateFn = /function lateClaim\([\s\S]*?\n {4}\}/.exec(host)?.[0];
  const commitFn = /function commit\([\s\S]*?\n {4}\}/.exec(host)?.[0];
  assert.ok(lateFn && commitFn, 'StakeAttestation.sol: lateClaim and commit');
  assert.match(commitFn, /require\(isAllowed\(listingId, msg\.sender\), "not allowed"\);/);
  assert.doesNotMatch(lateFn, /isAllowed|not allowed/);
  assert.ok(block.includes('It is open to every wallet, invited listing or not.'));

  // what it costs: commitPrice, as a commit (lateClaim's own note, and the lens's)
  assert.match(host, /@dev msg\.value as commit's: at least bondWei plus the live maxTotalFee \(commitPrice\)\./);
  assert.match(lens, /commitPrice quotes what it takes, as for a commit\./);
  assert.ok(block.includes('What it costs: what a commit costs, `commitPrice(listingId)`: the listing\'s `bondWei` plus the live prepay (section 4).'));
  assert.match(commit, /const price = await ctx\.read\('commitPrice', \[listingId\]\);/);
  assert.match(section(4), /A late claim sends `commitPrice\(listingId\)` too, read and sent the same way, for no award \(section 3, "Late claims"\)\./);

  // what it pays: settle gives a late claim no award at any class, counts it under `later`, and sends an INVALID's
  // bond to the maker unless it is narrow, late or not. The tool's three warnings say so, and agents.txt says them
  // word for word
  const settle = /function settle\([\s\S]*?\n {4}\}/.exec(logic)?.[0];
  assert.ok(settle, 'ClaimLogic.sol: settle');
  assert.match(settle, /uint256 award = late \? 0 : ClaimRules\.awardFor\(l\.awards, uint8\(l\.lowestClassCounted\), outcome\);/);
  assert.match(settle, /if \(late\) l\.lateOutcomeCounts\[outcome\] \+= 1;\s*else l\.outcomeCounts\[outcome\] \+= 1;/);
  assert.match(settle, /payee = hunter;\s*if \(outcome == ClaimRules\.INVALID\) \{[\s\S]*?if \(ClaimRules\.isNarrowInvalid\(outcome, mass, l\.narrowInvalidFloor\)\) \{[\s\S]*?\} else \{\s*payee = l\.maker;\s*\}\s*\}\s*amount = c\.bondWei;/);
  const warnings = quoted(/export const LATE_CLAIM_WARNINGS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(notices)?.[1] ?? '');
  assert.equal(warnings.length, 3, 'tool/src/notices.js holds the late claim\'s three warnings');
  assert.match(warnings[0], /^A late claim pays no award\b/);
  assert.match(warnings[1], /^The bond is forfeited on INVALID\b/);
  assert.match(warnings[2], /^The prepay is spent on the evaluation\b/);
  for (const line of warnings) assert.ok(block.includes(line), `agents.txt says it word for word: ${line}`);
  assert.match(notices, /LATE_CLAIM_WARNINGS\.map\(/, 'and the notice commit --late prints before it pays carries them');
  // the third warning's second half: finalize makes the refund in a call that is caught, and a refund deferred that
  // way is the hunter's still: anyone may call recoverLeftoverEth, which pays the round's funder
  assert.match(logic, /try EvaluationWallet\(payable\(wallet\)\)\.refundLeftoverEth\{gas: ClaimRules\.INLINE_REFUND_GAS_LIMIT\}\(\)[\s\S]*?\} catch \{\s*emit StakeAttestation\.RefundDeferred\(claimId, wallet\);\s*\}/);
  assert.match(host, /Retry the recovery of a wallet's unspent prepay and pay it to the wallet's funder\s+\/\/\/\s+\(walletInfo: the hunter for a claim round or an appeal, the maker for a dispute\)\. Anyone may\s+\/\/\/\s+call\./);
  assert.deepEqual(ABI.find((f) => f.name === 'recoverLeftoverEth').inputs.map((i) => `${i.type} ${i.name}`), ['address wallet']);
  assert.match(warnings[2], /comes back when the round is finalized or, if the refund fails then, when anyone calls recoverLeftoverEth on the wallet of that round\.$/);
  assert.match(section(1), /A late claim, on a listing that takes no commit any more \(section 3, "Late claims"\), pays no award in any outcome/);

  // the command: the flag is the parser's and commit's, a first run is a dry run as a commit's is, and the later verbs
  // are a claim's; status says which kind it is
  assert.ok(setLiteral(cli, 'FLAGS').includes('--late'));
  assert.ok(usageFlags().per.get('commit').has('--late'), 'the help documents --late for commit');
  assert.match(/case 'commit': \{[\s\S]*?\n {4}\}/.exec(cli)[0], /late: options\['--late'\] === true/);
  assert.match(/function readyToCommit[\s\S]*?\n\}/.exec(commit)[0], /commitPreflight\(ctx, listingId, hunter, late\)[\s\S]*NEEDS_ACKNOWLEDGEMENT/, 'the listing is asked, then the terms are said, then --yes');
  assert.ok(block.includes('The command: `verdikta-attest commit ./claim --listing <listingId> --late` prints the terms, the price and those three warnings, and sends nothing (exit 3); with --yes it sends `lateClaim`, then pins and discloses as a commit does.'));
  assert.match(toolSrc('status.js'), /\n {4}late: claim\.late,\n/, 'status reads the claim\'s kind from the chain');
  assert.match(/function printStatus[\s\S]*?\n\}/.exec(cli)[0], /if \(s\.late\) out\(LATE_CLAIM_NOTE\);/);
  assert.match(notices, /export const LATE_CLAIM_NOTE = 'A late claim: [^\n]*pays no award\./);
  assert.ok(block.includes('`status`, `reveal`, `claim` and `appeal` then work as on any claim, and `status` says it is a late claim with no award (with --json, `late` is true).'));
  const s5 = text.slice(text.indexOf('\n## 5. '), text.indexOf('\n## 6. '));
  for (const line of [
    '    verdikta-attest commit ./claim --listing <listingId> --late         # first run: its terms and the price; sends nothing\n',
    '    verdikta-attest commit ./claim --listing <listingId> --late --yes   # late claim, pin, disclose\n',
  ]) assert.ok(s5.includes(line), `section 5: ${line.trim()}`);

  // commit order: a late claim joins the listing's one queue, and pendingClaims never counts it (the bounty 400
  // test above holds both to ClaimLogic.commit and resolve); the tool's count adds the late claims still open
  assert.ok(block.includes('It reveals in commit order with the listing\'s other claims: behind every claim still open there, the stake\'s own and earlier late claims, and `pendingClaims` counts only the stake\'s own.'));
  assert.match(toolSrc('listing.js'), /l\.lateClaims - l\.lateExpired - /, 'the late claims still open: made, less expired, less settled');
  assert.match(logic, /if \(c\.late\) l\.lateExpired \+= 1;/);

  // the refusals: each code is the tool's, ends with exit 1, and the ordinary commit's names the flag
  const preflight = /async function commitPreflight[\s\S]*?\n\}/.exec(commit)?.[0];
  assert.ok(preflight, 'tool/src/commit.js: commitPreflight');
  for (const code of ['LATE_CLAIMS_ONLY', 'LISTING_TAKES_COMMITS', 'NO_LATE_CLAIMS']) {
    assert.ok(Object.hasOwn(ERROR_TEXTS, code), `${code} is an error of the tool`);
    assert.equal(new ToolError(code).exitCode, 1, code);
    assert.ok(preflight.includes(`'${code}'`), `${code} is decided before anything is drawn, pinned or signed`);
    assert.ok(block.includes(`(${code})`), `agents.txt names ${code}`);
  }
  assert.match(ERROR_TEXTS.LATE_CLAIMS_ONLY, /commit --late/);
  assert.ok(block.includes('The wrong kind is refused before anything is pinned or sent: `commit` without --late on a listing that takes late claims only (LATE_CLAIMS_ONLY), --late on a listing that takes commits (LISTING_TAKES_COMMITS), and --late on one that takes neither (NO_LATE_CLAIMS).'));
  assert.match(section(3), /One that takes none may take a late claim instead \("Late claims", after step 8\)\./);

  // a late claim is not signed while the wallet has a transaction pending, which may be the same claim sent some
  // other way with no log to find yet; a commit is signed as it always was
  assert.match(commit, /if \(late\) await noPendingOfWallet\(ctx, state\.hunter, 'A late claim signed now could be a second one, for a second bond\.'\);/);
  assert.match(/async function noPendingOfWallet[\s\S]*?\n\}/.exec(commit)[0], /if \(pending > latest\) throw fail\('WALLET_BUSY'/);
  assert.equal(new ToolError('WALLET_BUSY').exitCode, 4);
  assert.ok(block.includes('It signs nothing while your wallet has a transaction that is not mined yet (WALLET_BUSY, exit 4): that one may be this late claim, sent some other way, and a second one would pay a second bond.'));
  // the amount printed is the amount sent: a fee that moved since the terms is said before the signature
  assert.match(commit, /if \(price !== quoted\) ctx\.notice\(priceMovedNotice\(\{ late, quoted, price \}\)\);\s*const data = ctx\.encode\(/);
  assert.match(section(4), /A commit or a late claim whose fee moved between its terms and its signature says the new amount before it signs\./);

  // a resume: the flag is read until something is signed, and the saved transaction decides from then on
  assert.match(section(4), /Once a commit or a late claim is signed, a later run resumes that one, with --late or without it\./);
  assert.match(commit, /if \(state\?\.stage === 'commit-signed'\) state = await settleCommit\(ctx, ws, state\);/, 'a signed one is settled before the flag is read');

  // the index names it too
  assert.match(read('client', 'public', 'llms.txt'), /late claims/);
});

// The lines a hunter types, as they were before node P43: a published film shows them, so --late is added in lines of
// its own and nothing here is reworded.
test('node P43: the command lines agents.txt had are as they were, character for character', () => {
  const text = agents();
  for (const line of [
    '    verdikta-attest check ./claim --listing <listingId>          # before you commit; needs a runner: section 8',
    '    verdikta-attest commit ./claim --listing <listingId>         # first run: the terms and the price; sends nothing',
    '    verdikta-attest commit ./claim --listing <listingId> --yes   # commit, pin, disclose',
    '    verdikta-attest status ./claim                               # where the claim stands, and what is next',
    '    verdikta-attest reveal ./claim                               # after the fix window: what it sends; sends nothing',
    '    verdikta-attest reveal ./claim --yes                         # pin the plaintext and reveal',
    '    verdikta-attest status ./claim --wait --max-wait-ms <ms>     # polls the evaluation',
    '    verdikta-attest claim ./claim                                # finalize, settle, withdraw: whatever is due',
    '    ln -sf verdikta-attest.js bin/verdikta-attest && export PATH="$PWD/bin:$PATH"',
    '    export VERDIKTA_CONTRACT="$(curl -fsS https://verifiers.verdikta.org/api/status | jq -r .contract)"',
    '    git clone --branch main https://github.com/verdikta/verdikta-applications.git',
    '    cd verdikta-applications/stake-attestation/shared && npm ci --ignore-scripts',
    '    cd ../tool && npm ci --ignore-scripts',
    '    node bin/verdikta-attest.js --help',
    '5. `verdikta-attest commit ./claim --listing <listingId> --yes`, then back the folder up (9).',
    '6. After the fix window, `verdikta-attest reveal ./claim --yes`, then `status` and `claim`',
  ]) assert.ok(text.includes(`\n${line}\n`), line.trim());
  const block = text.slice(text.indexOf('The commands, in order'), text.indexOf('\nIf it is judged INVALID'));
  assert.equal(block.split('\n').filter((l) => l.startsWith('    verdikta-attest ')).length, 8, 'the commands block holds the eight lines it held');
  assert.doesNotMatch(block, /--late/, 'and the late claim\'s lines stand apart from it');
});
