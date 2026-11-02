// Acceptance 2 against real images: for a contract listing, the recorded explorer responses for
// the deployment (test/fixtures/explorer; no explorer is ever called live) are compared with the
// listed commit's files, read from the objects the builder fetched, and with the verified input
// compiled by solc 0.8.31 from binaries.soliditylang.org (checked against its list.json SHA-256)
// in a sandbox of the pinned base image.
//
// The adversarial listing: its setup rewrites the tracked src/Vault.sol in /repo into the
// explorer's edited version and installs a fake `solc` in the image's tools. The check reads
// neither: the listing is still refused, and the compiler is the Solidity project's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { createDocker, runSandboxed } from '../../src/docker.js';
import { createExplorer } from '../../src/explorer.js';
import { buildEnvImage, verifiedSourceDeps } from '../../src/pipeline.js';
import { newReport } from '../../src/report.js';
import { checkVerifiedSource } from '../../src/sourceCheck.js';
import { recordedExplorer } from '../helpers/fakes.js';
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
const docker = createDocker({});
let regs;
let repo;
let config;
const images = {};

async function build(name, draft) {
  images[name] = { draft, image: await buildEnvImage({ draft, config, report: newReport({ draft }), workDir: fs.mkdtempSync(path.join(dir, 'w-')) }) };
}

test.before(async () => {
  regs = await startRegistries(id);
  repo = fixtureRepo(dir);
  const honest = fixtureDraft(repo.baseCommit, recipient, { artifact: CONTRACT });
  config = parseConfig({
    registry: { repository: `${regs.host}/${id}/env`, apiUrl: regs.apiUrl },
    runner: { url: 'http://127.0.0.1:1', tokenEnv: 'UNUSED' },
    platforms,
    repoMirrors: { [honest.repo]: repo.mirror },
    solc: { cacheDir: path.join(dir, 'solc') },
  }, { baseDir: dir, env: {} });
  await build('honest', honest);
  const tampered = fixtureDraft(repo.baseCommit, recipient, { artifact: CONTRACT });
  tampered.commands.setup = [
    "sed -i 's/amount + 1/amount/' src/Vault.sol",
    'mkdir -p "$VERDIKTA_TOOLS/bin"',
    "printf '#!/bin/sh\\necho fake-solc\\n' > \"$VERDIKTA_TOOLS/bin/solc\"",
    'chmod 0755 "$VERDIKTA_TOOLS/bin/solc"',
  ].join(' && ');
  await build('tampered', tampered);
});

test.after(() => {
  if (regs) removeImages(`${regs.host}/${id}/env`);
  regs?.remove();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function check(name, routes) {
  const { draft, image } = images[name];
  const rec = recordedExplorer(routes);
  const explorer = createExplorer({ apiUrl: rec.apiUrl, apiKey: null, chainId: 8453, fetch: rec.fetch, timeoutMs: 5000 });
  const real = verifiedSourceDeps({ config, docker, draft, workDir: fs.mkdtempSync(path.join(dir, 's-')) });
  const readFiles = (req) => real.readFiles({ ...req, baseCommit: draft.baseCommit, gitDir: image.gitDir, image: image.ref });
  return checkVerifiedSource({ spec: draft, explorer, readFiles, compile: real.compile });
}

test('the verified source is the listed commit\'s, and compiled as verified by the checksummed solc it is the deployed code', { timeout: TIMEOUT }, async () => {
  const r = await check('honest', { getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault.json' });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.summary.bytecode, 'match');
  assert.equal(r.summary.metadata, 'match', 'same files and settings: even the metadata hash agrees');
  assert.deepEqual(r.summary.contract, { path: 'src/Vault.sol', name: 'Vault' });
  assert.deepEqual(r.summary.solc, { version: '0.8.31+commit.fd3a2265', sha256: SOLC_SHA256[platforms.run], platform: platforms.run });
});

test('a verified source that is not the listed commit stops the listing', { timeout: TIMEOUT }, async () => {
  const r = await check('honest', { getsourcecode: 'getsourcecode-vault-edited.json', getcode: 'getcode-vault.json' });
  assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['SOURCE_FILE_MISMATCH', 'src/Vault.sol']]);
});

test('deployed code the verified compile does not reproduce stops the listing', { timeout: TIMEOUT }, async () => {
  const r = await check('honest', { getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault-other.json' });
  assert.deepEqual(r.issues.map((i) => i.code), ['BYTECODE_MISMATCH']);
});

test('a setup that rewrites the tracked source and plants a solc cannot pass: the check reads neither', { timeout: TIMEOUT }, async () => {
  const { image } = images.tampered;
  // The attack is in place: the image's work tree holds the explorer's edited source, and a fake solc.
  const look = await runSandboxed({ docker, image: image.ref, platform: platforms.run, argv: ['/bin/sh', '-c', 'grep -c "amount + 1" /repo/src/Vault.sol; solc'], timeoutMs: 60000 });
  assert.deepEqual(look.stdout.toString().trim().split('\n'), ['0', 'fake-solc']);
  // The explorer verified the edited source: it still does not match the listed commit.
  const r = await check('tampered', { getsourcecode: 'getsourcecode-vault-edited.json', getcode: 'getcode-vault.json' });
  assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['SOURCE_FILE_MISMATCH', 'src/Vault.sol']]);
  // And the honest verification compiles with the Solidity project's solc, not the planted one.
  const ok = await check('tampered', { getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault.json' });
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.equal(ok.summary.solc.sha256, SOLC_SHA256[platforms.run]);
});
