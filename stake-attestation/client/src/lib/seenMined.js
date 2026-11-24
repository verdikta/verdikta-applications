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
 * The hash a read has at a height: its own block's at its block, and below it the one its chain gave when asked
 * (chain/snapshot.js `heights`). The one lookup, for a receipt's verdict and for what the page could not check.
 * @param {{ block: number, blockHash: string, hashes?: Record<number, string|null> }} read
 * @param {number} height
 */
export const hashAt = (read, height) => (read.block === height ? read.blockHash : read.hashes?.[height]);

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
  const hash = hashAt(read, seen.block);
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
 * is asked for no more. `onChange` is told each time a holder keeps or lets go: what the page says of its receipts
 * is drawn from who holds what (pageSays), so the page is drawn again.
 */
export function keptBlocks(onChange = () => {}) {
  const held = new Map();
  return Object.freeze({
    keep(block) {
      held.set(block, (held.get(block) ?? 0) + 1);
      onChange();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (held.get(block) > 1) held.set(block, held.get(block) - 1);
        else held.delete(block);
        onChange();
      };
    },
    blocks: () => [...held.keys()],
  });
}

/**
 * Whether a read has the hash its chain has at each of these blocks that is not above its own. No read, or one that
 * is of no block, has none.
 * @param {null | { block: number, blockHash?: string, hashes?: Record<number, string> }} read
 * @param {number[]} blocks
 */
export function hasHashAt(read, blocks) {
  if (!read || !Number.isSafeInteger(read.block)) return blocks.length === 0;
  return blocks.every((height) => height > read.block || typeof hashAt(read, height) === 'string');
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
 * A read through the wallet, just before an action, that has the listing otherwise than the page shows it: another
 * listing or none under the id, or a state in which the action cannot be taken. Nothing was sent. An action hands
 * the page this, with the block the wallet read at, where it hands a kept receipt after a transaction.
 */
export const contradictedAt = (block) => Object.freeze({ contradicted: true, block });
export const isContradiction = (told) => Boolean(told) && told.contradicted === true && Number.isSafeInteger(told.block);

/** A page that says none of it. */
export const SAYS_NOTHING = Object.freeze({ hidden: null, behind: null, unchecked: false });

/**
 * What the listing's page says of what is on it, when it is drawn: whether the listing is shown, the block the page
 * has not read, and that it could not check a transaction's block. This is the one place that decides them, and it
 * decides from what the page has at that moment, never from how a refresh happened to end: the page is drawn again
 * when a read is shown, when a receipt holder keeps or lets go, and when a refresh starts or ends.
 *
 *  - `hidden`: the listing is off the page as a whole, with the alert and Read again.
 *      'failed': the read on display failed (a block that answered what the contract never says of one block, or a
 *      node that did not answer on load). It is a read, so it is off the page at once.
 *      'contradicted': a read through the wallet contradicted the listing on display and no read has been taken
 *      since. A display the wallet's node has just contradicted is not shown, whether or not the page had read that
 *      height, and stays off the page until a read is taken, through Read again too.
 *  - `behind`: the newest block the page was told of, when the read on display is of an earlier one. Never a block
 *    the read on display is of, or an earlier one.
 *  - `unchecked`: a receipt the page holds now is at a block the read on display has no hash for. Said of a listing
 *    that is shown and read as far as the page was told: of what the page holds, not of what a refresh's reads were
 *    held to, so a receipt nothing holds any more is no reason for it, and one that arrived when no read could be
 *    taken is.
 *
 * While a refresh reads, nothing new is said of what no read has settled: the refresh may be about to settle it.
 * What the page said before that refresh began (`said`) stays said for as long as it is still so.
 * @param {object} o
 * @param {null|object} [o.read] - the read on display: the latest the page has shown (the listing, "no such
 *        listing", or a read that failed), with its block and hashes where it is of a block
 * @param {number} [o.needed] - the newest block the page was told of: a transaction it sent, or a read through the wallet
 * @param {boolean} [o.contradicted] - a read through the wallet contradicted the listing on display, and no read was taken since
 * @param {number[]} [o.blocks] - the blocks of the receipts the page holds now (keptBlocks().blocks())
 * @param {boolean} [o.reading] - a refresh is reading
 * @param {{ hidden: null|string, behind: number|null, unchecked: boolean }} [o.said] - what the page said at its
 *        last draw with no refresh reading
 * @returns {{ hidden: null|'failed'|'contradicted', behind: number|null, unchecked: boolean }}
 */
export function pageSays({ read = null, needed = 0, contradicted = false, blocks = [], reading = false, said = SAYS_NOTHING } = {}) {
  const failed = read?.failed ? 'failed' : null;
  const at = Number.isSafeInteger(read?.block) ? read.block : 0;
  const hidden = contradicted && (!reading || said.hidden === 'contradicted') ? 'contradicted' : failed;
  const behind = needed > at && (!reading || said.behind !== null) ? needed : null;
  const unchecked = hidden === null && behind === null && !hasHashAt(read, blocks) && (!reading || said.unchecked);
  return { hidden, behind, unchecked };
}
