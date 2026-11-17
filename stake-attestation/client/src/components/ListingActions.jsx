import { useEffect, useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';

import { LISTING_STATES } from '../chain/abi.js';
import { chainReader, stakeAttestation } from '../chain/wallet.js';
import { formatEth, formatTime } from '../lib/format.js';
import { closeTerms, renewTerms } from '../lib/listingActions.js';
import { STRINGS, fill } from '../strings.js';
import { useWalletContext, walletMessage } from './wallet.js';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const stateWords = (l) => STRINGS.fund.states[LISTING_STATES[Number(l.state)]] ?? String(l.state);
/** The block the wallet's node is at: a raw eth_blockNumber, since ethers' getBlockNumber() may answer from a cache. */
const blockNow = async (provider) => Number(await provider.send('eth_blockNumber', []));

/**
 * renew() (design §13.2): the maker pays the listing fee again for another 30 days. The fee is read from
 * the chain and shown before anything is sent; just before sending, the listing and the fee are read
 * again at one block through the wallet, and a fee that moved, or a listing that can no longer be
 * renewed, sends nothing. The contract takes exactly the fee, so a stale figure would revert anyway.
 */
export function RenewListing({ listingId, listing, onChanged = () => {} }) {
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
          {fill(terms.lapsed ? R.lapsed : R.until, { time: formatTime(terms.fundedUntil) })}
        </p>
      )}
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
