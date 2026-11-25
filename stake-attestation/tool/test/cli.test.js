import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { wordingProblems } from '@verdikta/stake-attestation-shared';

import { run, COMMANDS, TAKES, parseArgs } from '../src/cli.js';
import { USAGE } from '../src/usage.js';

const bin = fileURLToPath(new URL('../bin/verdikta-attest.js', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The CLI in this process: its exit code, what it wrote, and every environment variable it asked for. */
async function capture(argv, vars = {}) {
  let stdout = '';
  let stderr = '';
  const asked = [];
  const env = new Proxy({ ...vars }, { get: (target, name) => { asked.push(name); return target[name]; } });
  const code = await run(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } }, env);
  return { code, stdout, stderr, asked };
}

test('the package exposes the verdikta-attest binary', () => {
  assert.deepEqual(manifest.bin, { 'verdikta-attest': 'bin/verdikta-attest.js' });
  assert.match(fs.readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

test('--help prints usage and the hunter commands, exit 0', async () => {
  const res = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^Usage: verdikta-attest <command> \[options\]/);
  for (const name of ['check', 'commit', 'reveal', 'status', 'claim', 'appeal']) {
    assert.match(res.stdout, new RegExp(`^  ${name}\\s`, 'm'), name);
  }
  // node P18 adds appeal, the hunter's appeal of an INVALID (erratum E7)
  assert.deepEqual(Object.keys(COMMANDS), ['check', 'commit', 'reveal', 'status', 'claim', 'appeal']);
  assert.equal((await capture(['-h'])).code, 0);
});

test('--version prints the package version', async () => {
  const res = await capture(['--version']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), manifest.version);
});

test('no command prints usage to stderr, exit 2', async () => {
  const res = await capture([]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /^Usage: verdikta-attest/);
});

test('an unknown command or option is a usage error, exit 2', async () => {
  const cmd = await capture(['frobnicate']);
  assert.equal(cmd.code, 2);
  assert.match(cmd.stderr, /unknown command 'frobnicate'/);
  const opt = await capture(['--bogus']);
  assert.equal(opt.code, 2);
  assert.match(opt.stderr, /unknown option/);
});

test('a verb without what it needs is a usage error that names it, exit 2', async () => {
  const res = await capture(['commit']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /commit/);
  assert.equal(res.stdout, '');
});

// ------------------------------------------------------------------------------------------------ node P46
//
// Issue #241. The parser read `--yes=false` as --yes, so that line could sign and pay for a commit, and
// `--restart=false` as --restart, which removes a prepared folder's files; and it took every flag on every command,
// passing over the ones a command does not use. Now one table (TAKES, src/cli.js) says what each command takes, the
// parser reads a command's arguments against its row, and both mistakes are usage errors as the arguments are read:
// before the wallet key, the chain and the claim folder.

const VERBS = Object.keys(COMMANDS);
/** Every flag (`flags`) or option that takes a value (`values`) of any row. */
const allOf = (kind) => [...new Set(Object.values(TAKES).flatMap((row) => row[kind]))];
const takes = (verb, kind, name) => TAKES[verb][kind].includes(name) || TAKES['*'][kind].includes(name);
/** A line of each command that is whole without the argument under test. */
const WHOLE = { check: ['--listing', '7'], commit: ['--listing', '7', '--yes'], reveal: ['--yes'], status: ['--wait'], claim: [], appeal: ['--yes'] };
const TYPED = 'TYPED-BY-MISTAKE-91c2';

/** A server that counts what reaches it: the RPC, the gateway, the pin target and the runner of a run that must reach none. */
async function countingServer() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    res.end('{}');
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits: () => hits,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

/**
 * What a run reads first when it goes on: a wallet key in the environment, a key file (not there), an RPC, a gateway,
 * a pin target and a runner (each counted), and a claim folder (not there). `refused` holds a run to having read none.
 */
async function nothingIsRead() {
  const server = await countingServer();
  const missing = path.join(fs.realpathSync(os.tmpdir()), `sa-p46-not-there-${process.pid}-${Date.now()}`);
  const claim = path.join(missing, 'claim');
  const vars = {
    VERDIKTA_WALLET_KEY: `0x${'ab'.repeat(32)}`,
    VERDIKTA_RPC_URL: server.url,
    VERDIKTA_CONTRACT: `0x${'11'.repeat(20)}`,
    VERDIKTA_IPFS_GATEWAY: server.url,
    VERDIKTA_PIN_BACKEND: 'kubo',
    VERDIKTA_PIN_URL: server.url,
    CODE_RUNNER_URL: server.url,
    CODE_RUNNER_TOKEN: 'runner-token-of-this-test',
  };
  const given = ['--key-file', path.join(missing, 'wallet.key'), '--rpc-url', server.url, '--gateway', server.url];
  let runs = 0;
  /** `args` come after the claim folder; the options that name the key file, the RPC and the gateway come before them. */
  const refused = async (verb, args, text) => {
    const line = [verb, claim, ...given, ...args];
    const res = await capture(line, vars);
    const label = [verb, '<claim>', ...args].join(' ');
    assert.equal(res.code, 2, `${label}: ${res.stdout}${res.stderr}`);
    assert.equal(res.stdout, '', label);
    // the whole of what it says: the flag or option by name, and no value from the line
    assert.equal(res.stderr, `verdikta-attest: ${verb}: ${text}\n`, label);
    assert.deepEqual(res.asked, [], `${label}: no environment variable was read, so no wallet key, RPC, contract or gateway`);
    assert.equal(server.hits(), 0, `${label}: nothing reached the RPC, the gateway, the pin target or the runner`);
    assert.equal(fs.existsSync(missing), false, `${label}: no folder was made`);
    runs += 1;
  };
  return { server, vars, claim, refused, runs: () => runs, close: () => server.close() };
}

test('one table says what each command takes: a row for every command and one for all of them, and no name is a flag in one row and an option in another', () => {
  assert.deepEqual(Object.keys(TAKES), ['*', ...VERBS]);
  for (const [name, row] of Object.entries(TAKES)) {
    assert.deepEqual(Object.keys(row), ['flags', 'values'], name);
    for (const kind of ['flags', 'values']) {
      for (const option of row[kind]) assert.match(option, /^--[a-z][a-z-]*$/, `${name}: ${option}`);
      const own = name === '*' ? row[kind] : [...row[kind], ...TAKES['*'][kind]];
      assert.equal(new Set(own).size, own.length, `${name}: ${kind} are named once each`);
    }
  }
  assert.deepEqual(allOf('flags').filter((f) => allOf('values').includes(f)), []);
  assert.ok(Object.isFrozen(TAKES));
});

/** What a line of the help says is taken: the options followed by a <value>, and the bare flags, in the line's order. */
function shownOn(line) {
  const out = { flags: [], values: [] };
  for (const m of line.matchAll(/(--[a-z][a-z-]*)( <[^>]+>)?/g)) out[m[2] ? 'values' : 'flags'].push(m[1]);
  return out;
}

/** The help's own usage line of each command, and its "Options" section without the two answers given in a command's place. */
function helpLines() {
  const lines = USAGE.split('\n');
  const per = Object.fromEntries(VERBS.map((verb) => {
    const own = lines.filter((l) => l.startsWith(`  ${verb} <`));
    assert.equal(own.length, 1, `the help has one usage line for ${verb}`);
    return [verb, own[0]];
  }));
  const start = USAGE.indexOf('\nOptions:\n');
  const end = USAGE.indexOf('\n\n', start);
  assert.ok(start >= 0 && end > start, 'the help has its Options');
  const options = USAGE.slice(start, end).split('\n').slice(2);
  return { per, options };
}

test('the help\'s usage lines are the table, in both directions: a command takes what its own line shows, and the Options section, and nothing else', () => {
  const { per, options } = helpLines();
  for (const verb of VERBS) assert.deepEqual(shownOn(per[verb]), TAKES[verb], `${verb}: ${per[verb].trim()}`);
  // the Options section: each line is an option every command takes, but the two answers given in a command's place
  const instead = options.filter((l) => /^ {2}-[a-z], --[a-z]+ /.test(l));
  assert.deepEqual(instead.map((l) => l.trim().split(/\s{2,}/)[0]), ['-h, --help', '-v, --version']);
  const forAll = options.filter((l) => !instead.includes(l));
  for (const l of forAll) assert.match(l, /^ {2}--[a-z][a-z-]*( <[^>]+>)? {2,}\S/, l);
  assert.deepEqual(shownOn(forAll.map((l) => l.trim().split(/\s{2,}/)[0]).join(' ')), TAKES['*']);
  // and no line anywhere in the help names a flag the parser does not take
  const known = new Set([...allOf('flags'), ...allOf('values'), '--help', '--version']);
  for (const m of USAGE.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) assert.ok(known.has(m[0]), `the help names ${m[0]}`);
});

// The table against the code, so that nothing is taken that a command never reads: each command's own case in
// dispatch reads the options of its row, all of them and no other, and what is read outside those cases is the "*"
// row's (and --listing, through listingOf, which check and commit call).
test('each command reads the flags and options of its row, all of them and no other', () => {
  const src = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const read = (text) => [...new Set([...text.matchAll(/options\['(--[a-z-]+)'\]/g)].map((m) => m[1]))].sort();
  let outside = src;
  for (const verb of VERBS) {
    const block = new RegExp(`\\n {4}case '${verb}': \\{\\n[\\s\\S]*?\\n {4}\\}\\n`).exec(src)?.[0];
    assert.ok(block, `dispatch has a case for ${verb}`);
    outside = outside.replace(block, '\n');
    const names = [...read(block), ...(block.includes('listingOf()') ? ['--listing'] : [])].sort();
    assert.deepEqual(names, [...TAKES[verb].flags, ...TAKES[verb].values].sort(), verb);
  }
  assert.deepEqual(read(outside), [...TAKES['*'].flags, ...TAKES['*'].values, '--listing'].sort());
});

test('a flag written with = and a value, an empty one too, is a usage error (exit 2) on every command that takes it: it names the flag and never the value, before anything is read', async () => {
  const world = await nothingIsRead();
  try {
    // the two lines of issue #241
    await world.refused('commit', ['--listing', '7', '--yes=false'], '--yes takes no value');
    await world.refused('commit', ['--restart=false'], '--restart takes no value');
    for (const verb of VERBS) {
      const flags = [...TAKES[verb].flags, ...TAKES['*'].flags];
      assert.ok(flags.length >= 2, verb);
      for (const flag of flags) {
        for (const value of ['false', 'true', '0', 'no', '', TYPED]) await world.refused(verb, [`${flag}=${value}`], `${flag} takes no value`);
        // on a line that is whole without it, last and first, and beside the bare flag
        await world.refused(verb, [...WHOLE[verb], `${flag}=false`], `${flag} takes no value`);
        await world.refused(verb, [`${flag}=${TYPED}`, ...WHOLE[verb], flag], `${flag} takes no value`);
      }
    }
    assert.ok(world.runs() >= 8 * (allOf('flags').length + VERBS.length), `${world.runs()} lines`);
    // the same setting does read all of it once a line is accepted: the counts above are not empty by construction
    const went = await capture(['status', '7'], world.vars);
    assert.equal(went.code, 1, went.stderr);
    assert.match(went.stderr, /^verdikta-attest: RPC_UNAVAILABLE: /);
    assert.ok(went.asked.includes('VERDIKTA_RPC_URL') && went.asked.includes('VERDIKTA_CONTRACT'));
    assert.ok(world.server.hits() > 0, 'the RPC was asked');
  } finally {
    await world.close();
  }
});

const owned = (kind, name) => VERBS.filter((verb) => TAKES[verb][kind].includes(name)).map((verb) => `${verb}'s`);
const listed = (words) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]);

