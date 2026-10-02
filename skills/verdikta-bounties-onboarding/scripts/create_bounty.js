#!/usr/bin/env node
// Authorized commissioning only. Local/no-wallet preview is in verdikta-discover.
import fs from 'node:fs/promises';
import { saveState } from './_state.js';
import { createHash } from 'node:crypto';
import { isMain } from './_cli.js';
import { Contract } from 'ethers';

import { creationTerms, bindCreation, verifyTransaction, iface, deployments, abi, verifyCreatedBounty, verifySignedTransaction, reviewedApiOrigin } from './_transaction-guards.js';
import { validateRubric } from './rubric.cjs';
import { applyWorkOrder } from './_work-order.js';

export async function runCreate(lib, { contract = (address, abi, provider) => new Contract(address, abi, provider), fetchApi = globalThis.fetch, baseUrl: configuredBaseUrl = process.env.VERDIKTA_BOUNTIES_BASE_URL || '', pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const { arg, getNetwork, providerFor, loadWallet, loadApiKey, confirmSpendOrExit,
    isDryRun, preflightDeployment, loadSpendPolicy, getSupportedModelsForClass,
    validateAndNormalizeJuryNodes, sendTx } = lib;
  const configPath = arg('config');
  if (!configPath) throw new Error('Usage: create_bounty.js --config approved.json [--dry-run --prepared response.json] [--resume state.json]');
  const raw = await fs.readFile(configPath, 'utf8');
  const config = await applyWorkOrder(JSON.parse(raw));
  if (config.fixture_only) throw new Error('Synthetic config cannot commission real work; replace it with an owner-reviewed non-fixture request');
  const configHash = createHash('sha256').update(raw + (config.workOrderDraftSha256 || '')).digest('hex');
  const terms = creationTerms(config);
  const rubric = validateRubric(config.rubricJson);
  if (!rubric.valid) throw new Error(rubric.errors.join('; '));
  if (!config.title || !config.description || !Array.isArray(config.juryNodes) || !config.juryNodes.length) throw new Error('Title, description and juryNodes required');
  if ('threshold' in config.rubricJson) throw new Error('Threshold belongs outside rubricJson');
  const network = getNetwork(), provider = providerFor(network);
  try {
    const baseUrl = configuredBaseUrl ? configuredBaseUrl.replace(/\/+$/, '') : reviewedApiOrigin(network);
    await preflightDeployment(network, provider, baseUrl);
    const policy = await loadSpendPolicy();
    if (terms.value > BigInt(policy.maxValueWei) || terms.value > BigInt(policy.maxTotalWei)) throw new Error('Reward exceeds owner cap');
    const aggregatorAddress = await contract(deployments[network].address, ['function verdikta() view returns(address)'], provider).verdikta();
    const ceiling = await contract(aggregatorAddress, ['function maxOracleFee() view returns(uint256)'], provider).maxOracleFee();
    if (terms.params.oracle.maxOracleFee > ceiling) throw new Error('Oracle fee exceeds live ceiling');
    const wallet = (await loadWallet()).connect(provider);
    const apiKey = await loadApiKey();
    if (!apiKey) throw new Error('Configured API identity required');
    const headers = { 'Content-Type': 'application/json', 'X-Bot-API-Key': apiKey };
    async function api(path, body, method = 'POST') {
      const res = await fetchApi(`${baseUrl}/api${path}`, { method, headers, body: JSON.stringify(body), redirect: 'error' });
      if (!res.ok) throw new Error(`API ${path}: HTTP ${res.status}; do not create a replacement job`);
      return res.json();
    }
    const statePath = arg('resume') || `${configPath}.state.json`;
    async function link(state, receipt) {
      try {
        if (receipt.hash !== state.txHash) throw new Error('Creation receipt hash mismatch');
        if (receipt.status !== 1) throw new Error('Creation did not succeed; inspect saved transaction');
        const event = receipt.logs.filter(l => l.address.toLowerCase() === deployments[network].address.toLowerCase())
          .map(l => { try { return iface.parseLog(l); } catch { return null; } }).find(l => l?.name === 'BountyCreated');
        if (!event) throw new Error('No escrow BountyCreated event; inspect saved transaction');
        const bound = bindCreation(config, state.response, { recovery: true });
        let bounty;
        for (let attempt = 0; ; attempt++) {
          try { bounty = await contract(deployments[network].address, abi, provider).getBounty(event.args.bountyId, { blockTag: receipt.blockNumber }); break; }
          catch (error) { if (attempt >= 3) throw error; await pause(1000 * 2 ** attempt); }
        }
        verifyCreatedBounty(bounty, bound.params, wallet.address);
        const result = await api(`/jobs/${state.response.job.jobId}/bountyId`, { bountyId: Number(event.args.bountyId), txHash: receipt.hash, blockNumber: receipt.blockNumber }, 'PATCH');
        if (!result.success || result.job?.jobId == null || String(result.job.jobId) !== event.args.bountyId.toString()) throw new Error('API link response drift; keep the saved transaction and reconcile it');
        state.linkedJobId = result.job.jobId;
        await saveState(statePath, state);
        console.log(`Linked API job ${state.linkedJobId ?? '(verify API response)'}; on-chain bounty ${event.args.bountyId}`);
      } catch (error) {
        throw new Error(`Creation receipt ${receipt.hash} status ${receipt.status}; if successful, the bounty is funded. Run --resume ${statePath} to finish verification/linking: ${error.message}`, { cause: error });
      }
    }
    async function broadcast(state, bound) {
      const review = [`Escrow: ${deployments[network].address}`, `Submission deadline: ${new Date(Number(bound.params.submissionDeadline) * 1000).toISOString()}`, `Remaining submission time: ${Math.floor(Number(bound.params.submissionDeadline) - Date.now() / 1000)} seconds (original window ${config.submissionWindowHours} hours)`, `Usable time before prepare cutoff: ${Math.floor(Number(bound.params.submissionDeadline - bound.params.creatorAssessmentWindowSize) - Date.now() / 1000 - 2)} seconds`, `Supplier: ${config.procurementMode} ${bound.params.targetHunter}`];
      const receipt = await sendTx(wallet, 'createBounty', bound.transaction, {
        network, args: [bound.params], exactValueWei: bound.value, policy, review,
        onSigned: async ({ rawTransaction, hash }) => { state.rawTransaction = rawTransaction; state.txHash = hash; state.status = 'BROADCAST_PENDING'; await saveState(statePath, state); },
        onBroadcast: async hash => { state.txHash = hash; state.status = 'BROADCAST'; await saveState(statePath, state); },
      });
      if (receipt) await link(state, receipt);
    }
    if (arg('resume')) {
      if (isDryRun()) throw new Error('Resume performs linking; use --prepared for a non-mutating dry-run');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (state.configHash !== configHash || state.network !== network) throw new Error('Recovery needs the matching config/network and a saved broadcast hash; inspect chain/API before further action');
      if (!state.txHash) {
        if (state.status !== 'API_CREATED' || state.creator?.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('No safe pre-broadcast recovery state; reconcile chain/API manually');
        const bound = bindCreation(config, state.response, { apiCreatedAt: state.apiCreatedAt });
        await broadcast(state, bound);
        return;
      }
      const saved = bindCreation(config, state.response, { recovery: true });
      if (state.rawTransaction) verifySignedTransaction(state.rawTransaction, { network, method: 'createBounty', args: [saved.params], value: saved.value }, wallet.address, policy, state.txHash);
      const tx = await provider.getTransaction(state.txHash);
      let receipt = await provider.getTransactionReceipt(state.txHash);
      if (tx) {
        if (tx.from.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Saved transaction has wrong creator');
        verifyTransaction(tx, { network, method: 'createBounty', args: [saved.params], value: saved.value, maxValueWei: policy.maxValueWei });
      } else if (!receipt) {
        if (!state.rawTransaction) throw new Error('Saved transaction missing; reconcile its hash manually');
        bindCreation(config, state.response, { apiCreatedAt: state.apiCreatedAt });
        await confirmSpendOrExit([`Rebroadcast exactly the saved signed transaction ${state.txHash}. No new nonce or API job.`, `Escrow: ${deployments[network].address}; reward ${config.bountyAmount} ETH`, `Submission deadline: ${new Date(Number(saved.params.submissionDeadline) * 1000).toISOString()}`]);
        const sent = await provider.broadcastTransaction(state.rawTransaction);
        if (sent.hash !== state.txHash) throw new Error('RPC returned a different transaction hash');
        state.status = 'BROADCAST'; await saveState(statePath, state);
        receipt = await sent.wait();
      }
      if (!receipt) throw new Error('Transaction still pending; retry --resume later');
      await link(state, receipt); // Existing hash only; never creates another API job.
    } else {
      const supported = await getSupportedModelsForClass(baseUrl, apiKey, config.classId);
      const juryNodes = validateAndNormalizeJuryNodes({ classId: config.classId, juryNodes: config.juryNodes, supported });
      let response, state, apiCreatedAt;
      if (isDryRun()) {
        if (!arg('prepared')) throw new Error('Exact financial dry-run requires --prepared saved API response; no API job was created. For wallet-free drafting use verdikta-discover.');
        const prepared = JSON.parse(await fs.readFile(arg('prepared'), 'utf8'));
        response = prepared.response ?? prepared;
        apiCreatedAt = prepared.apiCreatedAt; // Prefer a saved API_CREATED state for older responses.
      } else {
        await confirmSpendOrExit([`Commission ${config.procurementMode} work for ${terms.params.targetHunter}`, `Reward: ${config.bountyAmount} ETH; chain: ${network}`, `Threshold ${config.threshold}; window ${config.submissionWindowHours} hours`, `Publish the reviewed description/rubric; then review exact transaction`, `Payout follows creator approval in its window or passing oracle evaluation; finalization is required.`]);
        // Reserve before mutation. Existing state always stops duplicate creation.
        state = { configHash, network, creator: wallet.address, status: 'API_CREATE_PENDING' };
        await fs.writeFile(statePath, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
        const o = terms.params.oracle;
        response = await api('/jobs/create', {
          title: config.title, description: config.description, workProductType: config.workProductType || 'research',
          creator: wallet.address, bountyAmount: config.bountyAmount, threshold: config.threshold,
          classId: config.classId, submissionWindowHours: config.submissionWindowHours,
          procurementMode: config.procurementMode, targetHunter: terms.params.targetHunter, rubricJson: config.rubricJson, juryNodes,
          creatorDeterminationPayment: config.creatorDeterminationPayment ?? config.bountyAmount,
          arbiterDeterminationPayment: config.arbiterDeterminationPayment ?? config.bountyAmount,
          creatorAssessmentWindowSeconds: Number(terms.params.creatorAssessmentWindowSize),
          oracleMaxOracleFee: o.maxOracleFee.toString(), oracleAlpha: Number(o.alpha),
          oracleEstimatedBaseCost: o.estimatedBaseCost.toString(), oracleMaxFeeBasedScaling: Number(o.maxFeeBasedScaling),
        });
        apiCreatedAt = Math.floor(Date.now() / 1000);
        state.response = response; state.apiCreatedAt = apiCreatedAt; state.status = 'API_CREATED';
        await saveState(statePath, state);
      }
      const bound = bindCreation(config, response, { apiCreatedAt });
      await broadcast(state, bound);
    }
  } finally { provider.destroy(); }
}

if (isMain(import.meta.url)) {
  await runCreate(await import('./_lib.js'));
}
