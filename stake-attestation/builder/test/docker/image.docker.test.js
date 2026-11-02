// The reusable builder workflow's image hand-off, run here with the same script and the same
// pinned skopeo against two throwaway registry:2 (no GHCR: that is owner gate G1): an image as
// `docker push` writes it (a Docker schema-2 manifest), the same image re-encoded as OCI, and a
// multi-platform index are exported from the build job's registry into skopeo's dir layout,
// checked, and pushed to the "published" registry at the same digest, then read back without a
// credential. A corrupted layout is refused before anything is pushed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { exportImage, inspectArgs, publishImage, skopeoRun, verifyImageDir } from '../../action/image.js';
import { REGISTRY_IMAGE, docker, newId, startRegistries } from './helpers.js';

const TIMEOUT = 1800000;
const id = newId();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
let staging;
let published;

/** The digest of `ref`'s top manifest as its registry serves it. */
function digestOf(ref) {
  const r = docker(skopeoRun({ mounts: [], args: ['inspect', '--raw', '--tls-verify=false', `docker://${ref}`] }));
  return `sha256:${crypto.createHash('sha256').update(r.stdout).digest('hex')}`;
}

function mediaTypeOf(ref) {
  return JSON.parse(docker(skopeoRun({ mounts: [], args: ['inspect', '--raw', '--tls-verify=false', `docker://${ref}`] })).stdout).mediaType;
}

test.before(async () => {
  staging = await startRegistries(`${id}a`);
  published = await startRegistries(`${id}b`);
  const ctx = path.join(dir, 'ctx');
  fs.mkdirSync(ctx);
  fs.writeFileSync(path.join(ctx, 'Dockerfile'), `FROM ${REGISTRY_IMAGE}\nLABEL io.verdikta.listing.base-commit="${'a'.repeat(40)}"\n`);
  const tag = `${staging.host}/${id}/env:built`;
  docker(['build', '--quiet', '--provenance=false', '--tag', tag, ctx]);
  docker(['push', '--quiet', tag]);
  docker(['image', 'rm', tag], { allowFail: true });
  const copy = (args) => docker(skopeoRun({ mounts: [], args: ['copy', '--quiet', '--src-tls-verify=false', '--dest-tls-verify=false', ...args] }));
  copy(['--format', 'v2s2', `docker://${tag}`, `docker://${staging.host}/${id}/env:v2s2`]);
  copy(['--format', 'oci', `docker://${tag}`, `docker://${staging.host}/${id}/env:oci`]);
  copy(['--all', '--preserve-digests', `docker://docker.io/library/${REGISTRY_IMAGE}`, `docker://${staging.host}/${id}/multi:index`]);
});

test.after(() => {
  staging?.remove();
  published?.remove();
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const [name, tag, mediaType] of [
  ['a Docker schema-2 image, as docker push writes it', 'env:v2s2', 'application/vnd.docker.distribution.manifest.v2+json'],
  ['an OCI image', 'env:oci', 'application/vnd.oci.image.manifest.v1+json'],
  ['a multi-platform index', 'multi:index', 'application/vnd.oci.image.index.v1+json'],
]) {
  test(`${name}: exported, checked and published at the same digest, readable without a credential`, { timeout: TIMEOUT }, async () => {
    const repo = tag.split(':')[0];
    const from = `${staging.host}/${id}/${repo}:${tag.split(':')[1]}`;
    assert.equal(mediaTypeOf(from), mediaType);
    const digest = digestOf(from);
    const out = path.join(dir, `layout-${repo}-${tag.split(':')[1]}`);
    const exported = await exportImage({ from: `${staging.host}/${id}/${repo}@${digest}`, dir: out });
    assert.equal(exported.digest, digest);
    assert.ok(exported.blobs >= 3);

    const to = `${published.host}/${id}/${repo}`;
    const r = await publishImage({ dir: out, image: `${to}@${digest}`, to, env: {} });
    assert.deepEqual(r, { digest, to });
    const back = docker(skopeoRun({ mounts: [], args: inspectArgs(`${to}@${digest}`) })).stdout;
    assert.equal(`sha256:${crypto.createHash('sha256').update(back).digest('hex')}`, digest);
  });
}

test('a layout whose bytes changed after the export is refused before anything is pushed', { timeout: TIMEOUT }, async () => {
  const from = `${staging.host}/${id}/env:v2s2`;
  const digest = digestOf(from);
  const out = path.join(dir, 'layout-tampered');
  await exportImage({ from: `${staging.host}/${id}/env@${digest}`, dir: out });
  const layer = fs.readdirSync(out).filter((f) => /^[0-9a-f]{64}$/.test(f)).map((f) => path.join(out, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  fs.appendFileSync(layer, 'x');
  await assert.rejects(verifyImageDir({ dir: out, digest }), /IMAGE_BLOB_CORRUPT/);
  const to = `${published.host}/${id}/tampered`;
  await assert.rejects(publishImage({ dir: out, image: `${to}@${digest}`, to, env: {} }), /IMAGE_BLOB_CORRUPT/);
  const probe = spawnSync('docker', skopeoRun({ mounts: [], args: inspectArgs(`${to}@${digest}`) }), { encoding: 'utf8' });
  assert.notEqual(probe.status, 0, 'nothing was pushed');
});
