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
const current = (job) => ({ ...job, rubricContent: { ...job.rubricContent, criteria: job.rubricContent.criteria.map((c) => (c.id === 'counter_bounty_terms' ? { ...c, description: template.criteria.find((x) => x.id === c.id).description } : c)) } });

async function harness(t, { me, clock = at('2026-10-20T18:00:00Z'), myJobs = [] } = {}) {
  const dir = await mkdtemp(`${tmpdir()}/verdikta-wager-test-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const logs = [], created = [], recovered = [], submitted = [];
  const records = {}, chain = {};
  for (let n = 18; n <= 25; n++) { records[n] = { status: fx(n, 'status'), job: current(fx(n, 'job').job) }; chain[n] = fx(n, 'rpc'); }
  const h = { dir, logs, created, recovered, submitted, records, chain, clock, myJobs, nextId: 26 };
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
  h.contract = () => ({ getBounty: async (n) => { if (!chain[n]) throw new Error('bad id'); return chain[n]; } });
  // create_bounty.js stand-in: checks the config it is handed, then writes the linked state like the real one.
  h.create = async (lib) => {
    const file = lib.arg('config'), config = JSON.parse(await readFile(file, 'utf8'));
    creationTerms(config); created.push(config);
    const id = h.nextId++, deadline = config.submissionDeadline;
    await writeFile(`${file}.state.json`, JSON.stringify({ linkedJobId: id, txHash: `0x${'ab'.repeat(32)}`, status: 'BROADCAST' }));
    records[id] = { status: { ...fx(18, 'status'), bountyId: id, creator: me, targetHunter: config.targetHunter, createdAt: h.clock, createdAtIso: new Date(h.clock * 1000).toISOString(), submissionDeadline: deadline, submissionDeadlineIso: new Date(deadline * 1000).toISOString() }, job: { ...current(fx(18, 'job').job), jobId: id, description: config.description, title: config.title } };
    chain[id] = { ...fx(18, 'rpc'), creator: me, targetHunter: config.targetHunter, createdAt: String(h.clock), submissionDeadline: String(deadline) };
  };
  h.recover = async (lib, opts) => { recovered.push(opts); return { hash: `0x${'cd'.repeat(32)}` }; };
  // submit_to_bounty.js stand-in: records what it would upload and writes its state like the real one (wx).
  h.submit = async (lib) => {
    const state = lib.arg('state');
    await writeFile(state, JSON.stringify({ jobId: lib.arg('jobId'), submissionId: '0' }), { flag: 'wx' });
    submitted.push({ jobId: lib.arg('jobId'), files: lib.argAll('file'), text: await readFile(lib.argAll('file')[0], 'utf8') });
  };
  h.run = (...argv) => runWager(h.lib, { argv, fetchApi: h.fetchApi, contract: h.contract, now: () => h.clock, log: (l) => logs.push(l), secretsDir: dir, create: h.create, recover: h.recover, submit: h.submit });
  h.text = () => logs.join('\n');
  return h;
}
const lineFrom = (text) => /^ {2}(Approve wager .*)$/m.exec(text)[1];
const proposal = {
  wagerId: 'VW-TEST3-BOS-DET-20261020', event: 'NBA 2026-27 regular season: Boston Celtics (BOS) at Detroit Pistons (DET), Little Caesars Arena, Detroit, Michigan.',
  shortEvent: 'Celtics @ Pistons', start: '2026-10-20T19:00:00Z', settle: '2026-10-21T19:00:00Z', stake: '0.0001',
  mySide: { label: 'the Boston Celtics win', short: 'the Celtics' }, opponent: { wallet: bob, label: 'the Detroit Pistons win', short: 'the Pistons' },
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
  assert.equal(c.targetHunter, alice); assert.equal(c.procurementMode, 'TARGETED'); assert.equal(c.submissionDeadline, at('2026-10-21T19:00:00Z'));
  assert.match(c.description, /^Counter bounty: #18, verified/m); assert.equal(c.workProductType, 'Wager settlement claim');
  assert.match(h.text(), /Posted bounty #26/);
  await assert.rejects(h.run('answer', '18', '--approval', line, '--yes'), /already approved and posting started/);
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
  h.clock = at('2026-10-21T00:30:00Z'); h.logs.length = 0;
  await h.run('claim', 'VW-TEST3-BOS-DET-20261020', ...score);
  const record = JSON.parse(await readFile(path.join(h.dir, 'wagers', h.created[0].wager.termsSha256.slice(0, 16), 'wager.json'), 'utf8'));
  const claim = await readFile(path.join(h.dir, 'wagers', record.termsSha256.slice(0, 16), 'claim.md'), 'utf8');
  assert.match(claim, /^MUTUAL WAGER CLAIM \(mutual-wager-v3\)\nWager ID: VW-TEST3-BOS-DET-20261020\nBounty claimed: #19\n/);
  assert.match(claim, /^Bounty #26\nOn-chain parameters: .*\/api\/jobs\/26\/onchain-status\n {2}creator 0x7ACb/m);
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
