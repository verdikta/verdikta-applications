import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';
import { checkWorkOrderResult } from '../_work-order-result.js';
import { runSubmit } from '../submit_to_bounty.js';
import { iface, deployments, verifyTransaction } from '../_transaction-guards.js';
import { composeEvaluationDescription } from '../../../verdikta-discover/scripts/work-order.mjs';

const discover = new URL('../../../verdikta-discover/', import.meta.url);
const example = async name => JSON.parse(await readFile(new URL(`examples/${name}`, discover), 'utf8'));
const d = deployments.base, cid = 'Qm' + 'a'.repeat(44), hunterCid = 'Qm' + 'b'.repeat(44), hash = '0x' + '1'.repeat(64);
const wallet = new Wallet('0x' + '11'.repeat(32)), creator = wallet.address, target = '0x2222222222222222222222222222222222222222';
const json = x => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
const log = (name, args) => ({ address: d.address, ...iface.encodeEventLog(iface.getEvent(name), args) });
const policy = { maxValueWei: '2000000000000000', maxTotalWei: '5000000000000000', maxGasLimit: '500000', maxFeePerGasWei: '2', maxPriorityFeePerGasWei: '1' };

/** A committed work order for each template, with a result that matches it and one that does not. */
async function workOrder(kind) {
  const request = { ...(await example(`${kind}.request.json`)), fixture_only: false, task_id: `${kind}-wo` };
  const { description, requestDigest } = composeEvaluationDescription({ baseDescription: 'Owner text', draftSha256: 'a'.repeat(64), templateId: kind, request });
  const fixture = await example(`${kind}.result.json`);
  // A real result cannot cite synthetic fixtures: the examples' sources become buyer-provided corpus entries.
  const good = { ...fixture, fixture_only: false, task_id: request.task_id, input_sha256: requestDigest, ...(fixture.sources ? { sources: fixture.sources.map(s => ({ ...s, provenance: 'BUYER_PROVIDED' })) } : {}) };
  const bad = { ...good, input_sha256: '0'.repeat(64) };
  return { description, good, bad, requestDigest };
}

test('checkWorkOrderResult: no work order means nothing to check; a work order needs a matching result.json', async t => {
  const dir = await mkdtemp(`${tmpdir()}/verdikta-wo-check-`); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await checkWorkOrderResult({ description: 'A plain bounty.', files: [`${dir}/anything.md`] }), { workOrder: false, templateId: null, errors: [] });
  for (const kind of ['source-check-v1', 'evidence-pack-v1', 'review-v1', 'real-world-task-v1']) {
    const { description, good, bad } = await workOrder(kind);
    const resultFile = `${dir}/result.json`, evidence = `${dir}/evidence.md`;
    await writeFile(evidence, '# evidence');
    await writeFile(resultFile, JSON.stringify(good));
    const ok = await checkWorkOrderResult({ description, files: [resultFile, evidence] });
    assert.deepEqual(ok, { workOrder: true, templateId: kind, errors: [] }, kind);
    await writeFile(resultFile, JSON.stringify(bad));
    const digest = await checkWorkOrderResult({ description, files: [resultFile, evidence] });
    assert.ok(digest.errors.some(e => /digest/.test(e)), `${kind}: ${digest.errors}`);
    const missing = await checkWorkOrderResult({ description, files: [evidence] });
    assert.match(missing.errors[0], /needs a result\.json/);
    await writeFile(resultFile, '{not json');
    assert.match((await checkWorkOrderResult({ description, files: [resultFile] })).errors[0], /not valid JSON/);
    await writeFile(resultFile, JSON.stringify({ ...good, fixture_only: true }));
    assert.ok((await checkWorkOrderResult({ description, files: [resultFile] })).errors.length, `${kind}: a fixture-only result is refused`);
    const corrupted = description.replace('"task_id":"', '"task_id":"x');
    assert.ok((await checkWorkOrderResult({ description: corrupted, files: [resultFile] })).errors.some(e => /bounty description/.test(e)));
  }
});

test('submit_to_bounty refuses to upload a failing work-order result and uploads a passing one', async t => {
  const dir = await mkdtemp(`${tmpdir()}/verdikta-wo-submit-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const { description, good, bad } = await workOrder('review-v1');
  const resultFile = `${dir}/result.json`, evidence = `${dir}/evidence.md`;
  await writeFile(evidence, '# evidence');
  const bounty = { evaluationCid: cid, targetHunter: creator };
  const transaction = { to: d.address, chainId: d.chainId, value: '0', data: iface.encodeFunctionData('prepareSubmission', [7, cid, hunterCid]) };
  function harness(args) {
    const sent = [];
    const provider = { destroy() {}, getTransaction: async () => null, getTransactionReceipt: async () => null };
    const w = { address: creator, connect() { return { ...this, provider }; } };
    const lib = { arg: n => args[n] ?? null, argAll: n => args[n] || [], getNetwork: () => 'base', providerFor: () => provider, loadWallet: async () => w, loadApiKey: async () => 'mock',
      preflightDeployment: async () => d.address, loadSpendPolicy: async () => policy, isDryRun: () => false, confirmSpendOrExit: async () => {},
      sendTx: async (signer, method, tx, opts) => { verifyTransaction(tx, { network: 'base', method, args: opts.args, value: opts.exactValueWei ?? 0n, maxValueWei: policy.maxValueWei }); await opts.onSigned?.({ hash }); sent.push(method);
        return { status: 1, hash, logs: [log('SubmissionPrepared', [7, 0, creator, target, 100n, cid])] }; } };
    return { lib, sent };
  }
  let uploads = 0;
  const env = { baseUrl: 'https://mock.invalid', pause: async () => {}, contract: () => ({ getBounty: async () => bounty, isAcceptingSubmissions: async () => true, getSubmission: async () => ({ hunter: creator, hunterCid }), nextAction: async () => 'AWAIT_CREATOR', requiredPrepay: async () => 123n }),
    fetchApi: async url => {
      if (url.endsWith('/7')) return json({ job: { jobId: 7, onChain: true, evaluationCid: cid, description } });
      if (url.endsWith('/validate')) return json({ valid: true });
      if (url.endsWith('/submit')) { uploads++; return json({ submission: { hunterCid } }); }
      if (url.endsWith('/prepare')) return json({ transaction });
      if (url.endsWith('/confirm')) return json({ success: true });
      throw Error(url);
    } };
  await writeFile(resultFile, JSON.stringify(bad));
  const failing = harness({ jobId: '7', file: [resultFile, evidence], state: `${dir}/state-bad.json` });
  await assert.rejects(runSubmit(failing.lib, env), /Work-order result check failed \(review-v1\).*digest/);
  assert.equal(uploads, 0, 'nothing is uploaded when the check fails'); assert.deepEqual(failing.sent, []);
  await writeFile(resultFile, JSON.stringify(good));
  const passing = harness({ jobId: '7', file: [resultFile, evidence], state: `${dir}/state-good.json` });
  await runSubmit(passing.lib, env);
  assert.equal(uploads, 1); assert.deepEqual(passing.sent, ['prepareSubmission']);
});
