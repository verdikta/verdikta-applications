// Acceptance 2 against real images: for a contract listing, the recorded explorer responses for
// the deployment (test/fixtures/explorer; no explorer is ever called live) are compared with the
// repository's own build at baseCommit, made with tools the listing did not choose: the listed
// commit's files from the objects the builder fetched, the pinned base's forge, and solc 0.8.31
// from binaries.soliditylang.org (checked against its list.json SHA-256), in a sandbox.
//
// The adversarial listing: its setup rewrites the tracked src/Vault.sol in /repo into the
// explorer's edited version, adds an untracked symbolic link lib/Alias.sol to it, and installs a
// fake `solc`. The check reads none of them: the listing is still refused, and the compiler is
// the Solidity project's. Two more listings change only foundry.toml: another solc pin, and the
// optimizer off; both are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { createDocker, runSandboxed } from '../../src/docker.js';
import { createExplorer } from '../../src/explorer.js';
import { buildEnvImage, repoBuilder } from '../../src/pipeline.js';
import { newReport } from '../../src/report.js';
import { checkVerifiedSource } from '../../src/sourceCheck.js';
import { FIXTURES, recordedExplorer } from '../helpers/fakes.js';
import { fixtureDraft, fixtureRepo, newId, removeImages, startRegistries, testPlatforms } from './helpers.js';

const TIMEOUT = 1800000;
const id = newId();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
const platforms = testPlatforms();
const recipient = codeReview.generateDisclosureKeyPair().recipient;
const CONTRACT = { kind: 'contract', address: '0x5f2A00000000000000000000000000000000C0dE', chainId: 8453 };
const SOLC_SHA256 = {
  'linux/amd64': 'aac9cd0116e9ae0cd3d8f64a8641381845dc9f12e2a52653de36fb619323e557',
  'linux/arm64': 'acf358d82da7db033debb2f4db11e1c9cfcb02b0cb5b5ddbb9635ad817b41bdd',
};
const TOML = fs.readFileSync(path.join(FIXTURES, 'vault', 'foundry.toml'), 'utf8');
const docker = createDocker({});
let regs;
const listings = {};

/** A fixture repository (foundry.toml changed by `toml`), its draft and its pushed image. */
async function listing(name, { toml = TOML, setup } = {}) {
  const sub = fs.mkdtempSync(path.join(dir, `${name}-`));
  const repo = fixtureRepo(sub, { 'foundry.toml': toml });
  const draft = fixtureDraft(repo.baseCommit, recipient, { artifact: CONTRACT, repo: `https://github.com/verdikta-test/${name}` });
  if (setup !== undefined) draft.commands.setup = setup;
  const config = parseConfig({
    registry: { repository: `${regs.host}/${id}/env`, apiUrl: regs.apiUrl },
    runner: { url: 'http://127.0.0.1:1', tokenEnv: 'UNUSED' },
    platforms,
    repoMirrors: { [draft.repo]: repo.mirror },
    solc: { cacheDir: path.join(dir, 'solc') },
  }, { baseDir: dir, env: {} });
  const image = await buildEnvImage({ draft, config, report: newReport({ draft }), workDir: fs.mkdtempSync(path.join(dir, 'w-')) });
  listings[name] = { draft, config, image };
}

test.before(async () => {
  regs = await startRegistries(id);
  await listing('honest');
  await listing('tampered', {
    setup: [
      "sed -i 's/amount + 1/amount/' src/Vault.sol",
      'mkdir -p lib && ln -s ../src/Vault.sol lib/Alias.sol',
      'mkdir -p "$VERDIKTA_TOOLS/bin"',
      "printf '#!/bin/sh\\necho fake-solc\\n' > \"$VERDIKTA_TOOLS/bin/solc\"",
      'chmod 0755 "$VERDIKTA_TOOLS/bin/solc"',
    ].join(' && '),
  });
  await listing('otherpin', { toml: TOML.replace('solc = "0.8.31"', 'solc = "0.8.30"'), setup: 'true' });
  await listing('nooptimizer', { toml: TOML.replace('optimizer = true', 'optimizer = false'), setup: 'true' });
});

