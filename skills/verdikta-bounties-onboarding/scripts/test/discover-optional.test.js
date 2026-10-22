// The onboarding skill installed alone (no sibling verdikta-discover): plain and wager submissions work, a work-order
// submission stops before any upload, and the work-order pre-check never misses a description the parser accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, cp, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';
import { checkWorkOrderResult, looksLikeWorkOrder, WORK_ORDER_MARKERS } from '../_work-order-result.js';
import { iface, deployments, verifyTransaction } from '../_transaction-guards.js';
import { composeEvaluationDescription, parseWorkOrderDescription } from '../../../verdikta-discover/scripts/work-order.mjs';

const scripts = fileURLToPath(new URL('..', import.meta.url));
const discover = new URL('../../../verdikta-discover/', import.meta.url);
const TEMPLATES = ['source-check-v1', 'evidence-pack-v1', 'review-v1', 'real-world-task-v1'];
const realDescription = async (kind) => {
  const request = { ...JSON.parse(await readFile(new URL(`examples/${kind}.request.json`, discover), 'utf8')), fixture_only: false, task_id: `${kind}-wo` };
  return composeEvaluationDescription({ baseDescription: 'Owner text', draftSha256: 'a'.repeat(64), templateId: kind, request }).description;
};
const wagerDescriptions = async () => {
  const dir = new URL('./fixtures/wager-testnet/', import.meta.url);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.job.json'));
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(new URL(n, dir), 'utf8')).job.description));
};

test('the work-order pre-check matches every real template description, and every description the parser accepts', async () => {
  for (const kind of TEMPLATES) {
    const description = await realDescription(kind);
    assert.ok(parseWorkOrderDescription(description), kind);
    assert.equal(looksLikeWorkOrder(description), true, kind);
    // Each marker is one composeEvaluationDescription writes (the strings are in step with the sibling).
    for (const marker of WORK_ORDER_MARKERS) assert.match(description, marker, `${kind}: ${marker}`);
    // Variants: CRLF line ends, each single line removed, the work-order lines only. Whenever the parser accepts one,
    // the pre-check does too; and any single marker line on its own is enough to send it to the parser.
    const lines = description.split('\n');
    const variants = [description.replace(/\n/g, '\r\n'), lines.slice(-6).join('\n'), ...lines.map((_, i) => lines.filter((__, j) => j !== i).join('\n'))];
    for (const v of variants) if (parseWorkOrderDescription(v)) assert.equal(looksLikeWorkOrder(v), true, `${kind} variant`);
    for (const marker of WORK_ORDER_MARKERS) {
      const only = lines.filter((l) => marker.test(l) || !WORK_ORDER_MARKERS.some((m) => m.test(l))).join('\n');
      assert.equal(looksLikeWorkOrder(only), true, `${kind}: ${marker} alone`);
    }
  }
  for (const description of [...await wagerDescriptions(), 'A plain bounty.', '', null, undefined]) assert.equal(looksLikeWorkOrder(description), false);
});

test('checkWorkOrderResult loads the sibling only for a work order, and fails closed when it is missing', async () => {
  const loads = [], missing = async (url) => { loads.push(url); throw Object.assign(new Error(`Cannot find module '${fileURLToPath(url)}'`), { code: 'ERR_MODULE_NOT_FOUND' }); };
  for (const description of await wagerDescriptions()) assert.deepEqual(await checkWorkOrderResult({ description, files: ['claim.md'], loadModule: missing }), { workOrder: false, templateId: null, errors: [] });
  assert.deepEqual(loads, []);
  const workOrder = await realDescription('review-v1');
  await assert.rejects(checkWorkOrderResult({ description: workOrder, files: ['result.json'], loadModule: missing }),
    (e) => e.code === 'DISCOVER_UNAVAILABLE' && /^Submitting to a work-order bounty \(Service: review-v1\) needs the sibling verdikta-discover skill .*from the same reviewed revision\. .*nothing was uploaded or signed\.$/.test(e.message));
  assert.equal(loads.length, 1);
  assert.match(loads[0], /\/verdikta-discover\/scripts\/work-order\.mjs$/);
  // Other load errors are not mistaken for a missing sibling.
  await assert.rejects(checkWorkOrderResult({ description: workOrder, loadModule: async () => { throw new SyntaxError('tampered'); } }), /tampered/);
});

