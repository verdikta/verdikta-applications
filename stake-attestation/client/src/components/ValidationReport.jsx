import { useId } from 'react';

import { STRINGS, fill } from '../strings.js';

const R = STRINGS.report;

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
