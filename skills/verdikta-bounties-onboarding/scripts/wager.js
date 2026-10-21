#!/usr/bin/env node
// Mutual wagers: two directed bounties used as a bet, on a game (the website's Mutual Wager template, mutual-wager-v3)
// or on a YES/NO question (its Question Wager template, mutual-wager-v4). The same six verbs in every agent runtime;
// bodies, checks and claims are the website's shared code (_mutual-wager.cjs). The terms pick the kind.
//
//   node wager.js propose --input proposal.json                      preview the first bounty and its approval line
//   node wager.js propose --input proposal.json --approval "<line>" --yes   post it after the owner's line
//   node wager.js answer <N>                                         check bounty #N and preview the mirrored answer
//   node wager.js answer <N> --approval "<line>" --yes               post the answer after the owner's line
//   node wager.js check <N> [--against <your bounty>]                full counter check of bounty #N (read-only)
//   node wager.js status                                             your wagers and the next step for each
//   node wager.js claim <wager> --score "..." --source "Name|URL|quote" --source ...   write claim.md, print its line
//   node wager.js claim <wager> --answer YES|NO --value "..." --as-of <ISO> --source ... --source ...   (a question)
//   node wager.js claim <wager> --approval "<line>" --yes            submit that claim.md after the owner's line
//   node wager.js close <wager> [--dry-run] [--yes]                  reclaim your stake after your bounty's deadline
//
// <wager> is the terms hash prefix, the Wager ID or one of the wager's bounty numbers. The owner's lines are the only
// authorization for --yes: "Approve wager <16 hex of sha256(description)>, stake <X> ETH, vs <opponent>, settle <ISO>"
// for a propose or answer, "Approve claim <16 hex of sha256(claim.md)>, bounty #<N>" for a claim. One wager per terms
// hash and per Wager ID. The native verdikta-agents runtime uses the same definitions.
//
// A post that stopped after the approval is finished by the same propose/answer command with the same line, never by
// create_bounty.js --resume: the start and the counter are checked again before anything is signed or rebroadcast.
// A claim whose evaluation failed can be replaced before the deadline, prepared again and approved again.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Contract, getAddress, parseEther } from 'ethers';
import { isMain } from './_cli.js';
import { defaultSecretsDir, ensureDir } from './_paths.js';
import { abi, deployments, reviewedApiOrigin } from './_transaction-guards.js';
import { runCreate } from './create_bounty.js';
import { runRecover } from './recover_funds.js';
import { runSubmit } from './submit_to_bounty.js';
import * as W from './_wager.js';

const USAGE = `Usage:
  node wager.js propose --input proposal.json [--defaults wager-defaults.json] [--approval "<owner's line>" --yes]
  node wager.js answer <N> [--approval "<owner's line>" --yes]
  node wager.js check <N> [--against <your bounty number>]
  node wager.js status
  node wager.js claim <wager> --score "<Team> <points>, <Team> <points> (Final)" --source "Name|https://...|quote" --source ... [--final-at <ISO>]
  node wager.js claim <wager> --answer YES|NO --value "<as the sources show it>" --as-of <ISO UTC> --source "Name|https://...|quote" --source ...
  node wager.js claim <wager> --approval "<owner's claim line>" --yes
  node wager.js close <wager> [--dry-run] [--yes]
<wager> is the terms hash prefix, the Wager ID or one of the wager's bounty numbers. A question proposal is
{ "kind": "question", ... } (examples/wager-question.json); a question claim takes --answer, --value and --as-of.`;

const FLAGS = new Set(['yes', 'confirm-spend', 'dry-run', 'dryRun']);
function parseArgs(argv) {
  const positional = [], values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (FLAGS.has(name)) { values[name] = [true]; continue; }
    if (i + 1 >= argv.length) throw new Error(`--${name} needs a value\n${USAGE}`);
    (values[name] ||= []).push(argv[++i]);
  }
  return { positional, opt: (n) => values[n]?.[0] ?? null, all: (n) => values[n] || [], flag: (n) => Boolean(values[n]) };
}
// A record's kind is the rubric its own terms name: 'game' (mutual-wager-v3) or 'question' (mutual-wager-v4).
const termsOf = (record) => W.shared.parseMutualWagerTerms(record.description);
const kindOfRecord = (record) => W.kindOf(termsOf(record));
const QUESTION_CLAIM_FLAGS = ['answer', 'value', 'as-of'];
const claimFlags = (kind, again = false) => (kind === 'question'
  ? (again ? '--answer ... --value ... --as-of ... --source ... --source ...' : '--answer YES|NO --value "..." --as-of <ISO> --source "Name|URL|quote" --source "..."')
  : (again ? '--score "..." --source ... --source ...' : '--score "..." --source "Name|URL|quote" --source "..."'));
const bountyNumber = (v, what = 'bounty number') => { if (!/^[0-9]+$/.test(String(v ?? ''))) throw new Error(`A ${what} is required\n${USAGE}`); return Number(v); };
const sameAddress = (a, b) => { try { return getAddress(String(a)) === getAddress(String(b)); } catch { return false; } };
const plainBounty = (b) => ({
  creator: b.creator, evaluationCid: b.evaluationCid, requestedClass: String(b.requestedClass), threshold: String(b.threshold), payoutWei: String(b.payoutWei),
  createdAt: String(b.createdAt), submissionDeadline: String(b.submissionDeadline), status: String(b.status), winner: b.winner, targetHunter: b.targetHunter,
  creatorDeterminationPayment: String(b.creatorDeterminationPayment), arbiterDeterminationPayment: String(b.arbiterDeterminationPayment),
  creatorAssessmentWindowSize: String(b.creatorAssessmentWindowSize),
  oracle: { maxOracleFee: String(b.oracle.maxOracleFee), alpha: String(b.oracle.alpha), estimatedBaseCost: String(b.oracle.estimatedBaseCost), maxFeeBasedScaling: String(b.oracle.maxFeeBasedScaling) },
});

