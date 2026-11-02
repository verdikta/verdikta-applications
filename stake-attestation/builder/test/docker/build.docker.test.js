// Acceptance 1 against a real daemon and registry:2: the env image is built FROM the foundry base
// pinned in @verdikta/common, holds the listed commit at /repo (uid 10001, with its objects),
// ran the maker's setup with network at build time only, is linux/amd64, is pushed to the
// configured registry, and is refused above the size limits.
//
// On an arm64 daemon without amd64 emulation (Apple silicon), the image is an index of
// linux/amd64 and linux/arm64 (config `platforms.extra`), the setup stage runs natively on arm64
// and the image is run as its arm64 variant; the linux/amd64 variant is built and pushed all the
// same (its final stage runs nothing, so it needs no emulation). On amd64 everything is amd64.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { createDocker, runSandboxed } from '../../src/docker.js';
import { buildEnvImage } from '../../src/pipeline.js';
import { newReport } from '../../src/report.js';
import { docker, fixtureDraft, fixtureRepo, newId, removeImages, startRegistries, testPlatforms } from './helpers.js';

const TIMEOUT = 1800000;
const id = newId();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
const platforms = testPlatforms();
let regs;
let repo;
let repository;
const recipient = codeReview.generateDisclosureKeyPair().recipient;

function config(over = {}) {
  return parseConfig({
    registry: { repository, apiUrl: regs.apiUrl },
    runner: { url: 'http://127.0.0.1:1', tokenEnv: 'UNUSED' },
    platforms,
    repoMirrors: { 'https://github.com/verdikta-test/vault-fixture': repo.mirror },
    workDir: path.join(dir, 'work'),
    ...over,
  }, { baseDir: dir, env: {} });
}

async function buildOnce(over) {
  const draft = fixtureDraft(repo.baseCommit, recipient);
  const report = newReport({ draft });
  const image = await buildEnvImage({ draft, config: config(over), report, workDir: fs.mkdtempSync(path.join(dir, 'w-')) });
  return { image, report };
}

