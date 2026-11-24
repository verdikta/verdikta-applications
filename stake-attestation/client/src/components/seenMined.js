import { useCallback, useEffect, useState } from 'react';

import { afterRead, asKept, receiptVerdict } from '../lib/seenMined.js';

/**
 * A transaction this component sent and saw mined (lib/seenMined.js). `seen` is a kept receipt: what the transaction
 * reported, with its hash and its block's number and hash; `setSeen` takes nothing else. `stands`: whether the page
 * may still speak on the strength of it, as of the snapshot the listing was last read at (`read`: its block, that
 * block's hash, and the hash its chain has at the receipt's height) and what that read shows (`shows(seen)`). Once a
 * read of its block or later said otherwise, it is kept as dropped (`seen.dropped`) and never stands again, whatever a
 * later read shows.
 * @param {null | { block: number, blockHash: string, hashes?: Record<number, string|null> }} read
 * @param {(seen: object) => boolean} shows
 * @returns {[object|null, (seen: object|null) => void, boolean]} [seen, setSeen, stands]
 */
export function useSeenMined(read, shows) {
  const [seen, set] = useState(null);
  const setSeen = useCallback((next) => set(asKept(next)), []);
  const shown = seen !== null && !seen.dropped && Boolean(shows(seen));
  const verdict = receiptVerdict(seen, read, shown);
  useEffect(() => {
    const next = afterRead(seen, read, shown);
    if (next !== seen) set(next);
    // `verdict` is what `read` and `shown` come to for this receipt: the effect runs when either changes it
  }, [seen, verdict]);
  return [seen, setSeen, verdict === 'stands'];
}
