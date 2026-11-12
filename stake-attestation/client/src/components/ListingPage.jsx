import { useEffect, useMemo, useRef, useState } from 'react';

import { hasWallet } from '../chain/wallet.js';
import { ApiError, followListing, listingChallenge, submitListing } from '../lib/api.js';
import { formIssues, initialForm, listMismatches, toListingRequest } from '../lib/draft.js';
import { disclosureKeyBytes32 } from '../lib/disclosure.js';
import { errorReason } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';
import { DeploymentProofPanel } from './DeploymentProofPanel.jsx';
import { DisclosureKeyPanel } from './DisclosureKeyPanel.jsx';
import { ListAndFund } from './ListAndFund.jsx';
import { ListingForm, fieldLabel } from './ListingForm.jsx';
import { ScanPanel } from './ScanPanel.jsx';
import { ValidationReport } from './ValidationReport.jsx';
import { useWalletContext } from './wallet.js';

const L = STRINGS.listing;

/**
 * The maker's listing flow (design §7.1, §8.1): the form, then the server's validation (its
 * issues when it refuses the request; otherwise the project's proof, then the build's status and
 * validation report), then list() and fund() through the wallet once the listing is ready. The
 * request names the connected wallet as the maker: the project names that address in its
 * repository (node P9), the wallet signs the request, and the baseline scan's findings go to it
 * (design §8.3). With no wallet nothing is sent.
 */
export function ListingPage() {
  const w = useWalletContext();
  const [form, setForm] = useState(initialForm);
  const [keyReady, setKeyReady] = useState(false);
  const [proof, setProof] = useState({ signer: '', signature: '', creationTx: '' });
  const [phase, setPhase] = useState('edit'); // edit | sending | following
  const [serverIssues, setServerIssues] = useState(null); // { error, issues }
  const [notice, setNotice] = useState(null);
  const [view, setView] = useState(null);
  const [sent, setSent] = useState(null); // the request the server answered with this listing
  const following = useRef(null);

  useEffect(() => () => following.current?.abort(), []);

  const issues = useMemo(() => formIssues(form), [form]);
  const pending = Object.keys(issues);
  const needsProof = form.kind === 'contract' && (!proof.signer.trim() || !proof.signature.trim());
  const canSend = pending.length === 0 && keyReady && form.disclosureKey && !needsProof && phase === 'edit';

  const onRecipient = (recipient, ready) => {
    setForm((f) => ({ ...f, disclosureKey: recipient }));
    setKeyReady(ready);
  };

  const send = async () => {
    setPhase('sending');
    setServerIssues(null);
    setNotice(null);
    let first;
    let body;
    let wallet;
    try {
      if (!hasWallet()) throw new Error('no wallet');
      wallet = await w.ensure();
    } catch {
      setPhase('edit');
      setNotice(L.needWallet);
      return;
    }
    try {
      body = { ...toListingRequest(form), maker: wallet.account };
      if (form.kind === 'contract') {
        body.deploymentProof = { signer: proof.signer.trim(), signature: proof.signature.trim(), ...(proof.creationTx.trim() ? { creationTx: proof.creationTx.trim() } : {}) };
      }
      const challenge = await listingChallenge(body);
      setPhase('signing');
      const signature = await wallet.signer.signMessage(challenge.message);
      setPhase('sending');
      first = await submitListing({ ...body, auth: { nonce: challenge.nonce, signature } });
    } catch (err) {
      setPhase('edit');
      if (err instanceof ApiError && err.status === 400 && err.body?.issues) setServerIssues(err.body);
      else if (err instanceof ApiError && err.status === 429) setNotice(L.busy);
      else setNotice(fill(L.networkError, { reason: errorReason(err) }));
      return;
    }
    setSent(body);
    setView(first);
    setPhase('following');
    const ctl = new AbortController();
    following.current = ctl;
    try {
      await followListing(first.id, (v) => { if (!ctl.signal.aborted) setView(v); }, { signal: ctl.signal });
    } catch (err) {
      setNotice(fill(L.networkError, { reason: errorReason(err) }));
    }
  };

  const again = () => {
    following.current?.abort();
    setNotice(null);
    setView(null);
    setPhase('edit');
  };

  const mismatched = view?.status === 'ready' && view.list && sent ? listMismatches(sent, view.list, disclosureKeyBytes32).length > 0 : false;
  if (phase === 'following' && view) {
    // the builder said no, or the server lost the listing (its jobs are in memory): edit and send again
    const done = ['refused', 'error'].includes(view.status) || notice !== null || mismatched;
    return (
      <>
        <h2>{L.title}</h2>
        <p data-testid="listing-status" className="status-line">
          {fill(L.status, { status: L.statuses[view.status] ?? view.status })}
        </p>
        {view.error && <p className="error">{fill(L.jobError, view.error)}</p>}
        {view.refusal && <p className="error" role="alert" data-testid="listing-refusal">{fill(L.refusal, view.refusal)}</p>}
        {notice && <p className="error" role="alert">{notice}</p>}
        {!view.refusal && <ValidationReport report={view.validationReport} devTrust={view.devTrust} />}
        <ScanPanel view={view} />
        {view.status === 'ready' && view.list && <ListAndFund view={view} sent={sent} />}
        {done && <button type="button" className="secondary" onClick={again}>{L.again}</button>}
      </>
    );
  }

  return (
    <>
      <h2>{L.title}</h2>
      <p className="lead">{L.intro}</p>
      <ListingForm
        form={form}
        setForm={setForm}
        issues={issues}
        keyPanel={<DisclosureKeyPanel recipient={form.disclosureKey} ready={keyReady} onRecipient={onRecipient} />}
        proofPanel={<DeploymentProofPanel form={form} proof={proof} onProof={setProof} />}
      />
      {serverIssues && (
        <div className="refused" role="alert">
          <h3>{L.refusedTitle}</h3>
          <p>{L.refusedIntro}</p>
          <ul>
            {serverIssues.issues.map((i, n) => (
              <li key={`${i.code}-${i.path}-${n}`}><code>{i.code}</code> <code>{i.path}</code>: {i.detail}</li>
            ))}
          </ul>
        </div>
      )}
      {notice && <p className="error" role="alert">{notice}</p>}
      <div className="submit">
        {(!keyReady || !form.disclosureKey) && <p className="hint">{L.needKey}</p>}
        {needsProof && <p className="hint">{L.needSignature}</p>}
        {pending.length > 0 && <p className="hint">{fill(L.fixFirst, { fields: pending.map(fieldLabel).join(', ') })}</p>}
        <button type="button" onClick={send} disabled={!canSend}>{phase === 'sending' ? L.submitting : phase === 'signing' ? L.signing : L.submit}</button>
      </div>
    </>
  );
}
