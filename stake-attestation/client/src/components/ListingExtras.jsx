import { useEffect, useId, useState } from 'react';
import { ArrowRight, FileText } from 'lucide-react';

import { LISTING_STATES } from '../chain/abi.js';
import { chainReader, minedReceipt, stakeAttestation } from '../chain/wallet.js';
import { getFeed, getRecord } from '../lib/api.js';
import { NO_HOLD, readHold } from '../lib/hold.js';
import { listingQueue } from '../lib/listingActions.js';
import { formatEth, formatTime } from '../lib/format.js';
import { otherListingsOfRecord } from '../lib/sameRepository.js';
import { confirmSuccessor, successorCandidates } from '../lib/successors.js';
import { STRINGS, fill } from '../strings.js';
import { siteErrorText } from './Facts.jsx';
import { SelectField } from './Field.jsx';
import { HoldListing } from './ListingActions.jsx';
import { SameRepositorySection } from './SameRepository.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const RF = STRINGS.roll;
const ROLLABLE = new Set(['Open', 'Depleted']);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * What the record mirror knows of one listing: its claims (Committed and LateClaim events, ids
 * only, as the site shows every claim that is not a valid finding), its identity (the Listed
 * event: kind, repository, commit) and the other listings of its repository (node P35). Null
 * `record` while it is read; { failed } when it cannot be.
 */
export function useListingRecord(listingId, artifactHash, opened) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!opened) return undefined;
    let live = true;
    getRecord(artifactHash.toLowerCase())
      .then((r) => {
        if (!live) return;
        const id = String(listingId);
        // a listing that does not count has its events apart
        const events = [...(r?.history.events ?? []), ...(r?.notCounted?.events ?? [])];
        const claims = [...new Set(events.filter((e) => (e.name === 'Committed' || e.name === 'LateClaim') && e.listingId === id).map((e) => e.claimId))]
          .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        const listed = events.find((e) => e.name === 'Listed' && e.listingId === id);
        const apart = r?.notCounted?.listings.find((l) => String(l.listingId) === id);
        const counted = Boolean(r?.record.listings.some((l) => String(l.listingId) === id));
        setState({
          claims,
          counted,
          why: apart ? apart.detail ?? apart.reason : null,
          identity: listed ? { kind: listed.args.kind, repo: listed.args.repo, baseCommit: listed.args.baseCommit } : null,
          sameRepository: otherListingsOfRecord(r, id),
        });
      })
      .catch((err) => { if (live) setState({ failed: siteErrorText(err) }); });
    return () => { live = false; };
  }, [listingId, artifactHash, opened]);
  return state;
}

/** The listing's claims, each linking to its page, and the link to the version's record. */
export function ListingClaims({ artifactHash, data, listing = null }) {
  const id = useId();
  const L = STRINGS.claims;
  // commit order (decision D5), from the listing as the chain has it (lib/listingActions.js listingQueue): how many
  // claims are open, late claims among them, and which is first
  const q = listing ? listingQueue(listing) : null;
  let queue = null;
  if (q) queue = `${q.late > 0n ? fill(L.openLate, { count: q.open, late: q.late }) : fill(L.open, { count: q.open })} ${fill(L.order, { head: q.head })}`;
  else if (listing && data && !data.failed && data.claims.length) queue = L.allResolved;
  let body;
  if (!data) body = null;
  else if (data.failed) body = <p className="hint">{fill(L.unavailable, { reason: data.failed })}</p>;
  // the record mirror may trail the chain: it never says "no claim" over a queue the chain already holds
  else if (!data.claims.length) body = q ? null : <p>{L.none}</p>;
  else body = <ul className="inline">{data.claims.map((c) => <li key={c}><a href={`#/claim/${c}`}>{fill(L.line, { id: c })}</a></li>)}</ul>;
  return (
    <section className="claim" aria-labelledby={id} data-testid="listing-claims">
      <h3 id={id}>{L.title}</h3>
      {body}
      {queue && <p data-testid="listing-queue">{queue}</p>}
      <p className="actions"><a className="button secondary" href={`#/record/${artifactHash.toLowerCase()}`}><FileText size={16} aria-hidden="true" />{L.record}</a></p>
    </section>
  );
}