async function manifest(name, ref) {
  const r = await fetch(`${regs.apiUrl}/v2/${name}/manifests/${ref}`, {
    headers: { accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
  });
  assert.equal(r.status, 200, `${name}@${ref}`);
  return r.json();
}

async function blob(name, digest) {
  return (await fetch(`${regs.apiUrl}/v2/${name}/blobs/${digest}`)).json();
}

async function tags(name) {
  const r = await fetch(`${regs.apiUrl}/v2/${name}/tags/list`);
  return r.status === 200 ? (await r.json()).tags || [] : [];
}

test.before(async () => {
  regs = await startRegistries(id);
  repository = `${regs.host}/${id}/env`;
  repo = fixtureRepo(dir);
});

test.after(() => {
  if (repository) removeImages(repository);
  regs?.remove();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('built FROM the pinned foundry base, linux/amd64, pushed to the registry by digest', { timeout: TIMEOUT }, async () => {
  const { image, report } = await buildOnce();
  const name = `${id}/env`;
  assert.match(image.ref, new RegExp(`^${repository.replace(/[.]/g, '\\.')}@sha256:[0-9a-f]{64}$`));
  assert.equal(image.platform, 'linux/amd64');
  assert.ok(image.compressedBytes > 0 && image.unpackedBytes > image.compressedBytes, JSON.stringify(image));
  const top = await manifest(name, image.digest);
  // The linux/amd64 manifest the arbiters pull, and (dev) the arm64 one beside it.
  const amd64 = top.manifests ? top.manifests.find((m) => m.platform.architecture === 'amd64' && m.platform.os === 'linux') : { digest: image.digest };
  assert.ok(amd64, JSON.stringify(top));
  if (platforms.extra.length) assert.ok(top.manifests.some((m) => m.platform.architecture === 'arm64'));
  else assert.equal(top.manifests, undefined, 'a single linux/amd64 manifest in production');
  const m = await manifest(name, amd64.digest);
  const cfg = await blob(name, m.config.digest);
  assert.equal(cfg.architecture, 'amd64');
  assert.equal(cfg.os, 'linux');
  assert.ok(!cfg.config.Volumes || Object.keys(cfg.config.Volumes).length === 0, 'the image declares no VOLUME');
  // FROM the pinned base: its layers come first, unchanged.
  const pin = codeReview.BASE_IMAGE_PINS.foundry;
  const baseRef = `${pin.repository}@${pin.digest}`;
  if (docker(['image', 'inspect', baseRef], { allowFail: true }).status !== 0) docker(['pull', '--platform', 'linux/amd64', baseRef]);
  const base = JSON.parse(docker(['image', 'inspect', '--format', '{{json .RootFS.Layers}}', baseRef]).stdout);
  assert.deepEqual(cfg.rootfs.diff_ids.slice(0, base.length), base);
  assert.equal(cfg.rootfs.diff_ids.length, base.length + 2, 'two layers on top: the tools and /repo');
  assert.equal(report.image.base, platforms.extra.length ? `${pin.repository}:${pin.version}@${pin.indexDigest}` : pin.reference);
});

test('the image meets the code-runner\'s contract, and the maker\'s setup had network only at build time', { timeout: TIMEOUT }, async () => {
  const { image } = await buildOnce();
  const script = [
    'set -e',
    'echo "owner=$(stat -c %u /repo)"',
    'echo "git=$(stat -c %F /repo/.git)"',
    `echo "commit=$(git -C /repo cat-file -t ${repo.baseCommit})"`,
    'echo "setupRoutes=$(cat /repo/setup-routes.txt)"',
    'echo "runRoutes=$(tail -n +2 /proc/net/route | grep -c .)"',
    'echo "solc=$(find /opt/verdikta/tools -type f -name "solc*" | head -1)"',
    'echo "home=$(ls -A "$HOME" | wc -l)"',
    'sh=$(readlink -f /bin/sh); d=$sh; while [ "$d" != / ]; do [ -w "$d" ] && echo "writable=$d"; [ "$(stat -c %u "$d")" = 0 ] || echo "notroot=$d"; d=$(dirname "$d"); done',
    'echo "sh=$sh"',
  ].join('\n');
  const r = await runSandboxed({ docker: createDocker({}), image: image.ref, platform: platforms.run, argv: ['/bin/sh', '-c', script], timeoutMs: 120000 });
  assert.equal(r.exitCode, 0, r.stderr.toString());
  const out = Object.fromEntries(r.stdout.toString().trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.equal(out.owner, '10001', 'the repository belongs to the sandbox user');
  assert.equal(out.git, 'directory', '.git is a real directory');
  assert.equal(out.commit, 'commit', 'the listed commit\'s objects are in the image');
  assert.ok(Number(out.setupRoutes) >= 1, `the setup ran with a network (${out.setupRoutes} routes)`);
  assert.equal(out.runRoutes, '0', 'run by the builder, the image has no route out');
  assert.match(out.solc, /^\/opt\/verdikta\/tools\/share\/svm\//, 'solc lives outside $HOME and /tmp');
  assert.equal(out.home, '0', '$HOME starts empty');
  assert.equal(out.writable, undefined, 'uid 10001 cannot write /bin/sh or a directory on its path');
  assert.equal(out.notroot, undefined, '/bin/sh and its directories belong to root');
});

test('above the unpacked limit the image is refused before it is pushed', { timeout: TIMEOUT }, async () => {
  const before = await tags(`${id}/env`);
  await assert.rejects(buildOnce({ limits: { imageUnpackedBytes: 100000000 } }), (err) => {
    assert.equal(err.code, 'IMAGE_UNPACKED_TOO_LARGE');
    assert.match(err.detail, /100000000/);
    return true;
  });
  assert.deepEqual(await tags(`${id}/env`), before, 'nothing new was pushed');
});

test('above the compressed limit the pushed image is refused', { timeout: TIMEOUT }, async () => {
  await assert.rejects(buildOnce({ limits: { imageCompressedBytes: 1000000 } }), (err) => {
    assert.equal(err.code, 'IMAGE_COMPRESSED_TOO_LARGE');
    assert.match(err.detail, /1000000/);
    return true;
  });
});
