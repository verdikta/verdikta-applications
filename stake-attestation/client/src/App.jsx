import { useCallback, useEffect, useMemo, useState } from 'react';

import { connectWallet, hasWallet, stillConnected } from './chain/wallet.js';
import { CheckPage } from './components/CheckPage.jsx';
import { ClaimPage } from './components/ClaimPage.jsx';
import { FeedPage } from './components/FeedPage.jsx';
import { FundPage } from './components/FundPage.jsx';
import { ListingPage } from './components/ListingPage.jsx';
import { RecordPage } from './components/RecordPage.jsx';
import { WalletContext, useWalletContext, walletMessage } from './components/wallet.js';
import { STRINGS, fill } from './strings.js';

// #/              home
// #/feed          the listing feed
// #/record[/hash] an artifact hash's record, its badge and what a record means
// #/list          the maker's listing flow
// #/check[/id]    decrypt-and-check a disclosed claim
// #/claim[/id]    a claim: its state, a pending round watched, release and dispute
// #/fund[/id]     a listing's own page: its terms, the opening fund() while it is Listed, its
//                 claims and record, roll forward
// Nothing private ever goes in the hash: only an artifact hash, a claim or a listing id.
function route() {
  const h = window.location.hash.replace(/^#/, '') || '/';
  if (h === '/feed') return { page: 'feed' };
  const record = /^\/record(?:\/([^/]{1,80}))?$/.exec(h);
  if (record) return { page: 'record', hash: record[1] ?? null };
  const claim = /^\/claim(?:\/(\d{1,20}))?$/.exec(h);
  if (claim) return { page: 'claim', claimId: claim[1] ?? null };
  const check = /^\/check(?:\/(\d{1,20}))?$/.exec(h);
  if (check) return { page: 'check', claimId: check[1] ?? null };
  const fund = /^\/fund(?:\/(\d{1,20}))?$/.exec(h);
  if (fund) return { page: 'fund', listingId: fund[1] ?? null };
  if (h === '/list') return { page: 'list' };
  return { page: 'home' };
}

function useRoute() {
  const [r, setR] = useState(route);
  useEffect(() => {
    const on = () => setR(route());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

function useWallet() {
  const [wallet, setWallet] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const w = await connectWallet();
      setWallet(w);
      return w;
    } catch (err) {
      setError(walletMessage(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);
  // A wallet that switches account or chain, or disconnects, is no longer the one connected:
  // forget it, so the bar offers to connect again and the next transaction asks afresh.
  useEffect(() => {
    if (!wallet || !hasWallet()) return undefined;
    const forget = () => setWallet(null);
    const events = ['accountsChanged', 'chainChanged', 'disconnect'];
    for (const e of events) window.ethereum.on?.(e, forget);
    return () => { for (const e of events) window.ethereum.removeListener?.(e, forget); };
  }, [wallet]);
  /** The connected wallet, as the wallet has it now: connecting again when it changed. */
  const ensure = useCallback(async () => {
    if (wallet && await stillConnected(wallet)) return wallet;
    setWallet(null);
    return connect();
  }, [wallet, connect]);
  return useMemo(() => ({ wallet, error, busy, connect, ensure }), [wallet, error, busy, connect, ensure]);
}

function WalletBar() {
  const w = useWalletContext();
  return (
    <div className="wallet">
      {w.wallet ? (
        <span data-testid="wallet">{fill(STRINGS.wallet.connected, { account: w.wallet.account })}</span>
      ) : (
        <button type="button" onClick={() => w.connect().catch(() => {})} disabled={w.busy}>
          {w.busy ? STRINGS.wallet.connecting : STRINGS.wallet.connect}
        </button>
      )}
      {w.error && <p className="error" role="alert">{w.error}</p>}
    </div>
  );
}

function Home() {
  return (
    <>
      <p className="lead">{STRINGS.home.lead}</p>
      <p>{STRINGS.home.recordNote}</p>
      <p className="status">{STRINGS.home.status}</p>
    </>
  );
}

export default function App() {
  const r = useRoute();
  const wallet = useWallet();
  return (
    <WalletContext.Provider value={wallet}>
      <header className="top">
        <h1>{STRINGS.appName}</h1>
        <nav>
          <a href="#/">{STRINGS.nav.home}</a>
          <a href="#/feed">{STRINGS.nav.feed}</a>
          <a href="#/record">{STRINGS.nav.record}</a>
          <a href="#/list">{STRINGS.nav.list}</a>
          <a href="#/claim">{STRINGS.nav.claim}</a>
          <a href="#/check">{STRINGS.nav.check}</a>
        </nav>
        <WalletBar />
      </header>
      <main className="page">
        {r.page === 'home' && <Home />}
        {r.page === 'feed' && <FeedPage />}
        {r.page === 'record' && <RecordPage key={r.hash ?? 'none'} hash={r.hash} />}
        {r.page === 'list' && <ListingPage />}
        {r.page === 'claim' && <ClaimPage key={r.claimId ?? 'none'} claimId={r.claimId} />}
        {/* Keyed by id only: a wallet switching networks mid-action must not unmount the action.
            What the pages read was checked to be the site's chain (chainReader), so it stays valid. */}
        {r.page === 'check' && <CheckPage key={r.claimId ?? 'none'} claimId={r.claimId} />}
        {r.page === 'fund' && <FundPage key={r.listingId ?? 'none'} listingId={r.listingId} />}
      </main>
      <footer className="foot">
        <p>
          <span>{STRINGS.footer.lead}</span> <a href={STRINGS.footer.guide}>{STRINGS.footer.guide}</a>
          {' '}<span className="hint">({STRINGS.footer.indexLead} <a href={STRINGS.footer.index}>{STRINGS.footer.index}</a>)</span>
        </p>
      </footer>
    </WalletContext.Provider>
  );
}
