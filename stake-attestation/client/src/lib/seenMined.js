// A transaction a page sent and saw mined, against what the page reads afterwards (node P42).
//
// The site's reader may trail the node the wallet sent through, and a block can be replaced after a wallet reported
// it. So a page that says "on hold", "rolled forward", "closed", "opened", "renewed" or "topped up" on the strength
// of a receipt says it only for as long as nothing it has read says otherwise. A block is its hash, never its number:
//   - a receipt the page keeps carries its block's number and hash (`kept`), or it is not kept at all;
//   - while the page's read is of a block before the receipt's, the receipt stands (the read says nothing of it);
//   - from a read of that block or a later one, the receipt stands only if the chain that read is of has that hash
//     at that height, and the read shows what the transaction did;
//   - once such a read said otherwise, the receipt is dropped for good. Whatever the listing becomes later (closed
//     another way, rolled to another listing, held again) is not that transaction's doing, and is never said with
//     its hash or its figures. A transaction that was included again in another block is not gone after: the page
//     then says the chain's state, without that transaction.
// The read is one snapshot of one block hash (chain/snapshot.js), which carries the hash its chain has at the height
// of each receipt the page keeps.

const HASH = /^0x[0-9a-f]{64}$/;

/**
 * A receipt to keep, with what the page will say of it: made from the receipt itself, so it cannot be without the
 * transaction's hash or the number and the hash of its block.
 * @param {{ hash: string, blockNumber: number, blockHash: string }} receipt - a mined transaction's receipt
 * @param {object} [said] - what the transaction reported (an event's time, an amount)
 * @returns {Readonly<{ tx: string, block: number, blockHash: string }>}
 */
export function kept(receipt, said = {}) {
  const block = Number(receipt?.blockNumber);
  const blockHash = String(receipt?.blockHash ?? '').toLowerCase();
  if (typeof receipt?.hash !== 'string' || !Number.isSafeInteger(block) || block < 0 || !HASH.test(blockHash)) {
    throw new TypeError('a receipt is kept with its transaction, and the number and the hash of its block');
  }
  return Object.freeze({ ...said, tx: receipt.hash, block, blockHash });
}

/** Whether `seen` is a receipt as `kept` makes them. */
export const isKept = (seen) => Boolean(seen) && typeof seen.tx === 'string' && Number.isSafeInteger(seen.block) && HASH.test(String(seen.blockHash));

/** `seen`, which must be null or a kept receipt: what a page holds of a transaction is never less than that. */
export function asKept(seen) {
  if (seen !== null && !isKept(seen)) throw new TypeError('a page keeps a receipt only with the hash of its block (lib/seenMined.js kept)');
  return seen;
}

/**
 * What a read says of a kept receipt.
 * @param {null | { block: number, blockHash: string, dropped?: boolean }} seen
 * @param {null | { block: number, blockHash: string, hashes?: Record<number, string|null> }} read - the snapshot the
 *        page's read of the listing is of (chain/snapshot.js); null: nothing read yet
 * @param {boolean} shows - whether that read shows what the transaction did
 * @returns {'stands'|'unread'|'dropped'|null} null: no receipt. 'unread': the read is of a later block and has no hash
 *          at the receipt's height (it was made before the page kept the receipt, or the node did not give that
 *          header): nothing is said on the strength of the receipt, and nothing is dropped, until a read has it. A
 *          receipt is dropped only on a hash that is another, or on a read of its own chain that does not show it.
 */
export function receiptVerdict(seen, read, shows) {
  if (seen === null) return null;
  if (seen.dropped) return 'dropped';
  if (!read || !Number.isSafeInteger(read.block) || read.block < seen.block) return 'stands';
  const hash = read.block === seen.block ? read.blockHash : read.hashes?.[seen.block];
  // no hash at that height in this read: it did not ask (it was made before the page kept the receipt), or the node
  // did not give that block's header. Neither says the block was replaced: nothing is dropped on it.
  if (typeof hash !== 'string') return 'unread';
  return hash === seen.blockHash && Boolean(shows) ? 'stands' : 'dropped';
}

/** Whether the page may still speak on the strength of the receipt. */
export const receiptStands = (seen, read, shows) => receiptVerdict(seen, read, shows) === 'stands';

/** The same receipt after a read: marked dropped, for good, once a read of its block or later says otherwise. */
export function afterRead(seen, read, shows) {
  if (seen === null || seen.dropped || receiptVerdict(seen, read, shows) !== 'dropped') return seen;
  return Object.freeze({ ...seen, dropped: true });
}

/**
 * The blocks of the receipts a page still holds. Each holder keeps its receipt's block while it holds the receipt
 * (`keep` returns what lets go of it, once), and every read of the page asks which hash its chain has at these
 * blocks and at no others: a receipt that was replaced by a later one, dropped for good, or gone with its listing
 * is asked for no more.
 */
export function keptBlocks() {
  const held = new Map();
  return Object.freeze({
    keep(block) {
      held.set(block, (held.get(block) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (held.get(block) > 1) held.set(block, held.get(block) - 1);
        else held.delete(block);
      };
    },
    blocks: () => [...held.keys()],
  });
}

/**
 * Whether a read has the hash its chain has at each of these blocks that is not above its own. No read has none.
 * @param {null | { block: number, hashes?: Record<number, string> }} read
 * @param {number[]} blocks
 */
export function hasHashAt(read, blocks) {
  if (!read) return blocks.length === 0;
  return blocks.every((height) => height > read.block || typeof read.hashes?.[height] === 'string');
}

/**
 * What one refresh of the page asks of its reads: the blocks to give the hash at, and whether a read has checked
 * them all. They are the blocks of the receipts the page holds (`registry`) and, at first, that of a receipt handed
 * to this refresh (`told`): its part holds it only from its next render on. From the first read that is held to them
 * the registry alone decides: by then the part holds the receipt, or nothing on the page does (the page came to show
 * another listing under the id) and its block is asked for no more.
 * @param {{ blocks(): number[] }} registry - keptBlocks()
 * @param {object|number} told - a kept receipt, or the number of a block
 */
export function refreshHeights(registry, told) {
  let handed = isKept(told) ? told.block : null;
  const heights = () => [...new Set([...registry.blocks(), ...(handed === null ? [] : [handed])])];
  return {
    heights,
    /** Whether a read has a hash at each of them that is not above its block. */
    checked(got) {
      const all = hasHashAt(got, heights());
      handed = null;
      return all;
    },
  };
}

/**
 * What the page says once the reading of a refresh is over, of the read it then has on display (`shown`: the newest
 * read it has shown that is of a block, or null).
 *  - `behind`: the block the page was told of (`from`) when no read of this refresh was taken (`seen`) and the page
 *    has shown no read of that block or a later one; null otherwise.
 *  - `unchecked`: a receipt the page holds now (`blocks`: keptBlocks().blocks()) is at a block the read on display
 *    has no hash for. It is said of what the page holds, not of what the reads were held to: a receipt handed over
 *    that nothing holds any more is no reason for it, and a receipt that arrived when no read could be taken (they
 *    failed, or trailed the read on display) is one.
 * @returns {{ behind: number|null, unchecked: boolean }}
 */
export function refreshNotices({ seen, from, shown, blocks }) {
  return { behind: !seen && from > (shown?.block ?? 0) ? from : null, unchecked: !hasHashAt(shown, blocks) };
}
