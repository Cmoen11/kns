// `/` filter (docs/ux.md §6.3): modes RE, NOT, LABEL, FUZZY, the typed k9s prefixes (`!re`,
// `-l sel`, `-f fz`), AND-combination of chips, and the match ranges used for highlighting. Pure.
import type { Filter } from "../types";

export type InputMode = "re" | "not" | "label" | "fuzzy";
export const INPUT_MODES: readonly InputMode[] = ["re", "not", "label", "fuzzy"];
export const MODE_LABEL: Record<InputMode, string> = { re: "RE", not: "NOT", label: "LABEL", fuzzy: "FUZZY" };

export const nextMode = (m: InputMode, modes: readonly InputMode[] = INPUT_MODES): InputMode => modes[(modes.indexOf(m) + 1) % modes.length];

/** Resolves the k9s prefixes. They only apply in the default RE mode; elsewhere the text is literal. */
export function detectMode(text: string, mode: InputMode): { mode: InputMode; text: string } {
  if (mode === "re") {
    if (text.startsWith("-l ")) return { mode: "label", text: text.slice(3).trim() };
    if (text.startsWith("-f ")) return { mode: "fuzzy", text: text.slice(3).trim() };
    if (text.startsWith("!")) return { mode: "not", text: text.slice(1) };
  }
  return { mode, text: mode === "label" ? text.trim() : text };
}

export function compileRegex(text: string): RegExp | null {
  try {
    return new RegExp(text, "i");
  } catch {
    return null;
  }
}

// one requirement of a label selector: key, key=value, key==value, key!=value, !key, key in (a,b), key notin (a,b)
const LABEL_KEY = "[A-Za-z0-9]([-A-Za-z0-9_./]*[A-Za-z0-9])?";
const LABEL_REQ = new RegExp(`^!?${LABEL_KEY}(\\s*(=|==|!=)\\s*[-A-Za-z0-9_.]*|\\s+(in|notin)\\s*\\([^()]*\\))?$`);

/** Splits a selector on the commas that are not inside `( )`. */
function splitSelector(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export const validLabelSelector = (sel: string): boolean => sel.trim() !== "" && splitSelector(sel).every((p) => LABEL_REQ.test(p.trim()));

export type ParseResult = { filter: Filter; error?: undefined } | { filter: null; error?: string };

/** What Enter (or live typing) turns the input into. Empty text gives no filter and no error. */
export function parseFilterInput(raw: string, mode: InputMode): ParseResult {
  const d = detectMode(raw, mode);
  if (d.text.trim() === "") return { filter: null };
  if (d.mode === "label") return validLabelSelector(d.text) ? { filter: { mode: "label", selector: d.text } } : { filter: null, error: "invalid label selector" };
  if (d.mode === "fuzzy") return { filter: { mode: "fuzzy", text: d.text.trim() } };
  if (!compileRegex(d.text)) return { filter: null, error: "invalid regex" };
  return { filter: { mode: d.mode, text: d.text } };
}

/** Subsequence match, case-insensitive. Returns the matched positions, or null. */
export function fuzzyMatch(needle: string, hay: string): number[] | null {
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < n.length; i++) {
    const ch = n[i];
    if (ch === " ") continue;
    j = h.indexOf(ch, j);
    if (j < 0) return null;
    out.push(j++);
  }
  return out;
}

export interface Matcher {
  /** no client-side filter: every row passes */
  readonly empty: boolean;
  /** true when the row passes every chip. `texts` are the row's cell texts, `name` its name. */
  test(texts: readonly string[], name: string): boolean;
  /** highlight ranges [start, end) inside one cell; fuzzy only marks the name cell */
  ranges(text: string, isName: boolean): [number, number][];
  /** all LABEL chips joined: the server-side labelSelector, or undefined */
  readonly labelSelector: string | undefined;
}

export function labelSelectorOf(filters: readonly Filter[], extra?: string): string | undefined {
  const parts: string[] = [];
  if (extra) parts.push(extra);
  for (const f of filters) if (f.mode === "label" && f.selector) parts.push(f.selector);
  return parts.length > 0 ? parts.join(",") : undefined;
}

/** Compiles chips (and the live draft) into one matcher. Invalid regexes are ignored. */
export function compileFilters(filters: readonly Filter[]): Matcher {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  const fuzzy: string[] = [];
  for (const f of filters) {
    if (f.mode === "label") continue;
    if (f.mode === "fuzzy") {
      if (f.text.trim()) fuzzy.push(f.text.trim());
      continue;
    }
    const re = compileRegex(f.text);
    if (!re) continue;
    (f.mode === "not" ? exclude : include).push(re);
  }
  const global = include.map((re) => new RegExp(re.source, "gi"));
  const empty = include.length === 0 && exclude.length === 0 && fuzzy.length === 0;
  const any = (re: RegExp, texts: readonly string[]) => {
    for (const t of texts) if (re.test(t)) return true;
    return false;
  };
  return {
    empty,
    labelSelector: labelSelectorOf(filters),
    test(texts, name) {
      for (const re of include) if (!any(re, texts)) return false;
      for (const re of exclude) if (any(re, texts)) return false;
      for (const f of fuzzy) if (!fuzzyMatch(f, name)) return false;
      return true;
    },
    ranges(text, isName) {
      if (empty || !text) return [];
      const out: [number, number][] = [];
      for (const re of global) {
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          out.push([m.index, m.index + m[0].length]);
        }
      }
      if (isName) for (const f of fuzzy) for (const p of fuzzyMatch(f, text) ?? []) out.push([p, p + 1]);
      return mergeRanges(out);
    },
  };
}

export function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else out.push(sorted[i]);
  }
  return out;
}

export function chipOf(f: Filter): { mode: string; value: string } {
  return f.mode === "label" ? { mode: "LABEL", value: f.selector } : { mode: MODE_LABEL[f.mode], value: f.text };
}

export const sameFilter = (a: Filter, b: Filter): boolean =>
  a.mode === b.mode && (a.mode === "label" ? a.selector === (b as typeof a).selector : a.text === (b as typeof a).text);
