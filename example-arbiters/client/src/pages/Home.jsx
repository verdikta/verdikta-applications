/**
 * Home Page
 * Landing page for the Verdikta Arbiters explorer: a short description of the
 * network, headline arbiter counts per network (the network selected in the
 * header is highlighted), a brief "how it works" strip, and links into the
 * Analytics / Contracts / My Arbiters sections.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Scale,
  Activity,
  BarChart3,
  FileText,
  Wallet,
  CheckCircle,
  XCircle,
  Coins,
  Shuffle,
  Lock,
  Gavel,
  ArrowRight
} from 'lucide-react';
import { useNetwork } from '../context/NetworkContext';
import { apiService } from '../services/api';
import './Home.css';

// Compare a summary network key ('base-sepolia') with the header selection
// ('base_sepolia') regardless of separator.
const sameNetwork = (a, b) => String(a).replace(/_/g, '-') === String(b).replace(/_/g, '-');

const HOW_IT_WORKS = [
  { icon: Coins, title: 'Stake & register', text: 'Operators stake 100 wVDKA in the Reputation Keeper to register an arbiter.' },
  { icon: Shuffle, title: 'Randomly selected', text: 'For each request a panel of arbiters is drawn at random, weighted by reputation.' },
  { icon: Lock, title: 'Commit & reveal', text: 'Selected arbiters commit, then reveal their scored AI evaluation.' },
  { icon: Gavel, title: 'Verdict & rewards', text: 'Responses are aggregated into one verdict; arbiters earn LINK and gain or lose reputation.' }
];

const EXPLORE = [
  { to: '/my-arbiters', icon: Wallet, title: 'My Arbiters', text: 'Connect a wallet to claim earned LINK and close out your arbiters.' },
  { to: '/analytics', icon: BarChart3, title: 'Analytics', text: 'Arbiter availability and reputation by owner, plus system diagnostics.' },
  { to: '/contracts', icon: FileText, title: 'Contracts', text: 'The core Verdikta contracts and their live on-chain configuration.' }
];

function NetworkCard({ net, active, onSelect }) {
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div
      className={`network-card clickable${active ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      title={active ? `${net.name} is the active network` : `Switch to ${net.name}`}
    >
      {active && <span className="active-badge">Active</span>}
      <div className="network-card-name">{net.name}</div>
      <div className="network-card-number">
        {net.totalArbiters != null ? net.totalArbiters.toLocaleString() : '—'}
      </div>
      <div className="network-card-label">registered arbiters</div>
      <div className={`network-card-health ${net.healthy ? 'healthy' : 'unhealthy'}`}>
        {net.healthy ? <CheckCircle size={14} /> : <XCircle size={14} />}
        {net.healthy ? 'Aggregator online' : 'Unreachable'}
      </div>
    </div>
  );
}

function Home() {
  const { selectedNetwork, setNetwork } = useNetwork();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    apiService.getSummary()
      .then((res) => {
        if (cancelled) return;
        if (res.success) setSummary(res.data);
        else setError(res.error || 'Failed to load network summary');
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="home">
      {/* Hero */}
      <section className="hero">
        <div className="hero-icon"><Scale size={56} /></div>
        <h1>Verdikta Arbiters</h1>
        <p className="hero-tagline">Trustless AI, decided by a decentralized jury.</p>
      </section>

      {/* Network overview — headline arbiter counts */}
      <section className="network-overview">
        <h2
          className="section-heading has-tooltip"
          title="The highlighted card is the active network. Click a card to switch the network for the whole app (same as the selector in the header)."
        >
          <Activity size={18} className="inline-icon" /> Network at a glance
        </h2>
        {loading ? (
          <div className="network-cards">
            {[0, 1].map((i) => (
              <div className="network-card skeleton" key={i}>
                <div className="network-card-name">&nbsp;</div>
                <div className="network-card-number">…</div>
                <div className="network-card-label">registered arbiters</div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="home-error">Couldn&rsquo;t load network stats: {error}</div>
        ) : (
          <div className="network-cards">
            {summary.networks.map((net) => (
              <NetworkCard
                key={net.network}
                net={net}
                active={sameNetwork(net.network, selectedNetwork)}
                onSelect={() => setNetwork(String(net.network).replace(/-/g, '_'))}
              />
            ))}
          </div>
        )}
      </section>

      {/* How it works */}
      <section className="how-it-works">
        <h2 className="section-heading">How the arbiter system works</h2>
        <p className="section-intro">
          Verdikta lets smart contracts request AI evaluations that are decided collectively by
          independent <strong>arbiters</strong> — oracle operators who stake wVDKA, are chosen at
          random for each request, and respond through a commit-reveal protocol. Their answers are
          aggregated into a single verdict, and arbiters earn LINK while building on-chain
          reputation for accuracy and timeliness.
        </p>
        <div className="steps">
          {HOW_IT_WORKS.map((s, i) => (
            <div className="step" key={s.title}>
              <div className="step-icon"><s.icon size={22} /></div>
              <div className="step-num">Step {i + 1}</div>
              <div className="step-title">{s.title}</div>
              <div className="step-text">{s.text}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Explore */}
      <section className="explore">
        <h2 className="section-heading">Explore</h2>
        <div className="explore-cards">
          {EXPLORE.map((c) => (
            <Link to={c.to} className="explore-card" key={c.to}>
              <div className="explore-card-icon"><c.icon size={22} /></div>
              <div className="explore-card-body">
                <div className="explore-card-title">{c.title} <ArrowRight size={14} /></div>
                <div className="explore-card-text">{c.text}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

export default Home;