test('a flag or an option on a command that does not take it is a usage error (exit 2): it names it and the commands that do take it, echoes no value, and comes before anything is read', async () => {
  const world = await nothingIsRead();
  try {
    // said in full, once each: a flag of one command, of several, an option of one, of several
    await world.refused('reveal', ['--waive-appeal'], '--waive-appeal is claim\'s flag: no other command takes it');
    await world.refused('status', ['--restart'], '--restart is commit\'s flag: no other command takes it');
    await world.refused('claim', ['--yes'], '--yes is commit\'s, reveal\'s and appeal\'s flag: no other command takes it');
    await world.refused('appeal', ['--max-wait-ms', '5000'], '--max-wait-ms is status\'s option: no other command takes it');
    await world.refused('claim', ['--listing', '7'], '--listing is check\'s and commit\'s option: no other command takes it');
    for (const verb of VERBS) {
      for (const [kind, word] of [['flags', 'flag'], ['values', 'option']]) {
        for (const name of allOf(kind).filter((n) => !takes(verb, kind, n))) {
          const text = `${name} is ${listed(owned(kind, name))} ${word}: no other command takes it`;
          // bare, with a value in either form (whose it is comes first, and the value is in neither text), and on a
          // line that is whole without it
          const forms = kind === 'flags' ? [[name], [`${name}=false`], [`${name}=${TYPED}`]] : [[name, TYPED], [`${name}=${TYPED}`], [name]];
          for (const form of forms) await world.refused(verb, form, text);
          await world.refused(verb, [...WHOLE[verb], ...forms[0]], text);
          await world.refused(verb, [...forms[0], ...WHOLE[verb]], text);
        }
      }
    }
    // each command refuses something, and each flag and option but those of the "*" row is refused somewhere
    assert.ok(world.runs() >= 5 * (VERBS.length + allOf('flags').length + allOf('values').length - 5), `${world.runs()} lines`);
    for (const kind of ['flags', 'values']) {
      for (const name of allOf(kind)) assert.equal(VERBS.every((verb) => takes(verb, kind, name)), TAKES['*'][kind].includes(name), `${name} is every command's only in the "*" row`);
    }
  } finally {
    await world.close();
  }
});

