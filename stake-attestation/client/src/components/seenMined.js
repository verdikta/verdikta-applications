import { useEffect, useState } from 'react';

import { afterRead, receiptStands } from '../lib/seenMined.js';

/**
 * A transaction this component sent and saw mined (lib/seenMined.js): `seen` is { ...what it reported, block }, set
 * with `setSeen` from the receipt. `stands`: whether the page may still speak on the strength of it, as of the read
 * the listing was last read at (`readBlock`) and what that read shows (`shows(seen)`). Once a read of its block or
 * later did not show it, it is kept as dropped (`seen.dropped`) and never stands again, whatever a later read shows.
 * @returns {[object|null, (seen: object|null) => void, boolean]} [seen, setSeen, stands]
 */
export function useSeenMined(readBlock, shows) {
  const [seen, setSeen] = useState(null);
  const shown = seen !== null && !seen.dropped && Boolean(shows(seen));
  const stands = receiptStands(seen, readBlock, shown);
  useEffect(() => {
    const next = afterRead(seen, readBlock, shown);
    if (next !== seen) setSeen(next);
  }, [seen, readBlock, shown]);
  return [seen, setSeen, stands];
}
