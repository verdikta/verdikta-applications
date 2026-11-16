import { useEffect, useId, useState } from 'react';
import { ArrowRight, FileText, RefreshCw } from 'lucide-react';

import { CLASSES } from '../chain/abi.js';
import { getFeed } from '../lib/api.js';
import { formatEth, formatTime, formatWhole } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';
import { AwardLine, LabelPills } from './Awards.jsx';
import { Code } from './Copy.jsx';
import { Diligence } from './Diligence.jsx';
import { AsOf, Facts, Pills, Tiles, siteErrorText } from './Facts.jsx';
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
  return out;
}

/**
 * One listing of the feed, as a card: its name with its labels and its proof beside it, the artifact
 * it stakes on, the figures a hunter chooses by as tiles, then every other term. Each value is the
 * text it was, under the same `data-testid`.
 */
function Entry({ e }) {
  const id = useId();
  const f = (name) => `feed-${e.listingId}-${name}`;
  const w = e.windows;
  const hash = e.artifactHash.toLowerCase();
  const proved = e.control?.proof === 'yes';
  const noArchive = fill(F.noArchive, { reason: e.archive?.error ?? 'ARCHIVE_UNAVAILABLE' });
  return (
    <section className="claim" aria-labelledby={id} data-testid={`feed-${e.listingId}`}>
      <div className="card-head">
        <h3 id={id}>{fill(F.entry, { id: e.listingId })}</h3>
        <Pills rows={[
          { id: f('labels'), label: F.labels, value: <LabelPills labels={labelsOf(e)} /> },
          { id: f('control'), label: e.control?.subject === 'deployment' ? STRINGS.control.bothLines : STRINGS.control.repository, value: proved ? STRINGS.control.yes : STRINGS.control.no, line: true, tone: proved ? 'pill-ok' : 'pill-warn' },
        ]} />
      </div>
      <Facts className="facts-lead" rows={[
        { id: f('artifact'), label: F.artifact, value: <Code value={artifactLine(e)} what={F.artifact} /> },
      ]} />
      <Tiles rows={[
        { id: f('escrow'), label: F.escrow, value: eth(e.escrowRemainingWei) },
        { id: f('bond'), label: F.bond, value: eth(e.bondWei) },
        { id: f('lowest'), label: F.lowest, value: e.lowestClassCounted },
        { id: f('claims'), label: F.claims, value: String(e.claimsSoFar) },
        { id: f('days-open'), label: F.daysOpen, value: String(e.daysOpen) },
      ]} />
      <Facts rows={[
        { id: f('awards'), label: F.awards, value: <AwardLine text={fill(R.awardsLine, Object.fromEntries(CLASSES.map((c) => [c, formatEth(e.awards[c])])))} lowest={e.lowestClassCounted} /> },
        { id: f('windows'), label: F.windows, value: fill(F.windowsLine, { fix: w.fixWindow / 86400, dispute: w.disputeWindow / 3600, grace: w.disclosureGrace / 3600, reveal: w.revealWindow / 86400, disclose: w.discloseWindow / 60 }) },
        { id: f('opened'), label: F.opened, value: formatTime(e.openedAt) },
        { id: f('funded-until'), label: F.fundedUntil, value: formatTime(e.fundedUntil) },
        BigInt(e.owedWei) > 0n ? { id: f('owed'), label: F.owed, value: eth(e.owedWei) } : null,
        BigInt(e.valueAtRiskUsd) > 0n ? { id: f('value-at-risk'), label: F.valueAtRisk, value: fill(R.usd, { usd: formatWhole(e.valueAtRiskUsd) }) } : null,
        { id: f('scope'), label: F.scope, value: e.scope ? fill(F.scopeLine, { include: e.scope.include.join(', '), exclude: e.scope.exclude.join(', ') || R.none }) : noArchive },
        // node P20: where the listing says its requirements are written
        { id: f('documents'), label: F.documents, value: Array.isArray(e.documents) ? (e.documents.length ? <span className="mono">{e.documents.join(', ')}</span> : F.documentsNone) : e.archive?.ok ? F.documentsUnread : noArchive },
        { id: f('hash'), label: R.artifactHash, value: <Code value={hash} what={R.artifactHash} /> },
        { id: f('image'), label: F.image, value: e.image ? <Code value={e.image} what={F.image} /> : noArchive },
      ]} />
      <p className="actions card-foot">
        <a className="button" href={`#/record/${hash}`}><FileText size={16} aria-hidden="true" />{F.record}</a>
        <a className="button secondary" href={`#/fund/${e.listingId}`}>{F.listing}<ArrowRight size={16} aria-hidden="true" /></a>
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
            { id: `feed-apart-${e.listingId}-artifact`, label: F.artifact, value: <Code value={artifactLine(e)} what={F.artifact} /> },
            { id: `feed-apart-${e.listingId}-maker`, label: N.maker, value: <Code value={e.maker} what={N.maker} /> },
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

  const again = (
    <button type="button" className="secondary" onClick={() => setAttempt((x) => x + 1)}>
      <RefreshCw size={16} aria-hidden="true" />
      {STRINGS.site.retry}
    </button>
  );
  let body;
  if (!loaded) body = <><div className="toolbar"><p className="hint">{F.loading}</p>{again}</div></>;
  else if (loaded.failed) body = <><div className="toolbar"><span />{again}</div><p className="error">{loaded.failed}</p></>;
  else {
    const { feed } = loaded;
    body = (
      <>
        <AsOf view={feed} testId="feed-as-of">{again}</AsOf>
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
      {body}
      <Diligence />
    </>
  );
}
