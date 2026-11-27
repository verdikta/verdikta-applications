// The badge (design §4.1, §4.2): the live state of an artifact hash's stake, never a historical
// claim. While a listing of the hash takes commits (Open, not lapsed) the badge reads
//
//   "no finding at or above <class> while staked"    <class>: the listing's lowestClassCounted
//
// qualified " · under-staked" and " · invited" when the labels say so; below the badge floor it
// reads only "scanned"; and a valid finding on the hash's record at or above the class replaces
// the statement. Each of these also states the shown listing's proof (src/control/facts.js): "staker
// named by the repository" and, for a contract, "staker controls the deployment". Only listings that
// count are on the view (src/control/counting.js), so a stake nobody proved never reaches the badge:
// a hash with listings and none that counts reads "no counted stake". When no listing of the hash takes commits the statement is gone: the badge says how
// the stake ended (closed, rolled forward, depleted, lapsed). Of several live listings the badge
// shows the one with the highest top award (then the lowest class counted, then the oldest). Every
// string it writes passes the shared wording check.
//
// The maker's hold (node P40; owner, 2026-11-23). A held listing takes no commit, so it is never the live listing here
// (its labels' `live` is false, labels.js), and no statement is made of it. When no listing of the hash takes commits
// and one is on hold, the badge reads
//
//   "stake on hold since <day>"                      <day>: the hold's day, UTC, as YYYY-MM-DD
//
// whatever else is true of that listing (Depleted, or its paid period over), and before a listing that ended: the
// stake is still there, and its maker has stopped new claims on it. Of several on hold, the latest listing's. "On
// hold", not "held": a stake that is "held" could be read as one that is in place.
//
// How it is drawn: the site's indigo and its scales on the left, the state's colour on the right, and
// the message on lines of its own parts: what it states, then the shown listing's proof under it (two
// lines for a contract: the repository's, then the deployment's). A line break stands where a " · "
// between two parts was; the words are the message's, and the title and aria-label, which a screen
// reader and a hover read, hold the message whole. A repository's badge is about two thirds as wide as
// one line would be.
import { outcomeRank } from '../chain/abi.js';
import { statementOf } from '../control/facts.js';
import { assertWording } from '../wording.js';

export const BADGE_LABEL = 'verdikta stake';
// each with white text at 4.5:1 or better
const COLORS = Object.freeze({
  live: '#047857',
  qualified: '#b45309',
  scanned: '#475569',
  finding: '#b91c1c',
  ended: '#64748b',
  none: '#64748b',
  unavailable: '#64748b',
});
const LABEL_COLOR = '#4c51bf';
// the scales of the site's header and icon, on a 24 by 24 grid (Lucide's "scale", ISC licence)
const MARK = '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>';
const ENDED = Object.freeze({ Closed: 'stake closed', Rolled: 'stake rolled forward', Depleted: 'stake depleted', Listed: 'stake not open' });

/** A time in unix seconds as its UTC day, YYYY-MM-DD. */
const utcDay = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

const byStrength = (a, b) => {
  const top = BigInt(b.awards[3]) - BigInt(a.awards[3]);
  if (top !== 0n) return top > 0n ? 1 : -1;
  const cls = outcomeRank(a.lowestClassCounted) - outcomeRank(b.lowestClassCounted);
  if (cls !== 0) return cls;
  return Number(BigInt(a.listingId) - BigInt(b.listingId));
};

/**
 * What the badge says for a record response (site.record), or for no record (null), and the lines it
 * is drawn on: what it states, then each part of the shown listing's proof when it states one.
 * @returns {{ badge: { state: string, message: string, listingId: string|null, class: string|null }, lines: string[] }}
 */
