import { PRIMARY_QUERY_MAX_CHARS, BCID_QUERY_MAX_CHARS } from "@verdikta/common";

// Primary-archive cap tracks @verdikta/common 1.8.0+. Confirm the arbiter fleet
// reports that version (including bounty class 128) before accepting longer queries.
const DEFAULT_MAX_EVALUATION_QUERY_CHARS = PRIMARY_QUERY_MAX_CHARS;
const HUNTER_QUERY_MAX_CHARS = BCID_QUERY_MAX_CHARS;

export const MAX_EVALUATION_QUERY_CHARS =
  Number(process.env.MAX_EVALUATION_QUERY_CHARS ?? DEFAULT_MAX_EVALUATION_QUERY_CHARS);

export const MAX_HUNTER_QUERY_CHARS = HUNTER_QUERY_MAX_CHARS;

export function checkQueryLength(query: string, isHunterArchive: boolean): boolean {
  if (isHunterArchive) {
    return query.length <= HUNTER_QUERY_MAX_CHARS;
  }
  return query.length <= MAX_EVALUATION_QUERY_CHARS;
}
