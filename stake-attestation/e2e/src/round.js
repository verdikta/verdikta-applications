// The round itself: every piece running together, on this machine, against a local chain, a local
// registry and a local IPFS, with no key that means anything. list -> fund -> commit -> release ->
// reveal -> judge (finalize) -> settle -> record, for a claim the jury decides, one the gates settle, one
// a non-tamper integrity check settles and one every arbiter abstains on. Node P18 adds the settlement
// safeguards (errata E7-E9): the valid HIGH is above the listing's confirmation size, so the keeper starts
// the dispute panel's confirmation after the dispute window; a second gate-failing claim is appealed through
// the tool and settles by the panel's result; and a claim the jury scores just short of valid is a narrow
// INVALID whose bond comes back. The first failed check, a service that will not start, or any
// error ends the round: exit 1, with everything it started stopped and removed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatEther } from 'ethers';

import { codeReview } from './common.js';
import { REAL_CONFIG } from './aggregatorRound.js';
import { createBridge, evaluateOver } from './bridge.js';
import { readPages } from './browser.js';
import { startChain } from './chain.js';
import {
  abstainEndChecks, abstainRunChecks, abstainedRoundChecks, cleanupVerdict, evidenceChecks, gateSettledChecks, integrityPageChecks, integrityRecordChecks, integrityRunChecks, juryPathChecks, moneyChecks, pageChecks,
  recordChecks, requestChecks, servedRoundChecks, settlementChecks,
} from './checks.js';
import {
  AWARDS_WEI, BOND_WEI, ESCROW_WEI, GIT_HOST, JURY_AVERAGE, JUROR_SCORES, JUSTIFIER, NARROW_AVERAGE, NARROW_SCORES, POC_MARKER, REPORT_MARKER, WINDOWS, claimFolder, draftSpec, makeRepository,
} from './fixtures.js';
import { RoundStopped, groupAlive, liveGroups, requestStop, sleep, stopProcessGroups, stopProcessesNaming, throwIfStopping, unlessStopped, waitUntil, within } from './proc.js';
import {
  arbiterHarness, cleanDockerConfig, leftovers, newRunnerToken, removeRunContainers, removeRunImages, startClient, startIpfs, startLateContainer, startRegistryPair, startServer, startSurvivor, warmSemgrep,
} from './services.js';
import { APP_DIR, arbiterCheckout, browserReady, compileContracts, E2E_DIR, installSiblings } from './setup.js';
import { createTool } from './tool.js';

