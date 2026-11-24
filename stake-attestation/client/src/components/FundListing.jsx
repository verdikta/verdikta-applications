import { useEffect, useState } from 'react';

import { LISTING_STATES } from '../chain/abi.js';
import { snapshot } from '../chain/snapshot.js';
import { chainReader, listingEvent, minedReceipt, stakeAttestation } from '../chain/wallet.js';
import { FormError, ethToWei } from '../lib/draft.js';
import { formatEth, formatTime } from '../lib/format.js';
import { kept } from '../lib/seenMined.js';
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
 * Its line after the opening says the listing is open, and until when by the receipt's own Opened event. On the
 * listing's own page the listing goes on changing under that line (a hold, a renewal, a roll forward, a close), so
 * there `followed` is true from the page's first read that has the opening: the line then keeps the transaction and
 * says only that this page opened the listing, and what the listing is now is the page's to say, from its latest
 * read. The page also says whether the opening still stands (`stands`: its receipt's block is the chain's as the page
 * reads it, lib/seenMined.js) and whether the listing reads Listed (`listed`). `dropped`: a read of the opening's
 * block or a later one says the listing never opened. The line of the opening then goes; while the listing is still
 * Listed an alert names the transaction and the form is back, the read just before sending deciding as for a first
 * opening.
 *
 * @param {{ listingId: bigint, top: bigint, maker: string, artifactHash: string, listed?: boolean, stands?: boolean, followed?: boolean, dropped?: boolean }} props -
 *        `top` is the awards[CRITICAL] this page shows
 */
export function FundListing({ listingId, top, maker, artifactHash, listed = true, stands = true, followed = false, dropped = false, onOpened = () => {} }) {
  const w = useWalletContext();
  const [escrow, setEscrow] = useState(formatEth(top));
  const [fee, setFee] = useState(null);
  const [opened, setOpened] = useState(null); // the opening's kept receipt (lib/seenMined.js), with { until | null }
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    chainReader()
      .then((p) => snapshot(p, (at) => stakeAttestation(at).feeDue(listingId)))
      .then(({ value: f }) => { if (live) setFee(f); })
      .catch(() => {});
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
      // the state and the fee at one block (chain/snapshot.js), so they cannot straddle another tab's opening
      // fund: Listed there means the fee is the listing fee, and passed as expectedFeeWei it makes this
      // transaction revert ("fee changed") if that opening is mined first
      const { value: [now, due] } = await snapshot(provider, (at) => {
        const view = stakeAttestation(at);
        return Promise.all([view.getListing(listingId), view.feeDue(listingId)]);
      });
      if (now.state !== 0n || now.artifactHash.toLowerCase() !== artifactHash.toLowerCase() || now.awards[3] !== top) {
        setError(fill(STRINGS.fund.changed, { id: String(listingId), state: STRINGS.fund.states[LISTING_STATES[Number(now.state)]] ?? String(now.state) }));
        setStale(true);
        return;
      }
      const sa = stakeAttestation(signer);
      const tx = await sa.fund(listingId, due, { value: due + escrowWei });
      // also when the wallet sent it again at a higher fee (chain/wallet.js minedReceipt): opened once, under that hash
      const receipt = await minedReceipt(tx);
      // From here the listing is opened and paid for: nothing below reports it as failed. Until when is the receipt's
      // own Opened event, so no read stands between the receipt and the line. The receipt is kept with its block's
      // hash (lib/seenMined.js): a page that reads the listing again reads from that block, and says the opening
      // only while that block is the chain's.
      const openedEvent = listingEvent(sa, receipt, 'Opened', listingId);
      const seen = kept(receipt, { until: openedEvent ? openedEvent.args.fundedUntil : null });
      setOpened(seen);
      onOpened(seen);
    } catch (err) {
      setError(err instanceof FormError ? err.message : fill(C.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
  };

  // On the listing's own page the opening's line is said while the page says the opening stands (`stands`), and the
  // form is there only for a listing that reads Listed (`listed`): an opening whose block the page has not read yet,
  // or one a read contradicted on a listing that is no longer Listed, draws nothing here.
  if (opened && stands) {
    let text = fill(C.openedNoTime, { id: String(listingId), tx: opened.tx });
    if (followed) text = fill(C.openedHere, { id: String(listingId), tx: opened.tx });
    else if (opened.until) text = fill(C.opened, { id: String(listingId), until: formatTime(opened.until), tx: opened.tx });
    return <p data-testid="opened" className="ok">{text}</p>;
  }
  if (!listed || (opened && !dropped)) return null;
  return (
    <>
      {opened && dropped && <p className="error" role="alert" data-testid="opening-dropped">{fill(C.openingDropped, { id: String(listingId), tx: opened.tx })}</p>}
      {fee !== null && <p>{fill(C.fee, { fee: formatEth(fee) })}</p>}
      <TextField label={C.escrow} value={escrow} onChange={setEscrow} inputMode="decimal" error={escrowError} />
      {!stale && <button type="button" onClick={fund} disabled={busy || escrowError !== null}>{busy ? C.funding : C.fund}</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
