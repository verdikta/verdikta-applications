// Acceptance 1 (the image's recipe): FROM the foundry base pinned in @verdikta/common, the listed
// commit checked out, the maker's setup with network in the build stage only, a linux/amd64
// image whose final stage runs nothing and meets the code-runner's image contract
// (verdikta-arbiter code-runner/README.md, "What the env image (P3a) must provide").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { IMAGE_LAYOUT, baseImageRefs, renderDockerfile, writeBuildContext } from '../../src/dockerfile.js';

const SHA = '7f3a9c0d1e2b3a4c5d6e7f8091a2b3c4d5e6f708';
const PIN = codeReview.BASE_IMAGE_PINS.foundry;

function stages(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('FROM ')) out.push({ from: line, lines: [] });
    else if (out.length && line.trim() && !line.startsWith('#')) out[out.length - 1].lines.push(line);
  }
  return out;
}

function render(over = {}) {
  const platforms = { setup: 'linux/amd64', extra: [], ...over.platforms };
  return renderDockerfile({ baseCommit: SHA, hasSetup: true, refs: baseImageRefs(platforms), platforms, builderVersion: '0.1.0', ...over });
}

test('both stages start FROM the foundry base pinned in @verdikta/common, by its linux/amd64 digest', () => {
  const refs = baseImageRefs({ setup: 'linux/amd64', extra: [] });
  assert.equal(refs.setup, `${PIN.repository}@${PIN.digest}`);
  assert.equal(refs.final, `${PIN.repository}@${PIN.digest}`);
  assert.equal(refs.attested, PIN.reference, 'attestation.json names the pinned reference');
  const [setup, final] = stages(render());
  assert.equal(setup.from, `FROM --platform=linux/amd64 ${PIN.repository}@${PIN.digest} AS setup`);
  assert.equal(final.from, `FROM ${PIN.repository}@${PIN.digest}`);
});

test('a dev build for another platform uses the pinned multi-platform index, never an unpinned tag', () => {
  const platforms = { setup: 'linux/arm64', extra: ['linux/arm64'] };
  const refs = baseImageRefs(platforms);
  assert.equal(refs.setup, `${PIN.repository}@${PIN.indexDigest}`);
  assert.equal(refs.final, `${PIN.repository}@${PIN.indexDigest}`);
  assert.equal(refs.attested, `${PIN.repository}:${PIN.version}@${PIN.indexDigest}`);
  const [setup] = stages(render({ platforms }));
  assert.equal(setup.from, `FROM --platform=linux/arm64 ${PIN.repository}@${PIN.indexDigest} AS setup`);
  assert.throws(() => baseImageRefs({ setup: 'linux/riscv64', extra: [] }), /platform/);
});

test('the setup stage checks out exactly the listed commit and its submodules, then runs the maker\'s setup in /repo', () => {
  const [setup] = stages(render());
  const body = setup.lines.join('\n');
  assert.match(body, /^USER root$/m);
  assert.match(body, /^COPY repo\.git \/repo\/\.git$/m);
  assert.ok(body.includes(`checkout --quiet --force --detach ${SHA}`), 'checks out baseCommit');
  assert.match(body, /submodule update --init --recursive/);
  assert.match(body, /cd \/repo && \/bin\/sh -e \/verdikta-build\/setup\.sh/);
  // HOME during setup is a build-only directory, never carried into the image.
  assert.match(body, /HOME=\/verdikta-build\/home/);
  assert.match(body, new RegExp(`XDG_DATA_HOME=${IMAGE_LAYOUT.xdgData}`));
});

test('the maker\'s setup command is a file in the context, never Dockerfile text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-ctx-'));
  const gitDir = path.join(dir, 'fetched.git');
  fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
  const setup = 'forge install\nFROM scratch\nCOPY / /stolen\nRUN curl evil';
  const ctx = path.join(dir, 'ctx');
  const { dockerfile } = writeBuildContext({ dir: ctx, gitDir, setup, baseCommit: SHA, platforms: { setup: 'linux/amd64', extra: [] }, builderVersion: '0.1.0' });
  assert.equal(fs.readFileSync(path.join(ctx, 'setup.sh'), 'utf8'), `${setup}\n`);
  assert.ok(!dockerfile.includes('forge install'), 'the setup text is not in the Dockerfile');
  assert.equal(stages(dockerfile).length, 2, 'the setup text adds no stage');
  assert.ok(fs.existsSync(path.join(ctx, 'repo.git', 'objects')));
  assert.equal(fs.readFileSync(path.join(ctx, 'Dockerfile'), 'utf8'), dockerfile);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('without a setup command no setup script runs', () => {
  const [setup] = stages(render({ hasSetup: false }));
  assert.ok(!setup.lines.join('\n').includes('setup.sh'));
});

test('the final stage runs nothing: no RUN, so the maker\'s code gets network only in the setup stage', () => {
  const [setup, final] = stages(render());
  assert.ok(setup.lines.some((l) => l.startsWith('RUN ')), 'the setup stage runs the setup');
  assert.deepEqual(final.lines.filter((l) => /^(RUN|ADD|ONBUILD|VOLUME|USER|ENTRYPOINT|CMD|SHELL|HEALTHCHECK)\b/.test(l)), []);
  for (const l of final.lines) assert.match(l, /^(COPY --from=setup |ENV |LABEL )/, l);
});

test('the final image: /repo belongs to uid 10001, tools under /opt outside $HOME and /tmp, no VOLUME', () => {
  const [, final] = stages(render());
  const body = final.lines.join('\n');
  assert.match(body, /^COPY --from=setup --chown=10001:10001 \/repo \/repo$/m);
  assert.match(body, new RegExp(`^COPY --from=setup ${IMAGE_LAYOUT.tools} ${IMAGE_LAYOUT.tools}$`, 'm'));
  assert.ok(IMAGE_LAYOUT.tools.startsWith('/opt/'));
  for (const p of [IMAGE_LAYOUT.tools, IMAGE_LAYOUT.xdgData]) {
    assert.ok(!p.startsWith('/tmp') && !p.startsWith('/home'), p);
  }
  assert.match(body, new RegExp(`^ENV XDG_DATA_HOME=${IMAGE_LAYOUT.xdgData} VERDIKTA_TOOLS=${IMAGE_LAYOUT.tools}`, 'm'));
  assert.ok(!/VOLUME/.test(render()), 'no VOLUME anywhere');
  assert.equal(IMAGE_LAYOUT.sandboxUid, 10001);
});

test('the tools path comes after the base image\'s own PATH, so it cannot shadow sh, git or forge', () => {
  const [, final] = stages(render());
  const env = final.lines.find((l) => l.startsWith('ENV '));
  assert.match(env, /PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin:\/opt\/verdikta\/tools\/bin/);
});

test('a baseCommit or version that is not what the schema allows never reaches the Dockerfile', () => {
  assert.throws(() => render({ baseCommit: 'HEAD; rm -rf /' }), /baseCommit/);
  assert.throws(() => render({ baseCommit: 'A'.repeat(40) }), /baseCommit/);
  assert.throws(() => render({ builderVersion: '1.0.0"\nRUN x' }), /version/);
  assert.ok(render({ baseCommit: 'b'.repeat(64) }).includes('b'.repeat(64)), 'SHA-256 commits');
});
