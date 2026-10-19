/**
 * Read a bounty's description back out of its evaluation query
 * (primary_query.json `query`).
 *
 * archiveGenerator.js writes the description as
 *
 *   === TASK DESCRIPTION ===
 *   Work Product Type: <type>
 *   Task Title: <title>
 *   Task Description: <description>
 *
 *   === EVALUATION PROTOCOL ===            (EVALUATION INSTRUCTIONS in the no-criteria fallback)
 *
 * The description is free text: it can hold blank lines and its own "=== ... ==="
 * lines (the mutual-wager terms block does), so only the template's next section
 * header ends it. Used by the chain sync (bounties with no API record of their own)
 * and the task-spec route, so both read the same text.
 */

const TASK_SECTION_HEADER = '=== TASK DESCRIPTION ===';
const DESCRIPTION_LABEL = 'Task Description:';
// The section headers archiveGenerator.js writes right after the description, in the order to try.
const SECTIONS_AFTER_DESCRIPTION = [
  '\n\n=== EVALUATION PROTOCOL ===',
  '\n\n=== EVALUATION INSTRUCTIONS ===',
];

/**
 * Returns the trimmed description, or null when the query has no
 * "Task Description:" line (or an empty one). A query that isn't in the API
 * template has no marker for where the description ends; then only its first
 * paragraph is returned, since the rest of a hand-built query is usually
 * instructions rather than description.
 */
function extractTaskDescription(query) {
  if (typeof query !== 'string') return null;
  const headerIdx = query.indexOf(TASK_SECTION_HEADER);
  const labelIdx = query.indexOf(DESCRIPTION_LABEL, headerIdx === -1 ? 0 : headerIdx);
  if (labelIdx === -1) return null;
  const start = labelIdx + DESCRIPTION_LABEL.length;

  for (const marker of SECTIONS_AFTER_DESCRIPTION) {
    const end = query.indexOf(marker, start);
    if (end !== -1) return query.slice(start, end).trim() || null;
  }

  const firstParagraph = query.slice(start).match(/^\s*(.+?)(?:\n\n|===|$)/s);
  return (firstParagraph && firstParagraph[1].trim()) || null;
}

module.exports = { extractTaskDescription };
