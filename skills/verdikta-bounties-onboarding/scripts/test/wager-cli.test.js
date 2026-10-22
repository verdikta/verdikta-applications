// wager.js verbs end to end against recorded testnet records, with the site, the escrow and create_bounty.js mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWager } from '../wager.js';
import * as W from '../_wager.js';
import { readFileSync } from 'node:fs';
import { creationTerms } from '../_transaction-guards.js';

const fx = (n, kind) => JSON.parse(readFileSync(new URL(`./fixtures/wager-testnet/${n}.${kind}.json`, import.meta.url), 'utf8'));
// The synthesized question pair (test/wager-question.test.js): #40 alice's offer, #41 bob's answer.
const qfx = (kind, n) => JSON.parse(readFileSync(new URL(`./fixtures/wager-question/${kind}-${n}.json`, import.meta.url), 'utf8'));
const alice = '0x7ACbdBC2bB6e4fF8b705d695F77144eA619C0e2D', bob = '0x75fAc210bF1Dcd0BA3FaC294de7c50C5763Da6d9';
const at = (iso) => Date.parse(iso) / 1000;
const policy = { maxValueWei: '1000000000000000', maxTotalWei: '2000000000000000', maxGasLimit: '900000', maxFeePerGasWei: '1000000000', maxPriorityFeePerGasWei: '1000000' };
const template = W.wagerRubricJson();
// The pair also predates canonical titles (the jury reads the title): `current` gives it today's derived title too.
const canonicalTitle = (job) => W.shared.canonicalWagerText(W.shared.parseMutualWagerTerms(job.description)).title;
const current = (job) => ({ ...job, title: canonicalTitle(job), rubricContent: { ...job.rubricContent, criteria: job.rubricContent.criteria.map((c) => (c.id === 'counter_bounty_terms' ? { ...c, description: template.criteria.find((x) => x.id === c.id).description } : c)) } });

