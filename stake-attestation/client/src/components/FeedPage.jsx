import { useEffect, useId, useState } from 'react';

import { CLASSES } from '../chain/abi.js';
import { getFeed } from '../lib/api.js';
import { formatEth, formatTime, formatWhole } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';
import { Diligence } from './Diligence.jsx';
import { AsOf, Facts, labelText, siteErrorText } from './Facts.jsx';
import { ListingWarning } from './ListingWarning.jsx';

const F = STRINGS.feed;
const R = STRINGS.record;
const eth = (wei) => fill(R.eth, { eth: formatEth(wei) });

function artifactLine(e) {
  const a = e.artifact;
  if (a.kind === 'Contract') return fill(F.contractAt, { address: a.address, chainId: a.chainId, repo: a.repo, commit: a.baseCommit });
  return fill(F.repoAt, { repo: a.repo, commit: a.baseCommit });
}

/** The labels as the record page shows them: the stake label, or why there is none, then invited. */
function labelsOf(e) {
  const out = [];
  if (e.labels.stake) out.push(e.labels.stake);
  else if (e.labels.error) out.push('noPrice');
  if (e.labels.invited) out.push('invited');
  return labelText(out);
}

function Entry({ e }) {
  const id = useId();
  const f = (name) => `feed-${e.listingId}-${name}`;
  const w = e.windows;
  const noArchive = fill(F.noArchive, { reason: e.archive?.error ?? 'ARCHIVE_UNAVAILABLE' });
  return (
    <section className="claim" aria-labelledby={id} data-testid={`feed-${e.listingId}`}>
      <h3 id={id}>{fill(F.entry, { id: e.listingId })}</h3>
      <Facts rows={[
        { id: f('artifact'), label: F.artifact, value: <span className="mono">{artifactLine(e)}</span> },
        { id: f('hash'), label: R.artifactHash, value: <span className="mono">{e.artifactHash.toLowerCase()}</span> },
        { id: f('labels'), label: F.labels, value: labelsOf(e) || R.none },
        { id: f('control'), label: e.control?.subject === 'deployment' ? STRINGS.control.bothLines : STRINGS.control.repository, value: e.control?.proof === 'yes' ? STRINGS.control.yes : STRINGS.control.no },
        { id: f('awards'), label: F.awards, value: fill(R.awardsLine, Object.fromEntries(CLASSES.map((c) => [c, formatEth(e.awards[c])]))) },
        { id: f('lowest'), label: F.lowest, value: e.lowestClassCounted },
        { id: f('bond'), label: F.bond, value: eth(e.bondWei) },
        { id: f('windows'), label: F.windows, value: fill(F.windowsLine, { fix: w.fixWindow / 86400, dispute: w.disputeWindow / 3600, grace: w.disclosureGrace / 3600, reveal: w.revealWindow / 86400, disclose: w.discloseWindow / 60 }) },
        { id: f('opened'), label: F.opened, value: formatTime(e.openedAt) },
        { id: f('funded-until'), label: F.fundedUntil, value: formatTime(e.fundedUntil) },
        { id: f('days-open'), label: F.daysOpen, value: String(e.daysOpen) },
        { id: f('claims'), label: F.claims, value: String(e.claimsSoFar) },
        { id: f('escrow'), label: F.escrow, value: eth(e.escrowRemainingWei) },
        BigInt(e.owedWei) > 0n ? { id: f('owed'), label: F.owed, value: eth(e.owedWei) } : null,
        BigInt(e.valueAtRiskUsd) > 0n ? { id: f('value-at-risk'), label: F.valueAtRisk, value: fill(R.usd, { usd: formatWhole(e.valueAtRiskUsd) }) } : null,
        { id: f('image'), label: F.image, value: e.image ? <span className="mono">{e.image}</span> : noArchive },
        { id: f('scope'), label: F.scope, value: e.scope ? fill(F.scopeLine, { include: e.scope.include.join(', '), exclude: e.scope.exclude.join(', ') || R.none }) : noArchive },
        // node P20: where the listing says its requirements are written
        { id: f('documents'), label: F.documents, value: Array.isArray(e.documents) ? (e.documents.length ? <span className="mono">{e.documents.join(', ')}</span> : F.documentsNone) : e.archive?.ok ? F.documentsUnread : noArchive },
      ]} />
      <p className="actions">
        <a href={`#/record/${e.artifactHash.toLowerCase()}`}>{F.record}</a>
        <a href={`#/fund/${e.listingId}`}>{F.listing}</a>
      </p>
    </section>
  );
}

/** Listings that take claims on-chain and do not count: the site offers no commit on them. */
function NotOffered({ list }) {
  const N = STRINGS.notCounted;
  if (!list?.length) return null;
  return (
    <section className="claim" data-testid="feed-not-counted">
      <h3>{N.feedTitle}</h3>
      <p className="hint">{N.feedIntro}</p>
      {list.map((e) => (
        <Facts
          key={e.listingId}
          rows={[
            { id: `feed-apart-${e.listingId}-artifact`, label: F.artifact, value: <span className="mono">{artifactLine(e)}</span> },
            { id: `feed-apart-${e.listingId}-maker`, label: N.maker, value: <span className="mono">{e.maker}</span> },
            { id: `feed-apart-${e.listingId}-why`, label: N.why, value: e.detail ?? e.reason },
          ]}
        />
      ))}
    </section>
  );
}

/** The listing feed (#/feed; design §15): every listing that counts and takes claims, from GET /api/feed. */
export function FeedPage() {
  const [loaded, setLoaded] = useState(null); // { feed } | { failed }
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getFeed()
      .then((feed) => { if (live) setLoaded({ feed }); })
      .catch((err) => { if (live) setLoaded({ failed: siteErrorText(err) }); });
    return () => { live = false; };
  }, [attempt]);

  let body;
  if (!loaded) body = <p className="hint">{F.loading}</p>;
  else if (loaded.failed) body = <p className="error">{loaded.failed}</p>;
  else {
    const { feed } = loaded;
    body = (
      <>
        <AsOf view={feed} testId="feed-as-of" />
        {feed.listings.length ? feed.listings.map((e) => <Entry key={e.listingId} e={e} />) : <p>{F.empty}</p>}
        <NotOffered list={feed.notCounted} />
      </>
    );
  }
  return (
    <>
      <h2>{F.title}</h2>
      <p className="lead">{F.intro}</p>
      <ListingWarning />
      <button type="button" className="secondary" onClick={() => setAttempt((x) => x + 1)}>{STRINGS.site.retry}</button>
      {body}
      <Diligence />
    </>
  );
}
