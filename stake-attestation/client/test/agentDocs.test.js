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
// The branch the documents send an agent to for the tool is named once, below (TOOL_REF): at G3 it is main.
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

/** Where the documents send an agent for the tool, until G3 merges the build to main. Named here only. */
const TOOL_REF = 'claude/stake-attestation';
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

test('the exit codes are the tool\'s table, and the flag each acknowledgement needs is on its line', () => {
  const text = agents();
  const start = text.indexOf('\nExit codes:\n');
  assert.ok(start >= 0, 'agents.txt has an Exit codes block');
  const block = text.slice(start + 1).split('\n\n')[0];
  const stated = new Map([...block.matchAll(/^ +(\d) {2}(.+)$/gm)].map((m) => [Number(m[1]), m[2]]));
  const exits = toolExits();
  assert.deepEqual([...stated.keys()].sort(), [...exits.keys()].sort(), 'the codes stated are the codes the tool returns');
  for (const [exit, codes] of exits) {
    if (exit <= 1) continue; // 1 is every other refusal's, and its texts name flags of their own
    const flags = new Set(codes.flatMap((c) => [...ERROR_TEXTS[c].matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0])));
    for (const f of flags) assert.ok(stated.get(exit).includes(f), `exit ${exit} is ${codes.join(', ')}: its line names ${f}`);
  }
  assert.match(stated.get(4), /again/, 'exit 4: run the same command again');
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

test('every host they name is an allowed one; GitHub links go to the two public repositories, at their refs', () => {
  const ALLOWED = new Set(['verifiers.verdikta.org', 'github.com', 'www.npmjs.com', 'unpkg.com', 'sepolia.base.org', 'sepolia.basescan.org', 'gateway.pinata.cloud', 'localhost']);
  const arbiterRef = JSON.parse(read('builder', 'test', 'docker', 'code-runner.pin.json')).branch;
  for (const [name, text] of docs()) {
    for (const m of text.matchAll(/\bhttps?:\/\/([^/\s)<>"'`]+)/g)) {
      const host = m[1].replace(/:\d+$/, '').replace(/[.,;:]+$/, '').toLowerCase();
      assert.ok(ALLOWED.has(host), `${name}: ${host} is not an allowed host`);
    }
    for (const m of text.matchAll(/\b(?:[a-z0-9-]+\.)+(?:org|io|com|net|cloud|dev|app|xyz|sh|ai|co|link|info)\b/gi)) {
      assert.ok(ALLOWED.has(m[0].toLowerCase()), `${name}: ${m[0]} is not an allowed host`);
    }
    for (const m of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[/\s)#]|$)(\/(?:tree|blob)\/([^\s)#]+))?/g)) {
      assert.ok([APPS_REPO, ARBITER_REPO].includes(m[1]), `${name}: github.com/${m[1]} is not a public repository of the site's`);
      if (m[3] === undefined) continue;
      const ref = m[1] === APPS_REPO ? TOOL_REF : arbiterRef;
      assert.ok(m[3].startsWith(`${ref}/`), `${name}: ${m[1]} at ${m[3]}: the ref is ${ref}`);
    }
  }
  const text = agents();
  assert.ok(text.includes(`git clone --branch ${TOOL_REF} https://github.com/${APPS_REPO}.git`), `agents.txt clones the tool at ${TOOL_REF}`);
  for (const m of text.matchAll(/--branch (\S+)/g)) assert.equal(m[1], TOOL_REF);
  assert.match(text, new RegExp(`branch\\s+${TOOL_REF.replace('/', '\\/')}`), 'it names the branch in the prose');
  assert.doesNotMatch(text, /verdikta-common\b/, 'never the private repository of @verdikta/common');
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
    ]);
    for (const m of stripped.matchAll(/(?<![\w.])\d{3,}(?![\w.])/g)) assert.ok(allowed.has(m[0]), `${name}: ${m[0]} is a number nothing here checks (a listing's value?)`);
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
