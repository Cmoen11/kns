// ANSI parser for log lines (docs/ux.md §13.3). Escape sequences are stripped; SGR colours are
// reduced to theme-safe tones: the two status hues and the text levels, never raw ANSI colours.
// Bold is a tone, never a font weight. Backgrounds are ignored.

/** hi = --k-text, muted = --k-text-muted, warn / error = the status hues; null = the line's own colour */
export type Tone = "hi" | "muted" | "warn" | "error";

export interface AnsiSpan {
  start: number;
  end: number;
  tone: Tone | null;
  underline: boolean;
}

export interface ParsedLine {
  /** the text without escape sequences and control characters; tabs expanded to 8-column stops */
  text: string;
  /** styled ranges, ascending and non-overlapping; null when the line has no styling */
  spans: AnsiSpan[] | null;
}

const ESC = 0x1b;
const TAB = 0x09;

/** True when the text needs the parser at all. */
const NEEDS = /[\u0000-\u001f\u007f\u009b]/;

const BASIC: (Tone | null)[] = ["muted", "error", "hi", "warn", "hi", "hi", "hi", null];
const BRIGHT: (Tone | null)[] = ["muted", "error", "hi", "warn", "hi", "hi", "hi", "hi"];

/** Reduces an RGB colour to a tone. */
export function rgbTone(r: number, g: number, b: number): Tone | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 40) return max < 110 ? "muted" : max > 200 ? "hi" : null;
  if (r >= g && r > b * 1.5) return g > r * 0.45 ? "warn" : "error";
  return "hi";
}

function indexedTone(n: number): Tone | null {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const c = n - 16;
    const lvl = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return rgbTone(lvl(Math.floor(c / 36)), lvl(Math.floor(c / 6) % 6), lvl(c % 6));
  }
  const gray = 8 + (n - 232) * 10;
  return rgbTone(gray, gray, gray);
}

interface Sgr {
  color: Tone | null;
  bold: boolean;
  dim: boolean;
  underline: boolean;
}

function toneOf(s: Sgr): Tone | null {
  if (s.color === "warn" || s.color === "error") return s.color;
  if (s.dim) return "muted";
  return s.color ?? (s.bold ? "hi" : null);
}

function applySgr(s: Sgr, params: string): void {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) {
      s.color = null;
      s.bold = s.dim = s.underline = false;
    } else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 22) s.bold = s.dim = false;
    else if (c === 4) s.underline = true;
    else if (c === 24) s.underline = false;
    else if (c >= 30 && c <= 37) s.color = BASIC[c - 30];
    else if (c >= 90 && c <= 97) s.color = BRIGHT[c - 90];
    else if (c === 39) s.color = null;
    else if (c === 38 || c === 48) {
      // extended colour: 38;5;n or 38;2;r;g;b (48 = background, parsed and ignored)
      const mode = codes[i + 1];
      if (mode === 5) {
        if (c === 38) s.color = indexedTone(codes[i + 2] ?? 0);
        i += 2;
      } else if (mode === 2) {
        if (c === 38) s.color = rgbTone(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
        i += 4;
      } else break;
    }
  }
}

export function parseAnsi(input: string): ParsedLine {
  if (!NEEDS.test(input)) return { text: input, spans: null };
  const sgr: Sgr = { color: null, bold: false, dim: false, underline: false };
  let out = "";
  let spans: AnsiSpan[] | null = null;
  let runStart = 0;
  let runTone: Tone | null = null;
  let runUnderline = false;

  const closeRun = () => {
    if (out.length > runStart && (runTone !== null || runUnderline)) {
      (spans ??= []).push({ start: runStart, end: out.length, tone: runTone, underline: runUnderline });
    }
    runStart = out.length;
    runTone = toneOf(sgr);
    runUnderline = sgr.underline;
  };

  const n = input.length;
  let i = 0;
  while (i < n) {
    const ch = input.charCodeAt(i);
    if (ch === ESC || ch === 0x9b) {
      let j = i + 1;
      const next = ch === 0x9b ? 0x5b : input.charCodeAt(j);
      if (next === 0x5b /* [ : CSI */) {
        if (ch === ESC) j++;
        const start = j;
        while (j < n) {
          const c = input.charCodeAt(j);
          if (c >= 0x40 && c <= 0x7e) break;
          j++;
        }
        if (j < n && input.charCodeAt(j) === 0x6d /* m */) {
          applySgr(sgr, input.slice(start, j));
          if (toneOf(sgr) !== runTone || sgr.underline !== runUnderline) closeRun();
        }
        i = j + 1;
      } else if (next === 0x5d /* ] : OSC, ends with BEL or ESC \ */) {
        j++;
        while (j < n) {
          const c = input.charCodeAt(j);
          if (c === 0x07) break;
          if (c === ESC && input.charCodeAt(j + 1) === 0x5c) {
            j++;
            break;
          }
          j++;
        }
        i = j + 1;
      } else {
        // two-character escape (ESC c, ESC 7 ...); charset selection takes one more
        i = next === 0x28 || next === 0x29 ? j + 2 : j + 1;
      }
    } else if (ch === TAB) {
      out += " ".repeat(8 - (out.length % 8));
      i++;
    } else if (ch < 0x20 || ch === 0x7f) {
      i++;
    } else {
      // copy the run of plain characters in one slice
      let j = i + 1;
      while (j < n) {
        const c = input.charCodeAt(j);
        if (c < 0x20 || c === 0x7f || c === 0x9b) break;
        j++;
      }
      out += input.slice(i, j);
      i = j;
    }
  }
  closeRun();
  return { text: out, spans };
}
