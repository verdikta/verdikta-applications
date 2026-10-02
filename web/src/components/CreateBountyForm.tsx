import { PRIMARY_QUERY_MAX_CHARS } from "@verdikta/common";

const MAX_QUERY_CHARS = PRIMARY_QUERY_MAX_CHARS;

export function QueryCounter({ value }: { value: string }) {
  return <span>{value.length} / {MAX_QUERY_CHARS}</span>;
}
