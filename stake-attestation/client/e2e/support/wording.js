// The wording guard for everything the site says about a record (review focus of node P6b: the
// record states facts only). Two checks:
//
//   banned       the shared helper's two words (stake-attestation/README.md, "Wording rule")
//   judgemental  phrases that would turn a fact into a verdict on the code: that it is safe,
//                secure, audited, vetted, approved, free of bugs, or a tier with a medal's name
//                (design §4.1: "Tiers are not named gold or silver")
//
// The unit tests run it over every UI string (src/strings.js); the Playwright tests run it over
// the text the record, feed and claim pages render, which includes what the server relays
// (labels, badge text).
import { findForbiddenWords } from '@verdikta/stake-attestation-shared';

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
