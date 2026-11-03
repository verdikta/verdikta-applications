/**
 * Hunters Page (/analytics/hunters?view=submitters|winners|connections)
 * Lists the wallet addresses that have submitted work, or won bounties, on the
 * current contract, and groups of those addresses that are linked on chain.
 * Reached from the Bounty Hunters block on /analytics.
 */

import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams, useLocation } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Users, Trophy, ArrowDown, ArrowUp, Link2 } from 'lucide-react';
import { apiService } from '../services/api';
import { config } from '../config';
import './Hunters.css';

const VIEWS = {
  submitters: {
    title: 'Submitters',
    icon: Users,
    blurb: 'Every wallet address with at least one submission on the current bounty contract, prepared or evaluated.'
  },
  winners: {
    title: 'Winners',
    icon: Trophy,
    blurb: 'Wallet addresses that have been paid for at least one bounty on the current contract.'
  },
  connections: {
    title: 'Connections',
    icon: Link2,
    blurb: 'Groups of hunter addresses that are linked on chain: one funded another, they share a parent account (the address that first funded them, or the owner of a smart wallet), or tokens moved between them. A link is evidence of a connection, not proof that one person controls the addresses.'
  }
};

const COLUMNS = [
  { key: 'address', label: 'Address' },
  { key: 'submissions', label: 'Submissions', numeric: true },
  { key: 'bounties', label: 'Bounties Entered', numeric: true },
  { key: 'wins', label: 'Wins', numeric: true },
  { key: 'ethWon', label: 'ETH Won', numeric: true },
  { key: 'lastSubmittedAt', label: 'Last Submission', numeric: true },
  { key: 'group', label: 'Group', numeric: true }
];

const MAX_BOUNTY_LINKS = 5;

const VIA_LABELS = {
  direct: 'direct transfer',
  deposit: 'bridge deposit from L1',
  'contract-call': 'through a contract call',
  creation: 'created the wallet',
  owner: 'wallet owner'
};

const formatDate = (secs) => (secs ? new Date(secs * 1000).toLocaleDateString() : '—');
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

