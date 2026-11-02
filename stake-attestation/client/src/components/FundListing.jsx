import { useEffect, useState } from 'react';

import { LISTING_STATES } from '../chain/abi.js';
import { chainReader, stakeAttestation } from '../chain/wallet.js';
import { FormError, ethToWei } from '../lib/draft.js';
import { formatEth, formatTime } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';
import { TextField } from './Field.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const C = STRINGS.chain;

/**
 * The opening fund() of a Listed listing, through the maker's wallet: feeDue() plus the escrow,
 * at least the CRITICAL award. Just before sending, the listing is read again through the
 * wallet, on the site's chain: it must still be Listed, the same artifact this page shows and
 * the same CRITICAL award, or nothing is sent. So a stale page (another tab funded it) or terms
 * read elsewhere never turn into a second payment, which the contract would take as a top-up.
 * The state and feeDue() are read at one block and the fee is passed as expectedFeeWei, so an
 * opening fund from elsewhere that lands first makes this one revert ("fee changed") rather than
 * top up (with a listing fee of 0 the two cannot be told apart). Once the transaction is mined
 * the button is gone for good, whatever a later read says.
 *
 * @param {{ listingId: bigint, top: bigint, maker: string, artifactHash: string }} props - `top`
 *        is the awards[CRITICAL] this page shows
 */
export function FundListing({ listingId, top, maker, artifactHash }) {
  const w = useWalletContext();
  const [escrow, setEscrow] = useState(formatEth(top));
  const [fee, setFee] = useState(null);
  const [opened, setOpened] = useState(null); // { tx, until | null }
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    chainReader().then((p) => stakeAttestation(p).feeDue(listingId)).then((f) => { if (live) setFee(f); }).catch(() => {});
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
      // the state and the fee at one block, so they cannot straddle another tab's opening fund:
      // Listed there means the fee is the listing fee, and passed as expectedFeeWei it makes this
      // transaction revert ("fee changed") if that opening is mined first
      const reader = stakeAttestation(provider);
      // a raw eth_blockNumber: ethers' getBlockNumber() may answer from before the list() it follows
      const blockTag = Number(await provider.send('eth_blockNumber', []));
      const [now, due] = await Promise.all([reader.getListing(listingId, { blockTag }), reader.feeDue(listingId, { blockTag })]);
      if (now.state !== 0n || now.artifactHash.toLowerCase() !== artifactHash.toLowerCase() || now.awards[3] !== top) {
        setError(fill(STRINGS.fund.changed, { id: String(listingId), state: STRINGS.fund.states[LISTING_STATES[Number(now.state)]] ?? String(now.state) }));
        setStale(true);
        return;
      }
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
      {!stale && <button type="button" onClick={fund} disabled={busy || escrowError !== null}>{busy ? C.funding : C.fund}</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
