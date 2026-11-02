// The reusable builder workflow (design §8.2 "a reusable GitHub Action", §20 decision 3; node P3b
// acceptance 3): the same builder, no secrets in the build job, the image published by a job of
// its own, signing in a separate job that receives only the build's outputs. Nothing here runs
// it against a registry: the workflow has no trigger of its own (publishing under
// ghcr.io/verdikta is owner gate G1). These tests read its YAML and unit-test the scripts it
// calls; CI also lints it with actionlint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { ACTION_PINS, builderConfig, codeRunnerEnv, registryArgs, signConfig } from '../../action/services.js';
import { exportArgs, inspectArgs, publishArgs, skopeoRun, verifyImageDir } from '../../action/image.js';
import { REGISTRY_IMAGE } from '../docker/helpers.js';
import { contractDraft, draftSpec } from '../helpers/specs.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const FILE = path.join(WORKFLOWS, 'stake-attestation-builder.yml');
const text = fs.readFileSync(FILE, 'utf8');
const wf = parse(text);
const SELF = 'verdikta/verdikta-applications';
const PIN = JSON.parse(fs.readFileSync(new URL('../docker/code-runner.pin.json', import.meta.url), 'utf8'));

const job = (name) => wf.jobs[name];
const steps = (name) => job(name).steps;
const uses = (name, action) => steps(name).filter((s) => String(s.uses ?? '').startsWith(`${action}@`));
const runs = (name) => steps(name).filter((s) => s.run).map((s) => s.run).join('\n');

