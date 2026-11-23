// In-document search for the header search bar (docs/ux.md §13.1). Pure.

export type SearchMode = "text" | "re";
export const SEARCH_MODES: readonly SearchMode[] = ["text", "re"];
export const MAX_MATCHES = 5000;

export interface Match {
  from: number;
  to: number;
}

export interface SearchResult {
  matches: Match[];
  /** invalid regular expression */
  error?: string;
  /** more than MAX_MATCHES: the list is cut */
  capped?: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive unless the query has an upper-case letter (smart case). */
export function findMatches(text: string, query: string, mode: SearchMode): SearchResult {
  if (!query) return { matches: [] };
  let re: RegExp;
  try {
    re = new RegExp(mode === "re" ? query : escapeRe(query), /[A-Z]/.test(query) ? "gm" : "gim");
  } catch (e) {
    return { matches: [], error: e instanceof Error ? e.message : "invalid pattern" };
  }
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (matches.length >= MAX_MATCHES) return { matches, capped: true };
    matches.push({ from: m.index, to: m.index + m[0].length });
  }
  return { matches };
}

/** Index of the first match at or after `pos` (wraps); -1 when there are none. */
export function matchAtOrAfter(matches: readonly Match[], pos: number): number {
  if (matches.length === 0) return -1;
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].from < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo === matches.length ? 0 : lo;
}

export const stepMatch = (count: number, current: number, delta: 1 | -1): number =>
  count === 0 ? -1 : (((current < 0 ? (delta === 1 ? -1 : 0) : current) + delta) % count + count) % count;
