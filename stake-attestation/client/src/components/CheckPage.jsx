import { useEffect, useId, useState } from 'react';

import { WalletError, chainNow, chainReader, stakeAttestation } from '../chain/wallet.js';
import { CONFIG } from '../config.js';
import { checkDisclosure, flagOffer } from '../lib/check.js';
import { identityFromKeyFile, saveLocally } from '../lib/disclosure.js';
import { fetchCiphertext } from '../lib/fetchCiphertext.js';
import { errorReason, formatTime } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';
import { TextField } from './Field.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const C = STRINGS.check;
const STEP_IDS = ['key', 'fetch', 'ciphertext', 'decrypt', 'plaintext'];
const STEP_TEXT = { passed: C.stepPassed, failed: C.stepFailed, skipped: C.stepSkipped };

async function readClaim(claimId) {
  const provider = await chainReader();
  const sa = stakeAttestation(provider);
  const count = await sa.claimCount();
  const id = BigInt(claimId);
  if (id === 0n || id > count) return null;
  const claim = await sa.getClaim(id);
  const listing = await sa.getListing(claim.listingId);
  return { claim, listing, now: await chainNow(provider) };
}

function verdictText(r) {
  if (r.verdict === 'match') return C.verdicts.match;
  if (r.verdict === 'wrongKey') return C.verdicts.wrongKey;
  if (r.verdict === 'badIdentity') return fill(C.verdicts.badIdentity, r.reason.vars);
  const reason = fill(C.reasons[r.reason.key], r.reason.vars);
  return fill(r.verdict === 'bad' ? C.verdicts.bad : C.verdicts.unavailable, { reason });
}

function ClaimLookup() {
  const [id, setId] = useState('');
  const go = () => { if (/^\d{1,20}$/.test(id.trim())) window.location.hash = `#/check/${id.trim()}`; };
  return (
    <div className="lookup">
      <TextField label={C.claimId} value={id} onChange={setId} inputMode="numeric" />
      <button type="button" onClick={go}>{C.load}</button>
    </div>
  );
}

/**
 * Decrypt-and-check a disclosed claim (design §14, erratum E5). The maker's private key is typed
 * or loaded from the key file into this page's state, used by checkDisclosure (common's
 * decryptDisclosure) and nothing else: no request carries it and nothing stores it. The only
 * network calls are chain reads, the ciphertext's GET from the gateway, and the wallet's
 * flagBadDisclosure transaction.
 */
