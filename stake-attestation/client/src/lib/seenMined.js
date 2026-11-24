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
