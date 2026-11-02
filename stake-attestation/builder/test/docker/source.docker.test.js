// Acceptance 2 against a real image: for a contract listing, the fixture is compiled at baseCommit
// inside its env image (no network, the sandbox user, read-only root), and the recorded explorer
// responses for the deployment (test/fixtures/explorer) are compared with those files and that
// compile. No explorer is ever called live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { createDocker } from '../../src/docker.js';
import { createExplorer } from '../../src/explorer.js';
import { buildEnvImage } from '../../src/pipeline.js';
import { newReport } from '../../src/report.js';
import { checkVerifiedSource, collectFromImage } from '../../src/sourceCheck.js';
import { recordedExplorer } from '../helpers/fakes.js';
import { fixtureDraft, fixtureRepo, newId, removeImages, startRegistries, testPlatforms } from './helpers.js';

const TIMEOUT = 1800000;
const id = newId();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
const platforms = testPlatforms();
const recipient = codeReview.generateDisclosureKeyPair().recipient;
let regs;
let repo;
let image;
let draft;

test.before(async () => {
  regs = await startRegistries(id);
  repo = fixtureRepo(dir);
  draft = fixtureDraft(repo.baseCommit, recipient, { artifact: { kind: 'contract', address: '0x5f2A00000000000000000000000000000000C0dE', chainId: 8453 } });
  const config = parseConfig({
    registry: { repository: `${regs.host}/${id}/env`, apiUrl: regs.apiUrl },
    runner: { url: 'http://127.0.0.1:1', tokenEnv: 'UNUSED' },
    platforms,
    repoMirrors: { [draft.repo]: repo.mirror },
  }, { baseDir: dir, env: {} });
  image = await buildEnvImage({ draft, config, report: newReport({ draft }), workDir: fs.mkdtempSync(path.join(dir, 'w-')) });
});

test.after(() => {
  if (regs) removeImages(`${regs.host}/${id}/env`);
  regs?.remove();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function check(routes) {
  const rec = recordedExplorer(routes);
  const explorer = createExplorer({ apiUrl: rec.apiUrl, apiKey: null, chainId: 8453, fetch: rec.fetch, timeoutMs: 5000 });
  const docker = createDocker({});
  const collect = (req) => collectFromImage({ docker, image: image.ref, platform: platforms.run, timeoutMs: 300000, ...req });
  return checkVerifiedSource({ spec: draft, explorer, collect });
}

test('the verified source and deployed code match the fixture compiled at baseCommit in its image', { timeout: TIMEOUT }, async () => {
  const r = await check({ getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault.json' });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.summary.bytecode, 'match');
  assert.equal(r.summary.metadata, 'match', 'same files and settings: even the metadata hash agrees');
  assert.deepEqual(r.summary.contract, { path: 'src/Vault.sol', name: 'Vault' });
});

test('a verified source that is not the repository at baseCommit stops the listing', { timeout: TIMEOUT }, async () => {
  const r = await check({ getsourcecode: 'getsourcecode-vault-edited.json', getcode: 'getcode-vault.json' });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'SOURCE_FILE_MISMATCH' && i.path === 'src/Vault.sol'), JSON.stringify(r.issues));
});

test('deployed code the compile at baseCommit does not reproduce stops the listing', { timeout: TIMEOUT }, async () => {
  const r = await check({ getsourcecode: 'getsourcecode-vault.json', getcode: 'getcode-vault-other.json' });
  assert.deepEqual(r.issues.map((i) => i.code), ['BYTECODE_MISMATCH']);
});
