// One test's world: a StakeAttestation deployment on the in-process network, a local pin target and
// gateway, a builder dev key, the listing flow's archives pinned and listed, a hunter's claim folder.
// Every key is Hardhat's test mnemonic or made per run; nothing touches a network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { zipStored } from '@verdikta/stake-attestation-shared/zip';

import { createHunter, createPinner } from '../../src/index.js';
import { deployStakeAttestation, hardhat } from './chain.js';
import { startIpfs } from './ipfs.js';

const require = createRequire(import.meta.url);
export const { codeReview } = require('@verdikta/common');

export const IMAGE = `ghcr.io/verdikta/stake-env@sha256:${'4e1b2c3d'.repeat(8)}`;
export const REPORT_MARKER = 'PLAINTEXT-REPORT-MARKER-7f3a';
export const POC_MARKER = 'PLAINTEXT-POC-MARKER-91c2';
export const ORACLE = { requestedClass: 133n, maxOracleFee: 120000000000000n, disputeMaxOracleFee: 200000000000000n, estimatedBaseCost: 1000000000000n, alpha: 500n, maxFeeBasedScaling: 1n };
export const HUNTER_INDEX = 5;
export const sha256 = (b) => `0x${crypto.createHash('sha256').update(b).digest('hex')}`;

const pretty = (v) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8');
const MANIFEST = 'manifest.json';
const PRIMARY = 'primary_query.json';

export const FINDING = Object.freeze({
  version: 1,
  title: 'Reentrancy in withdraw',
  claimedClass: 'HIGH',
  rootCause: 'Vault.withdraw sends ETH before it zeroes the balance, so a receiver can re-enter and drain the vault.',
  affectedPaths: ['src/Vault.sol'],
  poc: { command: 'forge test --match-test test_drain', observable: 'test_drain fails with "vault balance 0 after one withdraw"' },
});

export const POC_PATCH = [
  'diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/test/Exploit.t.sol',
  '@@ -0,0 +1,4 @@',
  '+// SPDX-License-Identifier: MIT',
  '+pragma solidity ^0.8.20;',
  `+// ${POC_MARKER}`,
  '+contract ExploitTest { function test_drain() public { assert(false); } }',
  '',
].join('\n');

export const FIX_PATCH = [
  'diff --git a/src/Vault.sol b/src/Vault.sol',
  '--- a/src/Vault.sol',
  '+++ b/src/Vault.sol',
  '@@ -1,1 +1,1 @@',
  '-uint x;',
  '+uint y;',
  '',
].join('\n');

export const REPORT = `# Reentrancy in withdraw\n\n${REPORT_MARKER}: the attacker re-enters withdraw from its fallback and takes the whole balance.\n`;

