import { useEffect, useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';

import { LISTING_STATES } from '../chain/abi.js';
import { chainReader, eventOf, stakeAttestation } from '../chain/wallet.js';
import { ethToWei } from '../lib/draft.js';
import { formatEth, formatTime } from '../lib/format.js';
import { holdTerms, readHold } from '../lib/hold.js';
import { closeTerms, renewTerms, topUpEffect, topUpTerms } from '../lib/listingActions.js';
import { STRINGS, fill } from '../strings.js';
import { TextField } from './Field.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
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
      const mine = await reader.getListing(BigInt(listingId), { blockTag: await blockNow(provider) });
      if (!topUpTerms(mine).can || !same(mine.maker, account)) {
        setError(fill(T.changed, { id: listingId, state: stateWords(mine) }));
        onChanged();
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
      onChanged();
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
          {done.reopened ? ` ${held ? T.reopenedHeld : T.reopened}` : ''}
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
      const [mine, due] = await Promise.all([reader.getListing(BigInt(listingId), { blockTag }), reader.listingFeeWei({ blockTag })]);
      if (!renewTerms(mine, 0).can || !same(mine.maker, account)) {
        setError(fill(R.changed, { id: listingId, state: stateWords(mine) }));
        onChanged();
        return undefined;
      }
      if (due !== fee) {
        setFee(due);
        return setError(fill(R.feeChanged, { fee: formatEth(due) }));
      }
      const tx = await stakeAttestation(signer).renew(BigInt(listingId), { value: due });
      await tx.wait();
      const after = await stakeAttestation(provider).getListing(BigInt(listingId));
      setDone({ tx: tx.hash, until: after.fundedUntil });
      onChanged();
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
 * Open or Depleted, or is on hold already, sends nothing. The receipt's Held event is the hold's time.
 *
 * `hold` is the listing's hold as the page read it from the chain (lib/hold.js holdView). Against a contract deployed
 * before the hold (`hold.supported` false) nothing is drawn: no section, no action. On a listing that is on hold the
 * section says since when and what is left; a hold ends in a roll forward or a close, and with it the section.
 */
export function HoldListing({ listingId, listing, hold, onHeld = () => {}, onChanged = () => {} }) {
  const w = useWalletContext();
  const id = useId();
  const H = STRINGS.hold;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { tx, heldAt }
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
      const [mine, now] = await Promise.all([reader.getListing(BigInt(listingId), { blockTag }), readHold(reader, listingId, { blockTag })]);
      if (!holdTerms(mine, now).can || !same(mine.maker, sender)) {
        setError(fill(H.changed, { id: listingId }));
        setAsking(false);
        onChanged();
        return undefined;
      }
      const tx = await stakeAttestation(signer).hold(BigInt(listingId));
      const receipt = await tx.wait();
      // the hold's time is its block's, as the Held event says it; a receipt it cannot be read from, from the chain
      const held = eventOf(reader, receipt, 'Held');
      const heldAt = held ? held.args.heldAt : (await readHold(reader, listingId, { blockTag: receipt.blockNumber })).heldAt;
      setDone({ tx: tx.hash, heldAt });
      setAsking(false);
      onHeld(heldAt);
    } catch (err) {
      setError(fill(STRINGS.claim.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  let body;
  if (done || terms.why === 'held') {
    body = (
      <>
        {done
          ? <p className="ok" data-testid="held">{fill(H.done, { id: listingId, time: formatTime(done.heldAt), tx: done.tx })}</p>
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
export function CloseListing({ listingId, listing, onChanged = () => {} }) {
  const w = useWalletContext();
  const id = useId();
  const C = STRINGS.close;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { tx, amount, account, deferred }
  const [error, setError] = useState(null);
  const terms = closeTerms(listing);

  if (terms.why === 'closed' && !done) return null;

  const close = async () => {
    setBusy(true);
    setError(null);
    try {
      const { signer, provider, account } = await w.ensure();
      if (!same(account, listing.maker)) return setError(fill(STRINGS.claim.notMaker, { maker: listing.maker, account }));
      const reader = stakeAttestation(provider);
      const mine = await reader.getListing(BigInt(listingId), { blockTag: await blockNow(provider) });
      // what this page offered is what is sent: a claim that came in, or an escrow that moved, asks again
      if (!closeTerms(mine).can || !same(mine.maker, account) || BigInt(mine.escrowWei) !== terms.escrowWei) {
        setError(fill(C.changed, { id: listingId }));
        setAsking(false);
        onChanged();
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
      setDone({ tx: tx.hash, amount, account, deferred });
      onChanged();
    } catch (err) {
      setError(fill(STRINGS.claim.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  let body;
  if (done) {
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