test('an option that takes a value takes it inline or as the next argument, on every command that takes it, and its value is never echoed', async () => {
  for (const verb of VERBS) {
    const values = [...TAKES[verb].values, ...TAKES['*'].values];
    assert.ok(values.length >= 4, verb);
    for (const name of values) {
      // inline, everything after the first = is the value; as the next argument, whatever it is
      assert.deepEqual(parseArgs(verb, ['./claim', `${name}=a=b`]), { options: { [name]: 'a=b' }, positional: ['./claim'] }, `${verb} ${name}=`);
      assert.deepEqual(parseArgs(verb, [name, 'v', './claim']), { options: { [name]: 'v' }, positional: ['./claim'] }, `${verb} ${name}`);
      assert.deepEqual(parseArgs(verb, ['./claim', ...WHOLE[verb], name, 'v']).options[name], 'v', `${verb} ${name} on a whole line`);
      const none = await capture([verb, './claim', name]);
      assert.equal(none.code, 2, `${verb} ${name}`);
      assert.equal(none.stderr, `verdikta-attest: ${verb}: ${name} needs a value\n`);
    }
    // and the flags it takes are read as given, each true and nothing else
    const flags = [...TAKES[verb].flags, ...TAKES['*'].flags];
    assert.deepEqual(parseArgs(verb, ['./claim', ...flags]), { options: Object.fromEntries(flags.map((f) => [f, true])), positional: ['./claim'] }, verb);
  }
  // the commands read the value in either form, and say what is wrong with it without repeating it
  for (const [argv, text] of [
    [['status', '7', `--max-wait-ms=${TYPED}`], 'status: --max-wait-ms is a number'],
    [['status', '7', '--max-wait-ms', TYPED], 'status: --max-wait-ms is a number'],
    [['check', './claim', `--listing=${TYPED}`], 'check: --listing is a listing id'],
    [['check', './claim', '--listing', TYPED], 'check: --listing is a listing id'],
  ]) {
    const res = await capture(argv);
    assert.equal(res.code, 2, argv.join(' '));
    assert.equal(res.stderr, `verdikta-attest: ${text}\n`, argv.join(' '));
  }
});

