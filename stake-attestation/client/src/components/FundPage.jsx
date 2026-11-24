import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { LISTING_STATES } from '../chain/abi.js';
import { snapshot } from '../chain/snapshot.js';
import { WalletError, chainReader, listingAt, stakeAttestation } from '../chain/wallet.js';
import { safeguardTerms } from '../lib/claimActions.js';
import { errorReason, formatEth, formatTime, formatWhole } from '../lib/format.js';
import { holdView, readHold } from '../lib/hold.js';
import { asKept, isKept } from '../lib/seenMined.js';
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
 * The page's read of the listing: one snapshot of one block hash (chain/snapshot.js). The count, the listing, its hold
 * (node P42) and whether it takes a commit as commit() decides it are that one block's: a hold mined between two
 * calls, or a block replaced under them, never pairs a listing with the hold of another moment or of another chain.
 * A contract deployed before the hold refuses the heldAt call, which readHold answers as "no hold here"; a read that
 * fails any other way rejects with the rest, and the page says it could not be read. So does a block that says both
 * "on hold" and "takes commits": the contract never says both of one block, and the page gives no guidance from it.
 * "No such listing" is an answer of a block too: a listing whose block was dropped is gone as of the block read,
 * which is how a page waiting for a later block learns of it.
 * @param {number[]} [heights] - the blocks of the receipts the page keeps: the snapshot says which hash its chain has
 *        at each (lib/seenMined.js)
 * @returns {Promise<{ block: number, blockHash: string, hashes: Record<number, string|null> } & ({ missing: true } | { listing: object, hold: { supported: boolean, heldAt: bigint }, takesCommits: boolean })>}
 */