test.after(() => {
  if (regs) removeImages(`${regs.host}/${id}/env`);
  regs?.remove();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function check(name, routes) {
  const { draft, config, image } = listings[name];
  const rec = recordedExplorer(routes);
  const explorer = createExplorer({ apiUrl: rec.apiUrl, apiKey: null, chainId: 8453, fetch: rec.fetch, timeoutMs: 5000 });
  const build = repoBuilder({ config, docker, draft, workDir: fs.mkdtempSync(path.join(dir, 's-')) });
  const buildRepo = (req) => build({ ...req, gitDir: image.gitDir, image: image.ref });
  return checkVerifiedSource({ spec: draft, explorer, buildRepo });
}

const MATCH = { getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault.json' };
const codes = (r) => r.issues.map((i) => [i.code, i.path ?? null]);

test('the listed commit builds, with the checksummed solc and the pinned forge, to the deployed code', { timeout: TIMEOUT }, async () => {
  const r = await check('honest', MATCH);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.deepEqual(r.warnings, [], 'the untracked files were laid out without an error');
  assert.equal(r.summary.bytecode, 'match');
  assert.equal(r.summary.metadata, 'match', 'same files and settings: even the metadata hash agrees');
  assert.deepEqual(r.summary.contract, { path: 'src/Vault.sol', name: 'Vault' });
  assert.deepEqual(r.summary.solc, { version: '0.8.31+commit.fd3a2265', sha256: SOLC_SHA256[platforms.run], platform: platforms.run });
});

test('a verified source that is not the listed commit stops the listing', { timeout: TIMEOUT }, async () => {
  assert.deepEqual(codes(await check('honest', { ...MATCH, getsourcecode: 'getsourcecode-vault-edited.json' })), [['SOURCE_FILE_MISMATCH', 'src/Vault.sol']]);
});

test('deployed code the listed commit does not build to stops the listing', { timeout: TIMEOUT }, async () => {
  assert.deepEqual(codes(await check('honest', { ...MATCH, getcode: 'getcode-vault-other.json' })), [['BYTECODE_MISMATCH', null]]);
});

test('a setup that rewrites a tracked source, links an untracked alias to it and plants a solc cannot pass', { timeout: TIMEOUT }, async () => {
  const { image } = listings.tampered;
  // The attack is in place: the image's work tree holds the edited source, the alias and a fake solc.
  const look = await runSandboxed({ docker, image: image.ref, platform: platforms.run, argv: ['/bin/sh', '-c', 'grep -c "amount + 1" /repo/src/Vault.sol; grep -c "amount + 1" /repo/lib/Alias.sol; solc'], timeoutMs: 60000 });
  assert.deepEqual(look.stdout.toString().trim().split('\n'), ['0', '0', 'fake-solc']);
  // The explorer verified the edited source, under its own name or the alias: neither is the listed commit.
  assert.deepEqual(codes(await check('tampered', { ...MATCH, getsourcecode: 'getsourcecode-vault-edited.json' })), [['SOURCE_FILE_MISMATCH', 'src/Vault.sol']]);
  assert.deepEqual(codes(await check('tampered', { ...MATCH, getsourcecode: 'getsourcecode-vault-alias.json' })), [['SOURCE_FILE_MISMATCH', 'lib/Alias.sol']]);
  // The honest verification builds the listed commit with the Solidity project's solc, not the planted one.
  const ok = await check('tampered', MATCH);
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.equal(ok.summary.solc.sha256, SOLC_SHA256[platforms.run]);
});

test('a repository that pins another solc than the deployment was verified with stops the listing', { timeout: TIMEOUT }, async () => {
  assert.deepEqual(codes(await check('otherpin', MATCH)), [['SOURCE_COMPILER_MISMATCH', null]]);
});

test('a repository whose settings build other code (the optimizer off) stops the listing', { timeout: TIMEOUT }, async () => {
  const r = await check('nooptimizer', MATCH);
  assert.deepEqual(codes(r), [['BYTECODE_MISMATCH', null]]);
  assert.match(r.issues[0].detail, /optimizer on vs off/);
});
