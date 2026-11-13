// The build job's egress rules (node P26): action/egress-rules.sh, run by the reusable workflow's build job
// in place of its two inline DROP rules, and by CI's builder-docker job so the Docker tests build under them.
// Here the real script runs against a stand-in iptables (test/helpers/iptablesStub.js), with no root and no
// daemon; test/docker/egress.docker.test.js holds the real rules to both sides on CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { evaluate, stubBin } from '../helpers/iptablesStub.js';

const SCRIPT = fileURLToPath(new URL('../../action/egress-rules.sh', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const builder = parse(fs.readFileSync(path.join(WORKFLOWS, 'stake-attestation-builder.yml'), 'utf8'));
const ci = parse(fs.readFileSync(path.join(WORKFLOWS, 'stake-attestation.yml'), 'utf8'));
const CHAIN = 'VERDIKTA-BUILD-EGRESS';
const METADATA = '169.254.169.254';
const HOST = '168.63.129.16';
const RULES = [
  `-d ${HOST}/32 -p udp --dport 53 -j RETURN`,
  `-d ${HOST}/32 -p tcp --dport 53 -j RETURN`,
  `-d ${HOST}/32 -j DROP`,
  `-d ${METADATA}/32 -j DROP`,
];

function runScript(stub, env = {}) {
  return spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { PATH: `${stub.bin}:${process.env.PATH}`, ...stub.env, ...env } });
}

test('the script exists and is what the workflows run', () => {
  assert.ok(fs.existsSync(SCRIPT), 'stake-attestation/builder/action/egress-rules.sh');
});

test('all of the metadata service is dropped, and all of the VM host\'s address but DNS, which goes back to Docker\'s chains', () => {
  const stub = stubBin();
  try {
    const r = runScript(stub);
    assert.equal(r.status, 0, r.stderr);
    const chains = stub.chains();
    assert.deepEqual(chains[CHAIN], RULES);
    assert.deepEqual(chains['DOCKER-USER'], [`-j ${CHAIN}`, '-j RETURN']);
    const verdict = (dst, proto, dport) => evaluate(chains, { dst, proto, dport });
    // DNS to the runner's resolver: RETURN, so FORWARD goes on to Docker's own chains, as it would with no rule.
    assert.equal(verdict(HOST, 'udp', 53), 'RETURN');
    assert.equal(verdict(HOST, 'tcp', 53), 'RETURN');
    for (const [proto, dport] of [['tcp', 80], ['tcp', 32526], ['tcp', 443], ['udp', 123], ['udp', 54], ['icmp']]) {
      assert.equal(verdict(HOST, proto, dport), 'DROP', `${HOST} ${proto}/${dport}`);
    }
    for (const [proto, dport] of [['tcp', 80], ['tcp', 443], ['udp', 53], ['tcp', 53], ['icmp']]) {
      assert.equal(verdict(METADATA, proto, dport), 'DROP', `${METADATA} ${proto}/${dport}`);
    }
    // Anything else is the build's network as Docker gives it.
    assert.equal(verdict('203.0.113.10', 'tcp', 443), 'RETURN');
    assert.equal(verdict('198.51.100.7', 'udp', 53), 'RETURN');
    assert.equal(stub.calls().filter((c) => c.startsWith('iptables ')).every((c) => c.startsWith('iptables -w ')), true, 'every call waits for the xtables lock');
  } finally {
    stub.remove();
  }
});

test('the order holds whatever was there before: a second run, a stale chain, a jump further down', () => {
  for (const start of [
    { 'DOCKER-USER': ['-j RETURN'] },
    { 'DOCKER-USER': ['-d 203.0.113.0/24 -j RETURN', `-j ${CHAIN}`, '-j RETURN'], [CHAIN]: [`-d ${HOST}/32 -j DROP`, `-d ${HOST}/32 -p udp --dport 53 -j RETURN`] },
    { 'DOCKER-USER': [`-j ${CHAIN}`, `-j ${CHAIN}`, '-j RETURN'], [CHAIN]: [] },
  ]) {
    const stub = stubBin(start);
    try {
      for (let run = 0; run < 2; run += 1) {
        const r = runScript(stub);
        assert.equal(r.status, 0, r.stderr);
        const chains = stub.chains();
        assert.deepEqual(chains[CHAIN], RULES, JSON.stringify(start));
        assert.equal(chains['DOCKER-USER'][0], `-j ${CHAIN}`, 'the jump is the first rule');
        assert.equal(chains['DOCKER-USER'].filter((x) => x === `-j ${CHAIN}`).length, 1, 'one jump');
        assert.equal(evaluate(chains, { dst: HOST, proto: 'udp', dport: 53 }), 'RETURN');
        assert.equal(evaluate(chains, { dst: HOST, proto: 'tcp', dport: 80 }), 'DROP');
      }
    } finally {
      stub.remove();
    }
  }
});