async function readListing(listingId, heights = []) {
  const provider = await chainReader();
  const { value, block, blockHash, hashes } = await snapshot(provider, async (at) => {
    const view = stakeAttestation(at);
    const listing = await listingAt(view, listingId);
    if (listing === null) return { missing: true };
    const [hold, takesCommits] = await Promise.all([readHold(view, listingId), view.acceptsCommits(BigInt(listingId))]);
    // One block that says both: the contract never does, so nothing of it is shown. It is an answer of its block all
    // the same, so a page waiting for that block learns that it cannot be read, and stops saying what it said before.
    if (hold.heldAt !== 0n && takesCommits) return { failed: STRINGS.fund.contradictory };
    return { listing, hold, takesCommits };
  }, { heights });
  return { ...value, block, blockHash, hashes };
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
  // the page's read: one snapshot (readListing), { listing, hold, takesCommits } or { missing }, with its block's number
  // and hash and the hashes its chain has at the blocks the page was told of; or { failed }
  const [loaded, setLoaded] = useState(null);
  const [attempt, setAttempt] = useState(0);
  // The read the page's parts are drawn from: the latest that has the listing. While a later read failed (a block that
  // answered what the contract never says of one block) the parts stay as that read left them, and hidden: nothing of
  // the listing is shown, and what they keep of the page's transactions is there when a read can be taken again.
  const lastListing = useRef(null);
  if (loaded?.listing) lastListing.current = loaded;
  const current = loaded?.failed ? lastListing.current : loaded?.listing ? loaded : null;
  // the snapshot that read is of: what a receipt the page keeps is held against (lib/seenMined.js)
  const read = useMemo(
    () => (current?.blockHash ? { block: current.block, blockHash: current.blockHash, hashes: current.hashes } : null),
    [current],
  );
  // The opening fund() this page sent and saw mined, as FundListing kept its receipt. Like a hold's receipt, it stands
  // while the page's read is of a block before its own; from then on only while its block is the chain's and the read
  // has the listing opened (its openedAt set, whatever its state since); and once a read says otherwise, it is dropped
  // for good (lib/seenMined.js): a listing closed without ever opening is never said to have been opened here.
  const [openedHere, setOpenedHere, openingStands] = useSeenMined(
    read,
    () => !current?.listing || BigInt(current.listing.openedAt) !== 0n,
  );
  // The hold this page sent and saw mined, as HoldListing kept its receipt (with `heldAt`). It stands in for the read
  // only while the page's read is of a block before its own (lib/hold.js holdView); a read of that block or later
  // decides alone, and replaces it.
  const [heldHere, setHeldHere] = useState(null);
  // the block of a transaction sent from this page that no read has reached: the page says so, and offers to read again
  const [behind, setBehind] = useState(null);
  // the latest read is of that block or a later one, and could not check the block of a receipt the page keeps (the
  // node did not give its header): the listing is shown as read, and the page says so, and offers to read again
  const [unchecked, setUnchecked] = useState(false);
  const mounted = useRef(false);
  const refreshRun = useRef(0);
  // the newest block this page knows the listing changed in: a transaction it sent, or a read through the wallet that
  // found the listing changed. No read from before it is taken, whichever action asks for the read.
  const needed = useRef(0);
  // the blocks of the receipts this page keeps: each read asks which hash its chain has at them (lib/seenMined.js).
  // One for each transaction sent from the page in this visit, and never forgotten while the page shows the listing.
  const keptAt = useRef([]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (listingId === null) return undefined;
    let live = true;
    setLoaded(null);
    readListing(listingId, keptAt.current)
      .then((got) => { if (live) setLoaded(got); })
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
  const refresh = useCallback((told = 0) => {
    // `told` is a receipt this page keeps (its block is read from, and its hash asked of every read from now on), or
    // the number of a block: a read through the wallet that found the listing changed, or a block still to be read
    const minBlock = isKept(told) ? told.block : told;
    if (isKept(told) && !keptAt.current.includes(told.block)) keptAt.current = [...keptAt.current, told.block];
    needed.current = Math.max(needed.current, minBlock);
    const from = needed.current;
    refreshRun.current += 1;
    const run = refreshRun.current;
    const wanted = () => mounted.current && refreshRun.current === run;
    // Whether a read has checked every receipt the page keeps: a hash at each of their blocks that is not above it.
    const checked = (got) => keptAt.current.every((height) => height > got.block || typeof got.hashes?.[height] === 'string');
    let shown = false;
    // One read. A read of the block waited for, or a later one, is the listing as the chain has it: it is shown at
    // once. If it could not check a receipt's block it is not the last read all the same: the page reads again, the
    // same bounded number of times, and then says what it could not check.
    const once = async () => {
      const got = await readListing(listingId, keptAt.current);
      if (!wanted() || got.block < from) return got;
      // a listing this page showed that a read of a later block does not have: said as gone, not only as absent
      setLoaded((was) => (got.missing && was && !was.failed && (!was.missing || was.gone) ? { ...got, gone: true } : got));
      // the chain as read at or after a hold's block says whether it is there: the receipt no longer stands in
      setHeldHere((seen) => (seen && got.block >= seen.block ? null : seen));
      shown = true;
      return checked(got) ? got : { ...got, block: -1 };
    };
    readFrom(once, from, { live: wanted }).then(({ reached }) => {
      if (!wanted()) return;
      if (reached || shown) setBehind(null);
      else if (from > 0) setBehind(from);
      setUnchecked(!reached && shown);
    });
  }, [listingId]);
  // The listing this page shows, by maker and artifact. On a chain whose blocks were replaced the id can come to name
  // another listing: everything the page kept for the one it showed (a hold or an opening it saw mined, an action's
  // line, the record and the successors found for it) is that listing's, and goes with it.
  const identity = current?.listing ? `${current.listing.maker}:${current.listing.artifactHash}`.toLowerCase() : null;
  const shownIdentity = useRef(null);
  useEffect(() => {
    if (shownIdentity.current !== null && identity !== null && identity !== shownIdentity.current) {
      setHeldHere(null);
      setOpenedHere(null);
    }
    if (identity !== null) shownIdentity.current = identity;
  }, [identity, setOpenedHere]);
  // A hold or an opening is the listing's it was sent for. Its receipt can arrive after the page has come to show
  // another listing under the id (the action was still waiting when a read replaced it): each callback is made for
  // the listing shown when its action was drawn, and one made for another listing sets nothing here. The page still
  // reads from the receipt's block.
  /** A hold this page sent was mined (`seen`: its kept receipt, with the Held event's time): said at once, then read from its block. */
  const onHeld = useCallback((seen) => {
    if (identity === shownIdentity.current) setHeldHere(asKept(seen));
    refresh(seen);
  }, [refresh, identity]);
  /** The opening fund() was mined (`seen`: its kept receipt): its own line stays, and the rest of the page follows the listing. */
  const onOpened = useCallback((seen) => {
    if (identity === shownIdentity.current) setOpenedHere(seen);
    refresh(seen);
  }, [refresh, identity, setOpenedHere]);

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
  // A read that failed: on load, or after a transaction of this page (a block that answered what the contract never
  // says of one block). Nothing of the listing is shown, nor of what a receipt said of it: no state, no hold, no order.
  // Reading again never takes a read from before the newest block the page was told of.
  const failed = loaded.failed ?? null;
  const again = () => (needed.current > 0 ? refresh(needed.current) : setAttempt((a) => a + 1));
  const unread = failed !== null && (
    <>
      <p className="error" role="alert" data-testid="listing-unread">{fill(F.readFailed, { reason: failed })}</p>
      {behind !== null && <p className="warning" role="status" data-testid="listing-behind">{fill(F.behind, { block: behind })}</p>}
      <button type="button" data-testid="listing-read-again" onClick={again}>{F.retry}</button>
    </>
  );
  // a read that failed before any read had the listing: there is nothing else to draw
  if (current === null) return <>{header}{unread}</>;

  const l = current.listing;
  const state = LISTING_STATES[Number(l.state)];
  // the hold as the chain has it, or as this page saw it mined (lib/hold.js holdView)
  const hold = holdView(l, current.hold, heldHere, current.block);
  // A listing this page just opened reads Listed until a read reaches the opening's block: until then it is shown as
  // open, by the receipt. A read of that block or later that still says Listed means the opening is not on the chain
  // as read: the state is the read's, the page says so, and the funding form is back.
  const openingAhead = openingStands && state === 'Listed';
  const openingDropped = openedHere?.dropped === true;
  const shown = openingAhead ? 'Open' : state;
  // errata E8 and E9: the floor and the size list() copied onto this listing, for its whole life
  const terms = safeguardTerms(l);
  return (
    <>
      {header}
      {unread}
      {/* Every part of the listing, in one place in the page whether it is shown or not: while a read has failed it is
          hidden as a whole (styles.css .listing-read[hidden]), and its parts keep what they hold of the page's
          transactions, to be held against the next read that can be taken. */}
      <div className="listing-read" hidden={failed !== null} data-testid="listing-read">
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
      {failed === null && behind !== null && (
        <>
          <p className="warning" role="status" data-testid="listing-behind">{fill(F.behind, { block: behind })}</p>
          <button type="button" className="secondary" data-testid="listing-read-again" onClick={() => refresh(behind)}>{F.retry}</button>
        </>
      )}
      {failed === null && behind === null && unchecked && (
        <>
          <p className="warning" role="status" data-testid="listing-unchecked">{F.unchecked}</p>
          <button type="button" className="secondary" data-testid="listing-read-again" onClick={again}>{F.retry}</button>
        </>
      )}
      {/* keyed by the listing shown: another listing under this id starts each part afresh, with nothing kept of the first */}
      <Fragment key={identity}>
        {/* The funding form of a listing that is Listed, and the opening's own line, with its transaction, while the
            opening stands. What the listing is now is never that line's to say: from the first read that has the
            opening (`followed`) it says only that this page opened it, and "is open until" is the line below, of the
            listing and its hold as last read. An opening a read contradicted is said only while the listing is still
            Listed, where it can be funded again; of a listing closed without opening, nothing is said of it. */}
        {(state === 'Listed' || openedHere !== null) && <FundListing listingId={BigInt(listingId)} top={l.awards[3]} maker={l.maker} artifactHash={l.artifactHash} listed={state === 'Listed'} stands={openingStands} followed={state !== 'Listed'} dropped={openingDropped} onOpened={onOpened} />}
        {state === 'Open' && !hold.held && <p className="ok" data-testid="listing-open-until">{fill(F.alreadyOpen, { id: listingId, until: formatTime(l.fundedUntil) })}</p>}
        {hold.held && <p className="warning" data-testid="listing-held">{fill(F.held, { id: listingId, time: formatTime(hold.heldAt) })}</p>}
        {state !== 'Listed' && state !== 'Open' && <p className="hint">{fill(F.notFundable, { id: listingId, state: F.states[state] ?? state })}</p>}
        <ListingMore listingId={listingId} listing={l} hold={hold} takesCommits={current.takesCommits} read={read} onHeld={onHeld} onChanged={refresh} />
        <TopUpEscrow listingId={listingId} listing={l} held={hold.held} read={read} onChanged={refresh} />
        <RenewListing listingId={listingId} listing={l} held={hold.held} read={read} onChanged={refresh} />
        <CloseListing listingId={listingId} listing={l} read={read} onChanged={refresh} />
      </Fragment>
      <Withdraw read={read} onChanged={refresh} />
      </div>
    </>
  );
}
