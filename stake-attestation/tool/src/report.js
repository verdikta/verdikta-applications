// What report.md says, read for advice only (node P19; owner, 2026-11-10, Q73 #2). The report should say where the code
// is required to behave as the PoC asserts, in a "## Requirement" section. The arbiters' External Adapter requires no
// such section (archive.js holds its rules, unchanged), so nothing here refuses a claim: check and commit warn.
//
// The heading is read loosely, by line, as CommonMark reads an ATX heading: up to three spaces of indentation, one to
// six "#", then a space or a tab, its text without a closing run of "#". The text's first word is Requirement or
// Requirements, in any case ("## Requirement: src/Vault.sol:42" counts; "## Requirementless" does not). Lines inside
// a fenced code block (``` or ~~~) are not headings. A setext heading (text over a line of "=" or "-") is not read,
// and neither is bold text standing in for a heading: the warning then says so, and the hunter can use "##".
import { REQUIREMENT } from './notices.js';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const CLOSING = /(?:^|[ \t]+)#+[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const REQUIREMENT_WORD = /^requirements?\b/i;

const ADVICE = `This is a warning: no gate requires the section, and the tool refuses nothing for it. ${REQUIREMENT}`;

/** Each warning's text, fixed by its code: nothing of the report is quoted, so --no-pack prints it as it is. */
export const REQUIREMENT_WARNINGS = Object.freeze({
  NO_REQUIREMENT_SECTION: `report.md has no "## Requirement" section. ${ADVICE}`,
  EMPTY_REQUIREMENT_SECTION: `report.md's "## Requirement" section has nothing under its heading. ${ADVICE}`,
});
const warning = (code) => [{ code, detail: REQUIREMENT_WARNINGS[code] }];

/** Each ATX heading outside fenced code: its level, its text and its line. */
function headings(lines) {
  const out = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = FENCE.exec(line);
    if (fence) {
      // a closing fence: the same character, at least as long, nothing after it but spaces
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === '') fence = null;
      return;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      return;
    }
    const h = ATX.exec(line);
    if (h) out.push({ level: h[1].length, text: (h[2] ?? '').replace(CLOSING, '').trim(), line: i });
  });
  return out;
}

/**
 * Whether report.md has a "## Requirement" section with text under its heading, as warnings: [] when it has, or when
 * the report is not text the gate would take (the gate says what is wrong with it then).
 * @param {Buffer|null} bytes - report.md as on disk
 * @returns {{ code: 'NO_REQUIREMENT_SECTION'|'EMPTY_REQUIREMENT_SECTION', detail: string }[]}
 */
export function requirementWarnings(bytes) {
  if (!bytes) return [];
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    return [];
  }
  if (text.trim() === '') return [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const all = headings(lines);
  const sections = all.filter((h) => REQUIREMENT_WORD.test(h.text));
  if (sections.length === 0) return warning('NO_REQUIREMENT_SECTION');
  const hasText = sections.some((s) => {
    const next = all.find((h) => h.line > s.line && h.level <= s.level);
    return lines.slice(s.line + 1, next ? next.line : lines.length).some((l) => l.trim() !== '');
  });
  return hasText ? [] : warning('EMPTY_REQUIREMENT_SECTION');
}
