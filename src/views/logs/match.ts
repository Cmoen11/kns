// Search and filter matching for log lines (docs/ux.md §6.3, §13.3). One matcher serves both:
// search highlights `ranges` without hiding anything, filter-lines keeps the lines where `test`
// holds. NOT has nothing to highlight, so it always filters.
import type { FilterMode } from "../../types";

export type Range = readonly [start: number, end: number];

export interface Query {
  mode: FilterMode;
  text: string;
}

export interface Matcher extends Query {
  /** the line passes (for NOT: does not contain the pattern) */
  test(line: string): boolean;
  /** ranges to highlight, ascending and non-overlapping; always empty for NOT */
  ranges(line: string): Range[];
  /** false for NOT */
  highlights: boolean;
  /** set when the pattern is not a valid regular expression; it is then matched literally */
  error?: string;
}

export const MODES: readonly FilterMode[] = ["re", "not", "fuzzy"];
export const MODE_LABEL: Record<FilterMode, string> = { re: "RE", not: "NOT", fuzzy: "FUZZY" };

export const nextMode = (mode: FilterMode): FilterMode => MODES[(MODES.indexOf(mode) + 1) % MODES.length];

export const sameQuery = (a: Query | null | undefined, b: Query | null | undefined): boolean =>
  (!a && !b) || (!!a && !!b && a.mode === b.mode && a.text === b.text);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ranges per line are capped: a pathological pattern must not stall a render */
const MAX_RANGES = 200;

function regexMatcher(q: Query): Matcher {
  // smart case: an uppercase letter in the pattern makes it case-sensitive
  const flags = /[A-Z]/.test(q.text.replace(/\\./g, "")) ? "" : "i";
  let source = q.text;
  let error: string | undefined;
  try {
    new RegExp(source, flags);
  } catch (e) {
    error = e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : "invalid pattern";
    source = escapeRe(q.text);
  }
  const probe = new RegExp(source, flags);
  const global = new RegExp(source, `${flags}g`);
  const negate = q.mode === "not";
  return {
    mode: q.mode,
    text: q.text,
    error,
    highlights: !negate,
    test: (line) => probe.test(line) !== negate,
    ranges(line) {
      if (negate) return [];
      const out: Range[] = [];
      global.lastIndex = 0;
      let m: RegExpExecArray | null;
      while (out.length < MAX_RANGES && (m = global.exec(line))) {
        if (m[0].length === 0) {
          global.lastIndex++;
          continue;
        }
        out.push([m.index, m.index + m[0].length]);
      }
      return out;
    },
  };
}

/** Positions of the query's characters as an in-order subsequence of the line, or null. */
function fuzzyPositions(needle: string, line: string): number[] | null {
  const hay = line.toLowerCase();
  const out: number[] = [];
  let from = 0;
  for (let i = 0; i < needle.length; i++) {
    const at = hay.indexOf(needle[i], from);
    if (at < 0) return null;
    out.push(at);
    from = at + 1;
  }
  return out;
}

function fuzzyMatcher(q: Query): Matcher {
  const needle = q.text.toLowerCase().replace(/\s+/g, "");
  return {
    mode: "fuzzy",
    text: q.text,
    highlights: true,
    test: (line) => fuzzyPositions(needle, line) !== null,
    ranges(line) {
      // a contiguous hit reads better than the first scattered subsequence
      const whole = line.toLowerCase().indexOf(needle);
      if (whole >= 0) return [[whole, whole + needle.length]];
      const pos = fuzzyPositions(needle, line);
      if (!pos) return [];
      const out: [number, number][] = [];
      for (const p of pos) {
        const last = out[out.length - 1];
        if (last && last[1] === p) last[1] = p + 1;
        else out.push([p, p + 1]);
      }
      return out;
    },
  };
}

/** null for an empty pattern. Never throws: a bad regular expression is matched literally. */
export function compileMatcher(q: Query | null | undefined): Matcher | null {
  if (!q || q.text === "") return null;
  if (q.mode === "fuzzy") return q.text.trim() === "" ? null : fuzzyMatcher(q);
  return regexMatcher(q);
}
