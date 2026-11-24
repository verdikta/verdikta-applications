import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';

import { LISTING_STATES } from '../chain/abi.js';
import { WalletError, chainReader, stakeAttestation } from '../chain/wallet.js';
import { safeguardTerms } from '../lib/claimActions.js';
import { errorReason, formatEth, formatTime, formatWhole } from '../lib/format.js';
import { holdView, readHold } from '../lib/hold.js';
import { readFrom } from '../lib/poll.js';
import { STRINGS, fill } from '../strings.js';
import { AwardLine, StatePill } from './Awards.jsx';
import { Code } from './Copy.jsx';
import { TextField } from './Field.jsx';
import { FundListing } from './FundListing.jsx';
import { CloseListing, RenewListing, TopUpEscrow, Withdraw } from './ListingActions.jsx';
import { ListingMore } from './ListingExtras.jsx';
import { ListingWarning } from './ListingWarning.jsx';
import { useSeenMined } from './seenMined.js';
import { DisclosureKeyForms } from './SameRepository.jsx';

const F = STRINGS.fund;
const CLASSES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * The listing, its hold (node P42) and whether it takes a commit as commit() decides it, read at one block: a hold
 * mined between two reads never pairs a listing with the hold of another moment. A contract deployed before the hold
 * refuses the heldAt call, which readHold answers as "no hold here"; a read that fails any other way rejects with the
 * rest, and the page says it could not be read. `block` is the block every part of the answer is of, and "no such
 * listing" is an answer of a block too: a listing whose block was dropped is gone as of the block read, which is how
 * a page waiting for a later block learns of it.
 * @returns {Promise<{ missing: true, block: number } | { listing: object, hold: { supported: boolean, heldAt: bigint }, takesCommits: boolean, block: number }>}
 */
async function readListing(listingId) {
  const provider = await chainReader();
  const sa = stakeAttestation(provider);
  const id = BigInt(listingId);
  // a raw eth_blockNumber: ethers' getBlockNumber() may answer from a cache
  const block = Number(await provider.send('eth_blockNumber', []));
  const at = { blockTag: block };
  if (id === 0n || id > (await sa.listingCount(at))) return { missing: true, block };
  const [listing, hold, takesCommits] = await Promise.all([sa.getListing(id, at), readHold(sa, id, at), sa.acceptsCommits(id, at)]);
  return { listing, hold, takesCommits, block };
}

/**
 * A listing's own page (#/fund/<id>): its stored terms and, while it is Listed, the opening
 * fund(). It is where a maker who left the listing flow between list() and fund() comes back to.
 * Once it opened: its claims, its record, a top-up of its escrow and, while it is Open or Depleted, the maker's
 * hold (where the contract has one), roll forward and renew.
 * Until it is closed: close. And for a connected wallet the contract holds something for: withdraw.
 * A listing on hold (node P42) stays Open or Depleted: the page says the hold beside the state, with its time.
 * After each transaction sent from it the page reads the listing again from the block the transaction was mined in.
 */
