// status: what a claim is and what comes next, on the chain's clock, read at one block. --wait polls a pending
// evaluation for up to 15 minutes (design §11). The contract never hears from the aggregator (erratum E4), so a
// round that is over stays Revealed until someone finalizes it: the watch asks for that with a dry run of finalize.
// The watch is bounded while a read hangs: each read gets at most the time left, and none starts after it.
//
// A judged claim's evidence comes from the first block of its upload's `justification`, and only that block
// (external-adapter/README.md): jury text follows it and can say anything. Every field is held to the form the
// block's writer gives it, so nothing else from an upload reaches a hunter's terminal. The chain says the outcome;
// the block only says why.
import { CLAIM_STATES, DISPUTE_RESULTS, EXPIRIES, OUTCOMES } from './abi.js';
import { codeReview } from './common.js';
import { within } from './context.js';
import { fail } from './errors.js';
import { gatewayGet, isCidShaped } from './ipfs.js';
import { ABSTAIN_COSTS } from './notices.js';
import { openWorkspace } from './workspace.js';

export const WATCH_MAX_MS = 15 * 60 * 1000;
const WATCH_POLL_MS = 15_000;
const EVIDENCE_HEADER = 'Execution evidence v1';
const EVIDENCE_END = 'End execution evidence';
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const NONE = /^none$/;

/** The first comma-separated CID of what the aggregator holds, in a form safe to fetch; else null. */
export function justificationCidOf(text) {
  const first = String(text ?? '').split(',')[0].split(':')[0].trim();
  return isCidShaped(first) ? first : null;
}

/**
 * The block at the very start of a justification, if that is what is there. It is the first line or it is not
 * the block, so jury text cannot stand in for it; a line that appears twice counts the first time.
 * @returns {null | { settlement: string, reportSha256: string|null, integrityFailedChecks: string[]|null, tamperFlags: string|null }}
 */
export function readExecutionEvidence(justification) {
  if (typeof justification !== 'string') return null;
  const lines = justification.split('\n');
  if (lines[0] !== EVIDENCE_HEADER) return null;
  const end = lines.indexOf(EVIDENCE_END);
  if (end < 0) return null;
  const fields = new Map();
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(': ');
    if (at > 0 && !fields.has(line.slice(0, at))) fields.set(line.slice(0, at), line.slice(at + 2));
  }
  const settlement = fields.get('Settlement');
  if (!/^(jury|DUPLICATE \(integrity\)|INVALID \([A-Za-z]{1,40}\))$/.test(settlement ?? '')) return null;
  const sha = fields.get('Report-SHA256');
  const checks = fields.get('Integrity-Failed-Checks');
  const flags = fields.get('Tamper-Flags');
  return {
    settlement,
    reportSha256: /^[0-9a-f]{64}$/.test(sha ?? '') ? sha : null,
    integrityFailedChecks: checks === undefined ? null : NONE.test(checks) ? [] : checks.split(',').filter((c) => codeReview.INTEGRITY_CHECKS.includes(c)),
    tamperFlags: /^(none|[a-z-]{1,40}=[0-9]{1,6}(,[a-z-]{1,40}=[0-9]{1,6})*)$/.test(flags ?? '') ? flags : null,
  };
}

async function readEvidence(ctx, claim, live = () => true) {
  if (!ctx.gateway) return null;
  const disputed = DISPUTE_RESULTS[Number(claim.dispute)];
  const requestId = disputed === 'Held' || disputed === 'Overturned' ? claim.disputeRequestId : claim.requestId;
  if (!requestId || /^0x0+$/.test(requestId)) return null;
  try {
    const aggregator = await ctx.aggregator();
    if (!live()) return null;
    const { justificationCID } = await ctx.rpc(() => aggregator.getEvaluation(requestId));
    const cid = justificationCidOf(justificationCID);
    if (!cid || !live()) return null;
    const bytes = await gatewayGet(ctx.gateway, cid, { maxBytes: MAX_UPLOAD_BYTES, timeoutMs: Math.min(ctx.readTimeoutMs, 30_000), fetchImpl: ctx.fetch });
    return readExecutionEvidence(JSON.parse(bytes.toString('utf8'))?.justification);
  } catch {
    return null; // it explains the outcome; the chain holds the outcome either way
  }
}

/**
 * Design §12 and erratum E6, for a claim in RoundFailed. The money depends on which kind of failure it was.
 * @param {{ deadline: bigint, requestId: string, roundStarted: boolean }} o
 */
export function failedRoundNext({ deadline, requestId, roundStarted }) {
  const refused = /^0x0+$/.test(String(requestId));
  const when = `before ${deadline} on the chain's clock`;
  if (refused && !roundStarted) return `The aggregator refused the request, so no round ran and nothing was spent: it holds no fault of your claim's. reveal --retrigger sends it again ${when}, with only what the live fee has risen by. If every attempt is refused, anyone may expire the claim from then on, and the bond and the prepay come back to you.`;
  if (refused) return `The aggregator refused this attempt, so the prepay is still held. An earlier round ran: ${ABSTAIN_COSTS} reveal --retrigger sends it again ${when}.`;
  return `The round failed, and it may be your proof or a host: ${ABSTAIN_COSTS} Run check on this claim to see whether it abstains there. reveal --retrigger sends the round again, with a fresh prepay, ${when}.`;
}

