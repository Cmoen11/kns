// Scrollback search and the COPY-mode line cursor (pure; the terminal is passed in as plain data).

export interface Match {
  /** absolute buffer line */
  line: number;
  col: number;
  length: number;
}

/**
 * Case-insensitive substring matches, top to bottom. Lines are searched one by one; a match that
 * spans a soft wrap is not found. Capped so a one-letter query on a huge buffer stays cheap.
 */
export function findMatches(lineAt: (i: number) => string | undefined, length: number, query: string, cap = 5000): Match[] {
  const q = query.toLowerCase();
  const out: Match[] = [];
  if (q.length === 0) return out;
  for (let i = 0; i < length && out.length < cap; i++) {
    const text = lineAt(i);
    if (!text) continue;
    const hay = text.toLowerCase();
    let at = hay.indexOf(q);
    while (at >= 0 && out.length < cap) {
      out.push({ line: i, col: at, length: q.length });
      at = hay.indexOf(q, at + q.length);
    }
  }
  return out;
}

/**
 * The match to show next when searching upwards (older output) from a position: the last match
 * strictly before it, wrapping to the newest. -1 when there are none.
 */
export function previousMatch(matches: readonly Match[], from: { line: number; col: number }): number {
  if (matches.length === 0) return -1;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    if (m.line < from.line || (m.line === from.line && m.col < from.col)) return i;
  }
  return matches.length - 1;
}

export interface CopyCursor {
  /** absolute buffer line of the line cursor */
  line: number;
  /** where `v` started the selection; null = no selection yet */
  anchor: number | null;
}

export type CopyMove = "down" | "up" | "top" | "bottom";

export function moveCopyCursor(c: CopyCursor, move: CopyMove, length: number): CopyCursor {
  const last = Math.max(0, length - 1);
  const line =
    move === "top" ? 0
    : move === "bottom" ? last
    : Math.min(last, Math.max(0, c.line + (move === "down" ? 1 : -1)));
  return line === c.line ? c : { ...c, line };
}

/** The lines COPY mode shows as selected: the cursor line, or anchor..cursor after `v`. */
export function copyRange(c: CopyCursor): { start: number; end: number } {
  const a = c.anchor ?? c.line;
  return { start: Math.min(a, c.line), end: Math.max(a, c.line) };
}

/** The viewport top that brings `line` on screen with the least scrolling; null = already visible. */
export function scrollTargetFor(line: number, viewportY: number, rows: number): number | null {
  if (line < viewportY) return line;
  if (line > viewportY + rows - 1) return line - rows + 1;
  return null;
}