async function harness(t, { me, clock = at('2026-10-20T18:00:00Z'), myJobs = [] } = {}) {
  const dir = await mkdtemp(`${tmpdir()}/verdikta-wager-test-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const logs = [], created = [], recovered = [], submitted = [], broadcasts = [], guarded = [];
  const records = {}, chain = {}, submissions = {}, mined = new Set();
  for (let n = 18; n <= 25; n++) { records[n] = { status: fx(n, 'status'), job: current(fx(n, 'job').job) }; chain[n] = fx(n, 'rpc'); }
  for (const n of [40, 41]) { records[n] = { status: qfx('status', n), job: qfx('job', n) }; chain[n] = qfx('chain', n); }
  // stall: 'api' stops after the API job exists, 'signed' after signing (transport lost); apiRefusal: /jobs/create answers 503 with that code.
  // me and secretsDir switch to run the other bettor against the same site and escrow (h.as).
  const h = { dir, secretsDir: dir, me, logs, created, recovered, submitted, broadcasts, guarded, records, chain, submissions, mined, clock, myJobs, nextId: 26, nextSubmission: 0, stall: null, apiRefusal: null, pending: {} };
  h.as = (wallet) => { h.me = wallet; h.secretsDir = wallet === me ? dir : path.join(dir, `wallet-${wallet}`); h.logs.length = 0; };
  h.lib = {
    getNetwork: () => 'base-sepolia', walletAddress: async () => h.me, loadApiKey: async () => 'test-key', loadSpendPolicy: async () => policy,
    loadWallet: async () => ({ address: h.me }), providerFor: () => ({ getNetwork: async () => ({ chainId: 84532n }), destroy() {} }),
  };
  h.fetchApi = async (url, { headers }) => {
    const route = url.replace('https://bounties-testnet.verdikta.org/api', '');
    let m;
    const ok = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if ((m = /^\/jobs\/(\d+)\/onchain-status$/.exec(route))) return records[m[1]] ? ok(records[m[1]].status) : new Response('{}', { status: 404 });
    if ((m = /^\/jobs\/(\d+)\?includeRubric=true$/.exec(route))) return records[m[1]] ? ok({ job: records[m[1]].job }) : new Response('{}', { status: 404 });
    if (route.startsWith('/jobs?')) { assert.equal(headers['X-Bot-API-Key'], 'test-key'); return ok({ jobs: h.myJobs }); }
    throw new Error(`unexpected ${url}`);
  };
  h.contract = () => ({
    getBounty: async (n) => { if (!chain[n]) throw new Error('bad id'); return chain[n]; },
    getSubmission: async (n, id) => { if (!submissions[`${n}/${id}`]) throw new Error('bad submissionId'); return submissions[`${n}/${id}`]; },
    pendingSubmissionIds: async (n) => (h.pending[n] || []).map(BigInt),
  });
  // create_bounty.js stand-in with the real one's recovery states: API_CREATE_PENDING -> API_CREATED (or API_REJECTED)
  // -> beforeBroadcast -> signed (txHash) -> broadcast -> linked. A resume of a mined transaction only links.
  h.create = async (lib, opts = {}) => {
    assert.equal(typeof opts.beforeBroadcast, 'function');
    const file = lib.arg('config'), config = JSON.parse(await readFile(file, 'utf8')), statePath = lib.arg('resume') || `${file}.state.json`;
    const save = (s) => writeFile(statePath, JSON.stringify(s));
    let state;
    if (lib.arg('resume')) state = JSON.parse(await readFile(statePath, 'utf8'));
    else {
      await writeFile(statePath, JSON.stringify({ status: 'API_CREATE_PENDING' }), { flag: 'wx' });
      if (h.apiRefusal) {
        const message = `API /jobs/create: HTTP 503 ${h.apiRefusal}: Could not read counter bounty #18 to check it. Try again shortly.; do not create a replacement job`;
        await save({ status: 'API_REJECTED', apiError: { status: 503, code: h.apiRefusal, message } }); h.apiRefusal = null;
        throw new Error(message);
      }
      created.push(config);
      state = { status: 'API_CREATED', response: { job: { jobId: 900 + created.length } } };
      await save(state);
      if (h.stall === 'api') { h.stall = null; throw new Error('process stopped after the API job'); }
    }
    if (!(state.txHash && mined.has(state.txHash))) {
      await opts.beforeBroadcast({ jobId: state.response?.job?.jobId ?? null }); guarded.push(h.clock);
      if (!state.txHash) Object.assign(state, { txHash: `0x${String(created.length).padStart(64, 'a')}`, rawTransaction: '0x02', status: 'BROADCAST_PENDING' });
      await save(state);
      if (h.stall === 'signed') { h.stall = null; throw new Error(`Broadcast uncertain for ${state.txHash}; use saved state to resume the same transaction: transport lost`); }
      broadcasts.push(state.txHash); mined.add(state.txHash);
    }
    const deadline = Number(creationTerms(config).submissionDeadline), id = h.nextId++;
    Object.assign(state, { status: 'BROADCAST', linkedJobId: id });
    await save(state);
    // The site's records of a posted question bounty have the question fixtures' shape (and its v4 rubric).
    const question = /\(mutual-wager-v4\) ===/.test(config.description);
    const base = question ? { status: qfx('status', 40), job: qfx('job', 40), rpc: qfx('chain', 40) } : { status: fx(18, 'status'), job: current(fx(18, 'job').job), rpc: fx(18, 'rpc') };
    records[id] = { status: { ...base.status, bountyId: id, creator: h.me, targetHunter: config.targetHunter, createdAt: h.clock, createdAtIso: new Date(h.clock * 1000).toISOString(), submissionDeadline: deadline, submissionDeadlineIso: new Date(deadline * 1000).toISOString() }, job: { ...base.job, jobId: id, description: config.description, title: config.title } };
    chain[id] = { ...base.rpc, creator: h.me, targetHunter: config.targetHunter, createdAt: String(h.clock), submissionDeadline: String(deadline) };
  };
  h.recover = async (lib, opts) => { recovered.push(opts); return { hash: `0x${'cd'.repeat(32)}` }; };
  // submit_to_bounty.js stand-in: records what it would upload and writes its state like the real one (wx); the
  // escrow then holds the submission, being evaluated.
  h.submit = async (lib) => {
    const state = lib.arg('state'), id = String(h.nextSubmission++);
    await writeFile(state, JSON.stringify({ jobId: lib.arg('jobId'), submissionId: id }), { flag: 'wx' });
    submissions[`${lib.arg('jobId')}/${id}`] = { hunter: h.me, status: 1n, acceptance: 0n, rejection: 0n };
    submitted.push({ jobId: lib.arg('jobId'), files: lib.argAll('file'), text: await readFile(lib.argAll('file')[0], 'utf8') });
  };
  h.run = (...argv) => runWager(h.lib, { argv, fetchApi: h.fetchApi, contract: h.contract, now: () => h.clock, log: (l) => logs.push(l), secretsDir: h.secretsDir, create: h.create, recover: h.recover, submit: h.submit });
  h.text = () => logs.join('\n');
  return h;
}
const lineFrom = (text) => /^ {2}(Approve wager .*)$/m.exec(text)[1];
const proposal = {
  wagerId: 'VW-TEST3-BOS-DET-20261020', event: 'NBA 2026-27 regular season: Boston Celtics (BOS) at Detroit Pistons (DET), Little Caesars Arena, Detroit, Michigan.',
  start: '2026-10-20T19:00:00Z', settle: '2026-10-21T19:00:00Z', stake: '0.0001', opponent: bob,
  sides: { creator: 'the Boston Celtics win', opponent: 'the Detroit Pistons win' },
};