test('it prints the chains it leaves', () => {
  const stub = stubBin();
  try {
    const r = runScript(stub);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^-A DOCKER-USER -j ${CHAIN}$`, 'm'));
    for (const rule of RULES) assert.ok(r.stdout.includes(`-A ${CHAIN} ${rule}\n`), rule);
    const calls = stub.calls();
    const shown = calls.findIndex((c) => c === `iptables -w -S ${CHAIN}`);
    assert.ok(shown > calls.findIndex((c) => c === `iptables -w -I DOCKER-USER 1 -j ${CHAIN}`), 'after the jump is in place');
  } finally {
    stub.remove();
  }
});

test('it refuses, writing no rule, where Docker\'s bridge has IPv6 or there is no DOCKER-USER chain', () => {
  const v6 = stubBin();
  try {
    const r = runScript(v6, { STUB_IPV6: 'true' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /IPv4 only/);
    assert.deepEqual(v6.calls().filter((c) => c.startsWith('iptables ')), []);
  } finally {
    v6.remove();
  }
  const none = stubBin({});
  try {
    const r = runScript(none);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no DOCKER-USER chain/);
    assert.deepEqual(none.calls().filter((c) => / -[NAIF] /.test(c)), []);
  } finally {
    none.remove();
  }
});

test('its comment says why DNS stays open and why nothing else on that address does', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const comment = text.split('\n').filter((l) => l.startsWith('#')).join('\n');
  for (const needle of ['the resolver the VM was given', 'Docker hands a build\'s containers that resolver', 'UDP and TCP port 53', 'RETURN, not ACCEPT', 'Nothing else on that address answers a name', 'the host agent\'s endpoints, 80 and 32526', 'IPv4 only']) {
    assert.ok(comment.includes(needle), needle);
  }
  // IPv4 addresses: the two the rules name, and the loopback the comment explains; nothing of a host of ours.
  const addresses = [...new Set(text.match(/\b[0-9]{1,3}(?:\.[0-9]{1,3}){3}\b/g))].sort();
  assert.deepEqual(addresses, ['127.0.0.53', HOST, METADATA].sort());
});

test('the build job runs it in place of its inline rules, before gVisor\'s install and anything of the maker\'s', () => {
  const steps = builder.jobs.build.steps;
  const at = steps.findIndex((s) => s.name === 'Keep the build\'s containers off the host\'s metadata services');
  assert.ok(at > 0);
  assert.equal(steps[at].run, 'sudo bash "$VAB_BUILDER/action/egress-rules.sh"');
  assert.equal(steps[at].if, undefined, 'every build, whatever its inputs');
  const later = (pattern) => steps.findIndex((s) => pattern.test(s.run ?? ''));
  assert.ok(at < later(/gvisor\.tar\.bz2/) && at < later(/services\.js" start/) && at < later(/verdikta-build-env\.js" build/));
  for (const [name, j] of Object.entries(builder.jobs)) {
    for (const s of j.steps) assert.doesNotMatch(s.run ?? '', /\biptables\b/, `${name}: ${s.name}`);
  }
});

test('builder-docker runs the same script at the same point, and its Docker tests know the rules are on', () => {
  const steps = ci.jobs['builder-docker'].steps;
  const at = steps.findIndex((s) => /egress-rules\.sh/.test(s.run ?? ''));
  assert.ok(at > 0, 'a step runs the script');
  assert.equal(steps[at].run, 'sudo bash action/egress-rules.sh');
  assert.equal(steps[at]['working-directory'], 'stake-attestation/builder');
  const gvisor = steps.findIndex((s) => /gvisor\.tar\.bz2/.test(s.run ?? ''));
  const tests = steps.findIndex((s) => /npm run test:docker/.test(s.run ?? ''));
  assert.ok(at < gvisor && gvisor < tests, 'before gVisor\'s install and its daemon reload, as in the build job');
  assert.equal(steps[tests].env.SA_BUILDER_EGRESS_RULES, '1');
  assert.doesNotMatch(JSON.stringify(ci.jobs['builder-docker']), /iptables -I/);
});
