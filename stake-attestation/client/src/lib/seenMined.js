// A transaction a page sent and saw mined, against what the page reads afterwards (node P42).
//
// The site's reader may trail the node the wallet sent through, and a block can be replaced after a wallet reported
// it. So a page that says "on hold", "rolled forward", "closed" or "opened" on the strength of a receipt says it
// only for as long as nothing it has read says otherwise:
//   - while its read of the listing is from before the receipt's block, the receipt stands (the read says nothing of
//     that block);
//   - from a read of that block or a later one, the receipt stands only if that read shows what the transaction
//     did;
//   - once such a read did not show it, the receipt is dropped for good. Whatever the listing becomes later (closed
//     another way, rolled to another listing, held again) is not that transaction's doing, and is never said with
//     its hash or its figures.

/**
 * @param {null | { block: number, dropped?: boolean }} seen - the transaction this page saw mined, with its block
 * @param {number|null} readBlock - the block the page's read of the listing is of; null: not known
 * @param {boolean} shows - whether that read shows what the transaction did
 * @returns {boolean} whether the page may still speak on the strength of the receipt
 */
export function receiptStands(seen, readBlock, shows) {
  if (seen === null || seen.dropped) return false;
  if (readBlock === null || readBlock < seen.block) return true;
  return Boolean(shows);
}

/** The same receipt after a read: marked dropped, for good, once a read of its block or later does not show it. */
export function afterRead(seen, readBlock, shows) {
  if (seen === null || seen.dropped || receiptStands(seen, readBlock, shows)) return seen;
  return { ...seen, dropped: true };
}
