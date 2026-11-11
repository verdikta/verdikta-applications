import { useId } from 'react';

import { STRINGS, fill } from '../strings.js';

const R = STRINGS.report;

/** The builder's documents step (node P20): what the tier would read, past the cap, skipped and unmatched. */
function Documents({ d }) {
  const id = useId();
  const list = (xs) => (xs.length ? xs.join(', ') : R.documentsNone);
  return (
    <section aria-labelledby={id} data-testid="report-documents">
      <h4 id={id}>{R.documentsTitle}</h4>
      <p className="hint">{R.documentsIntro}</p>
      <p className="mono">{fill(R.documentsRead, { files: list(d.read.map((f) => f.path)) })}</p>
      {d.pastCap.length > 0 && <p className="mono">{fill(R.documentsPastCap, { files: list(d.pastCap) })}</p>}
      {d.skipped.length > 0 && <p className="mono">{fill(R.documentsSkipped, { files: list(d.skipped.map((f) => fill(R.documentsSkippedFile, { path: f.path, reason: R.documentsReasons[f.reason] ?? f.reason }))) })}</p>}
      {d.unmatched.length > 0 && <p className="mono">{fill(R.documentsUnmatched, { globs: list(d.unmatched.map((u) => u.glob)) })}</p>}
    </section>
  );
}

/** The environment builder's validation report (design §8.2), as the server's listing view carries it. */
export function ValidationReport({ report, devTrust }) {
  const id = useId();
  return (
    <section className="report" aria-labelledby={id}>
      <h3 id={id}>{R.title}</h3>
      {!report ? <p className="hint">{R.none}</p> : (
        <>
          <p>{fill(R.status, { status: report.status })}</p>
          {Array.isArray(report.steps) && report.steps.length > 0 && (
            <>
              <h4>{R.steps}</h4>
              <ul aria-label={R.steps} className="steps">
                {report.steps.map((s) => (
                  <li key={s.name} data-testid={`report-step-${s.name}`} className={`step-${s.status}`}>
                    {fill(R.step, { name: R.stepNames[s.name] ?? s.name, status: s.status })}
                  </li>
                ))}
              </ul>
            </>
          )}
          {report.image?.ref && <p className="mono">{fill(R.image, { ref: report.image.ref })}</p>}
          {report.documents && Array.isArray(report.documents.read) && <Documents d={{ pastCap: [], skipped: [], unmatched: [], ...report.documents }} />}
          {report.limits && <p>{fill(R.limits, { limits: Object.entries(report.limits).map(([k, v]) => `${k} ${v}`).join(', ') })}</p>}
          {report.attestation && <p>{fill(R.attestation, { trust: report.attestation.trust, keyId: report.attestation.keyId })}</p>}
          {(devTrust || report.attestation?.trust === 'dev') && <p className="warning">{R.devTrust}</p>}
          {report.refusals?.length > 0 && (
            <>
              <h4>{R.refusals}</h4>
              <ul aria-label={R.refusals}>
                {report.refusals.map((r, i) => <li key={`${r.code}-${i}`}><code>{r.code}</code> ({r.step}): {r.detail}</li>)}
              </ul>
            </>
          )}
          {report.warnings?.length > 0 && (
            <>
              <h4>{R.warnings}</h4>
              <ul aria-label={R.warnings}>
                {report.warnings.map((w, i) => <li key={`${w.code ?? 'w'}-${i}`}><code>{w.code}</code>: {w.detail}</li>)}
              </ul>
            </>
          )}
          {report.error && <p className="error">{fill(R.error, { code: report.error.code, detail: report.error.detail })}</p>}
        </>
      )}
    </section>
  );
}
