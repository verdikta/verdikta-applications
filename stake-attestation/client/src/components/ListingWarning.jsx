import { useId } from 'react';

import { STRINGS } from '../strings.js';

/**
 * Who reads a proof first, and that the code may exist elsewhere: on every listing page (owner
 * decision Q34), as the hunter tool (node P5) says it before a commit. The text is
 * shared/src/listingWarning.js.
 */
export function ListingWarning() {
  const id = useId();
  const W = STRINGS.warning;
  return (
    <section className="claim warning" aria-labelledby={id} data-testid="listing-warning">
      <h3 id={id}>{W.title}</h3>
      <p>{W.proofFirst}</p>
      <p>{W.elsewhere}</p>
    </section>
  );
}
