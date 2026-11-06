// Node P8: the rules a "yes" has to pass, without a chain or git: the proof file's format and the
// address forms it takes, which repository URLs the site reads at all, the message a deployer or
// owner signs, and the wording of every fact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import { wordingProblems } from '@verdikta/stake-attestation-shared';
import { CONTROL_FILE, CONTROL_REASONS, canonicalAddress, controlMessage, mirrorPath, parseControlFile, repoUrlCheck, statementOf } from '../src/control/facts.js';
import { ConfigError, loadConfig } from '../src/config.js';

const MAKER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const file = (over) => JSON.stringify({ version: 1, maker: MAKER, ...over });
const HOSTS = ['github.com', 'gitlab.com'];

test('the proof file: JSON with its version and the maker\'s address, in EIP-55 or all lowercase', () => {
  assert.deepEqual(parseControlFile(file()), { maker: MAKER, problem: null });
  assert.deepEqual(parseControlFile(`\n  ${file({ maker: MAKER.toLowerCase() })}\n`), { maker: MAKER, problem: null }, 'lowercase names the same address');
});

test('an address in another form names nothing: a stranger cannot pass by case, prefix, ICAP or a typo', () => {
  const lower = MAKER.toLowerCase().slice(2);
  const badChecksum = `0x${MAKER.slice(2, 3) === 'B' ? 'b' : 'B'}${MAKER.slice(3)}`;
  const icap = ethers.getIcapAddress(MAKER);
  for (const maker of [
    badChecksum, // a mixed-case address whose checksum fails
    `0x${lower.toUpperCase()}`, // every letter uppercase: no checksum at all
    `0X${lower}`,
    lower, // no prefix
    icap,
    ` ${MAKER}`,
    `${MAKER} `,
    `${MAKER}\n`,
    `${MAKER}00`,
    MAKER.slice(0, 41),
    '0x0000000000000000000000000000000000000000',
    1234,
    null,
    [MAKER],
    { address: MAKER },
  ]) {
    assert.deepEqual(parseControlFile(file({ maker })), { maker: null, problem: 'ADDRESS_FORM' }, JSON.stringify(maker));
  }
});

test('a file in any other format proves nothing', () => {
  for (const [text, problem] of [
    ['', 'NOT_JSON'],
    ['not json', 'NOT_JSON'],
    [`﻿${file()}`, 'NOT_JSON'],
    ['[]', 'FORMAT'],
    ['null', 'FORMAT'],
    [`"${MAKER}"`, 'FORMAT'],
    [file({ version: 2 }), 'FORMAT'],
    [file({ version: '1' }), 'FORMAT'],
    [JSON.stringify({ maker: MAKER }), 'FORMAT'],
    [JSON.stringify({ version: 1 }), 'FORMAT'],
    [file({ extra: true }), 'FORMAT'],
  ]) {
    assert.deepEqual(parseControlFile(text), { maker: null, problem }, text);
  }
  assert.equal(parseControlFile(null).problem, 'NOT_JSON');
});

test('canonicalAddress: one spelling per address, for every comparison', () => {
  assert.equal(canonicalAddress(MAKER.toLowerCase()), MAKER);
  assert.equal(canonicalAddress(MAKER), MAKER);
  assert.equal(canonicalAddress(MAKER.toUpperCase()), null);
  assert.equal(canonicalAddress(ethers.getIcapAddress(MAKER)), null);
  assert.equal(canonicalAddress('0x0000000000000000000000000000000000000000'), null);
});

