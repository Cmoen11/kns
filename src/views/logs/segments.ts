// Turns one log line into render segments: ANSI tones, the level token and search hits merged
// into flat runs of text, then hard-wrapped to the column count. Wrapping is done here (not by
// CSS) so a row's height is known without measuring the DOM.
import type { AnsiSpan, Tone } from "./ansi";
import type { LevelHit, Level } from "./level";
import type { Range } from "./match";

export interface Seg {
  text: string;
  tone: Tone | null;
  underline: boolean;
  level: Level | null;
  hit: boolean;
}

/** visual lines a wrapped row may take before it is cut */
export const WRAP_MAX_UNITS = 40;
/** the same for a line expanded with Enter */
export const EXPAND_MAX_UNITS = 1000;
/** characters rendered for a truncated single-line row beyond the visible columns */
export const TRUNCATE_SLACK = 8;

/** Visual lines needed for `length` characters at `cols` per line. */
export function unitsFor(length: number, cols: number, max: number): number {
  if (cols <= 0 || length <= cols) return 1;
  return Math.min(Math.ceil(length / cols), max);
}

/**
 * Flat segments for the first `limit` characters of `text`. Spans and hits must be ascending and
 * non-overlapping (as the parser and the matcher produce them).
 */
export function buildSegments(
  text: string,
  spans: readonly AnsiSpan[] | null,
  level: LevelHit | null,
  hits: readonly Range[] | null,
  limit = text.length,
): Seg[] {
  const end = Math.min(text.length, Math.max(0, limit));
  if (end === 0) return [];
  if (!spans && !level && (!hits || hits.length === 0)) {
    return [{ text: end === text.length ? text : text.slice(0, end), tone: null, underline: false, level: null, hit: false }];
  }
  const cuts = new Set<number>([0, end]);
  const add = (n: number) => {
    if (n > 0 && n < end) cuts.add(n);
  };
  if (spans) for (const s of spans) (add(s.start), add(s.end));
  if (level) (add(level.start), add(level.end));
  if (hits) for (const h of hits) (add(h[0]), add(h[1]));
  const points = [...cuts].sort((a, b) => a - b);

  const out: Seg[] = [];
  let si = 0;
  let hi = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i];
    const to = points[i + 1];
    while (spans && si < spans.length && spans[si].end <= from) si++;
    while (hits && hi < hits.length && hits[hi][1] <= from) hi++;
    const span = spans && si < spans.length && spans[si].start <= from ? spans[si] : null;
    const hit = !!hits && hi < hits.length && hits[hi][0] <= from;
    const lvl = level && level.start <= from && from < level.end ? level.level : null;
    out.push({ text: text.slice(from, to), tone: span?.tone ?? null, underline: span?.underline ?? false, level: lvl, hit });
  }
  return out;
}

/** Hard-wraps segments into visual lines of `cols` characters. */
export function wrapSegments(segs: readonly Seg[], cols: number): Seg[][] {
  if (cols <= 0) return [segs.slice()];
  const lines: Seg[][] = [[]];
  let room = cols;
  for (const seg of segs) {
    let text = seg.text;
    while (text.length > room) {
      if (room > 0) lines[lines.length - 1].push({ ...seg, text: text.slice(0, room) });
      text = text.slice(room);
      lines.push([]);
      room = cols;
    }
    if (text.length > 0) {
      lines[lines.length - 1].push(text === seg.text ? seg : { ...seg, text });
      room -= text.length;
    }
  }
  return lines;
}