test('answer: preview, then post once with the owner\'s line; a second post is refused', async (t) => {
  const h = await harness(t, { me: bob });
  await h.run('answer', '18');
  const line = lineFrom(h.text());
  assert.match(line, new RegExp(`^Approve wager [0-9a-f]{16}, stake 0\\.0001 ETH, vs ${alice}, settle 2026-10-21T19:00:00Z$`));
  assert.equal(h.created.length, 0);
  await assert.rejects(h.run('answer', '18', '--approval', line.replace(/wager [0-9a-f]{16}/, 'wager deadbeefdeadbeef'), '--yes'), /They changed/);
  await assert.rejects(h.run('answer', '18', '--approval', line.replace(/(wager [0-9a-f]{8})[0-9a-f]{8}/, '$1'), '--yes'), /by 8 hex characters; it needs at least 16 \([0-9a-f]{16}\)/);
  assert.equal(h.created.length, 0);
  await h.run('answer', '18', '--approval', `Yes. ${line}`, '--yes');
  assert.equal(h.created.length, 1);
  const c = h.created[0];
  assert.equal(c.targetHunter, alice); assert.equal(c.procurementMode, 'TARGETED'); assert.equal(c.submissionDeadline, '2026-10-21T19:00:00Z');
  assert.equal(c.publicSubmissions, true); assert.deepEqual(c.juryNodes.map((n) => n.provider), ['OpenAI', 'Anthropic']);
  assert.match(c.description, /^Counter bounty: #18, verified/m); assert.equal(c.workProductType, 'Wager settlement claim');
  assert.match(h.text(), /Posted bounty #26/);
  await assert.rejects(h.run('answer', '18', '--approval', line, '--yes'), /already posted as bounty #26/);
  assert.equal(h.created.length, 1);
  const [folder] = await readdir(path.join(h.dir, 'wagers'));
  assert.equal(JSON.parse(await readFile(path.join(h.dir, 'wagers', folder, 'wager.json'), 'utf8')).bountyId, 26);
});

test('a post that failed before creating anything retries once with the same line', async (t) => {
  const h = await harness(t, { me: bob });
  await h.run('answer', '18');
  const line = lineFrom(h.text()), create = h.create;
  h.create = async () => { throw new Error('Live docs unavailable'); };
  await assert.rejects(h.run('answer', '18', '--approval', line, '--yes'), /Live docs unavailable/);
  h.create = create;
  await h.run('answer', '18', '--approval', line, '--yes');
  assert.match(h.text(), /Retrying the post/);
  assert.equal(h.created.length, 1);
});

test('answer refuses bad counters and never asks for approval', async (t) => {
  for (const n of ['20', '21', '22']) {
    const h = await harness(t, { me: bob });
    await assert.rejects(h.run('answer', n), /failed the counter check/);
    assert.doesNotMatch(h.text(), /Approve wager/);
    assert.deepEqual(await readdir(h.dir).catch(() => []), []);
  }
});

test('one live bounty per Wager ID: an existing twin blocks approval and posting', async (t) => {
  const h = await harness(t, { me: bob, myJobs: [{ jobId: 9, status: 'OPEN', description: fx(19, 'job').job.description }] });
  await assert.rejects(h.run('answer', '18'), /refused/);
  assert.match(h.text(), /Your bounty #9 already uses Wager ID VW-TEST3-BOS-DET-20261020/);
});

test('propose, check the answer, status, claim and close', async (t) => {
  const h = await harness(t, { me: alice });
  const input = path.join(h.dir, 'proposal.json');
  await writeFile(input, JSON.stringify(proposal));
  await h.run('propose', '--input', input);
  const line = lineFrom(h.text());
  await assert.rejects(h.run('propose', '--input', input, '--approval', line.replace('0.0001 ETH', '0.0002 ETH'), '--yes'), /stake 0.0002 ETH/);
  await h.run('propose', '--input', input, '--approval', line, '--yes');
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].description, fx(18, 'job').job.description);
  assert.match(h.text(), /Answer it by number by 2026-10-20T18:50:00Z \(10 minutes before the scheduled start 2026-10-20T19:00:00Z\)/);

  // Bob answers with #19 (REQUIRED style here); alice checks it before kickoff.
  h.logs.length = 0;
  await h.run('check', '19');
  assert.match(h.text(), /checked as the counter to bounty #26[\s\S]*PASS/);
  await assert.rejects(h.run('check', '24'), /failed the counter check/);
  assert.match(h.text(), /"No winner \(this bounty must not pay\):" line differs from yours/);

  h.clock = at('2026-10-20T20:00:00Z'); h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /Counter bounty #19: passed the check/); assert.match(h.text(), /claim\.md can be prepared from 2026-10-20T22:00:00Z; it is submitted about 2 hours after the final \(pass --final-at\), or from 2026-10-21T00:00:00Z without it/);
  const score = ['--score', 'Boston Celtics 110, Detroit Pistons 104 (Final)', '--source', 'NBA.com|https://www.nba.com/game/bos-vs-det|BOS 110 DET 104 FINAL', '--source', 'CBS Sports|https://www.cbssports.com/nba/gametracker/recap/x|Celtics 110 Pistons 104 Final'];
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score), /Too early/);
  h.clock = at('2026-10-20T22:30:00Z'); h.logs.length = 0;
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score);
  const earlyLine = /^ {2}(Approve claim [0-9a-f]{16}, bounty #19)$/m.exec(h.text())[1];
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--approval', earlyLine, '--yes'), /Too early to submit: wait until 2026-10-21T00:00:00/);
  assert.equal(h.submitted.length, 0);
  h.clock = at('2026-10-21T00:30:00Z'); h.logs.length = 0;
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score);
  const record = JSON.parse(await readFile(path.join(h.dir, 'wagers', h.created[0].wager.termsSha256.slice(0, 16), 'wager.json'), 'utf8'));
  const claim = await readFile(path.join(h.dir, 'wagers', record.termsSha256.slice(0, 16), 'claim.md'), 'utf8');
  assert.match(claim, /^MUTUAL WAGER CLAIM \(mutual-wager-v3\)\nWager ID: VW-TEST3-BOS-DET-20261020\nBounty claimed: #19\n/);
  assert.match(claim, /^3\. Counter bounty\nBounty #26\nOn-chain parameters: .*\/api\/jobs\/26\/onchain-status\nTerms, rubric and jury: .*\/api\/jobs\/26\?includeRubric=true\n$/m);
  const claimLine = /^ {2}(Approve claim [0-9a-f]{16}, bounty #19)$/m.exec(h.text())[1];
  assert.equal(claimLine, `Approve claim ${W.sha256(claim).slice(0, 16)}, bounty #19`);
  assert.equal(h.submitted.length, 0);
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--approval', claimLine.replace('#19', '#18'), '--yes'), /Show the owner the current claim/);
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--approval', claimLine, '--yes');
  assert.deepEqual(h.submitted.map(({ jobId, text }) => [jobId, text]), [['19', claim]]);
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--approval', claimLine, '--yes'), /already submitted/);
  assert.equal(h.submitted.length, 1);

  await assert.rejects(h.run('close', record.termsSha256.slice(0, 8)), /can be closed after its deadline 2026-10-21T19:00:00Z/);
  h.clock = at('2026-10-21T19:00:01Z');
  await h.run('close', record.termsSha256.slice(0, 8));
  assert.deepEqual(h.recovered, [{ close: '26' }]);
});

test('check --against audits any posted pair without a wallet', async (t) => {
  const h = await harness(t, { me: undefined });
  await h.run('check', '19', '--against', '18');
  assert.match(h.text(), /PASS/);
  for (const n of ['23', '24', '25']) await assert.rejects(h.run('check', n, '--against', '18'), /failed the counter check/);
});

// ---- Review findings of 2026-10-20 (PR #108): recovery and edge paths ----
const stateOf = async (h) => {
  const [folder] = await readdir(path.join(h.dir, 'wagers'));
  const dir = path.join(h.dir, 'wagers', folder);
  return { dir, record: JSON.parse(await readFile(path.join(dir, 'wager.json'), 'utf8')), state: JSON.parse(await readFile(path.join(dir, 'approved.json.state.json'), 'utf8').catch(() => 'null')) };
};
async function proposeFlow(t) {
  const h = await harness(t, { me: alice });
  const input = path.join(h.dir, 'proposal.json');
  await writeFile(input, JSON.stringify(proposal));
  await h.run('propose', '--input', input);
  return { h, input, line: lineFrom(h.text()) };
}
const score = ['--score', 'Boston Celtics 110, Detroit Pistons 104 (Final)', '--source', 'NBA.com|https://www.nba.com/game/bos-vs-det|BOS 110 DET 104 FINAL', '--source', 'CBS Sports|https://www.cbssports.com/nba/gametracker/recap/x|Celtics 110 Pistons 104 Final'];
const claimLineOf = (text) => /^ {2}(Approve claim [0-9a-f]{16}, bounty #19)$/m.exec(text)[1];
async function readyToClaim(t) {
  const { h, input, line } = await proposeFlow(t);
  await h.run('propose', '--input', input, '--approval', line, '--yes');
  await h.run('check', '19');
  h.clock = at('2026-10-21T00:30:00Z'); h.logs.length = 0;
  return h;
}

test('finding 1: a stalled answer is finished only by wager.js and never funded within 10 minutes of the start', async (t) => {
  const h = await harness(t, { me: bob });
  await h.run('answer', '18');
  const line = lineFrom(h.text());
  h.stall = 'api';
  await assert.rejects(h.run('answer', '18', '--approval', line, '--yes'), /process stopped after the API job/);
  h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /API job 901 created, nothing signed\)\. Finish it: node wager\.js answer 18 --approval "Approve wager [0-9a-f]{16}, stake/);
  assert.doesNotMatch(h.text(), /create_bounty\.js/);
  // Five minutes before the start the same command refuses to sign: the API job stays unfunded.
  h.clock = at('2026-10-20T18:55:00Z');
  await assert.rejects(h.run('answer', '18', '--approval', line, '--yes'), /Not funded: nothing was signed or broadcast[\s\S]*less than 10 minutes away or past/);
  assert.deepEqual(h.broadcasts, []);
  assert.equal(h.created.length, 1);
  h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /never funded, and the scheduled start is too close or past: this wager is off/);
});

test('finding 1: the counter is checked again before a stalled answer is signed', async (t) => {
  const h = await harness(t, { me: bob });
  await h.run('answer', '18');
  const line = lineFrom(h.text());
  h.stall = 'api';
  await assert.rejects(h.run('answer', '18', '--approval', line, '--yes'), /process stopped/);
  h.chain[18] = { ...h.chain[18], status: '2' }; // the first bounty was closed meanwhile
  await assert.rejects(h.run('answer', '18', '--approval', line, '--yes'), /Not funded[\s\S]*Bounty #18 on chain: it is no longer open/);
  assert.deepEqual(h.broadcasts, []);
  h.chain[18] = fx(18, 'rpc');
  h.logs.length = 0;
  await h.run('answer', '18', '--approval', line, '--yes');
  assert.match(h.text(), /Finishing the post of wager [0-9a-f]{8}: API job 901 was created, nothing signed[\s\S]*Posted bounty #26/);
  assert.equal(h.created.length, 1); assert.equal(h.broadcasts.length, 1);
});

test('finding 1: saved signed bytes are not rebroadcast after kickoff; a transaction already sent is still linked', async (t) => {
  const { h, input, line } = await proposeFlow(t);
  h.stall = 'signed';
  await assert.rejects(h.run('propose', '--input', input, '--approval', line, '--yes'), /Broadcast uncertain/);
  const { state } = await stateOf(h);
  assert.equal(state.status, 'BROADCAST_PENDING');
  h.clock = at('2026-10-20T19:05:00Z');
  await assert.rejects(h.run('propose', '--input', input, '--approval', line, '--yes'), /Not funded[\s\S]*2026-10-20T19:00:00Z is less than 10 minutes away or past/);
  assert.deepEqual(h.broadcasts, []);
  // Had the transaction reached the chain anyway, finishing only links it, at any time.
  h.mined.add(state.txHash); h.logs.length = 0;
  await h.run('propose', '--input', input, '--approval', line, '--yes');
  assert.match(h.text(), /Posted bounty #26[\s\S]*linked too close to the scheduled start/);
  assert.equal(h.guarded.length, 1); // only the first, pre-kickoff signing passed the guard
  assert.equal((await stateOf(h)).record.bountyId, 26);
});

test('finding 3: a post finished outside wager.js is read back into wager.json', async (t) => {
  const h = await harness(t, { me: bob });
  await h.run('answer', '18');
  const line = lineFrom(h.text());
  h.stall = 'signed';
  await assert.rejects(h.run('answer', '18', '--approval', line, '--yes'), /Broadcast uncertain/);
  const { dir } = await stateOf(h);
  // As an older skill told the agent: node create_bounty.js --config approved.json --resume approved.json.state.json
  const files = { config: path.join(dir, 'approved.json'), resume: path.join(dir, 'approved.json.state.json') };
  await h.create({ arg: (n) => files[n] ?? null }, { beforeBroadcast: async () => {} });
  h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /Your bounty #26: OPEN/);
  assert.doesNotMatch(h.text(), /Finish it/);
  assert.equal((await stateOf(h)).record.bountyId, 26);
  await assert.rejects(h.run('answer', '18', '--approval', line, '--yes'), /already posted as bounty #26/);
  h.clock = at('2026-10-21T19:00:01Z');
  await h.run('close', '26');
  assert.deepEqual(h.recovered, [{ close: '26' }]);
});

test('finding 4: /jobs/create refusals before anything is signed can be retried with the same line', async (t) => {
  const h = await harness(t, { me: bob });
  await h.run('answer', '18');
  const line = lineFrom(h.text());
  h.apiRefusal = 'WAGER_COUNTER_UNVERIFIED';
  await assert.rejects(h.run('answer', '18', '--approval', line, '--yes'), /HTTP 503 WAGER_COUNTER_UNVERIFIED[\s\S]*Nothing was created or signed \(state kept as .*approved\.json\.state\.stopped-\d+\.json\)\. Re-run the same command with the same line/);
  h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /Approved, not posted\. Finish it: node wager\.js answer 18/);
  h.logs.length = 0;
  await h.run('answer', '18', '--approval', line, '--yes');
  assert.match(h.text(), /Retrying the post[\s\S]*Posted bounty #26/);
  // A state left by a process stopped during /jobs/create (no answer, nothing signed) is set aside the same way.
  const g = await harness(t, { me: bob }), create = g.create;
  await g.run('answer', '18');
  g.create = async () => { throw new Error('killed'); };
  await assert.rejects(g.run('answer', '18', '--approval', line, '--yes'), /killed/); // approval and config saved
  const { dir } = await stateOf(g);
  await writeFile(path.join(dir, 'approved.json.state.json'), JSON.stringify({ status: 'API_CREATE_PENDING' }));
  g.create = create; g.logs.length = 0;
  await g.run('answer', '18', '--approval', line, '--yes');
  assert.match(g.text(), /The last post stopped before anything was created or signed \(API_CREATE_PENDING\)[\s\S]*Posted bounty #26/);
});

test('finding 2: after a failed evaluation a new claim may replace it, prepared and approved again, before the deadline', async (t) => {
  const h = await readyToClaim(t);
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score);
  const firstLine = claimLineOf(h.text());
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--approval', firstLine, '--yes');
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--approval', firstLine, '--yes'), /already submitted as submission 0 and is being evaluated/);
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score), /already submitted as submission 0 and is being evaluated/);
  Object.assign(h.submissions['19/0'], { status: 2n, acceptance: 40n, rejection: 60n }); // the jury failed it
  h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /The jury failed your claim to #19 \(submission 0\)\. Before 2026-10-21T19:00:00Z a new claim may replace it/);
  // The owner's line for the failed claim does not cover a new submission.
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--approval', firstLine, '--yes'), /The last claim failed, and this one was not prepared since/);
  assert.equal(h.submitted.length, 1);
  h.logs.length = 0;
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score);
  assert.match(h.text(), /This is claim 2 for this wager/);
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--approval', claimLineOf(h.text()), '--yes');
  assert.deepEqual(h.submitted.map((s) => s.jobId), ['19', '19']);
  const { dir, record } = await stateOf(h);
  assert.equal(record.claim.submissionId, '1'); assert.equal(record.claim.attempt, 2);
  assert.deepEqual(record.claims.map(({ submissionId, result, acceptance, rejection }) => [submissionId, result, acceptance, rejection]), [['0', 'FAILED', 40, 60]]);
  assert.ok((await readdir(dir)).some((f) => /^claim-submission\.attempt1-\d+\.json$/.test(f)));
  // Past the settlement deadline no new claim is built.
  Object.assign(h.submissions['19/1'], { status: 2n });
  h.clock = at('2026-10-21T19:00:01Z');
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score), /settlement deadline \(2026-10-21T19:00:00Z\) has passed/);
  assert.equal(h.submitted.length, 2);
});

test('finding 5: claim fails closed when your own bounty cannot be read', async (t) => {
  const h = await readyToClaim(t);
  const site = h.records[26], chain = h.chain[26];
  delete h.records[26];
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score), /Could not read your bounty #26 \(site record\)/);
  h.records[26] = site; delete h.chain[26];
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score), /Could not read your bounty #26 \(escrow\)/);
  h.chain[26] = { ...chain, status: '1', winner: bob }; // paid out on chain, site record not caught up
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score), /Your bounty #26 was already paid/);
  assert.equal(h.submitted.length, 0);
  assert.ok(!(await readdir((await stateOf(h)).dir)).includes('claim.md'));
});

