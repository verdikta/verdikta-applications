#!/usr/bin/env node
// One state-driven action per invocation; no polling, automatic re-prepare or payout promise.
// The action is the escrow's own nextAction (BountyEscrowLens): every label names the call that succeeds now.
import { isMain } from './_cli.js';
import { Contract, formatEther } from 'ethers';

import { abi, iface, aggregatorIface, deployments, reviewedApiOrigin, escrowAddress, outcomeName } from './_transaction-guards.js';

// Gas-only calls anyone may send. DRAW / CLOSE_COMMITS / PROMOTE move a round on (the server's keeper usually sends
// them; the promote reward goes to the sender); the rest resolve a submission or recover its leftover prepay.
export const ACTIONS = Object.freeze({
  DRAW: 'drawJury', CLOSE_COMMITS: 'closeCommits', PROMOTE: 'promote',
  FINALIZE: 'finalizeSubmission', CLOSE_FAILED: 'closeFailedRound', EXPIRE_RERUN: 'expireRerun', RECOVER_REFUND: 'recoverLeftoverEth',
});
const EFFECT = {
  PASS: 'paid to the hunter (subject to payout priority); the bond goes back to its funder',
  SOFT_FAIL: 'the submission awaits a re-run (2-hour window, before the deadline), keeping its place and bond',
  NO_RESULT: 'an unusable result: the submission awaits a re-run, keeping its place and bond',
  HARD_FAIL: 'the submission fails and its bond goes to the bounty creator',
};

