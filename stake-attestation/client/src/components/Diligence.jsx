import { useId } from 'react';

import { STRINGS } from '../strings.js';

const D = STRINGS.diligence;

/**
 * What a record does and does not mean (design §4.1, §4.2, §15), on the record and feed pages.
 * Every word is in STRINGS.diligence, where the wording guard reads it.
 */
export function Diligence() {
  const id = useId();
  return (
    <section className="diligence" aria-labelledby={id} data-testid="diligence">
      <h3 id={id}>{D.title}</h3>
      <p>{D.facts}</p>
      <p>{D.badge}</p>
      <p>{D.amount}</p>
      <ul>{D.labelList.map((l) => <li key={l}>{l}</li>)}</ul>
      <p>{D.readingsIntro}</p>
      <ul>{D.readings.map((r) => <li key={r}>{r}</li>)}</ul>
      <p>{D.readingsAfter}</p>
      <p>{D.looking}</p>
      <p>{D.holding}</p>
      <table>
        <caption>{D.tableTitle}</caption>
        <thead>
          <tr><th scope="col">{D.tableHead.award}</th><th scope="col">{D.tableHead.who}</th><th scope="col">{D.tableHead.attests}</th><th scope="col">{D.tableHead.label}</th></tr>
        </thead>
        <tbody>
          {D.table.map((r) => <tr key={r.award}><td>{r.award}</td><td>{r.who}</td><td>{r.attests}</td><td>{r.label}</td></tr>)}
        </tbody>
      </table>
      <p>{D.feed}</p>
      <p>{D.hunters}</p>
    </section>
  );
}