export async function runWager(lib, {
  argv = process.argv.slice(2), fetchApi = globalThis.fetch, contract = (address, contractAbi, provider) => new Contract(address, contractAbi, provider),
  now = () => Math.floor(Date.now() / 1000), log = console.log, secretsDir = defaultSecretsDir(), create = runCreate, recover = runRecover, submit = runSubmit,
} = {}) {
  const args = parseArgs(argv);
  const verb = args.positional[0];
  if (!['propose', 'answer', 'check', 'status', 'claim', 'close'].includes(verb)) throw new Error(USAGE);
  const network = lib.getNetwork();
  const origin = reviewedApiOrigin(network, process.env.VERDIKTA_BOUNTIES_BASE_URL);
  const ctx = W.siteContext({ network, origin, deployment: deployments[network] });
  const stateDir = path.join(secretsDir, 'wagers');
  let apiKey;

  // ---- reads: the site's public records, the escrow over RPC, this wallet ----
  async function api(route, { auth = false } = {}) {
    const headers = {};
    if (auth) {
      apiKey ??= await lib.loadApiKey().catch(() => null);
      if (!apiKey) throw new Error(`${route} needs this wallet's bot API key (node bot_register.js)`);
      headers['X-Bot-API-Key'] = apiKey;
    }
    const res = await fetchApi(`${origin}/api${route}`, { headers, redirect: 'error' });
    if (!res.ok) throw new Error(`${origin}/api${route}: HTTP ${res.status}`);
    return res.json();
  }
  async function escrowRead(fn) {
    const provider = lib.providerFor(network);
    try {
      if (Number((await provider.getNetwork()).chainId) !== deployments[network].chainId) throw new Error('The RPC is on another chain');
      return await fn(contract(deployments[network].address, abi, provider));
    } finally { provider.destroy?.(); }
  }
  const rpcBounty = (n) => escrowRead(async (escrow) => { try { return plainBounty(await escrow.getBounty(n)); } catch { return null; } });
  const rpcSubmission = (n, id) => escrowRead((escrow) => escrow.getSubmission(n, id));
  const claimFailed = (c) => (c.submissionId == null ? Promise.resolve(false)
    : rpcSubmission(c.bounty, c.submissionId).then((s) => W.SUBMISSION_STATUS[Number(s.status)] === 'Failed', () => false));
  async function readBounty(n) {
    const [status, details, rpc] = await Promise.all([api(`/jobs/${n}/onchain-status`).catch(() => null), api(`/jobs/${n}?includeRubric=true`).catch(() => null), rpcBounty(n)]);
    return { status, job: details?.job || null, rpc };
  }
  async function walletAddress() {
    if (lib.walletAddress) return getAddress(await lib.walletAddress());
    const keystore = process.env.VERDIKTA_KEYSTORE_PATH;
    if (!keystore) throw new Error('Set VERDIKTA_KEYSTORE_PATH (node onboard.js writes it)');
    const { address } = JSON.parse(await fs.readFile(lib.resolvePath(keystore), 'utf8'));
    return getAddress(String(address).startsWith('0x') ? address : `0x${address}`);
  }
  async function loadDefaults() {
    const file = args.opt('defaults') || path.join(secretsDir, 'wager-defaults.json');
    let custom;
    try { custom = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && !args.opt('defaults')) return W.WAGER_DEFAULTS; throw new Error(`${file}: ${e.message}`); }
    if (custom.fixture_only) throw new Error(`${file} is a shape example; copy it and remove fixture_only`);
    const jury = (custom.jury || W.WAGER_DEFAULTS.jury).map((n) => ({ provider: W.PROVIDER_NAMES[String(n.provider).toLowerCase()] ?? n.provider, model: n.model, weight: Number(n.weight), runs: Number(n.runs ?? 1) }));
    const oracle = { ...W.WAGER_DEFAULTS.oracle, ...(custom.oracle || {}) };
    if (!jury.length || jury.some((n) => !String(n.provider ?? '').trim() || !String(n.model ?? '').trim() || !Number.isFinite(n.weight) || n.weight <= 0 || !Number.isInteger(n.runs) || n.runs < 1 || n.runs > 10)
      || Math.abs(jury.reduce((sum, n) => sum + n.weight, 0) - 1) > 0.001) throw new Error(`${file}: jury needs provider, model, a weight (weights sum to 1) and runs 1-10 for every node`);
    if (!W.shared.parseOracleLine(`${W.shared.formatOracle(oracle)}.`)) throw new Error(`${file}: oracle needs maxOracleFeeEth, estimatedBaseCostEth (decimal ETH), maxFeeBasedScaling and alpha`);
    return { ...W.WAGER_DEFAULTS, classId: Number(custom.classId ?? W.WAGER_DEFAULTS.classId), jury, oracle };
  }

  // ---- local state: ~/.config/verdikta-bounties/wagers/<first 16 hex of the terms hash>/ ----
  const dirOf = (hash) => path.join(stateDir, hash.slice(0, 16));
  // approved.json is the create_bounty.js config, approved.json.state.json its recovery state.
  const pathsOf = (hash) => ({ approval: path.join(dirOf(hash), 'approval.json'), config: path.join(dirOf(hash), 'approved.json'), state: path.join(dirOf(hash), 'approved.json.state.json') });
  const exists = (file) => fs.access(file).then(() => true, () => false);
  // Recovery state: missing is null, unreadable is an error (never mistaken for "nothing started").
  const readState = (file) => fs.readFile(file, 'utf8').then(JSON.parse, (e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  const isoNow = () => new Date(now() * 1000).toISOString();
  // A state file is set aside (renamed, never deleted) when what it recorded allows a fresh attempt.
  async function setAside(file, label) {
    const kept = file.replace(/\.json$/, `.${label}-${now()}.json`);
    await fs.rename(file, kept);
    return kept;
  }
  async function saveRecord({ approved, ...record }) {
    await ensureDir(dirOf(record.termsSha256));
    await fs.writeFile(path.join(dirOf(record.termsSha256), 'wager.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  }
  // The bounty number is create_bounty.js's linked job id, read back whenever the post finished (here or elsewhere).
  async function recordPost(record, state) {
    Object.assign(record, { bountyId: state.linkedJobId, txHash: state.txHash ?? null, postedAt: record.postedAt ?? isoNow() });
    await saveRecord(record);
  }
  async function records() {
    const names = await fs.readdir(stateDir).catch(() => []);
    const out = [];
    for (const name of names) {
      const record = await fs.readFile(path.join(stateDir, name, 'wager.json'), 'utf8').then(JSON.parse, () => null);
      if (record?.network !== network) continue;
      const approved = await exists(pathsOf(record.termsSha256).approval);
      if (approved && record.bountyId == null) {
        const state = await readState(pathsOf(record.termsSha256).state).catch(() => null);
        if (state?.linkedJobId != null) await recordPost(record, state);
      }
      out.push({ ...record, approved });
    }
    return out.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }
  async function findRecord(ref) {
    if (!ref) throw new Error(`Name the wager\n${USAGE}`);
    const all = await records();
    const hits = all.filter((r) => (/^[0-9a-f]{8,64}$/i.test(ref) && r.termsSha256.startsWith(ref.toLowerCase())) || r.wagerId === ref
      || (/^[0-9]+$/.test(ref) && (String(r.bountyId) === ref || String(r.counter?.number) === ref)));
    const posted = hits.filter((r) => r.approved);
    const pick = posted.length === 1 ? posted : hits;
    if (pick.length !== 1) throw new Error(pick.length ? `"${ref}" matches ${pick.length} wagers; use the terms hash prefix` : `No wager "${ref}" on ${network}; see node wager.js status`);
    return pick[0];
  }
  async function myJobs(me) {
    const list = await api(`/jobs?creator=${me}&limit=200`, { auth: true });
    return list.jobs || [];
  }

  // ---- shared output ----
  const say = (...lines) => { for (const line of lines.flat()) log(line); };
  function preview(record, problems, extra = []) {
    say('', `${record.role === 'answerer' ? 'ANSWER' : 'WAGER OFFER'} ${record.wagerId} on ${network}`, `Title: ${record.title}`, '', record.description, '',
      `Terms SHA-256: ${record.termsSha256}`,
      `Bounty: ${record.stake} ETH escrowed for ${record.opponent} (targeted; only that wallet can claim), deadline = settlement deadline ${record.settle}, no approval window, no cancel.`,
      ...extra);
    if (problems.length) { say('', 'REFUSED. Problems:', problems.map((p) => `  - ${p}`)); return false; }
    say('', 'All checks passed. Show the owner the terms above and ask them to reply with exactly:', `  ${W.approvalLineFor(record)}`,
      'Only the owner\'s own message counts. Nothing is posted or spent until then.');
    return true;
  }
  async function policyProblems(stake) {
    const policy = await lib.loadSpendPolicy().catch((e) => ({ error: e.message }));
    if (policy.error) return [`Spend policy: ${policy.error}`];
    return parseEther(stake) > BigInt(policy.maxValueWei) || parseEther(stake) > BigInt(policy.maxTotalWei) ? [`The stake ${stake} ETH exceeds the owner's spend policy cap.`] : [];
  }
  async function twinProblems(me, wagerId, ownNumber) {
    const twin = W.shared.findWagerTwin((await myJobs(me)).filter((j) => String(j.jobId) !== String(ownNumber)), wagerId);
    return twin ? [`Your bounty #${twin.jobId} already uses Wager ID ${wagerId}. One live bounty per Wager ID: a new pair needs a new ID.`] : [];
  }

  // ---- propose / answer: preview, or bind the owner's line and post through create_bounty.js ----
  // wager.js owns every post, a stalled one included: the same command with the same line finishes it. Right before
  // anything is signed or a saved transaction is rebroadcast, postProblems runs again (the scheduled start at least
  // 10 minutes away, the counter for an answer, the spend policy, the Wager ID): a post that stalled until kickoff
  // must never fund a one-sided bet. A transaction already sent is only linked.
  const started = (state) => Boolean(state && (state.txHash || state.rawTransaction || state.response));
  async function postProblems(record, ownJobId) {
    const t = now(), late = W.startLeadProblem(record.start, t, kindOfRecord(record));
    if (late) return [late];
    const problems = [...await policyProblems(record.stake), ...await twinProblems(record.me, record.wagerId, ownJobId)];
    if (record.role === 'answerer') {
      const n = record.counter.number, { status, job, rpc } = await readBounty(n);
      const report = W.counterReport({ number: n, status, job, rpc, me: record.me, ctx, now: t });
      problems.push(...report.problems);
      if (!report.problems.length && report.answer?.description !== record.description) problems.push(`Bounty #${n} no longer mirrors into the approved answer ${record.termsSha256.slice(0, 8)}.`);
    } else problems.push(...W.ownTermsProblems({ description: record.description, me: record.me, ctx, now: t }));
    return problems;
  }
  /** The approved wager the owner's line names, when its post started or finished: finished as saved, never rebuilt. */
  async function startedPost(role, sameTarget) {
    const prefixes = W.parseWagerApprovalLines(args.opt('approval')).map((l) => l.hashPrefix);
    const hits = (await records()).filter((r) => r.approved && prefixes.some((p) => r.termsSha256.startsWith(p)));
    if (hits.length > 1) throw new Error(`The approval matches ${hits.length} approved wagers; ask the owner for the line with more of the terms hash`);
    const [record] = hits;
    if (!record || (record.bountyId == null && !started(await readState(pathsOf(record.termsSha256).state)))) return null;
    if (record.role !== role || !sameTarget(record)) {
      throw new Error(`The approval names wager ${record.termsSha256.slice(0, 8)}, ${record.role === 'answerer' ? `the answer to bounty #${record.counter?.number}` : `the proposal ${record.wagerId}`}: finish it with that command`);
    }
    return record;
  }
  // The last moment an answer can be funded: the server's answerBy, 10 minutes before the scheduled start.
  const answerBy = (record) => W.isoOf(W.unix(record.start) - W.shared.MIN_START_LEAD_SECONDS);
  const againCommand = (record, line = '<the owner\'s line>') => (record.role === 'answerer'
    ? `node wager.js answer ${record.counter.number} --approval "${line}" --yes` : `node wager.js propose --input <the proposal file> --approval "${line}" --yes`);

  async function approveAndPost(record, createBody = null) {
    if (args.flag('dry-run') || args.flag('dryRun')) throw new Error('--dry-run cannot post; run without --approval to preview');
    const approval = W.bindWagerApproval({ approvalText: args.opt('approval'), termsSha256: record.termsSha256, stake: record.stake, opponent: record.opponent, settle: record.settle });
    const dir = dirOf(record.termsSha256), p = pathsOf(record.termsSha256);
    const approvalPath = p.approval, approvedPath = p.config;
    const state = await readState(p.state);
    if (record.bountyId != null || state?.linkedJobId != null) {
      if (record.bountyId == null) await recordPost(record, state);
      throw new Error(`Wager ${record.termsSha256.slice(0, 8)} is already posted as bounty #${record.bountyId}: a terms hash is used once`);
    }
    if (started(state)) {
      say(`Finishing the post of wager ${record.termsSha256.slice(0, 8)}: ${state.txHash ? `transaction ${state.txHash} was signed` : `API job ${state.response?.job?.jobId} was created, nothing signed`}.`);
      return post(record, p, true);
    }
    if (state) say(`The last post stopped before anything was created or signed (${state.apiError?.message ?? state.status}); its state is kept as ${await setAside(p.state, 'stopped')}.`);
    if (!createBody) throw new Error(`Wager ${record.termsSha256.slice(0, 8)} has nothing to finish; run the same command with the same line again`);
    const problems = [...await policyProblems(record.stake), ...await twinProblems(record.me, record.wagerId)];
    const other = (await records()).find((r) => r.wagerId === record.wagerId && r.approved && r.termsSha256 !== record.termsSha256);
    if (other) problems.push(`You already approved wager ${other.termsSha256.slice(0, 8)} with Wager ID ${record.wagerId}.`);
    if (problems.length) throw new Error(`Not posted:\n  - ${problems.join('\n  - ')}`);
    const configText = JSON.stringify(W.createConfig({ createBody, wager: { termsSha256: record.termsSha256, role: record.role, wagerId: record.wagerId, counter: record.counter } }), null, 2) + '\n';
    // One wager per terms hash: the approval is claimed once. A retry is allowed only while nothing was created.
    await ensureDir(dir);
    try {
      await fs.writeFile(approvalPath, JSON.stringify({ line: approval.line, termsSha256: record.termsSha256, approvedAt: new Date(now() * 1000).toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await saveRecord(record);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const saved = await fs.readFile(path.join(dir, 'wager.json'), 'utf8').then(JSON.parse, () => null);
      if (saved) record = saved; else await saveRecord(record);
      say('Retrying the post: this wager was approved before and nothing was created.');
    }
    const savedConfig = await fs.readFile(approvedPath, 'utf8').catch(() => null);
    if (savedConfig === null) await fs.writeFile(approvedPath, configText, { flag: 'wx', mode: 0o600 });
    else if (savedConfig !== configText) throw new Error(`${approvedPath} differs from these terms; inspect it instead of posting`);
    return post(record, p, false);
  }

  // create_bounty.js posts (or, with resume, finishes) the saved config; postProblems guards every broadcast.
  async function post(record, p, resume) {
    const wallet = await lib.loadWallet();
    if (!sameAddress(wallet.address, record.me)) throw new Error(`The keystore decrypts to ${wallet.address}, not the Poster ${record.me}`);
    const beforeBroadcast = async ({ jobId }) => {
      const problems = await postProblems(record, jobId);
      if (problems.length) throw new Error(`Not funded: nothing was signed or broadcast for wager ${record.termsSha256.slice(0, 8)}.\n  - ${problems.join('\n  - ')}`);
    };
    const files = { config: p.config, resume: resume ? p.state : null };
    try {
      await create({ ...lib, arg: (name) => files[name] ?? null, loadWallet: async () => wallet }, { beforeBroadcast });
    } catch (e) {
      // Refused or lost before /jobs/create answered: nothing exists to finish, so the same line may try again.
      const state = await readState(p.state).catch(() => null);
      if (state && !started(state)) throw new Error(`${e.message}\nNothing was created or signed (state kept as ${await setAside(p.state, 'stopped')}). Re-run the same command with the same line to try again.`, { cause: e });
      throw e;
    }
    const state = await readState(p.state);
    if (state?.linkedJobId == null) throw new Error(`Posting wager ${record.termsSha256.slice(0, 8)} did not finish (${state?.status ?? 'no state'}). Finish it: ${againCommand(record)}`);
    await recordPost(record, state);
    say('', `Posted bounty #${record.bountyId} (transaction ${record.txHash}): ${origin}/bounty/${record.bountyId}`);
    const terms = termsOf(record), kind = W.kindOf(terms), label = W.startLabel(kind);
    if (record.role === 'proposer' && W.startLeadProblem(record.start, now(), kind)) {
      say(`It was linked too close to the ${label} ${record.start} for an answer: unless the opponent already answered, the wager is off. See node wager.js status; reclaim the stake after ${record.settle} with node wager.js close ${record.termsSha256.slice(0, 8)}.`);
    } else if (record.role === 'proposer') {
      say(`Send the opponent: "My side of wager ${record.wagerId} is bounty #${record.bountyId} on ${origin}. Answer it by number by ${answerBy(record)} (10 minutes before the ${label} ${record.start}): with the Verdikta onboarding skill, node wager.js answer ${record.bountyId}; on the website, the ${kind === 'question' ? 'Question Wager' : 'Mutual Wager'} template's answer field takes #${record.bountyId}."`,
        `Then check their bounty as soon as it is posted, and before ${record.start}: node wager.js check <their bounty number>`);
    } else if (kind === 'question') {
      say(`The wager is complete: bounty #${record.counter.number} and your #${record.bountyId}. From Claims open (${terms.fields.claimsOpen}), the side the answer makes win claims the other bounty with node wager.js claim.`);
    } else say(`The wager is complete: bounty #${record.counter.number} and your #${record.bountyId}. After the game, the winner claims the loser's bounty with node wager.js claim.`);
  }

  async function propose() {
    if (!args.opt('input')) throw new Error(USAGE);
    const input = JSON.parse(await fs.readFile(args.opt('input'), 'utf8'));
    if (input.fixture_only) throw new Error(`${args.opt('input')} is a shape example: copy it, fill in the real wager and remove fixture_only`);
    const me = await walletAddress();
    const built = W.buildProposal(input, { me, ctx, defaults: await loadDefaults(), now: now() });
    if (args.opt('approval')) {
      const saved = await startedPost('proposer', (r) => (built.termsSha256 ? r.termsSha256 === built.termsSha256 : r.wagerId === input.wagerId));
      if (saved) return approveAndPost(saved);
    }
    if (!built.offer) { say('REFUSED. Fix the proposal input:', built.problems.map((p) => `  - ${p}`)); throw new Error('The proposal input has problems; nothing was saved'); }
    const record = { version: 1, role: 'proposer', network, termsSha256: built.termsSha256, wagerId: built.terms.fields.wagerId, title: built.offer.title, description: built.offer.description,
      me, opponent: built.expect.targetHunter, stake: built.expect.stake, start: built.terms.fields.start, settle: built.terms.fields.settle, counter: null, createdAt: new Date(now() * 1000).toISOString() };
    if (args.opt('approval')) {
      if (built.problems.length) throw new Error(`Not posted:\n  - ${built.problems.join('\n  - ')}`);
      return approveAndPost(record, built.createBody);
    }
    const problems = [...built.problems, ...await policyProblems(record.stake), ...await twinProblems(me, record.wagerId).catch((e) => [`Could not check your other bounties: ${e.message}`])];
    if (!problems.length && !(await exists(path.join(dirOf(record.termsSha256), 'approval.json')))) await saveRecord(record);
    if (!preview(record, problems, [`Jury ${W.shared.formatJury(built.expect.jury, built.expect.iterations)}; class ${built.expect.classId}; threshold ${built.expect.threshold}.`,
      `The opponent must answer by ${answerBy(record)}, 10 minutes before the ${W.startLabel(W.kindOf(built.terms))} ${record.start}; without an answer the wager is off and this stake refunds after ${record.settle}.`,
      ...built.warnings.map((w) => `Note: ${w}`)])) throw new Error('The proposal was refused');
  }

  async function answer() {
    const n = bountyNumber(args.positional[1]);
    if (args.opt('approval')) {
      const saved = await startedPost('answerer', (r) => r.counter?.number === n);
      if (saved) return approveAndPost(saved);
    }
    const me = await walletAddress();
    const { status, job, rpc } = await readBounty(n);
    const report = W.counterReport({ number: n, status, job, rpc, me, ctx, now: now() });
    if (!report.answer || report.problems.length) {
      say(`REFUSED: do not answer bounty #${n}.`, report.problems.map((p) => `  - ${p}`), 'Tell the owner why. Never post a replacement or a different answer to work around a failed check.');
      throw new Error(`Bounty #${n} failed the counter check`);
    }
    const offer = { title: report.answer.title, description: report.answer.description };
    const record = { version: 1, role: 'answerer', network, termsSha256: W.termsHash(offer), wagerId: report.terms.fields.wagerId, title: offer.title, description: offer.description,
      me, opponent: getAddress(report.expect.targetHunter), stake: report.expect.stake, start: report.terms.fields.start, settle: report.terms.fields.settle,
      counter: { number: n }, checks: { [n]: { ok: true, problems: [], checkedAt: new Date(now() * 1000).toISOString() } }, createdAt: new Date(now() * 1000).toISOString() };
    if (args.opt('approval')) return approveAndPost(record, report.answer.createBody);
    const problems = [...await policyProblems(record.stake), ...await twinProblems(me, record.wagerId).catch((e) => [`Could not check your other bounties: ${e.message}`])];
    if (!problems.length && !(await exists(path.join(dirOf(record.termsSha256), 'approval.json')))) await saveRecord(record);
    if (!preview(record, problems, [`Bounty #${n} by ${status.creator} passed the full counter check (site records, escrow read, mirrored terms, template rubric, jury, oracle settings, timing).`,
      ...report.notes.map((note) => `Note: ${note}`)])) throw new Error('The answer was refused');
  }

  async function check() {
    const n = bountyNumber(args.positional[1]);
    const { status, job, rpc } = await readBounty(n);
    let me, mine = null, record = null;
    if (args.opt('against')) {
      const m = bountyNumber(args.opt('against'), '--against bounty number');
      const [mStatus, mDetails] = await Promise.all([api(`/jobs/${m}/onchain-status`), api(`/jobs/${m}?includeRubric=true`)]);
      me = getAddress(mStatus.creator);
      mine = { description: mDetails.job?.description, number: m, status: mStatus };
    } else {
      me = await walletAddress();
      const wagerId = W.shared.parseMutualWagerTerms(job?.description).fields?.wagerId;
      record = (await records()).find((r) => r.wagerId === wagerId && r.bountyId != null && status && sameAddress(r.opponent, status.creator)) || null;
      if (record) mine = { description: record.description, number: record.bountyId, status: await api(`/jobs/${record.bountyId}/onchain-status`) };
    }
    const report = W.counterReport({ number: n, status, job, rpc, me, ctx, now: now(), mine });
    const ok = report.problems.length === 0;
    say(mine ? `Bounty #${n} checked as the counter to bounty #${mine.number} (${me}):` : `Bounty #${n} checked as an offer for ${me} to answer:`,
      ok ? '  PASS: site records, escrow read, terms lines, template rubric word for word, jury, oracle settings, linkage and timing all match.' : report.problems.map((p) => `  FAIL: ${p}`));
    if (record) {
      // Results per bounty: a failed check of another bounty by the opponent leaves a passed counter in place.
      record.checks = { ...record.checks, [n]: { ok, problems: report.problems, checkedAt: new Date(now() * 1000).toISOString() } };
      if (ok && record.role === 'proposer' && record.counter == null) record.counter = { number: n };
      await saveRecord(record);
    }
    if (!ok) {
      say(mine ? 'Tell the owner now: this bounty cannot back your wager. Ask the opponent for a correct answer before the scheduled start; your own bounty cannot be cancelled and refunds after its deadline.'
        : 'Do not answer it. Tell the owner why.');
      throw new Error(`Bounty #${n} failed the counter check`);
    }
    if (!mine) say(`To accept, show the owner the answer preview: node wager.js answer ${n}`);
  }

  async function status() {
    const all = await records();
    if (!all.length) { say(`No wagers on ${network}.`); return; }
    const t = now();
    for (const r of all) {
      const deadlinePassed = t >= W.unix(r.settle);
      const terms = termsOf(r), kind = W.kindOf(terms), f = terms.fields || {};
      say('', `${r.termsSha256.slice(0, 8)}  ${r.wagerId}  ${r.role}  vs ${W.shortAddress(r.opponent)}  stake ${r.stake} ETH  ${kind === 'question' ? 'bets close' : 'start'} ${r.start}  settle ${r.settle}`);
      // A question's terms say what wins; the owner and the agent read the answer against these lines.
      if (kind === 'question') {
        say(`  Question: ${f.question}`, `  YES wins if: ${f.yes}`, `  NO wins if: ${f.no}`, `  No winner: ${f.noWinner}`, `  Your side: ${terms.poster.side}`,
          `  Resolution sources: ${W.shared.parseSourcesLine(f.sources).join(' , ')}`,
          `  Bets close ${f.start}, resolves at ${f.resolvesAt}, claims open ${f.claimsOpen}, settlement deadline ${f.settle}`);
      }
      if (!r.approved) { say('  Waiting for the owner\'s approval line:', `    ${W.approvalLineFor(r)}`); continue; }
      if (r.bountyId == null) {
        const p = pathsOf(r.termsSha256);
        const state = await readState(p.state).catch(() => null), line = await readState(p.approval).then((a) => a?.line, () => undefined);
        // Finishing re-checks the start before any broadcast; a signed transaction may already be on chain.
        if (state?.txHash) say(`  Approved; transaction ${state.txHash} was signed but the bounty is not linked yet. Finish it: ${againCommand(r, line)}`);
        else if (W.startLeadProblem(r.start, t, kind)) say(`  Approved but never funded, and the ${W.startLabel(kind)} is too close or past: this wager is off. Nothing was spent.`);
        else say(`  Approved, not posted${started(state) ? ` (API job ${state.response?.job?.jobId} created, nothing signed)` : ''}. Finish it: ${againCommand(r, line)}`);
        continue;
      }
      const mineStatus = await api(`/jobs/${r.bountyId}/onchain-status`).catch(() => null);
      say(`  Your bounty #${r.bountyId}: ${mineStatus?.status ?? 'unknown'}${mineStatus?.winner ? `, paid to ${mineStatus.winner}` : ''}, deadline ${mineStatus?.submissionDeadlineIso ?? r.settle}`);
      let counter = r.counter?.number ?? null;
      if (counter == null) {
        const candidates = await api(`/jobs?creator=${r.opponent}&targetHunter=${r.me}&limit=50`, { auth: true }).then((l) => (l.jobs || []).filter((j) => W.shared.parseMutualWagerTerms(j.description).fields?.wagerId === r.wagerId), () => []);
        say(candidates.length ? `  Opponent bounties with this Wager ID: ${candidates.map((j) => `#${j.jobId}`).join(', ')}. Check now: node wager.js check ${candidates[0].jobId}` : '  No answer from the opponent yet.');
      } else {
        const last = r.checks?.[counter];
        const checked = last ? (last.ok ? `passed the check ${last.checkedAt}` : `FAILED the check ${last.checkedAt}`) : 'not checked by this wallet';
        say(`  Counter bounty #${counter}: ${checked}.`);
      }
      const start = W.unix(r.start);
      let next;
      if (mineStatus?.status === 'AWARDED') next = `Your bounty #${r.bountyId} paid the opponent: the jury found the other side won.`;
      else if (mineStatus?.status === 'CLOSED') next = `Your bounty #${r.bountyId} is closed and its stake refunded.`;
      else if (r.claim && await claimFailed(r.claim)) next = `The jury failed your claim to #${r.claim.bounty} (submission ${r.claim.submissionId}). Before ${r.settle} a new claim may replace it: node wager.js claim ${r.termsSha256.slice(0, 8)} ${claimFlags(kind)}, then the owner's new claim line.`;
      else if (r.claim) next = `Claim submitted to #${r.claim.bounty}${r.claim.submissionId != null ? ` (submission ${r.claim.submissionId})` : ''}: after the jury, node claim_bounty.js --jobId ${r.claim.bounty} --submissionId <id>. Reclaim your own stake after ${mineStatus?.submissionDeadlineIso ?? r.settle} with node wager.js close ${r.termsSha256.slice(0, 8)}.`;
      else if (counter == null) {
        const when = kind === 'question' ? 'Bets close' : 'the start';
        next = t < start ? `Wait for the opponent to answer #${r.bountyId} by ${answerBy(r)} (10 minutes before ${when}), then check it.` : `No checked counter before ${when}: the wager is off. Reclaim your stake after ${mineStatus?.submissionDeadlineIso ?? r.settle}: node wager.js close ${r.termsSha256.slice(0, 8)}`;
      } else if (deadlinePassed) next = `The deadline passed: reclaim your stake with node wager.js close ${r.termsSha256.slice(0, 8)}`;
      else if (kind === 'question') next = questionNext(r, terms, t);
      else if (t < start + W.CLAIM_OPENS_AFTER_START) next = `Game not final yet. If your side wins, claim.md can be prepared from ${W.isoOf(start + W.CLAIM_OPENS_AFTER_START)}; it is submitted about 2 hours after the final (pass --final-at), or from ${W.isoOf(start + W.shared.CLAIM_AFTER_START_SECONDS)} without it.`;
      else next = `If your side won: node wager.js claim ${r.termsSha256.slice(0, 8)} --score "..." --source "Name|URL|quote" --source "..." (about 2 hours after the final), then submit it with the owner's claim line.`;
      say(`  Next: ${next}`);
    }
  }

  // A question's next step after both bounties exist: its times, not a game's, open the claim (from Claims open).
  function questionNext(r, terms, t) {
    const f = terms.fields, side = terms.poster.side;
    if (t < W.unix(f.resolvesAt)) return `Bets are closed; the question resolves at ${f.resolvesAt}. If the answer makes your side (${side}) win, claim.md can be prepared from Claims open, ${f.claimsOpen}.`;
    if (t < W.unix(f.claimsOpen)) return `The question resolved at ${f.resolvesAt}; claims open at ${f.claimsOpen}, once the sources show the final value. If the answer makes your side (${side}) win, prepare the claim then.`;
    return `If the answer makes your side (${side}) win: node wager.js claim ${r.termsSha256.slice(0, 8)} ${claimFlags('question')} (the value as the sources show it, and the time it is for), then submit it with the owner's claim line. If the No winner line holds, nobody claims.`;
  }

  // The claim submitted before, read from the escrow. In progress: finish it or wait for the jury. Failed (the jury's
  // verdict, or a timed-out evaluation once finalized) or stopped before anything reached the chain: its state is set
  // aside and a new claim may replace it before the deadline, prepared again and approved again by the owner.
  async function settleEarlierClaim(record, submissionPath, me) {
    const earlier = await readState(submissionPath);
    if (!earlier) {
      if (record.claim) throw new Error(`wager.json records a claim to #${record.claim.bounty}, but ${submissionPath} is missing. Restore it; never delete state files to retry`);
      return null;
    }
    const n = Number(earlier.jobId ?? record.claim?.bounty), id = earlier.submissionId ?? null;
    const resume = `node submit_to_bounty.js --jobId ${n} --resume ${id ?? '<submission id>'} --state ${submissionPath}`;
    let outcome;
    if (id == null) {
      if (earlier.prepareTxHash) throw new Error(`This wager's claim was already submitted: its prepare transaction ${earlier.prepareTxHash} was sent. Continue it with: ${resume}`);
      outcome = { result: 'NOT_PREPARED' };
    } else {
      const sub = await rpcSubmission(n, id), s = W.SUBMISSION_STATUS[Number(sub.status)];
      if (!sameAddress(sub.hunter, me)) throw new Error(`Submission ${id} on bounty #${n} is not this wallet's; inspect ${submissionPath}`);
      if (s === 'Prepared') throw new Error(`This wager's claim was already submitted as submission ${id}, but its evaluation was not started. Continue it with: ${resume}`);
      if (s === 'PendingVerdikta') throw new Error(`This wager's claim was already submitted as submission ${id} and is being evaluated. After the jury: node claim_bounty.js --jobId ${n} --submissionId ${id}. A new claim is possible only if it fails`);
      if (s !== 'Failed') throw new Error(`This wager's claim was already submitted as submission ${id} and is ${s ?? `in state ${sub.status}`}`);
      outcome = { result: 'FAILED', acceptance: Number(sub.acceptance), rejection: Number(sub.rejection) };
    }
    const settled = { ...record.claim, bounty: n, submissionId: id, ...outcome, keptAs: await setAside(submissionPath, `attempt${(record.claims?.length ?? 0) + 1}`), settledAt: isoNow() };
    record.claims = [...(record.claims || []), settled];
    delete record.claim;
    await saveRecord(record);
    return settled;
  }

  async function claim() {
    const record = await findRecord(args.positional[1]);
    if (record.bountyId == null) throw new Error('Your side of this wager was never posted; there is nothing to claim with');
    const claimedNumber = record.counter?.number != null && record.checks?.[record.counter.number]?.ok ? record.counter.number : null;
    if (claimedNumber == null) throw new Error('No checked counter bounty: run node wager.js check <the opponent\'s bounty> first');
    const dir = dirOf(record.termsSha256);
    const claimPath = path.join(dir, 'claim.md'), inputPath = path.join(dir, 'claim-input.json'), submissionPath = path.join(dir, 'claim-submission.json');
    // The claim is rebuilt from the same inputs at approval, so the owner's line names exactly the bytes submitted. A
    // game claim gives a score, a question claim an answer, a value and its time; the claimed bounty's terms decide
    // which one applies (buildClaim refuses the other shape).
    const kind = kindOfRecord(record), question = QUESTION_CLAIM_FLAGS.some((k) => args.opt(k) != null);
    const given = (name, key = name) => (args.opt(name) != null ? { [key]: args.opt(name) } : {});
    const input = question ? { answer: args.opt('answer'), value: args.opt('value'), asOf: args.opt('as-of'), sources: args.all('source'), ...given('score'), ...given('final-at', 'finalAt') }
      : args.opt('score') ? { score: args.opt('score'), sources: args.all('source'), finalAt: args.opt('final-at') }
        : args.opt('approval') ? await fs.readFile(inputPath, 'utf8').then(JSON.parse, () => { throw new Error(`No saved claim: run claim with ${kind === 'question' ? '--answer, --value, --as-of' : '--score'} and --source first`); })
          : (() => { throw new Error(`${kind === 'question' ? '--answer, --value, --as-of' : '--score'} and two --source entries are required\n${USAGE}`); })();
    const me = await walletAddress();
    const [{ status, job }, mine] = await Promise.all([readBounty(claimedNumber), readBounty(record.bountyId)]);
    if (!status || status.status !== 'OPEN' || status.deadlinePassed) throw new Error(`Bounty #${claimedNumber} is ${status?.status || 'unreadable'}; it cannot be claimed`);
    // Fail closed: no claim without reading, on the site and on chain, that your own bounty was not paid out.
    if (!mine.status || !mine.rpc) throw new Error(`Could not read your bounty #${record.bountyId} (${mine.status ? 'escrow' : 'site record'}); try again. A claim never goes ahead without checking that your own bounty was not already paid to the opponent`);
    if (mine.status.status === 'AWARDED' || mine.rpc.status === '1') throw new Error(`Your bounty #${record.bountyId} was already paid to ${mine.status.winner ?? mine.rpc.winner}: the jury found the other side won`);
    const terms = W.shared.parseMutualWagerTerms(job?.description);
    if (terms.fields?.wagerId !== record.wagerId) throw new Error(`Bounty #${claimedNumber} is not part of wager ${record.wagerId}`);
    const last = await settleEarlierClaim(record, submissionPath, me);
    if (last) say(`Your earlier claim${last.submissionId != null ? ` (submission ${last.submissionId})` : ''} ${last.result === 'FAILED' ? `failed its evaluation (acceptance ${last.acceptance}, rejection ${last.rejection})` : 'stopped before anything reached the chain'}; its state is kept as ${last.keptAs}.`);
    const attempt = (record.claims?.length ?? 0) + 1;
    const built = W.buildClaim({ claimed: { number: claimedNumber, terms, status }, counter: { number: record.bountyId, status: mine.status, job: mine.job }, me, ctx,
      score: input.score, sources: input.sources, finalAt: input.finalAt ?? undefined, answer: input.answer, value: input.value, asOf: input.asOf, now: now() });
    const claimSha256 = W.sha256(built.claim);
    const notes = built.warnings.map((w) => `  Note: ${w}`);
    if (!args.opt('approval')) {
      await fs.writeFile(claimPath, built.claim, { mode: 0o600 });
      await fs.writeFile(inputPath, JSON.stringify({ ...input, attempt }, null, 2) + '\n', { mode: 0o600 });
      say(built.claim, `claim.md SHA-256: ${claimSha256} (saved to ${claimPath})`, notes, '',
        ...(attempt > 1 ? [`This is claim ${attempt} for this wager. Tell the owner why the last one failed: their approval of it does not cover this one.`] : []),
        'Show the owner this claim and ask them to reply with exactly:', `  ${W.claimLineFor({ claimSha256, bounty: claimedNumber })}`,
        kind === 'question' ? `Submitting prepays the evaluation fee. Submit it by ${built.claimBy}, 15 minutes before the deadline.`
          : `Submitting prepays the evaluation fee. It is refused before ${built.claimAfter} (about 2 hours after the final; pass --final-at <ISO> when you know when the game ended).`);
      return;
    }
    // A new claim after a failed one needs the owner's new line for it: it must be prepared (and shown) again first.
    if ((input.attempt ?? 1) !== attempt) {
      throw new Error(`The last claim failed, and this one was not prepared since. Run node wager.js claim ${record.termsSha256.slice(0, 8)} ${claimFlags(kind, true)} without --approval, show the owner the new claim.md and why the last one failed, and ask for a new claim line. The earlier line does not cover a new submission`);
    }
    const approval = W.bindClaimApproval({ approvalText: args.opt('approval'), claimSha256, bounty: claimedNumber });
    if (built.tooEarly) throw new Error(`Too early to submit: wait until ${built.claimAfter}. Right after the final, a juror's web tool can still be served an in-progress page and fail the claim`);
    await fs.writeFile(claimPath, built.claim, { mode: 0o600 });
    const files = { jobId: String(claimedNumber), state: submissionPath };
    await submit({ ...lib, arg: (name) => files[name] ?? null, argAll: (name) => (name === 'file' ? [claimPath] : []) });
    const saved = await fs.readFile(submissionPath, 'utf8').then(JSON.parse, () => ({}));
    record.claim = { bounty: claimedNumber, attempt, claimSha256, approvalLine: approval.line, submissionId: saved.submissionId ?? null, submittedAt: isoNow() };
    await saveRecord(record);
    say(`Claim submitted to bounty #${claimedNumber}${saved.submissionId != null ? ` as submission ${saved.submissionId}` : ''}. The jury takes about 5-10 minutes; then node claim_bounty.js --jobId ${claimedNumber} --submissionId <id> finalizes the payout.`);
  }

  async function close() {
    const record = await findRecord(args.positional[1]);
    if (record.bountyId == null) throw new Error('This wager has no posted bounty of yours');
    const me = await walletAddress();
    const b = await rpcBounty(record.bountyId);
    if (!b || !sameAddress(b.creator, me)) throw new Error(`Bounty #${record.bountyId} is not this wallet's`);
    if (b.status !== '0') throw new Error(`Bounty #${record.bountyId} is already ${b.status === '1' ? 'paid out' : 'closed'}`);
    if (now() < Number(b.submissionDeadline)) throw new Error(`Bounty #${record.bountyId} can be closed after its deadline ${W.isoOf(b.submissionDeadline)}`);
    say(`Closing your bounty #${record.bountyId} returns its ${record.stake} ETH stake to this wallet.`);
    const receipt = await recover(lib, { close: String(record.bountyId) });
    if (receipt) { Object.assign(record, { closedAt: new Date(now() * 1000).toISOString(), closeTx: receipt.hash }); await saveRecord(record); say(`Closed: transaction ${receipt.hash}`); }
  }

  return { propose, answer, check, status, claim, close }[verb]();
}

if (isMain(import.meta.url)) {
  const lib = await import('./_lib.js');
  try { await runWager(lib); }
  catch (error) { console.error(error.message); process.exit(1); }
}