test('an unknown option on a command stays the usage error it was, with no value in it; -h, --help, -v and --version are answers in a command\'s place only', async () => {
  for (const verb of VERBS) {
    for (const [token, name] of [['--bogus', '--bogus'], [`--bogus=${TYPED}`, '--bogus'], ['--yess', '--yess'], ['--help', '--help'], ['-h', '-h'], ['--version', '--version'], ['-v', '-v']]) {
      const res = await capture([verb, './claim', token]);
      assert.equal(res.code, 2, `${verb} ${token}`);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, `verdikta-attest: ${verb}: unknown option '${name}'\n`, `${verb} ${token}`);
    }
  }
  for (const first of ['-h', '--help']) assert.deepEqual(await capture([first]), { code: 0, stdout: USAGE, stderr: '', asked: [] });
  for (const first of ['-v', '--version']) assert.deepEqual(await capture([first]), { code: 0, stdout: `${manifest.version}\n`, stderr: '', asked: [] });
});

/**
 * The command lines a document shows: every line that starts with `verdikta-attest` (a code block's, an indented
 * example's) and every such text in backticks, up to a # comment. Read from the document, never from a list here.
 */
function shownIn(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(?:^\s*|`)verdikta-attest((?:[ \t]+[^\s`#]+)+)/g)) out.push({ line: i + 1, argv: m[1].trim().split(/\s+/) });
  });
  return out;
}

