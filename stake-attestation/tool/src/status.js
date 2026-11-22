// status: what a claim is and what comes next, on the chain's clock, read at one block. --wait polls a pending
// evaluation for up to 15 minutes (design §11). The contract never hears from the aggregator (erratum E4), so a
// round that is over stays Revealed until someone finalizes it: the watch asks for that with a dry run of finalize.
// The watch is bounded while a read hangs: each read gets at most the time left, and none starts after it.
//
// A round that is over is read the way finalize reads it (node P32): the aggregator's result, judged by the lens's
// judgeVector, or with none the aggregator's own status of the round. So a round with no verdict reads as failed
// from the moment the aggregator's rule says so, before anyone finalizes it, and an open round, however slow, never
// does: the dry run of finalize is refused while the aggregator still waits for it. Nothing here reads a clock.
//
// The reveal deadline is the lens's. A release (or a roll-forward) ends the fix window early, and the deadline moves
// with it: status says so against what commit printed and recorded in state.json (`told`), and claims no move when
// nothing was recorded, by a claim id or from an older folder.
//
// A judged claim's evidence comes from the first block of its upload's `justification`, and only that block
// (external-adapter/README.md): jury text follows it and can say anything. Every field is held to the form the
// block's writer gives it, so nothing else from an upload reaches a hunter's terminal. The chain says the outcome;
// the block only says why.
import { MAX_JUSTIFICATION_UPLOAD_BYTES, justificationCidOf, readExecutionEvidence as readEvidenceBlock } from '@verdikta/stake-attestation-shared/execution-evidence';

import { formatEther } from 'ethers';

import { CLAIM_STATES, DISPUTE_KINDS, DISPUTE_RESULTS, EXPIRIES, OUTCOMES } from './abi.js';
import { codeReview } from './common.js';
import { within } from './context.js';
import { fail } from './errors.js';
import { gatewayGet } from './ipfs.js';
import { ABSTAIN_COSTS, noVerdictMeans, RETRIGGER_SAME_CLAIM } from './notices.js';
import { findSettlement, unreadSettlement } from './settlement.js';
import { openWorkspace } from './workspace.js';

const ZERO_ID = /^0x0+$/;
const eth = (wei) => `${formatEther(wei)} ETH`;

export const WATCH_MAX_MS = 15 * 60 * 1000;
const WATCH_POLL_MS = 15_000;

export { justificationCidOf };

/** The block at the very start of a justification, if that is what is there (shared/src/executionEvidence.js). */
export const readExecutionEvidence = (justification) => readEvidenceBlock(justification, { integrityChecks: codeReview.INTEGRITY_CHECKS });

async function readEvidence(ctx, claim, live = () => true) {
  if (!ctx.gateway) return null;
  const disputed = DISPUTE_RESULTS[Number(claim.dispute)];
  const requestId = disputed === 'Held' || disputed === 'Overturned' ? claim.disputeRequestId : claim.requestId;
  if (!requestId || ZERO_ID.test(requestId)) return null;
  try {
    const aggregator = await ctx.aggregator();
    if (!live()) return null;
    const { justificationCID } = await ctx.rpc(() => aggregator.getEvaluation(requestId));
    const cid = justificationCidOf(justificationCID);
    if (!cid || !live()) return null;
    const bytes = await gatewayGet(ctx.gateway, cid, { maxBytes: MAX_JUSTIFICATION_UPLOAD_BYTES, timeoutMs: Math.min(ctx.readTimeoutMs, 30_000), fetchImpl: ctx.fetch });
    return readExecutionEvidence(JSON.parse(bytes.toString('utf8'))?.justification);
  } catch {
    return null; // it explains the outcome; the chain holds the outcome either way
  }
}

/** What a failed round cost, from its own numbers (node P32): what the aggregator says it spent, or the prepay alone. */
export function roundCostText({ prepayWei = null, spentWei = null, refundWei = null } = {}, { recorded = true } = {}) {
  if (prepayWei === null || prepayWei === undefined) return '';
  const back = recorded ? 'came back to you at finalize' : 'comes back to you at finalize';
  if (spentWei === null || spentWei === undefined) return `This round's prepay was ${eth(prepayWei)}: its base fees came out of it, and the rest ${back}; the aggregator does not say how much of it the base fees took.`;
  return `This round's prepay was ${eth(prepayWei)}: its base fees took ${eth(spentWei)}, and the other ${eth(refundWei)} ${back}.`;
}

