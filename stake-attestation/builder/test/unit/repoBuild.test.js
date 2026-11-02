// The repository's build for the verified-source check: one sandbox of the pushed image with no
// network, fed on stdin the checksummed solc and the listed commit's files; it reads the verified
// files back from the tree the build reads, then runs the pinned base's forge with --use.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildArgv, buildAtCommit, buildInput } from '../../src/repoBuild.js';
import { fakeDocker } from '../helpers/fakes.js';

const SOLC = { bytes: Buffer.from('\x7fELF solc') };
const ENTRIES = [
  { path: 'src/Vault.sol', mode: '100644', bytes: Buffer.from('contract Vault {}\n') },
  { path: 'src/link.sol', mode: '120000', bytes: Buffer.from('Vault.sol') },
];
const b64 = (s) => Buffer.from(s).toString('base64');

test('stdin: the solc bytes, then "<mode> <size> <base64 path>" and the exact bytes of each file, then the end', () => {
  const input = buildInput(SOLC.bytes, ENTRIES);
  const expected = Buffer.concat([
    SOLC.bytes,
    Buffer.from(`100644 18 ${b64('src/Vault.sol')}\n`), ENTRIES[0].bytes,
    Buffer.from(`120000 9 ${b64('src/link.sol')}\n`), ENTRIES[1].bytes,
    Buffer.from('end 0 -\n'),
  ]);
  assert.ok(input.equals(expected));
});

test('the build runs in the sandbox (no network, uid 10001, read-only root) and its answer is read back', async () => {
  const artifact = { metadata: { compiler: { version: '0.8.31' } }, deployedBytecode: { object: '0x00' } };
  const out = [
    `F ${b64('src/Vault.sol')} ${b64('contract Vault {}\n')}`,
    `M ${b64('src/Gone.sol')}`,
    `C ${b64(JSON.stringify({ solc: '0.8.31' }))}`,
    `T 0 ${b64('')}`,
    'B 0',
    `A ${b64(JSON.stringify(artifact))}`,
  ].join('\n');
  const docker = fakeDocker((args) => (args[0] === 'run' ? { stdout: `${out}\n` } : {}));
  const r = await buildAtCommit({ docker, image: `env@sha256:${'a'.repeat(64)}`, platform: 'linux/amd64', solc: SOLC, entries: ENTRIES, contractPath: 'src/Vault.sol', contractName: 'Vault', paths: ['src/Vault.sol', 'src/Gone.sol'] });
  assert.equal(r.files.get('src/Vault.sol').toString(), 'contract Vault {}\n');
  assert.equal(r.files.get('src/Gone.sol'), null);
  assert.deepEqual(r.config, { solc: '0.8.31' });
  assert.deepEqual(r.artifact, artifact);
  assert.deepEqual(r.build, { exitCode: 0, log: '' });
  assert.deepEqual(r.copy, { exitCode: 0, errors: '' });
  const run = docker.calls.find((c) => c.args[0] === 'run');
  const pair = (f) => run.args[run.args.indexOf(f) + 1];
  assert.equal(pair('--network'), 'none');
  assert.equal(pair('--user'), '10001:10001');
  assert.ok(run.args.includes('--read-only') && run.args.includes('--interactive'));
  assert.deepEqual(run.args.slice(-7), buildArgv({ solcSize: SOLC.bytes.length, contractPath: 'src/Vault.sol', contractName: 'Vault', paths: ['src/Vault.sol', 'src/Gone.sol'] }).slice(-7));
  assert.ok(run.opts.stdin.equals(buildInput(SOLC.bytes, ENTRIES)));
  assert.match(run.args[run.args.indexOf('-c') + 1], /forge build --force --offline --use \/work\/\.verdikta\/solc/);
});

test('the script reads the verified files before forge runs, and solc lives where nothing else can write', () => {
  const script = buildArgv({ solcSize: 1, contractPath: 'a.sol', contractName: 'A', paths: [] })[2];
  assert.ok(script.indexOf('base64 -w0 < "$p"') < script.indexOf('forge config'), 'files first');
  assert.ok(script.indexOf('forge config') < script.indexOf('forge build'));
  assert.match(script, /chmod 0500 \/work\/\.verdikta$/m);
  assert.match(script, /tar -C \/work\/src --skip-old-files -xf -/, 'installed dependencies never over a tracked path');
});

test('a sandbox that did not lay the tree out is an error, never a verdict', async () => {
  const docker = fakeDocker((args) => (args[0] === 'run' ? { exitCode: 1, stderr: 'base64: invalid input' } : {}));
  await assert.rejects(buildAtCommit({ docker, image: 'x', platform: 'linux/amd64', solc: SOLC, entries: ENTRIES, contractPath: 'src/Vault.sol', contractName: 'Vault', paths: [] }), { code: 'SOURCE_READ_FAILED' });
});