const CLASS_PLATFORM = codeReview.CLASS_HARD_LIMITS.platform;
const OPERATOR = '0x0000000000000000000000000000000000000001';
/** What G2 sets on the real aggregators (design §7.2: setResponseTimeout(900)). */
const RESPONSE_TIMEOUT_SECONDS = 900;
/** Stands in for the keeper's selection and K dispatches inside the request: L4 ran out at 3M with 30 identities. */
const REQUEST_GAS_STAND_IN = 3_000_000;
/** The EA's deadline (design §11): the job's 840 s less the commit reserve. */
const EA_DEADLINE_LIMIT_MS = 780_000;
const OUTCOMES = ['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const INVALID_VECTOR = Object.freeze([1000000n, 0n, 0n, 0n, 0n, 0n]);
const DUPLICATE_VECTOR = Object.freeze([0n, 1000000n, 0n, 0n, 0n, 0n]);
/** What the integrity claim's proof changes: it writes .gitignore, which the round's draft protects. */
const INTEGRITY_CHECK = 'protectedPathsUnchanged';
const CLAIM_STATES = ['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed'];
const DISPUTE_RESULTS = ['None', 'Pending', 'Held', 'Overturned', 'NoVerdict'];
const DISPUTE_KINDS = ['None', 'Maker', 'Confirmation', 'Appeal'];
const EXPIRIES = ['None', 'Undisclosed', 'Unrevealed', 'RoundsFailed', 'SubmissionsRefused'];
const DEFAULT_LOG_ROOT = path.join(E2E_DIR, '.round', 'logs');
/**
 * How long a stop waits for the main flow to come back, so that what it started gets its closer. Everything that
 * only waits gives up at the flag, so this waits on what cannot be interrupted and can still create something: a
 * step on its way to a container or a process (a registry image's pull, A6a's starters). The whole start stage takes
 * 7 to 11 s, here and on CI with cold caches, and its slowest step can have a first pull in it: three minutes is
 * many times that. A6a's own limits are longer (next dev has 300 s), but a step that long is hung, and someone is
 * waiting at a terminal. Past it the run has failed, by name, and the sweep runs anyway.
 */
const STOP_BOUND_MS = 180_000;
/** One closer's limit: what holds a closer is a stuck daemon or node, and the ones after it still run. The longest of them is a docker rm, 60 s or 120 s. */
const CLOSER_BOUND_MS = 150_000;
const LISTING_TIMEOUT_MS = 900_000;
const CHAIN_WAIT_MS = 120_000;

class CheckFailed extends Error {}

/**
 * @param {object} [o]
 * @param {(line: string) => void} [o.log]
 * @param {string|null} [o.breakName] - SA_E2E_BREAK: break the round on purpose (runner-start, valid-claim-abstains, signal-in-scan, signal-in-start, crash-in-start, leader-dies, group-survives)
 * @param {boolean} [o.requireClassPlatform] - SA_E2E_REQUIRE_CLASS_PLATFORM=1: anything but linux/amd64 is a failure
 * @param {string} [o.logDir] - SA_E2E_LOG_DIR: the run's logs go in a new folder inside it, and nothing there is removed
 * @param {number} [o.stopBoundMs] - SA_E2E_STOP_BOUND_MS: STOP_BOUND_MS, shorter for the test of running past it
 * @param {(report: object) => void} [o.onFinished] - called with the report, on a signal too: a signal ends the process here
 * @returns {Promise<object>} the report
 */
export async function runRound({ log = (s) => process.stderr.write(`${s}\n`), breakName = process.env.SA_E2E_BREAK || null, requireClassPlatform = process.env.SA_E2E_REQUIRE_CLASS_PLATFORM === '1', logDir: logRoot = process.env.SA_E2E_LOG_DIR || null, stopBoundMs = Number(process.env.SA_E2E_STOP_BOUND_MS) || STOP_BOUND_MS, onFinished = () => {} } = {}) {
  const started = Date.now();
  const instance = `sae2e${crypto.randomBytes(4).toString('hex')}`;
  const workDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sa-e2e-'));
  const report = { ok: false, instance, workDir, breakName, stages: [], checks: [], pids: [], platform: null, classPlatform: null, arbiter: null, failure: null, signal: null, leftovers: null, stopped: null, cancelledJobs: null, cleanupFailures: [], stopDrainMs: null, lateStep: null, seconds: null };
  // Its own folder under a directory someone named, which may hold anything: only the default, ours, is emptied.
  if (!logRoot) fs.rmSync(DEFAULT_LOG_ROOT, { recursive: true, force: true });
  const logDir = path.join(logRoot ?? DEFAULT_LOG_ROOT, instance);
  fs.mkdirSync(logDir, { recursive: true });
  report.logDir = logDir;

  // What the run started, stopped last first; and last of all the sweep: what none of them could stop for itself.
  const closers = [];
  let sweep = null;
  const noteCleanupFailure = (err) => {
    report.cleanupFailures.push(err.message);
    log(`[round] cleanup: ${err.message}`);
  };
  const runClosers = async () => {
    while (closers.length) {
      try {
        await within(closers.pop()(), CLOSER_BOUND_MS, 'a closer');
      } catch (err) {
        noteCleanupFailure(err);
      }
    }
  };
  let closing = null;
  const closeDown = () => {
    closing ??= (async () => {
      await runClosers();
      try {
        await sweep?.();
      } catch (err) {
        noteCleanupFailure(err);
      }
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (err) {
        noteCleanupFailure(err);
      }
    })();
    return closing;
  };
  const finish = () => {
    report.seconds = Math.round((Date.now() - started) / 1000);
    // Whatever the checks said, a run that left something behind, or cannot say that it did not, did not pass.
    const notClean = cleanupVerdict({ cleanupFailures: report.cleanupFailures, inventoryDue: sweep !== null, leftovers: report.leftovers });
    if (notClean) {
      report.ok = false;
      report.failure = report.failure ? `${report.failure}; ${notClean}` : notClean;
    }
    onFinished(report);
  };

  /**
   * The two-phase stop, for a signal or a crash at any moment. First the flag, which everything that only waits
   * honours, and the closers of what has started. Then the main flow comes back, within the bound: a step
   * that was already on its way may still create something, and it gets its closer when it arrives. Then
   * those closers, and the sweep last, when nothing of the run is left to create anything. A sweep that ran
   * before the main flow came back would have nothing to say about what came after it.
   */
  let mainFlow = Promise.resolve();
  let stopReason = null;
  const stopFor = async (reason, exitCode) => {
    if (stopReason) {
      log(`[round] ${reason} as well: already stopping`);
      return;
    }
    stopReason = reason;
    report.ok = false;
    report.failure = `stopped by ${reason}`;
    log(`[round] ${report.failure}: stopping everything`);
    requestStop();
    await runClosers();
    const startedDrain = Date.now();
    const cameBack = await Promise.race([mainFlow.then(() => true), sleep(stopBoundMs).then(() => false)]);
    report.stopDrainMs = Date.now() - startedDrain;
    if (!cameBack) noteCleanupFailure(new Error(`the main flow had not stopped ${stopBoundMs} ms after the signal: what it was doing may still finish`));
    await closeDown();
    try {
      finish();
      log(`[round] ${report.failure}`);
    } finally {
      process.stderr.write('', () => process.exit(exitCode));
    }
  };
  const SIGNALS = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
  const onSignal = (signal) => {
    report.signal ??= signal;
    stopFor(signal, SIGNALS[signal]);
  };
  const onCrash = (err) => {
    report.crash ??= `${err?.name}: ${err?.message}`;
    log(err?.stack ?? String(err));
    stopFor(`a crash: ${report.crash}`, 1);
  };
  for (const signal of Object.keys(SIGNALS)) process.on(signal, onSignal);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  let stageChecks = 0;
  const stage = (name) => {
    throwIfStopping();
    if (report.stages.length && stageChecks === 0) throw new CheckFailed(`the stage ${report.stages[report.stages.length - 1].name} made no check`);
    stageChecks = 0;
    report.stages.push({ name, atSeconds: Math.round((Date.now() - started) / 1000) });
    log(`[round] ${name}`);
  };
  const expect = (...lists) => {
    for (const c of lists.flat()) {
      report.checks.push(c);
      stageChecks += 1;
      if (!c.ok) throw new CheckFailed(`${c.name}: ${c.detail}`);
    }
  };
  const one = (name, ok, detail = '') => expect([{ name, ok: Boolean(ok), detail: String(detail) }]);
  const track = (svc) => {
    const pid = svc?.pid ?? svc?.child?.pid;
    if (pid) report.pids.push({ name: svc.name, pid });
    return svc;
  };
  /**
   * A step that starts something: awaited to its end whatever happens, because it may be creating something,
   * then its closer, and only then the flag. So nothing it made is ever without a closer.
   */
  const owned = async (starting, closerOf) => {
    const started_ = await starting;
    closers.push(() => closerOf(started_));
    throwIfStopping();
    return started_;
  };
  /** A transaction's receipt: only waited on, and a provider that was closed never answers. */
  const mined = (sent) => unlessStopped(Promise.resolve(sent).then((tx) => tx.wait()));

  let h;
  let docker;
  let chain;
  let bridge;
  let server;
  let aiNode;
  const run = async () => {
    stage('prepare');
    installSiblings(log);
    const arbiter = arbiterCheckout(log);
    report.arbiter = { commit: arbiter.commit, pinned: arbiter.pinned };
    one('arbiter.pinned', arbiter.pinned || process.env.SA_E2E_ARBITER_UNPINNED === '1', arbiter.commit);
    compileContracts(log);
    const chromium = await browserReady(log);
    h = arbiterHarness(arbiter.dir);
    report.platform = h.platform;
    report.classPlatform = h.platform === CLASS_PLATFORM;
    if (requireClassPlatform && !report.classPlatform) throw new CheckFailed(`this host runs ${h.platform}, and SA_E2E_REQUIRE_CLASS_PLATFORM=1 refuses the local report substitution`);
    const dockerSettings = h.dockerHelpers.dockerTestConfig();
    docker = h.dockerHelpers.dockerFor(dockerSettings);
    const dockerInfo = await h.runText(docker, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30000 });
    one('docker.reachable', dockerInfo.exitCode === 0, dockerInfo.exitCode === 0 ? dockerInfo.stdout.trim() : dockerInfo.stderr);
    sweep = async () => {
      // With every service stopped and the main flow back: what they could not stop for themselves. Every group this
      // run started, by its id, whether or not its leader is there; then what names the run, a builder step's group.
      const ownGroups = liveGroups().filter((pgid) => pgid !== report.survivor);
      const groups = await stopProcessGroups(ownGroups);
      report.stopped = await stopProcessesNaming([workDir, instance], { except: [logDir] });
      const named = report.stopped.containers;
      await removeRunContainers(h, docker, instance, named);
      // A docker CLI that was cut off can have a create on its way through the daemon: again, a moment later.
      if (groups.stopped.length || report.stopped.groups.length || report.stopped.singles.length) {
        await sleep(2000);
        await removeRunContainers(h, docker, instance, named);
      }
      await removeRunImages(h, docker, instance);
      report.leftovers = {
        ...await leftovers(h, docker, instance, named),
        groups: [...new Set([...liveGroups(), ...report.stopped.groups.filter(groupAlive)])],
      };
      fs.rmSync(dockerSettings.dockerConfigDir, { recursive: true, force: true });
    };
    log(`[round] instance ${instance}, platform ${h.platform}, ${report.classPlatform ? 'the runner\'s real entry point' : 'the A6a launcher in front of the runner (report built with the class platform named)'}`);
    const semgrep = await warmSemgrep(h, docker, { platform: h.platform });
    throwIfStopping();
    one('semgrep.warmed', semgrep.problem === null && semgrep.present === true, semgrep.problem ?? `${semgrep.image}, ${semgrep.platform}`);

    stage('start');
    chain = await owned(startChain({ logDir }), (c) => c.close());
    track(chain.node);
    if (breakName === 'crash-in-start') setTimeout(() => { throw new Error('a crash on purpose'); }, 0);
    if (breakName === 'signal-in-start') {
      const late = startLateContainer({ instance, seconds: Number(process.env.SA_E2E_LATE_SECONDS) || 5, dockerConfigDir: dockerSettings.dockerConfigDir });
      report.lateStep = { name: late.name, pid: late.pid };
      process.kill(process.pid, 'SIGTERM');
      await owned(late.done, (name) => h.runText(docker, ['rm', '--force', '--volumes', name], { timeoutMs: 60000 }));
    }
    await mined(chain.aggregator.setResponseTimeout(RESPONSE_TIMEOUT_SECONDS));
    await mined(chain.aggregator.setRequestGasCost(REQUEST_GAS_STAND_IN));
    const ipfs = await owned(startIpfs(h), (i) => i.close());
    const registry = await owned(startRegistryPair(h, docker, instance), (r) => r.remove());
    one('registry.up', Boolean(registry.host && registry.apiUrl), `${registry.host}, read at ${registry.apiUrl}`);

    const runnerToken = newRunnerToken();
    const stateDir = fs.mkdtempSync(path.join(workDir, 'runner-state-'));
    const runner = track(await owned(h.startCodeRunner({
      logDir,
      stateDir,
      token: runnerToken,
      platform: breakName === 'runner-start' ? 'linux/not-a-platform' : h.platform,
      allowlist: registry.host,
      classPlatform: report.classPlatform,
      instance,
    }), (r) => r.close()));
    // Two proxies, so what the EA sent and what the hunter's check sent are told apart.
    const runnerProxy = await owned(h.startRecordingProxy(runner.url), (p) => p.close());
    const hunterRunner = await owned(h.startRecordingProxy(runner.url), (p) => p.close());

    const panel = codeReview.CODE_STANDARD_PANEL.AI_NODES.map((n) => ({ provider: n.AI_PROVIDER, model: n.AI_MODEL, weight: n.WEIGHT }));
    // the listing's dispute archive carries the dispute panel: the valid claim's confirmation (erratum E9) asks it
    const disputePanel = codeReview.CODE_STANDARD_DISPUTE_PANEL.AI_NODES.map((n) => ({ provider: n.AI_PROVIDER, model: n.AI_MODEL, weight: n.WEIGHT }));
    const juror = (model, scores) => ({ scores: [...scores], justification: `Mock juror ${model}: the deposit over-credits.` });
    const script = {
      [panel[0].model]: juror(panel[0].model, JUROR_SCORES[0]),
      // the valid claim's K jobs, one call each, then the narrow claim's (the last entry repeats): fixtures.js
      [panel[1].model]: [...Array.from({ length: REAL_CONFIG.k }, () => juror(panel[1].model, JUROR_SCORES[1])), juror(panel[1].model, NARROW_SCORES)],
      [JUSTIFIER.model]: { reply: 'Mock justification: the panel finds the over-credit a HIGH.' },
    };
    // the dispute panel's other jurors answer as the claim panel's second: the confirmation's average is the claim's
    for (const n of disputePanel) script[n.model] ??= juror(n.model, JUROR_SCORES[1]);
    const callLog = path.join(logDir, 'provider-calls.jsonl');
    aiNode = track(await owned(h.startAiNode({ logDir, callLog, script, justifierModel: `${JUSTIFIER.provider}:${JUSTIFIER.model}` }), (a) => a.close()));
    const aiProxy = await owned(h.startRecordingProxy(aiNode.url), (p) => p.close());
    const providerCalls = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

    const maker = chain.accounts.maker;
    const repository = makeRepository({ workDir, maker: maker.address });
    const dockerConfig = cleanDockerConfig(workDir);
    server = track(await owned(startServer({ workDir, logDir, chain, ipfs, registry, runnerProxyUrl: runnerProxy.url, runnerToken, platform: h.platform, repository, dockerConfig, instance }), (v) => v.close()));
    const client = track(await owned(startClient({ workDir, logDir, chain, ipfs, serverUrl: server.url }), (c) => c.close()));
    one('client.up', (await fetch(`${client.url}/`)).ok, client.url);
    one('client.apiProxied', (await fetch(`${client.url}/api/status`)).ok, 'the client reaches the server under /api');
    log('[round] services up');
    if (breakName === 'leader-dies') {
      // The leader alone: next dev's next-server stays in its group, still answering, and nothing names the run.
      const leader = aiNode.child.pid;
      process.kill(leader, 'SIGKILL');
      await waitUntil('the leader to die', async () => aiNode.exited() !== null, { timeoutMs: 15000 });
      await sleep(500);
      one('break.groupOutlivesItsLeader', groupAlive(leader), `group ${leader} ${groupAlive(leader) ? 'still has members' : 'is gone with its leader'}`);
      throw new CheckFailed('leader-dies: ended here on purpose, as any failure ends a round');
    }
    if (breakName === 'group-survives') {
      // Every check so far has passed and the main flow ends: only what is left can fail this run.
      report.survivor = startSurvivor().pid;
      return;
    }

    const settleOutcome = async (fn, what, timeoutMs = CHAIN_WAIT_MS) => waitUntil(what, fn, { timeoutMs, everyMs: 300, proc: server });

    // ---------------------------------------------------------------- the project's proof and the listing
    stage('list');
    const disclosure = codeReview.generateDisclosureKeyPair();
    const draft = draftSpec({ repo: repository.url, baseCommit: repository.baseCommit, disclosureKey: disclosure.recipient });
    const submit = async (wallet, body) => {
      const challengeRes = await server.post('/api/listings/challenge', body);
      const challenge = await challengeRes.json();
      if (challengeRes.status !== 200) throw new Error(`the listing challenge: HTTP ${challengeRes.status} ${JSON.stringify(challenge)}`);
      return server.post('/api/listings', { ...body, auth: { nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) } });
    };
    const follow = async (id) => waitUntil('waiting for the listing', async () => {
      const { json } = await server.get(`/api/listings/${id}`);
      if (breakName === 'signal-in-scan' && json.status === 'scanning') process.kill(process.pid, 'SIGTERM');
      return ['ready', 'refused', 'error'].includes(json.status) ? json : null;
    }, { timeoutMs: LISTING_TIMEOUT_MS, everyMs: 1000, proc: server });

    // Q34: another wallet names itself as the maker: the repository's file says otherwise, nothing is built.
    const other = chain.accounts.other;
    const refusedRes = await submit(other, { spec: draft, allowlist: [], maker: other.address });
    const refused = refusedRes.status === 202 ? await follow((await refusedRes.json()).id) : await refusedRes.json();
    one('listing.proofRefusesAnotherWallet', refused.status === 'refused' && refused.refusal?.code === 'PROOF_NAMES_ANOTHER_ADDRESS', JSON.stringify(refused.refusal ?? refused));

    // Q31, on the site's whole path: a command a claim's runner refuses is refused here by the same code, and nothing is built.
    const shellRes = await submit(maker, { spec: { ...draft, commands: { ...draft.commands, build: 'true; forge build' } }, allowlist: [], maker: maker.address });
    const shell = shellRes.status === 202 ? await follow((await shellRes.json()).id) : await shellRes.json();
    one('listing.shellPrefixRefused', shell.status === 'refused' && shell.validationReport?.refusals?.[0]?.code === 'COMMAND_NOT_ALLOWED' && shell.validationReport.steps?.length === 1, JSON.stringify(shell.validationReport?.refusals ?? shell).slice(0, 400));

    const accepted = await submit(maker, { spec: draft, allowlist: [], maker: maker.address });
    one('listing.accepted', accepted.status === 202, `HTTP ${accepted.status}`);
    const view = await follow((await accepted.json()).id);
    one('listing.ready', view.status === 'ready', JSON.stringify({ status: view.status, error: view.error, refusal: view.refusal, refusals: view.validationReport?.refusals }));
    const validation = view.validationReport;
    one('listing.commandsAskedFirst', validation.commands?.canary === 'COMMAND_NOT_ALLOWED' && validation.commands.issues?.length === 0 && validation.steps[0]?.name === 'spec', JSON.stringify(validation.commands ?? null));
    const stepNames = validation.steps.filter((s) => s.status === 'ok').map((s) => s.name);
    one('listing.realBuilder', ['spec', 'control', 'fetch', 'build', 'size', 'push', 'registry', 'listingCheck', 'finalSpec'].every((s) => stepNames.includes(s)), stepNames.join(', '));
    const checkAnswer = runnerProxy.post('/v1/listing-checks').find((c) => c.status === 200)?.response;
    one('listing.onTheRunner', checkAnswer?.listing?.status === 'accepted', `the runner's listing check: ${checkAnswer?.listing?.status}, on ${checkAnswer?.runner?.platform}`);
    one('listing.officialCompiler', (checkAnswer?.listing?.compilers?.checked ?? []).some((c) => c.release === '0.8.31'), JSON.stringify(checkAnswer?.listing?.compilers?.checked ?? null));
    one('listing.imageByDigest', validation.image.ref.startsWith(`${registry.host}/${instance}/env@sha256:`), validation.image.ref);
    one('listing.devTrustExplicit', view.trust === 'dev' && view.devTrust?.dev === true && view.devTrust.keys.length === 1, `trust ${view.trust}`);
    const devKey = view.devTrust.keys[0].publicKey;

    // The bytes the chain will point at are the listing flow's, byte for byte, and hold only under dev trust.
    const archive = (cid) => ipfs.get(cid);
    const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
    one('listing.archiveBytes', sha256(archive(view.list.listingCid)) === view.archives.listing.sha256 && sha256(archive(view.list.disputeCid)) === view.archives.dispute.sha256, 'both archives on the local IPFS hash to what the listing flow reported');
    const { readSignedListing } = await import(path.join(APP_DIR, 'shared', 'src', 'builderSignature.js'));
    one('listing.notProductionTrust', readSignedListing(archive(view.list.listingCid), { codeReview }).signed === false && readSignedListing(archive(view.list.listingCid), { codeReview, devKeys: view.devTrust.keys }).signed === true, 'the attestation verifies under this run\'s dev key and under no production key');

    // The baseline scan: the maker's, through the wallet.
    one('scan.done', view.scan?.status === 'done', JSON.stringify(view.scan));
    const scanChallenge = await (await server.post(`/api/listings/${view.id}/scan/challenge`, {})).json();
    const scanRes = await server.post(`/api/listings/${view.id}/scan`, { nonce: scanChallenge.nonce, signature: await maker.signMessage(scanChallenge.message) });
    const scanAnswer = await scanRes.json();
    one('scan.makerReads', scanRes.status === 200 && scanAnswer.status === 'done' && Boolean(scanAnswer.scan), `HTTP ${scanRes.status}, ${scanAnswer.status}`);

    const sa = chain.sa;
    const makerSa = sa.connect(maker);
    const listReceipt = await mined(makerSa.list(view.list.params, view.list.listingCid, view.list.disputeCid, view.list.knownIssueIds));
    const parsedLogs = (receipt) => receipt.logs.map((l) => { try { return sa.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const listed = parsedLogs(listReceipt).find((e) => e.name === 'Listed');
    const listingId = listed.args.listingId;
    const artifactHash = listed.args.artifactHash;
    one('list.artifactHash', artifactHash === view.artifactHash, artifactHash);

    stage('fund');
    const feeDue = await sa.feeDue(listingId);
    await mined(makerSa.fund(listingId, feeDue, { value: feeDue + ESCROW_WEI }));
    const listingNow = await sa.getListing(listingId);
    one('fund.opened', Number(listingNow.state) === 1 && listingNow.escrowWei === ESCROW_WEI, `state ${listingNow.state}, escrow ${listingNow.escrowWei}`);
    const inFeed = await settleOutcome(async () => {
      const { json } = await server.get('/api/feed');
      return json.listings?.find((l) => l.listingId === String(listingId)) ? json : null;
    }, 'waiting for the feed to count the listing');
    one('feed.counted', inFeed.notCounted.length === 0, `${inFeed.listings.length} counted, ${inFeed.notCounted.length} not`);

    // The EA starts now, with the key the listing was signed by: dev trust is one explicit key.
    const adapter = track(await owned(h.startAdapter({ logDir, aiNodeUrl: aiProxy.url, runnerUrl: runnerProxy.url, runnerToken, ipfsUrl: ipfs.url, pinKey: ipfs.pinKey, devKey, operator: OPERATOR }), (a) => a.close()));
    one('ea.devTrust', adapter.health.codeReview.trust === 'dev' && adapter.health.codeReview.devKeyCount === 1 && adapter.health.codeReview.chainId === 31337, JSON.stringify(adapter.health.codeReview));
    bridge = createBridge({
      mock: chain.aggregator,
      evaluate: evaluateOver(adapter.url),
      operator: OPERATOR,
      requestedClass: codeReview.CODE_CLASSES['code-standard'].classId,
      log,
    });
    closers.push(async () => { report.cancelledJobs = await bridge.stop(); });
    await bridge.start(chain.fromBlock);
    one('mock.realFee', (await chain.aggregator.feeMultiplier()) === BigInt(REAL_CONFIG.k + REAL_CONFIG.bonus * REAL_CONFIG.p), 'maxTotalFee = fee x (K + B x P)');

    // The builder pushed from this daemon: off it, or no run ever pulls. From here on the only copy
    // is in the registry, as on an arbiter's host. (The builder removes its own tag; the listing check's
    // reference goes too, and this says so whichever of them left what.)
    await removeRunImages(h, docker, instance);
    const onTheDaemon = (await leftovers(h, docker, instance)).images;
    one('image.offTheDaemon', onTheDaemon.length === 0, onTheDaemon.join(', ') || 'only in the registry');
    const tool = createTool({ chain, ipfs, runnerUrl: hunterRunner.url, runnerToken, devKey, log });
    const hunter = chain.accounts.hunter;
    const provider = chain.provider;
    const balance = (who) => provider.getBalance(who.address);
    // A balance as of a transaction's block: what the keeper does next, however soon, is not in it.
    const balanceAfterTx = async (who, hash) => provider.getBalance(who.address, (await provider.getTransactionReceipt(hash)).blockNumber);
    const claimStateOf = async (id) => CLAIM_STATES[Number(await sa.claimState(id))];
    const stateIs = (id, ...states) => settleOutcome(async () => {
      if (bridge.failure()) throw bridge.failure();
      return states.includes(await claimStateOf(id));
    }, `waiting for claim ${id} to be ${states.join(' or ')}`);
    const eventOf = async (name, id) => {
      const events = await sa.queryFilter(sa.filters[name](id), chain.fromBlock);
      return events;
    };
    const senderOf = async (event) => (event ? (await provider.getTransaction(event.transactionHash)).from : null);
    const uploadsOf = (list) => String(list).split(',').map((cid) => {
      const bytes = ipfs.get(cid);
      return bytes ? JSON.parse(bytes.toString('utf8')) : null;
    });
    const { readExecutionEvidence } = await import(path.join(APP_DIR, 'tool', 'src', 'index.js'));
    const toolDone = (name, r) => one(`tool.${name}`, r.code === 0, `exit ${r.code}: ${r.stderr.slice(0, 400)}`);
    const makerRelease = (id) => mined(makerSa.release(id));
    const counts = () => ({ runner: runnerProxy.post('/v1/runs').length, ai: aiProxy.post('/api/rank-and-justify').length, provider: providerCalls().length });
    const since = (before) => ({
      runnerCalls: runnerProxy.post('/v1/runs').slice(before.runner),
      aiCalls: aiProxy.post('/api/rank-and-justify').slice(before.ai),
      providerCalls: providerCalls().slice(before.provider),
    });
    // The whole addendum, strictly: a claim round's is the one line and nothing else (erratum E1).
    const parsedLine = (addendum) => {
      const parsed = codeReview.parseAddendum(String(addendum));
      return parsed.ok && parsed.dispute === null ? parsed.disclosure : null;
    };
    /** The claim's latest round, once every job of it has answered: what the checks read is the whole of it. */
    const roundOf = async (claimId) => {
      const events = await sa.queryFilter(sa.filters.EvaluationRequested(claimId), chain.fromBlock);
      const aggId = events[events.length - 1].args.requestId;
      await bridge.done(aggId);
      return bridge.quiet(aggId);
    };
    const recordView = async () => (await server.get(`/api/records/${artifactHash}`)).json;

    // ---------------------------------------------------------------- a claim the jury decides
    stage('valid: check and commit');
    const validDir = claimFolder(workDir, 'valid');
    const validCheck = await tool('check', validDir, '--listing', String(listingId));
    one('valid.check.passes', validCheck.code === 0 && validCheck.json?.forecast?.verdict === 'pass', `${validCheck.json?.forecast?.verdict}: ${JSON.stringify(validCheck.json?.forecast?.abstain ?? validCheck.stderr.slice(0, 300))}`);
    one('valid.check.platform', validCheck.json.forecast.runner.platform === h.platform, validCheck.json.forecast.runner.platform);
    const runsBeforeCommit = runnerProxy.post('/v1/runs').length;
    const validCommit = await tool('commit', validDir, '--listing', String(listingId), '--yes');
    toolDone('commit', validCommit);
    const validId = BigInt(validCommit.json.claimId);
    const onChain = await sa.getClaim(validId);
    one('valid.commit.hashes', onChain.archiveHash === validCommit.json.archiveSha256 && onChain.ciphertextSha256 === validCommit.json.ciphertextSha256, onChain.archiveHash);
    one('valid.commit.disclosed', onChain.disclosedAt !== 0n && onChain.ciphertextCid === validCommit.json.ciphertextCid, onChain.ciphertextCid);

    // The maker reads the proof first: the ciphertext is theirs to decrypt, nothing readable is public.
    const ciphertext = ipfs.get(onChain.ciphertextCid);
    one('valid.disclosure.ciphertextOnIpfs', `0x${sha256(ciphertext)}` === onChain.ciphertextSha256, onChain.ciphertextCid);
    const plaintext = Buffer.from(codeReview.decryptDisclosure(new Uint8Array(ciphertext), disclosure.identity));
    one('valid.disclosure.makerDecrypts', `0x${sha256(plaintext)}` === onChain.archiveHash, 'the maker\'s key opens it, and it hashes to the commitment');
    one('valid.disclosure.notReadable', !ciphertext.includes(POC_MARKER) && !ciphertext.includes(REPORT_MARKER), 'the pinned bytes hold neither the proof nor the report');
    one('valid.embargo.noArbiterYet', runnerProxy.post('/v1/runs').length === runsBeforeCommit && aiProxy.post('/api/rank-and-justify').length === 0 && bridge.rounds.size === 0, 'no arbiter has seen it');

    // Embargo: the tool refuses before the fix window ends; the chain would too.
    const early = await tool('reveal', validDir);
    one('valid.embargo.revealRefused', early.code !== 0 && /NOT_REVEALABLE_YET/.test(early.stderr), `exit ${early.code}: ${early.stderr.slice(0, 200)}`);
    const pinnedBeforeReveal = [...ipfs.pins];

    // A second claim commits behind it: commit order (D5).
    stage('gate: check and commit behind the first');
    const gateDir = claimFolder(workDir, 'gate');
    const gateCheck = await tool('check', gateDir, '--listing', String(listingId));
    const forecastGate = gateCheck.json?.forecast?.gates?.find((g) => g.name === 'testPathsOnly');
    one('gate.check.forecast', gateCheck.code === 1 && gateCheck.json?.forecast?.verdict === 'fail' && forecastGate?.status === 'fail' && gateCheck.json.forecast.settlesAs?.outcome === 'INVALID', `${gateCheck.json?.forecast?.verdict}, testPathsOnly ${forecastGate?.status}, settles as ${gateCheck.json?.forecast?.settlesAs?.outcome}`);
    const gateCommit = await tool('commit', gateDir, '--listing', String(listingId), '--yes');
    toolDone('commit', gateCommit);
    const gateId = BigInt(gateCommit.json.claimId);
    await makerRelease(gateId);
    const outOfOrder = await tool('reveal', gateDir);
    one('gate.order.waitsItsTurn', outOfOrder.code !== 0 && /OUT_OF_ORDER/.test(outOfOrder.stderr), `exit ${outOfOrder.code}: ${outOfOrder.stderr.slice(0, 200)}`);

    // ---------------------------------------------------------------- back to the first: release, reveal, judge, settle
    stage('valid: release and reveal');
    await makerRelease(validId);
    one('valid.release.released', (await eventOf('Released', validId)).length === 1, 'Released on the chain');
    if (breakName === 'valid-claim-abstains') {
      log('[round] break: the AI Node goes down, so the jury cannot be reached');
      await aiNode.close();
    }
    const validReveal = await tool('reveal', validDir);
    toolDone('reveal', validReveal);
    const hunterAfterReveal = await balanceAfterTx(hunter, validReveal.json.tx);
    const makerBeforeJudge = await balanceAfterTx(maker, validReveal.json.tx);
    const before1 = { runner: runsBeforeCommit, ai: 0, provider: 0 };
    const validRound = await roundOf(validId);
    const validClaim = await sa.getClaim(validId);
    one('valid.plaintext.pinnedOnlyAtReveal', !pinnedBeforeReveal.includes(validClaim.bcid) && ipfs.pins.includes(validClaim.bcid) && pinnedBeforeReveal.includes(validClaim.ciphertextCid), `${pinnedBeforeReveal.length} pins before the reveal: the ciphertext among them, the archive not`);
    expect(requestChecks('valid', validRound, {
      listingCid: view.list.listingCid,
      bcid: validClaim.bcid,
      requestedClass: codeReview.CODE_CLASSES['code-standard'].classId,
      oracle: view.list.params.oracle,
      disclosure: { parsed: parsedLine(validRound.addendum), archiveSha256: validClaim.archiveHash, ciphertextSha256: validClaim.ciphertextSha256, ciphertextCid: validClaim.ciphertextCid },
    }));
    expect(servedRoundChecks('valid', validRound, { vector: JURY_AVERAGE }));

    stage('valid: judge');
    const validPath = since(before1);
    const validAnswer = validPath.runnerCalls[0]?.response;
    expect(juryPathChecks('valid', {
      ...validPath,
      panel,
      justifier: JUSTIFIER,
      disclosureKeys: [parsedLine(validRound.addendum)?.contentKey, parsedLine(validRound.addendum)?.ephemeralKey].filter(Boolean),
      markers: [REPORT_MARKER, POC_MARKER],
      average: JURY_AVERAGE,
      maxTokens: codeReview.CODE_CLASSES['code-standard'].envelope.jurorOutputTokens,
      report: { classPlatform: report.classPlatform, classPlatformName: CLASS_PLATFORM },
    }));
    // A6a's own checks on what the EA sent the AI Node and on the report's gates, for every job.
    one('valid.report.everyGatePassed', h.gatesPassed(validAnswer?.report).ok, h.gatesPassed(validAnswer?.report).detail);
    validPath.aiCalls.forEach((call, i) => {
      for (const c of h.aiRequestChecks(call, { pack: validAnswer?.contextPack, reportSha256: validAnswer?.reportSha256, deadlineLimitMs: EA_DEADLINE_LIMIT_MS, validate: codeReview.validateCodeReviewRequest })) one(`valid.job${i}.${c.name}`, c.ok, c.detail);
    });
    const validWatch = await tool('status', validDir, '--wait', '--max-wait-ms', String(CHAIN_WAIT_MS));
    one('tool.statusWait', validWatch.code === 0 && ['Judged', 'Revealed'].includes(validWatch.json?.state), `exit ${validWatch.code}, ${validWatch.json?.state}`);
    await stateIs(validId, 'Judged');
    const judgedEvent = (await eventOf('Judged', validId))[0];
    one('valid.judged.outcome', OUTCOMES[Number(judgedEvent.args.outcome)] === 'HIGH', OUTCOMES[Number(judgedEvent.args.outcome)]);
    const uploaded = uploadsOf(judgedEvent.args.justificationCid);
    const judgedStatus = await tool('status', validDir);
    expect(evidenceChecks('valid', {
      uploads: uploaded,
      evidences: uploaded.map((u) => readExecutionEvidence(u?.justification)),
      settlement: 'jury',
      source: 'code-review-jury',
      reportSha256: validAnswer.reportSha256,
      expectedCount: REAL_CONFIG.p,
    }));
    one('valid.status.evidence', judgedStatus.json?.evidence?.settlement === 'jury', JSON.stringify(judgedStatus.json?.evidence));
    one('valid.refund.atFinalize', (await eventOf('LeftoverRefunded', validId))[0]?.args.amountWei === validRound.required - validRound.spent, `${(await eventOf('LeftoverRefunded', validId))[0]?.args.amountWei}`);

    stage('valid: dispute window, then settle');
    // Erratum E9 (node P18): the HIGH award is above the listing's size, so it waits for the dispute panel
    const [confirmOpensAt, confirmDeadline] = await sa.confirmWindow(validId);
    one('valid.confirm.awaits', confirmDeadline > 0n && (await sa.settleableAt(validId)) === confirmDeadline && confirmDeadline - confirmOpensAt === BigInt(WINDOWS.reveal), `confirm from ${confirmOpensAt} until ${confirmDeadline}; settleable at ${await sa.settleableAt(validId)}`);
    const keeperRunsBefore = (await server.get('/api/status')).json.keeper?.lastRun?.at ?? 0;
    await settleOutcome(async () => ((await server.get('/api/status')).json.keeper?.lastRun?.at ?? 0) > keeperRunsBefore + 1000, 'waiting for keeper cycles');
    one('valid.settle.waitsDisputeWindow', (await claimStateOf(validId)) === 'Judged' && (await eventOf('ConfirmationRequested', validId)).length === 0, 'the keeper leaves a valid verdict alone inside the dispute window, and starts no confirmation in it');
    const escrowBeforeConfirm = (await sa.getListing(listingId)).escrowWei;
    await chain.advance(WINDOWS.dispute + 1);
    // the keeper starts the confirmation, the listing's escrow paying it
    const confirmEvent = await settleOutcome(async () => (await eventOf('ConfirmationRequested', validId))[0] ?? null, 'waiting for the keeper to call confirm');
    one('valid.confirm.byKeeper', (await senderOf(confirmEvent)) === chain.accounts.keeper.address, `confirm from ${await senderOf(confirmEvent)}`);
    const confirmRound = await bridge.quiet(confirmEvent.args.requestId);
    one('valid.confirm.request.disputeArchive', confirmRound.cids[0] === view.list.disputeCid && confirmRound.cids[1] === validClaim.bcid && confirmRound.cids.length === 2, JSON.stringify(confirmRound.cids));
    one('valid.confirm.request.noDisputeLine', parsedLine(confirmRound.addendum) !== null && JSON.stringify(parsedLine(confirmRound.addendum)) === JSON.stringify(parsedLine(validRound.addendum)), `the claim's E1 line alone: ${String(confirmRound.addendum).slice(0, 120)}`);
    const escrowAtConfirm = (await sa.getListing(listingId, { blockTag: confirmEvent.blockNumber })).escrowWei;
    one('valid.confirm.escrowPaid', confirmEvent.args.prepayWei === confirmRound.required && escrowAtConfirm === escrowBeforeConfirm - confirmEvent.args.prepayWei, `prepay ${confirmEvent.args.prepayWei}, the live fee ${confirmRound.required}; escrow ${escrowBeforeConfirm} -> ${escrowAtConfirm}`);
    await stateIs(validId, 'Settled');
    const confirmJudged = (await eventOf('DisputeJudged', validId))[0];
    one('valid.confirm.held', DISPUTE_RESULTS[Number(confirmJudged?.args.result)] === 'Held' && OUTCOMES[Number(confirmJudged?.args.outcome)] === 'HIGH' && DISPUTE_KINDS[Number((await sa.getClaim(validId)).disputeKind)] === 'Confirmation', `${DISPUTE_RESULTS[Number(confirmJudged?.args.result)]}: ${OUTCOMES[Number(confirmJudged?.args.outcome)]}`);
    one('valid.confirm.keeperFinalized', (await senderOf(confirmJudged)) === chain.accounts.keeper.address, `the second finalize from ${await senderOf(confirmJudged)}`);
    const settledValid = (await eventOf('Settled', validId))[0];
    one('valid.confirm.settledAfter', settledValid.blockNumber >= confirmJudged.blockNumber && (await provider.getBlock(settledValid.blockNumber)).timestamp < Number(confirmDeadline), `settled at block ${settledValid.blockNumber}, the panel's verdict at ${confirmJudged.blockNumber}, before the deadline`);
    // what the round spent of the escrow: its prepay less what came back as a top-up
    const confirmRefund = (await eventOf('ConfirmationRefunded', validId))[0];
    const confirmSpent = confirmEvent.args.prepayWei - (confirmRefund ? confirmRefund.args.toOwedWei + confirmRefund.args.toEscrowWei + confirmRefund.args.toMakerWei : 0n);
    const hunterAfterSettle = await balance(hunter);
    const validFinal = await sa.getClaim(validId);
    expect(settlementChecks('valid', {
      state: await claimStateOf(validId),
      outcome: OUTCOMES[Number(validFinal.outcome)],
      expectedOutcome: 'HIGH',
      finalizeFrom: await senderOf(judgedEvent),
      settleFrom: await senderOf(settledValid),
      keeper: chain.accounts.keeper.address,
      vector: validFinal.vector.map((v) => BigInt(v)),
      expectedVector: [...JURY_AVERAGE],
    }));
    expect(moneyChecks('valid', [
      { name: 'hunter', before: hunterAfterReveal, after: hunterAfterSettle, expected: AWARDS_WEI.HIGH + BOND_WEI + (validRound.required - validRound.spent) },
      { name: 'makerUntouched', before: makerBeforeJudge, after: await balance(maker), expected: 0n },
    ]));
    const hunterClaim = await tool('claim', validDir);
    toolDone('claim', hunterClaim);
    one('valid.tool.claimNothingDue', hunterClaim.json?.sent?.length === 0 && (await balance(hunter)) === hunterAfterSettle, `sent ${JSON.stringify(hunterClaim.json?.sent)}`);
    const recordAfterValid = await settleOutcome(async () => {
      const r = await recordView();
      return r.record?.history?.outcomes?.[4] === '1' ? r : null;
    }, 'waiting for the record to show the settled finding');
    expect(recordChecks('valid', recordAfterValid, {
      artifactHash,
      listingId,
      outcomes: [0, 0, 0, 0, 1, 0],
      claims: 2,
      released: 2,
      noVerdict: 0,
      findings: [{ claimId: String(validId), outcome: 'HIGH', paidWei: AWARDS_WEI.HIGH.toString(), owedWei: '0', bcid: validFinal.bcid }],
      escrowWei: ESCROW_WEI - AWARDS_WEI.HIGH - confirmSpent,
      bondWei: BOND_WEI,
      awards: [AWARDS_WEI.LOW, AWARDS_WEI.MEDIUM, AWARDS_WEI.HIGH, AWARDS_WEI.CRITICAL],
    }).filter((c) => !c.name.endsWith('.record.claims')));
    const confirmedHistory = recordAfterValid.record.history;
    one('valid.record.confirmations', confirmedHistory.confirmationRounds === '1' && confirmedHistory.confirmationsHeld === '1' && confirmedHistory.confirmationsNoVerdict === '0' && recordAfterValid.record.findings[0]?.disputeKind === 'Confirmation' && recordAfterValid.record.listings[0]?.confirmAboveWei === AWARDS_WEI.MEDIUM.toString(), `rounds ${confirmedHistory.confirmationRounds}, held ${confirmedHistory.confirmationsHeld}; the finding's round ${recordAfterValid.record.findings[0]?.disputeKind}`);
    one('valid.record.pendingIsTheNextClaim', recordAfterValid.record.history.claims === '2' && recordAfterValid.record.history.pending === '1', `claims ${recordAfterValid.record.history.claims}, pending ${recordAfterValid.record.history.pending}`);
    const badge = await fetch(`${server.url}/api/records/${artifactHash}/badge.svg`);
    one('valid.badge', badge.ok && recordAfterValid.badge?.state === 'finding', recordAfterValid.badge?.message);

    // ---------------------------------------------------------------- a claim the gates settle
    stage('gate: reveal, INVALID, the appeal window, the bond to the maker');
    const before2 = counts();
    const gateReveal = await tool('reveal', gateDir);
    toolDone('reveal', gateReveal);
    const hunterAfterGateReveal = await balanceAfterTx(hunter, gateReveal.json.tx);
    const makerBeforeGate = await balanceAfterTx(maker, gateReveal.json.tx);
    const gateRound = await roundOf(gateId);
    const gateClaim = await sa.getClaim(gateId);
    expect(requestChecks('gate', gateRound, {
      listingCid: view.list.listingCid,
      bcid: gateClaim.bcid,
      priorBcids: [validFinal.bcid],
      requestedClass: codeReview.CODE_CLASSES['code-standard'].classId,
      oracle: view.list.params.oracle,
      disclosure: { parsed: parsedLine(gateRound.addendum), archiveSha256: gateClaim.archiveHash, ciphertextSha256: gateClaim.ciphertextSha256, ciphertextCid: gateClaim.ciphertextCid },
    }));
    expect(servedRoundChecks('gate', gateRound, { vector: INVALID_VECTOR }));
    expect(gateSettledChecks('gate', { ...since(before2), gate: 'testPathsOnly' }));
    // A claim round's INVALID waits out its appeal window, the dispute window, before anyone but its hunter
    // may settle it (erratum E7, node P16): the keeper leaves it alone until then. The hunter does not appeal
    // here (the tool's appeal is node P18's).
    await stateIs(gateId, 'Judged');
    const gateKeeperRunsBefore = (await server.get('/api/status')).json.keeper?.lastRun?.at ?? 0;
    await settleOutcome(async () => ((await server.get('/api/status')).json.keeper?.lastRun?.at ?? 0) > gateKeeperRunsBefore + 1000, 'waiting for keeper cycles');
    one('gate.settle.waitsAppealWindow', (await claimStateOf(gateId)) === 'Judged', 'the keeper leaves a claim round\'s INVALID alone inside its appeal window');
    await chain.advance(WINDOWS.dispute + 1);
    await stateIs(gateId, 'Settled');
    const gateJudged = (await eventOf('Judged', gateId))[0];
    const gateSettled = (await eventOf('Settled', gateId))[0];
    const gateFinal = await sa.getClaim(gateId);
    const gateUploads = uploadsOf(gateJudged.args.justificationCid);
    expect(evidenceChecks('gate', { uploads: gateUploads, evidences: gateUploads.map((u) => readExecutionEvidence(u?.justification)), settlement: 'INVALID (testPathsOnly)', source: 'code-review-runner', expectedCount: REAL_CONFIG.p }));
    expect(settlementChecks('gate', {
      state: await claimStateOf(gateId),
      outcome: OUTCOMES[Number(gateFinal.outcome)],
      expectedOutcome: 'INVALID',
      finalizeFrom: await senderOf(gateJudged),
      settleFrom: await senderOf(gateSettled),
      keeper: chain.accounts.keeper.address,
      vector: gateFinal.vector.map((v) => BigInt(v)),
      expectedVector: [...INVALID_VECTOR],
    }));
    const secondsToSettle = (await provider.getBlock(gateSettled.blockNumber)).timestamp - (await provider.getBlock(gateJudged.blockNumber)).timestamp;
    one('gate.settled.afterAppealWindow', secondsToSettle >= WINDOWS.dispute, `${secondsToSettle} s on the chain's clock after the verdict: a claim round's INVALID waits out the ${WINDOWS.dispute} s appeal window`);
    expect(moneyChecks('gate', [
      { name: 'bondToMaker', before: makerBeforeGate, after: await balance(maker), expected: BOND_WEI },
      { name: 'hunter', before: hunterAfterGateReveal, after: await balance(hunter), expected: gateRound.required - gateRound.spent },
    ]));

    // ---------------------------------------------------------------- a claim a non-tamper integrity check settles
    stage('integrity: check, commit, release');
    const integrityDir = claimFolder(workDir, 'integrity');
    const integrityCheck = await tool('check', integrityDir, '--listing', String(listingId));
    one('integrity.check.forecast', integrityCheck.code === 1 && integrityCheck.json?.forecast?.verdict === 'fail' && integrityCheck.json.forecast.settlesAs?.outcome === 'DUPLICATE' && integrityCheck.json.forecast.settlesAs?.bond === 'returned', `${integrityCheck.json?.forecast?.verdict}, settles as ${integrityCheck.json?.forecast?.settlesAs?.outcome}, bond ${integrityCheck.json?.forecast?.settlesAs?.bond}: ${integrityCheck.stderr.slice(0, 200)}`);
    const integrityCommit = await tool('commit', integrityDir, '--listing', String(listingId), '--yes');
    toolDone('commit', integrityCommit);
    const integrityId = BigInt(integrityCommit.json.claimId);
    await makerRelease(integrityId);

    stage('integrity: reveal, DUPLICATE, the bond back');
    const beforeIntegrity = counts();
    const integrityReveal = await tool('reveal', integrityDir);
    toolDone('reveal', integrityReveal);
    const hunterAfterIntegrityReveal = await balanceAfterTx(hunter, integrityReveal.json.tx);
    const makerBeforeIntegrity = await balanceAfterTx(maker, integrityReveal.json.tx);
    const integrityRound = await roundOf(integrityId);
    const integrityClaim = await sa.getClaim(integrityId);
    expect(requestChecks('integrity', integrityRound, {
      listingCid: view.list.listingCid,
      bcid: integrityClaim.bcid,
      priorBcids: [validFinal.bcid],
      requestedClass: codeReview.CODE_CLASSES['code-standard'].classId,
      oracle: view.list.params.oracle,
      disclosure: { parsed: parsedLine(integrityRound.addendum), archiveSha256: integrityClaim.archiveHash, ciphertextSha256: integrityClaim.ciphertextSha256, ciphertextCid: integrityClaim.ciphertextCid },
    }));
    expect(servedRoundChecks('integrity', integrityRound, { vector: DUPLICATE_VECTOR }));
    const integrityPath = since(beforeIntegrity);
    expect(integrityRunChecks('integrity', { ...integrityPath, failedCheck: INTEGRITY_CHECK }));
    await stateIs(integrityId, 'Settled');
    const integrityJudged = (await eventOf('Judged', integrityId))[0];
    const integritySettled = (await eventOf('Settled', integrityId))[0];
    const integrityFinal = await sa.getClaim(integrityId);
    // The real writer's bytes, read by the reader the record and the tool use: the first time they meet.
    const integrityUploads = uploadsOf(integrityJudged.args.justificationCid);
    const integrityEvidences = integrityUploads.map((u) => readExecutionEvidence(u?.justification));
    expect(evidenceChecks('integrity', { uploads: integrityUploads, evidences: integrityEvidences, settlement: 'DUPLICATE (integrity)', source: 'code-review-integrity', reportSha256: integrityPath.runnerCalls[0]?.response?.reportSha256 ?? null, expectedCount: REAL_CONFIG.p }));
    one('integrity.evidence.failedChecks', integrityEvidences.every((e) => JSON.stringify(e?.integrityFailedChecks) === JSON.stringify([INTEGRITY_CHECK]) && e?.tamperFlags === 'none'), JSON.stringify(integrityEvidences.map((e) => [e?.integrityFailedChecks, e?.tamperFlags])));
    const integrityStatus = await tool('status', integrityDir);
    one('integrity.status.readsTheBlock', integrityStatus.json?.evidence?.settlement === 'DUPLICATE (integrity)' && integrityStatus.json.evidence.integrityFailedChecks?.includes(INTEGRITY_CHECK), JSON.stringify(integrityStatus.json?.evidence));
    expect(settlementChecks('integrity', {
      state: await claimStateOf(integrityId),
      outcome: OUTCOMES[Number(integrityFinal.outcome)],
      expectedOutcome: 'DUPLICATE',
      finalizeFrom: await senderOf(integrityJudged),
      settleFrom: await senderOf(integritySettled),
      keeper: chain.accounts.keeper.address,
      vector: integrityFinal.vector.map((v) => BigInt(v)),
      expectedVector: [...DUPLICATE_VECTOR],
    }));
    const secondsToSettleIntegrity = (await provider.getBlock(integritySettled.blockNumber)).timestamp - (await provider.getBlock(integrityJudged.blockNumber)).timestamp;
    one('integrity.settled.noDisputeWindow', secondsToSettleIntegrity < WINDOWS.dispute, `${secondsToSettleIntegrity} s on the chain's clock after the verdict: a DUPLICATE does not wait out the ${WINDOWS.dispute} s window`);
    expect(moneyChecks('integrity', [
      { name: 'bondBack', before: hunterAfterIntegrityReveal, after: await balance(hunter), expected: BOND_WEI + (integrityRound.required - integrityRound.spent) },
      { name: 'makerUntouched', before: makerBeforeIntegrity, after: await balance(maker), expected: 0n },
    ]));
    // The record reads the justifications beside the indexer, so it says this a moment after the chain does.
    const recordWithIntegrity = await settleOutcome(async () => {
      const r = await recordView();
      const read = r.integrity?.listings?.[String(listingId)];
      return read && read.failed + read.otherDuplicates === 1 && read.unread === 0 ? r : null;
    }, 'waiting for the record to read the claim\'s justifications');
    const { INTEGRITY_NOTE } = await import(path.join(APP_DIR, 'shared', 'src', 'executionEvidence.js'));
    expect(integrityRecordChecks('integrity', recordWithIntegrity, { listingId, failed: 1, checks: [{ check: INTEGRITY_CHECK, count: 1 }], note: INTEGRITY_NOTE }));

    // ---------------------------------------------------------------- a claim every arbiter abstains on (E6)
    stage('abstain: check, commit, reveal');
    const abstainDir = claimFolder(workDir, 'abstain');
    const abstainCheck = await tool('check', abstainDir, '--listing', String(listingId));
    one('abstain.check.forecast', abstainCheck.code === 1 && abstainCheck.json?.forecast?.verdict === 'abstain' && abstainCheck.json.forecast.abstain?.cause === 'step_timeout', `${abstainCheck.json?.forecast?.verdict}, ${abstainCheck.json?.forecast?.abstain?.cause}`);
    const abstainCommit = await tool('commit', abstainDir, '--listing', String(listingId), '--yes');
    toolDone('commit', abstainCommit);
    const abstainId = BigInt(abstainCommit.json.claimId);
    await makerRelease(abstainId);
    const before3 = counts();
    const pinsBeforeAbstain = ipfs.pins.length;
    const abstainReveal = await tool('reveal', abstainDir);
    toolDone('reveal', abstainReveal);
    const hunterAfterAbstainReveal = await balanceAfterTx(hunter, abstainReveal.json.tx);
    const firstRound = await roundOf(abstainId);
    expect(abstainedRoundChecks('abstain.first', firstRound));
    expect(abstainRunChecks('abstain.first', { round: firstRound, ...since(before3), cause: 'step_timeout' }));

    stage('abstain: the round times out at the aggregator');
    one('abstain.first.stillOpen', (await claimStateOf(abstainId)) === 'Revealed', 'an open round: nobody can finalize it yet');
    await chain.advance(RESPONSE_TIMEOUT_SECONDS + 1);
    await stateIs(abstainId, 'RoundFailed');
    const failed = await eventOf('EvaluationFailed', abstainId);
    one('abstain.first.failedBy', (await senderOf(failed[0])) === chain.accounts.keeper.address, 'the keeper finalized the failed round');
    const baseOnly = firstRound.required - firstRound.spent;
    expect(moneyChecks('abstain.first', [{ name: 'refundAtFinalize', before: hunterAfterAbstainReveal, after: await balance(hunter), expected: baseOnly }]));
    const failedStatus = await tool('status', abstainDir);
    one('abstain.status.saysRetrigger', failedStatus.json?.state === 'RoundFailed' && /--retrigger/.test(failedStatus.json?.next ?? ''), failedStatus.json?.next);

    stage('abstain: re-trigger, a fresh prepay, and it fails again');
    const before4 = counts();
    const retrigger = await tool('reveal', abstainDir, '--retrigger');
    toolDone('retrigger', retrigger);
    const afterRetrigger = await balanceAfterTx(hunter, retrigger.json.tx);
    const retriggerTx = await provider.getTransaction(retrigger.json.tx);
    const prepaid = (await sa.queryFilter(sa.filters.EvaluationRequested(abstainId), chain.fromBlock)).pop().args;
    one('abstain.retrigger.freshPrepay', retriggerTx.value === firstRound.required && prepaid.prepayWei === firstRound.required && (await chain.aggregator.ethReceived(prepaid.requestId)) === firstRound.required, `sent ${retriggerTx.value}, the aggregator received ${await chain.aggregator.ethReceived(prepaid.requestId)}, the live fee is ${firstRound.required}`);
    one('abstain.retrigger.isTheHuntersTx', retriggerTx.from === hunter.address, retriggerTx.from);
    await stateIs(abstainId, 'Revealed');
    const secondRound = await roundOf(abstainId);
    expect(abstainedRoundChecks('abstain.second', secondRound));
    expect(abstainRunChecks('abstain.second', { round: secondRound, ...since(before4), cause: 'step_timeout' }));
    await chain.advance(RESPONSE_TIMEOUT_SECONDS + 1);
    await stateIs(abstainId, 'RoundFailed');
    expect(moneyChecks('abstain.second', [{ name: 'refundAtFinalize', before: afterRetrigger, after: await balance(hunter), expected: secondRound.required - secondRound.spent }]));

    stage('abstain: expiry, the bond to the maker');
    const makerBeforeExpiry = await balance(maker);
    const hunterBeforeExpiry = await balance(hunter);
    const deadline = await sa.retriggerDeadline(abstainId);
    await chain.advance(Number(deadline) - await chain.latest() + 1);
    await stateIs(abstainId, 'Expired');
    one('abstain.keeper.expired', (await senderOf((await eventOf('Expired', abstainId))[0])) === chain.accounts.keeper.address, 'the keeper expired it, with SA_KEEPER_EXPIRE=on');
    expect(moneyChecks('abstain.expiry', [
      { name: 'bondToMaker', before: makerBeforeExpiry, after: await balance(maker), expected: BOND_WEI },
      { name: 'hunterGetsNothing', before: hunterBeforeExpiry, after: await balance(hunter), expected: 0n },
    ]));

    // ---------------------------------------------------------------- the record
    stage('record');
    const abstainFinal = await sa.getClaim(abstainId);
    const finalView = await settleOutcome(async () => {
      const r = await recordView();
      return r.record?.history?.noVerdict === '1' && r.record?.history?.outcomes?.[0] === '1' ? r : null;
    }, 'waiting for the record to show all four claims');
    expect(abstainEndChecks('abstain', {
      state: await claimStateOf(abstainId),
      expiry: EXPIRIES[Number(abstainFinal.expiry)],
      judgedEvents: (await eventOf('Judged', abstainId)).length,
      settledEvents: (await eventOf('Settled', abstainId)).length,
      record: finalView.record,
      // the reveal pinned the claim itself; the arbiters, nothing
      uploads: ipfs.pins.slice(pinsBeforeAbstain).filter((cid) => cid !== abstainFinal.bcid),
    }));
    expect(recordChecks('final', finalView, {
      artifactHash,
      listingId,
      outcomes: [1, 1, 0, 0, 1, 0],
      claims: 4,
      released: 4,
      noVerdict: 1,
      findings: [{ claimId: String(validId), outcome: 'HIGH', paidWei: AWARDS_WEI.HIGH.toString(), owedWei: '0', bcid: validFinal.bcid }],
      escrowWei: ESCROW_WEI - AWARDS_WEI.HIGH - confirmSpent,
      bondWei: BOND_WEI,
      awards: [AWARDS_WEI.LOW, AWARDS_WEI.MEDIUM, AWARDS_WEI.HIGH, AWARDS_WEI.CRITICAL],
    }));
    const lensRecord = await sa.recordByHash(artifactHash, { blockTag: finalView.block.number });
    const apiHistory = finalView.record.history;
    one('final.record.isTheChains', String(lensRecord.history.claims) === apiHistory.claims && String(lensRecord.history.noVerdict) === apiHistory.noVerdict && String(lensRecord.history.released) === apiHistory.released
      && JSON.stringify(lensRecord.history.outcomes.map(String)) === JSON.stringify(apiHistory.outcomes)
      && JSON.stringify(lensRecord.findings.map((f) => f.bcid)) === JSON.stringify(finalView.record.findings.map((f) => f.bcid)), `at block ${finalView.block.number}: the lens and the API agree: outcomes ${apiHistory.outcomes}, findings ${lensRecord.findings.length}`);

    const events = (await server.get('/api/feed/events?limit=500')).json.events;
    const fullOf = (claimId) => events.filter((e) => e.claimId === String(claimId) && e.name === 'Judged');
    one('final.events.validPublished', fullOf(validId)[0]?.args?.justificationCid === judgedEvent.args.justificationCid, 'a valid finding\'s events are in full');
    one('final.events.invalidHidden', !JSON.stringify(events.filter((e) => e.claimId === String(gateId))).includes(gateFinal.bcid), 'an INVALID claim\'s events keep only their ids');
    one('final.events.duplicateHidden', !JSON.stringify(events.filter((e) => e.claimId === String(integrityId))).includes(integrityFinal.bcid), 'so do a DUPLICATE\'s');
    const status = (await server.get('/api/status')).json;
    one('final.keeper.noError', status.keeper?.enabled === true && status.keeper?.error === null && status.keeper?.address === chain.accounts.keeper.address, JSON.stringify(status.keeper?.error));
    one('final.indexer.confirms', status.indexer?.confirmations === 2 && status.indexer?.fresh === true, `confirmations ${status.indexer?.confirmations}, fresh ${status.indexer?.fresh}`);

    const pages = await readPages(chromium, client.url, { artifactHash, listingId, onBrowser: (b) => closers.push(() => b.close()) });
    one('final.page.confirmations', pages.record.confirmations === '1' && pages.record.confirmationResults.includes('same outcome 1'), `${pages.record.confirmations}: ${pages.record.confirmationResults}`);
    expect(integrityPageChecks('final', pages, { failed: 1, check: INTEGRITY_CHECK, count: 1, note: INTEGRITY_NOTE, bcid: integrityFinal.bcid }));
    expect(pageChecks('final', pages, {
      artifactHash,
      claims: 4,
      judged: 3,
      released: 4,
      state: 'open',
      verdicts: ['INVALID: 1', 'DUPLICATE: 1', 'LOW: 0', 'MEDIUM: 0', 'HIGH: 1', 'CRITICAL: 0'],
      noVerdict: 1,
      findingBcid: validFinal.bcid,
      invalidBcid: gateFinal.bcid,
    }));

    // ---------------------------------------------------------------- a claim its hunter appeals (E7, node P18)
    stage('appeal: check, commit, reveal, INVALID');
    const appealDir = claimFolder(workDir, 'appeal');
    const appealCheck = await tool('check', appealDir, '--listing', String(listingId));
    one('appeal.check.forecast', appealCheck.code === 1 && appealCheck.json?.forecast?.verdict === 'fail' && appealCheck.json.forecast.settlesAs?.outcome === 'INVALID', `${appealCheck.json?.forecast?.verdict}, settles as ${appealCheck.json?.forecast?.settlesAs?.outcome}`);
    const appealCommit = await tool('commit', appealDir, '--listing', String(listingId), '--yes');
    toolDone('commit', appealCommit);
    const appealId = BigInt(appealCommit.json.claimId);
    await makerRelease(appealId);
    const appealReveal = await tool('reveal', appealDir);
    toolDone('reveal', appealReveal);
    const appealClaimRound = await roundOf(appealId);
    expect(servedRoundChecks('appeal', appealClaimRound, { vector: INVALID_VECTOR }));
    await stateIs(appealId, 'Judged');
    const appealJudged = (await eventOf('Judged', appealId))[0];
    const appealClaim = await sa.getClaim(appealId);

    stage('appeal: the waiver, the cost, the appeal through the tool');
    // the hunter's own settle inside the window waives the appeal: the tool says so and sends nothing without the flag
    const waiverRun = await tool('claim', appealDir);
    one('appeal.waiver.warned', waiverRun.code === 0 && /waives the appeal/.test(waiverRun.stderr) && /--waive-appeal/.test(waiverRun.stderr) && (waiverRun.json?.sent ?? []).every((x) => x.action !== 'settle') && (await claimStateOf(appealId)) === 'Judged', `exit ${waiverRun.code}, sent ${JSON.stringify(waiverRun.json?.sent)}: ${waiverRun.stderr.slice(0, 300)}`);
    const liveFee = await sa.disputeFee(listingId);
    const noYes = await tool('appeal', appealDir);
    one('appeal.tool.needsYes', noYes.code === 3 && noYes.stderr.includes(`${formatEther(liveFee)} ETH`) && /--yes/.test(noYes.stderr) && (await eventOf('Appealed', appealId)).length === 0, `exit ${noYes.code}: ${noYes.stderr.slice(0, 300)}`);
    const appealRun = await tool('appeal', appealDir, '--yes');
    toolDone('appeal', appealRun);
    one('appeal.tool.appealed', appealRun.json?.action === 'appeal' && appealRun.json?.disputeKind === 'Appeal', JSON.stringify(appealRun.json));
    const appealTx = await provider.getTransaction(appealRun.json.tx);
    const appealed = (await eventOf('Appealed', appealId))[0];
    one('appeal.tool.paidTheLiveFee', appealTx.value === liveFee && appealTx.from === hunter.address && appealed?.args.prepayWei === liveFee, `sent ${appealTx.value} from ${appealTx.from}, the live dispute fee ${liveFee}`);
    const hunterAfterAppeal = await balanceAfterTx(hunter, appealRun.json.tx);
    const makerBeforeAppeal = await balanceAfterTx(maker, appealRun.json.tx);

    stage('appeal: the dispute panel holds it, and it settles by that result');
    const appealRound = await bridge.quiet(appealed.args.requestId);
    one('appeal.request.disputeArchive', appealRound.cids[0] === view.list.disputeCid && appealRound.cids[1] === appealClaim.bcid && JSON.stringify(parsedLine(appealRound.addendum)) === JSON.stringify(parsedLine(appealClaimRound.addendum)), `${JSON.stringify(appealRound.cids)}, the E1 line alone`);
    await stateIs(appealId, 'Settled');
    const appealPanel = (await eventOf('DisputeJudged', appealId))[0];
    one('appeal.panel.held', DISPUTE_RESULTS[Number(appealPanel?.args.result)] === 'Held' && OUTCOMES[Number(appealPanel?.args.outcome)] === 'INVALID', `${DISPUTE_RESULTS[Number(appealPanel?.args.result)]}: ${OUTCOMES[Number(appealPanel?.args.outcome)]}`);
    one('appeal.keeper.finalized', (await senderOf(appealPanel)) === chain.accounts.keeper.address, `the second finalize from ${await senderOf(appealPanel)}`);
    const appealSettled = (await eventOf('Settled', appealId))[0];
    one('appeal.keeper.settledByThePanel', (await senderOf(appealSettled)) === chain.accounts.keeper.address && appealSettled.blockNumber >= appealPanel.blockNumber, `settle from ${await senderOf(appealSettled)} at block ${appealSettled.blockNumber}, the panel's verdict at ${appealPanel.blockNumber}`);
    const appealSeconds = (await provider.getBlock(appealSettled.blockNumber)).timestamp - (await provider.getBlock(appealJudged.blockNumber)).timestamp;
    one('appeal.settled.insideTheWindow', appealSeconds < WINDOWS.dispute, `${appealSeconds} s after the claim round's verdict: the panel's verdict settled it, not the end of the ${WINDOWS.dispute} s window`);
    expect(moneyChecks('appeal', [
      { name: 'bondToMaker', before: makerBeforeAppeal, after: await balance(maker), expected: BOND_WEI },
      // the hunter bears the round's spent prepay: only its unspent part came back, at finalize
      { name: 'hunterBearsThePrepay', before: hunterAfterAppeal, after: await balance(hunter), expected: appealRound.required - appealRound.spent },
    ]));
    const appealStatus = await tool('status', appealDir);
    one('appeal.status.kind', appealStatus.json?.disputeKind === 'Appeal' && appealStatus.json?.dispute === 'Held' && appealStatus.json?.bond === 'forfeited' && appealStatus.json?.state === 'Settled', `${appealStatus.json?.disputeKind}, ${appealStatus.json?.dispute}, bond ${appealStatus.json?.bond}`);
    const recordAfterAppeal = await settleOutcome(async () => {
      const r = await recordView();
      // appeals counts at appeal(), its result at finalize, the outcome at settle: wait for the last
      return r.record?.history?.appealsHeld === '1' && r.record?.history?.outcomes?.[0] === '2' ? r : null;
    }, 'waiting for the record to count the appeal and its settlement');
    const appealHistory = recordAfterAppeal.record.history;
    one('appeal.record.appeals', appealHistory.appeals === '1' && appealHistory.appealsHeld === '1' && appealHistory.appealsOverturned === '0' && appealHistory.outcomes[0] === '2' && appealHistory.disputes === '0', `appeals ${appealHistory.appeals}, held ${appealHistory.appealsHeld}; INVALID ${appealHistory.outcomes[0]}; maker's disputes ${appealHistory.disputes}`);

    // ---------------------------------------------------------------- a narrow INVALID (E8, node P18)
    stage('narrow: commit, reveal, the jury short of valid');
    const narrowDir = claimFolder(workDir, 'narrow');
    const narrowCommit = await tool('commit', narrowDir, '--listing', String(listingId), '--yes');
    toolDone('commit', narrowCommit);
    const narrowId = BigInt(narrowCommit.json.claimId);
    await makerRelease(narrowId);
    const narrowReveal = await tool('reveal', narrowDir);
    toolDone('reveal', narrowReveal);
    const narrowRound = await roundOf(narrowId);
    expect(servedRoundChecks('narrow', narrowRound, { vector: NARROW_AVERAGE }));
    await stateIs(narrowId, 'Judged');
    const narrowJudged = (await eventOf('Judged', narrowId))[0];
    one('narrow.judged.outcome', OUTCOMES[Number(narrowJudged.args.outcome)] === 'INVALID', OUTCOMES[Number(narrowJudged.args.outcome)]);
    const narrowVector = [...(await sa.getClaim(narrowId)).vector].map(BigInt);
    const judgement = await sa.judgeVector(listingId, narrowVector);
    const listingNow2 = await sa.getListing(listingId);
    one('narrow.judged.narrow', judgement.wellFormed && Number(judgement.outcome) === 0 && judgement.narrow === true, `the lens's judgeVector: ${OUTCOMES[Number(judgement.outcome)]}, narrow ${judgement.narrow}, valid mass ${narrowVector.slice(2).reduce((a, b) => a + b, 0n)} at the listing's floor ${listingNow2.narrowInvalidFloor}`);
    const narrowStatus = await tool('status', narrowDir);
    one('narrow.status.narrow', narrowStatus.json?.narrow === true && /bond comes back/.test(narrowStatus.json?.next ?? '') && BigInt(narrowStatus.json?.times?.appealDeadline ?? 0) > 0n, `narrow ${narrowStatus.json?.narrow}: ${narrowStatus.json?.next}`);

    stage('narrow: the appeal window, then the bond back');
    const narrowRunsBefore = (await server.get('/api/status')).json.keeper?.lastRun?.at ?? 0;
    await settleOutcome(async () => ((await server.get('/api/status')).json.keeper?.lastRun?.at ?? 0) > narrowRunsBefore + 1000, 'waiting for keeper cycles');
    one('narrow.settle.waitsAppealWindow', (await claimStateOf(narrowId)) === 'Judged', 'the keeper leaves a claim round\'s INVALID alone inside its appeal window');
    const hunterBeforeNarrow = await balance(hunter);
    const makerBeforeNarrow = await balance(maker);
    await chain.advance(WINDOWS.dispute + 1);
    await stateIs(narrowId, 'Settled');
    const narrowEvent = (await eventOf('NarrowInvalid', narrowId))[0];
    one('narrow.event', Boolean(narrowEvent) && narrowEvent.args.validMass === narrowVector.slice(2).reduce((a, b) => a + b, 0n) && (await senderOf(narrowEvent)) === chain.accounts.keeper.address, `NarrowInvalid, valid mass ${narrowEvent?.args.validMass}, settled by ${await senderOf(narrowEvent)}`);
    expect(moneyChecks('narrow', [
      { name: 'bondBack', before: hunterBeforeNarrow, after: await balance(hunter), expected: BOND_WEI },
      { name: 'makerUntouched', before: makerBeforeNarrow, after: await balance(maker), expected: 0n },
    ]));
    const recordAfterNarrow = await settleOutcome(async () => {
      const r = await recordView();
      return r.record?.history?.narrowInvalid === '1' ? r : null;
    }, 'waiting for the record to count the narrow INVALID');
    const narrowHistory = recordAfterNarrow.record.history;
    one('narrow.record.narrowInvalid', narrowHistory.narrowInvalid === '1' && narrowHistory.outcomes[0] === '3' && recordAfterNarrow.record.listings[0]?.narrowInvalidFloor === listingNow2.narrowInvalidFloor.toString() && !recordAfterNarrow.record.findings.some((f) => f.claimId === String(narrowId)), `narrow ${narrowHistory.narrowInvalid} within INVALID ${narrowHistory.outcomes[0]}, floor ${recordAfterNarrow.record.listings[0]?.narrowInvalidFloor}, not published`);

    // ---------------------------------------------------------------- nothing live
    stage('nothing live');
    one('live.noHostApi', new URL(repository.url).host === GIT_HOST && finalView.fork?.status === 'unknown' && finalView.fork?.host === null, `the fork label: status ${finalView.fork?.status}, host ${finalView.fork?.host}: a host with no API (null is the checker's answer before any request), so it asked nobody`);
    one('live.ipfsNoMisses', ipfs.misses.length === 0, ipfs.misses.join(', ') || `${ipfs.fetches.length} fetches, ${ipfs.pins.length} pins, all here`);
    const everyProviderCall = providerCalls();
    one('live.providerIsTheMock', everyProviderCall.length > 0 && everyProviderCall.every((c) => [...panel.map((p) => p.model), ...disputePanel.map((p) => p.model), JUSTIFIER.model].includes(c.model) && c.outcome === 'answered'), `${everyProviderCall.length} calls, every one logged by the mock provider`);
    const firstCheck = hunterRunner.post('/v1/runs')[0]?.response;
    for (const c of h.pullChecks(firstCheck, await registry.manifestRequests(), validation.image.ref)) one(`live.${c.name}`, c.ok, c.detail);
  };

  // The main flow never rejects: a stop waits on it, and what ends it is the report's.
  mainFlow = run().then(
    () => {
      if (!stopReason) report.ok = true;
    },
    (err) => {
      if (stopReason) return; // what failed is what the stop stopped
      report.failure = err instanceof CheckFailed ? err.message : `${err.name}: ${err.message}`;
      log(`[round] FAILED: ${report.failure}`);
      if (!(err instanceof CheckFailed) && !(err instanceof RoundStopped)) log(err.stack ?? '');
      for (const svc of report.pids) {
        const file = path.join(logDir, `${svc.name}.log`);
        if (fs.existsSync(file)) log(`--- ${svc.name} (last lines)\n${fs.readFileSync(file, 'utf8').slice(-2500)}`);
      }
    },
  ).catch(noteCleanupFailure);
  await mainFlow;
  // A stop that came at any point owns the ending: it reports and exits with its own code.
  if (stopReason) await new Promise(() => {});
  await closeDown();
  if (stopReason) await new Promise(() => {});
  for (const signal of Object.keys(SIGNALS)) process.removeListener(signal, onSignal);
  process.removeListener('uncaughtException', onCrash);
  process.removeListener('unhandledRejection', onCrash);
  finish();
  return report;
}