const formatAgo = (ms) => {
  if (!ms) return 'never';
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

function Hunters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const raw = searchParams.get('view');
  const view = VIEWS[raw] ? raw : 'submitters';
  const listView = view === 'connections' ? 'submitters' : view;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [links, setLinks] = useState(null);
  const [linksError, setLinksError] = useState(null);
  const [sort, setSort] = useState({ key: 'wins', dir: 'desc' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiService.getHunterAnalytics(listView)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) throw new Error(result.error || 'Failed to load hunters');
        setData(result.data);
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Failed to load hunters'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [listView]);

  // Connections load once; the tab count and the Group column use them too
  useEffect(() => {
    let cancelled = false;
    apiService.getHunterConnections()
      .then((result) => {
        if (cancelled) return;
        if (!result.success) throw new Error(result.error || 'Failed to load connections');
        setLinks(result.data);
      })
      .catch((err) => { if (!cancelled) setLinksError(err.message || 'Failed to load connections'); });
    return () => { cancelled = true; };
  }, []);

  // Group links from the tables jump to #group-N
  useEffect(() => {
    if (view !== 'connections' || !links || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [view, links, location.hash]);

  const rows = useMemo(() => {
    const list = [...(data?.hunters || [])];
    const { key, dir } = sort;
    const sign = dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let cmp;
      if (key === 'address') {
        cmp = String(a.address).toLowerCase().localeCompare(String(b.address).toLowerCase());
      } else if (key === 'group') {
        // Ungrouped addresses always sort last
        if (a.group == null || b.group == null) return (a.group == null) - (b.group == null);
        cmp = a.group - b.group;
      } else {
        cmp = (a[key] ?? 0) - (b[key] ?? 0);
      }
      // Ties fall back to wins, then submissions, both descending
      return sign * cmp || b.wins - a.wins || b.submissions - a.submissions;
    });
    return list;
  }, [data, sort]);

  const toggleSort = (key) => {
    setSort((prev) => (prev.key === key
      ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: key === 'address' || key === 'group' ? 'asc' : 'desc' }));
  };

  const explorerUrl = config.networks[config.network]?.explorer || 'https://sepolia.basescan.org';
  const { title, icon: Icon, blurb } = VIEWS[view];

  const AddressLink = ({ address, short = false }) => (
    <a
      href={`${explorerUrl}/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className="address-link"
      title={short ? address : 'View on block explorer'}
    >
      <code>{short ? shortAddr(address) : address}</code>
      <ExternalLink size={12} />
    </a>
  );

  const TxLink = ({ hash, label = 'tx' }) => (hash ? (
    <a href={`${explorerUrl}/tx/${hash}`} target="_blank" rel="noopener noreferrer" className="tx-link" title={hash}>
      {label}
    </a>
  ) : null);

  const tabCount = (key) => {
    if (key === 'winners') return data?.totalWinners;
    if (key === 'submitters') return data?.totalSubmitters;
    return links?.coverage?.lastRunAt ? links.groups.length : null;
  };

  const renderEvidence = (link, i) => {
    if (link.type === 'funded') {
      return (
        <li key={i}>
          {link.via === 'owner' ? (
            <><AddressLink address={link.from} short /> owns the smart wallet <AddressLink address={link.to} short /></>
          ) : link.via === 'creation' ? (
            <><AddressLink address={link.from} short /> created the wallet <AddressLink address={link.to} short /></>
          ) : (
            <><AddressLink address={link.from} short /> sent <AddressLink address={link.to} short /> its first ETH ({VIA_LABELS[link.via] || link.via})</>
          )}
          {' '}<TxLink hash={link.txHash} />
        </li>
      );
    }
    if (link.type === 'shared-funder') {
      return (
        <li key={i}>
          {link.relation === 'owner' ? 'Smart wallets owned by the same address ' : 'First funded by the same address '}
          <AddressLink address={link.funder} short />
          {link.funderNonce != null && <span className="muted"> ({link.funderNonce.toLocaleString()} txs sent)</span>}
          {': '}
          {link.members.map((m, j) => (
            <span key={m.address} className="evidence-member">
              {j > 0 && ', '}
              <AddressLink address={m.address} short />
              {m.txHash && <> <TxLink hash={m.txHash} /></>}
            </span>
          ))}
        </li>
      );
    }
    return (
      <li key={i}>
        <AddressLink address={link.from} short /> sent {link.symbol || <code>{shortAddr(link.token)}</code>} tokens to{' '}
        <AddressLink address={link.to} short />
        {link.count > 1 && <span className="muted"> ({link.count} transfers)</span>}
        {' '}<TxLink hash={link.txHash} label={link.count > 1 ? 'latest tx' : 'tx'} />
      </li>
    );
  };

  const renderConnections = () => {
    if (linksError) return <div className="hunters-state error">{linksError}</div>;
    if (!links) return <div className="hunters-state">Loading connections...</div>;
    const { groups, hubs, coverage, status } = links;
    return (
      <>
        <div className="analysis-status">
          {status?.running && <span className="running">Analysis running ({status.phase}). </span>}
          {coverage.lastRunAt ? (
            <>
              Last analyzed {formatAgo(coverage.lastRunAt)}. {coverage.analyzed} of {coverage.hunters} hunters analyzed;
              a parent account was found for {coverage.parentKnown}
              {coverage.neverFunded > 0 && <> ({coverage.neverFunded} never held ETH)</>}.
              {coverage.tokenScanThroughBlock != null && <> Token transfers checked through block {coverage.tokenScanThroughBlock.toLocaleString()}.</>}
            </>
          ) : (
            <>The first analysis has not finished yet. It runs in the background; check back later.</>
          )}
          {coverage.lastError && <span className="error-text"> Last run stopped early: {coverage.lastError}</span>}
        </div>

        {coverage.lastRunAt && groups.length === 0 && (
          <div className="hunters-state">No linked hunter addresses found.</div>
        )}

        {groups.map((g) => (
          <section key={g.id} id={`group-${g.id}`} className="connection-group">
            <h2>
              Group {g.id}
              <span className="group-meta">
                {g.members.length} addresses · {g.wins} {g.wins === 1 ? 'win' : 'wins'}
                {g.ethWon > 0 && <> · {g.ethWon} ETH won</>}
              </span>
            </h2>
            <table className="hunters-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th className="numeric">Submissions</th>
                  <th className="numeric">Wins</th>
                  <th className="numeric">ETH Won</th>
                </tr>
              </thead>
              <tbody>
                {g.members.map((m) => (
                  <tr key={m.address}>
                    <td><AddressLink address={m.address} /></td>
                    <td className="numeric">{m.submissions}</td>
                    <td className="numeric">{m.wins}</td>
                    <td className="numeric">{m.ethWon > 0 ? m.ethWon : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3>Evidence</h3>
            <ul className="evidence">{g.links.map(renderEvidence)}</ul>
          </section>
        ))}

        {hubs.length > 0 && (
          <details className="hubs">
            <summary>
              {hubs.length} shared {hubs.length === 1 ? 'funder' : 'funders'} not counted as links
            </summary>
            <p className="muted">
              These addresses first funded two or more hunters but have sent
              {' '}{coverage.hubNonceThreshold.toLocaleString()}+ transactions or are contracts, which is typical
              of exchanges, faucets, bridges and relayers that fund many unrelated people.
            </p>
            <table className="hunters-table">
              <thead>
                <tr>
                  <th>Funder</th>
                  <th className="numeric">Hunters Funded</th>
                  <th className="numeric">Txs Sent</th>
                </tr>
              </thead>
              <tbody>
                {hubs.map((h) => (
                  <tr key={h.funder}>
                    <td><AddressLink address={h.funder} /></td>
                    <td className="numeric">{h.hunters}</td>
                    <td className="numeric">
                      {h.unchecked ? 'not checked yet' : h.isContract ? 'contract' : h.nonce?.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}

        <p className="method-note muted">
          How this works: for each hunter the analysis finds the address that first sent it ETH (or, for a smart
          wallet, its owners), then checks token Transfer events between hunters. It cannot see plain ETH
          sends between hunters after their first funding, so some connections may be missing.
        </p>
      </>
    );
  };

  return (
    <div className="hunters-page">
      <Link to="/analytics" className="back-link">
        <ArrowLeft size={16} /> Back to Analytics
      </Link>

      <h1><Icon size={24} className="inline-icon" /> Bounty Hunters: {title}</h1>
      <p className="hunters-blurb">{blurb}</p>

      <div className="view-tabs" role="tablist">
        {Object.entries(VIEWS).map(([key, v]) => {
          const count = tabCount(key);
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              className={`view-tab ${view === key ? 'active' : ''}`}
              onClick={() => setSearchParams({ view: key })}
            >
              {v.title}{count != null && <span className="tab-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {view === 'connections' ? renderConnections() : loading ? (
        <div className="hunters-state">Loading {title.toLowerCase()}...</div>
      ) : error ? (
        <div className="hunters-state error">{error}</div>
      ) : rows.length === 0 ? (
        <div className="hunters-state">No {title.toLowerCase()} yet.</div>
      ) : (
        <div className="hunters-table-wrap">
          <table className="hunters-table">
            <thead>
              <tr>
                <th className="rank">#</th>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className={`sortable ${c.numeric ? 'numeric' : ''}`}
                    aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    title={c.key === 'group' ? 'Connection group, if this address is linked on chain to another hunter' : undefined}
                  >
                    <button type="button" onClick={() => toggleSort(c.key)}>
                      {c.label}
                      {sort.key === c.key && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                    </button>
                  </th>
                ))}
                {view === 'winners' && <th>Bounties Won</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((h, i) => (
                <tr key={h.address.toLowerCase()}>
                  <td className="rank">{i + 1}</td>
                  <td><AddressLink address={h.address} /></td>
                  <td className="numeric">{h.submissions}</td>
                  <td className="numeric">{h.bounties}</td>
                  <td className="numeric">{h.wins}</td>
                  <td className="numeric">{h.ethWon > 0 ? h.ethWon : '—'}</td>
                  <td className="numeric">{formatDate(h.lastSubmittedAt)}</td>
                  <td className="numeric">
                    {h.group != null
                      ? <Link to={`/analytics/hunters?view=connections#group-${h.group}`} className="group-link">#{h.group}</Link>
                      : <span className="muted">—</span>}
                  </td>
                  {view === 'winners' && (
                    <td className="bounty-links">
                      {h.wonBountyIds.slice(0, MAX_BOUNTY_LINKS).map((id) => (
                        <Link key={id} to={`/bounty/${id}`}>#{id}</Link>
                      ))}
                      {h.wonBountyIds.length > MAX_BOUNTY_LINKS && (
                        <span
                          className="more"
                          title={h.wonBountyIds.slice(MAX_BOUNTY_LINKS).map((id) => `#${id}`).join(', ')}
                        >
                          +{h.wonBountyIds.length - MAX_BOUNTY_LINKS} more
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default Hunters;
