import { useId } from 'react';

import { badgePath } from '../lib/api.js';
import { STRINGS } from '../strings.js';
import { TextField } from './Field.jsx';

const B = STRINGS.badge;

/**
 * The hash's badge, served by the site's server from the record (design §4.1: the badge is the
 * live state), and the snippets that embed it elsewhere, linking back to this record.
 */
export function BadgeEmbed({ hash }) {
  const id = useId();
  const h = hash.toLowerCase();
  const origin = window.location.origin;
  const svg = `${origin}${badgePath(h)}`;
  const page = `${origin}/#/record/${h}`;
  return (
    <section className="claim" aria-labelledby={id} data-testid="badge-panel">
      <h3 id={id}>{B.title}</h3>
      <p className="hint">{B.intro}</p>
      {/* full size, as it shows where it is embedded: on a narrow screen it scrolls in its own row */}
      <p className="badge-wrap"><img src={badgePath(h)} alt={B.alt} data-testid="badge" /></p>
      <TextField label={B.markdown} value={`[![${B.alt}](${svg})](${page})`} readOnly mono testId="badge-markdown" multiline rows={2} />
      <TextField label={B.html} value={`<a href="${page}"><img src="${svg}" alt="${B.alt}"></a>`} readOnly mono testId="badge-html" multiline rows={2} />
    </section>
  );
}