/**
 * A usage line of the help as the command lines it shows, each with every optional part on it: the brackets taken
 * off, and one line for each choice of a parenthesized `(a | b)`, which a command takes one of (R1-F2).
 */
function helpCommandLines(line) {
  const choice = /\(([^()]+)\)/.exec(line);
  const each = choice ? choice[1].split(' | ').map((one) => line.replace(choice[0], one)) : [line];
  return each.map((one) => one.trim().replace(/[[\]]/g, '').split(/\s+/));
}

test('every command line the help, the README and the agent guide show is one the parser takes, each read from its file', async () => {
  const sources = {
    'the help': Object.values(helpLines().per).flatMap((line, i) => helpCommandLines(line).map((argv) => ({ line: i + 1, argv }))),
    'README.md': shownIn(fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8')),
    'client/public/agents.txt': shownIn(fs.readFileSync(new URL('../../client/public/agents.txt', import.meta.url), 'utf8')),
  };
  // check's line shows two: with --listing, and with --listing-archive in its place
  assert.deepEqual(sources['the help'].filter(({ argv }) => argv[0] === 'check').map(({ argv }) => argv.join(' ')), [
    'check <claim-dir> --listing <id> --no-pack --remote-runner',
    'check <claim-dir> --listing-archive <file> --no-pack --remote-runner',
  ]);
  // each of the two gets past check's own reading of its arguments, to the first thing check needs; both together do not
  for (const [args, code, said] of [
    [['--listing', '7'], 1, /^verdikta-attest: RUNNER_NOT_CONFIGURED: /],
    [['--listing-archive', 'listing.zip'], 1, /^verdikta-attest: RUNNER_NOT_CONFIGURED: /],
    [['--listing', '7', '--listing-archive', 'listing.zip'], 2, /^verdikta-attest: check: check needs --listing <id> or --listing-archive <file>\n$/],
  ]) {
    const res = await capture(['check', './claim', ...args, '--no-pack', '--remote-runner']);
    assert.equal(res.code, code, args.join(' '));
    assert.match(res.stderr, said, args.join(' '));
  }
  const least = { 'the help': 7, 'README.md': 11, 'client/public/agents.txt': 20 };
  for (const [name, shown] of Object.entries(sources)) {
    assert.ok(shown.length >= least[name], `${name}: ${shown.length} command lines were read`);
    const verbs = new Set();
    for (const { line, argv } of shown) {
      const at = `${name}:${line}: verdikta-attest ${argv.join(' ')}`;
      const [verb, ...args] = argv;
      if (verb.startsWith('-')) {
        assert.ok(['-h', '--help', '-v', '--version'].includes(verb) && args.length === 0, at);
        continue;
      }
      assert.ok(Object.hasOwn(COMMANDS, verb), at);
      verbs.add(verb);
      let parsed;
      assert.doesNotThrow(() => { parsed = parseArgs(verb, args); }, at);
      assert.ok(parsed.positional.length <= 1, `${at}: one claim folder or id at most`);
      // each option on the line is read as itself, none as another's value
      const named = [...new Set(args.filter((a) => a.startsWith('-')).map((a) => a.split('=')[0]))];
      assert.deepEqual(Object.keys(parsed.options).sort(), named.sort(), at);
    }
    assert.deepEqual([...verbs].sort(), [...VERBS].sort(), `${name} shows every command`);
  }
});

test('the help and the README say the rule once, for every flag, and nothing of the reading it replaced', () => {
  const help = USAGE.replace(/\s+/g, ' ');
  assert.match(help, /Each command takes what its own line above shows, and --json, --key-file, --rpc-url, --contract and --gateway\. A flag is the bare word, and an option's value follows it or an = \(--listing 7, --listing=7\)\. A flag with a value \(--yes=false too\) is a usage error, and so is a flag or an option on a command that does not take it: nothing is read or sent\./);
  assert.doesNotMatch(help, /--late is the bare flag/, 'the line on --late alone is the general one now');
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf('\n## The hunter tool\n');
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1)).replace(/\s+/g, ' ');
  assert.doesNotMatch(section, /Every other flag is read as it was/);
  assert.match(section, /A flag is the bare word: written with a value \(`--yes=false` too, or an empty one\) it is a usage error \(exit 2\), and so is a flag or an option on a command that does not take it, as the arguments are read: before the wallet key, the chain or the claim folder\./);
  assert.match(section, /one table says what each command takes \(`TAKES`, `tool\/src\/cli\.js`\)/);
  // what the parser says is the tool's own text, and passes the wording check
  for (const text of ['--yes takes no value', '--yes is commit\'s, reveal\'s and appeal\'s flag: no other command takes it', '--listing is check\'s and commit\'s option: no other command takes it']) assert.deepEqual(wordingProblems(text), [], text);
});

