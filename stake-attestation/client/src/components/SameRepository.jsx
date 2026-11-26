import { Fragment, useId } from 'react';

import { disclosureRecipientOf } from '../lib/disclosure.js';
import { formatTime } from '../lib/format.js';
import { pieces } from '../lib/pieces.js';
import { STRINGS, fill } from '../strings.js';
import { StatePill } from './Awards.jsx';
import { CopyButton } from './Copy.jsx';

const S = STRINGS.sameRepository;
const D = STRINGS.disclosure;

/** One form of the key, whole, as a chip in the line, and the button that copies it. */
function KeyForm({ value, what }) {
  return (
    <>
      <span className="mono code-inline">{value}</span>
      <CopyButton value={value} what={what} />
    </>
  );
}

/**
 * A listing's disclosure key in both its forms, and that they are one key (node P35; claim test, item 4): the age
 * recipient a listing archive names, and the bytes32 the contract stores. `recipient` is the server's
 * (disclosureRecipient); without it, the same conversion here.
 *
 * The page's text is the line of strings.js, character for character, and it reads as one line: each form is
 * an inline chip around its part of the line, with a copy button that holds an icon and no text, as the
 * page's other long values have. The note under it is its own sentence, on its own line.
 */
export function DisclosureKeyForms({ bytes32, recipient = null, testId }) {
  let age = recipient;
  if (!age) {
    try {
      age = disclosureRecipientOf(bytes32);
    } catch {
      age = null;
    }
  }
  const key = String(bytes32);
  return (
    <span className="key-forms" data-testid={testId}>
      <span className="key-line">
        {age
          ? pieces(D.line, { recipient: age, bytes32: key }).map((p, i) => (
            p.name ? <KeyForm key={p.name} value={p.value} what={D.copy[p.name]} /> : <Fragment key={i}>{p.text}</Fragment>
          ))
          : <KeyForm value={key} what={D.copy.bytes32} />}
      </span>
      {' '}<span className="hint key-note">{D.note}</span>
    </span>
  );
}

/**
 * One other listing's line, the link to its page. The text is the line of strings.js; its commit is drawn in
 * monospace and its state as a pill, green only for a listing that takes claims here: open, its fee paid, not on
 * hold (node P42), and offered by this site.
 */
function OtherListing({ x }) {
  const line = pieces(S.line, { id: x.listingId, commit: x.baseCommit ?? S.none, state: STRINGS.fund.states[x.state] ?? x.state });
  return (
    <a className="same-line" href={x.page}>
      {line.map((p, i) => {
        if (p.name === 'state') return <StatePill key="state" state={x.lapsed || !x.counted || x.heldAt !== null ? null : x.state} text={p.value} />;
        // the words that lead to the state: in the text, not drawn beside a pill
        if (p.text && line[i + 1]?.name === 'state') return <span key={i} className="sep">{p.text}</span>;
        return <span key={p.name ?? i} className={p.name === 'commit' && x.baseCommit ? 'same-text mono' : 'same-text'}>{p.text ?? p.value}</span>;
      })}
    </a>
  );
}

/** The other listings of a repository, each a link to its page (lib/sameRepository.js makes the list). */
export function SameRepositoryList({ list }) {
  if (!list.length) return S.none;
  return (
    <ul className="inline same-list">
      {list.map((x) => (
        <li key={x.listingId} data-testid={`same-repository-${x.listingId}`}>
          <OtherListing x={x} />
          {x.heldAt !== null && <span className="hint" data-testid={`same-repository-${x.listingId}-held`}> ({fill(S.held, { time: formatTime(x.heldAt) })})</span>}
          {x.lapsed && <span className="hint"> ({S.lapsed})</span>}
          {!x.counted && <span className="hint"> ({S.notCounted})</span>}
        </li>
      ))}
    </ul>
  );
}

/** A listing's own page: the other listings of its repository, from its version's record; `data` as useListingRecord gives it. */
export function SameRepositorySection({ data }) {
  const id = useId();
  if (!data) return null;
  return (
    <section className="claim" aria-labelledby={id} data-testid="same-repository">
      <h3 id={id}>{S.title}</h3>
      <p className="hint">{S.intro}</p>
      {data.failed ? <p className="hint">{fill(S.unavailable, { reason: data.failed })}</p> : <SameRepositoryList list={data.sameRepository} />}
    </section>
  );
}
