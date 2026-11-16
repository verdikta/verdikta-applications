// A Settled claim's settle (node P33, issue #205): who sent it, its transaction and block, and the outcome, paidWei and
// owedWei of its Settled event, so a hunter whose claim the site's keeper settled need not read the contract's events.
// The amounts are the event's, as the chain wrote them at the settle: the claim's own paidWei and owedWei move on when
// the maker's next fund pays what was owed.
//
// A settle this run sent is read from its own receipt. Any other is found without a scan: settle writes its block's
// time into the claim (settledAt), so the event is in a block of that second, and only those blocks are searched.
// They are found by their timestamps, from the head down, in a bounded number of block reads, and read with
// eth_getLogs in ranges the RPC takes: a public RPC caps the range, so one it refuses is asked for again in halves.
// When the event is not in those blocks, or the RPC does not answer, the result says so, and no sender is guessed.
import { formatEther } from 'ethers';

import { OUTCOMES } from './abi.js';
import { fail } from './errors.js';

/** Who sent a claim's settle, by `settlement.by`, in the words the tool prints (agents.txt §3 step 8 names each). */
export const SETTLED_BY = Object.freeze({
  thisRun: 'this run',
  hunter: 'the hunter\'s own address',
  other: 'another address',
});

/** The most block reads that find the blocks of the settle's second, and the most eth_getLogs that read them. */
export const MAX_BLOCK_READS = 64;
export const MAX_LOG_READS = 64;
/** The first step down from the head when no block before the settle is known yet. */
const FIRST_STEP_BLOCKS = 1024;

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function found({ by, from, tx, block, args, settledAt }) {
  return {
    found: true,
    by,
    from,
    tx,
    block,
    outcome: OUTCOMES[Number(args.outcome)],
    paidWei: args.paidWei,
    owedWei: args.owedWei,
    paidEth: formatEther(args.paidWei),
    owedEth: formatEther(args.owedWei),
    settledAt,
  };
}

const notFound = (reason, settledAt, searched = null) => ({ found: false, reason, settledAt, searched });

/** What is said when the search did not finish: the RPC failed, or the time given ran out. */
export const unreadSettlement = (settledAt) => notFound('unread', settledAt);

/** The claim's Settled event among `logs`, as the contract emitted it, or null. */
function settledIn(ctx, logs, claimId) {
  for (const log of logs ?? []) {
    if (!same(log.address, ctx.contract)) continue;
    const e = ctx.parseLog(log);
    if (e?.name === 'Settled' && e.args.claimId === BigInt(claimId)) return { log, args: e.args };
  }
  return null;
}

/** A settle this run sent, from its own receipt: null if the receipt holds no Settled event of the claim. */
export function settlementFromReceipt(ctx, receipt, claimId, settledAt) {
  const hit = settledIn(ctx, receipt?.logs, claimId);
  if (!hit) return null;
  return found({ by: 'thisRun', from: receipt.from, tx: receipt.hash, block: receipt.blockNumber, args: hit.args, settledAt });
}

/**
 * The blocks whose timestamp is `t`, at or below `head` ({ number, timestamp }): { fromBlock, toBlock }, or null when
 * no block has it. Timestamps never fall from one block to the next, and several blocks may share one (Base makes five
 * a second). The search goes down from the head, aimed by the chain's own rate between the blocks it has read and at
 * least twice as far each time, until it passes `t`; then it narrows the range to the second's first block and, the
 * same way, to its last. It reads at most MAX_BLOCK_READS blocks, and fails rather than read more.
 */
export async function blocksAt(ctx, t, head, step = (fn) => fn()) {
  if (head.timestamp < t) return null;
  const times = new Map([[head.number, head.timestamp]]);
  let reads = 0;
  const timeOf = async (n) => {
    if (times.has(n)) return times.get(n);
    reads += 1;
    if (reads > MAX_BLOCK_READS) throw fail('RPC_UNAVAILABLE', 'Finding the settle\'s blocks took too many reads.');
    const b = await step(() => ctx.rpc(() => ctx.provider.getBlock(n)));
    if (!b) throw fail('RPC_UNAVAILABLE', 'A block could not be read.');
    times.set(n, Number(b.timestamp));
    return times.get(n);
  };

  // The first block in `lo` + 1 .. `hi` whose time is at least `target`: the time of `lo` is before it, of `hi` not.
  // Each round reads the block where the range's own rate puts `target`, then the block a second's worth of blocks to
  // its other side, which closes the range around `target` when the guess was within a second; and it halves the
  // range when those two did not.
  const narrow = async (target, lo, hi) => {
    const side = async (n) => {
      if (await timeOf(n) < target) lo = n;
      else hi = n;
    };
    while (hi - lo > 1) {
      const width = hi - lo;
      const tl = times.get(lo);
      const perSecond = width / (times.get(hi) - tl); // the times differ: tl < target <= the time of hi
      const second = Math.max(1, Math.ceil(perSecond));
      const guess = Math.min(hi - 1, Math.max(lo + 1, lo + Math.round((target - tl) * perSecond)));
      await side(guess);
      const other = lo === guess ? Math.min(hi - 1, guess + second) : Math.max(lo + 1, guess - second);
      if (other > lo && other < hi) await side(other);
      if ((hi - lo) * 2 > width && hi - lo > 1) await side(lo + Math.floor((hi - lo) / 2));
    }
    return hi;
  };

  // Down from the head to a block before `t`, then up to the first block of its second.
  let upper = head.number;
  let above = null;
  let stride = FIRST_STEP_BLOCKS;
  let fromBlock = null;
  while (fromBlock === null) {
    let probe = upper - stride;
    const tu = times.get(upper);
    if (above && above.timestamp > tu) {
      // a second before `t`, at the rate between the last two blocks read
      const rate = (above.number - upper) / (above.timestamp - tu);
      probe = Math.min(probe, upper - Math.ceil((tu - t + 1) * rate));
    }
    probe = Math.max(0, probe);
    if (probe === upper) {
      fromBlock = upper; // genesis, of `t`'s second or after it
    } else if (await timeOf(probe) < t) {
      fromBlock = await narrow(t, probe, upper);
    } else if (probe === 0) {
      fromBlock = 0;
    } else {
      above = { number: upper, timestamp: tu };
      stride = (upper - probe) * 2;
      upper = probe;
    }
  }
  if (await timeOf(fromBlock) !== t) return null;
  // the last block of that second: below the first block read after it, or the head itself
  const later = [...times].filter(([n, time]) => n > fromBlock && time > t).map(([n]) => n);
  const toBlock = later.length ? (await narrow(t + 1, fromBlock, Math.min(...later))) - 1 : head.number;
  return { fromBlock, toBlock };
}

