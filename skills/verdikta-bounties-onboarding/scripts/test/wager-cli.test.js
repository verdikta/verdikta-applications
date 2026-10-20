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
  // stall: 'api' stops after the API job exists, 'signed' after signing (transport lost); apiRefusal: /jobs/create answers 503 with that code.
  const h = { dir, logs, created, recovered, submitted, broadcasts, guarded, records, chain, submissions, mined, clock, myJobs, nextId: 26, nextSubmission: 0, stall: null, apiRefusal: null };
  h.lib = {
    getNetwork: () => 'base-sepolia', walletAddress: async () => me, loadApiKey: async () => 'test-key', loadSpendPolicy: async () => policy,
    loadWallet: async () => ({ address: me }), providerFor: () => ({ getNetwork: async () => ({ chainId: 84532n }), destroy() {} }),
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
    records[id] = { status: { ...fx(18, 'status'), bountyId: id, creator: me, targetHunter: config.targetHunter, createdAt: h.clock, createdAtIso: new Date(h.clock * 1000).toISOString(), submissionDeadline: deadline, submissionDeadlineIso: new Date(deadline * 1000).toISOString() }, job: { ...current(fx(18, 'job').job), jobId: id, description: config.description, title: config.title } };
    chain[id] = { ...fx(18, 'rpc'), creator: me, targetHunter: config.targetHunter, createdAt: String(h.clock), submissionDeadline: String(deadline) };
  };
  h.recover = async (lib, opts) => { recovered.push(opts); return { hash: `0x${'cd'.repeat(32)}` }; };
  // submit_to_bounty.js stand-in: records what it would upload and writes its state like the real one (wx); the
  // escrow then holds the submission, being evaluated.
  h.submit = async (lib) => {
    const state = lib.arg('state'), id = String(h.nextSubmission++);
    await writeFile(state, JSON.stringify({ jobId: lib.arg('jobId'), submissionId: id }), { flag: 'wx' });
    submissions[`${lib.arg('jobId')}/${id}`] = { hunter: me, status: 1n, acceptance: 0n, rejection: 0n };
    submitted.push({ jobId: lib.arg('jobId'), files: lib.argAll('file'), text: await readFile(lib.argAll('file')[0], 'utf8') });
  };
  h.run = (...argv) => runWager(h.lib, { argv, fetchApi: h.fetchApi, contract: h.contract, now: () => h.clock, log: (l) => logs.push(l), secretsDir: dir, create: h.create, recover: h.recover, submit: h.submit });
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
  assert.match(line, new RegExp(`^Approve wager [0-9a-f]{8}, stake 0\\.0001 ETH, vs ${alice}, settle 2026-10-21T19:00:00Z$`));
  assert.equal(h.created.length, 0);
  await assert.rejects(h.run('answer', '18', '--approval', line.replace(/wager [0-9a-f]{8}/, 'wager deadbeef'), '--yes'), /They changed/);
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
  assert.match(h.text(), /Answer it by number before 2026-10-20T19:00:00Z/);

  // Bob answers with #19 (REQUIRED style here); alice checks it before kickoff.
  h.logs.length = 0;
  await h.run('check', '19');
  assert.match(h.text(), /checked as the counter to bounty #26[\s\S]*PASS/);
  await assert.rejects(h.run('check', '24'), /failed the counter check/);
  assert.match(h.text(), /"No winner \(this bounty must not pay\):" line differs from yours/);

  h.clock = at('2026-10-20T20:00:00Z'); h.logs.length = 0;
  await h.run('status');
  assert.match(h.text(), /Counter bounty #19: passed the check/); assert.match(h.text(), /claim from 2026-10-20T22:00:00Z/);
  const score = ['--score', 'Boston Celtics 110, Detroit Pistons 104 (Final)', '--source', 'NBA.com|https://www.nba.com/game/bos-vs-det|BOS 110 DET 104 FINAL', '--source', 'CBS Sports|https://www.cbssports.com/nba/gametracker/recap/x|Celtics 110 Pistons 104 Final'];
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score), /Too early/);
  h.clock = at('2026-10-20T22:30:00Z'); h.logs.length = 0;
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score);
  const earlyLine = /^ {2}(Approve claim [0-9a-f]{8}, bounty #19)$/m.exec(h.text())[1];
  await assert.rejects(h.run('claim', 'VW-TEST3-BOS-DET-20261020', '--approval', earlyLine, '--yes'), /Too early to submit: wait until 2026-10-21T00:00:00/);
  assert.equal(h.submitted.length, 0);
  h.clock = at('2026-10-21T00:30:00Z'); h.logs.length = 0;
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score);
  const record = JSON.parse(await readFile(path.join(h.dir, 'wagers', h.created[0].wager.termsSha256.slice(0, 16), 'wager.json'), 'utf8'));
  const claim = await readFile(path.join(h.dir, 'wagers', record.termsSha256.slice(0, 16), 'claim.md'), 'utf8');
  assert.match(claim, /^MUTUAL WAGER CLAIM \(mutual-wager-v3\)\nWager ID: VW-TEST3-BOS-DET-20261020\nBounty claimed: #19\n/);
  assert.match(claim, /^3\. Counter bounty\nBounty #26\nOn-chain parameters: .*\/api\/jobs\/26\/onchain-status\nTerms, rubric and jury: .*\/api\/jobs\/26\?includeRubric=true\n$/m);
  const claimLine = /^ {2}(Approve claim [0-9a-f]{8}, bounty #19)$/m.exec(h.text())[1];
  assert.equal(claimLine, `Approve claim ${W.sha256(claim).slice(0, 8)}, bounty #19`);
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
const claimLineOf = (text) => /^ {2}(Approve claim [0-9a-f]{8}, bounty #19)$/m.exec(text)[1];
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
  assert.match(h.text(), /API job 901 created, nothing signed\)\. Finish it: node wager\.js answer 18 --approval "Approve wager [0-9a-f]{8}, stake/);
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
