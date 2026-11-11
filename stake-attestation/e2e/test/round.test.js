// The node's acceptance: one script, every piece, one round, the record asserted. Runs the real script
// once and reads its real exit code and report.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REAL_CONFIG } from '../src/aggregatorRound.js';

const E2E = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-e2e-round-'));
let run;
let report;

const names = () => report.checks.map((c) => c.name);
const has = (...wanted) => {
  for (const name of wanted) assert.ok(names().includes(name), `the round made no check ${name}`);
};
const detail = (name) => report.checks.find((c) => c.name === name)?.detail;

before(async () => {
  const reportFile = path.join(tmp, 'report.json');
  run = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/round.js', '--report', reportFile], {
      cwd: E2E,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stderr.write(d); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out }));
  });
  report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  assert.ok(report, `no report: ${run.out.slice(-2000)}`);
}, { timeout: 2400000 });

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('acceptance 3: exit 0, and every check it made passed', () => {
  assert.equal(run.code, 0, report.failure);
  assert.equal(report.ok, true);
  assert.ok(report.checks.length > 80, `${report.checks.length} checks`);
  assert.deepEqual(report.checks.filter((c) => !c.ok), []);
});

test('acceptance 1: one script started the chain, the arbiter\'s services, the server with its keeper, and the client', () => {
  assert.deepEqual(report.pids.map((p) => p.name).sort(), ['ai-node', 'client', 'code-runner', 'external-adapter', 'hardhat', 'server'].sort());
  has('docker.reachable', 'registry.up', 'client.up', 'client.apiProxied', 'ea.devTrust', 'mock.realFee', 'final.keeper.noError', 'final.indexer.confirms');
});

test('acceptance 1: verdikta-arbiter at the pinned commit, and dev trust explicit', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(E2E, 'arbiter.pin.json'), 'utf8'));
  assert.equal(report.arbiter.commit, pin.commit);
  assert.equal(report.arbiter.pinned, true);
  has('listing.devTrustExplicit', 'listing.notProductionTrust', 'ea.devTrust');
});

