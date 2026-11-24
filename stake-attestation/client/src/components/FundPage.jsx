import { useCallback, useEffect, useId, useState } from 'react';

import { LISTING_STATES } from '../chain/abi.js';
import { WalletError, chainReader, stakeAttestation } from '../chain/wallet.js';
import { safeguardTerms } from '../lib/claimActions.js';
import { errorReason, formatEth, formatTime, formatWhole } from '../lib/format.js';
import { holdView, readHold } from '../lib/hold.js';
import { STRINGS, fill } from '../strings.js';
import { AwardLine, StatePill } from './Awards.jsx';
import { Code } from './Copy.jsx';
import { TextField } from './Field.jsx';
import { FundListing } from './FundListing.jsx';
import { CloseListing, RenewListing, TopUpEscrow, Withdraw } from './ListingActions.jsx';
import { ListingMore } from './ListingExtras.jsx';
import { ListingWarning } from './ListingWarning.jsx';
import { DisclosureKeyForms } from './SameRepository.jsx';

const F = STRINGS.fund;
const CLASSES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * The listing and its hold (node P42), read at one block: a hold mined between two reads never pairs a listing with
 * the hold of another moment. A contract deployed before the hold refuses the heldAt call, which readHold answers as
 * "no hold here"; a read that fails any other way rejects with the rest, and the page says it could not be read.
 * @returns {Promise<null | { listing: object, hold: { supported: boolean, heldAt: bigint } }>} null: no such listing
 */
async function readListing(listingId) {
  const provider = await chainReader();
  const sa = stakeAttestation(provider);
  const id = BigInt(listingId);
  if (id === 0n || id > (await sa.listingCount())) return null;
  // a raw eth_blockNumber: ethers' getBlockNumber() may answer from a cache
  const blockTag = Number(await provider.send('eth_blockNumber', []));
  const [listing, hold] = await Promise.all([sa.getListing(id, { blockTag }), readHold(sa, id, { blockTag })]);
  return { listing, hold };
}

/**
 * A listing's own page (#/fund/<id>): its stored terms and, while it is Listed, the opening
 * fund(). It is where a maker who left the listing flow between list() and fund() comes back to.
 * Once it opened: its claims, its record, a top-up of its escrow and, while it is Open or Depleted, the maker's
 * hold (where the contract has one), roll forward and renew.
 * Until it is closed: close. And for a connected wallet the contract holds something for: withdraw.
 * A listing on hold (node P42) stays Open or Depleted: the page says the hold beside the state, with its time.
 */
