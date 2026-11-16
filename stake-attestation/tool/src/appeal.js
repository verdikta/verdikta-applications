// appeal (design §13.2, erratum E7; node P18): the hunter's appeal of the INVALID its claim round settled, once, to the
// listing's dispute panel, and that appeal's one re-trigger after a round that settled no verdict. Both pay: the live
// dispute fee the lens quotes (disputeFee; retriggerTopUp for the re-trigger), all of it from the hunter, its spent
// part the hunter's whatever the result. So, as commit, it prints what it costs and sends nothing without --yes.
//
// Everything that could stop it comes first: the claim read at one block (whose it is, its state and the lens's
// windows), the wallet's balance, and a dry run of the call at the send's own gas limit and value. The amount the
// notice names is the amount sent. The signed call is saved in the claim folder before it is sent, so a re-run sends
// the same bytes at their nonce, after the same checks and only with --yes; saved bytes that could no longer succeed
// are forgotten only once the node holds them no more. A wallet with a transaction still pending is refused, since it
// may be this appeal. The contract allows one appeal and one re-trigger per claim, so a second call could only revert.
import { CLAIM_STATES, DISPUTE_KINDS, DISPUTE_RESULTS, OUTCOMES } from './abi.js';
import { bindingOf, checkBinding } from './commit.js';
import { fail, revertReasonOf } from './errors.js';
import { appealNotice } from './notices.js';
import { Transaction, formatEther } from 'ethers';
import { openWorkspace } from './workspace.js';

/** Above SUBMISSION_GAS_NEEDED: the call's own work, as reveal's. Only the gas used is paid. */
const APPEAL_OWN_GAS = 1_750_000n;

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Why a claim allows neither an appeal nor its re-trigger now, in the contract's terms. */
function whyNot(r, appealDeadline) {
  if (r.state === 'Disputed') return `A round of the dispute panel is open on it (${r.kind}).`;
  if (r.state !== 'Judged') return `It is ${r.state}: only a judged INVALID can be appealed.`;
  if (r.outcome === 'DUPLICATE') return 'Judged DUPLICATE: only an INVALID can be appealed, and a DUPLICATE settles at once.';
  if (r.outcome !== 'INVALID') return `Judged ${r.outcome}: only an INVALID can be appealed.`;
  if (r.kind === 'Appeal') return r.dispute === 'NoVerdict' ? 'Its appeal\'s one re-trigger is used.' : `It was appealed already (${r.dispute}): one dispute-panel verdict per claim.`;
  if (r.kind !== 'None') return `This INVALID is the dispute panel's verdict (${r.kind}): it is final.`;
  return `The appeal window ended at ${appealDeadline} on the chain's clock.`;
}

/** What the claim allows now, at one block: an appeal, the appeal's re-trigger, or neither and why. */
async function readAppeal(ctx, claimId) {
  const block = await ctx.rpc(() => ctx.provider.getBlock('latest'));
  const at = { blockTag: block.number };
  const claim = await ctx.read('getClaim', [claimId], at);
  const now = BigInt(block.timestamp);
  const r = {
    claimId,
    listingId: claim.listingId,
    hunter: claim.hunter,
    state: CLAIM_STATES[Number(await ctx.read('claimState', [claimId], at))],
    outcome: OUTCOMES[Number(claim.outcome)],
    kind: DISPUTE_KINDS[Number(claim.disputeKind)],
    dispute: DISPUTE_RESULTS[Number(claim.dispute)],
    now,
    action: null,
  };
  const { revealWindow } = await ctx.read('getListing', [claim.listingId], at);
  r.revealWindow = BigInt(revealWindow);
  const appealDeadline = await ctx.read('appealDeadline', [claimId], at);
  if (appealDeadline > now) return { ...r, action: 'appeal', deadline: appealDeadline, valueWei: await ctx.read('disputeFee', [claim.listingId], at) };
  if (r.state === 'Judged' && r.kind === 'Appeal' && r.dispute === 'NoVerdict' && !claim.appealRetriggered) {
    const deadline = await ctx.read('retriggerDeadline', [claimId], at);
    if (deadline > now) return { ...r, action: 'retrigger', deadline, valueWei: await ctx.read('retriggerTopUp', [claimId], at) };
    return { ...r, why: `The appeal's re-trigger window ended at ${deadline} on the chain's clock.` };
  }
  return { ...r, why: whyNot(r, appealDeadline) };
}