export async function runClaim(lib, { contract = (address, abi, provider) => new Contract(address, abi, provider), baseUrl: configuredBaseUrl = process.env.VERDIKTA_BOUNTIES_BASE_URL || '' } = {}) {
  const { arg, getNetwork, providerFor, loadWallet, preflightDeployment, loadSpendPolicy, sendTx } = lib;
  if (process.argv.includes('--maxWait')) throw new Error('--maxWait is retired; run one state-driven action per invocation');
  const jobId = arg('jobId'), submissionId = arg('submissionId');
  if (!/^[0-9]+$/.test(jobId || '') || !/^[0-9]+$/.test(submissionId || '')) throw new Error('Usage: claim_bounty.js --jobId ID --submissionId ID [--dry-run] [--approve-as-creator | --rerun]');
  const network = getNetwork(), escrowAt = escrowAddress(network), provider = providerFor(network);
  try {
    await preflightDeployment(network, provider, configuredBaseUrl || reviewedApiOrigin(network));
    const policy = await loadSpendPolicy(), signer = (await loadWallet()).connect(provider);
    const escrow = contract(escrowAt, abi, provider);
    const next = await escrow.nextAction(jobId, submissionId);
    console.log(`Submission ${submissionId}: ${next}`);
    const args = [BigInt(jobId), BigInt(submissionId)];
    const chainId = deployments[network].chainId;
    let review = [], method = ACTIONS[next] ?? null, tx = null, value = 0n, round = null;
    if (process.argv.includes('--approve-as-creator')) {
      const bounty = await escrow.getBounty(jobId);
      if (next !== 'AWAIT_CREATOR' || bounty.creator.toLowerCase() !== signer.address.toLowerCase()) throw new Error('Creator approval unavailable to this signer');
      // Approval sends no value, so maxValueWei never saw the ETH it releases: the payout is the
      // creator's spend, and a hunter's narrative is exactly the text that would ask an agent to
      // approve. Capped like any spend: maxCreatorReleaseWei in the owner's policy, else maxValueWei.
      const releaseCap = BigInt(policy.maxCreatorReleaseWei ?? policy.maxValueWei);
      if (BigInt(bounty.creatorDeterminationPayment) > releaseCap) throw new Error(`Creator approval would release ${bounty.creatorDeterminationPayment} wei, above the policy's ${policy.maxCreatorReleaseWei != null ? 'maxCreatorReleaseWei' : 'maxValueWei'}; the owner decides this one`);
      const submission = await escrow.getSubmission(jobId, submissionId);
      review = [`Release creator-determination payout: ${formatEther(bounty.creatorDeterminationPayment)} ETH (${bounty.creatorDeterminationPayment} wei)`, `Hunter: ${submission.hunter}`, `Work CID: ${submission.hunterCid}`];
      method = 'creatorApproveSubmission';
    } else if (next === 'RERUN') {
      // A re-run spends a fresh prepay: never without the explicit flag (the owner's decision, like a first start).
      const submission = await escrow.getSubmission(jobId, submissionId);
      const rerunBy = new Date(Number(submission.rerunDeadline) * 1000).toISOString();
      if (!process.argv.includes('--rerun')) {
        console.log(`Submission ${submissionId} awaits a re-run until ${rerunBy} (${submission.rounds} of 6 rounds run). A re-run costs a fresh prepay (requiredPrepay) and keeps the submission's place and bond; pass --rerun to send it. Otherwise it expires after that time (EXPIRE_RERUN; the bond comes back).`);
        return;
      }
      if (![submission.hunter, submission.bondFunder].some(a => String(a).toLowerCase() === signer.address.toLowerCase())) throw new Error('Only the hunter or the bond\'s funder may re-run this submission');
      value = await escrow.requiredPrepay(jobId);
      method = 'rerunSubmission';
      review = [`Re-run submission ${submissionId}: a new round with a fresh jury, attaching the prepay ${formatEther(value)} ETH (${value} wei); the unspent part comes back`, `Round ${Number(submission.rounds) + 1} of at most 6; the bond stays held`];
    } else if (next === 'CLOSE_COMMITS' || next === 'PROMOTE') {
      // The escrow's aggregator (one for every jury size), with the round's aggregation id; the executor re-reads both from the escrow.
      const [aggregator, submission] = await Promise.all([escrow.aggregator(), escrow.getSubmission(jobId, submissionId)]);
      tx = { to: aggregator, chainId, value: '0', data: aggregatorIface.encodeFunctionData(method, [submission.verdiktaAggId]) };
      args.splice(0, 2, submission.verdiktaAggId);
      round = { bountyId: BigInt(jobId), submissionId: BigInt(submissionId) };
      review = [`${method} on the escrow's aggregator ${aggregator} (gas only; anyone may send it)`];
    } else if (next === 'FINALIZE') {
      const result = await escrow.getOracleResult(jobId, submissionId), outcome = outcomeName(result.outcome);
      review = [`Round result: ${outcome}, ${result.passCount} juror score(s) at or above the threshold`, `Effect: ${EFFECT[outcome] ?? 'see the escrow'}`];
    } else if (next === 'CLOSE_FAILED') {
      review = ['The round has no result and can get none: closeFailedRound settles or cancels it and returns what is left of the prepay to its funder; the submission keeps its place and bond and may re-run'];
    }
    if (!method) {
      console.log('No action is available now. AWAIT_* means wait (AWAIT_ORACLE: the jury is working; AWAIT_EARLIER: an earlier submission holds payout priority; AWAIT_SLOT / AWAIT_EXPIRY: retry later); START belongs to submit_to_bounty.js --resume; DONE/DEAD does not imply a payout.');
      return;
    }
    tx ??= { to: escrowAt, chainId, value: value.toString(), data: iface.encodeFunctionData(method, args) };
    const receipt = await sendTx(signer, method, tx, { network, args, policy, review, exactValueWei: value, round });
    if (receipt) {
      const events = receipt.logs.filter(l => l.address.toLowerCase() === escrowAt.toLowerCase()).map(l => { try { return iface.parseLog(l)?.name; } catch { return null; } }).filter(Boolean);
      console.log(`Confirmed events: ${events.join(', ') || '(none from the escrow)'}. Read state to establish outcome; an accepted verdict alone does not prove payment delivery.`);
      if (events.includes('RerunAwaited')) console.log(`The submission awaits a re-run: claim_bounty.js --jobId ${jobId} --submissionId ${submissionId} --rerun within the window, or let it expire (the bond comes back).`);
      if (events.includes('BondForfeited')) console.log('The round was a hard fail: the bond went to the bounty creator.');
      if (events.includes('PaymentDeferred')) console.log('Payment is on the pull ledger; the recipient must separately authorize withdraw().');
      if (events.includes('RefundDeferred')) console.log('Refund recovery deferred; re-check nextAction and recoverLeftoverEth later.');
    }
  } finally { provider.destroy(); }
}

if (isMain(import.meta.url)) {
  await runClaim(await import('./_lib.js'));
}
