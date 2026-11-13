// The build job's egress rules (action/egress-rules.sh) against a real daemon, through the builder's own image
// build: the setup stage, the one with network, is where a maker's commands.setup runs. CI's builder-docker job
// runs that script before these tests, as the reusable workflow's build job does before a maker's build, and
// says so with SA_BUILDER_EGRESS_RULES=1. Both sides:
//
//   - a setup that resolves a public name and makes an HTTPS request builds (a Foundry listing's setup
//     downloads its solc; the first production listing failed there, with no DNS at all);
//   - a setup that tries TCP to the metadata service and to the VM host's address, on 80 and 32526, gets no
//     connection within 5 s of each.
//
// The pinned foundry base is Ubuntu with git: it has getent, timeout and bash (its /dev/tcp) but no curl, so
// git makes the HTTPS request. Elsewhere (a developer's machine) the rules are not on, and the runner's
// services are not there to be kept from: the tests say so and skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from '../../src/common.js';
import { parseConfig } from '../../src/config.js';
import { createDocker, runSandboxed } from '../../src/docker.js';
import { buildEnvImage } from '../../src/pipeline.js';
import { newReport } from '../../src/report.js';
import { fixtureDraft, fixtureRepo, newId, removeImages, startRegistries, testPlatforms } from './helpers.js';

const TIMEOUT = 1800000;
const CHAIN = 'VERDIKTA-BUILD-EGRESS';
const PROBES = ['169.254.169.254/80', '168.63.129.16/80', '168.63.129.16/32526'];
const PROBE_SECONDS = 5;
const skip = process.env.SA_BUILDER_EGRESS_RULES !== '1'
  ? 'the build job\'s egress rules are not on here: CI\'s builder-docker job runs action/egress-rules.sh before these tests and sets SA_BUILDER_EGRESS_RULES=1 (Linux, root, Docker\'s DOCKER-USER chain); without them there is nothing of a runner\'s to keep a build from'
  : process.platform !== 'linux' ? 'the egress rules are iptables rules on the daemon\'s host: Linux only' : false;

const id = newId();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
const recipient = codeReview.generateDisclosureKeyPair().recipient;
let regs;
let repo;
let repository;
let platforms;

/** Builds the fixture with `setup` as the maker's setup; on a failed build the assertion carries the build log's end. */
async function buildWithSetup(setup) {
  const draft = fixtureDraft(repo.baseCommit, recipient);
  draft.commands.setup = setup;
  const config = parseConfig({
    registry: { repository, apiUrl: regs.apiUrl },
    runner: { url: 'http://127.0.0.1:1', tokenEnv: 'UNUSED' },
    platforms,
    repoMirrors: { [draft.repo]: repo.mirror },
    workDir: path.join(dir, 'work'),
  }, { baseDir: dir, env: {} });
  try {
    return await buildEnvImage({ draft, config, report: newReport({ draft }), workDir: fs.mkdtempSync(path.join(dir, 'w-')) });
  } catch (err) {
    assert.fail(`the build failed: ${err.code}: ${err.detail}\n${err.log ?? ''}`);
  }
}

/** A file the setup left in /repo, read from the built image. */
async function readFromImage(image, file) {
  const r = await runSandboxed({ docker: createDocker({}), image: image.ref, platform: platforms.run, argv: ['/bin/cat', `/repo/${file}`], timeoutMs: 120000 });
  assert.equal(r.exitCode, 0, r.stderr.toString());
  return r.stdout.toString().trim();
}

test.before(async () => {
  if (skip) return;
  platforms = testPlatforms();
  regs = await startRegistries(id);
  repository = `${regs.host}/${id}/env`;
  repo = fixtureRepo(dir);
});

test.after(() => {
  if (repository) removeImages(repository);
  regs?.remove();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the rules these tests run under are the script\'s: its chain, jumped to first from DOCKER-USER', { skip }, () => {
  const read = (chain) => {
    const r = spawnSync('sudo', ['-n', 'iptables', '-w', '-S', chain], { encoding: 'utf8' });
    assert.equal(r.status, 0, `iptables -S ${chain}: ${r.stderr}`);
    return r.stdout.trim().split('\n');
  };
  const rules = read(CHAIN).filter((l) => l.startsWith('-A '));
  assert.equal(rules.length, 4, rules.join('\n'));
  assert.match(rules[0], /^-A VERDIKTA-BUILD-EGRESS -d 168\.63\.129\.16\/32 -p udp (-m udp )?--dport 53 -j RETURN$/);
  assert.match(rules[1], /^-A VERDIKTA-BUILD-EGRESS -d 168\.63\.129\.16\/32 -p tcp (-m tcp )?--dport 53 -j RETURN$/);
  assert.match(rules[2], /^-A VERDIKTA-BUILD-EGRESS -d 168\.63\.129\.16\/32 -j DROP$/);
  assert.match(rules[3], /^-A VERDIKTA-BUILD-EGRESS -d 169\.254\.169\.254\/32 -j DROP$/);
  const user = read('DOCKER-USER').filter((l) => l.startsWith('-A '));
  assert.equal(user[0], `-A DOCKER-USER -j ${CHAIN}`, user.join('\n'));
  assert.equal(user.filter((l) => l.includes(CHAIN)).length, 1, 'one jump');
});

test('a setup that resolves a public name and makes an HTTPS request builds', { skip, timeout: TIMEOUT }, async (t) => {
  const image = await buildWithSetup([
    'grep "^nameserver" /etc/resolv.conf > egress-resolver.txt || true',
    'getent hosts binaries.soliditylang.org > egress-dns.txt',
    'git ls-remote https://github.com/verdikta/verdikta-applications HEAD > egress-https.txt',
  ].join('\n'));
  t.diagnostic(`the setup's resolver: ${await readFromImage(image, 'egress-resolver.txt')}`);
  const dns = await readFromImage(image, 'egress-dns.txt');
  assert.match(dns, /^[0-9a-f.:]+\s+binaries\.soliditylang\.org/, dns);
  t.diagnostic(`binaries.soliditylang.org resolved in the setup: ${dns.split(/\s+/)[0]}`);
  assert.match(await readFromImage(image, 'egress-https.txt'), /^[0-9a-f]{40}\tHEAD$/, 'git read the repository over HTTPS');
});

test('a setup that tries TCP to the metadata service and the VM host\'s address gets no connection', { skip, timeout: TIMEOUT }, async (t) => {
  const image = await buildWithSetup([
    `for target in ${PROBES.join(' ')}; do`,
    '  start=$(date +%s)',
    '  rc=0',
    `  timeout ${PROBE_SECONDS} bash -c "exec 3<>/dev/tcp/$target" 2> /dev/null || rc=$?`,
    '  echo "$target $rc $(( $(date +%s) - start ))" >> egress-probes.txt',
    'done',
  ].join('\n'));
  const lines = (await readFromImage(image, 'egress-probes.txt')).split('\n');
  assert.deepEqual(lines.map((l) => l.split(' ')[0]), PROBES, lines.join('\n'));
  for (const line of lines) {
    const [target, rc, seconds] = line.split(' ');
    // 0 is a connection; 124 is timeout's (the SYN was dropped), anything else bash's own refusal.
    t.diagnostic(`${target}: ${rc === '124' ? `no answer in ${PROBE_SECONDS} s` : `exit ${rc}`} (${seconds} s)`);
    assert.notEqual(rc, '0', `${target}: the setup connected`);
    assert.ok(Number(seconds) <= PROBE_SECONDS + 2, `${target}: ${seconds} s`);
  }
});
