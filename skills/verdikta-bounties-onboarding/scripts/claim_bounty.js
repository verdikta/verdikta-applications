#!/usr/bin/env node
// One state-driven action per invocation; no polling, automatic re-prepare or payout promise.
import { isMain } from './_cli.js';
import { Contract, formatEther } from 'ethers';

import { abi, iface, deployments, reviewedApiOrigin } from './_transaction-guards.js';
export async function runClaim(lib, { contract = (address, abi, provider) => new Contract(address, abi, provider), baseUrl: configuredBaseUrl = process.env.VERDIKTA_BOUNTIES_BASE_URL || '' } = {}) {
  const { arg, getNetwork, providerFor, loadWallet, preflightDeployment, loadSpendPolicy, sendTx } = lib;
  if (process.argv.includes('--maxWait')) throw new Error('--maxWait is retired; run one state-driven action per invocation');
  const jobId = arg('jobId'), submissionId = arg('submissionId');
  if (!/^[0-9]+$/.test(jobId || '') || !/^[0-9]+$/.test(submissionId || '')) throw new Error('Usage: claim_bounty.js --jobId ID --submissionId ID [--dry-run] [--approve-as-creator]');
  const network = getNetwork(), provider = providerFor(network);
  try {
    await preflightDeployment(network, provider, configuredBaseUrl || reviewedApiOrigin(network));
    const policy = await loadSpendPolicy(), signer = (await loadWallet()).connect(provider);
    const escrow = contract(deployments[network].address, abi, provider);
    const next = await escrow.nextAction(jobId, submissionId);
    console.log(`Submission ${submissionId}: ${next}`);
    let review = [];
    let method = { FINALIZE: 'finalizeSubmission', FORCE_FAIL: 'failTimedOutSubmission', RECOVER_REFUND: 'recoverLeftoverEth' }[next];
    if (process.argv.includes('--approve-as-creator')) {
      const bounty = await escrow.getBounty(jobId);
      if (next !== 'AWAIT_CREATOR' || bounty.creator.toLowerCase() !== signer.address.toLowerCase()) throw new Error('Creator approval unavailable to this signer');
      const submission = await escrow.getSubmission(jobId, submissionId);
      review = [`Release creator-determination payout: ${formatEther(bounty.creatorDeterminationPayment)} ETH (${bounty.creatorDeterminationPayment} wei)`, `Hunter: ${submission.hunter}`, `Work CID: ${submission.hunterCid}`];
      method = 'creatorApproveSubmission';
    }
    if (method) {
      const args = [BigInt(jobId), BigInt(submissionId)];
      const tx = { to: deployments[network].address, chainId: deployments[network].chainId, value: '0', data: iface.encodeFunctionData(method, args) };
      const receipt = await sendTx(signer, method, tx, { network, args, policy, review });
      if (receipt) {
        const events = receipt.logs.filter(l => l.address.toLowerCase() === tx.to.toLowerCase()).map(l => { try { return iface.parseLog(l)?.name; } catch { return null; } }).filter(Boolean);
        console.log(`Confirmed events: ${events.join(', ')}. Read state to establish outcome; an accepted verdict alone does not prove payment delivery.`);
        if (events.includes('PaymentDeferred')) console.log('Payment is on the pull ledger; the recipient must separately authorize withdraw().');
        if (events.includes('RefundDeferred')) console.log('Refund recovery deferred; re-check nextAction and recoverLeftoverEth later.');
      }
    } else console.log('No resolving action is available now. AWAIT_* means wait; DONE/DEAD does not imply a payout.');
  } finally { provider.destroy(); }
}

if (isMain(import.meta.url)) {
  await runClaim(await import('./_lib.js'));
}
