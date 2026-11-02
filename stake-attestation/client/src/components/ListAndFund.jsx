import { useId, useState } from 'react';

import { stakeAttestation, eventOf } from '../chain/wallet.js';
import { FormError, ethToWei, listMismatches } from '../lib/draft.js';
import { disclosureKeyBytes32 } from '../lib/disclosure.js';
import { formatEth, formatTime } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';
import { TextField } from './Field.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const C = STRINGS.chain;
const CLASSES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * A ready listing: the terms list() will store, then list() and fund() through the maker's
 * wallet with the server's arguments exactly as it sent them (design §13.2; the server's
 * listParams.js makes them ethers-ready), but only once they are checked against what the maker
 * sent (`sent`): the disclosure key above all, so no server can list a key of its own. fund()
 * pays feeDue() plus the escrow, at least the CRITICAL award, which opens the listing.
 */
export function ListAndFund({ view, sent }) {
  const id = useId();
  const w = useWalletContext();
  const { params, listingCid, disputeCid, knownIssueIds } = view.list;
  const top = BigInt(params.awards[3]);
  const mismatches = listMismatches(sent, view.list, disclosureKeyBytes32);
  const [listed, setListed] = useState(null); // { listingId, tx, fee }
  const [opened, setOpened] = useState(null); // { until, tx }
  const [escrow, setEscrow] = useState(formatEth(top));
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const run = async (what, fn) => {
    setBusy(what);
    setError(null);
    try {
      await fn(await w.ensure());
    } catch (err) {
      setError(err instanceof FormError ? err.message : fill(C.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(null);
    }
  };

  const list = () => run('list', async ({ signer, provider }) => {
    const sa = stakeAttestation(signer);
    const tx = await sa.list(params, listingCid, disputeCid, knownIssueIds);
    const rc = await tx.wait();
    const e = eventOf(sa, rc, 'Listed');
    if (!e) throw new Error('no Listed event in the receipt');
    const listingId = e.args.listingId;
    // the listing exists from here on, whatever happens next: never offer list() again
    setListed({ listingId, tx: tx.hash, fee: null });
    const fee = await stakeAttestation(provider).feeDue(listingId);
    setListed({ listingId, tx: tx.hash, fee });
  });

  let escrowWei = null;
  let escrowError = null;
  try {
    escrowWei = BigInt(ethToWei(escrow));
    if (escrowWei < top) escrowError = fill(C.escrowLow, { min: formatEth(top) });
  } catch {
    escrowError = STRINGS.listing.bounds.amount;
  }

  const fund = () => run('fund', async ({ signer, provider }) => {
    const sa = stakeAttestation(signer);
    const fee = await stakeAttestation(provider).feeDue(listed.listingId);
    const tx = await sa.fund(listed.listingId, fee, { value: fee + escrowWei });
    await tx.wait();
    const l = await stakeAttestation(provider).getListing(listed.listingId);
    setOpened({ until: l.fundedUntil, tx: tx.hash });
  });

  const hours = (s) => Number(s) / 3600;
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
        <button type="button" onClick={list} disabled={busy !== null}>{busy === 'list' ? C.listing : C.list}</button>
      )}
      {listed && (
        <p data-testid="listed" data-listing-id={String(listed.listingId)}>
          {fill(C.listed, { id: String(listed.listingId), tx: listed.tx })}
        </p>
      )}
      {listed && !opened && (
        <>
          {listed.fee !== null && <p>{fill(C.fee, { fee: formatEth(listed.fee) })}</p>}
          <TextField label={C.escrow} value={escrow} onChange={setEscrow} inputMode="decimal" error={escrowError} />
          <button type="button" onClick={fund} disabled={busy !== null || escrowError !== null}>{busy === 'fund' ? C.funding : C.fund}</button>
        </>
      )}
      {opened && (
        <p data-testid="opened" className="ok">
          {fill(C.opened, { id: String(listed.listingId), until: formatTime(opened.until), tx: opened.tx })}
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