/**
 * Design §12 and erratum E6, for a claim's round with no verdict: in RoundFailed, or over at the aggregator and not yet
 * finalized (`recorded` false, node P32). The money depends on which kind of failure it was. What status read of it,
 * when it has: the re-trigger's quote, the window a deadline not yet set runs for, the round's cost and its timeout.
 * @param {{ deadline: bigint|null, requestId: string, roundStarted: boolean, recorded?: boolean, window?: bigint|null, retriggerWei?: bigint|null, cost?: object|null, timeoutSeconds?: bigint|null }} o
 */
export function failedRoundNext({ deadline, requestId, roundStarted, recorded = true, window = null, retriggerWei = null, cost = null, timeoutSeconds = null }) {
  const refused = ZERO_ID.test(String(requestId));
  const span = window === null || window === undefined ? 'the listing\'s reveal window' : `${window} s`;
  const when = deadline ? `before ${deadline} on the chain's clock` : `within ${span} of when finalize records the round as failed`;
  const quote = retriggerWei === null || retriggerWei === undefined ? '' : ` It sends ${eth(retriggerWei)} now, the contract's quote.`;
  if (refused && !roundStarted) return `The aggregator refused the request, so no round ran and nothing was spent: it holds no fault of your claim's. reveal --retrigger says what that costs and, with --yes, sends it again ${when}: only what the live fee has risen by.${quote} If every attempt is refused, anyone may expire the claim from then on, and the bond and the prepay come back to you.`;
  if (refused) return `The aggregator refused this attempt, so the prepay is still held. An earlier round ran: ${ABSTAIN_COSTS} reveal --retrigger says what it costs and, with --yes, sends it again ${when}.${quote}`;
  const head = recorded ? 'The round ended with no verdict: the claim is RoundFailed.' : 'The round ended with no verdict: the aggregator\'s time for it is over, and finalize records the claim as RoundFailed.';
  return [
    head,
    `It may be your proof or a host. ${noVerdictMeans(timeoutSeconds)}`,
    roundCostText(cost ?? {}, { recorded }),
    ABSTAIN_COSTS,
    RETRIGGER_SAME_CLAIM,
    // nothing re-triggers a round finalize has not recorded (R1-F2): claim records it, as anyone may, the keeper too
    recorded ? '' : 'Run claim to record it as failed now (anyone may, and the site\'s keeper does); until then reveal --retrigger has nothing to send.',
    `${recorded ? '' : 'Then '}reveal --retrigger says what it costs and, with --yes, sends the round again, with a fresh prepay, ${when}.${quote}`,
  ].filter(Boolean).join(' ');
}

