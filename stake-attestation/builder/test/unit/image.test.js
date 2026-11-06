// Acceptance 1 (build, push, measure): the image is built for linux/amd64 with no secret, build
// argument or host network, pushed to the configured registry, read back by digest, and refused
// above 2 GB compressed or 6 GB unpacked (the class's limits from @verdikta/common).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codeReview } from '../../src/common.js';
import { buildImage, pushImage, unpackedBytes, imageSizeIssues, imageLimits } from '../../src/image.js';
import { createRegistryClient } from '../../src/registry.js';
import { fakeDocker, fakeRegistry, registryImage } from '../helpers/fakes.js';

const PUSHED = `digest: sha256:${'1'.repeat(64)} size: 1234`;

test('the build is a linux/amd64 image with no secret, ssh agent, build argument or host network', async () => {
  const docker = fakeDocker();
  await buildImage({ docker, contextDir: '/ctx', tag: 'ghcr.io/verdikta/stake-env:abc', platforms: ['linux/amd64'], timeoutMs: 1000 });
  const [{ args, opts }] = docker.calls;
  assert.equal(args[0], 'build');
  assert.deepEqual(args.slice(args.indexOf('--platform'), args.indexOf('--platform') + 2), ['--platform', 'linux/amd64']);
  assert.ok(args.includes('--provenance=false') && args.includes('--sbom=false'), 'a plain image manifest, no attestation manifests');
  assert.deepEqual(args.slice(args.indexOf('--tag'), args.indexOf('--tag') + 2), ['--tag', 'ghcr.io/verdikta/stake-env:abc']);
  for (const banned of ['--secret', '--ssh', '--build-arg', '--network=host', 'host', '--allow', '--privileged']) {
    assert.ok(!args.includes(banned), banned);
  }
  assert.equal(args[args.length - 1], '/ctx');
  assert.equal(opts.timeoutMs, 1000);
});

test('a dev build adds its extra platforms to the same image index', async () => {
  const docker = fakeDocker();
  await buildImage({ docker, contextDir: '/ctx', tag: 't:1', platforms: ['linux/amd64', 'linux/arm64'], timeoutMs: 1000 });
  const args = docker.calls[0].args;
  assert.equal(args[args.indexOf('--platform') + 1], 'linux/amd64,linux/arm64');
});

test('a failed build is the listing\'s refusal, with the end of its log for the maker', async () => {
  const docker = fakeDocker(() => ({ exitCode: 1, stderr: `${'x'.repeat(100000)}\nsetup.sh: forge: not found\n` }));
  await assert.rejects(buildImage({ docker, contextDir: '/ctx', tag: 't:1', platforms: ['linux/amd64'], timeoutMs: 1000 }), (err) => {
    assert.equal(err.code, 'IMAGE_BUILD_FAILED');
    assert.equal(err.refusal, true);
    assert.match(err.log, /forge: not found/);
    assert.ok(err.log.length <= 32 * 1024 + 200, 'the log is cut to its tail');
    return true;
  });
});

test('the push names the digest the registry stored', async () => {
  const docker = fakeDocker((args) => (args[0] === 'push' ? { stdout: `abc: Pushed\n${PUSHED}\n` } : {}));
  const out = await pushImage({ docker, tag: '127.0.0.1:5000/env:t', timeoutMs: 1000 });
  assert.equal(out.digest, `sha256:${'1'.repeat(64)}`);
  assert.deepEqual(docker.calls[0].args, ['push', '127.0.0.1:5000/env:t']);
  const bad = fakeDocker(() => ({ stdout: 'pushed, no digest line\n' }));
  await assert.rejects(pushImage({ docker: bad, tag: 't', timeoutMs: 1000 }), { code: 'IMAGE_PUSH_FAILED' });
});

test('the unpacked size is the sum of the layer sizes the daemon lists, as the code-runner measures it', async () => {
  const docker = fakeDocker((args) => (args[0] === 'history' ? { stdout: '100\n0\n2500\n' } : {}));
  assert.equal(await unpackedBytes({ docker, ref: 'img@sha256:' + 'a'.repeat(64), platform: 'linux/amd64', timeoutMs: 1000 }), 2600);
  assert.deepEqual(docker.calls[0].args, ['history', '--platform', 'linux/amd64', '--human=false', '--no-trunc', '--format', '{{.Size}}', 'img@sha256:' + 'a'.repeat(64)]);
  const junk = fakeDocker(() => ({ stdout: '12MB\n' }));
  await assert.rejects(unpackedBytes({ docker: junk, ref: 'x', platform: 'linux/amd64', timeoutMs: 1000 }), { code: 'IMAGE_SIZE_UNKNOWN' });
});

