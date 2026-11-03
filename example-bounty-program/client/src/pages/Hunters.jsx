/**
 * Hunters Page (/analytics/hunters?view=submitters|winners)
 * Lists the wallet addresses that have submitted work, or won bounties, on the
 * current contract. Reached from the Bounty Hunters block on /analytics.
 */

import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Users, Trophy, ArrowDown, ArrowUp } from 'lucide-react';
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
  }
};

const COLUMNS = [
  { key: 'address', label: 'Address' },
  { key: 'submissions', label: 'Submissions', numeric: true },
  { key: 'bounties', label: 'Bounties Entered', numeric: true },
  { key: 'wins', label: 'Wins', numeric: true },
  { key: 'ethWon', label: 'ETH Won', numeric: true },
  { key: 'lastSubmittedAt', label: 'Last Submission', numeric: true }
];

const MAX_BOUNTY_LINKS = 5;

const formatDate = (secs) => (secs ? new Date(secs * 1000).toLocaleDateString() : '—');

function Hunters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === 'winners' ? 'winners' : 'submitters';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState({ key: 'wins', dir: 'desc' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiService.getHunterAnalytics(view)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) throw new Error(result.error || 'Failed to load hunters');
        setData(result.data);
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Failed to load hunters'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view]);

  const rows = useMemo(() => {
    const list = [...(data?.hunters || [])];
    const { key, dir } = sort;
    const sign = dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const av = a[key] ?? 0;
      const bv = b[key] ?? 0;
      const cmp = key === 'address'
        ? String(av).toLowerCase().localeCompare(String(bv).toLowerCase())
        : av - bv;
      // Ties fall back to wins, then submissions, both descending
      return sign * cmp || b.wins - a.wins || b.submissions - a.submissions;
    });
    return list;
  }, [data, sort]);

  const toggleSort = (key) => {
    setSort((prev) => (prev.key === key
      ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: key === 'address' ? 'asc' : 'desc' }));
  };

  const explorerUrl = config.networks[config.network]?.explorer || 'https://sepolia.basescan.org';
  const { title, icon: Icon, blurb } = VIEWS[view];

  return (
    <div className="hunters-page">
      <Link to="/analytics" className="back-link">
        <ArrowLeft size={16} /> Back to Analytics
      </Link>

      <h1><Icon size={24} className="inline-icon" /> Bounty Hunters: {title}</h1>
      <p className="hunters-blurb">{blurb}</p>

      <div className="view-tabs" role="tablist">
        {Object.entries(VIEWS).map(([key, v]) => {
          const count = key === 'winners' ? data?.totalWinners : data?.totalSubmitters;
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

      {loading ? (
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
                  <td>
                    <a
                      href={`${explorerUrl}/address/${h.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="address-link"
                      title="View on block explorer"
                    >
                      <code>{h.address}</code>
                      <ExternalLink size={12} />
                    </a>
                  </td>
                  <td className="numeric">{h.submissions}</td>
                  <td className="numeric">{h.bounties}</td>
                  <td className="numeric">{h.wins}</td>
                  <td className="numeric">{h.ethWon > 0 ? h.ethWon : '—'}</td>
                  <td className="numeric">{formatDate(h.lastSubmittedAt)}</td>
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
