import { Fragment } from 'react';

import { CLASSES } from '../chain/abi.js';
import { STRINGS } from '../strings.js';

// a class and its amount; the amount is formatEth's, digits and at most one point
const AWARD = /\b(LOW|MEDIUM|HIGH|CRITICAL) (\d+(?:\.\d+)?)/g;

/**
 * An award-table line ("LOW 0, MEDIUM 0.1, HIGH 0.4, CRITICAL 2 ETH") with each class and its amount
 * drawn as a chip. The text is the line itself, character for character, and it reads as one line:
 * the chips are inline boxes around parts of it, and the commas between them are text of no size, so
 * a selection copies the line whole and a search of the page finds it. (A chip that is a flex or
 * absolutely placed box would put a line break in the page's text at each one.) A class below
 * `lowest`, the lowest class the listing counts, is drawn muted; without `lowest`, a class that pays 0 is.
 */
export function AwardLine({ text, lowest = null }) {
  const floor = lowest ? CLASSES.indexOf(lowest) : -1;
  const parts = [];
  let at = 0;
  for (const m of text.matchAll(AWARD)) {
    const [whole, cls, amount] = m;
    const off = floor >= 0 ? CLASSES.indexOf(cls) < floor : Number(amount) === 0;
    parts.push({ gap: text.slice(at, m.index) }, { cls, amount, off });
    at = m.index + whole.length;
  }
  parts.push({ gap: text.slice(at) });
  return (
    <span className="awards">
      {parts.map((p, i) => {
        if (p.cls) return <span key={p.cls} className={p.off ? 'award award-off' : 'award'}><b>{p.cls}</b> {p.amount}</span>;
        if (!p.gap) return null;
        // between two chips: in the text, not drawn. Before the first and after the last: drawn as it is.
        return <span key={`gap-${i}`} className={p.gap.trim() === ',' ? 'sep' : 'awards-unit'}>{p.gap}</span>;
      })}
    </span>
  );
}

// noPrice is a sentence, not a word: its pill may wrap
const TONES = { staked: 'pill pill-tint', 'under-staked': 'pill pill-warn', noPrice: 'pill pill-long' };

/** The site's labels of a listing, each as a pill. The text is the labels joined by ", ", as before, on one line. */
export function LabelPills({ labels }) {
  if (!labels.length) return STRINGS.record.none;
  return labels.map((l, i) => (
    <Fragment key={l}>
      {i > 0 && <span className="sep">, </span>}
      <span className={TONES[l] ?? 'pill'}>{STRINGS.labels[l] ?? l}</span>
    </Fragment>
  ));
}

/** A listing's state as a pill: green while it takes claims. */
export function StatePill({ state, text }) {
  return <span className={state === 'Open' ? 'pill pill-dot pill-ok' : 'pill pill-dot'}>{text}</span>;
}