test('the registry answer: compressed size of the linux/amd64 manifest, its config, verified against the digest', async () => {
  const image = registryImage({ platforms: { 'linux/amd64': [700, 300], 'linux/arm64': [9000] } });
  const srv = await fakeRegistry({ name: 'verdikta/env', image });
  try {
    const reg = createRegistryClient({ repository: `127.0.0.1:${srv.port}/verdikta/env` });
    const info = await reg.imageInfo(image.digest, 'linux/amd64');
    const amd64 = image.manifests.find((m) => m.platform.architecture === 'amd64');
    assert.equal(info.digest, image.digest);
    assert.equal(info.manifestDigest, amd64.digest);
    const configSize = JSON.parse(image.blobs.get(amd64.digest).bytes).config.size;
    assert.equal(info.compressedBytes, 700 + 300 + configSize);
    assert.deepEqual(info.platforms.sort(), ['linux/amd64', 'linux/arm64']);
    assert.equal(info.config.os, 'linux');
    assert.equal(info.config.architecture, 'amd64');
    assert.deepEqual(info.volumes, []);
    await assert.rejects(reg.imageInfo(image.digest, 'linux/s390x'), { code: 'IMAGE_PLATFORM_MISSING' });
  } finally {
    await srv.close();
  }
});

test('the registry\'s bytes must hash to the digest asked for', async () => {
  const image = registryImage();
  const srv = await fakeRegistry({ name: 'env', image, tamper: (_d, bytes) => Buffer.concat([bytes, Buffer.from(' ')]) });
  try {
    const reg = createRegistryClient({ repository: `127.0.0.1:${srv.port}/env` });
    await assert.rejects(reg.imageInfo(image.digest, 'linux/amd64'), { code: 'REGISTRY_DIGEST_MISMATCH' });
  } finally {
    await srv.close();
  }
});

test('a public registry\'s anonymous bearer token is fetched and used', async () => {
  const image = registryImage();
  const srv = await fakeRegistry({ name: 'verdikta/env', image, token: 'anon-123' });
  try {
    const reg = createRegistryClient({ repository: `127.0.0.1:${srv.port}/verdikta/env` });
    const info = await reg.imageInfo(image.digest, 'linux/amd64');
    assert.equal(info.manifestDigest, image.digest);
    assert.ok(srv.requests.some((r) => r.url.startsWith('/token?') && r.url.includes('scope=repository%3Averdikta%2Fenv%3Apull')));
  } finally {
    await srv.close();
  }
});

test('an image whose config declares volumes is reported, so the listing can be refused', async () => {
  const image = registryImage({ volumes: { '/data': {} } });
  const srv = await fakeRegistry({ name: 'env', image });
  try {
    const info = await createRegistryClient({ repository: `127.0.0.1:${srv.port}/env` }).imageInfo(image.digest, 'linux/amd64');
    assert.deepEqual(info.volumes, ['/data']);
  } finally {
    await srv.close();
  }
});

test('plain HTTP only for a loopback registry; https everywhere else', () => {
  assert.equal(createRegistryClient({ repository: 'ghcr.io/verdikta/env' }).baseUrl, 'https://ghcr.io');
  assert.equal(createRegistryClient({ repository: '127.0.0.1:5000/env' }).baseUrl, 'http://127.0.0.1:5000');
  assert.equal(createRegistryClient({ repository: '127.0.0.1:5000/env', apiUrl: 'http://127.0.0.1:6000' }).baseUrl, 'http://127.0.0.1:6000');
  assert.throws(() => createRegistryClient({ repository: 'ghcr.io/verdikta/env', apiUrl: 'http://ghcr.io' }), /loopback/);
});

test('2 GB compressed and 6 GB unpacked, from the class limits; config may only lower them', () => {
  const limits = imageLimits();
  assert.equal(limits.imageCompressedBytes, codeReview.CLASS_HARD_LIMITS.imageCompressedBytes);
  assert.equal(limits.imageCompressedBytes, 2000000000);
  assert.equal(limits.imageUnpackedBytes, 6000000000);
  assert.deepEqual(imageSizeIssues({ compressedBytes: 2000000000, unpackedBytes: 6000000000 }, limits), []);
  assert.deepEqual(imageSizeIssues({ compressedBytes: 2000000001, unpackedBytes: 1 }, limits).map((i) => i.code), ['IMAGE_COMPRESSED_TOO_LARGE']);
  assert.deepEqual(imageSizeIssues({ compressedBytes: 1, unpackedBytes: 6000000001 }, limits).map((i) => i.code), ['IMAGE_UNPACKED_TOO_LARGE']);
  assert.deepEqual(imageSizeIssues({ unpackedBytes: 6000000001 }, limits).map((i) => i.code), ['IMAGE_UNPACKED_TOO_LARGE'], 'before the push, unpacked only');
  assert.equal(imageLimits({ imageUnpackedBytes: 100 }).imageUnpackedBytes, 100);
  assert.throws(() => imageLimits({ imageCompressedBytes: 2000000001 }), /class/);
});