export function CheckPage({ claimId }) {
  const w = useWalletContext();
  const headingId = useId();
  const [loaded, setLoaded] = useState(null); // { claim, listing, now } | { missing } | { failed }
  const [identity, setIdentity] = useState('');
  const [keyFileError, setKeyFileError] = useState(null);
  const [result, setResult] = useState(null);
  const [offer, setOffer] = useState(null);
  const [busy, setBusy] = useState(null);
  const [flagged, setFlagged] = useState(null); // tx hash
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (claimId === null) return undefined;
    let live = true;
    setLoaded(null);
    readClaim(claimId)
      .then((r) => { if (live) setLoaded(r ?? { missing: true }); })
      .catch((err) => { if (live) setLoaded({ failed: err instanceof WalletError ? fill(STRINGS.wallet[err.code], err.vars) : errorReason(err) }); });
    return () => { live = false; };
  }, [claimId, attempt]);

  if (claimId === null) {
    return (
      <>
        <h2>{C.title}</h2>
        <p className="lead">{C.intro}</p>
        <ClaimLookup />
      </>
    );
  }

  const header = (
    <>
      <h2>{C.title}</h2>
      <p className="lead">{C.intro}</p>
    </>
  );
  if (!loaded) return <>{header}<p className="hint">{C.loading}</p></>;
  if (loaded.missing) return <>{header}<p className="error">{fill(C.notFound, { id: claimId })}</p><ClaimLookup /></>;
  if (loaded.failed) {
    return (
      <>
        {header}
        <p className="error">{fill(C.readFailed, { reason: loaded.failed })}</p>
        <button type="button" onClick={() => setAttempt((a) => a + 1)}>{C.retry}</button>
      </>
    );
  }

  const { claim, listing } = loaded;
  const disclosed = claim.disclosedAt !== 0n;

  const loadKeyFile = async (file) => {
    setKeyFileError(null);
    if (!file) return;
    const found = identityFromKeyFile(await file.text());
    if (found) setIdentity(found);
    else setKeyFileError(C.keyFileEmpty);
  };

  const run = async () => {
    setBusy('check');
    setResult(null);
    setOffer(null);
    setError(null);
    try {
      if (!CONFIG.ipfsGateway) throw new Error(C.noGateway);
      const r = await checkDisclosure({
        // a whole key file pasted in works too
        identity: identityFromKeyFile(identity) ?? identity,
        listingKey: listing.disclosureKey,
        claim: { archiveHash: claim.archiveHash, ciphertextSha256: claim.ciphertextSha256, ciphertextCid: claim.ciphertextCid },
        fetchCiphertext: (cid) => fetchCiphertext(CONFIG.ipfsGateway, cid),
      });
      // the flag depends on the chain as it is now: its clock and whether the claim is flagged
      const provider = await chainReader();
      const [fresh, now] = await Promise.all([stakeAttestation(provider).getClaim(BigInt(claimId)), chainNow(provider)]);
      setResult(r);
      setOffer(flagOffer({ verdict: r.verdict, now, disclosedAt: fresh.disclosedAt, disclosureGrace: listing.disclosureGrace, flagged: fresh.flaggedBadDisclosure || flagged !== null }));
    } catch (err) {
      setError(err.message === C.noGateway ? C.noGateway : err instanceof WalletError ? walletMessage(err) : fill(C.readFailed, { reason: errorReason(err) }));
    } finally {
      setBusy(null);
    }
  };

  const flag = async () => {
    setBusy('flag');
    setError(null);
    try {
      // the offer was made when the check ran: the grace may have ended since, or someone flagged
      const provider = await chainReader();
      const [fresh, now] = await Promise.all([stakeAttestation(provider).getClaim(BigInt(claimId)), chainNow(provider)]);
      const still = flagOffer({ verdict: result.verdict, now, disclosedAt: fresh.disclosedAt, disclosureGrace: listing.disclosureGrace, flagged: fresh.flaggedBadDisclosure });
      if (!still.offer) {
        setOffer(still);
        return;
      }
      const { signer, account } = await w.ensure();
      if (account.toLowerCase() !== listing.maker.toLowerCase()) {
        setError(fill(C.notMaker, { maker: listing.maker, account }));
        return;
      }
      const tx = await stakeAttestation(signer).flagBadDisclosure(BigInt(claimId));
      await tx.wait();
      setFlagged(tx.hash);
      setOffer((o) => ({ ...o, offer: false, why: 'alreadyFlagged' }));
    } catch (err) {
      setError(walletMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {header}
      <section data-testid="claim-summary" aria-labelledby={headingId} className="claim">
        <h3 id={headingId}>{fill(C.summary, { id: claimId, listingId: String(claim.listingId) })}</h3>
        <dl>
          <dt>{C.hunter}</dt><dd className="mono">{claim.hunter}</dd>
          <dt>{C.committedAt}</dt><dd>{formatTime(claim.committedAt)}</dd>
          <dt>{C.disclosedAt}</dt><dd>{disclosed ? formatTime(claim.disclosedAt) : '-'}</dd>
          {disclosed && (<><dt>{C.graceEnds}</dt><dd>{formatTime(claim.disclosedAt + listing.disclosureGrace)}</dd></>)}
          {disclosed && (<><dt>{C.cid}</dt><dd className="mono">{claim.ciphertextCid}</dd></>)}
          <dt>{C.archiveHash}</dt><dd className="mono">{claim.archiveHash}</dd>
          <dt>{C.ciphertextHash}</dt><dd className="mono">{claim.ciphertextSha256}</dd>
          <dt>{C.flagged}</dt><dd>{claim.flaggedBadDisclosure || flagged ? C.yes : C.no}</dd>
        </dl>
      </section>

      {!disclosed && <p className="hint">{C.notDisclosed}</p>}

      {disclosed && (
        <section className="check-run">
          <TextField label={C.identity} value={identity} onChange={setIdentity} multiline rows={2} mono secret />
          <div className="field">
            <label htmlFor={`${headingId}-file`}>{C.keyFile}</label>
            <input id={`${headingId}-file`} type="file" accept=".txt,text/plain" onChange={(e) => loadKeyFile(e.target.files?.[0])} />
            {keyFileError && <p className="field-error">{keyFileError}</p>}
          </div>
          <button type="button" onClick={run} disabled={busy !== null || !identity.trim()}>{busy === 'check' ? C.running : C.run}</button>
        </section>
      )}

      {result && (
        <section className="check-result">
          <ul className="steps">
            {STEP_IDS.map((s) => (
              <li key={s} data-testid={`check-step-${s}`} className={`step-${result.steps[s]}`}>
                {fill(C.stepLine, { name: C.steps[s], result: STEP_TEXT[result.steps[s]] })}
              </li>
            ))}
          </ul>
          <p data-testid="check-verdict" className={result.verdict === 'match' ? 'ok' : 'error'}>{verdictText(result)}</p>
          {result.verdict === 'match' && (
            <button type="button" className="secondary" onClick={() => saveLocally(`claim-${claimId}.zip`, result.plaintext, 'application/zip')}>{C.save}</button>
          )}
          {offer?.offer && (
            <button type="button" onClick={flag} disabled={busy !== null}>{busy === 'flag' ? C.flagging : C.flag}</button>
          )}
          {offer?.why === 'graceOver' && <p className="hint">{fill(C.graceOver, { time: formatTime(offer.graceEnd) })}</p>}
          {offer?.why === 'alreadyFlagged' && !flagged && <p className="hint">{C.alreadyFlagged}</p>}
        </section>
      )}
      {flagged && <p data-testid="flagged" className="ok">{fill(C.flaggedNow, { tx: flagged })}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
