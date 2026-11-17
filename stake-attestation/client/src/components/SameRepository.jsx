import { useId } from 'react';

import { disclosureRecipientOf } from '../lib/disclosure.js';
import { STRINGS, fill } from '../strings.js';

const S = STRINGS.sameRepository;
const D = STRINGS.disclosure;

/**
 * A listing's disclosure key in both its forms, and that they are one key (node P35; claim test, item 4): the age
 * recipient a listing archive names, and the bytes32 the contract stores. `recipient` is the server's
 * (disclosureRecipient); without it, the same conversion here.
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
  return (
    <span data-testid={testId}>
      <span className="mono">{age ? fill(D.line, { recipient: age, bytes32: String(bytes32) }) : String(bytes32)}</span>
      {' '}<span className="hint">{D.note}</span>
    </span>
  );
}

/** The other listings of a repository, each a link to its page (lib/sameRepository.js makes the list). */
export function SameRepositoryList({ list }) {
  if (!list.length) return S.none;
  return (
    <ul className="inline">
      {list.map((x) => (
        <li key={x.listingId} data-testid={`same-repository-${x.listingId}`}>
          <a className="mono" href={x.page}>{fill(S.line, { id: x.listingId, commit: x.baseCommit ?? S.none, state: STRINGS.fund.states[x.state] ?? x.state })}</a>
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
