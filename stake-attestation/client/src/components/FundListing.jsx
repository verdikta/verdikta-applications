import { useEffect, useState } from 'react';

import { stakeAttestation } from '../chain/wallet.js';
import { FormError, ethToWei } from '../lib/draft.js';
import { formatEth, formatTime } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';
import { TextField } from './Field.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const C = STRINGS.chain;

/**
 * The opening fund() of a Listed listing, through the maker's wallet: feeDue() (read again just
 * before sending, and passed as expectedFeeWei, so a fee change reverts instead of taking escrow)
 * plus the escrow, at least the CRITICAL award. Once the transaction is mined the listing is
 * open and the button is gone for good, whatever a later read says, so no second payment can
 * follow a flaky read.
 *
 * @param {{ listingId: bigint, top: bigint, maker: string }} props - `top` is awards[CRITICAL]
 */
export function FundListing({ listingId, top, maker }) {
  const w = useWalletContext();
  const [escrow, setEscrow] = useState(formatEth(top));
  const [fee, setFee] = useState(null);
  const [opened, setOpened] = useState(null); // { tx, until | null }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    stakeAttestation().feeDue(listingId).then((f) => { if (live) setFee(f); }).catch(() => {});
    return () => { live = false; };
  }, [listingId]);

  let escrowWei = null;
  let escrowError = null;
  try {
    escrowWei = BigInt(ethToWei(escrow));
    if (escrowWei < top) escrowError = fill(C.escrowLow, { min: formatEth(top) });
  } catch {
    escrowError = STRINGS.listing.bounds.amount;
  }

  const fund = async () => {
    setBusy(true);
    setError(null);
    try {
      const { signer, provider, account } = await w.ensure();
      if (account.toLowerCase() !== maker.toLowerCase()) {
        setError(fill(STRINGS.fund.notMaker, { maker, account }));
        return;
      }
      const due = await stakeAttestation(provider).feeDue(listingId);
      const tx = await stakeAttestation(signer).fund(listingId, due, { value: due + escrowWei });
      await tx.wait();
      setOpened({ tx: tx.hash, until: null });
      try {
        const l = await stakeAttestation(provider).getListing(listingId);
        setOpened({ tx: tx.hash, until: l.fundedUntil });
      } catch {
        // the listing is open; only the end of its period is unknown here
      }
    } catch (err) {
      setError(err instanceof FormError ? err.message : fill(C.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
  };

  if (opened) {
    return (
      <p data-testid="opened" className="ok">
        {opened.until
          ? fill(C.opened, { id: String(listingId), until: formatTime(opened.until), tx: opened.tx })
          : fill(C.openedNoTime, { id: String(listingId), tx: opened.tx })}
      </p>
    );
  }
  return (
    <>
      {fee !== null && <p>{fill(C.fee, { fee: formatEth(fee) })}</p>}
      <TextField label={C.escrow} value={escrow} onChange={setEscrow} inputMode="decimal" error={escrowError} />
      <button type="button" onClick={fund} disabled={busy || escrowError !== null}>{busy ? C.funding : C.fund}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