// `live` says whether anyone still wants this answer: a read abandoned at the deadline starts nothing more.
export async function snapshot(ctx, claimId, live = () => true) {
  const step = (fn) => {
    if (!live()) throw fail('RPC_UNAVAILABLE', 'The time given is over.');
    return fn();
  };
  const block = await step(() => ctx.rpc(() => ctx.provider.getBlock('latest')));
  const at = { blockTag: block.number };
  const read = (name) => step(() => ctx.read(name, [claimId], at));
  const claim = await read('getClaim');
  const lens = CLAIM_STATES[Number(await read('claimState'))];
  const times = await read('claimTimes');
  const judged = lens === 'Judged' || lens === 'Settled' || lens === 'Disputed';
  const settleableAt = lens === 'Judged' ? await read('settleableAt') : 0n;
  const disputeDeadline = lens === 'Judged' ? await read('disputeDeadline') : 0n;
  // a failed claim round's, or (erratum E7) the one re-trigger of an appeal whose round settled no verdict
  const retriggerDeadline = lens === 'RoundFailed' || lens === 'Judged' ? await read('retriggerDeadline') : 0n;
  // the settlement safeguards (errata E7-E9), each from the lens: the appeal window, the confirmation's
  // window, and whether the vector is a narrow INVALID under the listing's floor (judgeVector)
  const appealDeadline = lens === 'Judged' ? await read('appealDeadline') : 0n;
  const [confirmOpensAt, confirmDeadline] = lens === 'Judged' || lens === 'Disputed' ? await read('confirmWindow') : [0n, 0n];
  const outcome = judged ? OUTCOMES[Number(claim.outcome)] : null;
  // Claims on a listing reveal in commit order (decision D5): while this one is still to be revealed and another
  // heads the listing's queue, that one comes first, whatever this claim's own fix window says.
  let waitsFor = null;
  if ((lens === 'Committed' || lens === 'Revealable') && claim.disclosedAt !== 0n) {
    const { headClaim } = await step(() => ctx.read('getListing', [claim.listingId], at));
    if (headClaim !== 0n && headClaim !== BigInt(claimId)) waitsFor = headClaim;
  }
  let narrow = null;
  if (outcome === 'INVALID') {
    const j = await step(() => ctx.read('judgeVector', [claim.listingId, [...claim.vector].map(BigInt)], at));
    narrow = j.wellFormed ? j.narrow : null;
  }
  // settle's own rule for the bond, once it has run: an INVALID's to the maker unless narrow (erratum E8)
  const bond = lens === 'Settled' ? (outcome === 'INVALID' && narrow !== true ? 'forfeited' : 'returned') : null;
  return {
    claimId: BigInt(claimId),
    listingId: claim.listingId,
    hunter: claim.hunter,
    state: lens,
    chainTime: BigInt(block.timestamp),
    outcome,
    expiry: lens === 'Expired' ? EXPIRIES[Number(claim.expiry)] : null,
    dispute: DISPUTE_RESULTS[Number(claim.dispute)],
    disputeKind: DISPUTE_KINDS[Number(claim.disputeKind)],
    late: claim.late,
    narrow,
    bond,
    disclosedAt: claim.disclosedAt,
    ciphertextCid: claim.ciphertextCid,
    bcid: claim.bcid,
    requestId: claim.requestId,
    bondWei: claim.bondWei,
    prepayWei: claim.prepayWei,
    paidWei: claim.paidWei,
    owedWei: claim.owedWei,
    flaggedBadDisclosure: claim.flaggedBadDisclosure,
    released: claim.released,
    times: {
      discloseDeadline: times.discloseDeadline,
      revealableAt: times.revealableAt,
      revealDeadline: times.revealDeadline,
      settleableAt,
      disputeDeadline,
      retriggerDeadline,
      appealDeadline,
      confirmOpensAt,
      confirmDeadline,
    },
    // node P32: a Committed claim is either undisclosed or disclosed and in its fix window; status says which
    disclosed: claim.disclosedAt !== 0n,
    inFixWindow: lens === 'Committed' && claim.disclosedAt !== 0n && BigInt(block.timestamp) < times.revealableAt,
    // the earliest claim on the listing neither settled nor expired, when it is another: this one reveals after it
    waitsFor,
    pending: lens === 'Revealed' || lens === 'Disputed',
    ready: null,
    // what finalize would record for a round that is over (readNow): 'verdict', 'noVerdict', or null
    roundResult: null,
    // the claim's own round ended with no verdict, finalized (RoundFailed) or not yet
    roundFailed: lens === 'RoundFailed',
    failedRound: null,
    revealDeadlineMoved: null,
    timedOut: false,
    evidence: null,
    roundStarted: claim.roundStarted,
    raw: claim,
    block: block.number,
  };
}

async function finalizeReady(ctx, claimId, blockTag) {
  try {
    await ctx.rpc(() => ctx.provider.call({ to: ctx.contract, data: ctx.encode('finalize', [claimId]), blockTag }));
    return true;
  } catch (err) {
    if (err.code === 'CONTRACT_REFUSED') return false;
    throw err;
  }
}

/**
 * What finalize will record for a round its dry run says is over, read as finalize's _poll reads it (node P32): the
 * aggregator's result, judged by the lens (judgeVector, ClaimRules.judge); with none, a round the aggregator has
 * settled is one with no verdict, and one it has not settled yet (finalize settles it there, past its timeout) fails
 * with too few commits or reveals. With enough of both the aggregator finishes it normally, and only finalize can
 * tell: null. Every read is at the snapshot's block.
 */
