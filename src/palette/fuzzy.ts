// Fuzzy matching and ranking for the palette and pickers (docs/ux.md §6.1). Pure.
// A query matches when its characters appear in order (case-insensitive). The score prefers an
// exact or prefix match, runs of consecutive characters, word starts and short targets.

export interface FuzzyMatch {
  score: number;
  /** indices into the text of the matched characters, ascending (for the underline) */
  positions: number[];
}

const isBoundary = (text: string, i: number): boolean => {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if (prev === "-" || prev === "_" || prev === "." || prev === "/" || prev === " " || prev === ":") return true;
  // camelCase hump
  return prev === prev.toLowerCase() && prev !== prev.toUpperCase() && cur !== cur.toLowerCase();
};

/** Matches `query` against `text`. Null when it does not match; an empty query matches with score 0. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  if (q.length > t.length) return null;

  // substring: the strongest signal, and the cheapest path
  const at = t.indexOf(q);
  if (at >= 0) {
    const positions: number[] = [];
    for (let i = 0; i < q.length; i++) positions.push(at + i);
    let score = 100 + q.length * 10 - Math.min(30, t.length - q.length);
    if (at === 0) score += q.length === t.length ? 100 : 50;
    else if (isBoundary(text, at)) score += 25;
    else score -= Math.min(10, at);
    return { score, positions };
  }

  // subsequence, greedy from the left but preferring word starts
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let i = from; i < t.length; i++) {
      if (t[i] !== ch) continue;
      if (found < 0) found = i;
      if (isBoundary(text, i)) {
        // take a word start when the remaining query still fits after it
        found = i;
        break;
      }
      if (i === prev + 1) break;
    }
    if (found < 0) return null;
    // the boundary jump may strand the rest of the query: fall back to the first hit
    if (!restFits(q, qi + 1, t, found + 1)) {
      found = t.indexOf(ch, from);
      if (found < 0 || !restFits(q, qi + 1, t, found + 1)) return null;
    }
    score += 10;
    if (found === prev + 1) score += 8;
    if (isBoundary(text, found)) score += 6;
    else score -= Math.min(3, found - from);
    positions.push(found);
    prev = found;
    from = found + 1;
  }
  score -= Math.min(30, t.length - q.length);
  return { score, positions };
}

function restFits(q: string, qi: number, t: string, from: number): boolean {
  let i = from;
  for (; qi < q.length; qi++) {
    i = t.indexOf(q[qi], i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

export interface Ranked<T> {
  item: T;
  score: number;
  positions: number[];
}

export interface RankOptions<T> {
  /** the text that is shown and underlined */
  text: (item: T) => string;
  /** extra texts that may also match (short names, kind); a hit there has no positions */
  keywords?: (item: T) => readonly string[] | undefined;
  /** added to the score of a matching item (recency) */
  bonus?: (item: T) => number;
}

/**
 * Ranks items by fuzzy score, best first. Ties keep the input order (stable), so sources decide
 * the order of equally good hits. With an empty query every item is kept in input order.
 */
export function rank<T>(items: readonly T[], query: string, opts: RankOptions<T>): Ranked<T>[] {
  const q = query.trim();
  if (q.length === 0) return items.map((item) => ({ item, score: 0, positions: [] }));
  const out: (Ranked<T> & { i: number })[] = [];
  items.forEach((item, i) => {
    let best = fuzzyMatch(q, opts.text(item));
    for (const k of opts.keywords?.(item) ?? []) {
      const m = fuzzyMatch(q, k);
      // a keyword hit ranks slightly below the same hit on the label
      if (m && (!best || m.score - 5 > best.score)) best = { score: m.score - 5, positions: [] };
    }
    if (!best) return;
    out.push({ item, score: best.score + (opts.bonus?.(item) ?? 0), positions: best.positions, i });
  });
  out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out;
}

/** Splits text into runs for rendering the match underline: [{ text, hit }]. */
export function segments(text: string, positions: readonly number[]): { text: string; hit: boolean }[] {
  if (positions.length === 0) return text.length > 0 ? [{ text, hit: false }] : [];
  const out: { text: string; hit: boolean }[] = [];
  const set = new Set(positions);
  let start = 0;
  let hit = set.has(0);
  for (let i = 1; i <= text.length; i++) {
    const h = i < text.length && set.has(i);
    if (i === text.length || h !== hit) {
      out.push({ text: text.slice(start, i), hit });
      start = i;
      hit = h;
    }
  }
  return out;
}
