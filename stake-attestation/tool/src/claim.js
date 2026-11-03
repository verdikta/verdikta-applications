// claim: finalize, settle and withdraw, each its own library call, and the verb that does whichever is due. All of
// them may be called by anyone and read the chain for where things stand, so a crash needs no saved state: a re-run
// sees what is done and goes on. The contract's reason for refusing is passed on, as `NOT_READY`.
import { CLAIM_STATES, OUTCOMES } from './abi.js';
import { fail } from './errors.js';
import { claimIdOf, runStatus } from './status.js';

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

export async function runSettle(ctx, claimId) {
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

/** Whatever is due, in order. @returns {Promise<{ sent: object[], state: string, next: string }>} */
export async function runClaim(ctx, { claimId, claimDir }) {
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
  if (s.state === 'Judged' && s.times.settleableAt !== 0n && s.times.settleableAt <= s.chainTime) await unlessBeaten(() => runSettle(ctx, id));
  if (await ctx.read('withdrawable', [hunter]) > 0n) sent.push(await runWithdraw(ctx));
  return { ...s, sent };
}