// Live testnet 2026-10-21 (#30 by the skill, answered by the native runtime with #31 naming #30): the proposer's check
// must accept an answer that names its bounty, or it can never claim.
test('a proposer checks an answer that names its bounty, then claims it', async (t) => {
  const { h, input, line } = await proposeFlow(t);
  assert.match(h.text(), /The opponent must answer by 2026-10-20T18:50:00Z, 10 minutes before the scheduled start/);
  await h.run('propose', '--input', input, '--approval', line, '--yes'); // alice's #26, Counter line REQUIRED
  h.as(bob);
  await h.run('answer', '26');
  await h.run('answer', '26', '--approval', lineFrom(h.text()), '--yes'); // bob's #27 names #26 with its real times
  assert.match(h.records[27].job.description, /^Counter bounty: #26, verified by the Poster before posting/m);
  h.as(alice);
  await h.run('check', '27');
  assert.match(h.text(), /Bounty #27 checked as the counter to bounty #26 \(0x7ACb[\s\S]*PASS/);
  await h.run('check', '27', '--against', '26');
  h.clock = at('2026-10-21T00:30:00Z'); h.logs.length = 0;
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score);
  const claimLine = /^ {2}(Approve claim [0-9a-f]{16}, bounty #27)$/m.exec(h.text())[1];
  assert.match(h.text(), /^Bounty claimed: #27$/m);
  assert.match(h.text(), /^3\. Counter bounty\nBounty #26 \(named in the terms\)\.$/m);
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--approval', claimLine, '--yes');
  assert.deepEqual(h.submitted.map((s) => s.jobId), ['27']);
});

test('a proposer still refuses an answer that names some other bounty', async (t) => {
  const { h, input, line } = await proposeFlow(t);
  await h.run('propose', '--input', input, '--approval', line, '--yes'); // alice's #26
  h.as(bob);
  await h.run('answer', '18'); // the same terms, posted earlier as #18
  await h.run('answer', '18', '--approval', lineFrom(h.text()), '--yes'); // bob's #27 names #18, not #26
  h.as(alice);
  await assert.rejects(h.run('check', '27'), /failed the counter check/);
  assert.match(h.text(), /FAIL: Bounty #27: its Counter bounty line names #18, not your bounty #26\./);
  await assert.rejects(h.run('check', '27', '--against', '26'), /failed the counter check/);
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score), /No checked counter bounty/);
});

// ---- Question wagers (mutual-wager-v4): the same verbs, with the question's args and times ----
const question = {
  kind: 'question', wagerId: 'VQ-TEST-AAPL-20261022', question: 'Will Apple (AAPL) close above $250.00 on 2026-10-22?',
  betsClose: '2026-10-22T13:00:00Z', resolvesAt: '2026-10-22T20:00:00Z',
  yes: 'the official closing price of AAPL on 2026-10-22 is above $250.00', no: 'the official closing price of AAPL on 2026-10-22 is $250.00 or below',
  sources: ['https://stockanalysis.com/stocks/aapl/history/'], side: 'NO', stake: '0.0001', settle: '2026-10-23T22:00:00Z', opponent: bob,
};
const closeSources = (value) => ['--source', `StockAnalysis|https://stockanalysis.com/stocks/aapl/history/|Oct 22, 2026 248.10 252.40 247.95 ${value}`,
  '--source', `Investing.com|https://www.investing.com/equities/apple-computer-inc-historical-data|10/22/2026 ${value} 248.10 252.40 247.95`];
const answerNo = ['--answer', 'NO', '--value', '$249.80', '--as-of', '2026-10-22T20:00:00Z', ...closeSources('249.80')];
// alice offers NO as #26, bob answers YES as #27 naming #26, alice checks it.
async function questionPair(t) {
  const h = await harness(t, { me: alice, clock: at('2026-10-22T11:00:00Z') });
  const input = path.join(h.dir, 'question.json');
  await writeFile(input, JSON.stringify(question));
  await h.run('propose', '--input', input);
  await h.run('propose', '--input', input, '--approval', lineFrom(h.text()), '--yes');
  h.as(bob);
  await h.run('answer', '26');
  await h.run('answer', '26', '--approval', lineFrom(h.text()), '--yes');
  h.as(alice);
  await h.run('check', '27');
  return { h, input };
}

test('question: propose posts the shared builder\'s bytes; the answer mirrors them; check passes', async (t) => {
  const h = await harness(t, { me: alice, clock: at('2026-10-22T11:00:00Z') });
  const input = path.join(h.dir, 'question.json');
  await writeFile(input, JSON.stringify(question));
  await h.run('propose', '--input', input);
  const line = lineFrom(h.text());
  assert.match(line, new RegExp(`^Approve wager [0-9a-f]{16}, stake 0\\.0001 ETH, vs ${bob}, settle 2026-10-23T22:00:00Z$`));
  assert.match(h.text(), /The opponent must answer by 2026-10-22T12:50:00Z, 10 minutes before the Bets close time 2026-10-22T13:00:00Z/);
  await h.run('propose', '--input', input, '--approval', line, '--yes');
  const shared = W.shared.proposeMutualWager({ ...question, creator: alice, classId: 128, threshold: 80, jury: W.WAGER_DEFAULTS.jury, iterations: 1, oracle: W.WAGER_DEFAULTS.oracle }, W.siteContext({ network: 'base-sepolia', origin: 'https://bounties-testnet.verdikta.org', deployment: { address: '0x1B4F0e43256d435DfcD5C0883799F0Eb3943e08f', chainId: 84532 } }));
  const c = h.created[0];
  assert.equal(c.description, shared.description); assert.equal(c.description, qfx('job', 40).description); assert.equal(c.title, shared.title);
  assert.deepEqual(c.rubricJson, W.wagerRubricJson('question')); assert.equal(c.submissionDeadline, '2026-10-23T22:00:00Z'); assert.equal(c.targetHunter, bob);
  assert.match(h.text(), /Answer it by number by 2026-10-22T12:50:00Z \(10 minutes before the Bets close time 2026-10-22T13:00:00Z\): with the Verdikta onboarding skill, node wager\.js answer 26; on the website, the Question Wager template's answer field takes #26/);
  h.as(bob);
  await h.run('answer', '26');
  assert.match(h.text(), new RegExp(`Note: The question, its "YES wins if" / "NO wins if" lines and its Resolution sources are the offer's, written by ${alice}`));
  await h.run('answer', '26', '--approval', lineFrom(h.text()), '--yes');
  assert.match(h.created[1].description, /^Counter bounty: #26, verified by the Poster before posting \(.*created 2026-10-22T11:00:00\.000Z, deadline 2026-10-23T22:00:00\.000Z/m);
  assert.match(h.created[1].description, /^Poster \(creator\): 0x75fAc210bF1Dcd0BA3FaC294de7c50C5763Da6d9; side: YES wins\.$/m);
  assert.match(h.text(), /From Claims open \(2026-10-22T22:00:00Z\), the side the answer makes win claims the other bounty/);
  h.as(alice);
  await h.run('check', '27');
  assert.match(h.text(), /Bounty #27 checked as the counter to bounty #26[\s\S]*PASS/);
  await h.run('check', '27', '--against', '26');
  // The game keys on a question are refused, and nothing is saved.
  const g = await harness(t, { me: alice, clock: at('2026-10-22T11:00:00Z') });
  const bad = path.join(g.dir, 'bad.json');
  await writeFile(bad, JSON.stringify({ ...question, event: 'x', start: question.betsClose }));
  await assert.rejects(g.run('propose', '--input', bad), /proposal input has problems/);
  assert.match(g.text(), /Not question-wager fields: event, start\. event, start belong to a game wager/);
  assert.deepEqual((await readdir(g.dir)).filter((f) => f !== 'bad.json'), []);
});

test('question: status follows Bets close, Resolves at and Claims open; claim refuses before Claims open', async (t) => {
  const { h } = await questionPair(t);
  h.clock = at('2026-10-22T14:00:00Z'); h.logs.length = 0;
  await h.run('status');
  const text = h.text();
  assert.match(text, /VQ-TEST-AAPL-20261022  proposer  vs 0x75fA…a6d9  stake 0\.0001 ETH  bets close 2026-10-22T13:00:00Z  settle 2026-10-23T22:00:00Z/);
  assert.match(text, /^ {2}Question: Will Apple \(AAPL\) close above \$250\.00 on 2026-10-22\?$/m);
  assert.match(text, /^ {2}YES wins if: the official closing price of AAPL on 2026-10-22 is above \$250\.00\.$/m);
  assert.match(text, /^ {2}NO wins if: the official closing price of AAPL on 2026-10-22 is \$250\.00 or below\.$/m);
  assert.match(text, /^ {2}Your side: NO wins$/m);
  assert.match(text, /^ {2}Resolution sources: https:\/\/stockanalysis\.com\/stocks\/aapl\/history\/$/m);
  assert.match(text, /^ {2}Bets close 2026-10-22T13:00:00Z, resolves at 2026-10-22T20:00:00Z, claims open 2026-10-22T22:00:00Z, settlement deadline 2026-10-23T22:00:00Z$/m);
  assert.match(text, /Counter bounty #27: passed the check/);
  assert.match(text, /Next: Bets are closed; the question resolves at 2026-10-22T20:00:00Z\. If the answer makes your side \(NO wins\) win, claim\.md can be prepared from Claims open, 2026-10-22T22:00:00Z\./);
  h.clock = at('2026-10-22T21:00:00Z'); h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /Next: The question resolved at 2026-10-22T20:00:00Z; claims open at 2026-10-22T22:00:00Z, once the sources show the final value/);
  // Resolved, Claims open not yet: no claim.md, nothing saved.
  await assert.rejects(h.run('claim', 'VQ-TEST-AAPL-20261022', ...answerNo), /Too early: claims open at 2026-10-22T22:00:00Z/);
  // A game's score on a question names the shape it needs.
  h.clock = at('2026-10-22T22:30:00Z');
  await assert.rejects(h.run('claim', 'VQ-TEST-AAPL-20261022', '--score', 'AAPL 250, LINE 249 (Final)', ...closeSources('249.80')), /Bounty #27 is a question wager \(mutual-wager-v4\): claim it with --answer YES\|NO/);
  await assert.rejects(h.run('claim', 'VQ-TEST-AAPL-20261022'), /--answer, --value, --as-of and two --source entries are required/);
  const { dir } = await stateOf(h);
  assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith('claim')), []);
  h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /Next: If the answer makes your side \(NO wins\) win: node wager\.js claim [0-9a-f]{8} --answer YES\|NO --value "\.\.\." --as-of <ISO> --source "Name\|URL\|quote" --source "\.\.\."/);
});

test('question: claim.md is the shared buildQuestionClaim text, approved and submitted unchanged; then close', async (t) => {
  const { h } = await questionPair(t);
  h.clock = at('2026-10-22T22:30:00Z'); h.logs.length = 0;
  await h.run('claim', 'VQ-TEST-AAPL-20261022', ...answerNo);
  const { dir, record } = await stateOf(h);
  const claim = await readFile(path.join(dir, 'claim.md'), 'utf8');
  const terms = W.shared.parseMutualWagerTerms(h.records[27].job.description);
  const shared = W.shared.buildQuestionClaim({ terms, bounty: 27, counter: 26, answer: 'NO', value: '$249.80', asOf: '2026-10-22T20:00:00Z',
    sources: W.parseSources([answerNo[7], answerNo[9]]), site: 'https://bounties-testnet.verdikta.org', now: h.clock });
  assert.deepEqual(shared.problems, []);
  assert.equal(claim, shared.claim);
  assert.match(claim, /^MUTUAL WAGER CLAIM \(mutual-wager-v4\)\nWager ID: VQ-TEST-AAPL-20261022\nBounty claimed: #27\n/);
  assert.match(claim, /^Value: \$249\.80, for 2026-10-22T20:00:00Z\nAnswer: NO\. NO wins if: the official closing price of AAPL on 2026-10-22 is \$250\.00 or below\.$/m);
  assert.ok(claim.endsWith('3. Counter bounty\nBounty #26 (named in the terms).\n'));
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'claim-input.json'), 'utf8')), { answer: 'NO', value: '$249.80', asOf: '2026-10-22T20:00:00Z', sources: [answerNo[7], answerNo[9]], attempt: 1 });
  const claimLine = /^ {2}(Approve claim [0-9a-f]{16}, bounty #27)$/m.exec(h.text())[1];
  assert.equal(claimLine, `Approve claim ${W.sha256(claim).slice(0, 16)}, bounty #27`);
  assert.match(h.text(), /Submitting prepays the evaluation fee\. Submit it by 2026-10-23T21:45:00\.000Z, 15 minutes before the deadline\./);
  assert.equal(h.submitted.length, 0);
  await assert.rejects(h.run('claim', 'VQ-TEST-AAPL-20261022', '--approval', claimLine.replace('#27', '#26'), '--yes'), /Show the owner the current claim/);
  await h.run('claim', 'VQ-TEST-AAPL-20261022', '--approval', claimLine, '--yes');
  assert.deepEqual(h.submitted.map(({ jobId, text }) => [jobId, text]), [['27', claim]]);
  // A failed evaluation: the next claim needs a fresh preview and the owner's new line, in the question's shape.
  Object.assign(h.submissions['27/0'], { status: 2n, acceptance: 30n, rejection: 70n });
  h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /The jury failed your claim to #27 \(submission 0\)\. Before 2026-10-23T22:00:00Z a new claim may replace it: node wager\.js claim [0-9a-f]{8} --answer YES\|NO --value "\.\.\." --as-of <ISO>/);
  await assert.rejects(h.run('claim', 'VQ-TEST-AAPL-20261022', '--approval', claimLine, '--yes'), /this one was not prepared since\. Run node wager\.js claim [0-9a-f]{8} --answer \.\.\. --value \.\.\. --as-of \.\.\. --source \.\.\. --source \.\.\. without --approval/);
  await assert.rejects(h.run('close', record.termsSha256.slice(0, 8)), /can be closed after its deadline 2026-10-23T22:00:00Z/);
  h.clock = at('2026-10-23T22:00:01Z');
  await h.run('close', record.termsSha256.slice(0, 8));
  assert.deepEqual(h.recovered, [{ close: '26' }]);
});

test('question: the answerer claims the REQUIRED offer, citing its own bounty by URL', async (t) => {
  const { h } = await questionPair(t);
  h.as(bob); h.clock = at('2026-10-22T22:30:00Z');
  const answerYes = ['--answer', 'YES', '--value', '$251.20', '--as-of', '2026-10-22T20:00:00Z', ...closeSources('251.20')];
  await assert.rejects(h.run('claim', 'VQ-TEST-AAPL-20261022', ...answerNo), /By your answer NO wins, so the Claimant's side \(YES wins\) did not/);
  h.logs.length = 0;
  await h.run('claim', 'VQ-TEST-AAPL-20261022', ...answerYes);
  assert.match(h.text(), /^Bounty claimed: #26$/m);
  assert.match(h.text(), /^3\. Counter bounty\nBounty #27\nOn-chain parameters: .*\/api\/jobs\/27\/onchain-status\nTerms, rubric and jury: .*\/api\/jobs\/27\?includeRubric=true$/m);
  await h.run('claim', 'VQ-TEST-AAPL-20261022', '--approval', /^ {2}(Approve claim [0-9a-f]{16}, bounty #26)$/m.exec(h.text())[1], '--yes');
  assert.deepEqual(h.submitted.map((s) => s.jobId), ['26']);
});

test('a game claim given in the question shape names the shape it needs', async (t) => {
  const h = await readyToClaim(t);
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--answer', 'YES', '--value', '110', '--as-of', '2026-10-21T00:00:00Z', ...score.slice(2)),
    /Bounty #19 is a game wager \(mutual-wager-v3\): claim it with --score "<Team> <points>, <Team> <points> \(Final\)"/);
  assert.equal(h.submitted.length, 0);
});

// Mainnet #253/#301: the opponent's rejected claims, never finalized, block closeExpiredBounty.
test('status and close tell the owner a close clears pending claims first', async (t) => {
  const { h, input, line } = await proposeFlow(t);
  await h.run('propose', '--input', input, '--approval', line, '--yes'); // alice's #26
  await h.run('check', '19');
  h.clock = at('2026-10-21T19:00:01Z'); h.pending[26] = [0, 1, 2, 3, 4]; h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /Next: The deadline passed: reclaim your stake with node wager\.js close [0-9a-f]{8} \(it first finalizes or fails the 5 claims still pending on your bounty #26, gas only; a claim that passed or is still being evaluated stops it\)/);
  h.pending[26] = []; h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /Next: The deadline passed: reclaim your stake with node wager\.js close [0-9a-f]{8}$/m);
  h.logs.length = 0;
  await h.run('close', '26');
  assert.match(h.text(), /Claims still pending on it are finalized or failed first \(gas only, covered by this close\)/);
  assert.deepEqual(h.recovered, [{ close: '26' }]);
});
