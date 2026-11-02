import { useCallback, useEffect, useMemo, useState } from 'react';

import { connectWallet } from './chain/wallet.js';
import { CheckPage } from './components/CheckPage.jsx';
import { ListingPage } from './components/ListingPage.jsx';
import { WalletContext, useWalletContext, walletMessage } from './components/wallet.js';
import { STRINGS, fill } from './strings.js';

// #/            home
// #/list        the maker's listing flow
// #/check[/id]  decrypt-and-check a disclosed claim
// Nothing private ever goes in the hash: only a claim id.
function route() {
  const h = window.location.hash.replace(/^#/, '') || '/';
  const check = /^\/check(?:\/(\d{1,20}))?$/.exec(h);
  if (check) return { page: 'check', claimId: check[1] ?? null };
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
  /** The connected wallet, connecting first when there is none. */
  const ensure = useCallback(async () => wallet ?? connect(), [wallet, connect]);
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
          <a href="#/list">{STRINGS.nav.list}</a>
          <a href="#/check">{STRINGS.nav.check}</a>
        </nav>
        <WalletBar />
      </header>
      <main className="page">
        {r.page === 'home' && <Home />}
        {r.page === 'list' && <ListingPage />}
        {r.page === 'check' && <CheckPage key={r.claimId ?? 'none'} claimId={r.claimId} />}
      </main>
    </WalletContext.Provider>
  );
}
