// Log patterns (docs/plan-features.md §3 E, ideas.md D4): every line is reduced to a template by
// deterministic masking (numbers, hex, UUIDs, timestamps, IPs, quoted values become `<*>`), and
// equal templates are counted. Deterministic on purpose: the same line always gives the same
// template, so the templates of two runs (current vs previous container run) can be compared
// for "NEW". Pure: runs in patterns.worker.ts, and in tests.
import type { LogLevel } from "../../ipc/types";
import { detectLevel } from "./level";

export const WILD = "<*>";
/** the miner looks at the newest lines only */
export const MAX_LINES = 20_000;
/** a template longer than this is cut (one pathological line must not dominate the table) */
const MAX_TEMPLATE = 400;

export interface MineLine {
  /** ANSI-stripped text, as the logs pane holds it */
  text: string;
  ms: number;
  level?: LogLevel;
}

export interface Pattern {
  template: string;
  count: number;
  /** epoch ms of the first and last line */
  first: number;
  last: number;
  /** the highest level among its lines, when any has one */
  level?: LogLevel;
  /** absent from the previous container run (only set when a previous run was read) */
  isNew?: boolean;
}

const RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
export const isErrorLevel = (l: LogLevel | undefined): boolean => l !== undefined && RANK[l] >= RANK.error;

// Keys whose quoted value is the message or the level: kept, so different messages stay apart.
const KEEP_KEYS = "level|lvl|severity|msg|message|event|logger|caller|component";

const RULES: readonly [RegExp, string][] = [
  // quoted values: JSON `"key": "value"` and logfmt `key="value"`, except message and level keys
  [new RegExp(String.raw`("(?!(?:${KEEP_KEYS})")[^"\\]{1,128}"\s*:\s*)"(?:[^"\\]|\\.)*"`, "gi"), `$1"${WILD}"`],
  [new RegExp(String.raw`(\b(?!(?:${KEEP_KEYS})=)[A-Za-z_][\w.-]*=)"(?:[^"\\]|\\.)*"`, "gi"), `$1"${WILD}"`],
  // UUIDs, ISO timestamps, clock times, IPv4 with an optional port, hex of 8+ with digits and letters
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, WILD],
  [/\b\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:[.,]\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)?/g, WILD],
  [/\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b/g, WILD],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, WILD],
  [/\b(?:0x)?(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, WILD],
  // numbers not glued to a letter on the left: `12ms` -> `<*>ms`, `user:42`, `/items/7`; `k8s`, `v2` stay
  [/(?<![A-Za-z_\d])-?\d+(?:\.\d+)?/g, WILD],
];

/** The template of one line. */
export function templateOf(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  for (const [re, to] of RULES) t = t.replace(re, to);
  // runs like `<*>.<*>` or `<*>:<*>` say nothing more than one wildcard
  t = t.replace(/<\*>(?:[.:,-]<\*>)+/g, WILD);
  return t.length > MAX_TEMPLATE ? t.slice(0, MAX_TEMPLATE) : t;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A regular expression (for the logs pane's RE search) that matches every line with this
 * template: literal parts escaped, `<*>` as a lazy wildcard, any whitespace run as `\s+`.
 */
export function templateRegex(template: string): string {
  const cut = template.length >= MAX_TEMPLATE;
  const body = template
    .split(WILD)
    .map((part) => escapeRe(part).replace(/ /g, "\\s+"))
    .join(".*?");
  return `^\\s*${body}${cut ? "" : "\\s*$"}`;
}

const PROGRESS_EVERY = 5000;

export interface MineResult {
  patterns: Pattern[];
  lines: number;
}

/**
 * Counts templates over the newest `MAX_LINES` lines. With `previous` (the templates of the
 * previous container run), patterns not in it are marked NEW; an empty set marks nothing.
 * Sorted by count, then template.
 */
export function mine(lines: readonly MineLine[], previous?: ReadonlySet<string> | null, onProgress?: (done: number, total: number) => void): MineResult {
  const from = Math.max(0, lines.length - MAX_LINES);
  const byTemplate = new Map<string, Pattern>();
  const total = lines.length - from;
  for (let i = from; i < lines.length; i++) {
    if (onProgress && (i - from) % PROGRESS_EVERY === 0 && i > from) onProgress(i - from, total);
    const l = lines[i];
    const template = templateOf(l.text);
    if (template === "") continue;
    const level = l.level ?? detectLevel(l.text)?.level;
    let p = byTemplate.get(template);
    if (!p) byTemplate.set(template, (p = { template, count: 0, first: l.ms, last: l.ms }));
    p.count++;
    if (l.ms < p.first) p.first = l.ms;
    if (l.ms > p.last) p.last = l.ms;
    if (level && (!p.level || RANK[level] > RANK[p.level])) p.level = level;
  }
  const patterns = [...byTemplate.values()];
  if (previous && previous.size > 0) for (const p of patterns) p.isNew = !previous.has(p.template);
  patterns.sort((a, b) => b.count - a.count || (a.template < b.template ? -1 : a.template > b.template ? 1 : 0));
  return { patterns, lines: lines.length - from };
}

/** The templates of a run (the previous container run, for NEW). */
export function templateSet(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    const tpl = templateOf(t);
    if (tpl) out.add(tpl);
  }
  return out;
}

/** Patterns shown with the errors-only toggle (`!`). */
export const visiblePatterns = (patterns: readonly Pattern[], errorsOnly: boolean): readonly Pattern[] =>
  errorsOnly ? patterns.filter((p) => isErrorLevel(p.level)) : patterns;
