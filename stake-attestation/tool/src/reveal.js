// reveal (design §14). The plaintext becomes public the moment it is pinned, so everything that could stop the
// reveal comes first, measured: the lens's state, commit order, the deadline, the wallet's balance, the disk against
// the chain's hashes, the arbiters' disclosure gate on those bytes, and a dry run of the call at the send's own gas
// limit and value. The dry run carries zero keys and a stand-in CID: the contract reads neither, and no RPC sees a
// real key before the plaintext is out. Only the signed reveal carries them, and it is saved before it is sent.
import { CLAIM_STATES, EXPIRIES } from './abi.js';
import { bindingOf, checkBinding, pinVerified, readBack, readProvenFiles } from './commit.js';
import { fail } from './errors.js';
import { rawCid, sha256Hex0x } from './ipfs.js';
import { failedRoundNext } from './status.js';
import { openWorkspace } from './workspace.js';

const ZERO_KEY16 = `0x${'00'.repeat(16)}`;
const ZERO_KEY32 = `0x${'00'.repeat(32)}`;
/** Above SUBMISSION_GAS_NEEDED: the reveal's own work (measured 530k, more with prior findings). Only gas used is paid. */
const REVEAL_OWN_GAS = 1_750_000n;

async function outcomeOf(ctx, state, topUpWei = null) {
  const [claim, lens] = await Promise.all([ctx.readSettled('getClaim', [state.claimId]), ctx.read('claimState', [state.claimId])]);
  const name = CLAIM_STATES[Number(lens)];
  return {
    claimId: BigInt(state.claimId),
    state: name,
    bcid: claim.bcid,
    requestId: claim.requestId,
    topUpWei,
    tx: state.revealTx?.hash ?? null,
    next: name === 'RoundFailed' ? failedRoundNext({ deadline: await ctx.read('retriggerDeadline', [state.claimId]), requestId: claim.requestId, roundStarted: claim.roundStarted }) : 'status --wait polls the evaluation, for up to 15 minutes.',
  };
}

async function ensureServed(ctx, cid, bytes, sha256, name) {
  try {
    await readBack(ctx, cid, bytes, sha256);
  } catch (err) {
    if (err.code !== 'PIN_NOT_READABLE') throw err;
    const again = await pinVerified(ctx, bytes, sha256, { name });
    if (again !== cid) throw fail('CIPHERTEXT_CID_DIFFERS', `${again}, not ${cid}.`);
  }
}

async function retrigger(ctx, ws, state) {
  const rec0 = state.retriggerTx;
  if (rec0?.raw) {
    await ctx.settleSaved(rec0);
    const after = { ...state, retriggerTx: null };
    ws.saveState(after);
    return outcomeOf(ctx, after);
  }
  const { archive, ciphertext } = readProvenFiles(ctx, ws, state);
  const claim = await ctx.read('getClaim', [state.claimId]);
  await ensureServed(ctx, claim.ciphertextCid, ciphertext, claim.ciphertextSha256, 'ciphertext.age');
  await ensureServed(ctx, claim.bcid, archive, claim.archiveHash, 'archive.zip');
  const topUp = await ctx.read('retriggerTopUp', [state.claimId]);
  const gasLimit = (await ctx.read('SUBMISSION_GAS_NEEDED')) + REVEAL_OWN_GAS;
  const data = ctx.encode('retrigger', [state.claimId]);
  await ctx.dryRun({ data, value: topUp, gasLimit }).catch((err) => {
    if (err.code === 'CONTRACT_REFUSED') throw fail('RETRIGGER_REFUSED', err.detail);
    throw err;
  });
  const rec = await ctx.sign({ data, value: topUp, gasLimit });
  const next = { ...state, retriggerTx: rec };
  ws.saveState(next);
  await ctx.broadcast(rec);
  await ctx.waitMined(rec);
  const after = { ...next, retriggerTx: null };
  ws.saveState(after);
  return outcomeOf(ctx, after, topUp);
}