async function roundResultOf(ctx, s, live) {
  const at = { blockTag: s.block };
  const step = (fn) => {
    if (!live()) throw fail('RPC_UNAVAILABLE', 'The time given is over.');
    return fn();
  };
  const requestId = s.state === 'Disputed' ? s.raw.disputeRequestId : s.requestId;
  const aggregator = await step(() => ctx.aggregator());
  const [likelihoods, , exists] = await step(() => ctx.rpc(() => aggregator.getEvaluation(requestId, at)));
  if (exists) {
    const judged = await step(() => ctx.read('judgeVector', [s.listingId, [...likelihoods].map(BigInt)], at));
    return judged.wellFormed ? 'verdict' : 'noVerdict';
  }
  const round = await step(() => ctx.rpc(() => aggregator.getAggregationStatus(requestId, at)));
  if (round.isComplete) return 'noVerdict';
  return !round.commitPhaseComplete || round.responseCount < round.requiredN ? 'noVerdict' : null;
}

const PANEL_ROUND = Object.freeze({ Maker: 'The maker\'s dispute round', Confirmation: 'The dispute panel\'s confirmation round', Appeal: 'Your appeal\'s round' });

/** A Judged claim: what may come next, by the lens's times (errata E7-E9). */
function judgedNext(s) {
  const t = s.times;
  const head = `Judged ${s.outcome}${s.narrow ? ', a narrow INVALID: if it stands, the bond comes back' : ''}.`;
  if (s.outcome === 'INVALID' && t.appealDeadline > s.chainTime) {
    return `${head} You may appeal it to the dispute panel until ${t.appealDeadline} on the chain's clock: appeal shows what it costs (the live dispute fee) and sends it with --yes. Anyone may settle it from then. Settling it yourself before then waives the appeal: claim --waive-appeal does that.`;
  }
  if (s.outcome === 'INVALID' && s.disputeKind === 'Appeal' && s.dispute === 'NoVerdict' && t.retriggerDeadline > s.chainTime) {
    return `${head} Your appeal's round settled no verdict. appeal re-triggers it once, for a fresh fee in full, before ${t.retriggerDeadline} on the chain's clock. Anyone may settle the INVALID from then; settling it yourself before then waives the re-trigger: claim --waive-appeal does that.`;
  }
  if (t.confirmDeadline !== 0n) {
    if (s.chainTime < t.confirmOpensAt) return `${head} The award is above the listing's confirmation size, so the dispute panel confirms it before it pays: a round may start from ${t.confirmOpensAt} on the chain's clock, the end of the dispute window (anyone may call confirm, and the site's keeper does). If no round returns a verdict, the first verdict pays from ${t.confirmDeadline}.`;
    if (s.chainTime < t.confirmDeadline) return `${head} It awaits the dispute panel's confirmation: anyone may call confirm until ${t.confirmDeadline} on the chain's clock, and the site's keeper does. If no round returns a verdict, the first verdict pays from then.`;
    return `${head} The confirmation deadline has passed with no verdict from the dispute panel: run claim to settle the first verdict.`;
  }
  if (t.settleableAt > s.chainTime) return `${head} The dispute window runs until ${t.settleableAt} on the chain's clock; run claim after that to settle.`;
  return `${head} Run claim to settle.`;
}

/**
 * The reveal deadline against what commit printed and recorded (`told`, node P32): moved earlier, with why from the
 * chain, or null. Only while the deadline matters (Committed, Revealable), and never without a record.
 */
function movedOf(s, told, listing) {
  if (!told || (s.state !== 'Committed' && s.state !== 'Revealable')) return null;
  const from = BigInt(told.revealDeadline ?? 0);
  const toldRevealable = BigInt(told.revealableAt ?? 0);
  if (from === 0n || toldRevealable === 0n) return null;
  const to = s.times.revealDeadline;
  // the deadline once this claim heads the queue; until then, the fix window's end it runs from
  const moved = to !== 0n ? to < from : s.times.revealableAt !== 0n && s.times.revealableAt < toldRevealable;
  if (!moved) return null;
  const rolledAt = BigInt(listing?.rolledAt ?? 0);
  const cause = s.released ? 'release' : rolledAt !== 0n && !s.raw.disclosedAfterRoll && rolledAt < toldRevealable ? 'rollForward' : null;
  return { from, to: to === 0n ? null : to, cause };
}

const WHY_EARLY = Object.freeze({
  release: 'the maker released the claim, which ends its fix window at once',
  rollForward: 'the maker rolled the listing forward to a fixed version, which ends the fix window of every claim disclosed before it',
});