// `live` says whether anyone still wants this answer: a read abandoned at the deadline starts nothing more.
async function snapshot(ctx, claimId, live = () => true) {
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
  const retriggerDeadline = lens === 'RoundFailed' ? await read('retriggerDeadline') : 0n;
  return {
    claimId: BigInt(claimId),
    listingId: claim.listingId,
    hunter: claim.hunter,
    state: lens,
    chainTime: BigInt(block.timestamp),
    outcome: judged ? OUTCOMES[Number(claim.outcome)] : null,
    expiry: lens === 'Expired' ? EXPIRIES[Number(claim.expiry)] : null,
    dispute: DISPUTE_RESULTS[Number(claim.dispute)],
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
    },
    pending: lens === 'Revealed' || lens === 'Disputed',
    ready: null,
    timedOut: false,
    evidence: null,
    roundStarted: claim.roundStarted,
    raw: claim,
  };
}

async function finalizeReady(ctx, claimId) {
  try {
    await ctx.rpc(() => ctx.provider.call({ to: ctx.contract, data: ctx.encode('finalize', [claimId]) }));
    return true;
  } catch (err) {
    if (err.code === 'CONTRACT_REFUSED') return false;
    throw err;
  }
}

function nextFor(s) {
  switch (s.state) {
    case 'Committed':
      if (s.disclosedAt === 0n) return `Not disclosed yet: run commit again before ${s.times.discloseDeadline} on the chain's clock, or the bond goes to the maker.`;
      return `In the fix window, until ${s.times.revealableAt} on the chain's clock. Then reveal.`;
    case 'Revealable':
      return s.times.revealDeadline === 0n ? 'Revealable once every earlier claim on the listing is settled or expired: reveal then.' : `Run reveal before ${s.times.revealDeadline} on the chain's clock, or the bond goes to the maker.`;
    case 'Revealed':
    case 'Disputed':
      if (s.ready === 'finalize') return 'The round is over: run claim to record it.';
      if (s.timedOut) return 'The round is still open after the time given. It may be running slowly; run status --wait again, and claim once it is over.';
      return 'The round is still open: the arbiters are at work, usually for 3 to 6 minutes and at most about 15. status --wait polls it.';
    case 'Judged':
      if (s.times.settleableAt > s.chainTime) return `Judged ${s.outcome}. The dispute window runs until ${s.times.settleableAt} on the chain's clock; run claim after that to settle.`;
      return `Judged ${s.outcome}. Run claim to settle.`;
    case 'Settled':
      return s.owedWei > 0n ? `Settled ${s.outcome}, with ${s.owedWei} wei of the award still owed: the maker's next fund pays it.` : `Settled ${s.outcome}.`;
    case 'Expired':
      return `Expired (${s.expiry}).`;
    case 'RoundFailed':
      return failedRoundNext({ deadline: s.times.retriggerDeadline, requestId: s.requestId, roundStarted: s.roundStarted });
    default:
      return '';
  }
}

async function finish(ctx, s, evidenceMs = ctx.readTimeoutMs) {
  const out = { ...s };
  if (out.outcome && out.state !== 'Disputed' && evidenceMs > 0) {
    let wanted = true;
    out.evidence = await within(readEvidence(ctx, out.raw, () => wanted), evidenceMs, () => {
      wanted = false;
      return new Error('late');
    }).catch(() => null);
  }
  out.next = nextFor(out);
  delete out.raw;
  return out;
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

export async function runStatus(ctx, { claimId, claimDir, wait = false, maxWaitMs }) {
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
    return finish(ctx, await readNow(ctx, id));
  }

  await bounded(() => ctx.ensureChain());
  const id = claimIdOf({ claimId, claimDir });
  const poll = ctx.pollMs ?? WATCH_POLL_MS;
  let last = null;
  for (;;) {
    if (left() <= 0) break;
    ctx.onRead?.();
    try {
      const got = await bounded((live) => readNow(ctx, id, live));
      last = got;
      if (!got.pending) return finish(ctx, got, left());
    } catch (err) {
      if (err.code !== 'RPC_UNAVAILABLE') throw err;
    }
    if (left() <= 0) break;
    await ctx.sleep(Math.min(poll, left()));
  }
  if (!last) throw fail('RPC_UNAVAILABLE', 'No read answered in the time given.');
  // No more reads: the time is up, and `last` is what is known.
  const out = { ...last, pending: true, timedOut: true };
  delete out.raw;
  out.next = nextFor(out);
  return out;
}

async function readNow(ctx, id, live = () => true) {
  const s = await snapshot(ctx, id, live);
  if (s.pending && live() && await finalizeReady(ctx, id)) {
    s.pending = false;
    s.ready = 'finalize';
  }
  return s;
}