// A copy of this skill's scripts with no skills/verdikta-discover beside it, as a ClawHub install of this skill alone.
async function installedAlone(t) {
  const root = await mkdtemp(`${tmpdir()}/verdikta-alone-`); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'skills', 'verdikta-bounties-onboarding', 'scripts');
  await mkdir(dir, { recursive: true });
  await cp(scripts, dir, { recursive: true, filter: (src) => !/[/\\](node_modules|test)([/\\]|$)/.test(path.relative(scripts, src) ? `/${path.relative(scripts, src)}` : '') });
  await symlink(path.join(scripts, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  await assert.rejects(access(path.join(root, 'skills', 'verdikta-discover')));
  return { root, ...(await import(pathToFileURL(path.join(dir, 'submit_to_bounty.js')).href)) };
}

test('installed without verdikta-discover: a wager claim submits, a work-order submission stops before any upload', async (t) => {
  const { root, runSubmit } = await installedAlone(t);
  const d = deployments.base, cid = 'Qm' + 'a'.repeat(44), hunterCid = 'Qm' + 'b'.repeat(44), hash = '0x' + '1'.repeat(64);
  const hunter = new Wallet('0x' + '11'.repeat(32)).address, poster = '0x2222222222222222222222222222222222222222';
  const policy = { maxValueWei: '2000000000000000', maxTotalWei: '5000000000000000', maxGasLimit: '6000000', maxFeePerGasWei: '2', maxPriorityFeePerGasWei: '1' };
  const json = (x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
  const log = (name, args) => ({ address: d.address, ...iface.encodeEventLog(iface.getEvent(name), args) });
  const claim = path.join(root, 'claim.md');
  await writeFile(claim, 'MUTUAL WAGER CLAIM (mutual-wager-v3)\n');
  async function submit(description, state) {
    let uploads = 0;
    const sent = [], provider = { destroy() {}, getTransaction: async () => null, getTransactionReceipt: async () => null };
    const wallet = { address: hunter, connect() { return { ...this, provider }; } };
    const args = { jobId: '7', file: [claim], state: path.join(root, state) };
    const lib = { arg: (n) => args[n] ?? null, argAll: (n) => args[n] || [], getNetwork: () => 'base', providerFor: () => provider, loadWallet: async () => wallet, loadApiKey: async () => 'mock',
      preflightDeployment: async () => d.address, loadSpendPolicy: async () => policy, isDryRun: () => false, confirmSpendOrExit: async () => {},
      sendTx: async (signer, method, tx, opts) => { verifyTransaction(tx, { network: 'base', method, args: opts.args, value: opts.exactValueWei ?? 0n, maxValueWei: policy.maxValueWei }); await opts.onSigned?.({ hash }); sent.push(method);
        return { status: 1, hash, logs: [log('SubmissionPrepared', [7, 0, hunter, poster, 100n, cid])] }; } };
    const transaction = { to: d.address, chainId: d.chainId, value: '0', data: iface.encodeFunctionData('prepareSubmission', [7, cid, hunterCid]) };
    const env = { baseUrl: 'https://mock.invalid', pause: async () => {}, contract: () => ({ getBounty: async () => ({ evaluationCid: cid, targetHunter: hunter }), isAcceptingSubmissions: async () => true, getSubmission: async () => ({ hunter, hunterCid }), nextAction: async () => 'AWAIT_ORACLE', requiredPrepay: async () => 123n }),
      fetchApi: async (url) => {
        if (url.endsWith('/7')) return json({ job: { jobId: 7, onChain: true, evaluationCid: cid, description } });
        if (url.endsWith('/validate')) return json({ valid: true });
        if (url.endsWith('/submit')) { uploads++; return json({ submission: { hunterCid } }); }
        if (url.endsWith('/prepare')) return json({ transaction });
        if (url.endsWith('/confirm')) return json({ success: true });
        throw Error(url);
      } };
    return { run: () => runSubmit(lib, env), sent, uploads: () => uploads, state: args.state };
  }
  const [wagerDescription] = await wagerDescriptions();
  const plain = await submit(wagerDescription, 'wager-claim.json');
  await plain.run();
  assert.equal(plain.uploads(), 1); assert.deepEqual(plain.sent, ['prepareSubmission']);
  const workOrder = await submit(await realDescription('source-check-v1'), 'work-order.json');
  await assert.rejects(workOrder.run(), /Submitting to a work-order bounty \(Service: source-check-v1\) needs the sibling verdikta-discover skill/);
  assert.equal(workOrder.uploads(), 0); assert.deepEqual(workOrder.sent, []);
  await assert.rejects(access(workOrder.state)); // no recovery state: nothing started
});
