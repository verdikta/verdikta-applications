#!/usr/bin/env node
// prepare -> creator window or start with LIVE ETH prepay -> confirm. No LINK.
import fs from 'node:fs/promises';
import { saveState } from './_state.js';
import path from 'node:path';
import { isMain } from './_cli.js';
import { Contract } from 'ethers';

import { abi, iface, deployments, verifyTransaction, reviewedApiOrigin } from './_transaction-guards.js';
import { checkWorkOrderResult } from './_work-order-result.js';

export async function runSubmit(lib, { contract = (address, abi, provider) => new Contract(address, abi, provider), fetchApi = globalThis.fetch, baseUrl: configuredBaseUrl = process.env.VERDIKTA_BOUNTIES_BASE_URL || '', pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const { arg, argAll, getNetwork, providerFor, loadWallet, loadApiKey, isDryRun,
    preflightDeployment, loadSpendPolicy, sendTx, confirmSpendOrExit } = lib;
  for (const name of ['alpha','maxOracleFee','estimatedBaseCost','maxFeeBasedScaling','confirm-first','skip-confirm','bundle']) {
    if (process.argv.includes(`--${name}`)) throw new Error(`--${name} is not supported by this current-generation flow; stop rather than changing transaction semantics`);
  }
  const jobId = arg('jobId');
  if (!/^[0-9]+$/.test(jobId || '')) throw new Error('Usage: submit_to_bounty.js --jobId ID --file report.md --state submission.json [--yes]; --dry-run requires --hunterCid CID; --resume SUBMISSION_ID only starts an existing prepare');
  const network = getNetwork(), provider = providerFor(network);
  try {
    const baseUrl = configuredBaseUrl ? configuredBaseUrl.replace(/\/+$/, '') : reviewedApiOrigin(network);
    await preflightDeployment(network, provider, baseUrl);
    const policy = await loadSpendPolicy();
    const signer = (await loadWallet()).connect(provider), hunter = signer.address;
    const apiKey = await loadApiKey();
    if (!apiKey) throw new Error('API identity required');
    const headers = { 'X-Bot-API-Key': apiKey, 'Content-Type': 'application/json' };
    async function api(route, body) {
      const res = await fetchApi(`${baseUrl}/api/jobs/${jobId}${route}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const error = new Error(`API ${route}: HTTP ${res.status}; retain existing IDs, do not prepare another submission`);
        error.status = res.status; error.code = data?.code || data?.error?.code; throw error;
      }
      let data;
      try { data = await res.json(); }
      catch { throw new Error(`API ${route}: invalid JSON (HTTP ${res.status}); retain existing IDs, do not prepare another submission`); }
      return data;
    }
    const escrow = contract(deployments[network].address, abi, provider);
    const bounty = await escrow.getBounty(jobId);
    const response = await api(''), job = response.job;
    if (!job || String(job.jobId) !== String(jobId) || !(job.onChain || job.syncedFromBlockchain) || job.evaluationCid !== bounty.evaluationCid) throw new Error('API/on-chain job identity mismatch');
    if (bounty.targetHunter !== '0x0000000000000000000000000000000000000000' && bounty.targetHunter.toLowerCase() !== hunter.toLowerCase()) throw new Error('Bounty targets a different supplier');
    const validation = await api('/validate');
    if (validation.valid !== true) throw new Error('Evaluation package validation failed or unavailable; do not upload');
    if (arg('resume') == null && !await escrow.isAcceptingSubmissions(jobId)) throw new Error('Bounty is not accepting submissions');
    let submissionId = arg('resume'), hunterCid = arg('hunterCid');
    const statePath = arg('state');
    let state;
    if (submissionId == null) {
      if (!isDryRun()) {
        if (!statePath || !argAll('file').length) throw new Error('--state and --file are required; preserve the state file for recovery');
        // A work-order bounty (the description commits a request) takes only a result.json that validates against it: the
        // evaluator's structural gates would fail anything else, so the upload is refused here first.
        const workOrder = await checkWorkOrderResult({ description: job.description, files: argAll('file') });
        if (workOrder.workOrder && workOrder.errors.length) throw new Error(`Work-order result check failed (${workOrder.templateId}): ${workOrder.errors.join('; ')}`);
        await confirmSpendOrExit([`Publish files and prepare submission for bounty ${jobId}; network ${network}`, `Evaluation prepay is ETH, limited by the owner policy ${policy.maxValueWei} wei; a creator window may defer start.`]);
        state = { network, jobId, hunter, status: 'UPLOAD_PENDING' };
        await fs.writeFile(statePath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
        const form = new FormData(); form.append('hunter', hunter);
        if (arg('narrative')) form.append('submissionNarrative', arg('narrative'));
        for (const file of argAll('file')) form.append('files', new Blob([await fs.readFile(file)]), path.basename(file));
        const res = await fetchApi(`${baseUrl}/api/jobs/${jobId}/submit`, { method: 'POST', headers: { 'X-Bot-API-Key': apiKey }, body: form, redirect: 'error' });
        if (!res.ok) throw new Error(`Upload HTTP ${res.status}`);
        const upload = await res.json(); hunterCid = upload.submission?.hunterCid;
        state.hunterCid = hunterCid;
        await saveState(statePath, state);
      }
      if (!/^[a-zA-Z0-9]{46,100}$/.test(hunterCid || '')) throw new Error('A bare work CID is required; dry-run uploads nothing');
      // Encode locally for dry-run: do not call mutation-shaped preparation endpoints.
      const args = [BigInt(jobId), bounty.evaluationCid, hunterCid];
      const transaction = isDryRun() ? { to: deployments[network].address, chainId: deployments[network].chainId, value: '0', data: iface.encodeFunctionData('prepareSubmission', args) } : (await api('/submit/prepare', { hunter, hunterCid })).transaction;
      const receipt = await sendTx(signer, 'prepareSubmission', transaction, { network, args, policy,
        onSigned: async ({ rawTransaction, hash }) => { state.prepareTxHash = hash; state.prepareRawTransaction = rawTransaction; await saveState(statePath, state); },
        onBroadcast: async hash => { state.prepareTxHash = hash; await saveState(statePath, state); } });
      if (!receipt) { return; }
      const event = receipt.logs.filter(l => l.address.toLowerCase() === deployments[network].address.toLowerCase()).map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .find(e => e?.name === 'SubmissionPrepared' && e.args.bountyId === BigInt(jobId) && e.args.hunter.toLowerCase() === hunter.toLowerCase());
      if (!event) throw new Error('No matching SubmissionPrepared; recover from saved hash, never repeat prepare blindly');
      submissionId = event.args.submissionId.toString(); state.submissionId = submissionId;
      await saveState(statePath, state);
      console.log(`Prepared submission ${submissionId}. Estimated prepay ${event.args.ethMaxBudget} wei (not a locked price).`);

    }
    // An RPC node behind the prepare receipt reverts "bad submissionId" for a submission that
    // exists. Retry only that read, with backoff; never prepare again.
    let sub;
    for (let attempt = 0; ; attempt++) {
      try { sub = await escrow.getSubmission(jobId, submissionId); break; }
      catch (error) {
        const lagging = /bad submissionId/i.test(`${error.reason ?? ''} ${error.shortMessage ?? ''} ${error.message ?? ''}`);
        if (!lagging || attempt >= 4) {
          if (arg('resume') == null && state?.submissionId != null) throw new Error(`Submission ${submissionId} is prepared and saved in ${statePath}, but the chain read failed: ${error.shortMessage ?? error.message}. Re-run with --resume ${submissionId} --state ${statePath}; do not prepare again.`, { cause: error });
          throw error;
        }
        await pause(1000 * 2 ** attempt);
      }
    }
    if (sub.hunter.toLowerCase() !== hunter.toLowerCase()) throw new Error('Submission belongs to another hunter');
    if (arg('resume') && statePath) {
      state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (state.network !== network || String(state.jobId) !== String(jobId) || state.hunter?.toLowerCase() !== hunter.toLowerCase() || state.hunterCid !== sub.hunterCid) throw new Error('Submission recovery state does not match chain/network/hunter');
      if (state.submissionId == null) {
        if (!state.prepareTxHash) throw new Error('Recovery state lacks prepare hash; reconcile it manually');
        const tx = await provider.getTransaction(state.prepareTxHash);
        const receipt = await provider.getTransactionReceipt(state.prepareTxHash);
        if (!tx || tx.from.toLowerCase() !== hunter.toLowerCase() || receipt?.status !== 1 || receipt.hash !== state.prepareTxHash) throw new Error('Prepare transaction not confirmed for this hunter');
        verifyTransaction(tx, { network, method: 'prepareSubmission', args: [BigInt(jobId), bounty.evaluationCid, state.hunterCid], value: 0n, maxValueWei: policy.maxValueWei });
        const event = receipt.logs.filter(l => l.address.toLowerCase() === deployments[network].address.toLowerCase()).map(l => { try { return iface.parseLog(l); } catch { return null; } })
          .find(e => e?.name === 'SubmissionPrepared' && e.args.bountyId === BigInt(jobId) && e.args.submissionId === BigInt(submissionId) && e.args.hunter.toLowerCase() === hunter.toLowerCase() && e.args.evaluationCid === bounty.evaluationCid);
        if (!event) throw new Error('Recovered submission ID does not match the saved prepare receipt');
        state.submissionId = String(submissionId);
        if (!isDryRun()) await saveState(statePath, state);
      } else if (String(state.submissionId) !== String(submissionId)) throw new Error('Submission recovery state has a different submission ID');

    }
    if (hunterCid && hunterCid !== sub.hunterCid) throw new Error('Submission CID does not match chain');
    hunterCid = sub.hunterCid;
    if (!isDryRun() && !state?.confirmed) {
      // Confirmation is idempotent. Retry only indexing/temporary failures; never prepare again.
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await api('/submissions/confirm', { submissionId: Number(submissionId), hunter, hunterCid });
          if (result.success !== true) throw new Error('Confirmation response is not successful');
          if (state) { state.confirmed = true; await saveState(statePath, state); }
          break;
        } catch (error) {
          const transient = error.code === 'SUBMISSION_BAD_ID' || [429,500,502,503,504].includes(error.status);
          if (!transient || attempt >= 3) throw error;
          await pause(1000 * 2 ** attempt);
        }
      }
    }
    const next = await escrow.nextAction(jobId, submissionId);
    console.log(`Submission ${submissionId}: ${next}`);
    if (next === 'START') {
      const value = await escrow.requiredPrepay(jobId);
      const args = [BigInt(jobId), BigInt(submissionId)];
      const transaction = isDryRun() ? { to: deployments[network].address, chainId: deployments[network].chainId, value: value.toString(), data: iface.encodeFunctionData('startPreparedSubmission', args) } : (await api(`/submissions/${submissionId}/start`, { hunter })).transaction;
      await sendTx(signer, 'startPreparedSubmission', transaction, { network, args, exactValueWei: value, policy });
    } else {
      console.log('No start transaction sent. AWAIT_* means wait; use claim_bounty.js for FINALIZE, FORCE_FAIL or RECOVER_REFUND. Re-run --resume with this submission ID, not a new prepare.');
    }
  } finally { provider.destroy(); }
}

if (isMain(import.meta.url)) {
  await runSubmit(await import('./_lib.js'));
}
