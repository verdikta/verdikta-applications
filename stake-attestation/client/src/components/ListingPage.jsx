import { useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, followListing, submitListing } from '../lib/api.js';
import { formIssues, initialForm, listMismatches, toListingRequest } from '../lib/draft.js';
import { disclosureKeyBytes32 } from '../lib/disclosure.js';
import { errorReason } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';
import { DisclosureKeyPanel } from './DisclosureKeyPanel.jsx';
import { ListAndFund } from './ListAndFund.jsx';
import { ListingForm, fieldLabel } from './ListingForm.jsx';
import { ValidationReport } from './ValidationReport.jsx';

const L = STRINGS.listing;

/**
 * The maker's listing flow (design §7.1, §8.1): the form, then the server's validation (its
 * issues when it refuses the request; otherwise the build's status and validation report), then
 * list() and fund() through the wallet once the listing is ready.
 */
export function ListingPage() {
  const [form, setForm] = useState(initialForm);
  const [keyReady, setKeyReady] = useState(false);
  const [phase, setPhase] = useState('edit'); // edit | sending | following
  const [serverIssues, setServerIssues] = useState(null); // { error, issues }
  const [notice, setNotice] = useState(null);
  const [view, setView] = useState(null);
  const [sent, setSent] = useState(null); // the request the server answered with this listing
  const following = useRef(null);

  useEffect(() => () => following.current?.abort(), []);

  const issues = useMemo(() => formIssues(form), [form]);
  const pending = Object.keys(issues);
  const canSend = pending.length === 0 && keyReady && form.disclosureKey && phase === 'edit';

  const onRecipient = (recipient, ready) => {
    setForm((f) => ({ ...f, disclosureKey: recipient }));
    setKeyReady(ready);
  };

  const send = async () => {
    setPhase('sending');
    setServerIssues(null);
    setNotice(null);
    let first;
    const body = toListingRequest(form);
    try {
      first = await submitListing(body);
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
        {notice && <p className="error" role="alert">{notice}</p>}
        <ValidationReport report={view.validationReport} devTrust={view.devTrust} />
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
        {pending.length > 0 && <p className="hint">{fill(L.fixFirst, { fields: pending.map(fieldLabel).join(', ') })}</p>}
        <button type="button" onClick={send} disabled={!canSend}>{phase === 'sending' ? L.submitting : L.submit}</button>
      </div>
    </>
  );
}
