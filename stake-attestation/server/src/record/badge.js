// The badge (design §4.1, §4.2): the live state of an artifact hash's stake, never a historical
// claim. While a listing of the hash takes commits (Open, not lapsed) the badge reads
//
//   "no finding at or above <class> while staked"    <class>: the listing's lowestClassCounted
//
// qualified " · under-staked" and " · invited" when the labels say so; below the badge floor it
// reads only "scanned"; and a valid finding on the hash's record at or above the class replaces
// the statement. Each of these also states the shown listing's control fact (src/control/facts.js),
// "staker controls the repository: yes / no", and a "no" qualifies the statement as under-staked and
// invited do. When no listing of the hash takes commits the statement is gone: the badge says how
// the stake ended (closed, rolled forward, depleted, lapsed). Of several live listings the badge
// shows the one with the highest top award (then the lowest class counted, then the oldest). Every
// string it writes passes the shared wording check.
import { outcomeRank } from '../chain/abi.js';
import { statementOf } from '../control/facts.js';
import { assertWording } from '../wording.js';

export const BADGE_LABEL = 'verdikta stake';
const COLORS = Object.freeze({
  live: '#2e7d32',
  qualified: '#b26a00',
  scanned: '#546e7a',
  finding: '#c62828',
  ended: '#757575',
  none: '#9e9e9e',
  unavailable: '#9e9e9e',
});
const ENDED = Object.freeze({ Closed: 'stake closed', Rolled: 'stake rolled forward', Depleted: 'stake depleted', Listed: 'stake not open' });

const byStrength = (a, b) => {
  const top = BigInt(b.awards[3]) - BigInt(a.awards[3]);
  if (top !== 0n) return top > 0n ? 1 : -1;
  const cls = outcomeRank(a.lowestClassCounted) - outcomeRank(b.lowestClassCounted);
  if (cls !== 0) return cls;
  return Number(BigInt(a.listingId) - BigInt(b.listingId));
};

/**
 * What the badge says for a record response (site.record), or for no record (null).
 * @returns {{ state: string, message: string, listingId: string|null, class: string|null }}
 */
export function badgeFor(view) {
  if (!view) return { state: 'none', message: 'no stake', listingId: null, class: null };
  const { record, labels } = view;
  const live = record.listings.filter((l) => labels.listings[l.listingId]?.live).sort(byStrength);
  if (!live.length) {
    const latest = [...record.listings].sort((a, b) => Number(BigInt(b.listingId) - BigInt(a.listingId)))[0];
    const message = latest.lapsed && latest.state === 'Open' ? 'stake lapsed' : ENDED[latest.state] ?? 'stake ended';
    return { state: 'ended', message, listingId: latest.listingId, class: null };
  }
  const l = live[0];
  const cls = l.lowestClassCounted;
  // no fact at hand reads as "no", the fact's default
  const control = view.control?.[l.listingId] ?? { controls: 'no', statement: statementOf('repository', false) };
  const withFact = (message) => `${message} · ${control.statement}`;
  const found = record.findings.filter((f) => outcomeRank(f.outcome) >= outcomeRank(cls)).length;
  if (found) return { state: 'finding', message: withFact(`${found} valid finding${found > 1 ? 's' : ''} at or above ${cls}`), listingId: l.listingId, class: cls };
  const lab = labels.listings[l.listingId];
  if (lab.stake === 'scanned') return { state: 'scanned', message: withFact('scanned'), listingId: l.listingId, class: cls };
  if (lab.stake === null) return { state: 'unavailable', message: withFact('price unavailable'), listingId: l.listingId, class: cls };
  const qualifiers = [lab.stake === 'under-staked' ? 'under-staked' : null, lab.invited ? 'invited' : null].filter(Boolean);
  const message = withFact([`no finding at or above ${cls} while staked`, ...qualifiers].join(' · '));
  return { state: qualifiers.length || control.controls !== 'yes' ? 'qualified' : 'live', message, listingId: l.listingId, class: cls };
}

const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
// Verdana 11px, as shields.io lays out text: about 6.5 px a character is close enough for a badge.
const textWidth = (s) => Math.ceil(s.length * 6.5) + 10;

/** The SVG for badgeFor's answer. */
export function renderBadge({ state, message, label = BADGE_LABEL }) {
  assertWording(label);
  assertWording(message);
  const color = COLORS[state] ?? COLORS.none;
  const title = `${label}: ${message}`;
  const lw = textWidth(label);
  const mw = textWidth(message);
  const w = lw + mw;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`,
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${lw / 2}" y="14">${escapeXml(label)}</text>`,
    `<text x="${lw + mw / 2}" y="14">${escapeXml(message)}</text>`,
    '</g></svg>',
  ].join('');
  return assertWording(svg);
}