/**
 * rollForward() (design §7.1, §13.2): the maker picks a successor among their own open listings
 * of the same repository, from the feed, each confirmed on-chain as the contract requires. Just
 * before sending, both listings are read again at one block through the wallet. Above the picker,
 * the panel says what a maker does before publishing a fix: a fixed commit is public before it
 * can be listed. Where the contract has the maker's hold (node P42; `hold.supported`), that is the
 * hold's order: hold, push the fix, validate it, list and fund the fixed version, roll forward, or
 * close when nothing is pending; a listing already on hold says since when and what is left.
 * Against a contract with no hold it is node P38's three lines, as they were: this listing takes
 * commits until it is closed or rolled forward. Either text depends on the chain alone (the
 * listing's state and its hold), so the panel shows for every Open or Depleted listing: `record`
 * (useListingRecord's answer) is null while the site's record is read and { failed } when it
 * cannot be, and only the picker waits for it. A listing on hold rolls forward as any other.
 * Without a `hold` the panel is the one for a contract with none.
 *
 * A successor is never a listing that is itself on hold: such a listing is Open, and the contract
 * would take it, but it takes no commits and a hold has no resume. The picker leaves it out, and
 * the read just before sending refuses it. With a hold, the fixed version is listed and funded
 * after this page was opened, often in another tab, so the panel looks for successors again when
 * asked. `onChanged(block)`: the listing rolled in that block, so the page reads it again from
 * there (a hold ends in the roll).
 */