async function resultOf(ctx, claimId, rec, { receipt, gone }) {
  const claim = await ctx.readSettled('getClaim', [claimId]);
  const state = CLAIM_STATES[Number(await ctx.read('claimState', [claimId]))];
  const kind = DISPUTE_KINDS[Number(claim.disputeKind)];
  const dispute = DISPUTE_RESULTS[Number(claim.dispute)];
  // the nonce went to another transaction: the call is in only if the chain says so (an appeal leaves
  // its kind on the claim; a re-trigger, whose claim was an appeal already, its appealRetriggered)
  const inPlace = rec.action === 'retrigger' ? claim.appealRetriggered === true : kind === 'Appeal';
  if ((receipt && receipt.status !== 1) || (gone && !inPlace)) {
    throw fail('APPEAL_REVERTED', `Transaction ${rec.hash}.`);
  }
  return {
    action: rec.action,
    claimId,
    tx: rec.hash,
    valueWei: BigInt(rec.value),
    state,
    disputeKind: kind,
    dispute,
    next: state === 'Disputed'
      ? 'The dispute panel\'s round is open: status --wait polls it, and the site\'s keeper finalizes it. Its verdict is final; claim settles it then.'
      : 'Run status to see where the claim stands.',
  };
}

/**
 * What would stop a send of `data` with `value` and `gasLimit` now: the wallet's balance, then a dry run. Throws
 * INSUFFICIENT_FUNDS or APPEAL_REFUSED; `maxFeePerGas` is the one the send would pay at most.
 */
async function preflight(ctx, hunter, { data, value, gasLimit, maxFeePerGas }) {
  const balance = await ctx.rpc(() => ctx.provider.getBalance(hunter));
  if (balance < value + gasLimit * maxFeePerGas) throw fail('INSUFFICIENT_FUNDS', `It needs ${formatEther(value)} ETH and its gas limit's worth of ETH, though only the gas used is paid.`);
  // the request goes to the aggregator uncaught, so its refusal reverts the call with a reason that is not the
  // contract's: still a refusal, said without the node's text (errors.js)
  await ctx.rpc(async () => {
    try {
      return await ctx.provider.call({ from: hunter, to: ctx.contract, data, value, gasLimit });
    } catch (err) {
      if (err?.code === 'CALL_EXCEPTION' && !revertReasonOf(err)) throw fail('APPEAL_REFUSED', 'The request was refused before any round started.');
      throw err;
    }
  }).catch((err) => {
    if (err.code === 'CONTRACT_REFUSED') throw fail('APPEAL_REFUSED', err.detail);
    throw err;
  });
}

/**
 * Saved bytes whose nonce is not used yet: sent again only while they would still succeed, with --yes on this run too.
 * Bytes that would not, and that the node does not hold, are forgotten, and a new call may be signed at their nonce;
 * bytes the node holds stay saved, and the run stops until their nonce is used: a second call signed meanwhile would
 * queue behind them.
 * @returns {Promise<object|null>} the result, or null when the saved bytes were forgotten
 */
async function resumeUnmined(ctx, claimId, hunter, acknowledge, store, saved) {
  const now = await readAppeal(ctx, claimId);
  const tx = Transaction.from(saved.raw);
  let still = now.action === saved.action && tx.value >= now.valueWei;
  if (still) {
    try {
      await preflight(ctx, hunter, { data: tx.data, value: tx.value, gasLimit: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas ?? 0n });
    } catch (err) {
      if (err.code !== 'APPEAL_REFUSED' && err.code !== 'INSUFFICIENT_FUNDS') throw err;
      still = false;
      if (!(await ctx.rpc(() => ctx.provider.getTransaction(saved.hash)))) {
        store.save(null);
        throw err;
      }
    }
  }
  if (!still) {
    if (await ctx.rpc(() => ctx.provider.getTransaction(saved.hash))) throw fail('WALLET_BUSY', `The saved ${saved.action}, transaction ${saved.hash}, can no longer succeed and is still pending: once its nonce is used, run appeal again.`);
    store.save(null);
    return null;
  }
  // the bytes a run that had --yes signed: sent again only with --yes on this run too
  ctx.notice(appealNotice({ ...now, valueWei: tx.value }));
  if (!acknowledge) throw fail('NEEDS_ACKNOWLEDGEMENT');
  const r = await ctx.settleSaved(saved);
  store.save(null);
  return resultOf(ctx, claimId, saved, r);
}