export function badgeDrawn(view) {
  const plain = (state, message, listingId = null) => ({ badge: { state, message, listingId, class: null }, lines: [message] });
  if (!view) return plain('none', 'no stake');
  const { record, labels } = view;
  if (!record.listings.length) return plain('none', 'no counted stake');
  const live = record.listings.filter((l) => labels.listings[l.listingId]?.live).sort(byStrength);
  if (!live.length) {
    const newestFirst = [...record.listings].sort((a, b) => Number(BigInt(b.listingId) - BigInt(a.listingId)));
    const heldAtOf = (l) => labels.listings[l.listingId]?.heldAt ?? null;
    const held = newestFirst.find((l) => heldAtOf(l) !== null);
    if (held) return plain('ended', `stake on hold since ${utcDay(heldAtOf(held))}`, held.listingId);
    const latest = newestFirst[0];
    const message = latest.lapsed && latest.state === 'Open' ? 'stake lapsed' : ENDED[latest.state] ?? 'stake ended';
    return plain('ended', message, latest.listingId);
  }
  const l = live[0];
  const cls = l.lowestClassCounted;
  // no fact at hand reads as "no", the fact's default
  const control = view.control?.[l.listingId] ?? { proof: 'no', statement: statementOf('repository', false) };
  // the proof's statement is one part, or two joined by " · " (src/control/facts.js): each on its own line
  const withFact = (state, statement) => ({
    badge: { state, message: `${statement} · ${control.statement}`, listingId: l.listingId, class: cls },
    lines: [statement, ...control.statement.split(' · ')],
  });
  const found = record.findings.filter((f) => outcomeRank(f.outcome) >= outcomeRank(cls)).length;
  if (found) return withFact('finding', `${found} valid finding${found > 1 ? 's' : ''} at or above ${cls}`);
  const lab = labels.listings[l.listingId];
  if (lab.stake === 'scanned') return withFact('scanned', 'scanned');
  if (lab.stake === null) return withFact('unavailable', 'price unavailable');
  const qualifiers = [lab.stake === 'under-staked' ? 'under-staked' : null, lab.invited ? 'invited' : null].filter(Boolean);
  return withFact(qualifiers.length || control.proof !== 'yes' ? 'qualified' : 'live', [`no finding at or above ${cls} while staked`, ...qualifiers].join(' · '));
}

/**
 * What the badge says for a record response (site.record), or for no record (null).
 * @returns {{ state: string, message: string, listingId: string|null, class: string|null }}
 */
export const badgeFor = (view) => badgeDrawn(view).badge;

const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
// Verdana 11px, as shields.io lays out text: about 6.5 px a character is room enough for a line, and about
// 6.2 is what the letters take. Each text is set to that length (textLength), so a viewer's wider fallback
// font cannot run a line past its box.
const textWidth = (s) => Math.ceil(s.length * 6.5);
const textLength = (s) => Math.round(s.length * 6.2);
// the first line's baseline and the step to the next; a badge of one or two lines is 40 px high, of three 54
const FIRST = 17;
const STEP = 14;

/**
 * The SVG for badgeDrawn's answer: `message` whole in the title and the aria-label, and `lines` (the
 * message's parts, at most three; the message itself without them) drawn one under the other.
 */
export function renderBadge({ state, message, lines = [message], label = BADGE_LABEL }) {
  assertWording(label);
  assertWording(message);
  for (const line of lines) assertWording(line);
  const drawn = lines.length >= 1 && lines.length <= 3 ? lines : [message];
  const color = COLORS[state] ?? COLORS.none;
  const title = `${label}: ${message}`;
  const h = drawn.length === 3 ? 54 : 40;
  const middle = h / 2 + 4;
  // the label's part: the mark (16 px, from x 8), the label from x 29, 8 px after it
  const lw = 29 + textWidth(label) + 8;
  const mw = 10 + Math.max(...drawn.map(textWidth)) + 12;
  const w = lw + mw;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="${w}" height="${h}" rx="5" fill="${color}"/>`,
    `<path d="M5 0h${lw - 5}v${h}H5a5 5 0 0 1-5-5V5a5 5 0 0 1 5-5z" fill="${LABEL_COLOR}"/>`,
    `<g transform="translate(8 ${h / 2 - 8}) scale(0.6667)" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${MARK}</g>`,
    `<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="29" y="${middle}" textLength="${textLength(label)}">${escapeXml(label)}</text>`,
    ...drawn.map((line, i) => `<text x="${lw + 10}" y="${drawn.length === 1 ? middle : FIRST + STEP * i}" textLength="${textLength(line)}">${escapeXml(line)}</text>`),
    '</g></svg>',
  ].join('');
  return assertWording(svg);
}
