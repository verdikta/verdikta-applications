import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Bot, FileText, GitBranch, Lock, Plus, Scale, Search, Terminal, Wallet } from 'lucide-react';

import { connectWallet, hasWallet, stillConnected } from './chain/wallet.js';
import { CheckPage } from './components/CheckPage.jsx';
import { ClaimPage } from './components/ClaimPage.jsx';
import { FeedPage } from './components/FeedPage.jsx';
import { FundPage } from './components/FundPage.jsx';
import { ListingPage } from './components/ListingPage.jsx';
import { RecordPage } from './components/RecordPage.jsx';
import { WalletContext, useWalletContext, walletMessage } from './components/wallet.js';
import { CONFIG } from './config.js';
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
          <Wallet size={18} aria-hidden="true" />
          {w.busy ? STRINGS.wallet.connecting : STRINGS.wallet.connect}
        </button>
      )}
      {w.error && <p className="error" role="alert">{w.error}</p>}
    </div>
  );
}

/** One side's steps, numbered, as the bounty site's "How It Works" draws them. */
function Steps({ side, className, icon, action }) {
  return (
    <div className={`how-card ${className}`}>
      <div className="how-head">
        <h3><span className="how-icon">{icon}</span>{side.title}</h3>
        {action}
      </div>
      <ol className="how-steps">
        {side.steps.map((s, i) => (
          <li key={s.title}>
            <span className="step-n" aria-hidden="true">{i + 1}</span>
            <h4>{s.title}</h4>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
      {side.note && <p className="how-note"><Terminal size={18} aria-hidden="true" /><span>{side.note}</span></p>}
    </div>
  );
}

function Home() {
  const H = STRINGS.home;
  return (
    <>
      <section className="hero">
        <h2>{H.headline}</h2>
        <p className="lead">{H.lead}</p>
        <p className="hero-actions">
          <a className="button hero-primary" href="#/feed"><Search size={20} aria-hidden="true" />{H.seeFeed}</a>
          <a className="button hero-ghost" href="#/list"><Plus size={20} aria-hidden="true" />{STRINGS.nav.list}</a>
        </p>
        <ul className="hero-points">
          <li><Lock size={16} aria-hidden="true" />{H.points.escrow}</li>
          <li><Scale size={16} aria-hidden="true" />{H.points.judged}</li>
          <li><FileText size={16} aria-hidden="true" />{H.points.record}</li>
        </ul>
        {/* what the record is not, where the promise is read */}
        <p className="hero-note">{H.recordNote}</p>
      </section>
      <section className="how">
        <h2>{H.how.title}</h2>
        <p className="status">{H.status}</p>
        <Steps
          side={H.how.makers}
          className="how-makers"
          icon={<GitBranch size={20} aria-hidden="true" />}
          action={<a className="button" href="#/list">{STRINGS.nav.list}<ArrowRight size={16} aria-hidden="true" /></a>}
        />
        {/* the guide a hunter's agent reads before it pays anything; the footer links it on every page */}
        <Steps
          side={H.how.hunters}
          className="how-hunters"
          icon={<Bot size={20} aria-hidden="true" />}
          action={<a className="button secondary mono" href={STRINGS.footer.guide}>{STRINGS.footer.guide}<ArrowRight size={16} aria-hidden="true" /></a>}
        />
      </section>
    </>
  );
}

// the header's links, in order, each with the page it is the link of
const NAV = [['home', '#/'], ['feed', '#/feed'], ['record', '#/record'], ['list', '#/list'], ['claim', '#/claim'], ['check', '#/check']];
// the home page is as wide as the header; a form or one claim reads better in a narrower column
const PAGE_CLASS = { home: 'page page-wide', list: 'page page-narrow', claim: 'page page-narrow', check: 'page page-narrow' };

/** The site's name with what it is, and the network the build is for, under it. */
function Brand() {
  const network = STRINGS.networks[CONFIG.chainId];
  return (
    <a className="brand" href="#/">
      <Scale className="brand-mark" size={30} aria-hidden="true" />
      <div className="brand-text">
        <h1>{STRINGS.appName}</h1>
        <span className="network">{network ? fill(STRINGS.taglineOn, { tagline: STRINGS.tagline, network }) : STRINGS.tagline}</span>
      </div>
    </a>
  );
}

export default function App() {
  const r = useRoute();
  const wallet = useWallet();
  return (
    <WalletContext.Provider value={wallet}>
      <header className="top">
        <div className="top-inner">
          <Brand />
          <nav>
            {NAV.map(([page, href]) => <a key={page} href={href} aria-current={r.page === page ? 'page' : undefined}>{STRINGS.nav[page]}</a>)}
          </nav>
          <WalletBar />
        </div>
      </header>
      <main className={PAGE_CLASS[r.page] ?? 'page'}>
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
          <Bot size={16} aria-hidden="true" />
          <span>{STRINGS.footer.lead}</span> <a href={STRINGS.footer.guide}>{STRINGS.footer.guide}</a>
          {' '}<span className="hint">({STRINGS.footer.indexLead} <a href={STRINGS.footer.index}>{STRINGS.footer.index}</a>)</span>
        </p>
      </footer>
    </WalletContext.Provider>
  );
}
