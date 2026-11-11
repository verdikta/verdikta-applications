// claim: finalize, settle and withdraw, each its own library call, and the verb that does whichever is due. All of
// them may be called by anyone and read the chain for where things stand, so a crash needs no saved state: a re-run
// sees what is done and goes on. The contract's reason for refusing is passed on, as `NOT_READY`.
//
// The one settle that costs the hunter something (erratum E7, node P18): until the lens's settleableAt only the
// hunter may settle a claim round's INVALID, or one whose appeal settled no verdict, and doing so waives the appeal
// (or its re-trigger). So the hunter's settle before that time says so and needs the explicit waiveAppeal
// (--waive-appeal); from that time anyone may settle, and nothing is waived.
import { CLAIM_STATES, OUTCOMES } from './abi.js';
import { fail } from './errors.js';
import { waiverNotice } from './notices.js';
import { claimIdOf, runStatus, snapshot } from './status.js';

async function send(ctx, name, args) {
  await ctx.hunterAddress();
  await ctx.ensureChain();
  const data = ctx.encode(name, args);
  try {
    return await ctx.sendSimple({ data });
  } catch (err) {
    if (err.code === 'CONTRACT_REFUSED') throw fail('NOT_READY', err.detail);
    throw err;
  }
}

async function stateAfter(ctx, claimId) {
  const claim = await ctx.readSettled('getClaim', [claimId]);
  const lens = CLAIM_STATES[Number(await ctx.read('claimState', [claimId]))];
  return { claim, state: lens };
}

export async function runFinalize(ctx, claimId) {
  const { hash } = await send(ctx, 'finalize', [claimId]);
  const { claim, state } = await stateAfter(ctx, claimId);
  return { action: 'finalize', tx: hash, claimId: BigInt(claimId), state, outcome: state === 'Judged' ? OUTCOMES[Number(claim.outcome)] : null };
}

/**
 * What settling now would waive, from a status read: null, or { what, until } when this wallet is the hunter of a
 * Judged INVALID that only its hunter may settle yet (the lens's settleableAt is still to come).
 */
export function waiverOf(s, hunter) {
  if (s.state !== 'Judged' || s.outcome !== 'INVALID' || s.times.settleableAt <= s.chainTime) return null;
  if (String(s.hunter).toLowerCase() !== String(hunter).toLowerCase()) return null;
  return { what: s.disputeKind === 'Appeal' && s.dispute === 'NoVerdict' ? 'retrigger' : 'appeal', until: s.times.settleableAt };
}

export async function runSettle(ctx, claimId, { waiveAppeal = false } = {}) {
  const hunter = await ctx.hunterAddress();
  await ctx.ensureChain();
  const waiver = waiverOf(await snapshot(ctx, claimId), hunter);
  if (waiver) {
    ctx.notice(waiverNotice(waiver));
    if (!waiveAppeal) throw fail('NEEDS_WAIVER', `Anyone may settle it from ${waiver.until} on the chain's clock.`);
  }
  const { hash } = await send(ctx, 'settle', [claimId]);
  const { claim, state } = await stateAfter(ctx, claimId);
  return { action: 'settle', tx: hash, claimId: BigInt(claimId), state, outcome: OUTCOMES[Number(claim.outcome)], paidWei: claim.paidWei, owedWei: claim.owedWei };
}

export async function runWithdraw(ctx) {
  const hunter = await ctx.hunterAddress();
  await ctx.ensureChain();
  const amount = await ctx.read('withdrawable', [hunter]);
  if (amount === 0n) throw fail('NOTHING_TO_WITHDRAW');
  const { hash } = await send(ctx, 'withdraw', []);
  return { action: 'withdraw', tx: hash, amountWei: amount };
}

/**
 * Whatever is due, in order. A settle that would waive the appeal is sent only with `waiveAppeal`; without it the
 * waiver is said, and nothing is sent. @returns {Promise<{ sent: object[], state: string, next: string }>}
 */
export async function runClaim(ctx, { claimId, claimDir, waiveAppeal = false }) {
  const hunter = await ctx.hunterAddress();
  await ctx.ensureChain();
  const id = claimIdOf({ claimId, claimDir });
  const sent = [];
  let s = await runStatus(ctx, { claimId: id });
  // Anyone may call these, and the site's keeper does: losing that race is no failure.
  const unlessBeaten = async (fn) => {
    try {
      sent.push(await fn());
    } catch (err) {
      if (err.code !== 'NOT_READY') throw err;
    }
    s = await runStatus(ctx, { claimId: id });
  };
  if (s.ready === 'finalize') await unlessBeaten(() => runFinalize(ctx, id));
  if (s.state === 'Judged' && s.times.settleableAt !== 0n && s.times.settleableAt <= s.chainTime) {
    await unlessBeaten(() => runSettle(ctx, id));
  } else {
    const waiver = waiverOf(s, hunter);
    if (waiver && waiveAppeal) await unlessBeaten(() => runSettle(ctx, id, { waiveAppeal: true }));
    else if (waiver) ctx.notice(`${waiverNotice(waiver)} claim --waive-appeal settles it now; nothing was sent.`);
  }
  if (await ctx.read('withdrawable', [hunter]) > 0n) sent.push(await runWithdraw(ctx));
  return { ...s, sent };
}
