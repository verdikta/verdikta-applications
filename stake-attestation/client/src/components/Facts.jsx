import { ApiError } from '../lib/api.js';
import { errorReason, formatTime } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';

/**
 * A list of facts: each row's label and value, the value marked `data-testid` for the tests.
 * Rows that are null are left out.
 * @param {{ rows: ({ id: string, label: string, value: import('react').ReactNode }|null)[], testId?: string }} props
 */
export function Facts({ rows, testId }) {
  return (
    <dl data-testid={testId}>
      {rows.filter(Boolean).map((r) => (
        <div key={r.id} className="fact">
          <dt>{r.label}</dt>
          <dd data-testid={r.id}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Which block an answer of the site's server is of, and whether its indexer is behind. */
export function AsOf({ view, testId }) {
  const block = view.block;
  return (
    <>
      <p className="hint" data-testid={testId}>{fill(STRINGS.site.asOf, { block: block.number, time: formatTime(block.timestamp) })}</p>
      {!view.fresh && <p className="warning" role="status">{fill(STRINGS.site.stale, { block: block.number, reason: view.staleReason })}</p>}
    </>
  );
}

/** A failed call to the site's server, as one line. */
export function siteErrorText(err) {
  if (err instanceof ApiError && err.status === 503 && err.body?.error === 'CHAIN_NOT_CONFIGURED') return STRINGS.site.notConfigured;
  return fill(STRINGS.site.unavailable, { reason: errorReason(err) });
}

/** The site's label words for a listing's labels. */
export const labelText = (labels) => labels.map((l) => STRINGS.labels[l] ?? l).join(', ');