export function RollForward({ listingId, listing, record, hold = NO_HOLD, onChanged = () => {} }) {
  const w = useWalletContext();
  const id = useId();
  const state = LISTING_STATES[Number(listing.state)];
  const identity = record && !record.failed ? record.identity : null;
  const [options, setOptions] = useState(null); // [{ id, commit, escrowWei, openedAt }] | { failed }
  // how many times the maker asked to look again, or a successor was refused: each looks for successors afresh
  const [again, setAgain] = useState(0);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { id, tx }
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!ROLLABLE.has(state) || !identity) return undefined;
    let live = true;
    (async () => {
      const feed = await getFeed();
      const candidates = successorCandidates(feed.listings, { listingId, maker: listing.maker, ...identity });
      const sa = stakeAttestation(await chainReader());
      const out = [];
      for (const e of candidates) {
        const id = BigInt(e.listingId);
        // the feed may trail the chain by a block: a listing held since is not offered
        const [s, onHold] = await Promise.all([sa.getListing(id), hold.supported ? readHold(sa, id) : NO_HOLD]);
        if (onHold.heldAt === 0n && confirmSuccessor(s, { successorId: id, listingId: BigInt(listingId), account: listing.maker })) {
          out.push({ id: e.listingId, commit: e.artifact.baseCommit, escrowWei: e.escrowRemainingWei, openedAt: e.openedAt });
        }
      }
      return out;
    })()
      .then((out) => {
        if (!live) return;
        setOptions(out);
        // the maker's choice stands while it is still among them
        setPick((was) => (out.some((o) => o.id === was) ? was : out[0]?.id ?? ''));
      })
      .catch((err) => { if (live) setOptions({ failed: siteErrorText(err) }); });
    return () => { live = false; };
  }, [listingId, listing.maker, state, identity, hold.supported, again]);

  if (done) return <p data-testid="rolled" className="ok">{fill(RF.done, { id: done.id, tx: done.tx })}</p>;
  if (!ROLLABLE.has(state)) return null;

  const roll = async () => {
    setBusy(true);
    setError(null);
    try {
      const { signer, provider, account } = await w.ensure();
      if (!same(account, listing.maker)) return setError(fill(STRINGS.claim.notMaker, { maker: listing.maker, account }));
      const reader = stakeAttestation(provider);
      // a raw eth_blockNumber: ethers' getBlockNumber() may answer from a cache
      const blockTag = Number(await provider.send('eth_blockNumber', []));
      const [mine, successor, successorHold] = await Promise.all([
        reader.getListing(BigInt(listingId), { blockTag }),
        reader.getListing(BigInt(pick), { blockTag }),
        hold.supported ? readHold(reader, pick, { blockTag }) : NO_HOLD,
      ]);
      if (!ROLLABLE.has(LISTING_STATES[Number(mine.state)]) || !same(mine.maker, account)
        || !confirmSuccessor(successor, { successorId: BigInt(pick), listingId: BigInt(listingId), account })) {
        return setError(fill(RF.changed, { id: pick }));
      }
      // Open, the maker's, no predecessor: the contract would take it. On hold it takes no commits, and for good.
      if (successorHold.heldAt !== 0n) {
        setAgain((n) => n + 1);
        return setError(fill(RF.successorOnHold, { id: pick }));
      }
      const tx = await stakeAttestation(signer).rollForward(BigInt(listingId), BigInt(pick));
      const receipt = await minedReceipt(tx);
      setDone({ id: pick, tx: receipt.hash });
      onChanged(receipt.blockNumber);
    } catch (err) {
      setError(fill(STRINGS.claim.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  let body;
  if (!record) body = <p className="hint">{RF.loading}</p>;
  else if (record.failed) body = <p className="hint" data-testid="roll-record-failed">{fill(RF.recordFailed, { reason: record.failed })}</p>;
  else if (!identity) body = <p className="hint">{RF.noIdentity}</p>;
  else if (options === null) body = <p className="hint">{RF.loading}</p>;
  else if (options.failed) body = <p className="error">{fill(RF.feedFailed, { reason: options.failed })}</p>;
  else if (!options.length) body = <p>{RF.none}</p>;
  else {
    body = (
      <>
        <SelectField
          label={RF.pick}
          value={pick}
          onChange={setPick}
          options={options.map((o) => ({ value: o.id, label: fill(RF.option, { id: o.id, commit: o.commit, escrow: formatEth(o.escrowWei), opened: formatTime(o.openedAt) }) }))}
        />
        <button type="button" onClick={roll} disabled={busy || !pick}>{busy ? RF.sending : fill(RF.button, { id: pick })}<ArrowRight size={16} aria-hidden="true" /></button>
      </>
    );
  }
  return (
    <section className="claim" aria-labelledby={id} data-testid="roll-forward">
      <h3 id={id}>{RF.title}</h3>
      <p>{RF.intro}</p>
      {hold.supported ? (
        <>
          <p className="warning" data-testid="roll-hold-first">{hold.held ? fill(RF.hold.held, { time: formatTime(hold.heldAt) }) : RF.hold.first}</p>
          <ul data-testid="roll-hold-order">
            {!hold.held && <li>{RF.hold.order}</li>}
            <li>{RF.hold.close}</li>
          </ul>
        </>
      ) : (
        <>
          <p className="warning" data-testid="roll-fix-keep">{RF.fix.keep}</p>
          <ul data-testid="roll-fix-order">
            <li>{RF.fix.noClaim}</li>
            <li>{RF.fix.claimPending}</li>
          </ul>
        </>
      )}
      {body}
      {/* with a hold the fixed version is listed after this page was opened: the panel looks again when asked */}
      {hold.supported && identity && options !== null && (
        <button type="button" className="secondary" data-testid="roll-look-again" onClick={() => { setError(null); setOptions(null); setAgain((n) => n + 1); }} disabled={busy}>{RF.again}</button>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/**
 * Whether the site offers a commit on this listing: only one that counts and takes a commit as the contract has it
 * (`takesCommits`: acceptsCommits at the block the listing was read at). A listing its maker has on hold (node P42)
 * takes none and is no entry of the feed, and neither is one that rolled forward, closed, is depleted or whose fee
 * has lapsed: of those the page says so, and never that the site offers them.
 */
function CommitOffer({ data, held = false, takesCommits = true }) {
  const id = useId();
  const O = STRINGS.offer;
  if (!data) return null;
  let text = O.yes;
  if (held) text = O.held;
  else if (!takesCommits) text = O.notTaking;
  if (data.failed) text = fill(O.unknown, { reason: data.failed });
  else if (!data.counted) text = fill(O.no, { reason: data.why ?? STRINGS.notCounted.none });
  return (
    <section className="claim" aria-labelledby={id} data-testid="commit-offer" data-offered={String(Boolean(data.counted) && !held && takesCommits)}>
      <h3 id={id}>{O.title}</h3>
      <p>{text}</p>
    </section>
  );
}

/**
 * The parts of a listing's page that follow its opening: its claims, its record, the other listings
 * of its repository (node P35), the maker's hold (node P42) and, next to it, roll forward. A listing
 * that has not opened has no record yet. `hold`: the listing's hold as the page read it from the chain
 * (lib/hold.js holdView), and `takesCommits`: whether it takes a commit, at the same block; `onHeld`,
 * `onChanged`: a hold, or a roll, this page sent was mined.
 */
export function ListingMore({ listingId, listing, hold = NO_HOLD, takesCommits = true, onHeld = () => {}, onChanged = () => {} }) {
  const state = LISTING_STATES[Number(listing.state)];
  const opened = state !== 'Listed';
  const data = useListingRecord(listingId, listing.artifactHash, opened);
  if (!opened) return null;
  return (
    <>
      <div className="pair">
        <CommitOffer data={data} held={hold.held} takesCommits={takesCommits} />
        <ListingClaims artifactHash={listing.artifactHash} data={data} listing={listing} />
      </div>
      <SameRepositorySection data={data} />
      {/* the hold is the chain's alone, as roll forward's lines are: neither waits for the site's record */}
      <HoldListing listingId={listingId} listing={listing} hold={hold} onHeld={onHeld} onChanged={onChanged} />
      {/* whatever the record's read came to: what the panel says before a fix is the chain's, and only its picker is the record's */}
      <RollForward listingId={listingId} listing={listing} record={data} hold={hold} onChanged={onChanged} />
    </>
  );
}
