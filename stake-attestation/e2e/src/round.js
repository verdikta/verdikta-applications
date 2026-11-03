// The round itself: every piece running together, on this machine, against a local chain, a local
// registry and a local IPFS, with no key that means anything. list -> fund -> commit -> release ->
// reveal -> judge (finalize) -> settle -> record, for a claim the jury decides, one the gates settle
// and one every arbiter abstains on. The first failed check, a service that will not start, or any
// error ends the round: exit 1, with everything it started stopped and removed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeReview } from './common.js';
import { REAL_CONFIG } from './aggregatorRound.js';
import { createBridge, evaluateOver } from './bridge.js';
import { readPages } from './browser.js';
import { startChain } from './chain.js';
import {
  abstainEndChecks, abstainRunChecks, abstainedRoundChecks, evidenceChecks, gateSettledChecks, juryPathChecks, moneyChecks, pageChecks,
  recordChecks, requestChecks, servedRoundChecks, settlementChecks,
} from './checks.js';
import {
  AWARDS_WEI, BOND_WEI, ESCROW_WEI, GIT_HOST, JURY_AVERAGE, JUROR_SCORES, JUSTIFIER, POC_MARKER, REPORT_MARKER, WINDOWS, claimFolder, draftSpec, makeRepository,
} from './fixtures.js';
import { stopProcessesNaming, waitUntil } from './proc.js';
import {
  arbiterHarness, cleanDockerConfig, leftovers, newRunnerToken, removeRunContainers, removeRunImages, startClient, startIpfs, startRegistryPair, startServer,
} from './services.js';
import { APP_DIR, arbiterCheckout, browserReady, compileContracts, E2E_DIR, installSiblings } from './setup.js';
import { createTool } from './tool.js';