export function FundPage({ listingId }) {
  const headingId = useId();
  const [lookup, setLookup] = useState('');
  const [loaded, setLoaded] = useState(null); // { listing, hold, takesCommits, block } | { missing, block } | { failed }
  const [attempt, setAttempt] = useState(0);
  // The opening fund() this page sent and saw mined: { block }. Like a hold's receipt, it stands while the page's read
  // is from before that block; from then on only while the read has the listing opened (its openedAt set, whatever its
  // state since); and once a read does not, it is dropped for good (lib/seenMined.js): a listing closed without ever
  // opening is never said to have been opened here.
  const [openedHere, setOpenedHere, openingStands] = useSeenMined(
    loaded?.block ?? null,
    () => !loaded?.listing || BigInt(loaded.listing.openedAt) !== 0n,
  );
  // a hold this page sent and saw mined: { at, block }. It stands only while the page's read is from before that
  // block (lib/hold.js holdView); a read of that block or later decides, and replaces it.
  const [heldHere, setHeldHere] = useState(null);
  // the block of a transaction sent from this page that no read has reached: the page says so, and offers to read again
  const [behind, setBehind] = useState(null);
  const mounted = useRef(false);
  const refreshRun = useRef(0);
  // the newest block this page knows the listing changed in: a transaction it sent, or a read through the wallet that
  // found the listing changed. No read from before it is taken, whichever action asks for the read.
  const needed = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // how many times an action on this page changed the chain: what reads it (the withdrawable amount) reads again
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (listingId === null) return undefined;
    let live = true;
    setLoaded(null);
    readListing(listingId)
      .then((read) => { if (live) setLoaded(read); })
      .catch((err) => { if (live) setLoaded({ failed: err instanceof WalletError ? fill(STRINGS.wallet[err.code], err.vars) : errorReason(err) }); });
    return () => { live = false; };
  }, [listingId, attempt]);

  // After an action on this page: the listing as the chain has it once the action is in it, read without taking the
  // page down, so the action's own line (renewed, closed) stays where it was said. `minBlock` is the block the
  // action was mined in, or the block a read through the wallet found the listing changed at. The site's reader may
  // trail the wallet's node, and a read from before that block would show the listing as it was (still on hold after
  // a roll, say): so the page reads until a read reaches the block (lib/poll.js readFrom), takes only that read, and
  // says plainly when none did, with a way to read again. A later refresh replaces the one before it and never asks
  // for less: the page keeps the newest block any of them named (`needed`), so an action that sends nothing (a
  // renewal the wallet's read refuses, say) cannot bring back a read from before a roll that is still being waited for.
  const refresh = useCallback((minBlock = 0) => {
    setVersion((v) => v + 1);
    needed.current = Math.max(needed.current, minBlock);
    const from = needed.current;
    refreshRun.current += 1;
    const run = refreshRun.current;
    const wanted = () => mounted.current && refreshRun.current === run;
    readFrom(() => readListing(listingId), from, { live: wanted }).then(({ read, reached }) => {
      if (!wanted()) return;
      if (reached) {
        // a listing this page showed that a read of a later block does not have: said as gone, not only as absent
        setLoaded((was) => (read.missing && was && !was.failed && (!was.missing || was.gone) ? { ...read, gone: true } : read));
        setBehind(null);
        // the chain as read at or after a hold's block says whether it is there: the receipt no longer stands in
        setHeldHere((seen) => (seen && read.block >= seen.block ? null : seen));
      } else if (from > 0) setBehind(from);
    });
  }, [listingId]);
  /** A hold this page sent was mined at `at` (its Held event) in `block`: said at once, then read from that block. */
  const onHeld = useCallback((at, block) => {
    setHeldHere({ at, block });
    refresh(block);
  }, [refresh]);
  /** The opening fund() was mined in `block`: its own line stays, and the rest of the page follows the listing. */
  const onOpened = useCallback((block = 0) => {
    setOpenedHere({ block });
    refresh(block);
  }, [refresh, setOpenedHere]);
  // The listing this page shows, by maker and artifact. On a chain whose blocks were replaced the id can come to name
  // another listing: everything the page kept for the one it showed (a hold or an opening it saw mined, an action's
  // line, the record and the successors found for it) is that listing's, and goes with it.
  const identity = loaded?.listing ? `${loaded.listing.maker}:${loaded.listing.artifactHash}`.toLowerCase() : null;
  const shownIdentity = useRef(null);
  useEffect(() => {
    if (shownIdentity.current !== null && identity !== null && identity !== shownIdentity.current) {
      setHeldHere(null);
      setOpenedHere(null);
    }
    if (identity !== null) shownIdentity.current = identity;
  }, [identity, setOpenedHere]);

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
  if (loaded.missing) {
    return (
      <>
        {header}
        <p className="error">{fill(F.notFound, { id: listingId })}</p>
        {loaded.gone && <p className="error" role="alert" data-testid="listing-gone">{fill(F.gone, { id: listingId })}</p>}
        {lookupForm}
      </>
    );
  }
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
  const hold = holdView(l, loaded.hold, heldHere, loaded.block);
  // A listing this page just opened reads Listed until a read reaches the opening's block: until then it is shown as
  // open, by the receipt. A read of that block or later that still says Listed means the opening is not on the chain
  // as read: the state is the read's, the page says so, and the funding form is back.
  const openingAhead = openingStands && state === 'Listed';
  const openingDropped = openedHere !== null && !openingStands;
  const shown = openingAhead ? 'Open' : state;
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
          <dt>{F.state}</dt><dd data-testid="listing-state"><StatePill state={hold.held ? null : shown} text={F.states[shown] ?? shown} /></dd>
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
      {behind !== null && (
        <>
          <p className="warning" role="status" data-testid="listing-behind">{fill(F.behind, { block: behind })}</p>
          <button type="button" className="secondary" data-testid="listing-read-again" onClick={() => refresh(behind)}>{F.retry}</button>
        </>
      )}
      {/* keyed by the listing shown: another listing under this id starts each part afresh, with nothing kept of the first */}
      <Fragment key={identity}>
        {/* The funding form of a listing that is Listed, and the opening's own line, with its transaction, while the
            opening stands. What the listing is now is never that line's to say: from the first read that has the
            opening (`followed`) it says only that this page opened it, and "is open until" is the line below, of the
            listing and its hold as last read. An opening a read contradicted is said only while the listing is still
            Listed, where it can be funded again; of a listing closed without opening, nothing is said of it. */}
        {(state === 'Listed' || openingStands) && <FundListing listingId={BigInt(listingId)} top={l.awards[3]} maker={l.maker} artifactHash={l.artifactHash} followed={state !== 'Listed'} dropped={openingDropped} onOpened={onOpened} />}
        {state === 'Open' && !hold.held && <p className="ok" data-testid="listing-open-until">{fill(F.alreadyOpen, { id: listingId, until: formatTime(l.fundedUntil) })}</p>}
        {hold.held && <p className="warning" data-testid="listing-held">{fill(F.held, { id: listingId, time: formatTime(hold.heldAt) })}</p>}
        {state !== 'Listed' && state !== 'Open' && <p className="hint">{fill(F.notFundable, { id: listingId, state: F.states[state] ?? state })}</p>}
        <ListingMore listingId={listingId} listing={l} hold={hold} takesCommits={loaded.takesCommits} readBlock={loaded.block} onHeld={onHeld} onChanged={refresh} />
        <TopUpEscrow listingId={listingId} listing={l} held={hold.held} onChanged={refresh} />
        <RenewListing listingId={listingId} listing={l} held={hold.held} onChanged={refresh} />
        <CloseListing listingId={listingId} listing={l} readBlock={loaded.block} onChanged={refresh} />
      </Fragment>
      <Withdraw version={version} />
    </>
  );
}
