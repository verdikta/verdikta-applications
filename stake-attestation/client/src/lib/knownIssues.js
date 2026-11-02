// A known issue's id in the browser (design §8.4): `sha256:` and the SHA-256 of the canonical
// JSON of its body, the keys class, description, paths and title in that order. This is
// @verdikta/common's codeReview.knownIssueId, whose module hashes with Node's crypto and cannot
// be bundled; the hash here is common's own (disclosureSha256, from its browser-safe module),
// test/knownIssues.test.js checks the result against common's function, and the server checks
// every id with common's validateKnownIssues before anything is built.
import { disclosureSha256 } from './disclosure.js';

export function knownIssueId(entry) {
  const canonical = JSON.stringify({
    class: entry.class,
    description: entry.description,
    paths: [...entry.paths],
    title: entry.title,
  });
  return `sha256:${disclosureSha256(new TextEncoder().encode(canonical)).slice(2)}`;
}

/** A row of the editor ({ title, class, paths: one per line, description }) as a known_issues.json entry. */
export function knownIssueEntry(row) {
  const body = {
    title: row.title.trim(),
    class: row.class,
    paths: row.paths.split('\n').map((p) => p.trim()).filter(Boolean),
    description: row.description.trim(),
  };
  return { id: knownIssueId(body), ...body };
}