/**
 * The claim's Settled event in `fromBlock`..`toBlock`, read in ranges of at most ctx.logPageBlocks blocks. A range the
 * RPC refuses is asked for again in halves, down to one block, so a capped public RPC is read within its cap; at most
 * MAX_LOG_READS calls. Null when it is not there.
 */
async function settledLog(ctx, claimId, { fromBlock, toBlock }, step, live) {
  const topics = ctx.topics('Settled', [claimId]);
  let page = Math.max(1, Math.floor(ctx.logPageBlocks));
  let calls = 0;
  for (let from = fromBlock; from <= toBlock;) {
    const to = Math.min(toBlock, from + page - 1);
    calls += 1;
    if (calls > MAX_LOG_READS) throw fail('RPC_UNAVAILABLE', 'Reading the settle\'s blocks took too many calls.');
    let logs;
    try {
      logs = await step(() => ctx.rpc(() => ctx.provider.getLogs({ address: ctx.contract, topics, fromBlock: from, toBlock: to })));
    } catch (err) {
      if (to > from && live()) {
        page = Math.ceil((to - from + 1) / 2);
        continue;
      }
      throw err;
    }
    const hit = settledIn(ctx, logs, claimId);
    if (hit) return hit;
    from = to + 1;
  }
  return null;
}

/**
 * A Settled claim's settle, from a status read (`s`, with the snapshot's `raw` claim and `block`): its Settled event,
 * found in the blocks of the claim's settledAt, and who sent its transaction: the claim's hunter or another address.
 * Throws when the chain does not answer; the caller says that, as unreadSettlement.
 */
export async function findSettlement(ctx, s, live = () => true) {
  const step = (fn) => {
    if (!live()) throw fail('RPC_UNAVAILABLE', 'The time given is over.');
    return fn();
  };
  const settledAt = BigInt(s.raw.settledAt);
  const blocks = await blocksAt(ctx, Number(settledAt), { number: s.block, timestamp: Number(s.chainTime) }, step);
  if (!blocks) return notFound('noBlockAtTime', settledAt);
  const hit = await settledLog(ctx, s.claimId, blocks, step, live);
  if (!hit) return notFound('notInBlocks', settledAt, blocks);
  const tx = await step(() => ctx.rpc(() => ctx.provider.getTransaction(hit.log.transactionHash)));
  if (!tx?.from) throw fail('RPC_UNAVAILABLE', 'The settle transaction could not be read.');
  return found({ by: same(tx.from, s.hunter) ? 'hunter' : 'other', from: tx.from, tx: hit.log.transactionHash, block: hit.log.blockNumber, args: hit.args, settledAt });
}

const NOT_FOUND = Object.freeze({
  notInBlocks: (st) => `was not found in blocks ${st.searched.fromBlock} to ${st.searched.toBlock}, the blocks of the claim's settle time (${st.settledAt})`,
  noBlockAtTime: (st) => `was not found: no block has the claim's settle time (${st.settledAt})`,
  unread: () => 'could not be read: the search for it did not finish (the RPC failed or did not answer in the time given, or the blocks took more reads than the search allows)',
});

/** What the CLI prints of a settlement: null prints nothing. */
export function settlementLines(st) {
  if (!st) return [];
  if (st.found) {
    let who = SETTLED_BY.thisRun;
    if (st.by === 'hunter') who = `${SETTLED_BY.hunter}, ${st.from}, in an earlier run`;
    if (st.by === 'other') who = `${SETTLED_BY.other}, ${st.from}, not the hunter's (the site's keeper settles claims once they are due, and anyone may)`;
    return [
      `Settle transaction ${st.tx}, block ${st.block}, sent by ${who}`,
      `Settled event: ${st.outcome}, paid ${st.paidEth} ETH, owed ${st.owedEth} ETH`,
    ];
  }
  const why = (NOT_FOUND[st.reason] ?? NOT_FOUND.unread)(st);
  return [`The settle's Settled event ${why}, so this does not say who sent the settle or what it paid.`];
}
