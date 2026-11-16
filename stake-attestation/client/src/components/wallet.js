import { createContext, useContext } from 'react';

import { WalletError } from '../chain/wallet.js';
import { errorReason } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';

/** { wallet: { provider, signer, account } | null, error, busy, connect(), ensure() } */
export const WalletContext = createContext(null);
export const useWalletContext = () => useContext(WalletContext);

/** A wallet or transaction error as one line for the page. */
export function walletMessage(err) {
  if (err instanceof WalletError) return fill(STRINGS.wallet[err.code], err.vars);
  return fill(STRINGS.wallet.rejected, { reason: errorReason(err) });
}