test('the two lines of issue #241 on a live listing: `commit --yes=false` signs and pays nothing, and `commit --restart=false` leaves a prepared folder as it is', async () => {
  const { closeRpc, runCli, statePath } = await import('./helpers/cli.js');
  const { makeClaimDir, makeWorld } = await import('./helpers/world.js');
  const w = await makeWorld();
  try {
    const l = await w.listing();
    const sent = async () => ({ claims: await w.claimCount(), uploads: w.ipfs.uploads.length, nonce: await w.provider.getTransactionCount(w.hunterWallet.address) });
    // --yes=false on a listing that takes commits, from a wallet that can pay: no yes, so nothing is signed
    const dir = makeClaimDir();
    const before = await sent();
    const paid = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes=false']);
    assert.equal(paid.code, 2, `${paid.stdout}${paid.stderr}`);
    assert.equal(paid.stdout, '');
    assert.equal(paid.stderr, 'verdikta-attest: commit: --yes takes no value\n');
    assert.deepEqual(await sent(), before, 'no claim, no pin, no transaction');
    assert.equal(fs.existsSync(statePath(dir, '')), false, 'the claim folder was not touched');
    // --restart=false on a prepared folder: its keys and its files stay
    const stop = (step) => {
      if (step === 'prepare:saved') throw new Error('stop');
    };
    await w.hunter({ onStep: stop }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch(() => {});
    const files = () => Object.fromEntries(fs.readdirSync(statePath(dir, '')).sort().map((f) => [f, fs.readFileSync(statePath(dir, f)).toString('base64')]));
    const prepared = files();
    assert.ok(Object.hasOwn(prepared, 'keys.json') && Object.hasOwn(prepared, 'state.json'), 'the folder is prepared');
    for (const args of [['--restart=false'], ['--listing', String(l.listingId), '--restart=false', '--yes'], ['--restart=']]) {
      const res = await runCli(w, ['commit', dir, ...args]);
      assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
      assert.equal(res.stderr, 'verdikta-attest: commit: --restart takes no value\n');
      assert.deepEqual(files(), prepared, `${args.join(' ')}: the prepared folder is as it was`);
    }
    assert.deepEqual(await sent(), before);
    // and the bare flags do what they did: --restart starts the folder over, --yes signs
    const again = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--restart', '--yes']);
    assert.equal(again.code, 0, again.stderr);
    assert.notEqual(files()['keys.json'], prepared['keys.json'], 'new keys');
    assert.equal(await w.claimCount(), before.claims + 1n);
  } finally {
    await closeRpc(w);
    await w.close();
  }
});