/** One appeal or re-trigger: a saved one first, else read, check, say the cost, and send only with acknowledge. */
async function appealOnce(ctx, claimId, hunter, acknowledge, store) {
  const saved = store?.saved?.raw ? store.saved : null;
  if (saved) {
    const receipt = await ctx.rpc(() => ctx.provider.getTransactionReceipt(saved.hash));
    const used = Boolean(receipt) || (await ctx.rpc(() => ctx.provider.getTransactionCount(saved.from, 'latest'))) > saved.nonce;
    if (used) {
      const r = await ctx.waitMined(saved);
      store.save(null);
      return resultOf(ctx, claimId, saved, r);
    }
    const resumed = await resumeUnmined(ctx, claimId, hunter, acknowledge, store, saved);
    if (resumed) return resumed;
  }

  const a = await readAppeal(ctx, claimId);
  if (!same(a.hunter, hunter)) throw fail('NOT_YOUR_CLAIM', `Claim ${claimId}'s hunter is ${a.hunter}.`);
  if (!a.action) throw fail('NOT_APPEALABLE', a.why);
  // a transaction of this wallet still pending may be this appeal, sent by a run that kept nothing
  const [latest, pending] = await Promise.all([
    ctx.rpc(() => ctx.provider.getTransactionCount(hunter, 'latest')),
    ctx.rpc(() => ctx.provider.getTransactionCount(hunter, 'pending')),
  ]);
  if (pending > latest) throw fail('WALLET_BUSY');
  const gasLimit = (await ctx.read('SUBMISSION_GAS_NEEDED')) + APPEAL_OWN_GAS;
  const fee = await ctx.feeCap();
  const data = ctx.encode(a.action, [claimId]);
  await preflight(ctx, hunter, { data, value: a.valueWei, gasLimit, maxFeePerGas: fee.maxFeePerGas });
  // Before anything is signed, and on every run from which one may go out.
  ctx.notice(appealNotice(a));
  if (!acknowledge) throw fail('NEEDS_ACKNOWLEDGEMENT');
  const rec = { ...(await ctx.sign({ data, value: a.valueWei, gasLimit })), action: a.action };
  store?.save(rec);
  await ctx.broadcast(rec);
  const r = await ctx.waitMined(rec);
  store?.save(null);
  return resultOf(ctx, claimId, rec, r);
}

/**
 * appeal, or the appeal's re-trigger, whichever the claim allows now.
 * @param {{ claimId?: bigint, claimDir?: string, acknowledge?: boolean }} o
 * @returns {Promise<{ action: 'appeal'|'retrigger', claimId: bigint, tx: string, valueWei: bigint, state: string, disputeKind: string, dispute: string, next: string }>}
 */
export async function runAppeal(ctx, { claimId, claimDir, acknowledge = false }) {
  const hunter = await ctx.hunterAddress();
  // What it costs must reach someone: a library caller gives it somewhere to go.
  if (!ctx.onNotice) throw fail('USAGE', 'appeal needs onNotice, for what must be said before anyone pays.');
  await ctx.ensureChain();
  if (claimDir === undefined || claimDir === null) {
    if (claimId === undefined || claimId === null) throw fail('USAGE', 'appeal needs a claim folder or a claim id.');
    return appealOnce(ctx, BigInt(claimId), hunter, acknowledge, null);
  }
  const ws = openWorkspace(claimDir);
  if (!ws.exists()) throw fail('NO_CLAIM_HERE');
  return ws.withLock(async () => {
    const state = ws.loadState();
    if (!state?.claimId) throw fail('NO_CLAIM_HERE', 'No claim id is saved yet.');
    checkBinding(state, bindingOf(ctx, hunter));
    const store = {
      saved: state.appealTx ?? null,
      save: (rec) => ws.saveState({ ...ws.loadState(), appealTx: rec }),
    };
    return appealOnce(ctx, BigInt(state.claimId), hunter, acknowledge, store);
  });
}