/** reveal, or a resume of one. `retrigger`: send a failed round again instead. */
export async function runReveal(ctx, { claimDir, retrigger: wantRetrigger = false }) {
  const hunter = await ctx.hunterAddress();
  await ctx.ensureChain();
  const ws = openWorkspace(claimDir);
  if (!ws.exists()) throw fail('NO_CLAIM_HERE');
  return ws.withLock(async () => {
    let state = ws.loadState();
    if (!state) throw fail('NO_CLAIM_HERE');
    checkBinding(state, bindingOf(ctx, hunter));
    if (!state.claimId) throw fail('NOT_DISCLOSED', 'Nothing has been committed yet: run commit again.');

    let lens = CLAIM_STATES[Number(await ctx.readSettled('claimState', [state.claimId]))];
    if (lens === 'RoundFailed') return wantRetrigger ? retrigger(ctx, ws, state) : outcomeOf(ctx, state);
    if (lens === 'Expired') {
      const c = await ctx.read('getClaim', [state.claimId]);
      throw fail('CLAIM_ENDED', `Expired: ${EXPIRIES[Number(c.expiry)]}.`);
    }

    // A reveal already signed decides first: it is the same call, at its nonce.
    if (state.revealTx?.raw && (lens === 'Committed' || lens === 'Revealable')) {
      const { receipt, gone } = await ctx.settleSaved(state.revealTx);
      if (receipt?.status === 1) await ctx.step('reveal:mined');
      lens = CLAIM_STATES[Number(await ctx.readSettled('claimState', [state.claimId]))];
      if (lens !== 'Committed' && lens !== 'Revealable') {
        state = { ...state, stage: 'revealed', revealTx: { hash: state.revealTx.hash } };
        ws.saveState(state);
        await ctx.step('reveal:saved');
        return outcomeOf(ctx, state);
      }
      const hash = state.revealTx.hash;
      state = { ...state, revealTx: null };
      ws.saveState(state);
      if (!gone) throw fail('REVEAL_REVERTED', `Transaction ${hash}.`);
    }
    if (lens !== 'Committed' && lens !== 'Revealable') {
      if (state.stage !== 'revealed') {
        state = { ...state, stage: 'revealed', revealTx: state.revealTx?.hash ? { hash: state.revealTx.hash } : null };
        ws.saveState(state);
      }
      return outcomeOf(ctx, state);
    }

    // At one block: what the claim is, where it stands in order, and when.
    const block = await ctx.rpc(() => ctx.provider.getBlock('latest'));
    const at = { blockTag: block.number };
    const claim = await ctx.read('getClaim', [state.claimId], at);
    const stateNow = CLAIM_STATES[Number(await ctx.read('claimState', [state.claimId], at))];
    if (claim.disclosedAt === 0n) throw fail('NOT_DISCLOSED', `Claim ${state.claimId}.`);
    const times = await ctx.read('claimTimes', [state.claimId], at);
    if (stateNow === 'Committed') throw fail('NOT_REVEALABLE_YET', `It is revealable after ${times.revealableAt} on the chain's clock.`);
    const l = await ctx.read('getListing', [claim.listingId], at);
    if (String(l.headClaim) !== String(state.claimId)) throw fail('OUT_OF_ORDER', `Claim ${l.headClaim} comes first.`);
    if (times.revealDeadline !== 0n && BigInt(block.timestamp) >= times.revealDeadline) throw fail('REVEAL_WINDOW_OVER', `It ended at ${times.revealDeadline} on the chain's clock.`);

    // The disk against the chain, and the arbiters' gate on the disk.
    const { archive, ciphertext, keys } = readProvenFiles(ctx, ws, state);
    if (sha256Hex0x(archive) !== claim.archiveHash) throw fail('FILE_CHANGED', 'archive.zip');
    if (sha256Hex0x(ciphertext) !== claim.ciphertextSha256) throw fail('FILE_CHANGED', 'ciphertext.age');
    if (l.disclosureKey.toLowerCase() !== state.disclosureKey.toLowerCase()) throw fail('CLAIM_MISMATCH', 'The listing holds another disclosure key.');
    await ctx.step('reveal:verified');
    await ensureServed(ctx, claim.ciphertextCid, ciphertext, claim.ciphertextSha256, 'ciphertext.age');

    // Everything that could stop it, before the plaintext is out.
    const gasLimit = (await ctx.read('SUBMISSION_GAS_NEEDED')) + REVEAL_OWN_GAS;
    const topUp = await ctx.read('revealTopUp', [state.claimId]);
    const fee = await ctx.feeCap();
    const balance = await ctx.rpc(() => ctx.provider.getBalance(hunter));
    if (balance < topUp + gasLimit * fee.maxFeePerGas) throw fail('INSUFFICIENT_FUNDS', 'A reveal needs its top-up and its gas limit\'s worth of ETH, though only the gas used is paid.');
    await ctx.dryRun({ data: ctx.encode('reveal', [state.claimId, rawCid(archive), ZERO_KEY16, ZERO_KEY32]), value: topUp, gasLimit }).catch((err) => {
      if (err.code === 'CONTRACT_REFUSED') throw fail('REVEAL_REFUSED', err.detail);
      throw err;
    });

    let cid = state.bcid ?? null;
    if (cid) {
      try {
        await readBack(ctx, cid, archive, claim.archiveHash);
      } catch (err) {
        if (err.code !== 'PIN_NOT_READABLE') throw err;
        cid = null;
      }
    }
    if (!cid) {
      cid = await pinVerified(ctx, archive, claim.archiveHash, { name: 'archive.zip', onUploaded: () => ctx.step('reveal:pinned') });
      await ctx.step('reveal:read-back');
      state = { ...state, stage: 'reveal-pinned', bcid: cid };
      ws.saveState(state);
      await ctx.step('reveal:cid-saved');
    }

    const liveTopUp = await ctx.read('revealTopUp', [state.claimId]);
    const rec = await ctx.sign({ data: ctx.encode('reveal', [state.claimId, cid, keys.contentKey, keys.ephemeralKey]), value: liveTopUp, gasLimit });
    state = { ...state, stage: 'reveal-signed', revealTx: rec };
    ws.saveState(state);
    await ctx.step('reveal:signed');
    await ctx.broadcast(rec);
    await ctx.step('reveal:sent');
    const { receipt } = await ctx.waitMined(rec);
    if (receipt?.status === 1) await ctx.step('reveal:mined');
    const after = CLAIM_STATES[Number(await ctx.readSettled('claimState', [state.claimId]))];
    if (after === 'Committed' || after === 'Revealable') {
      const hash = rec.hash;
      state = { ...state, stage: 'reveal-pinned', revealTx: null };
      ws.saveState(state);
      throw fail('REVEAL_REVERTED', `Transaction ${hash}.`);
    }
    state = { ...state, stage: 'revealed', revealTx: { hash: rec.hash } };
    ws.saveState(state);
    await ctx.step('reveal:saved');
    return outcomeOf(ctx, state, liveTopUp);
  });
}
