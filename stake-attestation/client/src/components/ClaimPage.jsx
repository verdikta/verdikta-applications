import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { CLAIM_STATES, DISPUTE_RESULTS, OUTCOMES } from '../chain/abi.js';
import { WalletError, chainReader, stakeAttestation } from '../chain/wallet.js';
import { ApiError, disputeStatementChallenge, pinDisputeStatement } from '../lib/api.js';
import { disputeOffer, pendingRound, releaseOffer } from '../lib/claimActions.js';
import { errorReason, formatEth, formatTime } from '../lib/format.js';
import { POLL_MS, WATCH_MS, watchUntil } from '../lib/poll.js';
import { MAX_STATEMENT_BYTES, checkStatement, cidMatches, statementSha256 } from '../lib/statement.js';
import { STRINGS, fill } from '../strings.js';
import { Facts } from './Facts.jsx';
import { TextField } from './Field.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const C = STRINGS.claim;
const E = STRINGS.enums;
const P = STRINGS.pending;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// after a mined transaction: how many reads of the claim, how far apart
const AFTER_TX_READS = 4;
const AFTER_TX_WAIT_MS = 2000;
const when = (t) => (t === 0n ? C.notYet : formatTime(t));

/**
 * The claim as the chain has it at one block, the latest, read through `provider` (the site's
 * reader by default, the wallet's just before a transaction): the stored claim, its listing, the
 * lens's derived state (Revealable) and times, the dispute deadline, and that block's time as
 * the clock. One block, so a finalize mined between two reads never pairs a new state with the
 * old claim. Null for no such claim.
 */
async function readClaim(claimId, provider = null) {
  const p = provider ?? await chainReader();
  const sa = stakeAttestation(p);
  const id = BigInt(claimId);
  // a raw eth_getBlockByNumber: ethers may answer getBlock() from a cache
  const block = await p.send('eth_getBlockByNumber', ['latest', false]);
  const at = { blockTag: Number(block.number) };
  if (id === 0n || id > (await sa.claimCount(at))) return null;
  const claim = await sa.getClaim(id, at);
  const [listing, state, times, deadline] = await Promise.all([
    sa.getListing(claim.listingId, at), sa.claimState(id, at), sa.claimTimes(id, at), sa.disputeDeadline(id, at),
  ]);
  return { claim, listing, state: CLAIM_STATES[Number(state)], times, deadline, now: BigInt(block.timestamp), block: at.blockTag };
}

const releaseArgs = (d) => ({ disclosedAt: d.claim.disclosedAt, state: d.state, revealableAt: d.times.revealableAt, now: d.now });
const disputeArgs = (d) => ({ state: d.state, outcome: OUTCOMES[Number(d.claim.outcome)], dispute: DISPUTE_RESULTS[Number(d.claim.dispute)], deadline: d.deadline, now: d.now });

/** The maker's account from the wallet, or an error line when it is not the listing's maker. */
async function makerWallet(w, maker) {
  const wallet = await w.ensure();
  if (!same(wallet.account, maker)) return { error: fill(C.notMaker, { maker, account: wallet.account }) };
  return { wallet };
}

/**
 * Watches a pending round (design §11, erratum E4): reads the claim every POLL_MS until it leaves
 * `kind`'s state, for up to WATCH_MS, then says plainly that it stopped and offers a re-check.
 */
function PendingWatch({ claimId, kind, at, onData }) {
  const [timedOut, setTimedOut] = useState(false);
  const [round, setRound] = useState(0);
  const latest = useRef(onData);
  latest.current = onData;

  useEffect(() => {
    const ac = new AbortController();
    setTimedOut(false);
    watchUntil({
      read: () => readClaim(claimId),
      done: (d) => d !== null && pendingRound(d.state) !== kind,
      onValue: (d) => { if (d && !ac.signal.aborted) latest.current(d); },
      signal: ac.signal,
    }).then((r) => { if (r.outcome === 'timeout') setTimedOut(true); });
    return () => ac.abort();
  }, [claimId, kind, round]);

  const minutes = WATCH_MS / 60000;
  return (
    <section className="claim" data-testid="pending" aria-live="polite">
      {!timedOut && <p>{fill(kind === 'dispute' ? P.dispute : P.claim, { time: formatTime(at), seconds: POLL_MS / 1000, minutes })}</p>}
      {!timedOut && <p className="hint">{P.typical}</p>}
      {timedOut && (
        <>
          <p data-testid="pending-timeout">{fill(P.timedOut, { minutes })}</p>
          <button type="button" onClick={() => setRound((x) => x + 1)}>{P.recheck}</button>
        </>
      )}
    </section>
  );
}