function movedText(m) {
  const now = m.to === null ? 'it now runs from the fix window\'s new end, or from when every earlier claim on the listing has resolved, whichever is later' : `the chain says ${m.to} now`;
  return `Your reveal deadline moved earlier: commit said ${m.from}, and ${now}, because ${WHY_EARLY[m.cause] ?? 'the fix window ended early'}.`;
}

/** What the chain says of an early end to the fix window, when nothing recorded says what the hunter was told. */
function earlyEndText(s) {
  // behind an earlier claim the deadline does not run from the release: it is set once this claim heads the queue
  if (s.released) return `The maker released this claim, which ended its fix window at ${s.raw.fixWindowEnd} on the chain's clock${s.waitsFor ? '.' : ': the reveal deadline runs from then.'}`;
  return '';
}

/** What a claim behind another in commit order waits for, and that its reveal deadline is not set until then. */
function queueText(s) {
  return `Claim ${s.waitsFor} was committed on this listing before yours and is neither settled nor expired: claims reveal in commit order, so yours can be revealed only once that claim, and any claim between the two, is settled or expired. The chain sets your reveal deadline then, and until then it reads 0. If that claim is abandoned, it leaves the queue only when someone calls expire on it after its own deadline: anyone may, and this tool has no command for it.`;
}

function nextFor(s) {
  switch (s.state) {
    case 'Committed':
      if (s.disclosedAt === 0n) return `Not disclosed yet: run commit again before ${s.times.discloseDeadline} on the chain's clock, or the bond goes to the maker.`;
      return [`Disclosed, and in the fix window until ${s.times.revealableAt} on the chain's clock. Then reveal. A release by the maker ends the fix window early, and the reveal deadline with it: status says so.`, s.waitsFor ? queueText(s) : ''].filter(Boolean).join(' ');
    case 'Revealable': {
      const early = s.revealDeadlineMoved ? movedText(s.revealDeadlineMoved) : earlyEndText(s);
      const what = s.times.revealDeadline === 0n ? `The fix window is over, and the claim still waits. ${s.waitsFor ? queueText(s) : 'Revealable once every earlier claim on the listing is settled or expired.'} Run status again, and reveal once it prints a reveal deadline.` : `Run reveal before ${s.times.revealDeadline} on the chain's clock, or the bond goes to the maker: without --yes it says what it would send, and sends nothing.`;
      return [early, what].filter(Boolean).join(' ');
    }
    case 'Revealed':
    case 'Disputed': {
      const round = s.state === 'Disputed' ? `${PANEL_ROUND[s.disputeKind] ?? 'The dispute panel\'s round'}` : 'The round';
      if (s.ready === 'finalize') {
        if (s.roundFailed) return failedRoundNext({ ...failedRoundArgs(s), recorded: false });
        if (s.roundResult === 'verdict') return `${round} returned a verdict: run claim to record it, or wait for the site's keeper, who does.`;
        if (s.roundResult === 'noVerdict') return `${round} ended with no verdict: run claim to record it, and status then says what follows.`;
        return `${round} is over, and finalize decides its result: run claim to record it.`;
      }
      if (s.timedOut) return `${round} is still open after the time given. It may be running slowly; run status --wait again, and claim once it is over.`;
      return `${round} is still open: the arbiters are at work, usually for 3 to 6 minutes and at most about 15. status --wait polls it.`;
    }
    case 'Judged':
      return judgedNext(s);
    case 'Settled':
      if (s.outcome === 'INVALID') return s.bond === 'returned' ? 'Settled INVALID, a narrow INVALID: the bond came back, with no award.' : 'Settled INVALID: the bond went to the maker.';
      return s.owedWei > 0n ? `Settled ${s.outcome}, with ${s.owedWei} wei of the award still owed: the maker's next fund pays it.` : `Settled ${s.outcome}.`;
    case 'Expired':
      return `Expired (${s.expiry}).`;
    case 'RoundFailed':
      return failedRoundNext({ ...failedRoundArgs(s), deadline: s.times.retriggerDeadline, recorded: true });
    default:
      return '';
  }
}

