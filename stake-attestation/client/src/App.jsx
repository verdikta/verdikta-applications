import { useCallback, useEffect, useMemo, useState } from 'react';

import { connectWallet, hasWallet, stillConnected } from './chain/wallet.js';
import { CheckPage } from './components/CheckPage.jsx';
import { FundPage } from './components/FundPage.jsx';
import { ListingPage } from './components/ListingPage.jsx';
import { WalletContext, useWalletContext, walletMessage } from './components/wallet.js';
import { STRINGS, fill } from './strings.js';

// #/            home
// #/list        the maker's listing flow
// #/check[/id]  decrypt-and-check a disclosed claim
// #/fund[/id]   a listing's own page: its terms and, while it is Listed, the opening fund()
// Nothing private ever goes in the hash: only a claim or listing id.
function route() {
  const h = window.location.hash.replace(/^#/, '') || '/';
  const check = /^\/check(?:\/(\d{1,20}))?$/.exec(h);
  if (check) return { page: 'check', claimId: check[1] ?? null };
  const fund = /^\/fund(?:\/(\d{1,20}))?$/.exec(h);
  if (fund) return { page: 'fund', listingId: fund[1] ?? null };
  if (h === '/list') return { page: 'list' };
  return { page: 'home' };
}

/**
 * A counter that moves on every chainChanged: the pages that read the chain are keyed by it, so
 * a wallet that switches networks makes them read again rather than keep another chain's data.
 */
function useChainEpoch() {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!hasWallet()) return undefined;
    const bump = () => setEpoch((e) => e + 1);
    window.ethereum.on?.('chainChanged', bump);
    return () => window.ethereum.removeListener?.('chainChanged', bump);
  }, []);
  return epoch;
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
  const epoch = useChainEpoch();
  return (
    <WalletContext.Provider value={wallet}>
      <header className="top">
        <h1>{STRINGS.appName}</h1>
        <nav>
          <a href="#/">{STRINGS.nav.home}</a>
          <a href="#/list">{STRINGS.nav.list}</a>
          <a href="#/check">{STRINGS.nav.check}</a>
        </nav>
        <WalletBar />
      </header>
      <main className="page">
        {r.page === 'home' && <Home />}
        {r.page === 'list' && <ListingPage />}
        {r.page === 'check' && <CheckPage key={`${r.claimId ?? 'none'}@${epoch}`} claimId={r.claimId} />}
        {r.page === 'fund' && <FundPage key={`${r.listingId ?? 'none'}@${epoch}`} listingId={r.listingId} />}
      </main>
    </WalletContext.Provider>
  );
}
