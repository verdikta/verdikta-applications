import { useEffect, useId, useState } from 'react';

import { LISTING_STATES } from '../chain/abi.js';
import { WalletError, chainReader, stakeAttestation } from '../chain/wallet.js';
import { errorReason, formatEth, formatTime } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';
import { TextField } from './Field.jsx';
import { FundListing } from './FundListing.jsx';

const F = STRINGS.fund;
const CLASSES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

async function readListing(listingId) {
  const sa = stakeAttestation(await chainReader());
  const id = BigInt(listingId);
  if (id === 0n || id > (await sa.listingCount())) return null;
  return sa.getListing(id);
}

/**
 * A listing's own page (#/fund/<id>): its stored terms and, while it is Listed, the opening
 * fund(). It is where a maker who left the listing flow between list() and fund() comes back to.
 */
export function FundPage({ listingId }) {
  const headingId = useId();
  const [lookup, setLookup] = useState('');
  const [loaded, setLoaded] = useState(null); // { listing } | { missing } | { failed }

  useEffect(() => {
    if (listingId === null) return undefined;
    let live = true;
    readListing(listingId)
      .then((l) => { if (live) setLoaded(l ? { listing: l } : { missing: true }); })
      .catch((err) => { if (live) setLoaded({ failed: err instanceof WalletError ? fill(STRINGS.wallet[err.code], err.vars) : errorReason(err) }); });
    return () => { live = false; };
  }, [listingId]);

  const header = (
    <>
      <h2>{F.title}</h2>
      <p className="lead">{F.intro}</p>
    </>
  );
  const go = () => { if (/^\d{1,20}$/.test(lookup.trim())) window.location.hash = `#/fund/${lookup.trim()}`; };
  const lookupForm = (
    <div className="lookup">
      <TextField label={F.listingId} value={lookup} onChange={setLookup} inputMode="numeric" />
      <button type="button" onClick={go}>{F.load}</button>
    </div>
  );

  if (listingId === null) return <>{header}{lookupForm}</>;
  if (!loaded) return <>{header}<p className="hint">{F.loading}</p></>;
  if (loaded.missing) return <>{header}<p className="error">{fill(F.notFound, { id: listingId })}</p>{lookupForm}</>;
  if (loaded.failed) return <>{header}<p className="error">{fill(F.readFailed, { reason: loaded.failed })}</p></>;

  const l = loaded.listing;
  const state = LISTING_STATES[Number(l.state)];
  return (
    <>
      {header}
      <section className="claim" aria-labelledby={headingId} data-testid="listing-summary">
        <h3 id={headingId}>{fill(F.summary, { id: listingId })}</h3>
        <dl>
          <dt>{F.maker}</dt><dd className="mono">{l.maker}</dd>
          <dt>{F.state}</dt><dd>{F.states[state] ?? state}</dd>
          <dt>{F.listingCid}</dt><dd className="mono">{l.listingCid}</dd>
        </dl>
        <ul>
          <li>{fill(STRINGS.chain.awards, Object.fromEntries(CLASSES.map((c, i) => [c, formatEth(l.awards[i])])))}</li>
          <li>{fill(STRINGS.chain.bond, { bond: formatEth(l.bondWei) })}</li>
          <li>{fill(STRINGS.chain.windows, { fix: Number(l.fixWindow) / 86400, dispute: Number(l.disputeWindow) / 3600, grace: Number(l.disclosureGrace) / 3600, reveal: Number(l.revealWindow) / 86400 })}</li>
          <li>{l.allowlist.length ? fill(STRINGS.chain.allowlist, { count: l.allowlist.length }) : STRINGS.chain.open}</li>
          <li>{fill(STRINGS.chain.knownIssues, { count: l.knownIssueIds.length })}</li>
        </ul>
      </section>
      {state === 'Listed' && <FundListing listingId={BigInt(listingId)} top={l.awards[3]} maker={l.maker} artifactHash={l.artifactHash} />}
      {state === 'Open' && <p className="ok">{fill(F.alreadyOpen, { id: listingId, until: formatTime(l.fundedUntil) })}</p>}
      {state !== 'Listed' && state !== 'Open' && <p className="hint">{fill(F.notFundable, { id: listingId, state: F.states[state] ?? state })}</p>}
    </>
  );
}