export function FundPage({ listingId }) {
  const headingId = useId();
  const [lookup, setLookup] = useState('');
  const [loaded, setLoaded] = useState(null); // { listing, hold } | { missing } | { failed }
  const [attempt, setAttempt] = useState(0);
  const [openedHere, setOpenedHere] = useState(false);
  // the time of a hold this page sent and saw mined: { listingId, at }, so a read from before it never undoes it
  const [heldHere, setHeldHere] = useState(null);
  // how many times an action on this page changed the chain: what reads it (the withdrawable amount) reads again
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (listingId === null) return undefined;
    let live = true;
    setLoaded(null);
    readListing(listingId)
      .then((read) => { if (live) setLoaded(read ?? { missing: true }); })
      .catch((err) => { if (live) setLoaded({ failed: err instanceof WalletError ? fill(STRINGS.wallet[err.code], err.vars) : errorReason(err) }); });
    return () => { live = false; };
  }, [listingId, attempt]);

  // After an action on this page: the listing as the chain has it now, read without taking the page down, so
  // the action's own line (renewed, closed) stays where it was said.
  const refresh = useCallback(() => {
    setVersion((v) => v + 1);
    readListing(listingId)
      .then((read) => {
        if (!read) return;
        setOpenedHere(false);
        setLoaded(read);
      })
      .catch(() => {});
  }, [listingId]);
  /** A hold this page sent was mined at `at` (its Held event): said at once, then the listing is read again. */
  const onHeld = useCallback((at) => {
    setHeldHere({ listingId, at });
    refresh();
  }, [listingId, refresh]);

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
  if (loaded.failed) {
    return (
      <>
        {header}
        <p className="error">{fill(F.readFailed, { reason: loaded.failed })}</p>
        <button type="button" onClick={() => setAttempt((a) => a + 1)}>{F.retry}</button>
      </>
    );
  }

  const l = loaded.listing;
  const state = LISTING_STATES[Number(l.state)];
  // the hold as the chain has it, or as this page saw it mined (lib/hold.js holdView)
  const hold = holdView(l, loaded.hold, heldHere?.listingId === listingId ? heldHere.at : null);
  // errata E8 and E9: the floor and the size list() copied onto this listing, for its whole life
  const terms = safeguardTerms(l);
  return (
    <>
      {header}
      <ListingWarning />
      <section className="claim card-main" aria-labelledby={headingId} data-testid="listing-summary">
        <h3 id={headingId}>{fill(F.summary, { id: listingId })}</h3>
        <dl>
          <dt>{F.maker}</dt><dd><Code value={l.maker} what={F.maker} /></dd>
          {/* the state is the chain's; a listing on hold takes no claims, so its pill is never the green of one that does */}
          <dt>{F.state}</dt><dd data-testid="listing-state"><StatePill state={hold.held ? null : openedHere ? 'Open' : state} text={F.states[openedHere ? 'Open' : state] ?? state} /></dd>
          {hold.held && <><dt>{F.heldSince}</dt><dd data-testid="listing-held-since">{formatTime(hold.heldAt)}</dd></>}
          <dt>{F.listingCid}</dt><dd><Code value={l.listingCid} what={F.listingCid} /></dd>
          <dt>{F.disclosureKey}</dt><dd><DisclosureKeyForms bytes32={l.disclosureKey} testId="listing-disclosure-key" /></dd>
        </dl>
        <ul className="terms">
          <li><AwardLine text={fill(STRINGS.chain.awards, Object.fromEntries(CLASSES.map((c, i) => [c, formatEth(l.awards[i])])))} /></li>
          <li>{fill(STRINGS.chain.bond, { bond: formatEth(l.bondWei) })}</li>
          <li>{fill(STRINGS.chain.windows, { fix: Number(l.fixWindow) / 86400, dispute: Number(l.disputeWindow) / 3600, grace: Number(l.disclosureGrace) / 3600, reveal: Number(l.revealWindow) / 86400 })}</li>
          <li>{l.allowlist.length ? fill(STRINGS.chain.allowlist, { count: l.allowlist.length }) : STRINGS.chain.open}</li>
          <li>{fill(STRINGS.chain.knownIssues, { count: l.knownIssueIds.length })}</li>
          <li data-testid="listing-band">{terms.band.empty ? STRINGS.chain.bandEmpty : fill(STRINGS.chain.band, { floor: formatWhole(terms.band.floor), points: terms.band.points })}</li>
          <li data-testid="listing-size">{terms.size.all ? STRINGS.chain.sizeAll : fill(STRINGS.chain.size, { size: formatEth(terms.size.wei) })}</li>
        </ul>
      </section>
      {state === 'Listed' && <FundListing listingId={BigInt(listingId)} top={l.awards[3]} maker={l.maker} artifactHash={l.artifactHash} onOpened={() => setOpenedHere(true)} />}
      {state === 'Open' && !hold.held && <p className="ok">{fill(F.alreadyOpen, { id: listingId, until: formatTime(l.fundedUntil) })}</p>}
      {hold.held && <p className="warning" data-testid="listing-held">{fill(F.held, { id: listingId, time: formatTime(hold.heldAt) })}</p>}
      {state !== 'Listed' && state !== 'Open' && <p className="hint">{fill(F.notFundable, { id: listingId, state: F.states[state] ?? state })}</p>}
      <ListingMore listingId={listingId} listing={l} hold={hold} onHeld={onHeld} onChanged={refresh} />
      <TopUpEscrow listingId={listingId} listing={l} held={hold.held} onChanged={refresh} />
      <RenewListing listingId={listingId} listing={l} held={hold.held} onChanged={refresh} />
      <CloseListing listingId={listingId} listing={l} onChanged={refresh} />
      <Withdraw version={version} />
    </>
  );
}
