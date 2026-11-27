import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { LISTING_STATES } from '../chain/abi.js';
import { snapshot } from '../chain/snapshot.js';
import { WalletError, chainReader, listingAt, stakeAttestation } from '../chain/wallet.js';
import { safeguardTerms } from '../lib/claimActions.js';
import { errorReason, formatEth, formatTime, formatWhole, juryLine } from '../lib/format.js';
import { readHold } from '../lib/hold.js';
import { NOTHING_READ, floorOf, pageAfter, pageSays } from '../lib/pageSays.js';
import { readFrom } from '../lib/poll.js';
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
 * The page's read of the listing: one snapshot of one block (chain/snapshot.js). The count, the listing, its hold
 * (node P42) and whether it takes commits (the contract's acceptsCommits; node P47) are that one block's: a hold mined
 * between two calls, or a block replaced under them, never pairs a listing with the hold of another moment or of
 * another chain. A contract deployed before the hold refuses the heldAt call, which readHold answers as "no hold
 * here"; a read that fails any other way rejects with the rest, and the page says it could not be read. Every contract
 * has acceptsCommits, so that call has no such answer: when it fails, refused or not, the read failed. "No such
 * listing" is an answer of a block too.
 * @returns {Promise<{ block: number } & ({ missing: true } | { listing: object, hold: { supported: boolean, heldAt: bigint, held: boolean }, takesCommits: boolean })>}
 */
async function readListing(listingId) {
  const { value, block } = await snapshot(await chainReader(), async (at) => {
    const view = stakeAttestation(at);
    const listing = await listingAt(view, listingId);
    if (listing === null) return { missing: true };
    return { listing, hold: await readHold(view, listingId), takesCommits: await view.acceptsCommits(BigInt(listingId)) };
  });
  return { ...value, block };
}

/**
 * A listing's own page (#/fund/<id>): its stored terms and, while it is Listed, the opening
 * fund(). It is where a maker who left the listing flow between list() and fund() comes back to.
 * Once it opened: its claims, its record, a top-up of its escrow and, while it is Open or Depleted, the maker's
 * hold (where the contract has one), roll forward and renew.
 * Until it is closed: close. And for a connected wallet the contract holds something for: withdraw.
 * A listing on hold (node P42) stays Open or Depleted: the page says the hold beside the state, with its time.
 * What the page says of the listing is its read's alone, and lib/pageSays.js decides it.
 */
export function FundPage({ listingId }) {
  const headingId = useId();
  const [lookup, setLookup] = useState('');
  const [attempt, setAttempt] = useState(0);
  // how many times an action on this page changed the chain: what reads it (the withdrawable amount) reads again
  const [version, setVersion] = useState(0);
  // What the page has read and was told (lib/pageSays.js): the read on display, the newest block it was told of, and
  // whether it knows that read is behind. Kept in a ref and moved on by `happened`, which draws the page again: a
  // refresh needs the floor as it is when it starts, not as the next render has it.
  const record = useRef(NOTHING_READ);
  const [, redraw] = useState(0);
  const happened = useCallback((event) => {
    record.current = pageAfter(record.current, event);
    redraw((n) => n + 1);
  }, []);
  const loaded = record.current.read; // { listing, hold, takesCommits, block } | { missing, block } | { failed } | null
  const says = pageSays(record.current);
  // The listing on display, by maker and artifact: an action is drawn for it, and a wallet's read that refuses an
  // action disagrees with that listing. One that arrives once the page shows another listing under the id hides
  // nothing of the listing now shown.
  const identity = loaded?.listing ? `${loaded.listing.maker}:${loaded.listing.artifactHash}`.toLowerCase() : null;
  const onDisplay = useRef(null);
  onDisplay.current = identity;
  const mounted = useRef(false);
  const run = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (listingId === null) return undefined;
    let live = true;
    happened({ type: 'loaded', read: null });
    readListing(listingId)
      .then((got) => { if (live) happened({ type: 'loaded', read: got }); })
      .catch((err) => { if (live) happened({ type: 'loaded', read: { failed: err instanceof WalletError ? fill(STRINGS.wallet[err.code], err.vars) : errorReason(err) } }); });
    return () => { live = false; };
  }, [listingId, attempt, happened]);

  // After an action on this page (`told`: the block its transaction was mined in, or lib/pageSays.js disagreedAt for a
  // read through the wallet that refused it), and when the visitor asks (no `told`). The page is told at once, before
  // any read: from that instant it shows nothing its read says of the hold. Then the listing is read again without
  // taking the page down, so an action's own line stays where it was said. The site's reader may trail the wallet's
  // node, so the page reads until a read is of the floor's block or a later one (lib/poll.js readFrom) and takes that
  // read alone; when none is, it says which block it has not read, with a way to read again. A later refresh replaces
  // the one before it, and the floor only rises. `of`: the listing the action was drawn for.
  const refresh = useCallback((told = null, of = null) => {
    if (told === null) happened({ type: 'again' });
    else if (typeof told === 'number') happened({ type: 'mined', block: told });
    else happened({ type: 'disagreed', block: told.block, shown: of === onDisplay.current });
    setVersion((v) => v + 1);
    run.current += 1;
    const mine = run.current;
    const wanted = () => mounted.current && run.current === mine;
    readFrom(() => readListing(listingId), floorOf(record.current), { live: wanted }).then(({ read, reached }) => {
      if (!wanted()) return;
      if (reached) happened({ type: 'read', read });
      happened({ type: 'settled' });
    });
  }, [listingId, happened]);
  const onChanged = useCallback((told) => refresh(told, identity), [refresh, identity]);

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

  // A read that was asked for, and not taken yet (lib/pageSays.js): said while its reads are out, and with the block
  // the next read has to reach and a way to read again once they are over. It is drawn wherever a read was taken:
  // under a listing, and on the "no such listing" page, where an action that was still out when that read was taken
  // can ask for another.
  const notice = (
    <>
      {says.reading && <p className="hint" role="status" data-testid="listing-reading">{F.reading}</p>}
      {says.unread !== null && (
        <>
          <p className="warning" role="status" data-testid="listing-behind">{fill(F.behind, { block: says.unread })}</p>
          <button type="button" className="secondary" data-testid="listing-read-again" onClick={() => refresh()}>{F.retry}</button>
        </>
      )}
    </>
  );

  if (listingId === null) return <>{header}{lookupForm}</>;
  if (!loaded) return <>{header}<p className="hint">{F.loading}</p></>;
  if (loaded.missing) return <>{header}<p className="error">{fill(F.notFound, { id: listingId })}</p>{notice}{lookupForm}</>;
  if (says.failed !== null) {
    return (
      <>
        {header}
        <p className="error">{fill(F.readFailed, { reason: says.failed })}</p>
        <button type="button" onClick={() => setAttempt((a) => a + 1)}>{F.retry}</button>
      </>
    );
  }

  const l = loaded.listing;
  const state = LISTING_STATES[Number(l.state)];
  // the hold as that read has it, and whether the page may say anything of it now (lib/pageSays.js)
  const { hold } = loaded;
  const quiet = says.off;
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
          {/* the state is the read's; a listing on hold takes no claims, so its pill is never the green of one that does */}
          {!quiet && <><dt>{F.state}</dt><dd data-testid="listing-state"><StatePill state={hold.held ? null : state} text={F.states[state] ?? state} /></dd></>}
          {!quiet && hold.held && <><dt>{F.heldSince}</dt><dd data-testid="listing-held-since">{formatTime(hold.heldAt)}</dd></>}
          <dt>{F.listingCid}</dt><dd><Code value={l.listingCid} what={F.listingCid} /></dd>
          <dt>{F.disclosureKey}</dt><dd><DisclosureKeyForms bytes32={l.disclosureKey} testId="listing-disclosure-key" /></dd>
        </dl>
        <ul className="terms">
          <li><AwardLine text={fill(STRINGS.chain.awards, Object.fromEntries(CLASSES.map((c, i) => [c, formatEth(l.awards[i])])))} /></li>
          <li>{fill(STRINGS.chain.bond, { bond: formatEth(l.bondWei) })}</li>
          <li>{fill(STRINGS.chain.windows, { fix: Number(l.fixWindow) / 86400, dispute: Number(l.disputeWindow) / 3600, grace: Number(l.disclosureGrace) / 3600, reveal: Number(l.revealWindow) / 86400 })}</li>
          <li>{l.allowlist.length ? fill(STRINGS.chain.allowlist, { count: l.allowlist.length }) : STRINGS.chain.open}</li>
          <li>{fill(STRINGS.chain.knownIssues, { count: l.knownIssueIds.length })}</li>
          <li data-testid="listing-jury">{juryLine(l.oracle)}</li>
          <li data-testid="listing-band">{terms.band.empty ? STRINGS.chain.bandEmpty : fill(STRINGS.chain.band, { floor: formatWhole(terms.band.floor), points: terms.band.points })}</li>
          <li data-testid="listing-size">{terms.size.all ? STRINGS.chain.sizeAll : fill(STRINGS.chain.size, { size: formatEth(terms.size.wei) })}</li>
        </ul>
      </section>
      {notice}
      {/* on the page as long as its listing is: the funding form while the read says Listed, and the line of an opening sent from here */}
      <FundListing listingId={BigInt(listingId)} top={l.awards[3]} maker={l.maker} artifactHash={l.artifactHash} listed={state === 'Listed'} quiet={quiet} onMined={onChanged} />
      {!quiet && state === 'Open' && !hold.held && <p className="ok" data-testid="listing-open-until">{fill(F.alreadyOpen, { id: listingId, until: formatTime(l.fundedUntil) })}</p>}
      {!quiet && hold.held && <p className="warning" data-testid="listing-held">{fill(F.held, { id: listingId, time: formatTime(hold.heldAt) })}</p>}
      {!quiet && state !== 'Listed' && state !== 'Open' && <p className="hint">{fill(F.notFundable, { id: listingId, state: F.states[state] ?? state })}</p>}
      <ListingMore listingId={listingId} listing={l} hold={hold} takesCommits={loaded.takesCommits} quiet={quiet} onChanged={onChanged} />
      <TopUpEscrow listingId={listingId} listing={l} held={hold.held} quiet={quiet} onChanged={onChanged} />
      <RenewListing listingId={listingId} listing={l} held={hold.held} quiet={quiet} onChanged={onChanged} />
      <CloseListing listingId={listingId} listing={l} quiet={quiet} onChanged={onChanged} />
      <Withdraw version={version} onChanged={onChanged} />
    </>
  );
}
