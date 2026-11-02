import { useId, useState } from 'react';

import { LISTING_STATES } from '../chain/abi.js';
import { eventOf, stakeAttestation } from '../chain/wallet.js';
import { listMismatches } from '../lib/draft.js';
import { disclosureKeyBytes32 } from '../lib/disclosure.js';
import { formatEth } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';
import { FundListing } from './FundListing.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const C = STRINGS.chain;
const CLASSES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * A ready listing: the terms list() will store, then list() and fund() through the maker's
 * wallet with the server's arguments exactly as it sent them (design §13.2; the server's
 * listParams.js makes them ethers-ready), but only once they are checked against what the maker
 * sent (`sent`): the disclosure key above all, so no server can list a key of its own.
 *
 * A version has one listing per maker until it is closed (activeListingOf). If the maker already
 * has one, list() would revert: the page points to that listing instead, whose own page
 * (#/fund/<id>) funds it. The same page is offered right after list(), so leaving between list
 * and fund strands nothing.
 */
export function ListAndFund({ view, sent }) {
  const id = useId();
  const w = useWalletContext();
  const { params, listingCid, disputeCid, knownIssueIds } = view.list;
  const mismatches = listMismatches(sent, view.list, disclosureKeyBytes32);
  const [listed, setListed] = useState(null); // { listingId, tx, maker }
  const [existing, setExisting] = useState(null); // { listingId, state }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const list = async () => {
    setBusy(true);
    setError(null);
    setExisting(null);
    try {
      const { signer, provider, account } = await w.ensure();
      const reader = stakeAttestation(provider);
      const active = await reader.activeListingOf(view.artifactHash, account);
      if (active !== 0n) {
        const l = await reader.getListing(active);
        setExisting({ listingId: active, state: LISTING_STATES[Number(l.state)] });
        return;
      }
      const sa = stakeAttestation(signer);
      const tx = await sa.list(params, listingCid, disputeCid, knownIssueIds);
      const rc = await tx.wait();
      const e = eventOf(sa, rc, 'Listed');
      if (!e) throw new Error('no Listed event in the receipt');
      setListed({ listingId: e.args.listingId, tx: tx.hash, maker: account });
    } catch (err) {
      setError(fill(C.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
  };

  const hours = (s) => Number(s) / 3600;
  const fundLink = (listingId) => <a href={`#/fund/${listingId}`}>{fill(C.fundPage, { id: String(listingId) })}</a>;
  return (
    <section className="ready" aria-labelledby={id}>
      <h3 id={id}>{C.readyTitle}</h3>
      <p className="mono">{fill(C.listingCid, { cid: listingCid })}</p>
      <p className="mono">{fill(C.disputeCid, { cid: disputeCid })}</p>
      <p className="mono">{fill(C.artifactHash, { hash: view.artifactHash })}</p>
      <h4>{C.terms}</h4>
      <ul>
        <li>{fill(C.awards, Object.fromEntries(CLASSES.map((c, i) => [c, formatEth(params.awards[i])])))}</li>
        <li>{fill(C.bond, { bond: formatEth(params.bondWei) })}</li>
        <li>{fill(C.windows, { fix: hours(params.fixWindow) / 24, dispute: hours(params.disputeWindow), grace: hours(params.disclosureGrace), reveal: hours(params.revealWindow) / 24 })}</li>
        <li>{params.allowlist.length ? fill(C.allowlist, { count: params.allowlist.length }) : C.open}</li>
        <li>{fill(C.knownIssues, { count: knownIssueIds.length })}</li>
        {params.valueAtRiskUsd !== '0' && <li>{fill(C.valueAtRisk, { usd: params.valueAtRiskUsd })}</li>}
      </ul>

      {mismatches.length > 0 && <p className="error" role="alert">{fill(C.mismatch, { fields: mismatches.join(', ') })}</p>}
      {!listed && mismatches.length === 0 && (
        <button type="button" onClick={list} disabled={busy}>{busy ? C.listing : C.list}</button>
      )}
      {existing && (
        <p data-testid="existing-listing" className="error">
          {existing.state === 'Listed'
            ? <>{fill(C.existingListed, { id: String(existing.listingId) })} {fundLink(existing.listingId)}</>
            : fill(C.existingActive, { id: String(existing.listingId), state: STRINGS.fund.states[existing.state] ?? existing.state })}
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {listed && (
        <>
          <p data-testid="listed" data-listing-id={String(listed.listingId)}>
            {fill(C.listed, { id: String(listed.listingId), tx: listed.tx })}
          </p>
          <p className="hint">{C.fundLater} {fundLink(listed.listingId)}</p>
          <FundListing listingId={listed.listingId} top={BigInt(params.awards[3])} maker={listed.maker} artifactHash={view.artifactHash} />
        </>
      )}
    </section>
  );
}
