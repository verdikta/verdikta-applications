import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState } from 'react';

import { afterRead, asKept, receiptVerdict } from '../lib/seenMined.js';

/** The page's registry of the blocks its kept receipts are at (lib/seenMined.js keptBlocks), for the parts of the page. */
export const KeptBlocks = createContext(null);

/**
 * A transaction this component sent and saw mined (lib/seenMined.js). `seen` is a kept receipt: what the transaction
 * reported, with its hash and its block's number and hash; `setSeen` takes nothing else. `stands`: whether the page
 * may still speak on the strength of it, as of the snapshot the listing was last read at (`read`: its block, that
 * block's hash, and the hash its chain has at the receipt's height) and what that read shows (`shows(seen)`). Once a
 * read of its block or later said otherwise, it is kept as dropped (`seen.dropped`) and never stands again, whatever a
 * later read shows.
 *
 * While the receipt is one the page could still speak from, its block is kept in the page's registry (KeptBlocks, or
 * `held` for the page's own), so the page's reads ask for the hash there; a receipt that is replaced, dropped, or
 * gone with its part lets go of it. It keeps and lets go before the browser paints (a layout effect): what the page
 * says of its receipts is drawn from who holds what, and a part that is gone holds nothing in what is painted.
 * @param {null | { block: number, blockHash: string, hashes?: Record<number, string> }} read
 * @param {(seen: object) => boolean} shows
 * @param {null | { keep(block: number): () => void }} [held] - the registry, where no context provides it
 * @returns {[object|null, (seen: object|null) => void, boolean]} [seen, setSeen, stands]
 */
export function useSeenMined(read, shows, held = null) {
  const blocks = useContext(KeptBlocks) ?? held;
  const [seen, set] = useState(null);
  const setSeen = useCallback((next) => set(asKept(next)), []);
  const shown = seen !== null && !seen.dropped && Boolean(shows(seen));
  const verdict = receiptVerdict(seen, read, shown);
  useEffect(() => {
    const next = afterRead(seen, read, shown);
    if (next !== seen) set(next);
    // `verdict` is what `read` and `shown` come to for this receipt: the effect runs when either changes it
  }, [seen, verdict]);
  const block = seen !== null && !seen.dropped ? seen.block : null;
  useLayoutEffect(() => (block === null || !blocks ? undefined : blocks.keep(block)), [block, blocks]);
  return [seen, setSeen, verdict === 'stands'];
}