export function tmpDir(prefix = 'sa-tool-') {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

/** A hunter's folder: finding.json, report.md, poc.patch, optionally fix.patch. */
export function makeClaimDir({ finding = FINDING, report = REPORT, poc = POC_PATCH, fix = null, dir = tmpDir('sa-claim-') } = {}) {
  fs.writeFileSync(path.join(dir, 'finding.json'), typeof finding === 'string' ? finding : `${JSON.stringify(finding, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'report.md'), report);
  fs.writeFileSync(path.join(dir, 'poc.patch'), poc);
  if (fix !== null) fs.writeFileSync(path.join(dir, 'fix.patch'), fix);
  return dir;
}

/** What code_review.json holds for a repository listing, as the builder writes it. */
export function specFor({ baseCommit, recipient, stake = {}, ...over }) {
  return {
    version: 1,
    kind: 'bug',
    repo: 'https://github.com/acme/vault',
    baseCommit,
    env: { image: IMAGE, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 812000000 },
    attestation: 'attestation.json',
    commands: {
      framework: 'forge',
      setup: 'forge build',
      build: 'forge build',
      test: 'forge test',
      testFiles: 'forge test --match-path $FILES',
      testIds: 'forge test --match-test $TEST_IDS',
    },
    baseline: 'baseline.json',
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    limits: { cpus: 2, memoryMb: 4096, buildSeconds: 13, testSeconds: 5, runSeconds: 34, maxPatchBytes: 2000000 },
    stake: {
      awards: { LOW: '0', MEDIUM: '0.1 ETH', HIGH: '0.4 ETH', CRITICAL: '2 ETH' },
      lowestClassCounted: 'MEDIUM',
      bondWei: '20000000000000000',
      fixWindowDays: 0,
      disclosureGraceHours: 0,
      scope: { include: ['src/**'], exclude: ['test/**'] },
      severityRubric: 'immunefi-v2.3',
      disclosureKey: recipient,
      valueAtRiskUsd: 1250000,
      ...stake,
    },
    ...over,
  };
}

function baselineFor(baseCommit) {
  const id = (fn) => `test/Vault.t.sol > VaultTest > ${fn}`;
  const tests = [
    { id: id('test_deposit_credits()'), results: ['pass', 'pass', 'pass'] },
    { id: id('test_owner_is_deployer()'), results: ['pass', 'pass', 'pass'] },
  ];
  return { version: 1, baseCommit, framework: 'forge', runs: 3, tests, stable: tests.map((t) => t.id), unstable: [], timings: { buildSeconds: 4.2, testSeconds: [1.5, 1.4, 1.6] } };
}

/** The listing flow's two archives (server/src/listing/archives.js) for a spec, signed with `builderKey`. */
export function buildArchives(spec, builderKey, { knownIssues = null, trust = 'dev' } = {}) {
  const specBytes = pretty(spec);
  const baselineBytes = pretty(baselineFor(spec.baseCommit));
  const knownBytes = knownIssues ? pretty(knownIssues) : null;
  const statement = codeReview.createAttestationStatement({
    files: { codeReview: specBytes, baseline: baselineBytes, knownIssues: knownBytes ?? undefined },
    trust,
    tools: { runner: '0.1.0' },
  });
  const attestation = codeReview.signAttestation(statement, builderKey.privateKey);
  const primary = pretty({ query: codeReview.buildClaimQuery(spec), outcomes: [...codeReview.BUG_OUTCOMES], references: [] });
  const archive = (panel) => zipStored([
    { name: MANIFEST, bytes: pretty({ version: '1.0', primary: { filename: PRIMARY }, juryParameters: panel, codeReview: 'code_review.json' }) },
    { name: PRIMARY, bytes: primary },
    { name: 'code_review.json', bytes: specBytes },
    { name: 'attestation.json', bytes: pretty(attestation) },
    { name: 'baseline.json', bytes: baselineBytes },
    ...(knownBytes ? [{ name: spec.stake.knownIssues, bytes: knownBytes }] : []),
  ]);
  return { listing: archive(codeReview.CODE_STANDARD_PANEL), dispute: archive(codeReview.CODE_STANDARD_DISPUTE_PANEL), attestation, baseline: baselineFor(spec.baseCommit) };
}

export function listParamsFor(spec, { knownIssues = null, allowlist = [], oracle = ORACLE } = {}) {
  const eff = codeReview.effectiveStake(spec);
  const awards = codeReview.awardsToWei(spec.stake.awards);
  return {
    params: {
      artifact: { kind: 0, repo: spec.repo, baseCommit: spec.baseCommit, chainId: 0n, addr: ethers.ZeroAddress },
      disclosureKey: `0x${Buffer.from(codeReview.parseDisclosureKey(spec.stake.disclosureKey)).toString('hex')}`,
      awards: codeReview.SEVERITY_CLASSES.map((c) => awards[c]),
      lowestClassCounted: codeReview.SEVERITY_CLASSES.indexOf(spec.stake.lowestClassCounted) + codeReview.FIRST_SEVERITY_OUTCOME_INDEX,
      bondWei: BigInt(spec.stake.bondWei),
      fixWindow: eff.fixWindowDays * 86400,
      disputeWindow: eff.disputeWindowHours * 3600,
      disclosureGrace: eff.disclosureGraceHours * 3600,
      revealWindow: eff.revealWindowDays * 86400,
      allowlist,
      valueAtRiskUsd: BigInt(spec.stake.valueAtRiskUsd ?? 0),
      oracle,
    },
    knownIssueIds: (knownIssues ?? []).map((k) => `0x${k.id.slice('sha256:'.length)}`).sort(),
  };
}

let commitCounter = 0;
export const freshCommit = () => `${(++commitCounter).toString(16).padStart(8, '0')}${crypto.randomBytes(16).toString('hex')}`;

export async function makeWorld() {
  const hre = await hardhat();
  const d = await deployStakeAttestation(hre);
  const ipfs = await startIpfs();
  const provider = new ethers.BrowserProvider(hre.network.provider, 31337, { cacheTimeout: -1, staticNetwork: true });
  const accounts = hre.network.config.accounts;
  const keyOf = (index) => ethers.HDNodeWallet.fromPhrase(accounts.mnemonic, accounts.passphrase ?? '', `${accounts.path}/${index}`).privateKey;
  const hunterKey = keyOf(HUNTER_INDEX);
  const hunterWallet = new ethers.Wallet(hunterKey, provider);
  const builderKey = codeReview.createDevBuilderKey();
  const signers = await hre.ethers.getSigners();
  const address = await d.sa.getAddress();
  const world = {
    hre,
    ...d,
    ipfs,
    provider,
    keyOf,
    hunterKey,
    hunterWallet,
    builderKey,
    signers,
    address,
    devKeys: [{ publicKey: builderKey.publicKey }],
    identity: null,
    rpc: (method, params = []) => hre.network.provider.send(method, params),
    async mine(n = 1) {
      for (let i = 0; i < n; i += 1) await hre.network.provider.send('evm_mine');
    },
    async increase(seconds) {
      await hre.network.provider.send('evm_increaseTime', [Number(seconds)]);
      await hre.network.provider.send('evm_mine');
    },
    async chainNow() {
      return BigInt((await hre.ethers.provider.getBlock('latest')).timestamp);
    },
    /**
     * Builds, pins, lists and funds a listing. `paramsOver` changes what goes on-chain and `specOver`
     * what is signed; `signWith` another builder's key; `pinListing`/`pinDispute` replace the bytes
     * pinned; `fund: false` stops before fund.
     */
    async listing({ stake = {}, specOver = {}, paramsOver = {}, signWith = builderKey, fund = true, listingBytes, disputeBytes, knownIssues = null, allowlist = [], oracle = ORACLE, maker = d.maker } = {}) {
      const pair = codeReview.generateDisclosureKeyPair();
      const spec = specFor({ baseCommit: freshCommit(), recipient: pair.recipient, stake, ...specOver });
      const archives = buildArchives(spec, signWith, { knownIssues });
      const lb = listingBytes ? listingBytes(archives, spec) : archives.listing;
      const db = disputeBytes ? disputeBytes(archives, spec) : archives.dispute;
      const listingCid = ipfs.put(lb);
      const disputeCid = ipfs.put(db);
      const { params, knownIssueIds } = listParamsFor(spec, { knownIssues, allowlist, oracle });
      const rc = await (await d.sa.connect(maker).list({ ...params, ...paramsOver }, listingCid, disputeCid, knownIssueIds)).wait();
      const listed = rc.logs.map((l) => { try { return d.sa.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Listed');
      const listingId = listed.args.listingId;
      if (fund) {
        const fee = await d.sa.feeDue(listingId);
        await (await d.sa.connect(maker).fund(listingId, fee, { value: fee + BigInt((paramsOver.awards ?? params.awards)[3]) })).wait();
      }
      return { listingId, spec, identity: pair.identity, recipient: pair.recipient, listingCid, disputeCid, archives, params: { ...params, ...paramsOver } };
    },
    /** The library, on this world's chain and pin target. `options` override anything. */
    hunter(options = {}) {
      return createHunter({
        provider,
        signer: hunterWallet,
        contract: address,
        gateway: ipfs.url,
        pinner: createPinner({ backend: 'kubo', url: ipfs.url }),
        devKeys: world.devKeys,
        confirmations: 1,
        pollMs: 1,
        waitMs: 4000,
        readBackMs: 50,
        receiptGraceMs: 20,
        onNotice: () => {},
        ...options,
      });
    },
    async claimCount() {
      return d.sa.claimCount();
    },
    async close() {
      await ipfs.close();
    },
  };
  return world;
}

/** The six one-hot verdicts. */
export const vectorOf = (outcome) => ['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((o) => (o === outcome ? 1000000n : 0n));
export const JUSTIFICATION_CID = 'bafkreihjustificationcidxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

/** Every byte a test can search: stdout, stderr, thrown errors in every form. */
export function allForms(err) {
  return [String(err), err?.message, err?.stack, JSON.stringify(err), JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})), String(err?.cause ?? '')].join('\n');
}

/** A key's forms: hex with and without 0x, either case, and base64. */
export function formsOf(hex) {
  const bare = hex.replace(/^0x/, '').toLowerCase();
  return [bare, bare.toUpperCase(), Buffer.from(bare, 'hex').toString('base64').replace(/=+$/, ''), Buffer.from(bare, 'hex').toString('base64url')];
}

export function assertNoForms(text, secrets, label = '') {
  for (const [name, values] of Object.entries(secrets)) {
    for (const v of values) {
      if (v && String(text).includes(v)) throw new Error(`${label} carries ${name}`);
    }
  }
}
