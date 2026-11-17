import { Clock } from 'lucide-react';

import { ApiError } from '../lib/api.js';
import { errorReason, formatTime } from '../lib/format.js';
import { STRINGS, fill } from '../strings.js';

/**
 * A list of facts: each row's label and value, the value marked `data-testid` for the tests.
 * Rows that are null are left out.
 * @param {{ rows: ({ id: string, label: string, value: import('react').ReactNode }|null)[], testId?: string, className?: string }} props
 */
export function Facts({ rows, testId, className }) {
  return (
    <dl data-testid={testId} className={className}>
      {rows.filter(Boolean).map((r) => (
        <div key={r.id} className="fact">
          <dt>{r.label}</dt>
          <dd data-testid={r.id}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The same rows as tiles: the figures a reader looks for first (escrow, bond, a count). A row's
 * `more`, when it has one, is a second value under the first, with its own `data-testid`.
 */
export function Tiles({ rows }) {
  return (
    <dl className="tiles">
      {rows.filter(Boolean).map((r) => (
        <div key={r.id} className="tile">
          <dt>{r.label}</dt>
          <dd data-testid={r.id}>{r.value}</dd>
          {r.more ? <dd className="tile-links" data-testid={r.more.id}>{r.more.value}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/**
 * The same rows as pills beside a card's name. A row with `line` draws its label in the pill with its
 * value ("Staker named by the repository: yes"), in the row's `tone`; any other row's value brings its
 * own pills, and its label is said to a screen reader and not drawn.
 */
export function Pills({ rows }) {
  return (
    <dl className="pills">
      {rows.filter(Boolean).map((r) => (
        <div key={r.id} className={r.line ? `pill-fact pill-line ${r.tone ?? ''}`.trim() : 'pill-fact'}>
          <dt className={r.line ? undefined : 'sr-only'}>{r.label}</dt>
          <dd data-testid={r.id}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Which block an answer of the site's server is of, and whether its indexer is behind. `children`:
 * what sits at the other end of the line (the feed's button that reads again).
 */
export function AsOf({ view, testId, children = null }) {
  const block = view.block;
  return (
    <>
      <div className="toolbar">
        <p className="hint as-of" data-testid={testId}>
          <Clock size={16} aria-hidden="true" />
          {fill(STRINGS.site.asOf, { block: block.number, time: formatTime(block.timestamp) })}
        </p>
        {children}
      </div>
      {!view.fresh && <p className="warning" role="status">{fill(STRINGS.site.stale, { block: block.number, reason: view.staleReason })}</p>}
    </>
  );
}

/** A failed call to the site's server, as one line. */
export function siteErrorText(err) {
  if (err instanceof ApiError && err.status === 503 && err.body?.error === 'CHAIN_NOT_CONFIGURED') return STRINGS.site.notConfigured;
  return fill(STRINGS.site.unavailable, { reason: errorReason(err) });
}
