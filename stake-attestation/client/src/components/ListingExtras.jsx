import { useEffect, useId, useState } from 'react';

import { LISTING_STATES } from '../chain/abi.js';
import { chainReader, stakeAttestation } from '../chain/wallet.js';
import { getFeed, getRecord } from '../lib/api.js';
import { formatEth, formatTime } from '../lib/format.js';
import { confirmSuccessor, successorCandidates } from '../lib/successors.js';
import { STRINGS, fill } from '../strings.js';
import { siteErrorText } from './Facts.jsx';
import { SelectField } from './Field.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const RF = STRINGS.roll;
const ROLLABLE = new Set(['Open', 'Depleted']);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * What the record mirror knows of one listing: its claims (Committed and LateClaim events, ids
 * only, as the site shows every claim that is not a valid finding) and its identity (the Listed
 * event: kind, repository, commit). Null `record` while it is read; { failed } when it cannot be.
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
        const events = r?.history.events ?? [];
        const claims = [...new Set(events.filter((e) => (e.name === 'Committed' || e.name === 'LateClaim') && e.listingId === id).map((e) => e.claimId))]
          .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        const listed = events.find((e) => e.name === 'Listed' && e.listingId === id);
        setState({ claims, identity: listed ? { kind: listed.args.kind, repo: listed.args.repo } : null });
      })
      .catch((err) => { if (live) setState({ failed: siteErrorText(err) }); });
    return () => { live = false; };
  }, [listingId, artifactHash, opened]);
  return state;
}

/** The listing's claims, each linking to its page, and the link to the version's record. */
export function ListingClaims({ artifactHash, data }) {
  const id = useId();
  const L = STRINGS.claims;
  let body;
  if (!data) body = null;
  else if (data.failed) body = <p className="hint">{fill(L.unavailable, { reason: data.failed })}</p>;
  else if (!data.claims.length) body = <p>{L.none}</p>;
  else body = <ul className="inline">{data.claims.map((c) => <li key={c}><a href={`#/claim/${c}`}>{fill(L.line, { id: c })}</a></li>)}</ul>;
  return (
    <section className="claim" aria-labelledby={id} data-testid="listing-claims">
      <h3 id={id}>{L.title}</h3>
      <p><a href={`#/record/${artifactHash.toLowerCase()}`}>{L.record}</a></p>
      {body}
    </section>
  );
}

/**
 * rollForward() (design §7.1, §13.2): the maker picks a successor among their own open listings
 * of the same repository, from the feed, each confirmed on-chain as the contract requires. Just
 * before sending, both listings are read again at one block through the wallet.
 */
export function RollForward({ listingId, listing, identity }) {
  const w = useWalletContext();
  const id = useId();
  const state = LISTING_STATES[Number(listing.state)];
  const [options, setOptions] = useState(null); // [{ id, commit, escrowWei, openedAt }] | { failed }
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { id, tx }
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!ROLLABLE.has(state) || !identity) return undefined;
    let live = true;
    (async () => {
      const feed = await getFeed();
      const candidates = successorCandidates(feed.listings, { listingId, maker: listing.maker, kind: identity.kind, repo: identity.repo });
      const sa = stakeAttestation(await chainReader());
      const out = [];
      for (const e of candidates) {
        const s = await sa.getListing(BigInt(e.listingId));
        if (confirmSuccessor(s, { successorId: BigInt(e.listingId), listingId: BigInt(listingId), account: listing.maker })) {
          out.push({ id: e.listingId, commit: e.artifact.baseCommit, escrowWei: e.escrowRemainingWei, openedAt: e.openedAt });
        }
      }
      return out;
    })()
      .then((out) => {
        if (!live) return;
        setOptions(out);
        setPick(out[0]?.id ?? '');
      })
      .catch((err) => { if (live) setOptions({ failed: siteErrorText(err) }); });
    return () => { live = false; };
  }, [listingId, listing.maker, state, identity]);

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
      const [mine, successor] = await Promise.all([reader.getListing(BigInt(listingId), { blockTag }), reader.getListing(BigInt(pick), { blockTag })]);
      if (!ROLLABLE.has(LISTING_STATES[Number(mine.state)]) || !same(mine.maker, account)
        || !confirmSuccessor(successor, { successorId: BigInt(pick), listingId: BigInt(listingId), account })) {
        return setError(fill(RF.changed, { id: pick }));
      }
      const tx = await stakeAttestation(signer).rollForward(BigInt(listingId), BigInt(pick));
      await tx.wait();
      setDone({ id: pick, tx: tx.hash });
    } catch (err) {
      setError(fill(STRINGS.claim.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  let body;
  if (!identity) body = <p className="hint">{RF.noIdentity}</p>;
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
        <button type="button" onClick={roll} disabled={busy || !pick}>{busy ? RF.sending : fill(RF.button, { id: pick })}</button>
      </>
    );
  }
  return (
    <section className="claim" aria-labelledby={id} data-testid="roll-forward">
      <h3 id={id}>{RF.title}</h3>
      <p>{RF.intro}</p>
      {body}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/** The parts of a listing's page that follow its opening: its claims, its record, roll forward. */
export function ListingMore({ listingId, listing }) {
  const state = LISTING_STATES[Number(listing.state)];
  const opened = state !== 'Listed';
  const data = useListingRecord(listingId, listing.artifactHash, opened);
  if (!opened) return null;
  return (
    <>
      <ListingClaims artifactHash={listing.artifactHash} data={data} />
      {data && !data.failed && <RollForward listingId={listingId} listing={listing} identity={data.identity} />}
    </>
  );
}