/** release(): the maker waives the rest of a disclosed claim's fix window. */
function ReleasePanel({ claimId, data, onData, onSent }) {
  const w = useWalletContext();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const offer = releaseOffer(releaseArgs(data));
  if (!offer.offer) return null;

  const release = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = await makerWallet(w, data.listing.maker);
      if (m.error) return setError(m.error);
      const { signer, provider } = m.wallet;
      // the window may have ended, or the claim moved on, since the page read it
      const fresh = await readClaim(claimId, provider);
      if (!releaseOffer(releaseArgs(fresh)).offer) {
        onData(fresh);
        return setError(C.changed);
      }
      const tx = await stakeAttestation(signer).release(BigInt(claimId));
      await tx.wait();
      onSent({ release: { tx: tx.hash } });
    } catch (err) {
      setError(fill(C.failed, { reason: walletMessage(err) }));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <section className="claim" aria-labelledby={id} data-testid="release-panel">
      <h3 id={id}>{STRINGS.release.title}</h3>
      <p>{STRINGS.release.intro}</p>
      <p>{fill(STRINGS.release.until, { time: formatTime(offer.until) })}</p>
      <button type="button" onClick={release} disabled={busy}>{busy ? STRINGS.release.sending : STRINGS.release.button}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/**
 * dispute(): the maker escalates a valid verdict once, inside the dispute window (design §13.2).
 * The escalation prepay (the lens's disputeFee: the dispute panel's maxTotalFee) is read from the
 * chain and shown before anything is sent; it is read again just before sending, and a higher
 * figure stops the dispute until the maker has seen it. The statement is pinned by the site's
 * server once the maker's wallet signs its sign-in challenge (the browser has no pinning
 * credentials), and its CID goes on-chain; the contract names it in the request's second
 * addendum line (erratum E2).
 */
function DisputePanel({ claimId, data, onData, onSent }) {
  const w = useWalletContext();
  const id = useId();
  const D = STRINGS.dispute;
  const listingId = data.claim.listingId;
  const [fee, setFee] = useState(null);
  const [text, setText] = useState('');
  const [pinned, setPinned] = useState(null); // { sha, cid }
  const [stage, setStage] = useState(null); // checking | signing | pinning | sending
  const [error, setError] = useState(null);
  const offer = disputeOffer(disputeArgs(data));
  const open = offer.offer;

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    chainReader().then((p) => stakeAttestation(p).disputeFee(listingId)).then((f) => { if (live) setFee(f); }).catch((err) => {
      if (live) setError(fill(C.readFailed, { reason: err instanceof WalletError ? walletMessage(err) : errorReason(err) }));
    });
    return () => { live = false; };
  }, [listingId, open]);

  if (!offer.offer) return null;

  const check = checkStatement(text);
  let statementError = null;
  if (check.error === 'tooLong') statementError = fill(D.tooLong, { bytes: check.length, max: MAX_STATEMENT_BYTES });
  else if (check.error === 'malformed') statementError = D.malformed;

  /** The fee and the claim now, through the wallet; an error line when the dispute cannot go on. */
  const stillOpen = async (provider) => {
    const [live, fresh] = await Promise.all([stakeAttestation(provider).disputeFee(listingId), readClaim(claimId, provider)]);
    if (!disputeOffer(disputeArgs(fresh)).offer) {
      onData(fresh);
      return { error: D.closed };
    }
    if (live > fee) {
      setFee(live);
      return { error: fill(D.feeRose, { fee: formatEth(live) }) };
    }
    return { live };
  };

  const dispute = async () => {
    setError(null);
    setStage('checking');
    try {
      const m = await makerWallet(w, data.listing.maker);
      if (m.error) return setError(m.error);
      const { signer, provider, account } = m.wallet;
      let s = await stillOpen(provider);
      if (s.error) return setError(s.error);

      const sha = statementSha256(check.bytes);
      let cid = pinned?.sha === sha ? pinned.cid : null;
      if (!cid) {
        setStage('signing');
        const resource = `claim:${claimId}`;
        const ch = await disputeStatementChallenge(claimId);
        // sign only a challenge to pin a statement on this claim, for this wallet
        if (ch.action !== 'pin-dispute' || ch.resource !== resource || !same(ch.address, account) || !String(ch.message).split('\n').includes(`Resource: ${resource}`)) {
          return setError(fill(D.pinFailed, { reason: 'CHALLENGE_MISMATCH' }));
        }
        const signature = await signer.signMessage(ch.message);
        setStage('pinning');
        const r = await pinDisputeStatement(claimId, { nonce: ch.nonce, signature, statement: text });
        if (!cidMatches(r.cid, check.bytes)) return setError(fill(D.cidMismatch, { cid: String(r.cid) }));
        cid = r.cid;
        setPinned({ sha, cid });
      }

      // signing took time: the window and the fee are read again
      s = await stillOpen(provider);
      if (s.error) return setError(s.error);
      setStage('sending');
      const tx = await stakeAttestation(signer).dispute(BigInt(claimId), cid, { value: s.live });
      await tx.wait();
      onSent({ dispute: { tx: tx.hash, cid } });
    } catch (err) {
      if (err instanceof ApiError) setError(fill(D.pinFailed, { reason: err.body?.error ?? err.message }));
      else setError(fill(C.failed, { reason: walletMessage(err) }));
    } finally {
      setStage(null);
    }
    return undefined;
  };

  const feeText = fee === null ? null : formatEth(fee);
  const stageText = { checking: D.checking, signing: D.signing, pinning: D.pinning, sending: D.sending };
  return (
    <section className="claim" aria-labelledby={id} data-testid="dispute-panel">
      <h3 id={id}>{D.title}</h3>
      <p>{fill(D.intro, { deadline: formatTime(offer.until) })}</p>
      <p data-testid="dispute-prepay">{feeText === null ? D.prepayLoading : fill(D.prepay, { fee: feeText })}</p>
      <TextField
        label={fill(D.statement, { max: MAX_STATEMENT_BYTES })}
        value={text}
        onChange={setText}
        multiline
        rows={6}
        hint={D.statementHint}
        error={statementError}
      />
      <p className="hint">{fill(D.bytes, { bytes: check.length, max: MAX_STATEMENT_BYTES })}</p>
      {pinned && <p className="mono">{fill(D.pinned, { cid: pinned.cid })}</p>}
      <button type="button" onClick={dispute} disabled={stage !== null || feeText === null || !check.ok}>
        {stage ? stageText[stage] : fill(D.button, { fee: feeText ?? '…' })}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function ClaimLookup() {
  const [id, setId] = useState('');
  const go = () => { if (/^\d{1,20}$/.test(id.trim())) window.location.hash = `#/claim/${id.trim()}`; };
  return (
    <div className="lookup">
      <TextField label={C.claimId} value={id} onChange={setId} inputMode="numeric" />
      <button type="button" onClick={go}>{C.load}</button>
    </div>
  );
}

/**
 * One claim (#/claim/<id>): its state and times as the chain holds them, a pending round watched
 * for up to 15 minutes, and the maker's actions: release in the fix window, dispute of a valid
 * verdict. Every transaction goes through the maker's wallet after the claim is read again.
 */
export function ClaimPage({ claimId }) {
  const headingId = useId();
  const [loaded, setLoaded] = useState(null); // { data } | { missing } | { failed }
  const [attempt, setAttempt] = useState(0);
  // what this page sent and saw mined: { release: { tx }, dispute: { tx, cid } }
  const [sent, setSent] = useState({});
  const onData = useCallback((data) => setLoaded({ data }), []);
  /**
   * After a mined transaction the claim is read again, a few times if the chain does not answer,
   * so a dispute's round is watched; if it still cannot be read, the page offers to read again,
   * and what was sent stays on the page either way.
   */
  const onSent = useCallback(async (s) => {
    setSent((x) => ({ ...x, ...s }));
    let reason = null;
    for (let i = 0; i < AFTER_TX_READS; i += 1) {
      if (i) await new Promise((r) => setTimeout(r, AFTER_TX_WAIT_MS));
      try {
        const d = await readClaim(claimId);
        if (d) return setLoaded({ data: d });
      } catch (err) {
        reason = err instanceof WalletError ? walletMessage(err) : errorReason(err);
      }
    }
    return setLoaded({ failed: reason ?? 'no answer' });
  }, [claimId]);

  useEffect(() => {
    if (claimId === null) return undefined;
    let live = true;
    setLoaded(null);
    readClaim(claimId)
      .then((d) => { if (live) setLoaded(d ? { data: d } : { missing: true }); })
      .catch((err) => { if (live) setLoaded({ failed: err instanceof WalletError ? walletMessage(err) : errorReason(err) }); });
    return () => { live = false; };
  }, [claimId, attempt]);

  const header = (
    <>
      <h2>{C.title}</h2>
      <p className="lead">{C.intro}</p>
    </>
  );
  const notices = (
    <>
      {sent.release && <p data-testid="released" className="ok">{fill(STRINGS.release.done, { tx: sent.release.tx })}</p>}
      {sent.dispute && (
        <section className="claim" data-testid="dispute-done">
          <p data-testid="statement-cid" className="mono">{fill(STRINGS.dispute.pinned, { cid: sent.dispute.cid })}</p>
          <p data-testid="disputed" className="ok">{fill(STRINGS.dispute.done, { tx: sent.dispute.tx })}</p>
        </section>
      )}
    </>
  );
  if (claimId === null) return <>{header}<ClaimLookup /></>;
  if (!loaded) return <>{header}{notices}<p className="hint">{C.loading}</p></>;
  if (loaded.missing) return <>{header}<p className="error">{fill(C.notFound, { id: claimId })}</p><ClaimLookup /></>;
  if (loaded.failed) {
    return (
      <>
        {header}
        {notices}
        <p className="error">{fill(C.readFailed, { reason: loaded.failed })}</p>
        <button type="button" onClick={() => setAttempt((a) => a + 1)}>{C.retry}</button>
      </>
    );
  }

  const d = loaded.data;
  const c = d.claim;
  const listingId = String(c.listingId);
  const judged = c.judgedAt !== 0n;
  const dispute = DISPUTE_RESULTS[Number(c.dispute)];
  const pending = pendingRound(d.state);
  return (
    <>
      {header}
      <section className="claim" aria-labelledby={headingId}>
        <h3 id={headingId}>{fill(C.summary, { id: claimId, listingId })}</h3>
        <Facts testId="claim-facts" rows={[
          { id: 'claim-state', label: C.state, value: E.claimStates[d.state] ?? d.state },
          c.late ? { id: 'claim-late', label: C.late, value: C.yes } : null,
          { id: 'claim-hunter', label: C.hunter, value: <span className="mono">{c.hunter}</span> },
          { id: 'claim-committed', label: C.committedAt, value: when(c.committedAt) },
          { id: 'claim-disclosed', label: C.disclosedAt, value: when(c.disclosedAt) },
          c.disclosedAt !== 0n ? { id: 'claim-fix-window-end', label: C.fixWindowEnd, value: formatTime(d.times.revealableAt) } : null,
          { id: 'claim-released', label: C.released, value: c.released ? C.yes : C.no },
          { id: 'claim-revealed', label: C.revealedAt, value: when(c.revealedAt) },
          { id: 'claim-judged', label: C.judgedAt, value: when(c.judgedAt) },
          judged ? { id: 'claim-outcome', label: C.outcome, value: OUTCOMES[Number(c.outcome)] } : null,
          dispute !== 'None' ? { id: 'claim-dispute', label: C.dispute, value: E.disputes[dispute] ?? dispute } : null,
          { id: 'claim-settled', label: C.settledAt, value: when(c.settledAt) },
          c.settledAt !== 0n ? { id: 'claim-paid', label: C.paid, value: fill(STRINGS.record.eth, { eth: formatEth(c.paidWei) }) } : null,
        ]} />
        <p className="actions">
          <a href={`#/fund/${listingId}`}>{fill(C.listingPage, { id: listingId })}</a>
          {c.disclosedAt !== 0n && <a href={`#/check/${claimId}`}>{C.checkPage}</a>}
        </p>
      </section>
      {notices}
      {pending && <PendingWatch claimId={claimId} kind={pending} at={pending === 'dispute' ? c.disputedAt : c.revealedAt} onData={onData} />}
      {!sent.release && <ReleasePanel claimId={claimId} data={d} onData={onData} onSent={onSent} />}
      {!sent.dispute && <DisputePanel claimId={claimId} data={d} onData={onData} onSent={onSent} />}
    </>
  );
}