function failedRoundArgs(s) {
  const f = s.failedRound ?? {};
  return {
    deadline: f.retriggerDeadline ?? null,
    requestId: s.requestId,
    roundStarted: s.roundStarted,
    window: f.retriggerWindow ?? null,
    retriggerWei: f.retriggerWei ?? null,
    cost: f.prepayWei === undefined ? null : { prepayWei: f.prepayWei, spentWei: f.spentWei, refundWei: f.refundWei },
    timeoutSeconds: f.responseTimeoutSeconds ?? null,
  };
}

/** A failed round as the snapshot alone knows it: what more reads add is failedRoundOf's. */
function baseFailedRound(s) {
  const recorded = s.state === 'RoundFailed';
  return {
    recorded,
    refused: recorded && ZERO_ID.test(String(s.requestId)),
    retriggerDeadline: recorded && s.times.retriggerDeadline !== 0n ? s.times.retriggerDeadline : null,
    retriggerWindow: null,
    retriggerWei: null,
    prepayWei: s.prepayWei,
    spentWei: null,
    refundWei: null,
    responseTimeoutSeconds: null,
  };
}

/**
 * A round with no verdict, from the chain (node P32): the re-trigger's quote and deadline, the lens's once finalize has
 * recorded it, and before that the live fee in full (a round that ran took its prepay: commitPrice less the bond) and
 * ClaimRules.retriggerDeadline from an earlier failure, if there was one; and what the round cost, from the
 * aggregator's own accounting of it (getEthAccounting), or the prepay alone where the aggregator has no such view.
 */
async function failedRoundOf(ctx, s, live) {
  const step = (fn) => {
    if (!live()) throw fail('RPC_UNAVAILABLE', 'The time given is over.');
    return fn();
  };
  const out = baseFailedRound(s);
  const listing = await step(() => ctx.read('getListing', [s.listingId]));
  const window = BigInt(listing.revealWindow);
  out.retriggerWindow = window;
  if (out.recorded) {
    out.retriggerWei = await step(() => ctx.read('retriggerTopUp', [s.claimId]));
  } else {
    out.retriggerWei = (await step(() => ctx.read('commitPrice', [s.listingId]))) - BigInt(listing.bondWei);
    if (BigInt(s.raw.failedAt) !== 0n) out.retriggerDeadline = BigInt(s.raw.failedAt) + window;
  }
  if (out.refused) return out;
  const aggregator = await step(() => ctx.aggregator());
  try {
    out.responseTimeoutSeconds = await step(() => ctx.rpc(() => aggregator.responseTimeoutSeconds()));
  } catch {
    out.responseTimeoutSeconds = null;
  }
  try {
    const a = await step(() => ctx.rpc(() => aggregator.getEthAccounting(s.requestId)));
    if (a.ethReceived > 0n) {
      const spent = a.baseCredited + a.bonusCredited;
      Object.assign(out, { prepayWei: a.ethReceived, spentWei: spent, refundWei: a.ethReceived - spent });
    }
  } catch {
    // an aggregator without the view, such as the mock: the prepay the claim sent, and no figure made up for the split
  }
  return out;
}

/** At most `ms` for `work(live)`; past it, or on any failure, `fallback`, and the work starts nothing more. */
function boundedOr(work, ms, fallback) {
  let wanted = true;
  return within(Promise.resolve().then(() => work(() => wanted)), ms, () => {
    wanted = false;
    return new Error('late');
  }).catch(() => fallback);
}

/**
 * A status read's answer. A Settled claim says how it settled (node P33, settlement.js): `known` when the claim verb
 * sent the settle and read it from its own receipt, else its Settled event, read side by side with the evidence so
 * that the two together take no longer than `evidenceMs`.
 */
async function finish(ctx, s, evidenceMs = ctx.readTimeoutMs, told = null, known = null) {
  const out = { ...s };
  if (out.roundFailed) out.failedRound = baseFailedRound(out);
  out.settlement = null;
  if (out.state === 'Settled') out.settlement = known ?? unreadSettlement(BigInt(out.raw.settledAt));
  if (evidenceMs > 0) {
    const settle = out.state === 'Settled' && !known ? boundedOr((live) => findSettlement(ctx, out, live), evidenceMs, out.settlement) : null;
    if (out.outcome && out.state !== 'Disputed') out.evidence = await boundedOr((live) => readEvidence(ctx, out.raw, live), evidenceMs, null);
    if (settle) out.settlement = await settle;
    if (out.roundFailed) out.failedRound = await boundedOr((live) => failedRoundOf(ctx, out, live), evidenceMs, out.failedRound);
    if (told && (out.state === 'Committed' || out.state === 'Revealable')) {
      const listing = await boundedOr((live) => (live() ? ctx.read('getListing', [out.listingId]) : null), evidenceMs, null);
      out.revealDeadlineMoved = movedOf(out, told, listing);
    }
  }
  out.next = nextFor(out);
  delete out.raw;
  delete out.block;
  return out;
}

