// Structured mode (docs/plan-features.md §3 E, `J`): a parsed line (level / msg / fields from the
// backend's parser) shows as `LEVEL message  k=v k=v`; Enter expands it into an aligned key/value
// block. Field chips (`level>=warn`, `.traceId=abc`) hide the lines that do not pass. Pure: no DOM.
import type { LogLevel } from "../../ipc/types";
import { cleanUntrusted } from "../../ui/untrusted";
import type { AnsiSpan } from "./ansi";
import { detectLevel, type LevelHit } from "./level";

export const LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
export const levelRank = (l: LogLevel): number => RANK[l];

/** Words accepted after `level>=`, as the parser normalises them. */
const ALIASES: Record<string, LogLevel> = {
  trace: "trace", trc: "trace", debug: "debug", dbg: "debug", info: "info", inf: "info",
  warn: "warn", warning: "warn", wrn: "warn", error: "error", err: "error", fatal: "fatal", crit: "fatal", critical: "fatal", panic: "fatal",
};
export const levelOf = (word: string): LogLevel | undefined => ALIASES[word.toLowerCase()];

/** What a line carries for structured mode (a subset of the session's Entry). */
export interface ParsedLine {
  text: string;
  /** the backend parser's level */
  plevel?: LogLevel;
  msg?: string;
  fields?: readonly (readonly [string, string])[];
  /** tint detection on the raw text, for lines the parser gave no level */
  level?: LevelHit | null;
}

export const isParsed = (e: ParsedLine): boolean => e.plevel !== undefined || e.msg !== undefined || (e.fields?.length ?? 0) > 0;

/** The level a chip compares: the parsed one, else warn / error from the tint detection. */
export const effectiveLevel = (e: ParsedLine): LogLevel | undefined =>
  e.plevel ?? (e.level === undefined ? detectLevel(e.text)?.level : e.level?.level);

// ── display ─────────────────────────────────────────────────────────────────

/** keys in an expanded block are padded to the widest, at most this */
const KEY_PAD_MAX = 24;
/** a field value shown inline is cut to this many characters */
const INLINE_VALUE_MAX = 80;
const LEVEL_WIDTH = 5;

export interface Display {
  /** one line: `WARN  slow query  table=orders` */
  text: string;
  /** tones for buildSegments: fields muted, a quiet level muted */
  spans: AnsiSpan[];
  /** the level word, tinted when it is warn or above */
  level: LevelHit | null;
}

const clean = (s: string, max: number) => cleanUntrusted(s, max);

/** The collapsed line of a parsed entry. Text is cleaned (cluster text, shown as text only). */
export function displayLine(e: ParsedLine): Display {
  const lv = e.plevel ? e.plevel.toUpperCase().padEnd(LEVEL_WIDTH) : "";
  const msg = clean(e.msg ?? (e.fields?.length ? "" : e.text), 4000);
  const spans: AnsiSpan[] = [];
  let level: LevelHit | null = null;
  let text = "";
  if (lv) {
    const word = e.plevel!.length;
    // only warn and above get a hue (ux §13.3); the quiet levels are muted
    if (levelRank(e.plevel!) >= RANK.warn) level = { start: 0, end: word, level: e.plevel === "warn" ? "warn" : "error" };
    else spans.push({ start: 0, end: word, tone: "muted", underline: false });
    text = `${lv} `;
  }
  text += msg;
  for (const [k, v] of e.fields ?? []) {
    text += "  ";
    const start = text.length;
    text += `${clean(k, 64)}=`;
    spans.push({ start, end: text.length, tone: "muted", underline: false });
    text += clean(v, INLINE_VALUE_MAX);
  }
  return { text, spans, level };
}

/** Visual lines of an expanded parsed entry: the collapsed head without fields, then one per field. */
export function expandedLines(e: ParsedLine): { head: Display; rows: { key: string; value: string }[]; pad: number } {
  const head = displayLine({ ...e, fields: undefined, msg: e.msg ?? (e.fields?.length ? "" : e.text) });
  const rows = (e.fields ?? []).map(([k, v]) => ({ key: clean(k, 64), value: clean(v, 1024) }));
  const pad = Math.min(KEY_PAD_MAX, rows.reduce((w, r) => Math.max(w, r.key.length), 0));
  return { head, rows, pad };
}

/** Rows an expanded parsed entry takes. */
export const expandedUnits = (e: ParsedLine): number => 1 + (e.fields?.length ?? 0);

// ── field chips ─────────────────────────────────────────────────────────────

export type FieldFilter =
  | { kind: "level"; op: ">=" | "="; level: LogLevel }
  | { kind: "field"; key: string; value: string };

/**
 * A field chip typed into the search input, or null when the text is an ordinary search:
 * `level>=warn`, `level=error`, `.traceId=abc` (exact value; `.key=` matches an empty value).
 */
export function parseFieldFilter(text: string): FieldFilter | null {
  const t = text.trim();
  const lv = /^(?:level|lvl)\s*(>=|=)\s*([A-Za-z]+)$/i.exec(t);
  if (lv) {
    const level = levelOf(lv[2]);
    return level ? { kind: "level", op: lv[1] as ">=" | "=", level } : null;
  }
  const f = /^\.([A-Za-z0-9_@][A-Za-z0-9_.@/-]{0,127})\s*=\s*(.*)$/.exec(t);
  if (f) return { kind: "field", key: f[1], value: f[2].replace(/^"(.*)"$/, "$1") };
  return null;
}

export const filterLabel = (f: FieldFilter): string => (f.kind === "level" ? `level${f.op}${f.level}` : `.${f.key}=${f.value}`);

export const sameFilter = (a: FieldFilter, b: FieldFilter): boolean => filterLabel(a) === filterLabel(b);

/** Whether a line passes one chip. Lines without the level or field fail it. */
export function passes(f: FieldFilter, e: ParsedLine): boolean {
  if (f.kind === "level") {
    const l = effectiveLevel(e);
    if (!l) return false;
    return f.op === "=" ? l === f.level : RANK[l] >= RANK[f.level];
  }
  if (f.key.toLowerCase() === "msg" || f.key.toLowerCase() === "message") return (e.msg ?? "") === f.value;
  for (const [k, v] of e.fields ?? []) if (k === f.key && v === f.value) return true;
  return false;
}

/** All chips at once (AND); null when there is none. */
export function chipPredicate(filters: readonly FieldFilter[]): ((e: ParsedLine) => boolean) | null {
  if (filters.length === 0) return null;
  return (e) => filters.every((f) => passes(f, e));
}
