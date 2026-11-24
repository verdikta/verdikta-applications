import { useEffect, useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';

import { LISTING_STATES } from '../chain/abi.js';
import { chainReader, listingAt, minedReceipt, stakeAttestation } from '../chain/wallet.js';
import { ethToWei } from '../lib/draft.js';
import { formatEth, formatTime } from '../lib/format.js';
import { NO_HOLD, holdTerms, readHold } from '../lib/hold.js';
import { closeTerms, renewTerms, sameListing, topUpEffect, topUpTerms } from '../lib/listingActions.js';
import { STRINGS, fill } from '../strings.js';
import { TextField } from './Field.jsx';
import { useSeenMined } from './seenMined.js';
import { useWalletContext, walletMessage } from './wallet.js';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
/** The Held event of `contract` for the listing in a receipt, or null: another contract's log, or another listing's, is none. */
function heldEvent(contract, receipt, listingId) {
  for (const log of receipt.logs) {
    if (!same(log.address, contract.target)) continue;
    let event = null;
    try {
      event = contract.interface.parseLog(log);
    } catch {
      // not an event of the client's ABI
    }
    if (event?.name === 'Held' && event.args.listingId === BigInt(listingId)) return event;
  }
  return null;
}
const stateWords = (l) => STRINGS.fund.states[LISTING_STATES[Number(l.state)]] ?? String(l.state);
/** The block the wallet's node is at: a raw eth_blockNumber, since ethers' getBlockNumber() may answer from a cache. */
const blockNow = async (provider) => Number(await provider.send('eth_blockNumber', []));

/**
 * A top-up (design §13.2): fund() on a listing that has opened, with no fee. The contract pays what the
 * listing owes hunters first, in commit order, and escrows the rest; a Depleted listing reopens once
 * nothing is owed and the escrow is back at the top award. The page says what the listing holds and
 * owes, and what the amount typed would do, before anything is sent. Just before sending, the listing
 * is read again through the wallet: one that can no longer be topped up sends nothing. fund() is sent
 * with expectedFeeWei 0, so it can only ever be a top-up: on a listing that is still Listed, where the
 * same call would be the opening fund, the contract refuses it ("fee changed"). The receipt says what
 * went to hunters (OwedPaid), what the escrow holds now (Funded) and whether the listing reopened. `held`: its maker
 * has it on hold (node P42). A top-up is taken as before, and a Depleted listing's state goes back to Open the same
 * way; it takes no claims all the same, and the page says that in place of "reopens".
 */
export function TopUpEscrow({ listingId, listing, held = false, onChanged = () => {} }) {
  const w = useWalletContext();
  const id = useId();
  const T = STRINGS.topUp;
  const terms = topUpTerms(listing);
  // a depleted listing: what reopens it is the amount to start from
  const [amount, setAmount] = useState(terms.toReopenWei ? formatEth(terms.toReopenWei) : '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { tx, toOwed, escrow, reopened }
  const [error, setError] = useState(null);

  if (!terms.can && !done) return null;

  let wei = null;
  let amountError = null;
  if (amount.trim() !== '') {
    try {
      wei = BigInt(ethToWei(amount));
      if (wei === 0n) {
        wei = null;
        amountError = T.positive;
      }
    } catch {
      amountError = STRINGS.listing.bounds.amount;
    }
  }
  const effect = wei === null ? null : topUpEffect(listing, wei);

  const topUp = async () => {
    setBusy(true);
    setError(null);
    try {
      const { signer, provider, account } = await w.ensure();
      if (!same(account, listing.maker)) return setError(fill(STRINGS.claim.notMaker, { maker: listing.maker, account }));
      const reader = stakeAttestation(provider);
      const blockTag = await blockNow(provider);
      const mine = await listingAt(reader, listingId, blockTag);
      // another listing under this id, or none: the wallet's chain is not the one this page read (FundPage refresh)
      if (!sameListing(mine, listing)) {
        setError(fill(STRINGS.fund.replaced, { id: listingId }));
        onChanged(blockTag);
        return undefined;
      }
      if (!topUpTerms(mine).can || !same(mine.maker, account)) {
        setError(fill(T.changed, { id: listingId, state: stateWords(mine) }));
        // the block the wallet saw the change at: the page reads the listing from there (FundPage refresh)
        onChanged(blockTag);
        return undefined;
      }
      const tx = await stakeAttestation(signer).fund(BigInt(listingId), 0n, { value: wei });
      const receipt = await tx.wait();
      let toOwed = 0n;
      let escrow = null;
      let reopened = false;
      for (const log of receipt.logs) {
        let event = null;
        try {
          event = reader.interface.parseLog(log);
        } catch {
          // another contract's log
        }
        if (event?.name === 'OwedPaid') toOwed += event.args.amountWei;
        if (event?.name === 'Funded') escrow = event.args.escrowWei;
        if (event?.name === 'Reopened') reopened = true;
      }
      if (escrow === null) escrow = (await reader.getListing(BigInt(listingId))).escrowWei;
      setDone({ tx: tx.hash, toOwed, escrow, reopened });
      setAmount('');
      onChanged(receipt.blockNumber);
    } catch (err) {
      setError(fill(STRINGS.claim.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <section className="claim" aria-labelledby={id} data-testid="top-up">
      <h3 id={id}>{T.title}</h3>
      <p>{T.intro}</p>
      {terms.can && (
        <>
          <p data-testid="top-up-escrow">{fill(T.escrow, { eth: formatEth(terms.escrowWei), top: formatEth(terms.topWei) })}</p>
          {terms.owedWei > 0n && <p data-testid="top-up-owed">{fill(T.owed, { eth: formatEth(terms.owedWei) })}</p>}
          {terms.state === 'Depleted' && <p className="warning" data-testid="top-up-depleted">{fill(held ? T.depletedHeld : T.depleted, { eth: formatEth(terms.toReopenWei) })}</p>}
          {terms.state === 'Rolled' && <p className="hint" data-testid="top-up-rolled">{T.rolled}</p>}
        </>
      )}
      {done && (
        <p className="ok" data-testid="topped-up">
          {done.toOwed > 0n
            ? fill(T.doneOwed, { tx: done.tx, owed: formatEth(done.toOwed), eth: formatEth(done.escrow) })
            : fill(T.done, { tx: done.tx, eth: formatEth(done.escrow) })}
          {/* "open again" is said of the listing as last read: not once it has rolled forward or closed since */}
          {done.reopened && terms.state === 'Open' ? ` ${held ? T.reopenedHeld : T.reopened}` : ''}
        </p>
      )}
      {terms.can && (
        <>
          <TextField label={T.amount} value={amount} onChange={setAmount} inputMode="decimal" error={amountError} testId="top-up-amount" />
          {effect && (
            <p className="hint" data-testid="top-up-effect">
              {effect.toOwedWei > 0n
                ? fill(T.effect, { owed: formatEth(effect.toOwedWei), rest: formatEth(effect.toEscrowWei), after: formatEth(effect.escrowAfterWei) })
                : fill(T.effectPlain, { after: formatEth(effect.escrowAfterWei) })}
              {effect.reopens ? ` ${held ? T.reopensHeld : T.reopens}` : ''}
            </p>
          )}
          <button type="button" onClick={topUp} disabled={busy || wei === null}>
            {busy ? T.sending : wei === null ? T.buttonNoAmount : fill(T.button, { eth: formatEth(wei) })}
          </button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/**
 * renew() (design §13.2): the maker pays the listing fee again for another 30 days. The fee is read from
 * the chain and shown before anything is sent; just before sending, the listing and the fee are read
 * again at one block through the wallet, and a fee that moved, or a listing that can no longer be
 * renewed, sends nothing. The contract takes exactly the fee, so a stale figure would revert anyway. `held`: its
 * maker has it on hold (node P42). A renewal extends the paid period as before and does not make the listing take
 * claims again, so the page never says "until it is renewed" of one.
 */
export function RenewListing({ listingId, listing, held = false, onChanged = () => {} }) {
  const w = useWalletContext();
  const id = useId();
  const R = STRINGS.renew;
  const [fee, setFee] = useState(null);
  const [now, setNow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { tx, until }
  const [error, setError] = useState(null);
  const terms = renewTerms(listing, now ?? Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!terms.can) return undefined;
    let live = true;
    (async () => {
      const provider = await chainReader();
      const [due, block] = await Promise.all([stakeAttestation(provider).listingFeeWei(), provider.getBlock('latest')]);
      if (live) {
        setFee(due);
        // the chain's time, which is what decides whether the period has lapsed
        setNow(Number(block.timestamp));
      }
    })().catch(() => {});
    return () => { live = false; };
  }, [terms.can, listing.fundedUntil]);

  if (!terms.can && !done) return null;

  const renew = async () => {
    setBusy(true);
    setError(null);
    try {
      const { signer, provider, account } = await w.ensure();
      if (!same(account, listing.maker)) return setError(fill(STRINGS.claim.notMaker, { maker: listing.maker, account }));
      const reader = stakeAttestation(provider);
      const blockTag = await blockNow(provider);
      const [mine, due] = await Promise.all([listingAt(reader, listingId, blockTag), reader.listingFeeWei({ blockTag })]);
      if (!sameListing(mine, listing)) {
        setError(fill(STRINGS.fund.replaced, { id: listingId }));
        onChanged(blockTag);
        return undefined;
      }
      if (!renewTerms(mine, 0).can || !same(mine.maker, account)) {
        setError(fill(R.changed, { id: listingId, state: stateWords(mine) }));
        onChanged(blockTag);
        return undefined;
      }
      if (due !== fee) {
        setFee(due);
        return setError(fill(R.feeChanged, { fee: formatEth(due) }));
      }
      const tx = await stakeAttestation(signer).renew(BigInt(listingId), { value: due });
      const receipt = await tx.wait();
      const after = await stakeAttestation(provider).getListing(BigInt(listingId));
      setDone({ tx: tx.hash, until: after.fundedUntil });
      onChanged(receipt.blockNumber);
    } catch (err) {
      setError(fill(STRINGS.claim.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <section className="claim" aria-labelledby={id} data-testid="renew">
      <h3 id={id}>{R.title}</h3>
      <p>{R.intro}</p>
      {terms.can && (
        <p className={terms.lapsed ? 'warning' : undefined} data-testid="renew-period">
          {fill(terms.lapsed ? (held ? R.lapsedHeld : R.lapsed) : R.until, { time: formatTime(terms.fundedUntil) })}
        </p>
      )}
      {terms.can && held && <p className="hint" data-testid="renew-held">{R.held}</p>}
      {done && <p className="ok" data-testid="renewed">{fill(R.done, { tx: done.tx, until: formatTime(done.until) })}</p>}
      {terms.can && (
        <>
          <p className="hint" data-testid="renew-fee">{fee === null ? R.feeLoading : fill(R.fee, { fee: formatEth(fee) })}</p>
          <button type="button" onClick={renew} disabled={busy || fee === null}>
            {busy ? R.sending : fill(R.button, { fee: fee === null ? '…' : formatEth(fee) })}
          </button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/**
 * hold() (node P42; StakeAttestation.hold, node P39): the maker stops new claims on the listing at once, before the fix
 * it rolls forward to is public. It leaves every pending claim alone and cannot be undone, so the section says those
 * three things before anything else, and the action takes two steps before the wallet's own, as close() does. The
 * action is drawn for the listing's maker only: for the connected wallet when it is the maker's, and for no other
 * wallet and none. The wallet is asked again at the click, since one can change its account without saying so. Just
 * before sending, the listing and its hold are read again at one block through the wallet: a listing that is no longer
 * Open or Depleted, or is on hold already, sends nothing. The hold is this contract's Held event for this listing in
 * the receipt, also when the wallet sent the call again at a higher fee and it was mined under another hash
 * (chain/wallet.js minedReceipt); its time is the event's.
 *
 * `hold` is the listing's hold as the page states it (lib/hold.js holdView): the chain's, or, while the page's read is
 * from before the block this page saw its hold mined in, that receipt's. Against a contract deployed before the hold
 * (`hold.supported` false) nothing is drawn: no section, no action. On a listing that is on hold the section says since
 * when and what is left; a hold ends in a roll forward or a close, and with it the section. A hold this page saw mined
 * that a read of that block or later does not show is said in an alert, never as a hold, and the action is offered
 * again: the maker must not publish a fix on the strength of a hold that is not on the chain.
 */
export function HoldListing({ listingId, listing, hold = NO_HOLD, readBlock = null, onHeld = () => {}, onChanged = () => {} }) {
  const w = useWalletContext();
  const id = useId();
  const H = STRINGS.hold;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  // The hold this page saw mined: { tx, heldAt, block }. It is the listing's hold while the read is from before its
  // block, and from then on while the read has a hold of that very time; once a read does not, it is dropped for good
  // (lib/seenMined.js), and a hold the listing has later is never said with this transaction.
  const [done, setDone, mine] = useSeenMined(readBlock, (d) => hold.held && hold.heldAt === BigInt(d.heldAt));
  const [error, setError] = useState(null);
  const terms = holdTerms(listing, hold);

  if (!hold.supported) return null;
  // neither Open nor Depleted: no hold to take, and one that was taken has ended
  if (terms.why === 'state') return null;

  const account = w.wallet?.account ?? null;
  const isMaker = account !== null && same(account, listing.maker);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const { signer, provider, account: sender } = await w.ensure();
      if (!same(sender, listing.maker)) {
        setAsking(false);
        return setError(fill(STRINGS.claim.notMaker, { maker: listing.maker, account: sender }));
      }
      const reader = stakeAttestation(provider);
      const blockTag = await blockNow(provider);
      const [mine, now] = await Promise.all([listingAt(reader, listingId, blockTag), readHold(reader, listingId, { blockTag })]);
      // A hold has no way back, so it is sent only for the listing this page showed the maker: the same artifact, and
      // the same maker's. On a chain whose blocks were replaced the id can name another of the maker's open listings,
      // and a hold there would leave the version meant to be protected taking commits.
      if (!sameListing(mine, listing)) {
        setError(fill(STRINGS.fund.replaced, { id: listingId }));
        setAsking(false);
        onChanged(blockTag);
        return undefined;
      }
      if (!holdTerms(mine, now).can || !same(mine.maker, sender)) {
        setError(fill(H.changed, { id: listingId }));
        setAsking(false);
        onChanged(blockTag);
        return undefined;
      }
      const tx = await stakeAttestation(signer).hold(BigInt(listingId));
      // also when the wallet sent it again at a higher fee: the receipt is then the replacement's, with its own hash
      const receipt = await minedReceipt(tx);
      // the hold is this contract's Held event for this listing, and its time the event's (its block's: ClaimLogic.hold)
      const held = heldEvent(reader, receipt, listingId);
      setAsking(false);
      if (!held) {
        // mined, and no hold of this listing in it: no hold is claimed, the maker is told which transaction it was,
        // and the listing is read from that block
        setError(fill(H.notConfirmed, { id: listingId, tx: receipt.hash }));
        onChanged(receipt.blockNumber);
        return undefined;
      }
      setDone({ tx: receipt.hash, heldAt: held.args.heldAt, block: receipt.blockNumber });
      onHeld(held.args.heldAt, receipt.blockNumber);
    } catch (err) {
      setError(fill(STRINGS.claim.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  let body;
  if (hold.held) {
    // The time is the page's one answer for this hold (`hold.heldAt`: the chain's once a read has it), here as in the
    // summary and the roll forward panel. The transaction this page saw mined is named with it only while the hold
    // read is that transaction's (`mine`): a hold the chain dates otherwise (the call mined again in another block,
    // or another hold altogether) is said by its own time, without a transaction this page cannot vouch for.
    body = (
      <>
        {mine
          ? <p className="ok" data-testid="held">{fill(H.done, { id: listingId, time: formatTime(hold.heldAt), tx: done.tx })}</p>
          : <p data-testid="hold-since">{fill(H.since, { time: formatTime(hold.heldAt) })}</p>}
        <p className="hint">{H.next}</p>
      </>
    );
  } else {
    let action;
    if (!isMaker) action = <p className="hint" data-testid="hold-maker-only">{H.makerOnly}</p>;
    else if (asking) {
      action = (
        <p className="actions">
          <button type="button" className="danger" onClick={send} disabled={busy}>
            {busy ? H.sending : fill(H.confirm, { id: listingId })}
          </button>
          <button type="button" className="secondary" onClick={() => setAsking(false)} disabled={busy}>{H.keep}</button>
        </p>
      );
    } else {
      action = (
        <button type="button" className="secondary" onClick={() => { setError(null); setAsking(true); }}>
          {fill(H.ask, { id: listingId })}<ArrowRight size={16} aria-hidden="true" />
        </button>
      );
    }
    body = (
      <>
        {/* a hold this page saw mined, and the chain as read since does not show: said first, and never as a hold */}
        {done && <p className="error" role="alert" data-testid="hold-dropped">{fill(H.dropped, { tx: done.tx })}</p>}
        <ul className="warning" data-testid="hold-warning">
          <li>{H.warning.stops}</li>
          <li>{H.warning.pending}</li>
          <li>{H.warning.oneWay}</li>
        </ul>
        <p className="hint" data-testid="hold-late">{H.late}</p>
        {action}
      </>
    );
  }
  return (
    <section className="claim" aria-labelledby={id} data-testid="hold">
      <h3 id={id}>{H.title}</h3>
      <p>{H.intro}</p>
      {body}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/**
 * close() (design §13.2): the maker ends the stake and takes back the escrow that is left. The contract
 * refuses while a claim is pending or an award is owed, so the page says which and offers nothing then.
 * It cannot be undone, so it takes two steps here before the wallet's own: the first shows what closing
 * does and how much comes back, the second sends it. Just before sending, the listing is read again
 * through the wallet. The receipt says what came back and whether the contract could send it: a wallet
 * it could not pay is credited instead (PaymentDeferred), and withdraws.
 */
export function CloseListing({ listingId, listing, readBlock = null, onChanged = () => {} }) {
  const w = useWalletContext();
  const id = useId();
  const C = STRINGS.close;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const terms = closeTerms(listing);
  // The close this page saw mined: { tx, amount, account, deferred, block }. It stands by its receipt while the page's
  // read is from before its block (`readBlock`: the block the listing was read at). From that block on the read
  // decides: a listing that does not read closed is not, the page says so, and the close is offered again by its
  // terms. A receipt a read contradicted is dropped for good (lib/seenMined.js): if the listing is closed later, by
  // another transaction, this section says nothing of it, as on a visit that sent no close, and never that
  // transaction's hash or what it reported as returned.
  const [done, setDone, closedHere] = useSeenMined(readBlock, () => terms.why === 'closed');

  if (terms.why === 'closed' && !closedHere) return null;

  const close = async () => {
    setBusy(true);
    setError(null);
    try {
      const { signer, provider, account } = await w.ensure();
      if (!same(account, listing.maker)) return setError(fill(STRINGS.claim.notMaker, { maker: listing.maker, account }));
      const reader = stakeAttestation(provider);
      const blockTag = await blockNow(provider);
      const mine = await listingAt(reader, listingId, blockTag);
      if (!sameListing(mine, listing)) {
        setError(fill(STRINGS.fund.replaced, { id: listingId }));
        setAsking(false);
        onChanged(blockTag);
        return undefined;
      }
      // what this page offered is what is sent: a claim that came in, or an escrow that moved, asks again
      if (!closeTerms(mine).can || !same(mine.maker, account) || BigInt(mine.escrowWei) !== terms.escrowWei) {
        setError(fill(C.changed, { id: listingId }));
        setAsking(false);
        onChanged(blockTag);
        return undefined;
      }
      const tx = await stakeAttestation(signer).close(BigInt(listingId));
      const receipt = await tx.wait();
      let amount = terms.escrowWei;
      let deferred = false;
      for (const log of receipt.logs) {
        let event = null;
        try {
          event = reader.interface.parseLog(log);
        } catch {
          // another contract's log
        }
        if (event?.name === 'Closed') amount = event.args.amountReturned;
        if (event?.name === 'PaymentDeferred' && same(event.args.to, account)) deferred = true;
      }
      setDone({ tx: tx.hash, amount, account, deferred, block: receipt.blockNumber });
      // sent: a close that turns out not to be on the chain is offered again from its first step
      setAsking(false);
      onChanged(receipt.blockNumber);
    } catch (err) {
      setError(fill(STRINGS.claim.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  let body;
  if (closedHere) {
    body = (
      <p className="ok" data-testid="closed">
        {fill(done.deferred ? C.doneDeferred : C.done, { id: listingId, tx: done.tx, eth: formatEth(done.amount), account: done.account })}
      </p>
    );
  } else if (terms.why === 'pending') {
    body = <p data-testid="close-blocked">{fill(C.pending, { count: terms.pending })}</p>;
  } else if (terms.why === 'owed') {
    body = <p data-testid="close-blocked">{fill(C.owed, { eth: formatEth(terms.owedWei) })}</p>;
  } else {
    body = (
      <>
        <p data-testid="close-escrow">{fill(C.escrow, { eth: formatEth(terms.escrowWei) })}</p>
        {asking ? (
          <p className="actions">
            <button type="button" className="danger" onClick={close} disabled={busy}>
              {busy ? C.sending : fill(C.confirm, { id: listingId, eth: formatEth(terms.escrowWei) })}
            </button>
            <button type="button" className="secondary" onClick={() => setAsking(false)} disabled={busy}>{C.keep}</button>
          </p>
        ) : (
          <button type="button" className="secondary" onClick={() => { setError(null); setAsking(true); }}>
            {fill(C.ask, { id: listingId })}<ArrowRight size={16} aria-hidden="true" />
          </button>
        )}
      </>
    );
  }
  return (
    <section className="claim" aria-labelledby={id} data-testid="close">
      <h3 id={id}>{C.title}</h3>
      <p>{C.intro}</p>
      {done && !closedHere && <p className="error" role="alert" data-testid="close-dropped">{fill(C.dropped, { id: listingId, tx: done.tx })}</p>}
      {body}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/**
 * withdraw(): what the contract holds for the connected wallet (`withdrawable`), and the transaction
 * that collects it. Shown only to a connected wallet that is held something; `version` reads it again
 * (a close whose payment was deferred has just added to it). The amount is read again through the
 * wallet before sending, and the contract pays the caller and no one else.
 */
export function Withdraw({ version = 0 }) {
  const w = useWalletContext();
  const id = useId();
  const W = STRINGS.withdraw;
  const account = w.wallet?.account ?? null;
  const [held, setHeld] = useState(null); // { account, wei }
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { tx, amount, account }
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!account) {
      setHeld(null);
      return undefined;
    }
    let live = true;
    chainReader()
      .then((provider) => stakeAttestation(provider).withdrawable(account))
      .then((wei) => { if (live) setHeld({ account, wei }); })
      .catch(() => { if (live) setHeld(null); });
    return () => { live = false; };
  }, [account, version, done]);

  const mine = held && account && same(held.account, account) ? held.wei : 0n;
  if (!done && mine === 0n) return null;

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      const { signer, provider, account: sender } = await w.ensure();
      const amount = await stakeAttestation(provider).withdrawable(sender, { blockTag: await blockNow(provider) });
      if (amount === 0n) {
        setHeld({ account: sender, wei: 0n });
        return setError(fill(W.changed, { account: sender }));
      }
      const tx = await stakeAttestation(signer).withdraw();
      await tx.wait();
      setDone({ tx: tx.hash, amount, account: sender });
    } catch (err) {
      setError(fill(STRINGS.claim.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <section className="claim" aria-labelledby={id} data-testid="withdraw">
      <h3 id={id}>{W.title}</h3>
      <p>{W.intro}</p>
      {done && <p className="ok" data-testid="withdrawn">{fill(W.done, { tx: done.tx, eth: formatEth(done.amount), account: done.account })}</p>}
      {mine > 0n && (
        <>
          <p data-testid="withdraw-held">{fill(W.held, { eth: formatEth(mine), account })}</p>
          <button type="button" onClick={withdraw} disabled={busy}>{busy ? W.sending : fill(W.button, { eth: formatEth(mine) })}</button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