/**
 * What commit printed of this claim's reveal and recorded in its folder (state.json `told`, node P32), or null: a claim
 * given by its id, a folder of another claim, or one an older tool committed.
 */
function toldOf(claimDir, id) {
  if (!claimDir) return null;
  try {
    const state = openWorkspace(claimDir).loadState();
    return state?.told && String(state.claimId) === String(id) ? state.told : null;
  } catch {
    return null;
  }
}

/** Resolves a folder or an id to the claim's id. */
export function claimIdOf({ claimId, claimDir }) {
  if (claimId !== undefined && claimId !== null) return BigInt(claimId);
  const ws = openWorkspace(claimDir);
  if (!ws.exists()) throw fail('NO_CLAIM_HERE');
  const state = ws.loadState();
  if (!state?.claimId) throw fail('NO_CLAIM_HERE', 'No claim id is saved yet.');
  return BigInt(state.claimId);
}

/**
 * @param {{ claimId?: bigint, claimDir?: string, wait?: boolean, maxWaitMs?: number }} o
 * @param {{ settlement?: object|null }} [sent] the claim verb's own settle, from its receipt: said as it is
 */
export async function runStatus(ctx, { claimId, claimDir, wait = false, maxWaitMs }, { settlement = null } = {}) {
  const start = ctx.now();
  const limit = Math.min(WATCH_MAX_MS, maxWaitMs ?? ctx.maxWaitMs ?? WATCH_MAX_MS);
  const left = () => start + limit - ctx.now();
  // At most the time left, for anything in a watch, and once that is gone it asks for nothing more.
  const bounded = async (work) => {
    let wanted = true;
    return within(work(() => wanted), Math.max(1, Math.min(ctx.readTimeoutMs, left())), () => {
      wanted = false;
      return fail('RPC_UNAVAILABLE', 'A read timed out.');
    });
  };
  if (!wait) {
    await ctx.ensureChain();
    const id = claimIdOf({ claimId, claimDir });
    return finish(ctx, await readNow(ctx, id), ctx.readTimeoutMs, toldOf(claimDir, id), settlement);
  }

  await bounded((live) => ctx.ensureChain(live));
  const id = claimIdOf({ claimId, claimDir });
  const told = toldOf(claimDir, id);
  const poll = ctx.pollMs ?? WATCH_POLL_MS;
  let last = null;
  for (;;) {
    if (left() <= 0) break;
    ctx.onRead?.();
    try {
      const got = await bounded((live) => readNow(ctx, id, live));
      last = got;
      if (!got.pending) return finish(ctx, got, left(), told, settlement);
    } catch (err) {
      if (err.code !== 'RPC_UNAVAILABLE') throw err;
    }
    if (left() <= 0) break;
    await ctx.sleep(Math.min(poll, left()));
  }
  if (!last) throw fail('RPC_UNAVAILABLE', 'No read answered in the time given.');
  // No more reads: the time is up, and `last` is what is known.
  const out = { ...last, pending: true, timedOut: true, settlement: null };
  out.next = nextFor(out);
  delete out.raw;
  delete out.block;
  return out;
}

/** A claim's state with its round read as status reads it (readNow), for reveal --retrigger (node P32). */
export const readClaimRound = (ctx, claimId) => readNow(ctx, BigInt(claimId));

// A pending round is over only when the chain says so: finalize's dry run passes, at the snapshot's block. Then what
// finalize would record is read from the aggregator (roundResultOf): a round with no verdict is failed from then on.
async function readNow(ctx, id, live = () => true) {
  const s = await snapshot(ctx, id, live);
  if (s.pending && live() && await finalizeReady(ctx, id, s.block)) {
    s.pending = false;
    s.ready = 'finalize';
    s.roundResult = await roundResultOf(ctx, s, live);
    s.roundFailed = s.state === 'Revealed' && s.roundResult === 'noVerdict';
  }
  return s;
}
