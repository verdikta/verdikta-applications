// The wording guard for everything the site says about a record (review focus of nodes P6b and P8:
// the record states facts only). Two checks:
//
//   banned       the two words of forbiddenWords.js (stake-attestation/README.md, "Wording rule")
//   judgemental  phrases that would turn a fact into a verdict on the code: that it is safe,
//                secure, audited, vetted, approved, free of bugs, or a tier with a medal's name
//                (design §4.1: "Tiers are not named gold or silver")
//
// The server holds every string it generates to it (server/src/wording.js), the client's unit tests
// run it over every UI string, and its Playwright tests over the text the record, feed and claim
// pages render, which includes what the server relays.
import { findForbiddenWords } from './forbiddenWords.js';

export const JUDGEMENTAL = Object.freeze([
  /\bsafe(ty|ly)?\b/i,
  /\bunsafe\b/i,
  /\bsecure[ds]?\b/i,
  /\binsecure\b/i,
  /\baudited\b/i,
  /\bbug[- ]?free\b/i,
  /\bfree (of|from) (bugs|vulnerabilities)\b/i,
  /\bvetted\b/i,
  /\btrusted\b/i,
  /\btrustworthy\b/i,
  /\bapproved\b/i,
  /\bendorse[ds]?\b/i,
  /\bguaranteed\b/i,
  /\brisk[- ]free\b/i,
  /\bcertificate\b/i,
  /\bseal of\b/i,
  /\bverified (safe|secure|code|contract)\b/i,
  /\b(gold|silver|bronze|platinum)\b/i,
]);

/** Every banned word and judgemental phrase in `text`, as short descriptions; [] when clean. */
export function wordingProblems(text) {
  const s = String(text);
  const out = findForbiddenWords(s).map((h) => `banned word at ${h.line}:${h.column}`);
  for (const re of JUDGEMENTAL) {
    const m = re.exec(s);
    if (m) out.push(`judgemental phrase "${m[0]}"`);
  }
  return out;
}