test('only plain https URLs on the site\'s git hosts are read: a look-alike is not', () => {
  for (const url of [
    'https://github.com/verdikta/verdikta-arbiter',
    'https://github.com/verdikta/verdikta-arbiter.git',
    'https://github.com/Verdikta/.github',
    'https://gitlab.com/group/subgroup/project',
  ]) {
    assert.deepEqual(repoUrlCheck(url, HOSTS), { ok: true, host: new URL(url).host }, url);
  }
  for (const [url, reason] of [
    // other hosts, however close
    ['https://github.com.evil.example/verdikta/verdikta-arbiter', 'REPO_HOST_NOT_CHECKED'],
    ['https://evil-github.com/verdikta/verdikta-arbiter', 'REPO_HOST_NOT_CHECKED'],
    ['https://raw.github.com/verdikta/verdikta-arbiter', 'REPO_HOST_NOT_CHECKED'],
    ['https://169.254.169.254/latest/meta-data', 'REPO_HOST_NOT_CHECKED'],
    ['https://localhost/a/b', 'REPO_HOST_NOT_CHECKED'],
    // another host dressed as this one
    ['https://github.com@evil.example/verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['https://github.com:443@evil.example/verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['https://user:pass@github.com/verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['https://github.com%2F@evil.example/verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    // one repository's name on another's path
    ['https://github.com/evil/repo/../../verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['https://github.com/verdikta/verdikta-arbiter/../../evil/repo', 'REPO_URL_FORM'],
    ['https://github.com/./verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['https://github.com/verdikta%2Fverdikta-arbiter/x', 'REPO_URL_FORM'],
    ['https://github.com/evil/repo?verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['https://github.com/evil/repo#verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['https://github.com/verdikta/verdikta-arbiter/', 'REPO_URL_FORM'],
    ['https://github.com//verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['https://github.com/verdikta', 'REPO_URL_FORM'],
    ['https://github.com:8443/verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    // another spelling of the host, or letters that only look the same
    ['https://GitHub.com/verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['https://github.com./verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['https://gіthub.com/verdikta/verdikta-arbiter', 'REPO_URL_FORM'], // a Cyrillic letter
    ['https://github.com/verdіkta/verdikta-arbiter', 'REPO_URL_FORM'], // a Cyrillic letter
    ['https://xn--gthub-n4d.com/verdikta/verdikta-arbiter', 'REPO_HOST_NOT_CHECKED'],
    // not https, or text around it
    ['http://github.com/verdikta/verdikta-arbiter', 'REPO_URL_FORM'],
    ['git@github.com:verdikta/verdikta-arbiter.git', 'REPO_URL_FORM'],
    ['https://github.com/verdikta/verdikta-arbiter\n', 'REPO_URL_FORM'],
    ['https://github.com/verdikta/verdikta-arbiter;rm -rf /', 'REPO_URL_FORM'],
    [`https://github.com/${'a/'.repeat(9)}b`, 'REPO_URL_FORM'],
    [`https://github.com/a/${'b'.repeat(300)}`, 'REPO_URL_FORM'],
  ]) {
    const got = repoUrlCheck(url, HOSTS);
    assert.deepEqual(got, { ok: false, reason }, url);
  }
});

test('a mirror path comes from a checked URL only and cannot leave the mirror folder', () => {
  assert.equal(mirrorPath('/m', 'https://github.com/acme/vault'), '/m/github.com/acme/vault.git');
  assert.equal(mirrorPath('/m', 'https://github.com/acme/vault.git'), '/m/github.com/acme/vault.git');
  assert.equal(mirrorPath('/m', 'https://github.com/../../etc/passwd'), null);
});

test('the signed message binds the maker, the artifact hash, its chain and contract, and the stake deployment, in one fixed form', () => {
  const o = {
    maker: MAKER,
    artifactHash: `0x${'ab'.repeat(32)}`,
    chainId: '8453',
    address: '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
    stakeChainId: 84532,
    stakeContract: '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
  };
  assert.equal(controlMessage(o), [
    'Verdikta stake attestation: control of a deployment',
    'The signer controls the deployment below and names the maker as its staker. This is not a transaction: it costs nothing and moves no funds.',
    '',
    'Version: 1',
    `Maker: ${MAKER}`,
    `Artifact Hash: 0x${'ab'.repeat(32)}`,
    'Chain Id: 8453',
    'Contract: 0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
    'Stake Chain Id: 84532',
    'Stake Contract: 0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
  ].join('\n'));
  // any other value is another message: nothing signed for one listing verifies for another
  const base = controlMessage(o);
  for (const over of [
    { maker: '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2' },
    { artifactHash: `0x${'cd'.repeat(32)}` },
    { chainId: '1' },
    { address: MAKER },
    { stakeChainId: 8453 },
    { stakeContract: MAKER },
  ]) {
    assert.notEqual(controlMessage({ ...o, ...over }), base, JSON.stringify(over));
  }
  // one spelling: an address in another case makes the same message
  assert.equal(controlMessage({ ...o, maker: MAKER.toLowerCase() }), base);
  assert.equal(controlMessage({ ...o, artifactHash: o.artifactHash.toUpperCase().replace('0X', '0x') }), base);
  // a value cannot add a line of its own
  assert.throws(() => controlMessage({ ...o, chainId: '1\nMaker: x' }), TypeError);
  assert.throws(() => controlMessage({ ...o, maker: 'nope' }), TypeError);
  assert.throws(() => controlMessage({ ...o, artifactHash: '0x12' }), TypeError);
});

test('the wording is facts only: every statement and reason passes the banned-words and judgemental-phrase checks', () => {
  // a repository names its staker, who may be a sponsor; only a contract's signer speaks of control
  assert.equal(statementOf('repository', true), 'staker named by the repository: yes');
  assert.equal(statementOf('repository', false), 'staker named by the repository: no');
  assert.equal(statementOf('deployment', true), 'staker controls the deployment: yes');
  assert.equal(statementOf('deployment', false), 'staker controls the deployment: no');
  for (const subject of ['repository', 'deployment']) assert.deepEqual(wordingProblems(statementOf(subject, true)), []);
  assert.ok(Object.keys(CONTROL_REASONS).length >= 12);
  for (const [code, text] of Object.entries(CONTROL_REASONS)) {
    assert.deepEqual(wordingProblems(text), [], code);
    assert.equal(text.includes('\n'), false, code);
  }
  assert.ok(CONTROL_REASONS.NO_PROOF_FILE.includes(CONTROL_FILE));
});

test('config: the git hosts, the bounds, a mirror folder for development only, no credential held', () => {
  const c = loadConfig({}).control;
  assert.deepEqual(c.gitHosts, ['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org']);
  assert.equal(c.mirrorDir, null);
  assert.equal(c.timeoutMs, 120000);
  assert.equal(c.maxBytes, 256 * 1024 * 1024);
  assert.equal(c.retryMs, 60000);
  assert.equal(c.recheckMs, 86400000);
  assert.equal(c.rpcTimeoutMs, 10000);
  assert.match(c.bin, /builder\/bin\/verdikta-control-check\.js$/);

  const o = loadConfig({ SA_CONTROL_GIT_HOSTS: 'github.com, git.example.org', SA_CONTROL_RETRY_MS: '100', SA_CONTROL_GIT_MIRROR_DIR: '/tmp/m' }).control;
  assert.deepEqual(o.gitHosts, ['github.com', 'git.example.org']);
  assert.equal(o.retryMs, 100);
  assert.equal(o.mirrorDir, '/tmp/m');

  for (const bad of ['https://github.com', 'github.com/x', 'GITHUB.COM', 'a b', '127.0.0.1']) {
    assert.throws(() => loadConfig({ SA_CONTROL_GIT_HOSTS: bad }), (e) => e instanceof ConfigError && /SA_CONTROL_GIT_HOSTS/.test(e.message), bad);
  }
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', SA_PINNING: 'kubo', SA_CONTROL_GIT_MIRROR_DIR: '/tmp/m' }),
    (e) => e instanceof ConfigError && /SA_CONTROL_GIT_MIRROR_DIR/.test(e.message),
    'a local copy must not be able to say yes in production',
  );

  assert.throws(() => loadConfig({ SA_CONTROL_RPC_URL_8453: 'http://rpc.example/x' }), (e) => /SA_CONTROL_RPC_URL_8453/.test(e.message));
  assert.throws(() => loadConfig({ SA_CONTROL_RPC_URL_base: 'https://rpc.example/x' }), (e) => /the listing chain's id/.test(e.message));

  const key = 'https://rpc.example/secret-key';
  const held = JSON.stringify(loadConfig({ SA_CONTROL_RPC_URL_8453: key }));
  assert.equal(held.includes('secret-key'), false, 'an RPC URL may carry a key: it stays in the environment');
});