const CLASS_PLATFORM = codeReview.CLASS_HARD_LIMITS.platform;
const OPERATOR = '0x0000000000000000000000000000000000000001';
/** What G2 sets on the real aggregators (design §7.2: setResponseTimeout(900)). */
const RESPONSE_TIMEOUT_SECONDS = 900;
/** Stands in for the keeper's selection and K dispatches inside the request: L4 ran out at 3M with 30 identities. */
const REQUEST_GAS_STAND_IN = 3_000_000;
const OUTCOMES = ['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const CLAIM_STATES = ['Committed', 'Revealable', 'Revealed', 'Judged', 'Disputed', 'Settled', 'Expired', 'RoundFailed'];
const EXPIRIES = ['None', 'Undisclosed', 'Unrevealed', 'RoundsFailed', 'SubmissionsRefused'];
const DEFAULT_LOG_ROOT = path.join(E2E_DIR, '.round', 'logs');
const LISTING_TIMEOUT_MS = 900_000;
const CHAIN_WAIT_MS = 120_000;

class CheckFailed extends Error {}

/**
 * @param {object} [o]
 * @param {(line: string) => void} [o.log]
 * @param {string|null} [o.breakName] - SA_E2E_BREAK: break the round on purpose (runner-start, valid-claim-abstains, signal-in-scan)
 * @param {boolean} [o.requireClassPlatform] - SA_E2E_REQUIRE_CLASS_PLATFORM=1: anything but linux/amd64 is a failure
 * @param {string} [o.logDir] - SA_E2E_LOG_DIR: the run's logs go in a new folder inside it, and nothing there is removed
 * @param {(report: object) => void} [o.onFinished] - called with the report, on a signal too: a signal ends the process here
 * @returns {Promise<object>} the report
 */
export async function runRound({ log = (s) => process.stderr.write(`${s}\n`), breakName = process.env.SA_E2E_BREAK || null, requireClassPlatform = process.env.SA_E2E_REQUIRE_CLASS_PLATFORM === '1', logDir: logRoot = process.env.SA_E2E_LOG_DIR || null, onFinished = () => {} } = {}) {
  const started = Date.now();
  const instance = `sae2e${crypto.randomBytes(4).toString('hex')}`;
  const workDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sa-e2e-'));
  const report = { ok: false, instance, workDir, breakName, stages: [], checks: [], pids: [], platform: null, classPlatform: null, arbiter: null, failure: null, signal: null, leftovers: null, stopped: null, cancelledJobs: null, cleanupFailures: [], seconds: null };
  // Its own folder under a directory someone named, which may hold anything: only the default, ours, is emptied.
  if (!logRoot) fs.rmSync(DEFAULT_LOG_ROOT, { recursive: true, force: true });
  const logDir = path.join(logRoot ?? DEFAULT_LOG_ROOT, instance);
  fs.mkdirSync(logDir, { recursive: true });
  report.logDir = logDir;

  const closers = [];
  let inventoryDue = false;
  let closing = null;
  const close = () => {
    closing ??= (async () => {
      for (const c of closers.reverse()) {
        try {
          await c();
        } catch (err) {
          report.cleanupFailures.push(err.message);
          log(`[round] cleanup: ${err.message}`);
        }
      }
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (err) {
        report.cleanupFailures.push(err.message);
      }
    })();
    return closing;
  };
  const finish = () => {
    report.seconds = Math.round((Date.now() - started) / 1000);
    // Whatever the checks said, a run that left something behind, or cannot say that it did not, did not pass.
    const notClean = report.cleanupFailures.length ? `the cleanup failed: ${report.cleanupFailures.join('; ')}`
      : inventoryDue && !report.leftovers ? 'no inventory of what the run left'
        : report.leftovers && (report.leftovers.containers.length || report.leftovers.images.length) ? `left behind: ${JSON.stringify(report.leftovers)}`
          : null;
    if (notClean) {
      report.ok = false;
      report.failure = report.failure ?? notClean;
    }
    onFinished(report);
  };
  // A signal is a failure too: everything stops, the report says so, and the exit code does.
  const onSignal = (signal) => {
    report.ok = false;
    report.signal = signal;
    report.failure = `stopped by ${signal}`;
    log(`[round] ${report.failure}: stopping everything`);
    close().finally(() => {
      finish();
      process.stderr.write('', () => process.exit(signal === 'SIGINT' ? 130 : 143));
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let stageChecks = 0;
  const stage = (name) => {
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

  let h;
  let docker;
  let chain;
  let bridge;
  let server;
  let aiNode;
  try {
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
    closers.push(() => fs.rmSync(dockerSettings.dockerConfigDir, { recursive: true, force: true }));
    docker = h.dockerHelpers.dockerFor(dockerSettings);
    const dockerInfo = await h.runText(docker, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30000 });
    one('docker.reachable', dockerInfo.exitCode === 0, dockerInfo.exitCode === 0 ? dockerInfo.stdout.trim() : dockerInfo.stderr);
    inventoryDue = true;
    closers.push(async () => {
      // Last, with every service stopped: what they could not stop for themselves.
      report.stopped = await stopProcessesNaming([workDir, instance]);
      await removeRunContainers(h, docker, instance, report.stopped.containers);
      await removeRunImages(h, docker, instance);
      report.leftovers = await leftovers(h, docker, instance, report.stopped.containers);
    });
    log(`[round] instance ${instance}, platform ${h.platform}, ${report.classPlatform ? 'the runner\'s real entry point' : 'the A6a launcher in front of the runner (report built with the class platform named)'}`);

    stage('start');
    chain = await startChain({ logDir });
    closers.push(() => chain.close());
    track(chain.node);
    await (await chain.aggregator.setResponseTimeout(RESPONSE_TIMEOUT_SECONDS)).wait();
    await (await chain.aggregator.setRequestGasCost(REQUEST_GAS_STAND_IN)).wait();
    const ipfs = await startIpfs(h);
    closers.push(() => ipfs.close());
    const registry = await startRegistryPair(h, docker, instance);
    closers.push(() => registry.remove());
    one('registry.up', Boolean(registry.host && registry.apiUrl), `${registry.host}, read at ${registry.apiUrl}`);

    const runnerToken = newRunnerToken();
    const stateDir = fs.mkdtempSync(path.join(workDir, 'runner-state-'));
    const runner = track(await h.startCodeRunner({
      logDir,
      stateDir,
      token: runnerToken,
      platform: breakName === 'runner-start' ? 'linux/not-a-platform' : h.platform,
      allowlist: registry.host,
      classPlatform: report.classPlatform,
      instance,
    }));
    closers.push(() => runner.close());
    // Two proxies, so what the EA sent and what the hunter's check sent are told apart.
    const runnerProxy = await h.startRecordingProxy(runner.url);
    closers.push(() => runnerProxy.close());
    const hunterRunner = await h.startRecordingProxy(runner.url);
    closers.push(() => hunterRunner.close());

    const panel = codeReview.CODE_STANDARD_PANEL.AI_NODES.map((n) => ({ provider: n.AI_PROVIDER, model: n.AI_MODEL, weight: n.WEIGHT }));
    const script = {
      [panel[0].model]: { scores: [...JUROR_SCORES[0]], justification: `Mock juror ${panel[0].model}: the deposit over-credits.` },
      [panel[1].model]: { scores: [...JUROR_SCORES[1]], justification: `Mock juror ${panel[1].model}: the deposit over-credits.` },
      [JUSTIFIER.model]: { reply: 'Mock justification: the panel finds the over-credit a HIGH.' },
    };
    const callLog = path.join(logDir, 'provider-calls.jsonl');
    aiNode = track(await h.startAiNode({ logDir, callLog, script, justifierModel: `${JUSTIFIER.provider}:${JUSTIFIER.model}` }));
    closers.push(() => aiNode.close());
    const aiProxy = await h.startRecordingProxy(aiNode.url);
    closers.push(() => aiProxy.close());
    const providerCalls = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

    const maker = chain.accounts.maker;
    const repository = makeRepository({ workDir, maker: maker.address });
    const dockerConfig = cleanDockerConfig(workDir);
    server = track(await startServer({ workDir, logDir, chain, ipfs, registry, runnerProxyUrl: runnerProxy.url, runnerToken, platform: h.platform, repository, dockerConfig, instance }));
    closers.push(() => server.close());
    const client = track(await startClient({ workDir, logDir, chain, ipfs, serverUrl: server.url }));
    closers.push(() => client.close());
    one('client.up', (await fetch(`${client.url}/`)).ok, client.url);
    one('client.apiProxied', (await fetch(`${client.url}/api/status`)).ok, 'the client reaches the server under /api');
    log('[round] services up');

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

    const accepted = await submit(maker, { spec: draft, allowlist: [], maker: maker.address });
    one('listing.accepted', accepted.status === 202, `HTTP ${accepted.status}`);
    const view = await follow((await accepted.json()).id);
    one('listing.ready', view.status === 'ready', JSON.stringify({ status: view.status, error: view.error, refusal: view.refusal, refusals: view.validationReport?.refusals }));
    const validation = view.validationReport;
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
    const listReceipt = await (await makerSa.list(view.list.params, view.list.listingCid, view.list.disputeCid, view.list.knownIssueIds)).wait();
    const parsedLogs = (receipt) => receipt.logs.map((l) => { try { return sa.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const listed = parsedLogs(listReceipt).find((e) => e.name === 'Listed');
    const listingId = listed.args.listingId;
    const artifactHash = listed.args.artifactHash;
    one('list.artifactHash', artifactHash === view.artifactHash, artifactHash);

    stage('fund');
    const feeDue = await sa.feeDue(listingId);
    await (await makerSa.fund(listingId, feeDue, { value: feeDue + ESCROW_WEI })).wait();
    const listingNow = await sa.getListing(listingId);
    one('fund.opened', Number(listingNow.state) === 1 && listingNow.escrowWei === ESCROW_WEI, `state ${listingNow.state}, escrow ${listingNow.escrowWei}`);
    const inFeed = await settleOutcome(async () => {
      const { json } = await server.get('/api/feed');
      return json.listings?.find((l) => l.listingId === String(listingId)) ? json : null;
    }, 'waiting for the feed to count the listing');
    one('feed.counted', inFeed.notCounted.length === 0, `${inFeed.listings.length} counted, ${inFeed.notCounted.length} not`);

    // The EA starts now, with the key the listing was signed by: dev trust is one explicit key.
    const adapter = track(await h.startAdapter({ logDir, aiNodeUrl: aiProxy.url, runnerUrl: runnerProxy.url, runnerToken, ipfsUrl: ipfs.url, pinKey: ipfs.pinKey, devKey, operator: OPERATOR }));
    closers.push(() => adapter.close());
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
    const makerRelease = async (id) => (await makerSa.release(id)).wait();
    const counts = () => ({ runner: runnerProxy.post('/v1/runs').length, ai: aiProxy.post('/api/rank-and-justify').length, provider: providerCalls().length });
    const since = (before) => ({
      runnerCalls: runnerProxy.post('/v1/runs').slice(before.runner),
      aiCalls: aiProxy.post('/api/rank-and-justify').slice(before.ai),
      providerCalls: providerCalls().slice(before.provider),
    });
    const parsedLine = (addendum) => codeReview.parseDisclosureLine(String(addendum).split('\n')[0]).fields;
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
    const hunterAfterReveal = await balance(hunter);
    const makerBeforeJudge = await balance(maker);
    const before1 = { runner: runsBeforeCommit, ai: 0, provider: 0 };
    const validRound = await roundOf(validId);
    const validClaim = await sa.getClaim(validId);
    one('valid.plaintext.pinnedOnlyAtReveal', !pinnedBeforeReveal.includes(validClaim.bcid) && ipfs.pins.includes(validClaim.bcid) && pinnedBeforeReveal.includes(validClaim.ciphertextCid), `${pinnedBeforeReveal.length} pins before the reveal: the ciphertext among them, the archive not`);
    expect(requestChecks('valid', validRound, {
      listingCid: view.list.listingCid,
      bcid: validClaim.bcid,
      requestedClass: codeReview.CODE_CLASSES['code-standard'].classId,
      disclosure: { parsed: parsedLine(validRound.addendum), archiveSha256: validClaim.archiveHash, ciphertextSha256: validClaim.ciphertextSha256, ciphertextCid: validClaim.ciphertextCid },
    }));
    expect(servedRoundChecks('valid', validRound));

    stage('valid: judge');
    expect(juryPathChecks('valid', {
      ...since(before1),
      panel,
      justifier: JUSTIFIER,
      disclosureKeys: [parsedLine(validRound.addendum)?.contentKey, parsedLine(validRound.addendum)?.ephemeralKey].filter(Boolean),
      report: { classPlatform: report.classPlatform, classPlatformName: CLASS_PLATFORM },
    }));
    one('valid.round.jurorAverage', JSON.stringify(validRound.likelihoods.map(String)) === JSON.stringify(JURY_AVERAGE.map(String)), JSON.stringify(validRound.likelihoods.map(String)));
    const validWatch = await tool('status', validDir, '--wait', '--max-wait-ms', String(CHAIN_WAIT_MS));
    one('tool.statusWait', validWatch.code === 0 && ['Judged', 'Revealed'].includes(validWatch.json?.state), `exit ${validWatch.code}, ${validWatch.json?.state}`);
    await stateIs(validId, 'Judged');
    const judgedEvent = (await eventOf('Judged', validId))[0];
    one('valid.judged.outcome', OUTCOMES[Number(judgedEvent.args.outcome)] === 'HIGH', OUTCOMES[Number(judgedEvent.args.outcome)]);
    const uploaded = uploadsOf(judgedEvent.args.justificationCid);
    const judgedStatus = await tool('status', validDir);
    expect(evidenceChecks('valid', {
      uploads: uploaded,
      evidence: readExecutionEvidence(uploaded[0]?.justification),
      settlement: 'jury',
      reportSha256: since(before1).runnerCalls[0].response.reportSha256,
    }));
    one('valid.status.evidence', judgedStatus.json?.evidence?.settlement === 'jury', JSON.stringify(judgedStatus.json?.evidence));
    one('valid.refund.atFinalize', (await eventOf('LeftoverRefunded', validId))[0]?.args.amountWei === validRound.required - validRound.spent, `${(await eventOf('LeftoverRefunded', validId))[0]?.args.amountWei}`);

    stage('valid: dispute window, then settle');
    const keeperRunsBefore = (await server.get('/api/status')).json.keeper?.lastRun?.at ?? 0;
    await settleOutcome(async () => ((await server.get('/api/status')).json.keeper?.lastRun?.at ?? 0) > keeperRunsBefore + 1000, 'waiting for keeper cycles');
    one('valid.settle.waitsDisputeWindow', (await claimStateOf(validId)) === 'Judged', 'the keeper leaves a valid verdict alone inside the dispute window');
    await chain.advance(WINDOWS.dispute + 1);
    await stateIs(validId, 'Settled');
    const settledValid = (await eventOf('Settled', validId))[0];
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
      escrowWei: ESCROW_WEI - AWARDS_WEI.HIGH,
    }).filter((c) => !c.name.endsWith('.record.claims')));
    one('valid.record.pendingIsTheNextClaim', recordAfterValid.record.history.claims === '2' && recordAfterValid.record.history.pending === '1', `claims ${recordAfterValid.record.history.claims}, pending ${recordAfterValid.record.history.pending}`);
    const badge = await fetch(`${server.url}/api/records/${artifactHash}/badge.svg`);
    one('valid.badge', badge.ok && recordAfterValid.badge?.state === 'finding', recordAfterValid.badge?.message);

    // ---------------------------------------------------------------- a claim the gates settle
    stage('gate: reveal, INVALID, the bond to the maker');
    const before2 = counts();
    const gateReveal = await tool('reveal', gateDir);
    toolDone('reveal', gateReveal);
    const hunterAfterGateReveal = await balance(hunter);
    const makerBeforeGate = await balance(maker);
    const gateRound = await roundOf(gateId);
    const gateClaim = await sa.getClaim(gateId);
    expect(requestChecks('gate', gateRound, {
      listingCid: view.list.listingCid,
      bcid: gateClaim.bcid,
      priorBcids: [validFinal.bcid],
      requestedClass: codeReview.CODE_CLASSES['code-standard'].classId,
      disclosure: { parsed: parsedLine(gateRound.addendum), archiveSha256: gateClaim.archiveHash, ciphertextSha256: gateClaim.ciphertextSha256, ciphertextCid: gateClaim.ciphertextCid },
    }));
    expect(servedRoundChecks('gate', gateRound));
    expect(gateSettledChecks('gate', { ...since(before2), gate: 'testPathsOnly' }));
    await stateIs(gateId, 'Settled');
    const gateJudged = (await eventOf('Judged', gateId))[0];
    const gateSettled = (await eventOf('Settled', gateId))[0];
    const gateFinal = await sa.getClaim(gateId);
    const gateUploads = uploadsOf(gateJudged.args.justificationCid);
    expect(evidenceChecks('gate', { uploads: gateUploads, evidence: readExecutionEvidence(gateUploads[0]?.justification), settlement: 'INVALID (testPathsOnly)' }));
    expect(settlementChecks('gate', {
      state: await claimStateOf(gateId),
      outcome: OUTCOMES[Number(gateFinal.outcome)],
      expectedOutcome: 'INVALID',
      finalizeFrom: await senderOf(gateJudged),
      settleFrom: await senderOf(gateSettled),
      keeper: chain.accounts.keeper.address,
      vector: gateFinal.vector.map((v) => BigInt(v)),
      expectedVector: [1000000n, 0n, 0n, 0n, 0n, 0n],
    }));
    one('gate.settled.noDisputeWindow', gateSettled.blockNumber - gateJudged.blockNumber < 60, `${gateSettled.blockNumber - gateJudged.blockNumber} blocks after the verdict: an INVALID does not wait out the window`);
    expect(moneyChecks('gate', [
      { name: 'bondToMaker', before: makerBeforeGate, after: await balance(maker), expected: BOND_WEI },
      { name: 'hunter', before: hunterAfterGateReveal, after: await balance(hunter), expected: gateRound.required - gateRound.spent },
    ]));

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
    const abstainReveal = await tool('reveal', abstainDir);
    toolDone('reveal', abstainReveal);
    const hunterAfterAbstainReveal = await balance(hunter);
    const pinsBeforeAbstain = ipfs.pins.length; // the reveal pinned the claim itself; the arbiters pin nothing
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
    const retrigger = await tool('reveal', abstainDir, '--retrigger');
    toolDone('retrigger', retrigger);
    const afterRetrigger = await balance(hunter);
    const retriggerTx = await provider.getTransaction(retrigger.json.tx);
    const prepaid = (await sa.queryFilter(sa.filters.EvaluationRequested(abstainId), chain.fromBlock)).pop().args;
    one('abstain.retrigger.freshPrepay', retriggerTx.value === firstRound.required && prepaid.prepayWei === firstRound.required && (await chain.aggregator.ethReceived(prepaid.requestId)) === firstRound.required, `sent ${retriggerTx.value}, the aggregator received ${await chain.aggregator.ethReceived(prepaid.requestId)}, the live fee is ${firstRound.required}`);
    one('abstain.retrigger.isTheHuntersTx', retriggerTx.from === hunter.address, retriggerTx.from);
    await stateIs(abstainId, 'Revealed');
    const before4 = counts();
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
    }, 'waiting for the record to show all three claims');
    expect(abstainEndChecks('abstain', {
      state: await claimStateOf(abstainId),
      expiry: EXPIRIES[Number(abstainFinal.expiry)],
      judgedEvents: (await eventOf('Judged', abstainId)).length,
      settledEvents: (await eventOf('Settled', abstainId)).length,
      record: finalView.record,
      pinsBefore: pinsBeforeAbstain,
      pinsAfter: ipfs.pins.length,
    }));
    expect(recordChecks('final', finalView, {
      artifactHash,
      listingId,
      outcomes: [1, 0, 0, 0, 1, 0],
      claims: 3,
      released: 3,
      noVerdict: 1,
      findings: [{ claimId: String(validId), outcome: 'HIGH', paidWei: AWARDS_WEI.HIGH.toString(), owedWei: '0', bcid: validFinal.bcid }],
      escrowWei: ESCROW_WEI - AWARDS_WEI.HIGH,
    }));
    const lensRecord = await sa.recordByHash(artifactHash, { blockTag: finalView.block.number });
    one('final.record.isTheChains', lensRecord.history.claims === 3n && lensRecord.history.noVerdict === 1n && lensRecord.findings.length === 1, `at block ${finalView.block.number}: claims ${lensRecord.history.claims}, findings ${lensRecord.findings.length}`);

    const events = (await server.get('/api/feed/events?limit=500')).json.events;
    const fullOf = (claimId) => events.filter((e) => e.claimId === String(claimId) && e.name === 'Judged');
    one('final.events.validPublished', fullOf(validId)[0]?.args?.justificationCid === judgedEvent.args.justificationCid, 'a valid finding\'s events are in full');
    one('final.events.invalidHidden', !JSON.stringify(events.filter((e) => e.claimId === String(gateId))).includes(gateFinal.bcid), 'an INVALID claim\'s events keep only their ids');
    const status = (await server.get('/api/status')).json;
    one('final.keeper.noError', status.keeper?.enabled === true && status.keeper?.error === null && status.keeper?.address === chain.accounts.keeper.address, JSON.stringify(status.keeper?.error));
    one('final.indexer.confirms', status.indexer?.confirmations === 2 && status.indexer?.fresh === true, `confirmations ${status.indexer?.confirmations}, fresh ${status.indexer?.fresh}`);

    const pages = await readPages(chromium, client.url, { artifactHash, listingId });
    expect(pageChecks('final', pages, {
      artifactHash,
      claims: 3,
      verdicts: ['INVALID: 1', 'HIGH: 1'],
      noVerdict: 1,
      findingBcid: validFinal.bcid,
      invalidBcid: gateFinal.bcid,
    }));

    // ---------------------------------------------------------------- nothing live
    stage('nothing live');
    one('live.noHostApi', new URL(repository.url).host === GIT_HOST && finalView.fork?.status === 'unknown' && finalView.fork?.host === null, `the fork label: status ${finalView.fork?.status}, host ${finalView.fork?.host}: a host with no API (null is the checker's answer before any request), so it asked nobody`);
    one('live.ipfsNoMisses', ipfs.misses.length === 0, ipfs.misses.join(', ') || `${ipfs.fetches.length} fetches, ${ipfs.pins.length} pins, all here`);
    const everyProviderCall = providerCalls();
    one('live.providerIsTheMock', everyProviderCall.length > 0 && everyProviderCall.every((c) => [...panel.map((p) => p.model), JUSTIFIER.model].includes(c.model) && c.outcome === 'answered'), `${everyProviderCall.length} calls, every one logged by the mock provider`);
    const firstCheck = hunterRunner.post('/v1/runs')[0]?.response;
    for (const c of h.pullChecks(firstCheck, await registry.manifestRequests(), validation.image.ref)) one(`live.${c.name}`, c.ok, c.detail);
    report.ok = true;
    return report;
  } catch (err) {
    if (report.signal) return report; // what failed is what the signal stopped: the finally below waits for onSignal
    report.failure = err instanceof CheckFailed ? err.message : `${err.name}: ${err.message}`;
    log(`[round] FAILED: ${report.failure}`);
    if (!(err instanceof CheckFailed)) log(err.stack ?? '');
    for (const svc of report.pids) {
      const file = path.join(logDir, `${svc.name}.log`);
      if (fs.existsSync(file)) log(`--- ${svc.name} (last lines)\n${fs.readFileSync(file, 'utf8').slice(-2500)}`);
    }
    return report;
  } finally {
    // A signal that came at any point owns the ending: it reports and exits with its own code.
    if (report.signal) await new Promise(() => {});
    await close();
    if (report.signal) await new Promise(() => {});
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    finish();
  }
}