test('a reusable workflow: it runs only when another workflow calls it, and nothing in this repository does (G1)', () => {
  assert.deepEqual(Object.keys(wf.on), ['workflow_call']);
  const inputs = wf.on.workflow_call.inputs;
  for (const name of ['builder-ref', 'spec', 'publish-repository']) assert.equal(inputs[name].required, true, name);
  assert.equal(inputs['publish-repository'].default, undefined, 'no default registry: the caller names its own');
  assert.equal(inputs.signing.default, 'dev');
  assert.equal(inputs.runtime.default, 'runsc');
  assert.doesNotMatch(text, /ghcr\.io\/verdikta\b/);
  assert.deepEqual(wf.permissions, {}, 'each job asks for what it needs');
  for (const f of fs.readdirSync(WORKFLOWS)) {
    if (f === path.basename(FILE)) continue;
    assert.doesNotMatch(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8'), /uses:\s*['"]?\S*stake-attestation-builder\.yml/, `${f} calls the builder workflow`);
  }
});

test('artifact names are this invocation\'s: a caller may build several listings in one run', () => {
  const names = steps('build').find((s) => s.id === 'names');
  assert.match(names.run, /sha256sum/);
  for (const k of ['SPEC', 'KNOWN_ISSUES', 'PUBLISH_REPOSITORY', 'ARTIFACT_NAME']) assert.ok(names.env[k], k);
  assert.equal(job('build').outputs['artifact-id'], '${{ steps.names.outputs.id }}');
  const all = Object.entries(wf.jobs).flatMap(([n, j]) => j.steps.map((s) => [n, s])).filter(([, s]) => /actions\/(upload|download)-artifact@/.test(String(s.uses ?? '')));
  assert.equal(all.length, 5);
  for (const [n, s] of all) assert.match(s.with.name, n === 'build' ? /^\$\{\{ steps\.names\.outputs\.id \}\}-/ : /^\$\{\{ needs\.build\.outputs\.artifact-id \}\}-/, `${n}: ${s.with.name}`);
  assert.match(wf.on.workflow_call.outputs['signed-artifact'].value, /artifact-id/);
});

test('every upload keeps hidden files: a listing may name its files with a leading dot', () => {
  const uploads = Object.values(wf.jobs).flatMap((j) => j.steps).filter((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.equal(uploads.length, 3);
  for (const u of uploads) assert.equal(u.with['include-hidden-files'], true, u.with.name);
});

test('every action it uses is pinned to a commit', () => {
  for (const [name, j] of Object.entries(wf.jobs)) {
    for (const s of j.steps) if (s.uses) assert.match(s.uses, /^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/, `${name}: ${s.uses}`);
  }
});

test('the build job holds no secret, reads the repositories only, and runs the same builder', () => {
  const b = job('build');
  assert.deepEqual(b.permissions, { contents: 'read' });
  assert.equal(b.environment, undefined);
  const body = JSON.stringify(b);
  assert.doesNotMatch(body, /secrets\./);
  assert.doesNotMatch(body, /github\.token/);
  const checkouts = uses('build', 'actions/checkout');
  assert.equal(checkouts.length, 2);
  for (const c of checkouts) assert.equal(c.with['persist-credentials'], false, 'no token left in .git/config');
  const builder = checkouts.find((c) => c.with.repository === SELF);
  assert.equal(builder.with.ref, '${{ inputs.builder-ref }}');
  // The caller's repository: only the draft and the known issues, not its code (the builder fetches
  // the listed commit itself).
  const caller = checkouts.find((c) => c.with.repository === undefined);
  assert.match(caller.with['sparse-checkout'], /inputs\.spec/);
  assert.equal(caller.with['sparse-checkout-cone-mode'], false);
  const r = runs('build');
  assert.match(r, /bin\/verdikta-build-env\.js" build --config "\$VAB_WORK\/builder\.json"/);
  assert.doesNotMatch(r, /verdikta-build-env\.js"? (sign|scan|run)\b/);
  assert.match(r, /action\/services\.js" start\b/);
  assert.match(r, /action\/image\.js" export --from /);
  assert.match(r, /action\/services\.js" stop\b/);
  // Inputs reach scripts through the environment, never spliced into the script text.
  for (const s of steps('build')) if (s.run) assert.doesNotMatch(s.run, /\$\{\{/, s.name);
  // The build's containers cannot reach the host's metadata services.
  assert.match(r, /DOCKER-USER -d 169\.254\.169\.254/);
  assert.match(r, /DOCKER-USER -d 168\.63\.129\.16/);
});

test('the image is published by a job of its own, which runs none of the maker\'s code', () => {
  const p = job('publish');
  assert.deepEqual([p.needs].flat(), ['build']);
  assert.deepEqual(p.permissions, { contents: 'read', packages: 'write' });
  assert.doesNotMatch(JSON.stringify(p), /secrets\./);
  for (const c of uses('publish', 'actions/checkout')) assert.equal(c.with.repository, SELF);
  const r = runs('publish');
  assert.doesNotMatch(r, /verdikta-build-env/);
  assert.match(r, /action\/image\.js" publish --dir "\$VAB_IMAGE" --image "\$IMAGE" --to "\$PUBLISH_REPOSITORY"/);
  const step = steps('publish').find((x) => /image\.js" publish/.test(x.run ?? ''));
  assert.equal(step.env.IMAGE, '${{ needs.build.outputs.image }}');
  assert.equal(step.env.REGISTRY_TOKEN, '${{ github.token }}', 'the job\'s own token, packages: write');
  const downloads = uses('publish', 'actions/download-artifact');
  assert.deepEqual(downloads.map((d) => d.with.name), ['${{ needs.build.outputs.artifact-id }}-env-image']);
});

test('signing is a separate job that receives only the build\'s outputs and checks them before it signs', () => {
  const s = job('sign');
  assert.deepEqual([s.needs].flat().sort(), ['build', 'publish']);
  assert.equal(s.environment, '${{ inputs.signing-environment }}');
  assert.deepEqual(s.permissions, { contents: 'read' });
  for (const c of uses('sign', 'actions/checkout')) {
    assert.equal(c.with.repository, SELF, 'the builder only, never the caller\'s repository');
    assert.equal(c.with.ref, '${{ inputs.builder-ref }}');
  }
  assert.deepEqual(uses('sign', 'actions/download-artifact').map((d) => d.with.name), ['${{ needs.build.outputs.artifact-id }}-listing']);
  const step = steps('sign').find((x) => /verdikta-build-env\.js" sign\b/.test(x.run ?? ''));
  assert.match(step.run, /--expect-outputs "\$OUTPUTS_SHA256" --check-registry/);
  assert.equal(step.env.OUTPUTS_SHA256, '${{ needs.build.outputs.outputs-sha256 }}');
  assert.match(step.env.VERDIKTA_BUILDER_KEY, /inputs\.signing == 'production' && secrets\.VERDIKTA_BUILDER_KEY/);
  // The only secret the workflow reads, and only in this step.
  const refs = [...text.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(refs)], ['VERDIKTA_BUILDER_KEY']);
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(wf.jobs).filter(([n]) => n !== 'sign'))).includes('secrets.'), false);
  assert.ok(wf.on.workflow_call.secrets.VERDIKTA_BUILDER_KEY.required === false);
});

test('pins: the code-runner the Docker tests run, registry:2 by digest, common\'s gVisor release with its SHA-512', () => {
  assert.equal(ACTION_PINS.codeRunner.commit, PIN.commit);
  assert.equal(ACTION_PINS.codeRunner.repository, PIN.repository);
  assert.equal(ACTION_PINS.registry.image, REGISTRY_IMAGE);
  assert.match(ACTION_PINS.skopeo.image, /^quay\.io\/skopeo\/stable@sha256:[0-9a-f]{64}$/);
  assert.equal(`release-${ACTION_PINS.gvisor.version}`, codeReview.GVISOR_RELEASE);
  assert.match(ACTION_PINS.gvisor.sha512, /^[0-9a-f]{128}$/);
  assert.match(runs('build'), /\.gvisor\.version/);
  assert.match(runs('build'), /sha512sum -c -/);
});

test('services.js writes a build config the builder accepts: a loopback staging registry, the published repository, the local runner', () => {
  const dir = '/tmp/vab-work';
  const raw = builderConfig({ dir, registryPort: 41000, runnerPort: 42000, publishAs: 'ghcr.io/acme/stake-env', spec: draftSpec() });
  const c = parseConfig(raw, { baseDir: dir, env: {} });
  assert.equal(c.registry.repository, '127.0.0.1:41000/stake-env');
  assert.equal(c.registry.publishAs, 'ghcr.io/acme/stake-env');
  assert.equal(c.runner.url, 'http://127.0.0.1:42000');
  assert.equal(raw.runner.tokenFile, path.join(dir, 'runner.token'));
  assert.equal(raw.signing, undefined, 'the build config names no signing key');
  assert.equal(c.explorers.size, 0);
  const contract = builderConfig({ dir, registryPort: 41000, runnerPort: 42000, publishAs: 'ghcr.io/acme/stake-env', spec: contractDraft(), explorerUrl: 'https://base.blockscout.com/api' });
  assert.deepEqual(contract.explorers, { 8453: { apiUrl: 'https://base.blockscout.com/api' } }, 'a keyless explorer: no key in the build job');
  assert.throws(() => builderConfig({ dir, registryPort: 41000, runnerPort: 42000, publishAs: 'ghcr.io/acme/stake-env:latest', spec: draftSpec() }));
  assert.deepEqual(signConfig({ signing: 'dev', publishAs: 'ghcr.io/acme/stake-env' }).signing, { key: 'dev' });
  assert.deepEqual(signConfig({ signing: 'production', publishAs: 'ghcr.io/acme/stake-env' }).signing, { key: { env: 'VERDIKTA_BUILDER_KEY' } });
  assert.throws(() => signConfig({ signing: 'maybe', publishAs: 'ghcr.io/acme/stake-env' }));
});

test('services.js starts registry:2 by digest on loopback, and the code-runner with its own environment only', () => {
  const args = registryArgs({ name: 'vab-registry', port: 41000 });
  assert.equal(args.at(-1), ACTION_PINS.registry.image);
  assert.ok(args.includes('--network') && args[args.indexOf('--network') + 1] === 'host');
  assert.ok(args.includes('REGISTRY_HTTP_ADDR=127.0.0.1:41000'));
  const env = codeRunnerEnv({ token: 't'.repeat(64), port: 42000, runtime: 'runsc', registryHost: '127.0.0.1:41000', stateDir: '/tmp/s', base: { PATH: '/usr/bin', HOME: '/home/runner', GITHUB_TOKEN: 'x', ACTIONS_RUNTIME_TOKEN: 'y', DOCKER_HOST: 'unix:///var/run/docker.sock' } });
  assert.deepEqual(Object.keys(env).sort(), ['CODE_RUNNER_HOST', 'CODE_RUNNER_INSTANCE', 'CODE_RUNNER_PORT', 'CODE_RUNNER_REGISTRY_ALLOWLIST', 'CODE_RUNNER_RUNTIME', 'CODE_RUNNER_STATE_DIR', 'CODE_RUNNER_TOKEN', 'DOCKER_HOST', 'HOME', 'LOG_LEVEL', 'PATH'].sort());
  assert.equal(env.CODE_RUNNER_REGISTRY_ALLOWLIST, '127.0.0.1:41000');
  assert.equal(env.CODE_RUNNER_HOST, '127.0.0.1');
  assert.throws(() => codeRunnerEnv({ token: 't'.repeat(64), port: 42000, runtime: 'kata', registryHost: '127.0.0.1:41000', stateDir: '/tmp/s', base: {} }));
});

/** A skopeo dir: layout holding an index of one linux/amd64 image; returns its folder and digests. */
function imageDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-imagedir-'));
  const put = (bytes, mediaType, name) => {
    const hex = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(dir, name ?? hex), bytes);
    return { mediaType, digest: `sha256:${hex}`, size: bytes.length };
  };
  const layer = put(Buffer.from('layer bytes'), 'application/vnd.docker.image.rootfs.diff.tar.gzip');
  const config = put(Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', rootfs: { type: 'layers', diff_ids: [] } })), 'application/vnd.docker.container.image.v1+json');
  const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', config, layers: [layer] }));
  const hex = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const manifest = put(manifestBytes, 'application/vnd.docker.distribution.manifest.v2+json', `${hex}.manifest.json`);
  const index = put(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json', manifests: [{ ...manifest, platform: { os: 'linux', architecture: 'amd64' } }] })), null, 'manifest.json');
  fs.writeFileSync(path.join(dir, 'version'), 'Directory Transport Version: 1.1\n');
  return { dir, digest: index.digest, layer, manifest };
}

test('image.js: the exported layout verifies only at the digest the build reported, with every manifest and blob intact; Docker schema-2 included', async () => {
  const l = imageDir();
  assert.deepEqual(await verifyImageDir({ dir: l.dir, digest: l.digest }), { digest: l.digest, blobs: 4 });
  await assert.rejects(verifyImageDir({ dir: l.dir, digest: `sha256:${'0'.repeat(64)}` }), /IMAGE_DIGEST_MISMATCH/);
  fs.writeFileSync(path.join(l.dir, l.layer.digest.slice(7)), 'other bytes');
  await assert.rejects(verifyImageDir({ dir: l.dir, digest: l.digest }), /IMAGE_BLOB_CORRUPT/);
  fs.rmSync(path.join(l.dir, 'version'));
  await assert.rejects(verifyImageDir({ dir: l.dir, digest: l.digest }), /IMAGE_DIR_INVALID/);
  fs.rmSync(l.dir, { recursive: true, force: true });
});

test('image.js: skopeo by digest, preserving digests, through its dir layout; plain HTTP only to a loopback registry; the token only in an auth file', () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  const run = skopeoRun({ mounts: [['/tmp/img', '/image', 'ro']], args: ['inspect'], uid: 1001, gid: 118 });
  assert.equal(run[run.indexOf('--user') + 1], '1001:118');
  assert.ok(run.includes(ACTION_PINS.skopeo.image));
  assert.deepEqual(exportArgs(`127.0.0.1:41000/stake-env@${digest}`), ['copy', '--quiet', '--all', '--preserve-digests', '--src-tls-verify=false', `docker://127.0.0.1:41000/stake-env@${digest}`, 'dir:/image']);
  assert.throws(() => exportArgs('127.0.0.1:41000/stake-env:latest'));
  assert.deepEqual(publishArgs({ digest, to: 'ghcr.io/acme/stake-env', authfile: '/auth/auth.json' }), ['copy', '--quiet', '--all', '--preserve-digests', '--dest-authfile', '/auth/auth.json', 'dir:/image', `docker://ghcr.io/acme/stake-env:listing-${'d'.repeat(64)}`]);
  assert.deepEqual(inspectArgs(`ghcr.io/acme/stake-env@${digest}`), ['inspect', '--raw', '--no-creds', `docker://ghcr.io/acme/stake-env@${digest}`]);
  assert.doesNotMatch(fs.readFileSync(new URL('../../action/image.js', import.meta.url), 'utf8'), /--(dest-)?creds\b/, 'no credential on a command line');
});

test('CI lints this workflow with a pinned actionlint, and runs the app\'s checks when it changes', () => {
  const ci = parse(fs.readFileSync(path.join(WORKFLOWS, 'stake-attestation.yml'), 'utf8'));
  assert.ok(ci.on.pull_request.paths.includes('.github/workflows/stake-attestation-builder.yml'));
  const all = Object.values(ci.jobs).flatMap((j) => j.steps).filter((s) => s.run).map((s) => s.run).join('\n');
  assert.match(all, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
  assert.match(all, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/);
  assert.match(all, /actionlint[^\n]*\.github\/workflows\/stake-attestation-builder\.yml/);
  assert.match(all, /check-forbidden-words\.js[^\n]*\.github\/workflows\/stake-attestation-builder\.yml/);
});