test('acceptance 2: list, fund, commit, release, reveal, judge, settle, record, in that order, with the hunter tool and the API', () => {
  const order = ['list', 'fund', 'valid: check and commit', 'valid: release and reveal', 'valid: judge', 'valid: dispute window, then settle', 'record'];
  const at = order.map((name) => report.stages.findIndex((s) => s.name === name));
  assert.ok(at.every((i) => i >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  has('listing.realBuilder', 'listing.onTheRunner', 'listing.archiveBytes', 'list.artifactHash', 'fund.opened', 'feed.counted');
  has('valid.check.passes', 'tool.commit', 'valid.release.released', 'tool.reveal', 'tool.statusWait', 'tool.claim');
  has('valid.judged.outcome', 'valid.settled.outcome', 'valid.keeper.finalized', 'valid.keeper.settled', 'valid.money.hunter');
  has('final.record.outcomes', 'final.record.findings', 'final.record.isTheChains', 'final.page.finding');
});

test('acceptance 2: the gate-failing claim settles INVALID with the bond to the maker, after its appeal window (erratum E7), and no model was asked', () => {
  has('gate.check.forecast', 'gate.runner.gateFailed', 'gate.noAi', 'gate.evidence.settlement', 'gate.settled.outcome', 'gate.money.bondToMaker', 'gate.money.hunter', 'gate.settle.waitsAppealWindow', 'gate.settled.afterAppealWindow');
  assert.match(detail('gate.evidence.settlement'), /INVALID \(testPathsOnly\)/);
});

test('node P12: a claim that fails a non-tamper integrity check on real forge settles DUPLICATE, bond back, and the record counts it under the check it names', () => {
  has('integrity.check.forecast', 'integrity.runner.gateFailed', 'integrity.runner.reproducesOnlyThroughIntegrity', 'integrity.runner.checkFailed', 'integrity.runner.noTamperFlag', 'integrity.runner.everyRunFailed', 'integrity.noAi');
  has('integrity.evidence.uploads', 'integrity.evidence.settlement', 'integrity.evidence.source', 'integrity.status.readsTheBlock', 'integrity.settled.outcome', 'integrity.settled.noDisputeWindow');
  has('integrity.money.bondBack', 'integrity.money.makerUntouched', 'integrity.record.integrityFailed', 'integrity.record.integrityChecks', 'integrity.record.integrityApart', 'final.page.integrityFailed', 'final.page.integrityChecks', 'final.page.duplicateNotPublished');
  assert.match(detail('integrity.evidence.settlement'), /DUPLICATE \(integrity\)/);
  assert.match(detail('integrity.record.integrityChecks'), /protectedPathsUnchanged/);
  assert.equal(report.stages.findIndex((s) => s.name === 'integrity: reveal, DUPLICATE, the bond back') > report.stages.findIndex((s) => s.name === 'gate: reveal, INVALID, the appeal window, the bond to the maker'), true);
});

test('node P18: an award above the listing\'s size is confirmed by the dispute panel, the keeper calling confirm after the dispute window, paid from the escrow', () => {
  has('valid.settle.waitsDisputeWindow', 'valid.confirm.awaits', 'valid.confirm.byKeeper', 'valid.confirm.request.disputeArchive', 'valid.confirm.request.noDisputeLine', 'valid.confirm.escrowPaid', 'valid.confirm.held', 'valid.confirm.keeperFinalized', 'valid.confirm.settledAfter', 'valid.record.confirmations');
  assert.match(detail('valid.confirm.held'), /Held/);
});

test('node P18: an INVALID appealed through the tool, after its explicit --yes, and settled by the dispute panel\'s result', () => {
  has('appeal.check.forecast', 'appeal.waiver.warned', 'appeal.tool.needsYes', 'appeal.tool.appealed', 'appeal.tool.paidTheLiveFee', 'appeal.request.disputeArchive', 'appeal.panel.held', 'appeal.keeper.finalized', 'appeal.keeper.settledByThePanel', 'appeal.settled.insideTheWindow', 'appeal.money.bondToMaker', 'appeal.money.hunterBearsThePrepay', 'appeal.status.kind', 'appeal.record.appeals');
  assert.match(detail('appeal.panel.held'), /INVALID/);
});

test('node P18: a narrow INVALID, read from the contract, waits out its appeal window and gets its bond back', () => {
  has('narrow.judged.outcome', 'narrow.judged.narrow', 'narrow.status.narrow', 'narrow.settle.waitsAppealWindow', 'narrow.event', 'narrow.money.bondBack', 'narrow.money.makerUntouched', 'narrow.record.narrowInvalid');
  assert.match(detail('narrow.judged.narrow'), /narrow/);
});

test('node P12: the runner at the pin had the Semgrep image before it started, and the fixture settled as it did', () => {
  has('semgrep.warmed', 'listing.officialCompiler', 'listing.commandsAskedFirst', 'listing.shellPrefixRefused', 'valid.report.everyGatePassed');
  assert.match(detail('semgrep.warmed'), /sha256:/);
});

test('an abstention is never a settled claim: rounds fail, a fresh prepay, then expiry with the bond to the maker (E6)', () => {
  has('abstain.check.forecast', 'abstain.first.round.allAbstained', 'abstain.first.runner.ranIt', 'abstain.first.ea.abstained', 'abstain.first.noAi', 'abstain.second.runner.ranIt', 'abstain.second.ea.abstained', 'abstain.first.stillOpen', 'abstain.first.money.refundAtFinalize', 'abstain.retrigger.asksYes', 'abstain.retrigger.freshPrepay', 'abstain.second.round.allAbstained', 'abstain.keeper.expired', 'abstain.expiry.money.bondToMaker', 'abstain.expiry.money.hunterGetsNothing', 'abstain.never.judged', 'abstain.never.settled', 'abstain.ended.expired', 'abstain.nothingUploaded');
});

test('review focus: the bridge ran the real K, M, N and P, and what the real contract would do with the answers', () => {
  has('valid.round.polled', 'valid.round.commits', 'valid.round.revealJobs', 'valid.round.reveals', 'valid.round.clustered', 'valid.round.noRevert', 'valid.round.noBadReveal', 'valid.round.noAbstain', 'valid.round.vector', 'valid.round.everyRevealSame', 'valid.request.cids', 'valid.request.disclosureLine', 'valid.request.oracle', 'gate.request.cids', 'gate.round.vector', 'gate.round.everyRevealSame');
  assert.match(detail('valid.round.polled'), new RegExp(`K = ${REAL_CONFIG.k}`));
  assert.match(detail('valid.round.commits'), new RegExp(`M = ${REAL_CONFIG.m}`));
  assert.match(detail('valid.round.reveals'), new RegExp(`N = ${REAL_CONFIG.n}`));
  assert.match(detail('valid.round.clustered'), new RegExp(`P = ${REAL_CONFIG.p}`));
});

test('nothing is a stand-in for a verdict: the runner, the jury and the evidence each say they ran', () => {
  has('valid.report.everyGatePassed', 'valid.runner.oneSandbox', 'valid.runner.definitive', 'valid.runner.reportPlatform', 'valid.jury.perJob', 'valid.jury.panelAskedEveryJob', 'valid.jury.everyJuror', 'valid.jury.onlyThePanel', 'valid.jury.everyJobAverage', 'valid.jury.everyJurorInEveryAnswer', 'valid.jury.everyCallSawEvidence', 'valid.jury.codeModeSettings', 'valid.jury.onePrompt', 'valid.jury.justifier', 'valid.jury.keysKnown', 'valid.jury.keysNotSeen', 'valid.evidence.uploads', 'valid.evidence.settlement', 'valid.evidence.reportHash', 'valid.evidence.source');
});

test('the embargo and the queue are the chain\'s and the tool\'s, not the script\'s order', () => {
  has('valid.embargo.noArbiterYet', 'valid.embargo.revealRefused', 'valid.plaintext.pinnedOnlyAtReveal', 'gate.order.waitsItsTurn', 'valid.settle.waitsDisputeWindow', 'listing.proofRefusesAnotherWallet', 'valid.disclosure.makerDecrypts', 'valid.disclosure.notReadable');
});

test('node P20: a listing that names its documents is built and checked, and the pack the runner at the pin built has the documents tier with the expected files; the first listing\'s pack has none', () => {
  has('documents.listing.accepted', 'documents.listing.ready', 'documents.listing.documentsStep', 'documents.listing.read', 'documents.listing.skipped', 'documents.listing.unmatchedWarned');
  has('documents.check.passes', 'documents.request.documents', 'documents.pack.isTheRunners', 'documents.pack.documentsTier', 'documents.pack.documentFiles', 'documents.forecast.documents');
  has('valid.pack.noDocumentsTier');
  assert.match(detail('documents.pack.documentFiles'), /README\.md.*docs\/spec\.md/);
  assert.match(detail('documents.pack.documentFiles'), /notText/);
});

test('nothing live: every CID came from the local IPFS, every model call from the mock provider, the image from the local registry', () => {
  has('live.noHostApi', 'live.ipfsNoMisses', 'live.providerIsTheMock', 'live.image.pulled', 'live.image.byDigest');
});

test('on the class platform the runner\'s own entry point and report path; elsewhere the launcher, and the run says so', () => {
  const classPlatform = os.arch() === 'x64';
  assert.equal(report.classPlatform, classPlatform);
  assert.equal(report.platform, classPlatform ? 'linux/amd64' : 'linux/arm64');
  if (process.env.SA_E2E_REQUIRE_CLASS_PLATFORM === '1') assert.equal(report.classPlatform, true);
  if (!classPlatform) assert.match(run.out, /the A6a launcher in front of the runner/);
  else assert.match(run.out, /the runner's real entry point/);
});

test('it left nothing behind', () => {
  assert.deepEqual(report.leftovers, { containers: [], images: [], groups: [] });
  assert.deepEqual(report.cleanupFailures, []);
  const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60000, env: { ...process.env, DOCKER_CONFIG: tmp } });
  const containers = docker('ps', '--all', '--format', '{{.Names}}\t{{.Image}}\t{{.Labels}}').stdout.split('\n').filter((l) => l.includes(report.instance));
  assert.deepEqual(containers, []);
});
